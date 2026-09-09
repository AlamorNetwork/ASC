import { config } from './config.js';

const { key, base } = config.router;

// 9router appends a trailing `data: [DONE]` even to non-streaming responses,
// which makes res.json() throw. Strip it before parsing.
function parseRouterBody(raw) {
  return JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
}

// Some endpoints refuse to let reasoning be turned off. Discovered on the first
// rejection and remembered, so the cost saving is taken where it is allowed and
// silently skipped where it is not.
let reasoningCanBeDisabled = true;

/**
 * A network failure says nothing about which call died, so every request carries a
 * label and retries a couple of times before giving up. A dropped connection to the
 * provider is common enough that failing the whole turn on the first one is wrong.
 */
export async function routerFetch(path, init, {
  label = 'router', tries = 3, timeoutMs = 120000,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    // Without an explicit deadline a hung connection waits on Node's default, which
    // is long enough to look like the whole program has stopped.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${base}${path}`, { ...init, signal: ctrl.signal });
    } catch (err) {
      lastErr = err;
      const timedOut = err.name === 'AbortError';
      const cause = timedOut ? `timeout after ${timeoutMs / 1000}s` : (err.cause?.code ?? err.name);
      console.warn(`[llm] ${label} attempt ${attempt}/${tries} failed: ${cause}`);
      // A timeout means the far end is slow, so hammering it again mostly multiplies
      // the wait. One more try, then give up and say so.
      if (timedOut && attempt >= 2) break;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  const cause = lastErr?.name === 'AbortError'
    ? `پاسخی نداد (${timeoutMs / 1000} ثانیه)`
    : (lastErr?.cause?.code ?? lastErr?.message ?? 'unknown');
  throw new Error(`ارتباط با ${label} برقرار نشد — ${cause} · ${base}`);
}

async function post(body) {
  const res = await routerFetch('/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { label: `chat/${body.model}` });
  return { res, raw: await res.text() };
}

/**
 * One chat completion. `content` may be a string or an array of content parts
 * (so audio goes through the same path as text).
 * Returns { text, usage } where usage carries the provider's own cost figures.
 */
export async function chat({ model, system, content, maxTokens = 3000, noThinking = true }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  const body = { model, messages, max_tokens: maxTokens };
  // Reasoning tokens are 30-75% of output cost on transcription-shaped work and
  // buy nothing there, so they are turned off where the endpoint permits it.
  if (noThinking && reasoningCanBeDisabled) body.reasoning_effort = 'none';

  let { res, raw } = await post(body);

  if (!res.ok && body.reasoning_effort && /reasoning/i.test(raw)) {
    reasoningCanBeDisabled = false;
    console.warn('[llm] endpoint requires reasoning; retrying with it enabled (costs more)');
    delete body.reasoning_effort;
    ({ res, raw } = await post(body));
  }

  if (!res.ok) throw new Error(`router ${res.status}: ${raw.slice(0, 300)}`);

  const json = parseRouterBody(raw);
  const usage = json.usage ?? {};
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: {
      inTokens: usage.prompt_tokens ?? 0,
      outTokens: usage.completion_tokens ?? 0,
      costUsd: usage.cost ?? 0,
      costToman: usage.total_cost_toman ?? 0,
    },
  };
}

/** Same call, but the reply must be a JSON object. Returns { data, usage }. */
export async function chatJson(opts) {
  const { text, usage } = await chat(opts);
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return { data: JSON.parse(cleaned), usage };
  } catch {
    // Last resort: the outermost {...} in the reply.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return { data: JSON.parse(m[0]), usage }; } catch { /* fall through */ }
    }
    throw new Error(`model did not return JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Streaming completion. `onDelta(fullTextSoFar)` is called as chunks arrive, throttled
 * by the caller. Falls back to a normal call if the endpoint refuses to stream, so a
 * provider without SSE degrades to a slower reply rather than an error.
 */
export async function chatStream({ model, system, history = [], content, maxTokens = 2000, onDelta }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of history) messages.push({ role: m.role, content: m.text });
  if (content) messages.push({ role: 'user', content });

  let res;
  try {
    res = await routerFetch('/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true }),
    }, { label: `stream/${model}` });
  } catch (err) {
    // An endpoint that cannot stream should still answer, just without the typing effect.
    console.warn('[llm] streaming unavailable, falling back:', err.message);
    const out = await chat({ model, system, content: messages.at(-1)?.content, maxTokens });
    onDelta?.(out.text);
    return out;
  }

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`router ${res.status} (${model}): ${raw.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) { text += delta; onDelta?.(text); }
        if (chunk.usage) usage = chunk.usage;
      } catch { /* a partial frame; the next read completes it */ }
    }
  }

  return {
    text,
    usage: {
      inTokens: usage.prompt_tokens ?? 0,
      outTokens: usage.completion_tokens ?? 0,
      costUsd: usage.cost ?? 0,
      costToman: usage.total_cost_toman ?? 0,
    },
  };
}

export const audioPart = (base64, format = 'ogg') => ({
  type: 'input_audio',
  input_audio: { data: base64, format },
});

export const textPart = (text) => ({ type: 'text', text });
