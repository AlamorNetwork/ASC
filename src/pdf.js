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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  } catch {
    available = false;
  }
  return available;
}

/**
 * @returns {{text:string, pages:number, perPage:string[], scanned:boolean}}
 * `scanned` means the text layer is empty or near-empty, so the pages are images.
 */
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
    const perPage = stdout.split('\f');
    if (!pages) pages = perPage.length;

    const text = stdout.replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

    // A text layer that averages under ~80 characters a page is not a text layer.
    const scanned = text.length < Math.max(200, pages * 80);

    return { text, pages, perPage, scanned };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Rough cost signal for the scanned path, where every page must go through vision. */
export const estimateVisionTokens = (pages) => pages * 1600;
