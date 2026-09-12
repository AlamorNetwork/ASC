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

/**
 * What a failure says about whose problem it is.
 *
 * The three that mean "this key is spent" rest the key. The two that mean "this endpoint
 * cannot serve this model right now" do not — another key would be told exactly the same
 * thing, and resting a perfectly good key over the provider's own outage would spend the
 * whole free tier's worth of keys on a single bad afternoon. Everything else is a
 * malformed request, which is malformed on every key and every model.
 */
export const kindOfFailure = (status) =>
  status === 429 ? 'rate'
    : status === 402 ? 'credit'
      : (status === 401 || status === 403) ? 'auth'
        : status >= 500 ? 'upstream'          // their servers, not our credentials
          : status === 404 ? 'missing'        // this provider does not carry this model
            : null;

/** Failures that mean move on to the next model rather than the next key. */
export const blamesTheModel = (kind) => kind === 'upstream' || kind === 'missing';

/**
 * 402 is the ambiguous one, and the ambiguity matters.
 *
 * A gateway returns it both for "your balance is empty" and for "this model is not
 * included in your plan". Liara answered 402 for gemini-3.7-flash on a key whose
 * embeddings were working fine that minute, so it plainly meant the second — and
 * resting the key for half an hour over one model would have taken embeddings,
 * reranking and research down with it.
 *
 * So a 402 rests the model first. Only when a second, different model on the same key
 * also refuses is the account itself the likely problem, and then the key rests too.
 */
const refusedModels = new Map();   // provider#index -> Set of models that answered 402

export function noteRefusal(providerName, index, model) {
  const at = coolKey(providerName, index);
  const seen = refusedModels.get(at) ?? new Set();
  seen.add(model);
  refusedModels.set(at, seen);
  return seen.size;
}

export const refusalCount = (providerName, index) =>
  (refusedModels.get(coolKey(providerName, index))?.size ?? 0);

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

/**
 * A model that the provider could not serve, set aside briefly.
 *
 * Measured on kiraai's free tier: which models are up changes between runs minutes
 * apart — a set that answered fine can be entirely 502 the next time. The answer is a
 * long chain, but a long chain of mostly-down links would pay a failed round trip for
 * each of them on every single call. Remembering which ones just failed turns that into
 * one bad call rather than every call, and the memory is short because the outages are.
 */
const restingModels = new Map();   // `${provider}@${model}` -> usable again at
const MODEL_REST = 2 * 60_000;

export const restModel = (providerName, model) =>
  restingModels.set(`${providerName}@${model}`, Date.now() + MODEL_REST);

export const modelResting = (providerName, model) =>
  (restingModels.get(`${providerName}@${model}`) ?? 0) > Date.now();

/** Test seam and a way to clear a cool-off after fixing a key. */
export const clearCooling = () => {
  cooling.clear(); restingModels.clear(); refusedModels.clear();
};

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
