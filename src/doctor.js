/**
 * Whether each role can actually reach a model, and what to type if it cannot.
 *
 * A role whose chain resolves to nothing does not announce itself. It falls back to a
 * built-in default, the default is not on the configured endpoint either, and the
 * feature is dead until someone uses it and gets an error. Moving behind a gateway
 * renames every model, so this is exactly when it happens — and it happened.
 *
 * The same logic runs in scripts/check.js and behind /doctor, because the person who
 * needs it is not always the person with a shell. That was the lesson of the server
 * whose sshd stopped while the bot kept answering.
 */
import { config } from './config.js';
import { planFor } from './providers.js';
import { allModels } from './settings.js';

/** What each role is for, so a broken one says what stopped working. */
const CONSEQUENCE = {
  capture: 'ویس و صفحه‌های اسکن‌شده خوانده نمی‌شوند',
  transcribe: 'مسیر ارزان پیاده‌سازی ویس کار نمی‌کند',
  research: 'تحقیق وب اجرا نمی‌شود',
  structure: 'برنامه‌ریزی و ارزیابی کار نمی‌کند — بیشتر بات می‌ایستد',
  router: 'تشخیص منظور پیام کار نمی‌کند',
  embed: 'جست‌وجوی معنایی خاموش است؛ فقط کلیدواژه‌ای',
  rerank: 'آخرین مرحله‌ی دقتِ بازیابی خاموش است',
};

/**
 * Whether the key is actually accepted, which a model list does not tell you.
 *
 * 9router serves /v1/models to anyone — no key, a wrong key, the literal placeholder
 * text out of a setup script — and only refuses at /v1/chat/completions. So a report
 * built on the model list alone says "374 models, all good" about an endpoint that will
 * reject every real request.
 *
 * Asking for a model that cannot exist settles it without generating anything: a 401 is
 * the key being refused, and any other refusal means the key got through and only the
 * model was wrong. Nothing is billed either way.
 */
async function keyAccepted(provider, timeoutMs) {
  try {
    const res = await fetch(`${provider.base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.keys[0]}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: '__asc_auth_probe_not_a_model__',
        messages: [{ role: 'user', content: '.' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, why: null };
  } catch {
    return { ok: null, why: 'unreachable' };     // says nothing either way
  }
}

async function catalogueFor(provider, timeoutMs) {
  try {
    const res = await fetch(`${provider.base}/models`, {
      headers: { Authorization: `Bearer ${provider.keys[0]}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ids: null, why: `HTTP ${res.status}`, key: null };
    const models = (await res.json()).data ?? [];
    const ids = new Set(models.map((m) => m.id));

    // What each one can be given. capture has to take a voice note and a scanned page,
    // and a suggestion that can do neither is worse than none — it looks right and fails
    // on first use. Three providers, three ways of saying it, and kiraai's `input_types`
    // is the one this missed: it made every kira suggestion a guess.
    const takes = (m, kind) =>
      m.capabilities?.[kind === 'audio' ? 'audioInput' : 'vision'] === true
      || (m.architecture?.input_modalities ?? []).includes(kind)
      || (m.input_types ?? []).includes(kind);

    const audio = new Set(models.filter((m) => takes(m, 'audio')).map((m) => m.id));
    const image = new Set(models.filter((m) => takes(m, 'image')).map((m) => m.id));

    const key = await keyAccepted(provider, timeoutMs);
    return { ids, audio, image, why: null, key };
  } catch (err) {
    return { ids: null, why: String(err.cause?.code ?? err.name), key: null };
  }
}

/**
 * @returns {{roles: Array, endpoints: Array, broken: Array}}
 *   A role is `broken` only when an endpoint answered and did not have any of its
 *   models. An endpoint that could not be asked proves nothing either way.
 */
