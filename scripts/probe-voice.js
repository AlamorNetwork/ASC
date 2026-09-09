/**
 * Runs one real voice note through several models and reports what each one cost,
 * how long it took, and what it actually heard.
 *
 *   node scripts/probe-voice.js "ویس تست.ogg"
 *   node scripts/probe-voice.js voice.ogg google/gemini-3.5-flash-lite stt:openai/whisper-large-v3
 *
 * A model id on its own means the one-call route: a multimodal model listens and returns
 * the structured capture. `stt:<model>` means the two-call route: that model transcribes,
 * then the structure model makes sense of the text.
 *
 * Quality here is not something a script can score — it is your own voice, so you are the
 * judge. What the script can do is put every transcript side by side with its price, and
 * say how far each one drifted from the model currently in use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { chatJson, transcribe, audioPart, textPart } from '../src/llm.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('\nusage: node scripts/probe-voice.js <audio file> [model | stt:model ...]\n');
  process.exit(1);
}

const buffer = fs.readFileSync(file);

// A gateway namespaces model ids (liara/google/…) where a direct provider does not, so
// the defaults borrow whatever shape the configured capture model already has.
const parts = config.models.capture.split('/');
const ns = parts.length > 2 ? parts.slice(0, -2).join('/') + '/' : '';

const candidates = process.argv.slice(3).length ? process.argv.slice(3) : [
  config.models.capture,          // what runs today — the baseline
  `${ns}google/gemini-3.6-flash`,
  `${ns}google/gemini-3.5-flash-lite`,
  `${ns}xiaomi/mimo-v2.5`,
  `stt:${ns}openai/whisper-large-v3`,
  `stt:${ns}qwen/qwen3-asr-0.6b`,
];

const SYSTEM = `You turn one Persian voice note into a structured capture object.
Reply with a JSON object only — no prose, no code fence.
{"transcript":"verbatim Persian transcription, correct punctuation, proper nouns exact",
 "kind":"research | standing_intention | note | question | action_request | unclear",
 "title":"short Persian title","topic":"the subject or null"}
Always fill transcript. Losing the thought is the worst outcome.`;

/** Seconds of audio, when ffprobe is around. Cost per minute is the number that matters. */
function duration() {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}

const secs = duration();
console.log(`\n${path.basename(file)}  ·  ${(buffer.length / 1024).toFixed(0)} KB` +
  (secs ? `  ·  ${secs.toFixed(1)}s` : '') + `\n${config.router.base}\n`);

const results = [];

for (const spec of candidates) {
  const isStt = spec.startsWith('stt:');
  const model = isStt ? spec.slice(4) : spec;
  const label = isStt ? `${model} + ${config.models.structure}` : model;
  process.stdout.write(`── ${spec}\n`);

  const t0 = Date.now();
  try {
    let transcript, kind, title, costToman = 0, costUsd = 0, note = '';

    if (isStt) {
      const heard = await transcribe({ model, buffer });
      if (!heard.text) throw new Error('empty transcript');
      transcript = heard.text;
      costToman += heard.usage.costToman;
      costUsd += heard.usage.costUsd;
      // The endpoint usually declines to price this call; say so rather than print a
      // zero that reads as free.
      if (!heard.usage.costToman && !heard.usage.costUsd) note = 'stt cost not reported';

      const { data, usage } = await chatJson({
        model: config.models.structure,
        system: SYSTEM,
        content: `این متن پیاده‌سازی یک ویس است. به capture object تبدیلش کن.\n\n${heard.text}`,
      });
      kind = data.kind; title = data.title;
      costToman += usage.costToman; costUsd += usage.costUsd;
    } else {
      const { data, usage } = await chatJson({
        model,
        system: SYSTEM,
        content: [audioPart(buffer.toString('base64')), textPart('این ویس را به capture object تبدیل کن.')],
      });
      transcript = String(data.transcript ?? '').trim();
      kind = data.kind; title = data.title;
      costToman += usage.costToman; costUsd += usage.costUsd;
    }

    const ms = Date.now() - t0;
    results.push({ spec, label, transcript, kind, title, costToman, costUsd, ms, note });
    console.log(`   ✅ ${(ms / 1000).toFixed(1)}s  ·  ${costToman ? Math.round(costToman).toLocaleString('en-US') + ' toman' : (costUsd ? '$' + costUsd.toFixed(5) : 'cost not reported')}`);
    console.log(`      ${transcript.slice(0, 120)}${transcript.length > 120 ? '…' : ''}`);
  } catch (err) {
    console.log(`   ✖  ${String(err.message ?? err).slice(0, 160)}`);
    results.push({ spec, label, failed: String(err.message ?? err) });
  }
}

