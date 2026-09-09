/**
 * What a provider actually gives you, per key.
 *
 *   node scripts/probe-provider.js kira
 *   node scripts/probe-provider.js kira qwen3.8-flash-free glm-5.3-free
 *
 * A model list says what exists; it does not say what your key is allowed to call, how
 * fast it is rate limited, or whether a "free" model answers at all. This asks each key
 * for a real completion and reports what came back, so a chain in .env is built from
 * what works rather than from a web page.
 */
import { config } from '../src/config.js';
import { keysAvailable, providerStatus } from '../src/providers.js';

const name = (process.argv[2] ?? 'kira').toLowerCase();
const provider = config.providers.get(name);

if (!provider) {
  console.error(`\nNo provider called "${name}".\n`);
  console.error('Declared providers: ' + [...config.providers.keys()].join(', '));
  console.error(`\nDeclare one in .env:\n  ${name.toUpperCase()}_BASE_URL=https://…/v1` +
    `\n  ${name.toUpperCase()}_KEYS=key-one,key-two\n`);
  process.exit(1);
}

console.log(`\n${provider.name} · ${provider.base} · ${provider.keys.length} key(s)`);

// The shape of a key, without the key. Most "invalid key" reports are a value copied
// from the wrong place or truncated on the way into .env, and the prefix a provider
// documents is enough to tell — while staying safe to paste into a chat.
for (const [i, k] of provider.keys.entries()) {
  const marker = k.match(/^[A-Za-z]+[_-]/)?.[0] ?? k.slice(0, 4);
  console.log(`  key ${i + 1}: starts "${marker}…", ${k.length} chars`);
}
console.log('');

// The provider's own list, when it publishes one. Free models are the point here.
let listed = [];
try {
  const res = await fetch(`${provider.base}/models`, {
    headers: { Authorization: `Bearer ${provider.keys[0]}` },
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  listed = j.data ?? [];
  const free = listed.filter((m) => m.is_free);
  console.log(`${listed.length} models listed, ${free.length} marked free`);
  if (free.length) console.log('  ' + free.map((m) => m.id).join('\n  '));

  // What this project needs and a chat-only provider will not have.
  const kinds = new Set(listed.map((m) => m.type).filter(Boolean));
  const missing = ['embedding', 'rerank'].filter((k) => ![...kinds].some((t) => t.includes(k)));
  if (missing.length) {
    console.log(`\n⚠ no ${missing.join(' or ')} here — those roles must stay on another provider.`);
  }
} catch (err) {
  console.log(`could not list models: ${String(err.message).slice(0, 80)}`);
}

// All of the free ones, not a sample: the chain wants every model that has ever worked,
// and testing them costs nothing.
const models = process.argv.slice(3).length
  ? process.argv.slice(3)
  : listed.filter((m) => m.is_free).map((m) => m.id);

if (!models.length) {
  console.log('\nNothing to test. Name some models as arguments.\n');
  process.exit(0);
}

console.log(`\ntesting ${models.length} model(s) against ${provider.keys.length} key(s)\n`);

const rows = [];
for (const model of models) {
  for (const [i, key] of provider.keys.entries()) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'به فارسی در یک جمله بگو میترائیسم چه بود.' }],
          max_tokens: 400,
        }),
        signal: AbortSignal.timeout(90000),
      });
      const raw = await res.text();
      const ms = Date.now() - t0;

      if (!res.ok) {
        const why = res.status === 429 ? 'rate limited'
          : res.status === 402 ? 'out of credit'
            : (res.status === 401 || res.status === 403) ? 'key rejected'
              : res.status >= 500 ? 'their gateway is down for this model'
                : res.status === 404 ? 'no such model here' : 'error';
        console.log(`  ✖ ${model.padEnd(28)} key ${i + 1}  ${res.status} ${why}`);
        rows.push({ model, key: i + 1, ok: false, status: res.status, why });
        continue;
      }

      const j = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
      const text = j.choices?.[0]?.message?.content ?? '';
      const think = j.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

      // An empty reply is the failure mode that looks like success — a reasoning model
      // spending the whole budget thinking. Worth seeing before it is put in a chain.
      console.log(`  ${text.trim() ? '✅' : '⚠ '} ${model.padEnd(28)} key ${i + 1}  ${ms}ms` +
        `  ${j.usage?.completion_tokens ?? 0} out` + (think ? ` (${think} thinking)` : '') +
        (text.trim() ? '' : '  ← answered nothing'));
      if (text.trim() && i === 0) console.log(`      ${text.trim().slice(0, 110)}`);
      rows.push({ model, key: i + 1, ok: !!text.trim(), ms, think });
    } catch (err) {
      console.log(`  ✖ ${model.padEnd(28)} key ${i + 1}  ${err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code ?? err.message).slice(0, 40)}`);
      rows.push({ model, key: i + 1, ok: false, why: 'unreachable' });
    }
  }
}

