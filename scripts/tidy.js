/**
 * Removes rows the self-check left in the real database.
 *
 *   node scripts/tidy.js              shows what it would remove, changes nothing
 *   node scripts/tidy.js --delete     removes them
 *
 * The suite used to open data/asc.db and create dossiers, documents, users and claims
 * under throwaway principals. Scoping kept them out of anyone's view, but they are still
 * in the file. It writes to data/check.db now, so this is for what accumulated before.
 *
 * A test principal is a word, a dash, and a millisecond timestamp — `fts-1788897792094`,
 * the shape `${name}-${Date.now()}` produces. Nothing a person would ever be called.
 * Anything that does not match that shape is left alone, and the dry run names every
 * principal that survives so the decision is made on sight rather than on trust.
 */
import { config } from '../src/config.js';
import * as store from '../src/db.js';

const DELETE = process.argv.includes('--delete');

const TEST = `(principal_id GLOB '*-1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
  OR principal_id IN ('selfcheck','principal-A','principal-B'))`;

const TABLES = [
  'dossiers', 'documents', 'chunks', 'claims', 'captures', 'messages', 'users',
  'intentions', 'intention_runs', 'investigations', 'episodes', 'dossier_links',
  'predictions',
];

console.log(`\n${config.dbPath}\n`);

// Everything that is not going, by name, before anything is counted as removable.
const survivors = store.readOnlyQuery(
  `SELECT principal_id, count(*) n FROM dossiers WHERE NOT ${TEST} GROUP BY principal_id ORDER BY n DESC`);

console.log('these principals stay, untouched:');
if (survivors.length) {
  for (const r of survivors) console.log(`   ${r.principal_id} — ${r.n} dossier(s)`);
} else {
  console.log('   (none — every dossier here was made by the test suite)');
}

let total = 0;
const counts = [];
for (const t of TABLES) {
  let n = 0;
  try { n = store.readOnlyQuery(`SELECT count(*) c FROM ${t} WHERE ${TEST}`)[0].c; }
  catch { continue; }   // a table an older database does not have yet
  const keep = store.readOnlyQuery(`SELECT count(*) c FROM ${t} WHERE NOT ${TEST}`)[0].c;
  counts.push([t, n, keep]);
  total += n;
}

console.log('\ntable              remove    keep');
console.log('─'.repeat(36));
for (const [t, n, keep] of counts) {
  console.log(`${t.padEnd(18)}${String(n).padStart(6)}${String(keep).padStart(8)}`);
}
console.log('─'.repeat(36));
console.log(`${'total'.padEnd(18)}${String(total).padStart(6)}`);

if (!total) {
  console.log('\nNothing to tidy.\n');
  process.exit(0);
}

if (!DELETE) {
  console.log('\nNothing was changed. Read the list above — especially the principals that');
  console.log('stay — and if it looks right:\n');
  console.log('  node scripts/tidy.js --delete\n');
  console.log('Back the file up first if you want to be able to change your mind:');
  console.log(`  cp "${config.dbPath}" "${config.dbPath}.bak"\n`);
  process.exit(0);
}

// One transaction: a half-tidied database with dossiers gone and their chunks left
// behind would be worse than an untidy one.
const removed = store.deleteWhere(TABLES, TEST);
console.log(`\nRemoved ${removed} row(s).`);
console.log('Run VACUUM to give the space back:  sqlite3 ' + config.dbPath + ' VACUUM\n');