// ------------------------------------------------------------------ comparison

const ok = results.filter((r) => !r.failed);
if (!ok.length) {
  console.log('\nNothing worked. Check that the endpoint has these models.\n');
  process.exit(0);
}

/** Word overlap against the baseline, as a rough measure of how far a transcript drifted. */
const words = (s) => new Set(String(s).toLowerCase()
  .replace(/[.,!?؟،؛:«»"'()\[\]]/g, ' ').split(/\s+/).filter(Boolean));

const base = ok[0];
const baseWords = words(base.transcript);
for (const r of ok) {
  const w = words(r.transcript);
  const shared = [...w].filter((x) => baseWords.has(x)).length;
  r.agreement = baseWords.size ? shared / Math.max(baseWords.size, w.size) : 0;
}

console.log('\n' + '─'.repeat(74));
console.log('model'.padEnd(42) + 'cost'.padStart(12) + 'time'.padStart(8) + 'agree'.padStart(8));
console.log('─'.repeat(74));
for (const r of ok) {
  const cost = r.costToman ? Math.round(r.costToman).toLocaleString('en-US')
    : r.costUsd ? '$' + r.costUsd.toFixed(5) : '—';
  console.log(r.label.slice(0, 41).padEnd(42) + cost.padStart(12) +
    ((r.ms / 1000).toFixed(1) + 's').padStart(8) +
    (r === base ? 'base' : Math.round(r.agreement * 100) + '%').padStart(8));
}
console.log('─'.repeat(74));

if (secs) {
  console.log(`\nper minute of audio, at ${secs.toFixed(0)}s measured:`);
  for (const r of ok.filter((x) => x.costToman)) {
    console.log(`  ${r.label.slice(0, 41).padEnd(42)}${Math.round(r.costToman * 60 / secs).toLocaleString('en-US')} toman/min`);
  }
}

const priced = ok.filter((r) => r.costToman);
if (priced.length > 1) {
  const cheapest = priced.reduce((a, b) => (b.costToman < a.costToman ? b : a));
  const ratio = base.costToman ? base.costToman / cheapest.costToman : 0;
  if (cheapest !== base && ratio > 1.3) {
    console.log(`\n${cheapest.label} came in ${ratio.toFixed(1)}× cheaper than ${base.label}.`);
    console.log(`It agreed with it on ${Math.round(cheapest.agreement * 100)}% of words — read both transcripts below`);
    console.log('before switching. A cheap transcript that gets a name wrong is not cheap.');
  }
}

const unpriced = ok.filter((r) => r.note);
if (unpriced.length) {
  console.log(`\nNote: ${unpriced.map((r) => r.spec).join(', ')} — the endpoint did not report a cost for the`);
  console.log('transcription call, so the figure above counts only the structuring call.');
  console.log("The provider's dashboard has the real number.");
}

console.log('\n' + '═'.repeat(74));
console.log('full transcripts — you are the judge here');
console.log('═'.repeat(74));
for (const r of ok) {
  console.log(`\n── ${r.spec}  (${r.kind ?? '?'} · ${r.title ?? '?'})`);
  console.log(r.transcript);
}
console.log('');
