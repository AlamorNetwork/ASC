/** A sourced, portable decision memo for an app idea. Model proposals remain proposals. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const plain = (value, limit = 500) => String(value ?? '').replace(/[\r\n\t]+/g, ' ')
  .replace(/[<>`|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
const list = (value, limit = 8) => (Array.isArray(value) ? value : []).slice(0, limit);
const safeUrl = (value) => {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
};

export function ideaSources(reports = []) {
  const sources = [];
  const seen = new Set();
  for (const entry of reports) for (const finding of entry.report?.findings ?? []) {
    const url = safeUrl(finding.sourceUrl);
    const documentId = Number(finding.documentId);
    const validDocument = Number.isSafeInteger(documentId) && documentId > 0;
    const quote = plain(finding.quote, 700);
    if (!quote || (!url && !validDocument)) continue;
    const key = `${url || documentId}|${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ id: `S${sources.length + 1}`, url, documentId: validDocument ? documentId : null,
      page: Number(finding.page) || null, quote, finding: plain(finding.text, 350) });
    if (sources.length >= 24) return sources;
  }
  return sources;
}

export function renderIdeaReport({ title, rootId, summary, result = {}, proposal = {}, sources = [],
  referenceReview = { books: [], note: '' } }) {
  const refs = new Set(sources.map((source) => source.id));
  const evidence = (item) => {
    const ids = list(item?.evidence, 6).map(String).filter((id) => refs.has(id));
    return ids.length ? ` — ${ids.map((id) => `[${id}]`).join('، ')}` : ' — شاهد کافی در این دور ثبت نشده؛ پیشنهاد نیازمند ارزیابی است';
  };
  const points = (items, field = 'text') => list(items).length ? list(items).map((item) => {
    if (typeof item === 'string') return `- ${plain(item, 700)} — پیشنهاد/فرضیه؛ شاهد مستقیم ثبت نشده`;
    return `- **${plain(item?.name || item?.title || 'مورد', 100)}:** ${plain(item?.[field] || item?.reason, 700)}${evidence(item)}`;
  }) : ['- هنوز ارزیابی مستند برای این بخش ثبت نشده است.'];
  const decisions = list(proposal.stack).map((item) =>
    `| ${plain(item?.layer, 80)} | ${plain(item?.choice, 120)} | ${plain(item?.why, 300)}${evidence(item)} |`);
  const flow = list(proposal.flow, 10).map((item, i) => ({ id: `N${i}`,
    label: plain(item, 90).replace(/["\\\[\]{}();]/g, '') }));
  const diagram = flow.length >= 2 ? ['```mermaid', 'flowchart TD',
    ...flow.map((item) => `  ${item.id}["${item.label}"]`),
    ...flow.slice(1).map((item, i) => `  N${i} --> ${item.id}`), '```']
    : ['```mermaid', 'flowchart TD', '  A["نیاز کاربر"] --> B["پژوهش و اعتبارسنجی"]',
      '  B --> C["نمونه اولیه"]', '  C --> D["آزمون و اصلاح"]', '```'];
  const coverage = sources.length ? `این گزارش از ${sources.length} گذرگاه یا نقل‌قول ثبت‌شده در پژوهش استفاده می‌کند. انطباق لفظی به‌تنهایی صحت یا مناسب‌بودن مهندسی را ثابت نمی‌کند.`
    : 'در این دور شاهد قابل استناد ثبت نشد؛ تصمیم‌ها مقدماتی‌اند و نیاز به بررسی منابع دارند.';
  const lines = [
    `# ارزیابی ایده: ${plain(title, 200)}`, '',
    `> نیت پژوهشی #${Number(rootId)} · ${new Date().toISOString().slice(0, 10)} · ${result.incomplete?.length ? 'پیش‌نویس؛ پژوهش ناتمام' : 'گزارش این دور پژوهش'}`,
    '', '## دامنه و کیفیت شواهد', coverage,
    result.incomplete?.length ? `- ${result.incomplete.length} زیرنیت ناتمام مانده است.` : null,
    result.siteError ? `- خطای دسترسی به منبع: ${plain(result.siteError, 300)}` : null,
    '', '## مسئله و هدف', plain(proposal.problem || title, 1200),
    '', '## جمع‌بندی اجرایی', plain(proposal.summary || summary || 'هنوز جمع‌بندی مستند آماده نیست.', 1500),
    '', '## مرحلهٔ ۱: کتاب‌ها و منابع مرجع',
    ...(referenceReview.books?.length ? referenceReview.books.map((book) =>
      `- کتاب #${book.id} «${plain(book.title, 140)}»: ${book.readPages ?? '?'} از ${book.pages ?? '?'} صفحه در بانک ذخیره شده؛ ${book.inspectedPassages} از ${book.storedPassages} گذرگاه در این بررسی به مدل داده شد${book.hasCachedAnalysis ? '؛ تحلیل پیشین در بانک موجود است' : ''}.`)
      : ['- کتاب مرتبطی از بانک محلی در این دور به مدل داده نشد.']),
    plain(referenceReview.note, 500),
    '', '## کاربران، سناریوها و فرض‌ها',
    '### کاربران و ذی‌نفعان', ...points(proposal.users),
    '### سناریوهای اصلی و خطا', ...points(proposal.scenarios),
    '### فرض‌های نیازمند آزمون', ...points(proposal.assumptions),
    '', '## قابلیت‌های ضروری و مفید', ...points(proposal.necessary),
    '', '## گزینه‌های نامناسب یا زودهنگام', ...points(proposal.avoid),
    '', '## معماری و انتخاب فناوری',
    '| لایه | انتخاب پیشنهادی | دلیل و پشتوانه |', '| --- | --- | --- |',
    ...(decisions.length ? decisions : ['| نیازمند بررسی | انتخاب نشده | مستندات و سنجش بیشتر لازم است |']),
    '', '### ملاحظات معماری', ...points(proposal.architecture),
    '', '### داده، مجوزها و مرز اعتماد', ...points(proposal.dataAndPermissions),
    '', '## جریان کار پیشنهادی', ...diagram,
    '', '## امنیت، حریم خصوصی و عملیات', ...points(proposal.security),
    '', '## تجربهٔ کاربر و طراحی محصول', ...points(proposal.experience),
    '', '### دسترس‌پذیری', ...points(proposal.accessibility),
    '', '## فرایند ساخت و سنجش', ...points(proposal.steps),
    '', '## معیارهای پذیرش برای عامل پیاده‌ساز', ...points(proposal.acceptance),
    '', '## آینده‌نگری، هزینه و ریسک', ...points(proposal.risks),
    '', '## جایگزین‌ها و معیار تغییر تصمیم', ...points(proposal.alternatives),
    '', '## پرسش‌های باز',
    ...list(result.openQuestions, 10).map((q) => `- ${plain(q, 400)}`),
    ...list(proposal.openQuestions, 8).map((q) => `- ${plain(q, 400)}`),
    '', '## منابع و عبارت شاهد',
    ...(sources.length ? sources.map((source) => `- **[${source.id}]** ${source.url ? `[منبع](${source.url.replaceAll(')', '%29')})` : `سند #${source.documentId}`}${source.page ? `، صفحه ${source.page}` : ''} — «${source.quote}»`)
      : ['- شاهدی در این دور ثبت نشد.']),
    '', '## روش و محدودیت',
    '- انتخاب فناوری و معماری پیشنهاد مهندسی است، نه حقیقت اثبات‌شده. ارجاع‌ها فقط به منابعی است که عامل‌ها خوانده‌اند.',
    '- برای ادعای «جدیدترین» باید تاریخ انتشار منبع و نسخهٔ فناوری جدا بررسی شود؛ نبود این اطلاعات به معنی تأیید تازگی نیست.',
    '- این سند طرح و معیار تصمیم است و کد اجرایی نیست. گذرگاه‌های نمونه‌خوانی‌شده جای مطالعهٔ کامل کتاب را نمی‌گیرند.',
  ];
  return lines.filter((line) => line !== null).join('\n') + '\n';
}

export function ideaReportPath(principalId, dossierId, rootId) {
  const namespace = path.basename(config.dbPath, path.extname(config.dbPath));
  const owner = String(principalId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(path.dirname(config.dbPath), `${namespace}-ledgers`, owner,
    `dossier-${Number(dossierId)}-idea-${Number(rootId)}.md`);
}

export function saveIdeaReport(principalId, dossierId, rootId, markdown) {
  const file = ideaReportPath(principalId, dossierId, rootId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, markdown, { encoding: 'utf8', mode: 0o600 });
  return file;
}
