/**
 * Rebuilds the vectors, now that embedding is free.
 *
 *   node scripts/reembed.js          says what it would do, changes nothing
 *   node scripts/reembed.js --run
 *   node scripts/reembed.js --run --missing-only
 *
 * Two reasons to run it.
 *
 * Chunks with no vector at all: every remote embedding call that timed out left one
 * behind, and this corpus collected a lot of those. They are invisible to semantic
 * search and nothing retries them.
 *
 * And vectors made by a different model, or the same model at a different precision.
 * Embeddings are only comparable to others from the same model — a vector from the API's
 * full-precision e5-large and one from a local copy of it are close but not the same,
 * and mixing them quietly degrades every comparison rather than failing.
 */
import { config } from '../src/config.js';
import * as store from '../src/db.js';
import { embed } from '../src/chunks.js';
import { modelFor } from '../src/settings.js';

const RUN = process.argv.includes('--run');
const MISSING_ONLY = process.argv.includes('--missing-only');
const BATCH = 32;

const model = modelFor('embed');
console.log(`\nembedding model: ${model}`);
console.log(`database: ${config.dbPath}\n`);

const total = store.readOnlyQuery('SELECT count(*) c FROM chunks', 1)[0].c;
const without = store.readOnlyQuery('SELECT count(*) c FROM chunks WHERE embedding IS NULL', 1)[0].c;
const withVec = total - without;

console.log(`  ${total.toLocaleString('en-US')} chunks`);
console.log(`  ${withVec.toLocaleString('en-US')} have a vector`);
console.log(`  ${without.toLocaleString('en-US')} do not — invisible to semantic search`);

const target = MISSING_ONLY ? without : total;
console.log(`\n  would embed: ${target.toLocaleString('en-US')}` +
  (MISSING_ONLY ? '  (--missing-only)' : '  (everything, so one model made all of them)'));

if (!target) { console.log('\nNothing to do.\n'); process.exit(0); }

if (!RUN) {
  console.log('\nNothing was changed. To do it:\n');
  console.log(`  node scripts/reembed.js --run${MISSING_ONLY ? ' --missing-only' : ''}\n`);
  console.log('Check where embeddings are pointed first — this writes whatever that model');
  console.log('returns, so doing it against the wrong one replaces good vectors with');
  console.log('vectors that do not match the rest:\n');
  console.log(`  currently: ${model}\n`);
  process.exit(0);
}

// One sample first. Writing thousands of vectors of the wrong width, or none at all,
// is worth one round trip to rule out.
const probe = await embed(['نمونه‌ای برای سنجش']).catch((e) => {
  console.error(`\n✖ the embedding endpoint failed: ${e.message}\n`);
  process.exit(1);
});
const dims = probe.vectors[0]?.length ?? 0;
if (!dims) { console.error('\n✖ it returned no vector.\n'); process.exit(1); }
console.log(`\n  ${dims} dimensions per vector`);

// Existing vectors are Float32 blobs; a model of a different width cannot be mixed in.
const sample = store.readOnlyQuery('SELECT length(embedding) n FROM chunks WHERE embedding IS NOT NULL LIMIT 1', 1)[0];
if (sample && sample.n / 4 !== dims) {
  console.log(`\n  ⚠ the vectors already stored are ${sample.n / 4} dimensions, not ${dims}.`);
  console.log('    Those two cannot be compared at all, so this has to redo all of them.');
  if (MISSING_ONLY) {
    console.error('    --missing-only would leave the database with both. Run it without.\n');
    process.exit(1);
  }
}

const where = MISSING_ONLY ? 'WHERE embedding IS NULL' : '';
let done = 0;
let cost = 0;
const started = Date.now();

for (;;) {
  const rows = store.db.prepare(
    `SELECT id, text FROM chunks ${where} ORDER BY id LIMIT ${BATCH} OFFSET ${MISSING_ONLY ? 0 : done}`).all();
  if (!rows.length) break;

  try {
    const { vectors, costToman } = await embed(rows.map((r) => r.text));
    cost += costToman;
    for (let i = 0; i < rows.length; i++) {
      if (vectors[i]) store.setChunkEmbedding(rows[i].id, Buffer.from(new Float32Array(vectors[i]).buffer));
    }
  } catch (err) {
    // Stop rather than carry on writing gaps: a half-done pass is the state this script
    // exists to clean up.
    console.error(`\n✖ stopped at ${done}: ${err.message}`);
    console.error('  What is written so far is fine. Run it again to carry on.\n');
    process.exit(1);
  }

  done += rows.length;
  const rate = done / ((Date.now() - started) / 1000);
  process.stdout.write(`\r  ${done.toLocaleString('en-US')} / ${target.toLocaleString('en-US')}` +
    `  ·  ${rate.toFixed(0)}/s` + (cost ? `  ·  ${Math.round(cost)} toman` : '  ·  free'));
}

console.log(`\n\nDone. ${done.toLocaleString('en-US')} chunks in ${((Date.now() - started) / 60000).toFixed(1)} minutes` +
  (cost ? `, ${Math.round(cost).toLocaleString('en-US')} toman.` : ', at no cost.'));
console.log('\nCheck it took:  /doctor  in the bot, then ask it something.\n');
