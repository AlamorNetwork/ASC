import { config } from './config.js';
import * as tg from './telegram.js';
import * as store from './db.js';
import * as settings from './settings.js';
import * as chat from './chat.js';
import { captureFromAudio, captureFromText } from './capture.js';
import { runResearch } from './research.js';
import { ingestToDossier, sha256 } from './ingest.js';
import { createWatch } from './intentions.js';
import { relatedDossiers } from './chunks.js';
import { startScheduler } from './scheduler.js';
import * as menu from './menu.js';

const esc = tg.esc;
const toman = (n) => Math.round(n).toLocaleString('fa-IR');

// The first chat to speak claims ownership, stored so a restart cannot hand the bot
// to whoever messages next. Everyone else must be let in by the owner, and each
// person's data is scoped to their own principal id — nothing is shared.
let ownerChatId = config.ownerChatId ?? (Number(store.getSetting('owner_chat_id')) || null);

/**
 * @returns {'owner'|'member'|'pending'|'blocked'} what this chat is allowed to do.
 * A newcomer is registered as pending and the owner is asked, once.
 */
async function admit(chatId, from) {
  const id = String(chatId);

  if (!ownerChatId) {
    ownerChatId = chatId;
    store.setSetting('owner_chat_id', chatId);
    store.upsertUser({ principalId: id, name: from?.first_name, username: from?.username, role: 'owner', state: 'active' });
    store.setUserState(id, 'active', 'owner');
    console.log(`[asc] owner claimed and stored: ${chatId}`);
    return 'owner';
  }
  if (chatId === ownerChatId) {
    if (!store.getUser(id)) {
      store.upsertUser({ principalId: id, name: from?.first_name, username: from?.username, role: 'owner', state: 'active' });
      store.setUserState(id, 'active', 'owner');
    }
    return 'owner';
  }

  const user = store.getUser(id);
  if (user?.state === 'active') return 'member';
  if (user?.state === 'blocked') return 'blocked';

  if (!user) {
    store.upsertUser({ principalId: id, name: from?.first_name, username: from?.username });
    const who = [from?.first_name, from?.username ? `@${from.username}` : null]
      .filter(Boolean).join(' ') || id;
    await tg.send(chatId,
      'سلام. این بات خصوصی است و دسترسی‌ات باید تأیید شود.\n\n<i>درخواستت فرستاده شد.</i>')
      .catch(() => {});
    await tg.send(ownerChatId,
      `👤 <b>${esc(who)}</b> درخواست دسترسی داد.\n<code>${id}</code>\n\n<i>داده‌هایش کاملاً جدا از داده‌های تو خواهد بود.</i>`,
      { buttons: [[
        { text: '✅ اجازه بده', callback_data: `m:allow:${id}` },
        { text: '🚫 رد کن', callback_data: `m:block:${id}` },
      ]] }).catch(() => {});
  }
  return 'pending';
}

const KINDS = { text: 'متن', image: 'تصویر', pdf: 'PDF' };

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

// Each column renders on its own, so it can be sent the moment it is ready
// instead of arriving as one wall of text at the end.
const SECTION = {
  summary: ({ topic, summary }) => [`🔎 <b>${esc(topic)}</b>`, '', esc(summary)].join('\n'),

  verified: ({ verified }) => {
    const L = ['✅ <b>تأییدشده</b> <i>— منبع را باز کردم و این جمله در آن بود</i>', ''];
    for (const c of verified) {
      L.push(`• ${esc(c.text)}`);
      if (c.sourceUrl) L.push(`   ↳ <a href="${esc(c.sourceUrl)}">${esc(c.sourceTitle || c.sourceUrl)}</a>`);
    }
    return L.join('\n');
  },

  disputed: ({ disputed }) => {
    const L = ['⚠️ <b>مورد اختلاف</b> <i>— منابع معتبر با هم مخالف‌اند</i>', ''];
    for (const d of disputed) {
      L.push(`• ${esc(d.question)}`);
      for (const s of d.sides ?? []) L.push(`   – ${esc(s.who)}: ${esc(s.position)}`);
    }
    return L.join('\n');
  },

  found: ({ found }) => {
    const L = ['📄 <b>پیدا شده</b> <i>— خواندم ولی تأیید نشد</i>', ''];
    for (const c of found) {
      L.push(`• ${esc(c.text)}`);
      const bits = [];
      if (c.sourceUrl) bits.push(`<a href="${esc(c.sourceUrl)}">${esc(c.sourceTitle || 'منبع')}</a>`);
      if (c.verifyNote) bits.push(`<i>${esc(c.verifyNote)}</i>`);
      if (bits.length) L.push(`   ↳ ${bits.join(' · ')}`);
    }
    return L.join('\n');
  },

  unresolved: ({ unresolved }) =>
    ['❓ <b>حل‌نشده</b>', '', ...unresolved.map((q) => `• ${esc(q)}`)].join('\n'),
};

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
      onSection: async (name, payload) => {
        if (SECTION[name]) await tg.send(chatId, SECTION[name]({ topic, ...payload }));
      },
    });

    await tg.edit(chatId, status.message_id, `🔎 <b>${esc(topic)}</b>`);

    if (!output.verified?.length) {
      await tg.send(chatId, '✅ <b>تأییدشده</b>\n\n<i>هیچ ادعایی تأیید نشد. این یک نتیجه‌ی صادقانه است، نه خطا.</i>');
    }
    if (output.sourceQualityNote) await tg.send(chatId, `⚠️ <i>${esc(output.sourceQualityNote)}</i>`);

    settings.setActiveDossier(principalId, dossierId);
    const tail = [`💰 ${toman(costToman)} تومان · پرونده #${dossierId}`];
    if (output.budgetExceeded) {
      tail.push('', `<i>از سقف بودجه رد شد — نتیجه ممکن است ناقص باشد.</i>`);
    }
    await tg.send(chatId, tail.join('\n'), {
      buttons: [
        [{ text: '💬 بحث کنیم', callback_data: `chat:${dossierId}` }],
        ...(output.budgetExceeded ? [[
          { text: '⬆️ سقف را دو برابر کن', callback_data: 'budget:x2' },
          { text: '♾ بی‌سقف', callback_data: 'budget:none' },
        ]] : []),
      ],
    });
  } catch (err) {
    console.error('[research] failed:', err);
    await tg.edit(chatId, status.message_id,
      `🔎 <b>${esc(topic)}</b>\n\n❌ تحقیق شکست خورد: ${esc(String(err.message ?? err))}\n\n<i>ثبت اولیه‌ات سالم است و از دست نرفته.</i>`);
  }
}

