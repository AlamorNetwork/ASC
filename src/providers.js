/**
 * More than one model provider at a time, and more than one key for each.
 *
 * No single endpoint has everything this needs. One has embeddings and a reranker but
 * charges for chat; another gives chat away but has no embeddings at all. Tying the whole
 * program to one base URL meant taking the worst of whichever was chosen, so a model id
 * can now name where it lives:
 *
 *   MODEL_STRUCTURE=qwen3.8-flash-free@kira
 *   MODEL_EMBED=intfloat/multilingual-e5-large        (the default provider)
 *
 * A provider is declared by a pair of environment variables, so adding one needs no code:
 *
 *   KIRA_BASE_URL=https://kiraai.vn/api/v1
 *   KIRA_KEYS=key-one,key-two,key-three
 *
 * `@` is the separator because model ids already contain both `/` and `:`
 * (google/gemini-3.7-flash:online), and none of them contain `@`.
 *
 * A free tier is rate limited by design, so a model may be written as a chain and the
 * next link is used when the one before it is exhausted:
 *
 *   MODEL_STRUCTURE=qwen3.8-flash-free@kira,glm-5.3-free@kira,google/gemini-3.6-flash
 *
 * Falling back is not an optimisation here. Without it a rate-limited free model takes
 * the investigation down with it in the middle of a run.
 */

const DEFAULT = 'default';

/** Reads provider declarations out of the environment. */
export function buildProviders(env, fallback) {
  const providers = new Map();

  if (fallback?.base) {
    providers.set(DEFAULT, { name: DEFAULT, base: fallback.base, keys: [fallback.key] });
  }

  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^([A-Z][A-Z0-9_]*)_BASE_URL$/);
    if (!m || m[1] === 'ROUTER' || !v) continue;
    const name = m[1].toLowerCase();

    // Several accounts on one provider, so a per-key limit is not a per-provider limit.
    const keys = String(env[`${m[1]}_KEYS`] ?? env[`${m[1]}_KEY`] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!keys.length) continue;

    providers.set(name, { name, base: String(v).replace(/\/+$/, ''), keys });
  }

  return providers;
}

/**
 * Which key a provider should use right now.
 *
 * A key that has just been rate limited is set aside for a while rather than dropped:
 * on a free tier the limit is the normal state of affairs, not a broken credential, and
 * it will be usable again shortly.
 */
const cooling = new Map();   // `${provider}#${index}` -> timestamp it becomes usable again

const COOL_OFF = { rate: 60_000, credit: 30 * 60_000, auth: 24 * 60 * 60_000 };

const coolKey = (provider, index) => `${provider}#${index}`;

export function keysAvailable(provider) {
  const now = Date.now();
  return provider.keys
    .map((key, index) => ({ key, index }))
    .filter(({ index }) => (cooling.get(coolKey(provider.name, index)) ?? 0) <= now);
}

/**
 * Sets a key aside. `kind` decides for how long — a rate limit is a minute, an exhausted
 * balance is half an hour, and a rejected key is a day, since retrying it sooner only
 * spends time to be told the same thing.
 */
export function setAside(providerName, index, kind = 'rate') {
  cooling.set(coolKey(providerName, index), Date.now() + (COOL_OFF[kind] ?? COOL_OFF.rate));
}

export const kindOfFailure = (status) =>
  status === 429 ? 'rate'
    : status === 402 ? 'credit'
      : (status === 401 || status === 403) ? 'auth'
        : null;

/** For reporting: which keys are in play and which are resting. */
export function providerStatus(providers) {
  const now = Date.now();
  return [...providers.values()].map((p) => ({
    name: p.name,
    base: p.base,
    keys: p.keys.length,
    ready: keysAvailable(p).length,
    restingUntil: p.keys
      .map((_, i) => cooling.get(coolKey(p.name, i)) ?? 0)
      .filter((t) => t > now)
      .map((t) => Math.ceil((t - now) / 1000)),
  }));
}

/** Test seam and a way to clear a cool-off after fixing a key. */
export const clearCooling = () => cooling.clear();

/**
 * Turns `a@kira,b@kira,c` into the ordered list of attempts to make.
 * An unknown provider name is left out rather than throwing: one bad entry in a chain
 * should cost that link, not the whole call.
 */
export function planFor(spec, providers) {
  const plan = [];
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = part.lastIndexOf('@');
    const model = at === -1 ? part : part.slice(0, at);
    const name = at === -1 ? DEFAULT : part.slice(at + 1);
    const provider = providers.get(name);
    if (!provider || !model) continue;
    plan.push({ model, provider });
  }
  return plan;
}

/** The model id as the provider knows it, with any `@provider` stripped. */
export const bareModel = (spec) => {
  const first = String(spec ?? '').split(',')[0].trim();
  const at = first.lastIndexOf('@');
  return at === -1 ? first : first.slice(0, at);
};
