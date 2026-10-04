/** Free end-to-end check for owner-scoped book IDs and bounded mother reading. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-library-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const library = await import('../src/book-library.js');
const { motherTurn } = await import('../src/mother.js');
try {
  const owner = 'reader';
  const first = Number(store.insertDossier({ principalId: owner, topic: 'پرونده اول' }));
  const second = Number(store.insertDossier({ principalId: owner, topic: 'پرونده دوم' }));
  const old = Number(store.insertDocument({ principalId: owner, dossierId: first,
    filename: '2015.179866.pdf', kind: 'pdf', extraction: 'model_vision_pages',
    pages: 480, readPages: 20, sha256: 'same-pdf' }));
  const full = Number(store.insertDocument({ principalId: owner, dossierId: second,
    filename: 'Early Zoroastrianism.pdf', kind: 'pdf', extraction: 'local',
    pages: 480, readPages: 480, sha256: 'same-pdf' }));
  const witness = 'The sanctuary was situated at ground level in the existing building.';
  store.insertChunks(owner, second, full, [{ seq: 0, page: 7,
    text: `A source passage about architecture. ${witness} This observation is limited to the building discussed.` }]);
  store.saveAnalysisSection(owner, old, 1, 'section-hash', 'test', {
    about: 'مهرابه‌های رومی و معماری اوستیا', pageFrom: 7, pageTo: 8 });
  store.saveAnalysisSynthesis(owner, old, 'synthesis-hash', 'test', {
    overview: 'کتاب دربارهٔ آیین‌های ایرانی و نسبت آن‌ها با مهرابه‌های رومی است.' });
  const matches = library.searchBooks(owner, 'مهرابه', 5);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, old);
  assert.equal(matches[0].documentId, full);
  assert.deepEqual(matches[0].dossierIds, [first, second]);
  assert.equal(library.searchBooks(owner, 'sanctuary')[0].id, old,
    'content search should find a book with an unrelated filename');
  assert.deepEqual(library.searchBooks('someone-else', 'مهرابه'), []);
  const read = library.readBook(owner, old, { page: 7 });
  assert.equal(read.passages[0].page, 7);
  assert.match(read.passages[0].text, /ground level/);
  assert.equal(library.readBook('someone-else', old), null);
  assert.equal(library.readBook(owner, old, { page: 0 }), null);
  assert.equal(library.readBook(owner, old, { page: 7, limit: 100 }).passages.length, 1);
  const md = library.renderLibraryIndex(owner);
  assert.match(md, new RegExp(`کتاب #${old}`));
  assert.match(md, /مهرابه‌های رومی و معماری اوستیا/);
  assert.match(md, /2015\.179866\.pdf/);
  assert.ok(!md.includes(witness), 'index should not copy whole source passages');
  let sawInventory = false;
  const answered = await motherTurn({ principalId: owner, dossierId: first,
    userText: 'از کتاب دربارهٔ معماری چه می‌دانیم؟',
    ask: async ({ system, content }) => {
      if (system.includes('دستیار مادر')) {
        const packet = JSON.parse(content);
        sawInventory = packet.libraryBooks?.some((book) => book.id === old &&
          book.sections?.some((section) => section.title.includes('اوستیا')));
        return { data: { action: 'read_book', book_id: old, book_page: 7 }, usage: {} };
      }
      return { data: { answer: 'این بنا در سطح زمین بود.', passage_id: 1, quote: witness }, usage: {} };
    } });
  assert.equal(sawInventory, true);
  assert.equal(answered.action.type, 'library_read');
  assert.match(answered.text, /شاهد منطبق/);
  assert.match(answered.text, /صفحه 7/);
  const indexPath = library.refreshLibraryIndex(owner);
  assert.ok(fs.existsSync(indexPath));
  const unsupported = await motherTurn({ principalId: owner, dossierId: first,
    userText: 'کتاب را دوباره بررسی کن',
    ask: async ({ system }) => system.includes('دستیار مادر')
      ? { data: { action: 'read_book', book_id: old, book_page: 7 }, usage: {} }
      : { data: { answer: 'ادعای ساختگی', passage_id: 1, quote: 'A sentence not in the book' }, usage: {} } });
  assert.match(unsupported.text, /شاهد منطبق.*نبود/);
  const listing = await motherTurn({ principalId: owner, dossierId: first,
    userText: 'فهرست کتاب‌ها را نشان بده',
    ask: async () => ({ data: { action: 'search_library' }, usage: {} }) });
  assert.match(listing.text, new RegExp(`#${old}`));
  console.log('library check passed — stable PDF ID, deduplicated copies, global search, bounded reading, mother quote gate; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
