/**
 * Which vision models this key may actually call.
 *
 *   node scripts/probe-vision.js
 *   node scripts/probe-vision.js google/gemini-3.6-flash openai/gpt-5.4-mini
 *
 * A provider listing 137 vision-capable models says nothing about which of them your
 * plan includes — gemini-3.7-flash answered 402 on a key whose embeddings were working
 * the same minute. Rather than guess from the list, this sends each one a real image and
 * prints the chain to paste.
 *
 * The image is generated here, not fetched: a two-colour PNG with a shape whose position
 * the model has to report. Cheap, and unambiguous about whether it looked.
 */
import zlib from 'node:zlib';
import { config } from '../src/config.js';
import { endpointFor } from '../src/llm.js';

/** A tiny PNG, written by hand so the test needs no file and no network. */
function testPng() {
  const W = 64, H = 64;
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);          // filter byte + RGB
    for (let x = 0; x < W; x++) {
      // A red square in the bottom-right quadrant, white everywhere else.
      const red = x >= W / 2 && y >= H / 2;
      row[1 + x * 3] = red ? 220 : 255;
      row[2 + x * 3] = red ? 30 : 255;
      row[3 + x * 3] = red ? 30 : 255;
    }
    rows.push(row);
  }
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;                        // 8-bit, truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dataUri = `data:image/png;base64,${testPng().toString('base64')}`;

const candidates = process.argv.slice(2).length ? process.argv.slice(2) : [
  config.models.capture,               // what is configured now
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'openai/gpt-5.4-mini',
  'openai/gpt-4.1-mini',
  'xiaomi/mimo-v2.5',
];

console.log(`\n${candidates.length} model(s), one 64×64 image each\n`);

const rows = [];
for (const spec of candidates) {
  const { model, base, key } = endpointFor(spec);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUri } },
            { type: 'text', text: 'در این تصویر یک مربع رنگی هست. فقط بگو رنگش چیست و در کدام ربع تصویر است.' },
          ],
        }],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const raw = await res.text();
    const ms = Date.now() - t0;

    if (!res.ok) {
      const why = res.status === 402 ? 'not in your plan, or no balance'
        : res.status === 429 ? 'rate limited'
          : (res.status === 401 || res.status === 403) ? 'key rejected'
            : res.status >= 500 ? 'their gateway'
              : res.status === 404 ? 'no such model' : 'error';
      console.log(`  ✖ ${model.padEnd(32)} ${res.status}  ${why}`);
      rows.push({ model, ok: false, status: res.status });
      continue;
    }

    const j = JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim());
    const said = (j.choices?.[0]?.message?.content ?? '').replace(/\s+/g, ' ').trim();
    // It saw the image only if it can name both the colour and where it was.
    const sawColour = /قرمز|سرخ|red/i.test(said);
    const sawPlace = /راست|پایین|چهارم|bottom|right/i.test(said);
    const toman = Math.round(j.usage?.total_cost_toman ?? 0);

    console.log(`  ${sawColour && sawPlace ? '✅' : '⚠ '} ${model.padEnd(32)} ${ms}ms` +
      (toman ? ` · ${toman} toman` : '') + `  ${said.slice(0, 60)}`);
    rows.push({ model, ok: sawColour && sawPlace, ms, toman });
  } catch (err) {
    console.log(`  ✖ ${model.padEnd(32)} ${err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code ?? err.message).slice(0, 40)}`);
    rows.push({ model, ok: false });
  }
}

const good = rows.filter((r) => r.ok).sort((a, b) => (a.toman || 0) - (b.toman || 0) || a.ms - b.ms);
console.log('');
if (good.length) {
  console.log('Read the image correctly, cheapest first:');
  for (const r of good) {
    console.log(`  ${(r.toman ? r.toman + ' toman' : 'free').padStart(11)}  ${String(Math.round(r.ms / 100) / 10) + 's'} ${r.model}`);
  }
  console.log('\nCapture reads voice notes and scanned pages, so it must accept both audio');
  console.log('and images — check the model list before trusting a cheap one here.\n');
  console.log(`  MODEL_CAPTURE=${good.map((r) => r.model).join(',')}`);
  console.log('\nA chain, so a 402 on one model no longer stops a document being read.');
} else {
  console.log('None of these worked. If they all returned 402 the account is out of');
  console.log('balance; if only some did, those models are not in your plan.');
}

const refused = rows.filter((r) => r.status === 402);
if (refused.length && refused.length < rows.length) {
  console.log(`\nⓘ ${refused.length} returned 402 while others answered, so the key is fine —`);
  console.log('  those models are not included in this plan. The client now rests the');
  console.log('  model rather than the key when that happens.');
}
console.log('');