/** A web round on an existing dossier, when its own documents did not hold the answer. */
async function runWebResearch(chatId, principalId, dossierId, topic, question) {
  const status = await tg.send(chatId, `🌐 <b>${esc(question.slice(0, 60))}</b>\n\nدر حال جست‌وجو در وب…`);
  try {
    const { output, costToman } = await runResearch({
      principalId, dossierId, topic, question,
      onProgress: (m) => tg.edit(chatId, status.message_id, `🌐 <b>${esc(topic)}</b>\n\n${esc(m)}`),
      onSection: async (name, payload) => {
        if (SECTION[name]) await tg.send(chatId, SECTION[name]({ topic, ...payload }));
      },
    });
    await tg.edit(chatId, status.message_id, `🌐 <b>${esc(topic)}</b>`);
    if (!output.verified?.length) {
      await tg.send(chatId, '✅ <b>تأییدشده</b>\n\n<i>هیچ ادعایی تأیید نشد.</i>');
    }
    await tg.send(chatId, `💰 ${toman(costToman)} تومان · به پرونده #${dossierId} اضافه شد`);
  } catch (err) {
    await tg.edit(chatId, status.message_id, `🌐 ❌ ${esc(String(err.message ?? err))}`);
  }
}

/**
 * Menu actions. Some change something first, then the screen is re-rendered in place
 * so the chat keeps exactly one live menu instead of a stack of stale ones.
 */
async function handleMenu(chatId, principalId, { name, arg, isOwner, cb }) {
  let screenName = name;
  let notice = null;

  switch (name) {
    case 'open':
      settings.setActiveDossier(principalId, Number(arg));
      notice = 'باز شد';
      screenName = 'd';
      break;

    case 'watch':
      try {
        createWatch({ principalId, dossierId: Number(arg), everyHours: 24 });
        notice = 'پیگیری ساخته شد';
      } catch (err) { notice = err.message; }
      screenName = 'd';
      break;

    case 'unwatch':
      store.setIntentionState(principalId, Number(arg), 'suspended');
      notice = 'متوقف شد';
      screenName = 'watches';
      arg = undefined;
      break;

    case 'rel': {
      const rows = relatedDossiers(principalId, Number(arg));
      await tg.answerCallback(cb.id, rows.length ? `${rows.length} مورد` : 'چیزی پیدا نشد');
      await tg.send(chatId, rows.length
        ? ['🔗 <b>شاید مرتبط باشند</b>', '', ...rows.map((r) =>
            `#${r.dossier.id} ${esc(r.dossier.topic)} — ${Math.round(r.score * 100)}٪`),
           '', `<code>/link ${arg} &lt;id&gt;</code> برای وصل کردن`].join('\n')
        : 'پرونده‌ی مرتبطی پیدا نشد.\n<i>بردارها لازم‌اند — سندی به پرونده‌ها داده‌ای؟</i>');
      return;
    }

    // Owner-only membership decisions.
    case 'allow':
    case 'block': {
      if (!isOwner) return void await tg.answerCallback(cb.id, 'فقط مالک');
      const target = String(arg);
      store.setUserState(target, name === 'allow' ? 'active' : 'blocked', 'member');
      await tg.answerCallback(cb.id, name === 'allow' ? 'اجازه داده شد' : 'مسدود شد');
      await tg.edit(chatId, cb.message.message_id,
        `${cb.message.text}\n\n${name === 'allow' ? '✅ اجازه داده شد.' : '🚫 مسدود شد.'}`, []);
      if (name === 'allow') {
        await tg.send(Number(target),
          'دسترسی‌ات تأیید شد. 🎉\n\nویس بفرست یا بنویس. /menu را هم بزن.')
          .catch(() => {});
      }
      return;
    }

    case 'noop':
      return void await tg.answerCallback(cb.id);
  }

  const view = menu.screen(screenName, principalId, arg, { isOwner });
  if (!view) return void await tg.answerCallback(cb.id);
  await tg.answerCallback(cb.id, notice ?? undefined);
  await tg.edit(chatId, cb.message.message_id, view.text, view.buttons);
}

