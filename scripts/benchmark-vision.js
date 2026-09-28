/**
 * Compare OCR of the same scanned book pages, with a human-corrected reference.
 * Default is a dry run. No model is called without --run.
 *
 * node scripts/benchmark-vision.js book.pdf truth.json gemini-3.1-flash-lite@mixdirect qwen3.5-vl@mixdirect
 * node scripts/benchmark-vision.js book.pdf truth.json gemini-3.1-flash-lite@mixdirect --run
 *
 * truth.json: {"2":"Exact text on page 2", "19":"Exact text on page 19"}
 */
import { readFile } from 'node:fs/promises';
import { scannedPages } from '../src/pdf.js';
import { chat } from '../src/llm.js';

const args = process.argv.slice(2);
const run = args.includes('--run');
const parts = args.filter((x) => x !== '--run');
if (parts.length < 3) {
  console.error('Usage: node scripts/benchmark-vision.js book.pdf truth.json MODEL [MODEL...] [--run]');
  process.exitCode = 2;
} else {
  const [pdfPath, truthPath, ...models] = parts;
  const truth = JSON.parse(await readFile(truthPath, 'utf8'));
  const pages = Object.keys(truth).map(Number).sort((a, b) => a - b);
  if (!pages.length || pages.some((n) => !Number.isInteger(n) || n < 1 || !String(truth[n]).trim()))
    throw new Error('truth.json needs numbered pages with a human-corrected transcript.');
  console.log(`Pages: ${pages.join(', ')}; models: ${models.join(', ')}`);
  if (!run) {
    console.log('Dry run: no model calls. Add --run to spend money.');
  } else {
    const pdf = await readFile(pdfPath);
    const outputs = [];
    const normalize = (s) => String(s).normalize('NFKC').replace(/[\u064a\u0649]/g, 'ی')
      .replace(/\u0643/g, 'ک').replace(/[\u200c\s]+/g, ' ').trim();
    function distance(a, b) {
      const left = [...normalize(a)], right = [...normalize(b)];
      let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
      for (let i = 1; i <= left.length; i++) {
        const next = [i];
        for (let j = 1; j <= right.length; j++)
          next[j] = Math.min(next[j - 1] + 1, previous[j] + 1,
            previous[j - 1] + Number(left[i - 1] !== right[j - 1]));
        previous = next;
      }
      return previous[right.length];
    }
    // Rasterize once per page, then give identical PNG bytes to every model.
    for (const page of pages) {
      for await (const image of scannedPages(pdf, { from: page, to: page })) {
        for (const model of models) {
          const started = Date.now();
          try {
            const { text, usage } = await chat({ model,
              system: 'متن این صفحه را دقیقاً رونویسی کن. فقط متن صفحه را بده؛ توضیح نده و چیزی اضافه نکن.',
              content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${image.buffer.toString('base64')}` } },
                { type: 'text', text: `صفحه ${page}` },
              ], maxTokens: 2500, noThinking: false });
            const errors = distance(truth[page], text);
            const chars = [...normalize(truth[page])].length;
            outputs.push({ model, page, errors, chars, ms: Date.now() - started,
              reportedToman: usage.costToman || null,
              inputTokens: usage.inTokens ?? null, outputTokens: usage.outTokens ?? null });
            console.log(`${model} page ${page}: CER ${(100 * errors / chars).toFixed(1)}%, ${Date.now() - started}ms`);
          } catch (err) {
            outputs.push({ model, page, error: String(err.message ?? err), ms: Date.now() - started });
            console.log(`${model} page ${page}: FAILED ${err.message}`);
          }
        }
      }
    }
    for (const model of models) {
      const rows = outputs.filter((r) => r.model === model);
      const ok = rows.filter((r) => !r.error);
      const chars = ok.reduce((n, r) => n + r.chars, 0);
      const errors = ok.reduce((n, r) => n + r.errors, 0);
      const knownCosts = ok.filter((r) => r.reportedToman != null);
      console.log(`${model}: ${ok.length}/${rows.length} pages, CER ${chars ? (100 * errors / chars).toFixed(1) : '—'}%, ` +
        `time ${Math.round(rows.reduce((n, r) => n + r.ms, 0) / 1000)}s, ` +
        `reported cost ${knownCosts.length === ok.length ? knownCosts.reduce((n, r) => n + r.reportedToman, 0) + ' toman' : 'unknown'}`);
    }
  }
}
