import { config } from './config.js';
import * as tg from './telegram.js';
import * as store from './db.js';
import { captureFromAudio, captureFromText } from './capture.js';
import { runResearch } from './research.js';

const esc = tg.esc;
const toman = (n) => Math.round(n).toLocaleString('fa-IR');

// v1 is single-principal. OWNER_CHAT_ID wins; otherwise the first chat to speak
// claims ownership and it is written to the database, so a restart cannot hand the
// bot to whoever messages next. Everyone else is ignored.
let ownerChatId = config.ownerChatId ?? (Number(store.getSetting('owner_chat_id')) || null);

const KIND_LABEL = {
  research: 'درخواست تحقیق',
  standing_intention: 'نیت ماندگار',
  note: 'یادداشت',
  question: 'پرسش',
  action_request: 'درخواست اقدام',
  unclear: 'نامشخص',
};

function captureCard(id, c, costToman) {
  const lines = [
    `🎧 <b>${esc(c.title || 'ثبت شد')}</b>`,
    '',
    esc(c.transcript),
    '',
    `نوع: ${KIND_LABEL[c.kind]}${c.confidence ? ` · اطمینان ${Math.round(c.confidence * 100)}٪` : ''}`,
  ];
  if (c.topic) lines.push(`موضوع: ${esc(c.topic)}`);
  if (c.request) lines.push(`درخواست: ${esc(c.request)}`);
  if (c.durability) lines.push(`نشانگر دوام: «${esc(c.durability)}» — نیت ماندگار در نسخه‌ی بعدی`);
  lines.push(`هزینه‌ی ثبت: ${toman(costToman)} تومان`);

  const buttons = [[
    { text: '🔎 تحقیق کن', callback_data: `research:${id}` },
    { text: '✔️ فقط ذخیره', callback_data: `keep:${id}` },
  ]];
  return { text: lines.join('\n'), buttons };
}

function renderResult(topic, out, costToman) {
  const L = [`🔎 <b>${esc(topic)}</b>`];
  if (out.summary) L.push('', esc(out.summary));

  if (out.verified?.length) {
    L.push('', '✅ <b>تأییدشده</b> <i>— منبع را باز کردم و این جمله در آن بود</i>');
    for (const c of out.verified) {
      L.push(`• ${esc(c.text)}`);
      if (c.sourceUrl) L.push(`   ↳ <a href="${esc(c.sourceUrl)}">${esc(c.sourceTitle || c.sourceUrl)}</a>`);
    }
  } else {
    L.push('', '✅ <b>تأییدشده</b>', '<i>هیچ ادعایی تأیید نشد. این یک نتیجه‌ی صادقانه است، نه خطا.</i>');
  }

  if (out.disputed?.length) {
    L.push('', '⚠️ <b>مورد اختلاف</b> <i>— منابع معتبر با هم مخالف‌اند</i>');
    for (const d of out.disputed) {
      L.push(`• ${esc(d.question)}`);
      for (const s of d.sides ?? []) {
        L.push(`   – ${esc(s.who)}: ${esc(s.position)}`);
      }
    }
  }

  if (out.found?.length) {
    L.push('', '📄 <b>پیدا شده</b> <i>— خواندم ولی تأیید نشد</i>');
    for (const c of out.found) {
      L.push(`• ${esc(c.text)}`);
      const bits = [];
      if (c.sourceUrl) bits.push(`<a href="${esc(c.sourceUrl)}">${esc(c.sourceTitle || 'منبع')}</a>`);
      if (c.verifyNote) bits.push(`<i>${esc(c.verifyNote)}</i>`);
      if (bits.length) L.push(`   ↳ ${bits.join(' · ')}`);
    }
  }

  if (out.unresolved?.length) {
    L.push('', '❓ <b>حل‌نشده</b>');
    for (const q of out.unresolved) L.push(`• ${esc(q)}`);
  }

  if (out.sourceQualityNote) L.push('', `⚠️ <i>${esc(out.sourceQualityNote)}</i>`);
  L.push('', `💰 ${toman(costToman)} تومان`);
  if (out.budgetExceeded) L.push('<i>بودجه‌ی این دور تمام شد — نتیجه ناقص است.</i>');
  return L.join('\n');
}

async function handleCapture(chatId, principalId, capture, usage, replyTo) {
  const id = store.insertCapture({
    principalId,
    source: capture.source,
    telegramMsg: replyTo,
    transcript: capture.transcript,
    kind: capture.kind,
    title: capture.title,
    request: capture.request,
    topic: capture.topic,
    durability: capture.durability,
    confidence: capture.confidence,
    raw: capture,
    costToman: usage.costToman,
  });
  const card = captureCard(id, capture, usage.costToman);
  await tg.send(chatId, card.text, { buttons: card.buttons, replyTo });
}

