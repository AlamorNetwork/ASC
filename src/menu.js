/**
 * Inline menus.
 *
 * Every screen is built here and rendered by editing one message, so navigating does
 * not leave a trail of dead cards in the chat. Callback data is kept short and always
 * of the form `m:<screen>[:<arg>]` — Telegram caps it at 64 bytes.
 *
 * All user-supplied text passes through `esc` before it reaches a message, because a
 * dossier titled with a `<` would otherwise break the whole screen's HTML parse.
 */
import { esc } from './telegram.js';
import * as store from './db.js';
import * as settings from './settings.js';

const toman = (n) => Math.round(n || 0).toLocaleString('fa-IR');
const btn = (text, data) => ({ text, callback_data: data });
const back = (to = 'root') => btn('‹ بازگشت', `m:${to}`);

/** Telegram rejects a callback_data over 64 bytes, so ids are all we ever put in it. */
const short = (s, n = 28) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const SCREENS = {
  root(principalId) {
    const active = settings.activeDossier(principalId);
    const d = active ? store.getDossier(principalId, active) : null;
    return {
      text: [
        '🧠 <b>ASC</b>',
        '',
        d ? `پرونده‌ی باز: <b>#${d.id}</b> — ${esc(d.topic)}` : 'پرونده‌ای باز نیست.',
        '',
        '<i>ویس بفرست یا بنویس — هر چیزی ثبت می‌شود.</i>',
      ].join('\n'),
      buttons: [
        [btn('📁 پرونده‌ها', 'm:dossiers'), btn('👁 پیگیری‌ها', 'm:watches')],
        [btn('💰 هزینه', 'm:cost'), btn('🗄 داده‌ها', 'm:data')],
        [btn('⚙️ تنظیمات', 'm:settings'), btn('❓ راهنما', 'm:help')],
      ],
    };
  },

  dossiers(principalId) {
    const rows = store.listDossiers(principalId, 8);
    const active = settings.activeDossier(principalId);
    return {
      text: rows.length
        ? ['📁 <b>پرونده‌ها</b>', '', ...rows.map((d) =>
            `${d.id === active ? '▶️' : '·'} <b>#${d.id}</b> ${esc(d.topic)}`)].join('\n')
        : '📁 <b>پرونده‌ها</b>\n\nهنوز پرونده‌ای نیست. یک ویس یا سند بفرست.',
      buttons: [
        ...rows.map((d) => [btn(`${d.id === active ? '▶️ ' : ''}#${d.id} ${short(d.topic)}`, `m:d:${d.id}`)]),
        [back()],
      ],
    };
  },

  d(principalId, id) {
    const d = store.getDossier(principalId, Number(id));
    if (!d) return { text: 'پرونده پیدا نشد.', buttons: [[back('dossiers')]] };

    const claims = store.dossierClaims(principalId, d.id);
    const docs = store.dossierDocuments(principalId, d.id);
    const links = store.linkedDossiers(principalId, d.id);
    const count = (s) => claims.filter((c) => c.status === s).length;
    const active = settings.activeDossier(principalId) === d.id;

    return {
      text: [
        `📁 <b>#${d.id}</b> — ${esc(d.topic)}`,
        '',
        `✅ ${count('verified')}   ⚠️ ${count('disputed')}   📄 ${count('found')}`,
        `📎 ${docs.length} سند · 🔗 ${links.length} پیوند`,
        docs.length ? '' : null,
        ...docs.slice(0, 4).map((doc) =>
          `   ${esc(doc.filename)}${doc.pages ? ` · ${doc.read_pages ?? doc.pages}/${doc.pages} ص` : ''}`),
        links.length ? `\nمرتبط: ${links.map((l) => `#${l.id}`).join('، ')}` : null,
      ].filter((x) => x !== null).join('\n'),
      buttons: [
        [active ? btn('✔️ باز است', 'm:noop') : btn('💬 باز کن و بحث کن', `m:open:${d.id}`)],
        [btn('👁 پیگیری کن', `m:watch:${d.id}`), btn('🔗 مرتبط‌ها', `m:rel:${d.id}`)],
        [back('dossiers')],
      ],
    };
  },

  watches(principalId) {
    const rows = store.listIntentions(principalId).filter((i) => i.state !== 'expired');
    const mark = { armed: '👁', running: '⏳', suspended: '⏸' };
    return {
      text: rows.length
        ? ['👁 <b>پیگیری‌ها</b>', '', ...rows.map((i) =>
            `${mark[i.state] ?? '·'} <b>#${i.id}</b> ${esc(i.title)}\n` +
            `    هر ${i.every_hours}س · ${i.runs} اجرا · ${toman(i.cost_toman)} ت`)].join('\n')
        : '👁 <b>پیگیری‌ها</b>\n\nهیچ پیگیری فعالی نیست.\n\n<i>از صفحه‌ی یک پرونده می‌توانی پیگیری بسازی.</i>',
      buttons: [
        ...rows.filter((i) => i.state === 'armed')
          .map((i) => [btn(`⏸ توقف #${i.id}`, `m:unwatch:${i.id}`)]),
        [back()],
      ],
    };
  },

  cost(principalId) {
    const s = store.userSpend(principalId);
    const total = s.captures + s.research + s.documents + s.chat;
    const rows = store.costReport(principalId).slice(0, 6);
    return {
      text: [
        '💰 <b>هزینه‌ی تو</b>',
        '',
        `ثبت ویس و متن: ${toman(s.captures)} ت`,
        `تحقیق: ${toman(s.research)} ت`,
        `اسناد: ${toman(s.documents)} ت`,
        `گفتگو: ${toman(s.chat)} ت`,
        `<b>جمع: ${toman(total)} تومان</b>`,
        rows.length ? '\n<b>به تفکیک پرونده</b>' : '',
        ...rows.map((r) => `#${r.id} ${esc(short(r.topic, 24))} — ${toman(r.toman)} ت`),
      ].filter(Boolean).join('\n'),
      buttons: [[back()]],
    };
  },

  data(principalId) {
    const s = store.stats(principalId);
    return {
      text: [
        '🗄 <b>داده‌های تو</b>',
        '',
        `ثبت‌ها: ${s.captures}`,
        `پرونده‌ها: ${s.dossiers}`,
        `دورهای تحقیق: ${s.episodes}`,
        `ادعاها: ${s.claims} — ${s.verified} تأییدشده`,
        '',
        '<i>این داده‌ها فقط مال توست. کاربران دیگر آن را نمی‌بینند.</i>',
      ].join('\n'),
      buttons: [[back()]],
    };
  },

  settings(principalId, _arg, { isOwner }) {
    const m = settings.allModels();
    const b = settings.budget();
    return {
      text: [
        '⚙️ <b>تنظیمات</b>',
        '',
        `سقف هر تحقیق: ${b === null ? 'بی‌سقف' : `$${b}`}`,
        '',
        '<b>مدل‌ها</b>',
        `ثبت: <code>${esc(m.capture)}</code>`,
        `تحقیق: <code>${esc(m.research)}</code>`,
        `گفتگو: <code>${esc(m.structure)}</code>`,
        '',
        '<i>با /model و /budget قابل تغییرند.</i>',
      ].join('\n'),
      buttons: [
        isOwner ? [btn('👥 کاربران', 'm:users')] : [],
        [back()],
      ].filter((r) => r.length),
    };
  },

  users(_principalId, _arg, { isOwner }) {
    if (!isOwner) return { text: 'فقط مالک.', buttons: [[back('settings')]] };
    const rows = store.listUsers();
    const mark = { owner: '👑', member: '👤' };
    const state = { active: '', pending: ' — در انتظار', blocked: ' — مسدود' };
    return {
      text: ['👥 <b>کاربران</b>', '', ...rows.map((u) => {
        const s = store.userSpend(u.principal_id);
        const total = s.captures + s.research + s.documents + s.chat;
        return `${mark[u.role]} ${esc(u.name || u.principal_id)}${state[u.state] ?? ''}\n` +
               `    <code>${u.principal_id}</code> · ${toman(total)} ت`;
      })].join('\n'),
      buttons: [
        ...rows.filter((u) => u.role !== 'owner').map((u) => [
          u.state === 'blocked'
            ? btn(`✅ آزاد کن ${short(u.name || u.principal_id, 16)}`, `m:allow:${u.principal_id}`)
            : btn(`🚫 مسدود کن ${short(u.name || u.principal_id, 16)}`, `m:block:${u.principal_id}`),
        ]),
        [back('settings')],
      ],
    };
  },

  help() {
    return {
      text: [
        '❓ <b>راهنما</b>',
        '',
        '<b>ویس یا متن بفرست</b> — ثبت می‌شود، حتی اگر نفهمم چه می‌خواهی.',
        '<b>سند بفرست</b> — PDF، تصویر یا متن. وارد پرونده‌ی باز می‌شود.',
        '',
        'وقتی تحقیقی تمام شد، دکمه‌ی «بحث کنیم» گفتگو را روی همان پرونده باز می‌کند.',
        '',
        '<b>چهار ستون نتیجه</b>',
        '✅ منبع را باز کردم و این جمله در آن بود',
        '⚠️ منابع معتبر با هم مخالف‌اند',
        '📄 خواندم ولی تأیید نشد',
        '❓ حل نشد',
        '',
        '<i>«تأییدشده» یعنی این منبع واقعاً این را گفته — نه اینکه حقیقت دارد.</i>',
      ].join('\n'),
      buttons: [[back()]],
    };
  },

  noop() { return null; },
};

/**
 * Builds a screen. Returns null when the action has no screen of its own
 * (the caller handles those and then re-renders).
 */
export function screen(name, principalId, arg, ctx = {}) {
  const fn = SCREENS[name] ?? SCREENS.root;
  return fn(principalId, arg, ctx);
}

export const isScreen = (name) => Object.hasOwn(SCREENS, name);
