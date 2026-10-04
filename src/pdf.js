/**
 * PDF text extraction, locally and for free.
 *
 * Most PDFs carry a text layer, and pulling it out is a parsing job, not a model job.
 * `pdftotext` (poppler-utils) does it in well under a second at no cost. Only a PDF
 * with no text layer — a scan — needs a model, and that path is expensive enough that
 * the user is asked first.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/** Is poppler-utils installed? Cached, since it cannot change while we run. */
let available = null;
export async function pdftotextAvailable() {
  if (available !== null) return available;
  try {
    await run('pdftotext', ['-v'], { timeout: 5000 });
    available = true;
  } catch (err) {
    // Xpdf prints a valid version and exits 1 for -v; Poppler exits 0.
    available = /pdftotext version/i.test(`${err.stdout ?? ''} ${err.stderr ?? ''}`);
  }
  return available;
}

/**
 * @returns {{text:string, pages:number, perPage:string[], scanned:boolean, visionPages:number[]}}
 * A PDF can mix selectable text and image-only (or blank) pages.
 */
export const pageNeedsVision = (text) => String(text ?? '').trim().length < 80;

export async function extractPdf(buffer) {
  if (!await pdftotextAvailable()) {
    throw new Error('pdftotext نصب نیست. روی سرور: apt install -y poppler-utils');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'asc-pdf-'));
  const file = path.join(dir, 'in.pdf');
  try {
    await writeFile(file, buffer);

    let pages = 0;
    try {
      const { stdout } = await run('pdfinfo', [file], { timeout: 15000 });
      pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
    } catch { /* pdfinfo is optional; the page markers below still give a count */ }

    // -layout keeps table columns readable instead of interleaving them.
    const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
      timeout: 120000,
      maxBuffer: 200 * 1024 * 1024,
    });

    // pdftotext separates pages with a form feed.
    const parts = stdout.split('\f');
    if (parts.at(-1) === '') parts.pop();
    if (!pages) pages = parts.length;
    const perPage = Array.from({ length: pages }, (_, i) => parts[i] ?? '');

    const text = stdout.replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

    const visionPages = perPage.flatMap((pageText, i) => pageNeedsVision(pageText) ? [i + 1] : []);
    const scanned = visionPages.length > 0;

    return { text, pages, perPage, scanned, visionPages };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rough cost signal for the scanned path, where every page must go through vision. */
export const estimateVisionTokens = (pages) => pages * 1600;

/** Keep only one rasterized page in memory while a book is read. */
export async function* scannedPages(buffer, { from = 1, to, dpi = 150, skipPages = new Set() } = {}) {
  if (!await pdftotextAvailable()) throw new Error('poppler-utils نصب نیست.');
  const dir = await mkdtemp(path.join(tmpdir(), 'asc-scan-'));
  const file = path.join(dir, 'in.pdf');
  const output = path.join(dir, 'page');
  try {
    await writeFile(file, buffer);
    for (let page = from; page <= to; page++) {
      if (skipPages.has(page)) { yield { page, buffer: null }; continue; }
      await run('pdftoppm', ['-f', String(page), '-l', String(page),
        '-singlefile', '-png', '-r', String(dpi), file, output],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
      yield { page, buffer: await readFile(`${output}.png`) };
      await rm(`${output}.png`, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render pages to PNG so a scanned book can be read one page at a time.
 * Reading it in a single call means asking a model to emit an entire book as output,
 * which costs more than the input and truncates long before the end.
 */
export async function renderPages(buffer, { from = 1, to = null, dpi = 150 } = {}) {
  if (!await pdftotextAvailable()) {
    throw new Error('poppler-utils نصب نیست. روی سرور: apt install -y poppler-utils');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'asc-png-'));
  const file = path.join(dir, 'in.pdf');
  try {
    await writeFile(file, buffer);
    const args = ['-png', '-r', String(dpi), '-f', String(from)];
    if (to) args.push('-l', String(to));
    args.push(file, path.join(dir, 'page'));

    await run('pdftoppm', args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });

    const { readdir, readFile } = await import('node:fs/promises');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort();
    const pages = [];
    for (const name of names) {
      // pdftoppm names files page-01.png, page-02.png …
      const num = Number(name.match(/-(\d+)\.png$/)?.[1] ?? 0);
      pages.push({ page: num || pages.length + from, buffer: await readFile(path.join(dir, name)) });
    }
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