async function startResearch(chatId, principalId, captureId) {
  const cap = store.getCapture(principalId, captureId);
  if (!cap) return;

  const topic = cap.topic || cap.title || cap.transcript.slice(0, 60);
  const dossierId = store.insertDossier({
    principalId, captureId, topic, question: cap.request || cap.transcript,
  });

  const status = await tg.send(chatId, `🔎 <b>${esc(topic)}</b>\n\nشروع کردم…`);

  try {
    const { output, costToman } = await runResearch({
      principalId, dossierId,
      question: cap.request || cap.transcript,
      topic,
      onProgress: (msg) => tg.edit(chatId, status.message_id, `🔎 <b>${esc(topic)}</b>\n\n${esc(msg)}`),
    });
    await tg.edit(chatId, status.message_id, `🔎 <b>${esc(topic)}</b>\n\nتمام شد.`);
    await tg.send(chatId, renderResult(topic, output, costToman));
  } catch (err) {
    console.error('[research] failed:', err);
    await tg.edit(chatId, status.message_id,
      `🔎 <b>${esc(topic)}</b>\n\n❌ تحقیق شکست خورد: ${esc(String(err.message ?? err))}\n\n<i>ثبت اولیه‌ات سالم است و از دست نرفته.</i>`);
  }
}

async function handleCommand(chatId, principalId, text) {
  if (text.startsWith('/start')) {
    await tg.send(chatId,
      ['سلام. ویس بفرست یا بنویس.', '',
       'هر چیزی که بفرستی ثبت می‌شود — حتی اگر نفهمم چه می‌خواهی.',
       'اگر درخواست تحقیق باشد، دکمه‌اش را می‌زنی و در پس‌زمینه انجام می‌دهم.', '',
       '/cost — گزارش هزینه', '/recent — آخرین ثبت‌ها', '/db — دیتابیس'].join('\n'));
    return true;
  }
  if (text.startsWith('/cost')) {
    const rows = store.costReport(principalId);
    if (!rows.length) return (await tg.send(chatId, 'هنوز تحقیقی انجام نشده.'), true);
    const total = rows.reduce((s, r) => s + r.toman, 0);
    const L = ['💰 <b>گزارش هزینه</b>', ''];
    for (const r of rows) {
      L.push(`• ${esc(r.topic)} — ${toman(r.toman)} تومان · ${r.episodes} دور · ${r.acted} بار اقدام`);
    }
    L.push('', `جمع: ${toman(total)} تومان`);
    await tg.send(chatId, L.join('\n'));
    return true;
  }
  if (text.startsWith('/recent')) {
    const rows = store.recentCaptures(principalId);
    if (!rows.length) return (await tg.send(chatId, 'هنوز چیزی ثبت نشده.'), true);
    await tg.send(chatId, rows.map((r) =>
      `#${r.id} · ${KIND_LABEL[r.kind] ?? r.kind} — ${esc(r.title || r.transcript.slice(0, 50))}`).join('\n'));
    return true;
  }

  // ------------------------------------------------------------ inspection

  if (text.startsWith('/db')) {
    const s = store.stats(principalId);
    await tg.send(chatId, [
      '🗄 <b>وضعیت دیتابیس</b>', '',
      `ثبت‌ها: ${s.captures}`,
      `پرونده‌ها: ${s.dossiers}`,
      `دورهای تحقیق: ${s.episodes}`,
      `ادعاها: ${s.claims} — که ${s.verified} تا تأیید شده`,
      `جمع هزینه: ${toman(s.spent)} تومان`, '',
      '<code>/c &lt;id&gt;</code> ثبت · <code>/d &lt;id&gt;</code> پرونده · <code>/eps</code> دورها',
      '<code>/sql SELECT …</code> پرس‌وجوی خواندنی',
    ].join('\n'));
    return true;
  }

  if (text.startsWith('/c ')) {
    const row = store.getCapture(principalId, Number(text.slice(3).trim()));
    if (!row) return (await tg.send(chatId, 'پیدا نشد.'), true);
    await tg.send(chatId, [
      `🎧 <b>ثبت #${row.id}</b> · ${row.source} · ${row.created_at.slice(0, 19)}`, '',
      esc(row.transcript), '',
      `kind=${row.kind} · confidence=${row.confidence} · ${toman(row.cost_toman)} تومان`,
      row.topic ? `topic: ${esc(row.topic)}` : '',
      row.request ? `request: ${esc(row.request)}` : 'request: null',
      row.durability ? `durability: ${esc(row.durability)}` : '',
      '', '<b>raw</b>', `<pre>${esc(JSON.stringify(JSON.parse(row.raw_json), null, 1))}</pre>`,
    ].filter(Boolean).join('\n'));
    return true;
  }

  if (text.startsWith('/d ')) {
    const id = Number(text.slice(3).trim());
    const d = store.getDossier(principalId, id);
    if (!d) return (await tg.send(chatId, 'پیدا نشد.'), true);
    const claims = store.dossierClaims(principalId, id);
    const mark = { verified: '✅', disputed: '⚠️', found: '📄', unresolved: '❓' };
    const L = [`📁 <b>پرونده #${d.id}</b> · ${esc(d.topic)} · ${d.state}`, ''];
    for (const c of claims) {
      L.push(`${mark[c.status] ?? '·'} ${esc(c.text)}`);
      const bits = [];
      if (c.verify_method) bits.push(`<i>${c.verify_method}</i>`);
      if (c.verify_note) bits.push(esc(c.verify_note));
      if (c.source_url) bits.push(esc(c.source_url));
      if (bits.length) L.push(`   ↳ ${bits.join(' · ')}`);
      if (c.quote) L.push(`   «${esc(c.quote.slice(0, 160))}»`);
    }
    if (!claims.length) L.push('<i>هنوز ادعایی ثبت نشده.</i>');
    await tg.send(chatId, L.join('\n'));
    return true;
  }

  if (text.startsWith('/eps')) {
    const rows = store.recentEpisodes(principalId);
    if (!rows.length) return (await tg.send(chatId, 'هنوز دوری اجرا نشده.'), true);
    await tg.send(chatId, rows.map((e) =>
      `#${e.id} · پرونده ${e.dossier_id} · ${e.state} · ${toman(e.cost_toman)} تومان · ` +
      `${e.duration_ms ? Math.round(e.duration_ms / 1000) + 'ث' : '—'}${e.user_acted ? ' · اقدام شد' : ''}`
    ).join('\n'));
    return true;
  }

  if (text.startsWith('/sql')) {
    const sql = text.slice(4).trim();
    if (!sql) {
      await tg.send(chatId, ['<code>/sql SELECT …</code> — فقط خواندنی، حداکثر ۲۰ سطر.', '',
        'جدول‌ها: <code>captures</code> · <code>dossiers</code> · <code>episodes</code> · <code>claims</code>', '',
        'مثال:', '<code>/sql SELECT status, count(*) FROM claims GROUP BY status</code>'].join('\n'));
      return true;
    }
    try {
      const rows = store.readOnlyQuery(sql);
      if (!rows.length) return (await tg.send(chatId, 'بدون نتیجه.'), true);
      const body = rows.map((r) => JSON.stringify(r)).join('\n');
      await tg.send(chatId, `<pre>${esc(body.slice(0, 3500))}</pre>\n${rows.length} سطر`);
    } catch (err) {
      await tg.send(chatId, `❌ ${esc(err.message)}`);
    }
    return true;
  }

  return false;
}

