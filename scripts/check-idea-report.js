/** Free end-to-end idea memo check; all model and research calls are local stubs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-idea-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const { motherTurn, normalizePlan } = await import('../src/mother.js');
const { reviewIdeaReferences } = await import('../src/idea-references.js');
const settings = await import('../src/settings.js');
const { ideaReportPath } = await import('../src/idea-report.js');
const { renderMarkdown } = await import('../web/public/markdown.js');
try {
  const pid = 'idea-owner';
  const libraryCase = Number(store.insertDossier({ principalId: pid, topic: 'کتابخانهٔ محصول' }));
  const libraryDoc = Number(store.insertDocument({ principalId: pid, dossierId: libraryCase,
    filename: 'راهنمای رزرو پزشک.pdf', kind: 'pdf', extraction: 'local', pages: 20, readPages: 18 }));
  store.insertChunks(pid, libraryCase, libraryDoc, Array.from({ length: 12 }, (_, seq) => ({
    seq, page: seq + 1, text: `رزرو پزشک باید هنگام همزمانی درخواست‌ها ظرفیت نوبت را دوباره بررسی کند. بخش ${seq + 1}. ${'جزئیات ظرفیت نوبت و دسترسی بیمار. '.repeat(240)}`,
  })));
  const extraTitles = ['راهنمای تجربه بیمار.pdf', 'معماری نوبت‌دهی.pdf'];
  for (const title of extraTitles) {
    const id = Number(store.insertDocument({ principalId: pid, dossierId: libraryCase,
      filename: title, kind: 'pdf', extraction: 'local', pages: 1, readPages: 1 }));
    store.insertChunks(pid, libraryCase, id, [{ seq: 0, page: 1,
      text: `رزرو پزشک، رضایت بیمار و جریان نوبت‌دهی. منبع: ${title}` }]);
  }
  const request = 'ایدهٔ من ساخت اپلیکیشن رزرو پزشک است. دربارهٔ معماری، زبان و فناوری‌های مناسب با منابع معتبر تحقیق کن و گزارش Markdown و فلوچارت بده.';
  const plan = normalizePlan({ action: 'respond', reply: 'به نظر خوب است.' }, request);
  assert.equal(plan.action, 'research_team');
  assert.equal(plan.subtasks.length, 3);
  assert.ok(plan.subtasks.every((task) => task.role === 'web-researcher'));
  const linked = normalizePlan({ action: 'crawl_site', url: 'https://example.org/official' },
    `${request} این منبع را هم بررسی کن: https://example.org/official`);
  assert.equal(linked.action, 'research_team', 'one reference URL must not replace the idea review');
  let calls = 0;
  const team = async ({ principalId, dossierId, nodeId }) => {
    calls++;
    const root = store.getResearchNode(principalId, nodeId);
    assert.equal(root.dossier_id, dossierId);
    assert.equal(store.dossierResearchNodes(principalId, dossierId).filter((n) => n.parent_id === nodeId).length, 3);
    store.updateResearchNode(principalId, nodeId, { status: calls === 1 ? 'paused' : 'done', result: { summary: 'پژوهش ذخیره شد' } });
    return { summary: 'پژوهش ذخیره شد', incomplete: calls === 1 ? [2] : [],
      openQuestions: ['بار همزمان چند کاربر است؟'], reports: [{ question: 'معماری', report: { summary: 'مستندات رسمی مرور شد',
        findings: [{ sourceUrl: 'https://example.org/official', text: 'API service', quote: 'An API service can separate clients from stored records.' }] } }] };
  };
  let bookSelections = 0, sectionCalls = 0;
  const ask = async ({ system, content }) => ({ data: system.includes('کتاب‌های واقعاً مرتبط') ?
    (bookSelections++, { bookIds: JSON.parse(content).catalogue.map((book) => book.id) }) :
    system.includes('تو تحلیل‌گر متن هستی') ? (sectionCalls++, {
      about: 'ظرفیت رزرو پزشک', details: [], events: [], actors: [], concepts: [], links: [], questions: [],
    }) : system.includes('تو تحلیل‌گر ساختار یک سند هستی') ? {
      overview: 'نوبت‌دهی و محدودکردن دسترسی بیمار', structure: [], timeline: [],
      tensions: [], hypotheses: [], openQuestions: [], nextSteps: [],
    } : system.includes('ویراستار سند') ? {
    problem: 'رزرو نوبت بدون تداخل', summary: 'با نمونهٔ کوچک شروع کن.',
    stack: [{ layer: 'API', choice: 'Node.js', why: 'به سنجش بار نیاز دارد', evidence: ['S1', 'S99'] }],
    avoid: [{ name: 'ریزسرویس زودهنگام', reason: 'هزینهٔ عملیاتی', evidence: [] }],
    flow: ['انتخاب پزشک', 'بررسی ظرفیت', 'ثبت نوبت'],
  } : { action: 'respond', reply: 'از حافظه می‌گویم.' }, usage: {} });
  const first = await motherTurn({ principalId: pid, userText: request, ask, team });
  assert.equal(first.action.type, 'team_paused');
  assert.ok(first.text.includes('| API | Node.js |'));
  assert.ok(first.text.includes('```mermaid'));
  assert.ok(first.text.includes('https://example.org/official'));
  assert.ok(first.text.includes('راهنمای رزرو پزشک.pdf'));
  assert.ok(extraTitles.every((title) => first.text.includes(title)),
    'more than two relevant books must be analyzed and listed');
  assert.ok(first.text.includes('از') && first.text.includes('بخش تحلیل شد'));
  assert.ok(first.text.includes('18 از 20 صفحه'));
  assert.ok(sectionCalls > 1, 'all stored sections, including beyond ten passages, must be read');
  const sectionsAfterFirst = sectionCalls;
  assert.ok(first.text.includes('## امنیت، حریم خصوصی و عملیات'));
  assert.ok(!first.text.includes('[S99]'));
  const rootId = first.action.nodeId;
  const file = ideaReportPath(pid, first.dossierId, rootId);
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(file.replace(/\.md$/, '-references.json')));
  assert.ok(first.text.includes(`/api/idea-report?dossierId=${first.dossierId}&rootId=${rootId}`));
  assert.equal(bookSelections, 1);
  const newBook = Number(store.insertDocument({ principalId: pid, dossierId: libraryCase,
    filename: 'امنیت رزرو پزشک.pdf', kind: 'pdf', extraction: 'local', pages: 1, readPages: 1 }));
  store.insertChunks(pid, libraryCase, newBook, [{ seq: 0, page: 1,
    text: 'برای رزرو پزشک، دسترسی به سوابق باید محدود و قابل حسابرسی باشد.' }]);
  const second = await motherTurn({ principalId: pid, dossierId: first.dossierId,
    userText: 'ادامه بده', ask: async ({ system, content }) => {
      assert.ok(system.includes('ویراستار سند') || system.includes('کتاب‌های واقعاً مرتبط') ||
        system.includes('تو تحلیل‌گر متن هستی') || system.includes('تو تحلیل‌گر ساختار یک سند هستی'),
        'resume should not replan');
      return ask({ system, content });
    }, team });
  assert.equal(second.action.nodeId, rootId);
  assert.equal(bookSelections, 2, 'a new reference book should invalidate the saved selection');
  assert.ok(second.text.includes('امنیت رزرو پزشک.pdf'));
  assert.equal(sectionCalls, sectionsAfterFirst + 1,
    'resume must reuse analysis of existing books and inspect only the new book');
  assert.equal(calls, 2);
  assert.equal(store.dossierResearchNodes(pid, first.dossierId).filter((n) => !n.parent_id).length, 1);
  assert.ok(fs.readFileSync(file, 'utf8').includes('گزارش این دور پژوهش'));
  const html = renderMarkdown('# نتیجه\n| الف | ب |\n| --- | --- |\n| الف | ب |\n<script>alert(1)</script>\n[بد](javascript:alert(1))\n[گزارش](/api/idea-report?dossierId=1&rootId=2)');
  assert.ok(html.includes('<h1>نتیجه</h1>') && html.includes('<table>') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>') && !html.includes('href="javascript:'));
  assert.ok(html.includes('download'));
  const flowHtml = renderMarkdown('```mermaid\nflowchart TD\n N0["نیاز"]\n N1["آزمون"]\n N0 --> N1\n```');
  assert.ok(flowHtml.includes('class="md-flow"') && flowHtml.includes('نیاز') && flowHtml.includes('آزمون'));
  settings.setBudget(0);
  const limited = await reviewIdeaReferences({ principalId: pid, dossierId: first.dossierId,
    rootId: rootId + 9000, idea: request, ask });
  assert.equal(limited.complete, false);
  assert.equal(limited.pauseReason, 'budget');
  settings.setBudget(null);
  const resumed = await reviewIdeaReferences({ principalId: pid, dossierId: first.dossierId,
    rootId: rootId + 9000, idea: request, ask });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.books.length, 4);
  console.log('idea report check passed — delegation, sources, Markdown, resume, safe rendering; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
