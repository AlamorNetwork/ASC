import { config } from './config.js';
import * as store from './db.js';
import { planFor, keysAvailable, setAside, kindOfFailure, bareModel } from './providers.js';

const { key, base } = config.router;

/**
 * Sends one request for a model that may name its provider, and may name several.
 *
 * Two things are being worked around, and they compose: a free tier limits each key, so
 * a provider's other keys are tried before giving up on it; and a free model runs out
 * entirely, so the next model in the chain is tried before giving up on the request.
 * Only a failure that a different key or model could fix moves on — a 400 means the
 * request is wrong and will be just as wrong everywhere.
 *
 * @param body must carry `model`, which may be `a@kira,b@kira,c`
 * @returns {{res, raw, model, provider}} the attempt that answered
 */
async function attempt(path, body, { label, timeoutMs = 120000, tries = 3 }) {
  const plan = planFor(body.model, config.providers);
  if (!plan.length) throw new Error(`مدل «${body.model}» به هیچ ارائه‌دهنده‌ای وصل نیست`);

  let last = null;

  for (const { model, provider } of plan) {
    const usable = keysAvailable(provider);
    if (!usable.length) {
      last ??= new Error(`${provider.name}: همه‌ی کلیدها موقتاً کنار گذاشته شده‌اند`);
      continue;
    }

    for (const { key: apiKey, index } of usable) {
      const res = await routerFetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model }),
      }, { label: `${label}/${model}`, timeoutMs, tries, base: provider.base })
        .catch((err) => { last = err; return null; });

      if (!res) continue;                       // the network, not the key
      const raw = await res.text();
      if (res.ok) return { res, raw, model, provider };

      const kind = kindOfFailure(res.status);
      if (!kind) return { res, raw, model, provider };   // a real answer: wrong request

      // Out of quota on this key. Rest it and let the next one try.
      setAside(provider.name, index, kind);
      console.warn(`[llm] ${provider.name} key #${index + 1} set aside (${kind}, ${res.status}) on ${model}`);
      last = new Error(`${model}: ${res.status}`);
    }
  }

  throw last ?? new Error(`هیچ ارائه‌دهنده‌ای به «${body.model}» جواب نداد`);
}

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
 * Every toman this process has spent, counted in one place.
 *
 * Cost was previously only visible per call, which made it easy for something routine —
 * a test suite on every deploy, say — to spend real money without anyone seeing a total.
 * Anything that reads a provider's usage figures reports it here.
 */
export const spend = { toman: 0, usd: 0, calls: 0 };

export function recordSpend(usage = {}, { model = 'unknown', kind = 'chat' } = {}) {
  const toman = usage?.total_cost_toman ?? usage?.costToman ?? 0;
  const usd = usage?.cost ?? usage?.costUsd ?? 0;
  spend.calls++;
  spend.toman += toman;
  spend.usd += usd;

  // Kept per call, not just as a total, because the decision this feeds — what to move
  // to a local model — depends entirely on which of them is expensive.
  try {
    store.recordSpendRow({
      model, kind, toman, usd,
      inTokens: usage?.prompt_tokens ?? 0,
      outTokens: usage?.completion_tokens ?? 0,
    });
  } catch { /* accounting must never break the call it is accounting for */ }
}

export const spendMark = () => ({ ...spend });
export const spendSince = (mark) => ({
  toman: spend.toman - mark.toman,
  usd: spend.usd - mark.usd,
  calls: spend.calls - mark.calls,
});

/**
 * A network failure says nothing about which call died, so every request carries a
 * label and retries a couple of times before giving up. A dropped connection to the
 * provider is common enough that failing the whole turn on the first one is wrong.
 */
export async function routerFetch(path, init, {
  label = 'router', tries = 3, timeoutMs = 120000, base: origin = base,
} = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    // Without an explicit deadline a hung connection waits on Node's default, which
    // is long enough to look like the whole program has stopped.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(`${origin}${path}`, { ...init, signal: ctrl.signal });
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
  throw new Error(`ارتباط با ${label} برقرار نشد — ${cause} · ${origin}`);
}

const post = (body) => attempt('/chat/completions', body, { label: 'chat' });

/**
 * Where to send a request for `spec`, for the paths that cannot use `attempt` — streaming,
 * because it must not read the body; embeddings and reranking, because they are single
 * shot and their providers are not interchangeable anyway. Takes the first link of the
 * chain that has a key ready.
 */