export async function run() {
  const me = await tg.getMe();
  console.log(`[asc] connected as @${me.username}`);
  console.log(ownerChatId
    ? `[asc] owner: ${ownerChatId}`
    : '[asc] unclaimed — the first chat to message becomes the owner');

  for await (const update of tg.updates()) {
    try {
      const msg = update.message;
      const cb = update.callback_query;
      const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
      if (!chatId) continue;

      if (!ownerChatId) {
        ownerChatId = chatId;
        store.setSetting('owner_chat_id', chatId);
        console.log(`[asc] owner claimed and stored: ${chatId}`);
      }
      if (chatId !== ownerChatId) {
        console.log(`[asc] ignored message from ${chatId}`);
        continue;
      }
      const principalId = String(ownerChatId);

      if (cb) {
        const [action, idStr] = String(cb.data).split(':');
        const id = Number(idStr);
        if (action === 'research') {
          await tg.answerCallback(cb.id, 'شروع کردم');
          await tg.edit(chatId, cb.message.message_id, cb.message.text ?? '', []);
          startResearch(chatId, principalId, id).catch((e) => console.error(e));
        } else if (action === 'keep') {
          await tg.answerCallback(cb.id, 'ذخیره شد');
          await tg.edit(chatId, cb.message.message_id, `${cb.message.text}\n\n✔️ ذخیره شد.`, []);
        }
        continue;
      }

      if (!msg) continue;

      if (msg.text && msg.text.startsWith('/')) {
        if (await handleCommand(chatId, principalId, msg.text)) continue;
      }

      const voice = msg.voice ?? msg.audio ?? msg.video_note;
      if (voice) {
        await tg.typing(chatId);
        const buf = await tg.downloadFile(voice.file_id);
        const { capture, usage } = await captureFromAudio(buf);
        await handleCapture(chatId, principalId, { ...capture, source: 'voice' }, usage, msg.message_id);
        continue;
      }

      if (msg.text) {
        await tg.typing(chatId);
        const { capture, usage } = await captureFromText(msg.text);
        await handleCapture(chatId, principalId, { ...capture, source: 'text' }, usage, msg.message_id);
        continue;
      }

      await tg.send(chatId, 'فعلاً فقط ویس و متن. بقیه بعداً.');
    } catch (err) {
      // A memory layer must never take the conversation down with it.
      console.error('[asc] update failed:', err);
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) await tg.send(chatId, `⚠️ خطا: ${esc(String(err.message ?? err))}`).catch(() => {});
    }
  }
}