// Ordered by the one thing actually measured. Latency is the difference between these
// models: they cost the same (nothing), and for the roles they suit, faster is better.
const working = [...new Map(
  rows.filter((r) => r.ok)
    .sort((a, b) => a.ms - b.ms)
    .map((r) => [r.model, r]),
).values()];

/**
 * The timing above is for a paragraph of prose. A routing decision is a dozen tokens of
 * JSON, so it is a different measurement — and it is the one that decides whether a
 * model can sit in front of every message. Reasoning models are where these diverge
 * most: some spend longer thinking about a one-word answer than writing an essay.
 */
if (working.length) {
  console.log('\ntiming a routing-shaped call (short JSON, which is what the router does)');
  for (const r of working) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${provider.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.keys[0]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: r.model,
          messages: [
            { role: 'system', content: 'فقط JSON بده: {"intent":"chat | research | keep"}' },
            { role: 'user', content: 'برو در مورد آیین میترائیسم تحقیق کن' },
          ],
          // Room for a reasoning model to think and still answer. Measuring with a tight
          // budget punishes exactly the models that llm.js retries successfully, which
          // would report them as broken when production handles them fine.
          max_tokens: 900,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const j = JSON.parse((await res.text()).replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
      const said = j.choices?.[0]?.message?.content ?? '';
      r.routerMs = Date.now() - t0;
      // Getting the answer right matters as much as speed: a router that cannot follow
      // a three-way instruction is not cheap, it is wrong on every message.
      r.routes = /research/i.test(said);
      console.log(`  ${String(Math.round(r.routerMs / 100) / 10).padStart(5)}s  ${r.model.padEnd(26)}` +
        (r.routes ? '✅ chose research' : `⚠ said: ${said.replace(/\s+/g, ' ').slice(0, 46)}`));
    } catch {
      r.routerMs = Infinity;
      console.log(`     —   ${r.model.padEnd(26)}✖ failed`);
    }
  }
}