// Scanned PDFs waiting for the user to approve the expensive path.
const pendingScans = new Map();

/** Read a supplied file into the active dossier, opening one if none is active. */
async function handleDocument(chatId, principalId, { fileId, filename, mime, allowVision = false, dossierIdOverride = null, pageLimit = null, fromPage = null, resumeDocumentId = null }) {
  let dossierId = dossierIdOverride ?? settings.activeDossier(principalId);
  let opened = false;

  if (!dossierId || !store.getDossier(principalId, dossierId)) {
    dossierId = store.insertDossier({
      principalId, topic: filename || 'سند', question: null, state: 'open',
    });
    settings.setActiveDossier(principalId, dossierId);
    opened = true;
  }

  const d = store.getDossier(principalId, dossierId);
  const status = await tg.send(chatId,
    `📎 <b>${esc(filename || 'سند')}</b>\n\n${opened ? `پرونده‌ی تازه #${dossierId}` : `به پرونده #${dossierId} — ${esc(d.topic)}`}\n\nدر حال خواندن…`);

  try {
    const buffer = await tg.downloadFile(fileId);

    // Same bytes, already partly read? Continue from where it stopped rather than
    // charging again for pages we already hold.
    if (!fromPage && !resumeDocumentId) {
      const prior = store.findDocumentByHash(principalId, dossierId, sha256(buffer));
      if (prior && prior.read_pages && prior.pages && prior.read_pages < prior.pages) {
        const token = String(fileId).slice(-40);
        const remaining = prior.pages - prior.read_pages;
        pendingScans.set(token, {
          fileId, filename, mime, dossierId,
          fromPage: prior.read_pages + 1, resumeDocumentId: prior.id,
        });
        const perPage = Math.round((prior.cost_toman || 0) / Math.max(1, prior.read_pages)) || 900;
        await tg.edit(chatId, status.message_id, [
          `📎 <b>${esc(filename || 'سند')}</b>`, '',
          `قبلاً <b>${prior.read_pages}</b> از ${prior.pages} صفحه خوانده شده.`,
          `${remaining} صفحه مانده — از صفحه‌ی ${prior.read_pages + 1} ادامه می‌دهم.`, '',
          `~${toman(perPage)} تومان هر صفحه · <b>${toman(perPage * remaining)} تومان</b> تا آخر`,
        ].join('\n'), [
          [{ text: `📄 ۲۰ صفحه‌ی بعدی (~${toman(perPage * Math.min(20, remaining))}ت)`, callback_data: `scan20:${token}` }],
          [{ text: `📚 تا آخر (~${toman(perPage * remaining)}ت)`, callback_data: `scan:${token}` },
           { text: '✖️ بی‌خیال', callback_data: 'scancancel:0' }],
        ]);
        return;
      }
      if (prior && prior.pages && prior.read_pages >= prior.pages) {
        await tg.edit(chatId, status.message_id,
          `📎 <b>${esc(filename || 'سند')}</b>\n\n✔️ این سند کامل خوانده شده (${prior.pages} صفحه). دوباره پول نمی‌دهیم.\n\n<i>سؤالت را بپرس.</i>`);
        return;
      }
    }

    let out;
    try {
      out = await ingestToDossier({
        principalId, dossierId, buffer, filename, mime, allowVision, pageLimit,
        fromPage: fromPage || 1, resumeDocumentId,
        onProgress: (m) => tg.edit(chatId, status.message_id,
          `📎 <b>${esc(filename || 'سند')}</b>\n\n${esc(m)}`),
      });
    } catch (err) {
      // A scanned PDF has no text layer, so it can only be read through vision.
      // That is expensive enough to quote a price and ask first.
      if (!err.scanned) throw err;
      const token = String(fileId).slice(-40);
      pendingScans.set(token, { fileId, filename, mime, dossierId, pages: err.scanned.pages });
      const perPage = Math.round(err.scanned.estTokens / err.scanned.pages * 0.6);
      const est = perPage * err.scanned.pages;
      await tg.edit(chatId, status.message_id, [
        `📎 <b>${esc(filename || 'سند')}</b>`, '',
        `${err.scanned.pages} صفحه · <b>اسکن‌شده، بدون لایه‌ی متنی</b>`, '',
        'باید صفحه‌به‌صفحه با vision خوانده شود.',
        `تخمین: ~${toman(perPage)} تومان هر صفحه · <b>${toman(est)} تومان</b> برای همه`,
      ].join('\n'), [
        [{ text: `📄 ۲۰ صفحه‌ی اول (~${toman(perPage * 20)}ت)`, callback_data: `scan20:${token}` }],
        [{ text: `📚 همه (~${toman(est)}ت)`, callback_data: `scan:${token}` },
         { text: '✖️ بی‌خیال', callback_data: 'scancancel:0' }],
      ]);
      return;
    }

    const head = [`📎 <b>${esc(out.filename || 'سند')}</b> · ${KINDS[out.kind] ?? out.kind}`];
    if (out.pages) {
      head.push(out.readPages && out.readPages < out.pages
        ? `${out.readPages} از ${out.pages} صفحه خوانده شد`
        : `${out.pages} صفحه`);
    }
    if (out.textLength) head.push(`${out.textLength.toLocaleString('fa-IR')} کاراکتر`);
    if (out.chunks) head.push(`${out.chunks} تکه${out.embedded ? ` · ${out.embedded} بردار` : ''}`);
    if (out.extraction === 'local') head.push('<i>استخراج محلی، رایگان</i>');
    if (out.hasTables) head.push('شامل جدول');
    await tg.edit(chatId, status.message_id, head.join(' · '));

    if (out.summary) await tg.send(chatId, esc(out.summary));
    if (out.verified.length) await tg.send(chatId, SECTION.verified({ verified: out.verified }));
    if (out.found.length) await tg.send(chatId, SECTION.found({ found: out.found }));
    if (!out.verified.length && !out.found.length) {
      await tg.send(chatId, '<i>ادعای مشخصی از این سند بیرون نیامد. متنش ذخیره شد.</i>');
    }

    await tg.send(chatId,
      `💰 ${toman(out.costToman)} تومان · پرونده #${dossierId}`,
      { buttons: [[{ text: '💬 بحث کنیم', callback_data: `chat:${dossierId}` }]] });
  } catch (err) {
    console.error('[ingest] failed:', err);
    await tg.edit(chatId, status.message_id,
      `📎 <b>${esc(filename || 'سند')}</b>\n\n❌ ${esc(String(err.message ?? err))}`);
  }
}

/** One chat turn about the active dossier, streamed into a single edited message. */
async function handleChatTurn(chatId, principalId, dossierId, userText) {
  const d = store.getDossier(principalId, dossierId);
  if (!d) {
    settings.setActiveDossier(principalId, null);
    await tg.send(chatId, 'آن پرونده دیگر نیست. با /use یکی دیگر انتخاب کن.');
    return;
  }

  const placeholder = await tg.send(chatId, '…');
  let lastEdit = 0;
  let lastShown = '';

  // The search trail is shown as it happens, in one message that grows. A lead is
  // often the useful part — it says what the source actually calls the thing you asked
  // about — so it should not be buried until the end.
  let trailMsg = null;
  const trailLines = [];
  const showTrail = async (line) => {
    trailLines.push(line);
    const body = trailLines.join('\n');
    if (!trailMsg) trailMsg = await tg.send(chatId, body);
    else await tg.edit(chatId, trailMsg.message_id, body);
  };

  try {
    const { text, usage, research } = await chat.reply({
      principalId, dossierId, userText,
      onStep: async (step) => {
        if (step.kind === 'searching') {
          await showTrail(`🔍 <b>گام ${step.hop}</b> — ${step.queries.map((q) => `«${esc(q)}»`).join(' ')}`);
        } else if (step.kind === 'found') {
          const where = step.pages?.length ? ` · ص ${[...new Set(step.pages)].slice(0, 6).join('، ')}` : '';
          await showTrail(`   ${step.fresh ? `${step.fresh} پاساژ تازه` : 'چیز تازه‌ای نبود'}${where}`);
        } else if (step.kind === 'lead') {
          if (step.lead) await showTrail(`💡 ${esc(step.lead)}`);
          else if (step.missing) await showTrail(`   <i>هنوز پیدا نشده: ${esc(step.missing)}</i>`);
        } else if (step.kind === 'widening') {
          await showTrail(`🔎 در ${step.count} پرونده‌ی دیگر خودت هم می‌گردم…`);
        } else if (step.kind === 'elsewhere') {
          for (const e of step.elsewhere) {
            await showTrail(`📁 <b>#${e.dossier.id}</b> ${esc(e.dossier.topic)} — ${e.rows.length} پاساژ مرتبط`);
          }
        }
      },
      onDelta: (soFar) => {
        const now = Date.now();
        if (now - lastEdit < 1200 || soFar === lastShown) return;
        lastEdit = now;
        lastShown = soFar;
        tg.edit(chatId, placeholder.message_id, esc(soFar) + ' ▍');
      },
    });

    const total = (usage.costToman ?? 0) + (research?.costToman ?? 0);
    const tail = research?.hops
      ? `<i>${toman(total)} تومان · ${research.hops} گام · ${research.passages.length} پاساژ · پرونده #${dossierId}</i>`
      : `<i>${toman(total)} تومان · پرونده #${dossierId}</i>`;
    // Every answer can become a standing question, so a line of enquiry can keep
    // going without being asked again.
    await tg.edit(chatId, placeholder.message_id, `${esc(text)}\n\n${tail}`);
    await tg.send(chatId, '<i>می‌خواهی همین را مرتب پیگیری کنم؟</i>', {
      buttons: [[{ text: '👁 همین را پیگیری کن', callback_data: `watchq:${dossierId}` }]],
    });

    // Material sat in another dossier of theirs. Offer to link, since that makes the
    // connection permanent instead of a one-off lucky find.
    if (research?.elsewhere?.length) {
      const first = research.elsewhere[0].dossier;
      await tg.send(chatId,
        `📁 مطالب مرتبط در پرونده‌ی <b>#${first.id}</b> «${esc(first.topic)}» هم بود.\n\n<i>وصلشان کنم تا از این به بعد با هم جست‌وجو شوند؟</i>`,
        { buttons: [[{ text: `🔗 وصل کن به #${first.id}`, callback_data: `linkto:${first.id}` }]] });
    }

    // Neither this dossier nor the user's other sources hold it. Offer the web, never
    // take it — going online is a spend the user should choose.
    if (research?.notInCorpus) {
      await tg.send(chatId,
        'در هیچ‌کدام از اسناد تو پیدا نشد. بروم در وب تحقیق کنم؟',
        { buttons: [[{ text: '🌐 تحقیق در وب', callback_data: `webresearch:${dossierId}` }]] });
    }
  } catch (err) {
    await tg.edit(chatId, placeholder.message_id, `⚠️ ${esc(String(err.message ?? err))}`);
  }
}

async function handleCommand(chatId, principalId, text, isOwner) {
  if (text.startsWith('/menu') || text.startsWith('/start')) {
    const view = menu.screen('root', principalId, undefined, { isOwner });
    await tg.send(chatId, view.text, { buttons: view.buttons });
    return true;
  }

  if (text.startsWith('/users')) {
    if (!isOwner) return (await tg.send(chatId, 'فقط مالک.'), true);
    const view = menu.screen('users', principalId, undefined, { isOwner });
    await tg.send(chatId, view.text, { buttons: view.buttons });
    return true;
  }

  if (text.startsWith('/oldstart')) {
    await tg.send(chatId,
      ['سلام. ویس بفرست یا بنویس.', '',
       'هر چیزی که بفرستی ثبت می‌شود — حتی اگر نفهمم چه می‌خواهی.',
       'اگر درخواست تحقیق باشد، دکمه‌اش را می‌زنی و در پس‌زمینه انجام می‌دهم.', '',
       'وقتی تحقیقی تمام شد، دکمه‌ی «بحث کنیم» را بزن تا درباره‌اش حرف بزنیم.', '',
       '/use — پرونده‌ها · /close — خروج از گفتگو',
       '/watch — پیگیری خودکار · /intentions · /unwatch',
       '/link · /unlink · /related — پیوند پرونده‌ها',
       '/model · /models · /budget',
       '/cost · /recent · /db'].join('\n'));
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

  // ------------------------------------------------------- chat and control

  if (text.startsWith('/use')) {
    const arg = text.slice(4).trim();
    if (!arg) {
      const rows = store.listDossiers(principalId);
      if (!rows.length) return (await tg.send(chatId, 'هنوز پرونده‌ای نیست.'), true);
      const active = settings.activeDossier(principalId);
      await tg.send(chatId, ['📁 <b>پرونده‌ها</b>', '',
        ...rows.map((d) => `${d.id === active ? '▶️' : '  '} #${d.id} · ${esc(d.topic)} · ${d.state}`),
        '', '<code>/use &lt;id&gt;</code> برای انتخاب'].join('\n'));
      return true;
    }
    const d = store.getDossier(principalId, Number(arg));
    if (!d) return (await tg.send(chatId, 'پیدا نشد.'), true);
    settings.setActiveDossier(principalId, d.id);
    await tg.send(chatId, `💬 روی پرونده #${d.id} — ${esc(d.topic)}\n\nهر چه بنویسی گفتگو درباره‌ی همین است. <code>/close</code> برای خروج.`);
    return true;
  }

  if (text.startsWith('/close')) {
    settings.setActiveDossier(principalId, null);
    await tg.send(chatId, 'از گفتگو خارج شدم. حالا هر پیام دوباره یک ثبت جدید است.');
    return true;
  }

  if (text.startsWith('/models')) {
    try {
      const res = await fetch(`${config.router.base}/models`, {
        headers: { Authorization: `Bearer ${config.router.key}` },
      });
      const j = await res.json();
      const ids = (j.data ?? []).map((m) => m.id).sort();
      await tg.send(chatId, `<b>${ids.length} مدل</b>\n\n<code>${esc(ids.join('\n'))}</code>`);
    } catch (err) {
      await tg.send(chatId, `❌ ${esc(String(err.message ?? err))}`);
    }
    return true;
  }

  if (text.startsWith('/model')) {
    const arg = text.slice(6).trim();
    if (!arg) {
      const m = settings.allModels();
      await tg.send(chatId, ['🧠 <b>مدل‌ها</b>', '',
        `capture   <code>${esc(m.capture)}</code> <i>(باید صوت بپذیرد)</i>`,
        `research  <code>${esc(m.research)}</code> <i>(باید جست‌وجوگر باشد)</i>`,
        `structure <code>${esc(m.structure)}</code> <i>(گفتگو و ساختاردهی)</i>`, '',
        '<code>/model research openai/gpt-…</code>', '<code>/models</code> فهرست کامل'].join('\n'));
      return true;
    }
    const [role, ...rest] = arg.split(/\s+/);
    const id = rest.join(' ');
    if (!id) return (await tg.send(chatId, 'شناسه‌ی مدل را هم بده.'), true);
    try {
      settings.setModel(role, id);
      await tg.send(chatId, `✔️ ${role} → <code>${esc(id)}</code>\n\n<i>بدون ری‌استارت اعمال شد.</i>`);
    } catch (err) {
      await tg.send(chatId, `❌ ${esc(err.message)}`);
    }
    return true;
  }

  if (text.startsWith('/budget')) {
    const arg = text.slice(7).trim();
    if (!arg) {
      const b = settings.budget();
      const avg = settings.recentAverageCost(principalId);
      await tg.send(chatId, ['💰 <b>سقف هزینه‌ی هر دور تحقیق</b>', '',
        b === null ? 'بی‌سقف' : `$${b} ≈ ${toman(b * 310000)} تومان`,
        avg ? `میانگین دورهای اخیر: ${toman(avg * 310000)} تومان` : 'هنوز داده‌ای نیست.', '',
        '<code>/budget 0.03</code> · <code>/budget none</code>'].join('\n'));
      return true;
    }
    if (arg === 'none') {
      settings.setBudget(null);
      await tg.send(chatId, '♾ سقف برداشته شد. دیگر نمی‌پرسم و جلوی هیچ هزینه‌ای را نمی‌گیرم.');
    } else if (Number.isFinite(Number(arg))) {
      settings.setBudget(Number(arg));
      await tg.send(chatId, `✔️ سقف: $${arg} ≈ ${toman(Number(arg) * 310000)} تومان`);
    } else {
      await tg.send(chatId, 'عدد به دلار، یا <code>none</code>.');
    }
    return true;
  }

  if (text.startsWith('/watch')) {
    const parts = text.slice(6).trim().split(/\s+/).filter(Boolean);
    const dossierId = Number(parts[0]) || settings.activeDossier(principalId);
    const everyHours = Number(parts[1]) || 24;
    if (!dossierId) {
      await tg.send(chatId, 'اول با <code>/use &lt;id&gt;</code> پرونده‌ای انتخاب کن، یا <code>/watch 3</code> بزن.');
      return true;
    }
    try {
      const id = createWatch({
        principalId, dossierId, everyHours, createdFrom: text,
      });
      const it = store.getIntention(principalId, id);
      await tg.send(chatId, ['👁 <b>نیت ماندگار ساخته شد</b>', '',
        esc(it.title),
        `هر ${everyHours} ساعت یک بار دنبال چیز تازه می‌گردم.`,
        `تا ${it.until_at.slice(0, 10)} — بعدش می‌پرسم هنوز می‌خواهی یا نه.`, '',
        '<i>اگر چیزی تازه نبود، چیزی نمی‌گویم.</i>'].join('\n'));
    } catch (err) {
      await tg.send(chatId, `❌ ${esc(err.message)}`);
    }
    return true;
  }

  if (text.startsWith('/intentions') || text.startsWith('/watches')) {
    const rows = store.listIntentions(principalId);
    if (!rows.length) return (await tg.send(chatId, 'هنوز نیت ماندگاری نیست. <code>/watch</code> بزن.'), true);
    const mark = { armed: '👁', running: '⏳', suspended: '⏸', expired: '⌛' };
    await tg.send(chatId, ['👁 <b>نیت‌های ماندگار</b>', '', ...rows.map((i) =>
      `${mark[i.state] ?? '·'} #${i.id} ${esc(i.title)}\n` +
      `   هر ${i.every_hours}س · ${i.runs} اجرا${i.silent_runs ? ` (${i.silent_runs} بی‌نتیجه)` : ''} · ` +
      `${toman(i.cost_toman)} تومان · بعدی ${i.next_run_at.slice(5, 16).replace('T', ' ')}`
    ), '', '<code>/unwatch &lt;id&gt;</code> برای توقف'].join('\n'));
    return true;
  }

  if (text.startsWith('/unwatch')) {
    const id = Number(text.slice(8).trim());
    const it = store.getIntention(principalId, id);
    if (!it) return (await tg.send(chatId, 'پیدا نشد.'), true);
    store.setIntentionState(principalId, id, 'suspended');
    await tg.send(chatId, `⏸ «${esc(it.title)}» متوقف شد.`);
    return true;
  }

  if (text.startsWith('/link')) {
    const [x, y] = text.slice(5).trim().split(/\s+/).map(Number);
    const a = x || settings.activeDossier(principalId);
    if (!a || !y) {
      await tg.send(chatId, '<code>/link 3 7</code> — یا با پرونده‌ی فعال: <code>/link 7</code>');
      return true;
    }
    const b = x && y ? y : x;
    try {
      store.linkDossiers(principalId, a, b);
      const da = store.getDossier(principalId, a), db_ = store.getDossier(principalId, b);
      if (!da || !db_) throw new Error('یکی از پرونده‌ها پیدا نشد');
      await tg.send(chatId, `🔗 #${a} «${esc(da.topic)}» ↔ #${b} «${esc(db_.topic)}»\n\n<i>حالا وقتی در یکی سؤال کنی، متن آن یکی هم جست‌وجو می‌شود.</i>`);
    } catch (err) {
      await tg.send(chatId, `❌ ${esc(err.message)}`);
    }
    return true;
  }

  if (text.startsWith('/unlink')) {
    const [x, y] = text.slice(7).trim().split(/\s+/).map(Number);
    const a = x || settings.activeDossier(principalId);
    const removed = store.unlinkDossiers(principalId, a, y || x);
    await tg.send(chatId, removed ? '🔗 پیوند برداشته شد.' : 'چنین پیوندی نبود.');
    return true;
  }

  if (text.startsWith('/related')) {
    const id = Number(text.slice(8).trim()) || settings.activeDossier(principalId);
    if (!id) return (await tg.send(chatId, 'اول پرونده‌ای انتخاب کن.'), true);
    const rows = relatedDossiers(principalId, id);
    if (!rows.length) {
      await tg.send(chatId, 'پرونده‌ی مرتبطی پیدا نشد. <i>(بردارها لازم‌اند — سندی به پرونده‌ها داده‌ای؟)</i>');
      return true;
    }
    await tg.send(chatId, ['🔗 <b>شاید مرتبط باشند</b>', '',
      ...rows.map((r) => `#${r.dossier.id} ${esc(r.dossier.topic)} — شباهت ${Math.round(r.score * 100)}٪`),
      '', `<code>/link ${id} &lt;id&gt;</code> برای وصل کردن`].join('\n'));
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

  startScheduler({
    // A watch that found something new. One that found nothing says nothing.
    onReport: async ({ report, dossier, fresh, costToman, intention }) => {
      if (!ownerChatId) return;
      if (report) return void await tg.send(ownerChatId, report).catch(() => {});

      await tg.send(ownerChatId, [
        `👁 <b>${esc(intention.title)}</b>`, '',
        `${fresh.length} چیز تازه درباره‌ی «${esc(dossier.topic)}»`,
      ].join('\n'));

      const verified = fresh.filter((c) => c.status === 'verified');
      const found = fresh.filter((c) => c.status !== 'verified');
      if (verified.length) await tg.send(ownerChatId, SECTION.verified({ verified }));
      if (found.length) await tg.send(ownerChatId, SECTION.found({ found }));

      await tg.send(ownerChatId, `💰 ${toman(costToman)} تومان · پرونده #${dossier.id}`, {
        buttons: [[
          { text: '💬 بحث کنیم', callback_data: `chat:${dossier.id}` },
          { text: '⏸ بس کن', callback_data: `unwatch:${intention.id}` },
        ]],
      });
    },

    onExpired: async (intention) => {
      if (!ownerChatId) return;
      await tg.send(ownerChatId,
        `⌛ «${esc(intention.title)}» به پایان مهلتش رسید و متوقف شد.`,
        { buttons: [[{ text: '🔄 ۶۰ روز دیگر', callback_data: `renew:${intention.id}` }]] })
        .catch(() => {});
    },

    // A watch that keeps finding nothing is probably done. Ask once rather than
    // quietly spending money every day forever.
    onQuiet: async (intention) => {
      if (!ownerChatId) return;
      await tg.send(ownerChatId, [
        `👁 «${esc(intention.title)}»`, '',
        `${intention.silent_runs} بار پشت‌سرهم چیز تازه‌ای نبود.`,
        `تا حالا ${toman(intention.cost_toman)} تومان خرج کرده.`,
      ].join('\n'), {
        buttons: [[
          { text: '⏸ بس کن', callback_data: `unwatch:${intention.id}` },
          { text: '👁 ادامه بده', callback_data: `keepwatch:${intention.id}` },
        ]],
      }).catch(() => {});
    },
  });

  for await (const update of tg.updates()) {
    try {
      const msg = update.message;
      const cb = update.callback_query;
      const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
      if (!chatId) continue;

      const from = msg?.from ?? cb?.from;
      const access = await admit(chatId, from);
      if (access === 'pending' || access === 'blocked') continue;

      const principalId = String(chatId);
      const isOwner = access === 'owner';

      if (cb) {
        // Menu callbacks are `m:<screen>[:<arg>]` and all render in place.
        if (String(cb.data).startsWith('m:')) {
          const [, name, arg] = String(cb.data).split(':');
          await handleMenu(chatId, principalId, { name, arg, isOwner, cb });
          continue;
        }

        const [action, idStr] = String(cb.data).split(':');
        const id = Number(idStr);
        if (action === 'research') {
          await tg.answerCallback(cb.id, 'شروع کردم');
          await tg.edit(chatId, cb.message.message_id, cb.message.text ?? '', []);
          startResearch(chatId, principalId, id).catch((e) => console.error(e));
        } else if (action === 'keep') {
          await tg.answerCallback(cb.id, 'ذخیره شد');
          await tg.edit(chatId, cb.message.message_id, `${cb.message.text}\n\n✔️ ذخیره شد.`, []);
        } else if (action === 'chat') {
          settings.setActiveDossier(principalId, id);
          store.markActed(principalId, id);
          await tg.answerCallback(cb.id, 'در حال گفتگو');
          const d = store.getDossier(principalId, id);
          await tg.send(chatId,
            `💬 روی پرونده #${id} — ${esc(d?.topic ?? '')}\n\nبپرس. <code>/close</code> برای خروج.`);
        } else if (action === 'scan' || action === 'scan20') {
          const job = pendingScans.get(idStr);
          await tg.answerCallback(cb.id, job ? 'شروع کردم' : 'منقضی شده');
          await tg.edit(chatId, cb.message.message_id, cb.message.text ?? '', []);
          if (job) {
            pendingScans.delete(idStr);
            handleDocument(chatId, principalId, {
              ...job, allowVision: true, dossierIdOverride: job.dossierId,
              pageLimit: action === 'scan20' ? 20 : null,
              fromPage: job.fromPage ?? 1,
              resumeDocumentId: job.resumeDocumentId ?? null,
            }).catch((e) => console.error('[scan]', e));
          }
        } else if (action === 'webresearch') {
          await tg.answerCallback(cb.id, 'شروع کردم');
          await tg.edit(chatId, cb.message.message_id, cb.message.text ?? '', []);
          const d = store.getDossier(principalId, id);
          // The question that went unanswered is the last thing the user asked here.
          const lastUser = [...store.conversation(principalId, id, 12)]
            .reverse().find((m) => m.role === 'user');
          if (d && lastUser) {
            runWebResearch(chatId, principalId, id, d.topic, lastUser.text)
              .catch((e) => console.error('[webresearch]', e));
          }
        } else if (action === 'watchq') {
          // Turn the question just asked into a standing one.
          const lastUser = [...store.conversation(principalId, id, 12)]
            .reverse().find((m) => m.role === 'user');
          if (!lastUser) {
            await tg.answerCallback(cb.id, 'سؤالی پیدا نشد');
          } else {
            try {
              const wid = createWatch({
                principalId, dossierId: id, question: lastUser.text, everyHours: 24,
              });
              await tg.answerCallback(cb.id, 'ساخته شد');
              await tg.edit(chatId, cb.message.message_id,
                `👁 <b>پیگیری #${wid}</b>\n\n«${esc(lastUser.text.slice(0, 120))}»\n\n` +
                'هر ۲۴ ساعت دنبالش می‌گردم و <i>فقط وقتی چیز تازه‌ای باشد</i> خبر می‌دهم.', []);
            } catch (err) {
              await tg.answerCallback(cb.id, err.message.slice(0, 60));
            }
          }
        } else if (action === 'linkto') {
          const home = settings.activeDossier(principalId);
          try {
            store.linkDossiers(principalId, home, id);
            await tg.answerCallback(cb.id, 'وصل شد');
            await tg.edit(chatId, cb.message.message_id,
              `${cb.message.text}\n\n🔗 وصل شد — از این به بعد با هم جست‌وجو می‌شوند.`, []);
          } catch (err) {
            await tg.answerCallback(cb.id, err.message.slice(0, 60));
          }
        } else if (action === 'unwatch') {
          store.setIntentionState(principalId, id, 'suspended');
          await tg.answerCallback(cb.id, 'متوقف شد');
          await tg.edit(chatId, cb.message.message_id, `${cb.message.text}\n\n⏸ متوقف شد.`, []);
        } else if (action === 'keepwatch') {
          store.setIntentionState(principalId, id, 'armed');
          await tg.answerCallback(cb.id, 'ادامه می‌دهم');
          await tg.edit(chatId, cb.message.message_id, `${cb.message.text}\n\n👁 ادامه دارد.`, []);
        } else if (action === 'renew') {
          const it = store.getIntention(principalId, id);
          if (it) {
            store.setIntentionState(principalId, id, 'armed');
            createWatch({
              principalId, dossierId: it.dossier_id, title: it.title,
              everyHours: it.every_hours, days: 60,
            });
            store.setIntentionState(principalId, id, 'expired');
          }
          await tg.answerCallback(cb.id, '۶۰ روز دیگر');
          await tg.edit(chatId, cb.message.message_id, `${cb.message.text}\n\n🔄 تمدید شد.`, []);
        } else if (action === 'scancancel') {
          await tg.answerCallback(cb.id, 'بی‌خیال شدم');
          await tg.edit(chatId, cb.message.message_id, `${cb.message.text}\n\n✖️ خوانده نشد.`, []);
        } else if (action === 'budget') {
          const current = settings.budget();
          if (idStr === 'none') {
            settings.setBudget(null);
            await tg.answerCallback(cb.id, 'بی‌سقف شد');
            await tg.send(chatId, '♾ سقف برداشته شد. از این به بعد جلوی هیچ هزینه‌ای را نمی‌گیرم.');
          } else {
            const next = Number(((current ?? 0.05) * 2).toFixed(4));
            settings.setBudget(next);
            await tg.answerCallback(cb.id, 'سقف بالا رفت');
            await tg.send(chatId, `⬆️ سقف: $${next} ≈ ${toman(next * 310000)} تومان`);
          }
        }
        continue;
      }

      if (!msg) continue;

      if (msg.text && msg.text.startsWith('/')) {
        if (await handleCommand(chatId, principalId, msg.text, isOwner)) continue;
      }

      // Photos arrive as an array of sizes; the last one is the largest.
      const photo = msg.photo?.[msg.photo.length - 1];
      if (photo) {
        await handleDocument(chatId, principalId, {
          fileId: photo.file_id,
          filename: msg.caption?.slice(0, 60) || 'تصویر.jpg',
          mime: 'image/jpeg',
        });
        continue;
      }

      if (msg.document) {
        await handleDocument(chatId, principalId, {
          fileId: msg.document.file_id,
          filename: msg.document.file_name || 'سند',
          mime: msg.document.mime_type || '',
        });
        continue;
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
        // With a dossier open, plain text is conversation about it. Voice is always
        // a new capture, so a thought can still be dropped mid-discussion.
        const active = settings.activeDossier(principalId);
        if (active) {
          await tg.typing(chatId);
          await handleChatTurn(chatId, principalId, active, msg.text);
          continue;
        }
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