export async function diagnose({ timeoutMs = 20000 } = {}) {
  const seen = new Map();
  const ask = async (provider) => {
    if (!seen.has(provider.name)) seen.set(provider.name, await catalogueFor(provider, timeoutMs));
    return seen.get(provider.name);
  };

  const roles = [];
  for (const [role, spec] of Object.entries(allModels())) {
    if (!spec || spec === 'none') { roles.push({ role, spec, state: 'off' }); continue; }

    const plan = planFor(spec, config.providers);
    if (!plan.length) {
      roles.push({ role, spec, state: 'broken', detail: 'به هیچ ارائه‌دهنده‌ای وصل نیست' });
      continue;
    }

    const links = [];
    let working = null;
    let asked = false;
    for (const { model, provider } of plan) {
      const { ids } = await ask(provider);
      if (!ids) { links.push({ model, provider: provider.name, state: 'unknown' }); continue; }
      asked = true;
      const here = ids.has(model);
      links.push({ model, provider: provider.name, state: here ? 'present' : 'absent' });
      if (here && !working) working = { model, provider: provider.name };
    }

    roles.push({
      role, spec, links, working,
      state: working ? 'ok' : asked ? 'broken' : 'unknown',
      detail: working ? null : 'هیچ‌کدام از حلقه‌ها روی اندپوینت نیست',
    });
  }

  // Naming a model that is actually there turns "none of these exist" into something
  // to type. The catalogues are already in hand; not using them made the report a
  // list of absences.
  const catalogues = new Map([...seen.entries()].map(([name, v]) => [name, v.ids]));
  const modality = new Map([...seen.entries()].map(([name, v]) => [name, { audio: v.audio, image: v.image }]));
  for (const r of roles) {
    if (r.state !== 'broken') continue;
    r.suggestion = suggestionFor(r.role, catalogues, (r.links ?? []).map((l) => l.model), modality);
    // Changing which model makes the vectors is not a like-for-like swap, and the
    // report should not offer one as though it were.
    r.warnsRebuild = r.role === 'embed'
      && r.suggestion?.length
      && !(r.links ?? []).some((l) => r.suggestion[0].endsWith(`/${l.model}`) || r.suggestion[0].startsWith(l.model));
  }

  return {
    roles,
    catalogues,
    endpoints: [...seen.entries()].map(([name, v]) => ({
      name,
      base: config.providers.get(name)?.base ?? '',
      models: v.ids ? v.ids.size : null,
      why: v.why,
      // false means the key was refused: the catalogue reads fine and nothing will run.
      keyOk: v.key?.ok ?? null,
    })),
    broken: roles.filter((r) => r.state === 'broken'),
    rejected: [...seen.entries()].filter(([, v]) => v.key?.ok === false).map(([name]) => name),
  };
}

export const consequenceOf = (role) => CONSEQUENCE[role] ?? '';

/**
 * A model id that IS on some endpoint and looks like what this role needs, so the
 * report can end with something to type rather than only with what is wrong.
 */
export function suggestionFor(role, catalogues, tried = [], modality = new Map()) {
  // capture is handed both a voice note and a scanned page, so it needs ears and eyes.
  // A model with neither is not a weaker candidate, it is a wrong one. Only applied
  // where the provider actually says: silence is not taken as "no".
  const needs = role === 'capture' ? ['audio', 'image']
    : role === 'transcribe' ? ['audio']
      : [];

  const unfit = (name, id) => {
    const known = modality.get(name);
    if (!known) return false;
    return needs.some((kind) => {
      const set = known[kind];
      return set && set.size > 0 && !set.has(id);
    });
  };

  // Almost always the right answer, and always the safest: the very model that was
  // asked for, under the prefix this gateway gives it. `google/gemini-3.6-flash` is
  // absent while `liara/google/gemini-3.6-flash` is right there. It matters most for
  // embeddings, where a different model is not a substitution at all — vectors only
  // mean anything against others from the same one.
  const sameModel = [];
  for (const [name, ids] of catalogues) {
    if (!ids) continue;
    for (const want of tried) {
      for (const id of ids) {
        if (id !== want && !id.endsWith(`/${want}`)) continue;
        if (unfit(name, id)) continue;
        sameModel.push(`${id}${name === 'default' ? '' : `@${name}`}`);
      }
    }
  }
  if (sameModel.length) return sameModel.slice(0, 3);

  // What a role needs, and what it must not be given: a reranker where an embedding
  // model belongs answers, and every comparison it makes is nonsense.
  const rules = {
    embed: { want: /embedding|-e5-|bge-m3/i, avoid: /rerank|tts|asr/i },
    rerank: { want: /rerank/i, avoid: null },
    capture: { want: /flash|gemini|gpt-[45]|omni/i, avoid: /rerank|embed|tts|asr|:online|image/i },
    research: { want: /:online|sonar/i, avoid: /rerank|embed|tts/i },
    structure: { want: /flash|mini|free/i, avoid: /rerank|embed|tts|asr|image/i },
    router: { want: /flash|mini|free/i, avoid: /rerank|embed|tts|asr|image/i },
    transcribe: { want: /whisper|asr|stt|transcribe/i, avoid: /tts/i },
  }[role];
  if (!rules) return null;

  // Where the provider says what a model accepts, that is the requirement and the name
  // is only a tiebreaker. Matching on the name alone ruled out ox-alpha — which takes
  // text, image, pdf, audio and video — because it is not called "flash" or "gemini".
  const knowsModality = needs.length
    && [...modality.values()].some((m) => needs.every((k) => m?.[k]?.size > 0));

  const out = [];
  for (const [name, ids] of catalogues) {
    if (!ids) continue;
    for (const id of ids) {
      if (!knowsModality && !rules.want.test(id)) continue;
      if (rules.avoid?.test(id)) continue;
      if (unfit(name, id)) continue;
      out.push(`${id}${name === 'default' ? '' : `@${name}`}`);
      if (out.length >= 3) return out;
    }
  }
  return out.length ? out : null;
}
