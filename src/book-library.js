/** Owner-scoped book catalogue over the existing PDF documents and chunks. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';

const plain = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ')
  .replace(/[<>`]/g, ' ').trim().slice(0, max);
const normal = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\u200c/g, ' ');
const termsOf = (value) => [...new Set(normal(value).match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 12);

function allBooks(principalId) {
  const rows = store.db.prepare(`SELECT d.*, a.result_json AS analysis_json
    FROM documents d LEFT JOIN document_analysis_synthesis a
      ON a.principal_id=d.principal_id AND a.document_id=d.id
    WHERE d.principal_id=? AND d.kind='pdf' ORDER BY d.id`).all(principalId);
  const groups = new Map();
  for (const row of rows) {
    const key = row.sha256 ? `sha256:${row.sha256}` : `document:${row.id}`;
    if (!groups.has(key)) groups.set(key, { id: row.id, sha256: row.sha256,
      copies: [], best: row, analysisSource: null, filenames: new Set(), dossierIds: new Set() });
    const book = groups.get(key);
    book.copies.push(row.id);
    book.filenames.add(row.filename);
    book.dossierIds.add(row.dossier_id);
    const quality = (doc) => [doc.read_pages ?? 0, doc.char_count ?? 0];
    const next = quality(row), prior = quality(book.best);
    if (next[0] > prior[0] || (next[0] === prior[0] && next[1] > prior[1])) book.best = row;
    if (row.analysis_json && (!book.analysisSource ||
        next[0] > quality(book.analysisSource)[0])) book.analysisSource = row;
  }
  return [...groups.values()].map((book) => {
    let analysis = null;
    try { analysis = JSON.parse(book.analysisSource?.analysis_json || 'null'); } catch { /* incomplete */ }
    const sections = store.analysisSections(principalId, (book.analysisSource ?? book.best).id).slice(0, 16).flatMap((row) => {
      try {
        const section = JSON.parse(row.result_json);
        return section.about ? [{ number: row.section_no, title: plain(section.about, 150),
          pageFrom: section.pageFrom ?? null, pageTo: section.pageTo ?? null }] : [];
      } catch { return []; }
    });
    return { id: book.id, documentId: book.best.id, sha256: book.sha256,
      title: plain(book.best.filename, 180), filenames: [...book.filenames].map((x) => plain(x, 180)),
      dossierIds: [...book.dossierIds], pages: book.best.pages,
      readPages: book.best.read_pages ?? book.best.pages ?? 0,
      overview: plain(analysis?.overview, 450), sections,
      copies: book.copies };
  });
}

