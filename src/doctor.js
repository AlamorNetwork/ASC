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

async function catalogueFor(provider, timeoutMs) {
  try {
    const res = await fetch(`${provider.base}/models`, {
      headers: { Authorization: `Bearer ${provider.keys[0]}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ids: null, why: `HTTP ${res.status}` };
    return { ids: new Set(((await res.json()).data ?? []).map((m) => m.id)), why: null };
  } catch (err) {
    return { ids: null, why: String(err.cause?.code ?? err.name) };
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

  return {
    roles,
    endpoints: [...seen.entries()].map(([name, v]) => ({
      name,
      base: config.providers.get(name)?.base ?? '',
      models: v.ids ? v.ids.size : null,
      why: v.why,
    })),
    broken: roles.filter((r) => r.state === 'broken'),
  };
}

export const consequenceOf = (role) => CONSEQUENCE[role] ?? '';

/**
 * A model id that IS on some endpoint and looks like what this role needs, so the
 * report can end with something to type rather than only with what is wrong.
 */
export function suggestionFor(role, endpoints, catalogues) {
  const wants = {
    embed: /embed|e5|bge/i,
    rerank: /rerank/i,
    capture: /flash|gpt|gemini|omni/i,
    research: /:online|sonar|perplexity/i,
    structure: /flash|mini|free/i,
    router: /flash|mini|free/i,
    transcribe: /whisper|asr|transcribe|stt/i,
  }[role];
  if (!wants) return null;

  for (const [name, ids] of catalogues) {
    if (!ids) continue;
    const hit = [...ids].find((id) => wants.test(id));
    if (hit) return `${hit}${name === 'default' ? '' : `@${name}`}`;
  }
  return null;
}
