/** Free end-to-end idea memo check; all model and research calls are local stubs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-idea-check-'));
process.env.ASC_DB = path.join(temp, 'check.db');
const store = await import('../src/db.js');
const { motherTurn, normalizePlan } = await import('../src/mother.js');
const { ideaReportPath } = await import('../src/idea-report.js');
const { renderMarkdown } = await import('../web/public/markdown.js');
try {
  const pid = 'idea-owner';
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
  const ask = async ({ system }) => ({ data: system.includes('ویراستار گزارش') ? {
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
  assert.ok(!first.text.includes('[S99]'));
  const rootId = first.action.nodeId;
  const file = ideaReportPath(pid, first.dossierId, rootId);
  assert.ok(fs.existsSync(file));
  assert.ok(first.text.includes(`/api/idea-report?dossierId=${first.dossierId}&rootId=${rootId}`));
  const second = await motherTurn({ principalId: pid, dossierId: first.dossierId,
    userText: 'ادامه بده', ask: async ({ system }) => {
      assert.ok(system.includes('ویراستار گزارش'), 'resume should not replan');
      return ask({ system });
    }, team });
  assert.equal(second.action.nodeId, rootId);
  assert.equal(calls, 2);
  assert.equal(store.dossierResearchNodes(pid, first.dossierId).filter((n) => !n.parent_id).length, 1);
  assert.ok(fs.readFileSync(file, 'utf8').includes('گزارش این دور پژوهش'));
  const html = renderMarkdown('# نتیجه\n| الف | ب |\n| --- | --- |\n| الف | ب |\n<script>alert(1)</script>\n[بد](javascript:alert(1))\n[گزارش](/api/idea-report?dossierId=1&rootId=2)');
  assert.ok(html.includes('<h1>نتیجه</h1>') && html.includes('<table>') && html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>') && !html.includes('href="javascript:'));
  assert.ok(html.includes('download'));
  const flowHtml = renderMarkdown('```mermaid\nflowchart TD\n N0["نیاز"]\n N1["آزمون"]\n N0 --> N1\n```');
  assert.ok(flowHtml.includes('class="md-flow"') && flowHtml.includes('نیاز') && flowHtml.includes('آزمون'));
  console.log('idea report check passed — delegation, sources, Markdown, resume, safe rendering; 0 model calls');
} finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