/** Search names, model-generated section topics, and actual stored book text. */
export function searchBooks(principalId, query = '', limit = 8) {
  const books = allBooks(principalId);
  const words = termsOf(query);
  if (!words.length) return books.sort((a, b) => b.id - a.id).slice(0, limit);
  const textHits = new Set();
  const match = words.map((word) => `"${word.replace(/"/g, '')}"`).join(' OR ');
  try {
    const hits = store.db.prepare(`SELECT DISTINCT c.document_id FROM chunks_fts f
      JOIN chunks c ON c.id=f.rowid JOIN documents d ON d.id=c.document_id
      WHERE f.chunks_fts MATCH ? AND d.principal_id=? AND d.kind='pdf' LIMIT 200`)
      .all(match, principalId);
    for (const hit of hits) textHits.add(hit.document_id);
  } catch { /* malformed FTS input only loses the full-text lane */ }
  return books.map((book) => {
    const name = normal(book.filenames.join(' ')), overview = normal(book.overview);
    const sections = normal(book.sections.map((s) => s.title).join(' '));
    const score = words.reduce((sum, word) => sum + (name.includes(word) ? 4 : 0) +
      (overview.includes(word) ? 2 : 0) + (sections.includes(word) ? 2 : 0), 0) +
      (book.copies.some((id) => textHits.has(id)) ? 1 : 0);
    return { book, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.book.id - a.book.id)
    .slice(0, limit).map((item) => item.book);
}

/** Return only bounded passages; a book ID never means sending the whole PDF to a model. */
export function readBook(principalId, bookId, { query = '', page = null, limit = 4, documentId = null } = {}) {
  const id = Number(bookId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const book = allBooks(principalId).find((item) => item.id === id || item.copies.includes(id));
  if (!book) return null;
  const readDocumentId = book.copies.includes(Number(documentId)) ? Number(documentId) : book.documentId;
  const cap = Math.min(Math.max(Number(limit) || 4, 1), 4);
  const requestedPage = page == null ? null : Number(page);
  if (requestedPage !== null && (!Number.isSafeInteger(requestedPage) || requestedPage < 1)) return null;
  let chunks;
  if (requestedPage !== null) {
    chunks = store.db.prepare(`SELECT id,page,seq,text FROM chunks
      WHERE principal_id=? AND document_id=? AND page=? ORDER BY seq LIMIT ?`)
      .all(principalId, readDocumentId, requestedPage, cap);
  } else if (termsOf(query).length) {
    const match = termsOf(query).map((word) => `"${word.replace(/"/g, '')}"`).join(' OR ');
    try {
      chunks = store.db.prepare(`SELECT c.id,c.page,c.seq,c.text FROM chunks_fts f
        JOIN chunks c ON c.id=f.rowid WHERE f.chunks_fts MATCH ?
        AND c.principal_id=? AND c.document_id=? ORDER BY f.rank LIMIT ?`)
        .all(match, principalId, readDocumentId, cap);
    } catch { chunks = []; }
  } else chunks = store.documentChunks(principalId, readDocumentId).slice(0, cap);
  if (!chunks.length && requestedPage === null)
    chunks = store.documentChunks(principalId, readDocumentId).slice(0, cap);
  return { ...book, documentId: readDocumentId, requestedPage, passages: chunks.map((chunk, i) => ({
    ref: `[${i + 1}]`, page: chunk.page, seq: chunk.seq, text: chunk.text.slice(0, 1500) })) };
}

export function renderLibraryIndex(principalId) {
  const books = allBooks(principalId);
  const lines = ['# بانک کتاب ASC', '',
    '> این فهرست از اسناد ذخیره‌شده ساخته شده است. خلاصه‌ها و موضوعات بخش‌ها برداشت مدل‌اند؛ شاهد تاریخی فقط متن صفحه و نقل‌قول منطبق است.', ''];
  for (const book of books) {
    lines.push(`## کتاب #${book.id} · ${book.title}`, '',
      `- فایل‌ها: ${book.filenames.join('، ')}`,
      `- اثرانگشت فایل: ${book.sha256 || 'برای این سند قدیمی ثبت نشده'}`,
      `- پوشش: ${book.readPages} از ${book.pages ?? '?'} صفحه`,
      `- پرونده‌ها: ${book.dossierIds.map((id) => `#${id}`).join('، ')}`,
      `- شرح کوتاه: ${book.overview || 'هنوز تحلیل و شرح ثبت نشده است.'}`,
      ...(!book.overview ? [`- آغاز متن ذخیره‌شده: ${plain(store.documentPassages(principalId, book.documentId, '', 1)?.[0]?.text, 240) || 'هنوز متن قابل خواندن ندارد.'}`] : []), '');
    if (book.sections.length) lines.push('موضوعات بخش‌های تحلیل‌شده:',
      ...book.sections.map((s) => `- بخش ${s.number}${s.pageFrom ? `، صفحه ${s.pageFrom}${s.pageTo && s.pageTo !== s.pageFrom ? ` تا ${s.pageTo}` : ''}` : ''}: ${s.title}`), '');
  }
  if (!books.length) lines.push('هنوز PDFای در بانک ثبت نشده است.', '');
  return lines.join('\n').trimEnd() + '\n';
}

/** All OCR, text, image and PDF documents, across this owner's dossiers. */
export function renderSourceIndex(principalId) {
  const rows = store.sourceInventory(principalId);
  const lines = ['# فهرست منابع ASC', '',
    '> فهرست از پایگاه داده ساخته شده است؛ شرح تحلیلی شاهد تاریخی نیست. برای شاهد، متن ذخیره‌شدهٔ سند را بخوان.', '',
    `تعداد اسناد: ${rows.length}`, ''];
  for (const row of rows) {
    let overview = '';
    try { overview = plain(JSON.parse(row.analysis_json || '{}').overview, 400); }
    catch { /* analysis may be incomplete */ }
    lines.push(`## سند #${row.id} · ${plain(row.filename, 180)}`,
      `- پرونده: #${row.dossier_id} · ${plain(row.dossier_topic, 150)}`,
      `- نوع: ${plain(row.kind, 30)} · پوشش: ${row.read_pages ?? row.pages ?? '?'} از ${row.pages ?? '?'} صفحه · ${row.char_count ?? 0} نویسه`,
      `- شرح: ${overview || 'هنوز تحلیل کوتاه ثبت نشده است.'}`, '');
    if (row.opening_text) lines.push(`- آغاز متن ذخیره‌شده: ${plain(row.opening_text, 280)}`, '');
  }
  if (!rows.length) lines.push('هنوز سندی ثبت نشده است.', '');
  return lines.join('\n').trimEnd() + '\n';
}

export function refreshLibraryIndex(principalId) {
  const dir = path.join(path.dirname(config.dbPath),
    `${path.basename(config.dbPath, path.extname(config.dbPath))}-ledgers`,
    String(principalId).replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'library.md');
  fs.writeFileSync(file, renderLibraryIndex(principalId), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'sources.md'), renderSourceIndex(principalId), { mode: 0o600 });
  return file;
}