console.log('');
if (working.length) {
  console.log('Answered, fastest first:');
  for (const r of working) console.log(`  ${String(Math.round(r.ms / 100) / 10).padStart(5)}s  ${r.model}`);

  // A model that returned 5xx is not a model to leave out. Which of these is up changes
  // from one run to the next — a set that answered a minute ago can be entirely down
  // now — so a chain built only from this sample would be built from a coin toss. A
  // link that is down costs one instant 502 and moves on, so the cheap thing is to
  // include everything and let the runtime sort it out, ordered by what we did measure.
  const alsoTried = models.filter((m) => !working.some((w) => w.model === m));

  // structure is a JSON role — every planner, assessor and gap prompt in this program
  // demands a JSON object — so the routing test measures it better than the prose one
  // does. A model that writes a fast paragraph and then cannot produce a short JSON
  // object belongs behind one that can, however quick it looked.
  const byJson = [...working].sort((a, b) =>
    (b.routes === true) - (a.routes === true) || a.ms - b.ms);
  const chain = [...byJson.map((r) => r.model), ...alsoTried]
    .map((m) => `${m}@${provider.name}`).join(',');

  console.log('\nstructure — planning and assessing inside a run, called dozens of times.');
  console.log('Every prompt in that role wants JSON back, so the ones that produced it');
  console.log('go first, however fast the others wrote prose:');
  console.log(`  MODEL_STRUCTURE=${chain},${config.models.structure}`);

  const proseOnly = working.filter((r) => r.routes === false || r.routerMs === Infinity);
  if (proseOnly.length) {
    console.log(`\n  Demoted: ${proseOnly.map((r) => r.model).join(', ')} — wrote prose but`);
    console.log('  could not return a short JSON object, which is all this role ever asks for.');
  }
  if (alsoTried.length) {
    console.log(`\n  The ${alsoTried.length} that failed just now are in the chain on purpose. Which of these`);
    console.log('  models is up changes between runs, a down link costs one instant 502,');
    console.log('  and leaving it out is what turns a bad minute into a missing model.');
  }

  // The router runs on every message with the user waiting, so its budget is patience,
  // not money. A free model that takes ten seconds is a worse router than a cheap one
  // that takes one, even though it costs less.
  const quick = working
    .filter((r) => r.routes && r.routerMs < 4000)
    .sort((a, b) => a.routerMs - b.routerMs);
  console.log('\nrouter — one decision per message, with you waiting for it.');
  if (quick.length) {
    console.log(`  MODEL_ROUTER=${quick.map((r) => `${r.model}@${provider.name}`).join(',')},${config.models.structure}`);
    console.log('  (only the ones that both answered correctly and came back under 4s)');
  } else {
    console.log(`  Nothing here answered in under 5 seconds, so leave the router where it is:`);
    console.log(`  MODEL_ROUTER=${config.models.structure}`);
    console.log('  It is one small call per message — the saving is not worth the wait.');
  }

  console.log('\nThe last link matters in both: a free tier runs out mid-investigation,');
  console.log('and with nothing behind it the run stops there.');

  // A model that chooses another model puts both cost and behaviour outside your control.
  const auto = working.filter((r) => /auto|router/i.test(r.model));
  if (auto.length) {
    console.log(`\n⚠ ${auto.map((r) => r.model).join(', ')} picks a model for you. What it picks,`);
    console.log('  and whether that one is free, is not something this can check — the');
    console.log("  provider's free list may not cover where it forwards. Prefer a named model.");
  }
} else {
  console.log('Nothing answered. Check the keys, or the model ids.');
}

// Whose fault the failures are. Getting this wrong sends you to re-register accounts
// when the provider is simply having a bad afternoon.
const failed = rows.filter((r) => !r.ok && r.status);
const rejected = failed.filter((r) => r.status === 401 || r.status === 403);
const upstream = failed.filter((r) => r.status >= 500);

if (rejected.length && rejected.length === rows.length) {
  console.log('\n✖ Every model rejected this key, which is what an invalid key looks like.');
  console.log('  Compare the prefix printed above with the one the provider documents —');
  console.log('  an API key and a browser session token are different things, and a');
  console.log('  session token copied out of a logged-in page fails exactly like this.');
  console.log('  Then check it was copied whole and the account is activated.');
} else if (rejected.length) {
  console.log(`\nⓘ ${rejected.length} model(s) returned 401 while others did not, so the key itself`);
  console.log('  is fine — those models are not open to this account. Leave them out of the chain.');
}

if (upstream.length) {
  console.log(`\nⓘ ${upstream.length} model(s) returned 5xx. That is their gateway, not your key —`);
  console.log('  the client moves to the next model in the chain and leaves the key alone.');
  console.log('  Worth re-running later; a free model can be down for hours.');
}

if (failed.some((r) => r.status === 429)) {
  console.log('\nSome keys were already rate limited — that is what more keys are for,');
  console.log('and the client rests a limited key for a minute before reusing it.');
}

console.log('\n' + JSON.stringify(providerStatus(config.providers)
  .find((s) => s.name === provider.name)) + '\n');
void keysAvailable;