export function endpointFor(spec) {
  for (const { model, provider } of planFor(spec, config.providers)) {
    const usable = keysAvailable(provider);
    if (usable.length) {
      return { model, base: provider.base, key: usable[0].key, provider: provider.name };
    }
  }
  // Better to try the default and get the provider's own error than to invent one here.
  return { model: bareModel(spec), base, key, provider: 'default' };
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

  let { res, raw, model: served, provider } = await post(body);

  if (!res.ok && body.reasoning_effort && /reasoning/i.test(raw)) {
    reasoningCanBeDisabled = false;
    console.warn('[llm] endpoint requires reasoning; retrying with it enabled (costs more)');
    delete body.reasoning_effort;
    ({ res, raw, model: served, provider } = await post(body));
  }

  // Naming the model matters: most failures here are "this endpoint does not have that
  // id", and a bare status code sends you looking in the wrong place.
  if (!res.ok) throw new Error(`router ${res.status} (${served}@${provider.name}): ${raw.slice(0, 300)}`);

  let json = parseRouterBody(raw);
  let usage = json.usage ?? {};
  recordSpend(usage, { model: served, kind: 'chat' });

  // A reasoning model can spend the whole completion budget thinking and leave no room
  // to answer — qwen3.7-flash put 1,705 of 1,805 tokens into reasoning, then on a longer
  // prompt cut its JSON off mid-object. Both read as "the model failed" when they are
  // really "we did not leave it room", and the money is spent either way, so one retry
  // with headroom is strictly better than reporting a broken reply. Once only: a model
  // that truncates twice is not going to fit on the third try either.
  const spentThinking = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const finish = json.choices?.[0]?.finish_reason;
  const emptyAfterThinking = !String(json.choices?.[0]?.message?.content ?? '').trim() && spentThinking > 0;

  if (emptyAfterThinking || finish === 'length') {
    const roomier = Math.max(maxTokens * 3, spentThinking * 2 + 1500);
    console.warn(`[llm] ${served} ran out of room (${finish}, ${spentThinking} thinking tokens); ` +
      `retrying with ${roomier}`);
    const retry = await post({ ...body, max_tokens: roomier });
    if (retry.res.ok) {
      json = parseRouterBody(retry.raw);
      usage = json.usage ?? {};
      recordSpend(usage, { model: served, kind: 'chat' });
    }
  }

  return {
    text: json.choices?.[0]?.message?.content ?? '',
    // Which link of the chain answered, so a silent fallback to a paid model is visible.
    served, provider: provider.name,
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
export async function chatStream({ model: spec, system, history = [], content, maxTokens = 2000, onDelta }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of history) messages.push({ role: m.role, content: m.text });
  if (content) messages.push({ role: 'user', content });

  // Streaming takes the first ready link only. If it fails for any reason the fallback
  // below is a plain chat(), which does walk the whole chain — so a rate-limited free
  // model costs the typing effect, not the answer.
  const { model, base: origin, key: apiKey } = endpointFor(spec);

  let res;
  try {
    res = await routerFetch('/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true }),
    }, { label: `stream/${model}`, base: origin });
  } catch (err) {
    // An endpoint that cannot stream should still answer, just without the typing effect.
    console.warn('[llm] streaming unavailable, falling back:', err.message);
    const out = await chat({ model: spec, system, content: messages.at(-1)?.content, maxTokens });
    onDelta?.(out.text);
    return out;
  }

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    // A rate limit here is exactly what the chain exists for, so hand it to chat().
    console.warn(`[llm] stream ${res.status} on ${model}, falling back to the chain`);
    const out = await chat({ model: spec, system, content: messages.at(-1)?.content, maxTokens });
    onDelta?.(out.text);
    return out;
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

  recordSpend(usage, { model, kind: 'chat' });
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

/**
 * Speech to text through a dedicated model.
 *
 * A multimodal chat model charges for audio as input tokens, which for a two-minute
 * note is most of the bill. A speech-to-text model is billed by length of audio and is
 * an order of magnitude cheaper, at the price of a second call to make sense of what it
 * heard. Endpoints rarely report cost for this route, so a zero here means unknown, not
 * free — the provider's own dashboard is the truth.
 *
 * @returns {Promise<{text:string, usage:object}>}
 */
let sttShape = null;   // the request form this endpoint accepted, found once

export const resetTranscribeShape = () => { sttShape = null; };

export async function transcribe({ model: spec, buffer, filename = 'voice.ogg', mimeType = 'audio/ogg', language = 'fa' }) {
  const { model, base: origin, key: apiKey } = endpointFor(spec);
  // Transcription endpoints vary the way rerank ones do: the path differs, and naming the
  // language helps some providers and is rejected by others. Rather than assume one, the
  // working form is discovered on the first call and reused after that.
  // Language matters for Persian — without it these models often decide mid-sentence
  // that they are hearing Arabic.
  const shapes = [
    { path: '/audio/transcriptions', language, format: 'json' },
    { path: '/audio/transcriptions', language, format: null },
    { path: '/audio/transcriptions', language: null, format: null },
    { path: '/audio/speech-to-text', language, format: null },
  ];

  let raw = null;
  let lastError = null;

  for (const s of (sttShape ? [sttShape] : shapes)) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    form.append('model', model);
    if (s.language) form.append('language', s.language);
    if (s.format) form.append('response_format', s.format);

    const res = await routerFetch(s.path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },  // no Content-Type: FormData sets its own boundary
      body: form,
    }, { label: `stt/${model}`, tries: 1, timeoutMs: 180000, base: origin });

    const body = await res.text();
    if (res.ok) { raw = body; sttShape = s; break; }

    // The first shape is the standard one, so its rejection is the provider's real
    // objection. A later shape failing differently is noise on top of that.
    lastError ??= `${res.status}: ${body.slice(0, 200)}`;
    // A rejected shape is worth trying the next form of. Anything else is the provider
    // saying no to the whole idea, and will say the same to every shape.
    if (![400, 404, 415, 422].includes(res.status)) break;
  }

  if (raw === null) throw new Error(`transcription failed (${model}) — ${lastError ?? 'no response'}`);

  let json;
  try { json = parseRouterBody(raw); }
  catch { json = { text: raw }; }   // some endpoints return bare text

  const usage = json.usage ?? {};
  recordSpend(usage, { model, kind: 'stt' });
  return {
    text: String(json.text ?? '').trim(),
    usage: {
      inTokens: usage.prompt_tokens ?? 0,
      outTokens: usage.completion_tokens ?? 0,
      costUsd: usage.cost ?? 0,
      costToman: usage.total_cost_toman ?? 0,
      seconds: json.duration ?? usage.seconds ?? 0,
    },
  };
}

export const audioPart = (base64, format = 'ogg') => ({
  type: 'input_audio',
  input_audio: { data: base64, format },
});

export const textPart = (text) => ({ type: 'text', text });
