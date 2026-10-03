const $ = (id) => document.getElementById(id);
let csrf = '', selected = null, freshCase = false, activeJob = null, mode = 'chat', busy = false;
let investigation = null, progressHideTimer = null, toastTimer = null, monitorSnapshot = '', leadSnapshot = '', monitorTimer = null, monitorNodes = [];
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const formatTime = (ms) => `${fa(Math.round(ms / 1000))} ثانیه`;
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 5500); }
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = csrf;
  if (options.json) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.json); }
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers });
  if (res.status === 401) { $('app').hidden = true; $('login').hidden = false; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function displayAuth(ok) { $('login').hidden = ok; $('app').hidden = !ok; }
async function pollAgentMonitor() {
  if (!selected || freshCase || document.hidden || activeJob || $('app').hidden) return;
  const dossierId = selected;
  try {
    const live = await api(`/api/research-progress?dossierId=${dossierId}`);
    if (selected === dossierId && !freshCase) { renderAgentMonitor(live.nodes); renderLeadMonitor(live.leads); }
  } catch { /* the next refresh can retry without interrupting the conversation */ }
}
function startAgentMonitor() {
  if (!monitorTimer) monitorTimer = setInterval(pollAgentMonitor, 2500);
}
async function refresh() {
  const q = freshCase ? '?fresh=1' : selected ? `?dossierId=${selected}` : '';
  const data = await api(`/api/state${q}`);
  selected = freshCase ? null : data.selected?.id ?? null;
  render(data);
  await loadUploads();
  if (!activeJob) {
    const { job } = await api('/api/active-job');
    if (job) watch(job.id, ({ import:'خواندن سند', analysis:'تحلیل عمیق سند', deep:'کاوش عمیق',
      research:'تحقیق وب', chat:'در حال پاسخ', claims:'استخراج ادعاها', site:'خواندن وب‌سایت',
      team:'گروه پژوهش', consult:'مشاور منابع' })[job.kind] || 'در حال کار');
  }
}
function render(data) {
  investigation = data.investigation ?? null;
  const dossiers = Array.isArray(data.dossiers) ? data.dossiers : [];
  const stats = data.stats || {};
  $('case-count').textContent = fa(dossiers.length);
  $('stat-cases').textContent = fa(stats.dossiers);
  $('stat-verified').textContent = fa(stats.verified);
  $('stat-claims').textContent = fa(stats.claims);
  $('case-list').innerHTML = dossiers.length ? dossiers.map((d) => `<button class="case-item ${selected === d.id ? 'active' : ''}" data-case="${Number(d.id)}" ${selected === d.id ? 'aria-current="true"' : ''}><span class="case-name">${esc(d.topic)}</span><small>#${fa(d.id)} · ${esc(d.state)}</small></button>`).join('') : '<p class="rail-empty">هنوز پرونده‌ای نیست. گفت‌وگو را آغاز کن.</p>';
  for (const button of document.querySelectorAll('[data-case]')) button.onclick = async () => {
    try {
      const id = Number(button.dataset.case);
      await api('/api/select-dossier', { method:'POST', json:{ dossierId:id } });
      selected = id; freshCase = false; $('rail').classList.remove('open'); $('mobile-menu').setAttribute('aria-expanded', 'false'); await refresh(); $('prompt').focus();
    } catch(e) { fail(e); }
  };
  $('breadcrumb').textContent = selected ? data.selected?.topic || 'پرونده' : 'گفت‌وگوی تازه';
  $('inspector-subtitle').textContent = data.selected?.topic || 'پرسش‌ها و شاهدها، کنار هم.';
  $('ledger').disabled = !selected;
  $('upload-target').textContent = freshCase || !selected
    ? 'مقصد فایل بعدی: پروندهٔ تازه'
    : `مقصد فایل بعدی: ${data.selected?.topic || 'پرونده'} (#${fa(selected)})`;
  $('messages').innerHTML = (Array.isArray(data.messages) ? data.messages : []).map((m) => `<div class="message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="who">${m.role === 'user' ? 'شما' : 'عامل مادر'}</div><p>${esc(m.text)}</p></div>`).join('');
  document.querySelector('.conversation').classList.toggle('has-messages', $('messages').childElementCount > 0);
  $('messages').scrollTop = $('messages').scrollHeight;
  $('document-list').innerHTML = (Array.isArray(data.documents) ? data.documents : []).map((d) => `<div class="doc-row"><span title="${esc(d.filename)}">◈ ${esc(d.filename)} ${d.pages ? `· ${fa(d.read_pages ?? d.pages)}/${fa(d.pages)}` : ''}</span><span class="doc-actions">${d.id && d.extraction !== 'model_vision_pages' ? `<button class="small-action" data-claims="${Number(d.id)}">ادعاها</button>` : ''}<button class="small-action" data-analyze="${Number(d.id)}" title="تحلیل متن ذخیره‌شده ممکن است هزینه داشته باشد">تحلیل عمیق</button><a class="small-action" href="/api/document-analysis?documentId=${Number(d.id)}" title="دریافت گزارش Markdown">MD</a></span></div>`).join('');
  for (const b of document.querySelectorAll('[data-claims]')) b.onclick = async () => { try { const r = await api('/api/claims', { method:'POST', json:{ documentId:Number(b.dataset.claims) } }); watch(r.id, 'استخراج ادعاها'); } catch(e){fail(e);} };
  for (const b of document.querySelectorAll('[data-analyze]')) b.onclick = async () => { try { const r = await api('/api/analyze-document', { method:'POST', json:{ documentId:Number(b.dataset.analyze) } }); watch(r.id, 'تحلیل عمیق سند'); } catch(e){fail(e);} };
  const claims = Array.isArray(data.claims) ? data.claims : [];
  $('claims-list').innerHTML = claims.length ? claims.slice(-15).reverse().map((c) => `<div class="claim ${c.status === 'verified' ? '' : 'found'}">${c.status === 'verified' ? '✓ تأیید' : '◇ نیاز به بررسی'} · ${esc(c.text)}<small>${esc(c.source_title || c.source_url || 'منبع نامشخص')}</small></div>`).join('') : '<p class="muted">هنوز شاهدی ثبت نشده است.</p>';
  renderAgentMonitor(data.researchNodes);
  renderLeadMonitor(data.researchLeads);
  renderResearch(data.researchNodes);
  renderSources(data.sources, data.pendingUploads, data.otherDossierDocuments);
  renderInvestigation();
}
function renderAgentMonitor(rawNodes) {
  const box = $('agent-monitor');
  const nodes = Array.isArray(rawNodes) ? rawNodes.filter((n) => n && Number.isSafeInteger(Number(n.id))) : [];
  monitorNodes = nodes;
  const running = nodes.filter((n) => n.status === 'running').length;
  const waiting = nodes.filter((n) => n.status === 'pending' || n.status === 'paused').length;
  const failed = nodes.filter((n) => n.status === 'failed').length;
  const signal = $('activity-signal');
  signal.dataset.status = running || activeJob ? 'running' : failed ? 'failed' : waiting ? 'waiting' : 'idle';
  signal.dataset.short = running ? `${fa(running)} فعال` : activeJob ? 'در حال کار' : failed ? `${fa(failed)} خطا` : waiting ? `${fa(waiting)} در صف` : '';
  $('activity-label').textContent = running ? `${fa(running)} عامل در حال کار` : activeJob ? $('progress-title').textContent : failed ? `${fa(failed)} عامل نیازمند بررسی` : waiting ? `${fa(waiting)} عامل در انتظار` : 'فضای پژوهش آماده است';
  if (!selected || !nodes.length) {
    const empty = selected ? 'هنوز عاملی برای این پرونده مأمور نشده است.' : 'برای دیدن وضعیت عامل‌ها، پرونده‌ای انتخاب کن.';
    const html = `<p class="muted">${empty}</p>`;
    if (monitorSnapshot !== html) { box.innerHTML = html; monitorSnapshot = html; }
    return;
  }
  const order = { running: 0, failed: 1, paused: 2, pending: 3, done: 4 };
  const statusNames = { pending:'در صف', running:'در حال کار', paused:'مکث', done:'این گام تکمیل', failed:'خطا' };
  const roles = { coordinator:'عامل مادر', 'source-analyst':'عامل اسناد', 'web-researcher':'عامل وب', local:'عامل محلی' };
  const done = nodes.filter((n) => n.status === 'done').length;
  const cards = [...nodes].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || Number(a.id) - Number(b.id))
    .map((n) => `<div class="agent-card" data-status="${esc(n.status || 'pending')}"><div class="agent-card-head"><strong>${esc(roles[n.assigned_role] || n.assigned_role || 'عامل')}${n.parent_id ? ` · زیر #${fa(n.parent_id)}` : ''}</strong><span>${esc(statusNames[n.status] || n.status || 'در صف')}</span></div><p>${esc(n.title)}</p><small>گام فعلی: ${esc(n.progress_stage || (n.status === 'pending' ? 'منتظر شروع' : 'گام تازه ثبت نشده است'))}</small>${n.open_question ? `<small class="agent-card-question">پرسش باز: ${esc(n.open_question)}</small>` : ''}</div>`).join('');
  const html = `<div class="agent-count">${fa(running)} فعال · ${fa(waiting)} در انتظار · ${fa(done)} تکمیل · ${fa(nodes.length)} نیت</div>${cards}`;
  if (monitorSnapshot !== html) { box.innerHTML = html; monitorSnapshot = html; }
}
function renderLeadMonitor(rawLeads) {
  const box = $('lead-monitor');
  const leads = Array.isArray(rawLeads) ? rawLeads.slice(-20).reverse() : [];
  const status = { pending:'در انتظار بازبینی', approved:'تأیید و ارجاع شد', deferred:'فعلاً تأیید نشد' };
  const html = leads.length ? leads.map((lead) => `<div class="lead-card" data-status="${esc(lead.status)}"><strong>${esc(lead.question)}</strong><small>از زیرنیت #${fa(lead.source_node_id)} · ${esc(status[lead.status] || lead.status)}${lead.child_node_id ? ` · پیگیری در #${fa(lead.child_node_id)}` : ''}</small>${lead.review_note ? `<small>${esc(lead.review_note)}</small>` : ''}</div>`).join('')
    : '<p class="muted">هنوز سرنخی بررسی نشده است.</p>';
  if (leadSnapshot !== html) { box.innerHTML = html; leadSnapshot = html; }
}
function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function renderResearch(rawNodes) {
  if (!selected) {
    $('research-tree').innerHTML = '<p class="muted">برای دیدن پرسش‌ها، پرونده‌ای انتخاب کن.</p>';
    return;
  }
  const nodes = Array.isArray(rawNodes) ? rawNodes.filter((n) => n && Number.isSafeInteger(Number(n.id)) && Number(n.id) > 0) : [];
  const byId = new Map(nodes.map((n) => [Number(n.id), n]));
  const children = new Map();
  for (const node of nodes) {
    const parent = Number(node.parent_id);
    const key = parent && byId.has(parent) && parent !== Number(node.id) ? parent : 0;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }
  const visited = new Set();
  function branch(node, depth) {
    const id = Number(node.id);
    if (visited.has(id)) return '';
    visited.add(id);
    const statusNames = { pending:'در صف', running:'در حال بررسی', paused:'مکث', done:'تکمیل', completed:'تکمیل', failed:'خطا' };
    const status = `<span class="research-status" data-status="${esc(node.status || 'pending')}">${esc(statusNames[node.status] || node.status || 'در صف')}</span>`;
    const question = node.open_question ? `<p>${esc(node.open_question)}</p>` : '';
    let result = null;
    try { result = JSON.parse(node.result_json || 'null'); } catch { /* unfinished output */ }
    const summary = result?.summary ? `<p class="research-summary">${esc(result.summary)}</p>` : '';
    const findings = Array.isArray(result?.findings) ? result.findings.slice(0, 5).map((f) => {
      const url = safeWebUrl(f?.sourceUrl);
      const source = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(f?.sourceTitle || f.sourceUrl)}</a>`
        : f?.sourceTitle ? esc(f.sourceTitle)
        : Number.isSafeInteger(Number(f?.documentId)) && Number(f.documentId) > 0 ? `سند #${fa(f.documentId)}` : 'منبع نامشخص';
      return `<li>${esc(f?.text)} <small>${source}${f?.page ? ` · ص ${fa(f.page)}` : ''} · صحت ادعا هنوز داوری نشده</small></li>`;
    }).join('') : '';
    const resultView = summary || findings ? `<details><summary>گزارش عامل</summary>${summary}${findings ? `<ul>${findings}</ul>` : ''}</details>` : '';
    const role = node.assigned_role ? `<small>نقش: ${esc(node.assigned_role)}</small>` : '';
    const descendants = (children.get(id) || []).map((child) => branch(child, depth + 1)).join('');
    return `<li><div class="research-node"><div class="research-node-head"><strong>${esc(node.title || 'بی‌عنوان')}</strong>${status}</div>${question}${role}${resultView}</div>${descendants ? `<ul>${descendants}</ul>` : ''}</li>`;
  }
  const roots = children.get(0) || [];
  const tree = [...roots, ...nodes.filter((n) => !roots.includes(n))].map((node) => branch(node, 0)).join('');
  $('research-tree').innerHTML = tree ? `<ul class="research-roots">${tree}</ul>` : '<p class="muted">هنوز نیتی ثبت نشده است. به عامل مادر بگو چه چیزی را بررسی کند.</p>';
}
function renderSources(rawSources, rawPending, rawElsewhere) {
  $('site-form').hidden = !selected;
  $('site-form').querySelector('button[type="submit"]').disabled = busy;
  $('consult-form').hidden = !selected;
  $('consult-form').querySelector('button[type="submit"]').disabled = busy;
  if (!selected) {
    $('source-list').innerHTML = '<p class="muted">برای دیدن منابع، پرونده‌ای انتخاب کن.</p>';
    return;
  }
  const sources = Array.isArray(rawSources) ? rawSources.filter((source) => source && typeof source === 'object') : [];
  const pending = Array.isArray(rawPending) ? rawPending : [];
  const elsewhere = Array.isArray(rawElsewhere) ? rawElsewhere : [];
  const pendingHtml = pending.length ? `<ul>${pending.map((file) =>
    `<li><div class="source-heading"><strong>${esc(file.name)}</strong></div><small>آپلود شده؛ هنوز متن آن خوانده نشده است</small><button class="small-action" type="button" data-pending-upload="${esc(file.id)}">بررسی فایل</button></li>`).join('')}</ul>` : '';
  const sourceHtml = sources.length ? `<ul>${sources.map((source) => {
    const url = safeWebUrl(source.url);
    const title = esc(source.title || source.url || 'منبع بی‌عنوان');
    const heading = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<strong>${title}</strong>`;
    const pages = source.pages ? ` · ${fa(source.readPages ?? 0)}/${fa(source.pages)} صفحه` : '';
    const noOutput = source.noOutputPageCount ? ` · ${fa(source.noOutputPageCount)} صفحه بدون خروجی ویژن` : '';
    const status = source.analysisStatus ? ` · ${esc(source.analysisStatus)}` : '';
    const relations = Array.isArray(source.relations) ? source.relations.slice(0, 5) : [];
    return `<li><div class="source-heading">${heading}</div><small>${esc(source.type || 'منبع')}${pages}${noOutput}${status}</small>${source.summary ? `<p>${esc(source.summary)}</p>` : ''}${relations.length ? `<details><summary>ارتباط بخش‌ها</summary><ul>${relations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}</li>`;
  }).join('')}</ul>` : pending.length || elsewhere.length ? '' : '<p class="muted">هنوز منبعی در این پرونده ثبت نشده است.</p>';
  const elsewhereHtml = !sources.length && elsewhere.length
    ? `<p class="muted">سندهای ذخیره‌شده در پرونده‌های دیگر:</p><ul>${elsewhere.map((doc) =>
      `<li><strong>${esc(doc.filename)}</strong><small>پرونده #${fa(doc.dossierId)} · ${esc(doc.dossierTopic)}</small><button class="small-action" type="button" data-source-dossier="${Number(doc.dossierId)}">باز کردن پرونده</button></li>`).join('')}</ul>` : '';
  $('source-list').innerHTML = pendingHtml + sourceHtml + elsewhereHtml;
  for (const button of $('source-list').querySelectorAll('[data-pending-upload]'))
    button.onclick = () => beginImport(button.dataset.pendingUpload);
  for (const button of $('source-list').querySelectorAll('[data-source-dossier]'))
    button.onclick = async () => { try {
      const id = Number(button.dataset.sourceDossier);
      await api('/api/select-dossier', { method:'POST', json:{ dossierId:id } });
      selected = id; freshCase = false; await refresh();
    } catch (error) { fail(error); } };
}
function renderInvestigation() {
  const box = $('investigation-status');
  const run = investigation;
  if (!selected || !run) {
    box.innerHTML = `<p class="muted">${selected ? 'برای این پرونده هنوز کاوشی ثبت نشده است.' : 'برای دیدن وضعیت کاوش، پرونده‌ای انتخاب کن.'}</p>`;
    $('resume-options').hidden = true;
    return;
  }
  const states = { running:'در حال کاوش', paused:'متوقف؛ آمادهٔ ادامه', done:'پایان‌یافته' };
  const reasons = { ceiling:'رسیدن به سقف هزینه', exhausted:'پایان سرنخ‌ها', stopped:'توقف به درخواست شما', interrupted:'قطع شدن اجرا' };
  const leads = Array.isArray(run.nextLeads) ? run.nextLeads : [];
  box.innerHTML = `<p class="investigation-question">${esc(run.question)}</p><p><strong>${esc(states[run.state] || run.state || 'نامشخص')}</strong>${run.stopped ? ` · ${esc(reasons[run.stopped] || run.stopped)}` : ''}</p><p>${fa(run.rounds)} دور · ${fa(run.costToman)} تومان${Number.isFinite(Number(run.costUsd)) && run.costUsd != null ? ` · ${esc(String(run.costUsd))} دلار` : ''}</p>${leads.length ? `<div class="investigation-leads"><strong>سرنخ‌های بعدی</strong><ul>${leads.slice(0, 4).map((lead) => `<li>${esc(lead)}</li>`).join('')}</ul></div>` : ''}`;
  $('resume-options').hidden = !(run.state === 'paused' && leads.length && Number.isSafeInteger(Number(run.id)) && Number(run.id) > 0);
  $('resume-deep').disabled = busy;
}
function spendCeiling(input) {
  const raw = input.value.trim();
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0 || amount > 20) {
    input.setCustomValidity('سقف هزینه باید عددی بزرگ‌تر از صفر و حداکثر ۲۰ دلار باشد.');
    input.reportValidity();
    input.focus();
    return null;
  }
  input.setCustomValidity('');
  return amount;
}
async function startDeep({ resume = false } = {}) {
  if (busy) return toast('یک کار دیگر در حال اجراست.');
  const input = $(resume ? 'resume-ceiling' : 'deep-ceiling');
  const ceilingUsd = spendCeiling(input);
  if (ceilingUsd === null) return;
  const question = resume ? investigation?.question : $('prompt').value.trim();
  const runId = resume ? Number(investigation?.id) : null;
  if (resume && (!selected || !Number.isSafeInteger(runId) || runId <= 0 || investigation?.state !== 'paused')) return toast('این کاوش آمادهٔ ادامه نیست.');
  if (!resume && !question) return $('prompt').focus();
  const action = resume ? 'ادامه' : 'آغاز';
  if (!confirm(`${action} کاوش عمیق با سقف توقف ${ceilingUsd} دلار برای این نوبت؟ توقف بین دورها بررسی می‌شود و دور جاری ممکن است سقف را رد کند.`)) return;
  setBusy(true);
  try {
    const r = await api(resume ? '/api/deep/resume' : '/api/deep', { method:'POST', json: resume
      ? { runId, ceilingUsd } : { dossierId:selected, question, ceilingUsd } });
    if (!resume) { $('prompt').value = ''; addMessage('user', question); }
    watch(r.id, resume ? 'ادامهٔ کاوش عمیق' : 'کاوش عمیق');
  } catch(e) { setBusy(false); fail(e); }
}
async function loadUploads() {
  const list = await api('/api/uploads');
  $('upload-list').innerHTML = (Array.isArray(list) ? list : []).map((m) => {
    const progress = m.pages ? ` · ${fa(m.readPages ?? 0)}/${fa(m.pages)} صفحه` : '';
    const destination = m.dossierId ? `پرونده #${fa(m.dossierId)}` : m.newDossier ? 'پروندهٔ تازه' : 'پروندهٔ فعال';
    const state = m.documentId ? (m.pages && m.readPages < m.pages ? ' · خواندن ناتمام' : ' · وارد منابع شد') : ' · هنوز وارد منابع نشده';
    return `<div class="upload-row"><span title="${esc(m.name)}">${esc(m.name)}<small>${destination}${progress}${state}</small></span><span class="upload-actions"><button class="small-action" data-upload="${esc(m.id)}" data-mode="detect">بررسی</button>${/\.pdf$/i.test(m.name) && (!m.pages || m.readPages < m.pages) ? `<button class="small-action" data-upload="${esc(m.id)}" data-mode="batch">۲۰ صفحه</button><button class="small-action" data-upload="${esc(m.id)}" data-mode="all">تا پایان</button>` : ''}</span></div>`;
  }).join('') || '<p class="muted">فایلی در انتظار خواندن نیست.</p>';
  for (const b of document.querySelectorAll('[data-upload]')) b.onclick = () => beginImport(b.dataset.upload, b.dataset.mode);
}
function fail(e) { toast(e.message || String(e)); }
function handleAction(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'propose_team' && action.requiresApproval !== false && action.approvalRequired !== false) {
    const node = Number(action.nodeId);
    const label = action.title || action.summary || 'پیشنهاد گروه پژوهش';
    addMessage('assistant', `${label}\nبرای تأیید، در همین گفت‌وگو به عامل مادر بگو این مسیر را آغاز کند.${Number.isSafeInteger(node) && node > 0 ? ` (نیت #${fa(node)})` : ''}`);
  } else if (action.type === 'team_started' || action.type === 'team_resumed') {
    toast(action.type === 'team_started' ? 'گروه پژوهش آغاز به کار کرد؛ وضعیت را در درخت نیت ببین.' : 'گروه پژوهش ادامه داد؛ وضعیت را در درخت نیت ببین.');
  }
}
function selectResultDossier(result) {
  const id = Number(result?.dossierId);
  if (Number.isSafeInteger(id) && id > 0) { selected = id; freshCase = false; }
}
function showChatResult(result) {
  if (typeof result?.text !== 'string' || !result.text.trim()) return;
  const last = $('messages').lastElementChild;
  if (last?.classList.contains('assistant') && last.querySelector('p')?.textContent === result.text) return;
  addMessage('assistant', result.text);
}
function setBusy(value) { busy = value; $('compose-form').querySelector('button').disabled = value; $('resume-deep').disabled = value; $('site-form').querySelector('button[type="submit"]').disabled = value; $('consult-form').querySelector('button[type="submit"]').disabled = value; }
async function beginImport(id, visionMode = 'detect') {
  if (busy) return toast('یک کار دیگر در حال اجراست.');
  if (visionMode !== 'detect' && !confirm(visionMode === 'all'
    ? 'همهٔ صفحه‌های باقی‌مانده بررسی می‌شود. صفحه‌های دارای متن محلی خوانده می‌شوند و فقط صفحه‌های تصویری به مدل ویژن می‌روند؛ ممکن است هزینه و زمان داشته باشد. هر صفحه ذخیره می‌شود. شروع شود؟'
    : '۲۰ صفحهٔ بعدی بررسی می‌شود؛ فقط صفحه‌های تصویری ممکن است هزینهٔ ویژن داشته باشند. شروع شود؟')) return;
  try {
    const r = await api('/api/import', { method: 'POST', json: {
      uploadId:id, dossierId:selected, visionMode:visionMode === 'detect' ? null : visionMode,
    } });
    watch(r.id, visionMode === 'all' ? 'خواندن تا پایان' : visionMode === 'batch' ? 'خواندن ۲۰ صفحه' : 'بررسی سند');
  } catch(e) { fail(e); }
}
async function watch(id, title) {
  if (!id) return;
  clearTimeout(progressHideTimer);
  activeJob = id; setBusy(true); $('progress').hidden = false; $('progress-title').textContent = title;
  renderAgentMonitor(monitorNodes);
  $('progress-detail').textContent = 'در حال آماده‌سازی…';
  $('progress-summary').hidden = true;
  $('progress-track').removeAttribute('aria-valuenow');
  $('progress-fill').classList.add('indeterminate');
  $('stop-job').hidden = false;
  const started = Date.now();
  while (activeJob === id) {
    try {
      const job = await api(`/api/jobs/${id}`);
      $('progress-time').textContent = formatTime(Date.now() - started);
      $('progress-detail').textContent = job.stage || 'در حال انجام…';
      if (job.kind === 'chat' || job.kind === 'team') {
        try {
          const live = await api(`/api/research-progress${selected ? `?dossierId=${selected}` : ''}`);
          if (!selected && live.dossierId) selected = Number(live.dossierId);
          renderAgentMonitor(live.nodes); renderLeadMonitor(live.leads);
        } catch { /* live panel may fail without losing the underlying job */ }
      }
      const summary = job.summary || job.result?.summary;
      $('progress-summary').hidden = !summary;
      if (summary) $('progress-summary').textContent = String(summary);
      if (job.kind === 'deep' && job.state === 'running') {
        const status = `در حال کاوش · ${job.stage || 'در حال آماده‌سازی…'}`;
        if ($('investigation-status').textContent !== status) $('investigation-status').textContent = status;
      }
      const page = /صفحه\s+(\d+)\s+از\s+(\d+)/.exec(job.stage || '');
      const vector = /بردار\s+(\d+)\s+از\s+(\d+)/.exec(job.stage || '');
      const analysis = /(?:تحلیل )?بخش\s+(\d+)\s+از\s+(\d+)/.exec(job.stage || '');
      const part = page || vector || analysis;
      $('progress-fill').classList.toggle('indeterminate', !part);
      if (part && Number(part[2]) > 0) {
        const percent = Math.max(3, Math.min(100, Math.round(Number(part[1]) / Number(part[2]) * 100)));
        $('progress-fill').style.width = `${percent}%`;
        $('progress-track').setAttribute('aria-valuenow', String(percent));
      } else $('progress-track').removeAttribute('aria-valuenow');
      if (job.state !== 'running') {
        activeJob = null; setBusy(false); $('progress-fill').classList.remove('indeterminate'); $('progress-fill').style.width = '100%';
        $('progress-track').setAttribute('aria-valuenow', '100');
        $('progress-detail').textContent = job.state === 'failed' ? `خطا: ${job.error || 'کار ناموفق بود.'}` : job.state === 'done' ? 'کار پایان یافت.' : 'کار متوقف شد.';
        $('stop-job').hidden = true;
        progressHideTimer = setTimeout(() => { if (!activeJob) $('progress').hidden = true; }, job.state === 'failed' ? 12000 : 4500);
        if (job.state === 'failed') toast(job.savedScan ? `${job.error} · تا صفحه ${job.savedScan.readPages} ذخیره شد.` : job.error || 'کار ناموفق بود.');
        if (job.state === 'done') {
          selectResultDossier(job.result);
          if (job.kind === 'research') toast('تحقیق ثبت شد؛ یافته‌ها را در پرونده ببین.');
          if (job.kind === 'import') toast(job.result?.alreadyRead ? 'این سند قبلاً خوانده شده است.' : job.result?.pages
            ? `${fa(job.result.readPages)} از ${fa(job.result.pages)} صفحه ذخیره شد${job.result.readPages < job.result.pages ? '؛ برای ادامه «تا پایان» را بزن.' : '.'}`
            : 'سند ذخیره شد.');
          if (job.kind === 'analysis') toast(`تحلیل ${fa(job.result?.sections)} بخش ثبت شد؛ فایل MD از کنار سند دریافت می‌شود.`);
          if (job.kind === 'deep') toast(job.result?.canResume ? 'کاوش متوقف شد؛ می‌توانی آن را از دفتر پرونده ادامه بدهی.' : 'کاوش عمیق ثبت شد؛ یافته‌ها را در پرونده ببین.');
          if (job.kind === 'team') toast('گزارش عامل‌ها ذخیره شد؛ وضعیت زیرپرسش‌ها را در درخت ببین.');
          if (job.kind === 'site') toast(`${fa(job.result?.pagesSaved)} صفحه ذخیره شد${job.result?.done ? '.' : '؛ برای ادامه همان نشانی را دوباره بفرست.'}`);
          if (job.kind === 'consult') toast(`${fa(job.result?.sources?.length)} نشانی پیشنهادی ثبت شد؛ هنوز تأیید نشده‌اند.`);
        }
        if (job.state === 'needs_vision') {
          selectResultDossier(job.result);
          toast(`این PDF صفحهٔ تصویری دارد؛ ${fa(job.result?.readPages)} از ${fa(job.result?.pages)} صفحه خوانده شده. برای ادامه، «۲۰ صفحه» یا «تا پایان» را بزن.`);
        }
        try { await refresh(); }
        finally { if (job.state === 'done' && job.kind === 'chat') showChatResult(job.result); }
        if (job.state === 'done') handleAction(job.result?.action || job.action);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch(e) { activeJob = null; setBusy(false); renderAgentMonitor(monitorNodes); $('progress-detail').textContent = 'ارتباط با وضعیت کار قطع شد. با تازه‌سازی، وضعیت را دوباره بررسی کن.'; $('stop-job').hidden = true; fail(e); break; }
  }
}
function addMessage(role, text) {
  const box = document.createElement('div'); box.className = `message ${role}`;
  const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'user' ? 'شما' : 'عامل مادر';
  const p = document.createElement('p'); p.textContent = text;
  box.append(who, p); $('messages').append(box); document.querySelector('.conversation').classList.add('has-messages'); $('messages').scrollTop = $('messages').scrollHeight;
}
function sendFile(file) {
  if (!file) return;
  if (file.size > 100 * 1024 * 1024) return toast('سقف فایل ۱۰۰ مگابایت است.');
  const xhr = new XMLHttpRequest();
  const target = freshCase ? '&newDossier=1' : selected ? `&dossierId=${selected}` : '';
  xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}${target}`);
  xhr.withCredentials = true; xhr.setRequestHeader('X-CSRF-Token', csrf);
  $('upload-status').textContent = 'در حال آپلود…';
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('upload-status').textContent = `آپلود: ${fa(Math.round(e.loaded/e.total*100))}٪`; };
  xhr.onload = () => {
    try { const r = JSON.parse(xhr.responseText); if (xhr.status !== 201) throw new Error(r.error || 'آپلود ناموفق بود.');
      if (r.dossierId && freshCase) { selected = Number(r.dossierId); freshCase = false; }
      $('upload-status').textContent = r.jobId
        ? 'آپلود کامل شد؛ بررسی متن فایل آغاز شد.'
        : 'آپلود کامل شد؛ برای شروع خواندن، «بررسی» را بزن.';
      if (r.jobId) watch(r.jobId, 'بررسی متن فایل');
      refresh().catch(fail); }
    catch(e){ $('upload-status').textContent=''; fail(e); }
  };
  xhr.onerror = () => { $('upload-status').textContent=''; toast('اتصال هنگام آپلود قطع شد.'); };
  xhr.send(file);
}
$('login-form').onsubmit = async (e) => { e.preventDefault(); $('login-error').textContent = '';
  try { const r = await api('/api/login', { method:'POST', json:{ password:$('password').value } }); csrf = r.csrf; $('password').value=''; displayAuth(true); startAgentMonitor(); await refresh(); }
  catch(err){ $('login-error').textContent = err.message; } };
$('logout').onclick = async () => { await api('/api/logout', { method:'POST' }).catch(() => {}); csrf=''; displayAuth(false); };
$('refresh').onclick = () => refresh().catch(fail);
$('new-case').onclick = () => { selected=null; freshCase=true; $('messages').innerHTML=''; document.querySelector('.conversation').classList.remove('has-messages'); $('breadcrumb').textContent='گفت‌وگوی تازه'; $('rail').classList.remove('open'); $('mobile-menu').setAttribute('aria-expanded', 'false'); refresh().then(() => $('prompt').focus()).catch(fail); };
$('mobile-dossier').onclick = () => {
  const workspace = document.querySelector('.workspace');
  const atDossier = workspace.scrollTop > workspace.clientHeight * .45;
  const inspector = document.querySelector('.inspector');
  const inspectorTop = workspace.scrollTop + inspector.getBoundingClientRect().top - workspace.getBoundingClientRect().top;
  workspace.scrollTo({ top: atDossier ? 0 : inspectorTop, behavior: 'smooth' });
};
$('mobile-menu').onclick = () => {
  const open = $('rail').classList.toggle('open');
  $('mobile-menu').setAttribute('aria-expanded', String(open));
  if (open) $('new-case').focus();
};
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('rail').classList.contains('open')) {
    $('rail').classList.remove('open');
    $('mobile-menu').setAttribute('aria-expanded', 'false');
    $('mobile-menu').focus();
  }
});
for (const [id, value] of [['tab-chat','chat'],['tab-deep','deep']]) $(id).onclick = () => {
  mode=value;
  for (const [tab, kind] of [['tab-chat','chat'],['tab-deep','deep']]) {
    $(tab).classList.toggle('selected', value === kind);
    $(tab).setAttribute('aria-pressed', String(value === kind));
  }
  $('deep-options').hidden = value !== 'deep';
  $('deep-ceiling').disabled = value !== 'deep';
  $('prompt').placeholder = value === 'deep' ? 'پرسش اصلی کاوش عمیق چیست؟' : 'پرسش یا دستورت را به عامل مادر بگو…';
  $('compose-hint').textContent = value === 'deep' ? 'این مسیر مستقل از گفت‌وگو با عامل مادر است؛ پس از تأیید سقف هزینه آغاز می‌شود و در پرونده ثبت خواهد شد.' : 'با عامل مادر حرف بزن. وقتی صریحاً دستور تحقیق بدهی، خودش زیرنیت‌ها را می‌سازد و عامل‌ها را مأمور می‌کند.';
};
$('compose-form').onsubmit = async (e) => { e.preventDefault(); if (busy) return;
  const message=$('prompt').value.trim(); if (!message) return;
  const requestMode = mode;
  if (requestMode === 'deep') return startDeep();
  try { setBusy(true); const r=await api(`/api/${requestMode}`, { method:'POST', json:{ message, question:message, dossierId:selected } });
    $('prompt').value=''; addMessage('user',message);
    if (r.id) watch(r.id,requestMode==='chat'?'عامل مادر در حال بررسی':'در حال تحقیق وب');
    else {
      selectResultDossier(r);
      try { await refresh(); } finally { if (requestMode === 'chat') showChatResult(r); }
      handleAction(r.action);
      setBusy(false);
    } }
  catch(err){setBusy(false);fail(err);} };
$('resume-deep').onclick = () => startDeep({ resume:true });
$('site-form').onsubmit = async (e) => {
  e.preventDefault();
  if (busy || !selected) return;
  const url = safeWebUrl($('site-url').value.trim());
  const status = $('site-form-status');
  if (!url) { status.textContent = 'نشانی باید با http یا https شروع شود.'; $('site-url').focus(); return; }
  status.textContent = 'در حال ثبت نشانی…';
  setBusy(true);
  try {
    const job = await api('/api/site-crawl', { method:'POST', json:{ dossierId:selected, url } });
    $('site-url').value = '';
    status.textContent = 'خواندن وب‌سایت آغاز شد.';
    if (job.id) watch(job.id, 'خواندن وب‌سایت');
    else { setBusy(false); await refresh(); }
  } catch (err) { setBusy(false); status.textContent = err.message || 'ثبت نشانی ناموفق بود.'; fail(err); }
};
$('consult-form').onsubmit = async (e) => {
  e.preventDefault();
  if (busy || !selected) return;
  const question = $('consult-question').value.trim();
  const status = $('consult-form-status');
  if (!question) { $('consult-question').focus(); return; }
  if (!confirm('یک درخواست هزینه‌دار به OpenRouter برای پیشنهاد منبع ارسال شود؟ نتیجه فقط سرنخ است و هنوز تأیید نشده.')) return;
  setBusy(true);
  try {
    const job = await api('/api/source-consult', { method:'POST', json:{ dossierId:selected, question } });
    status.textContent = 'مشاور در حال جست‌وجوی منبع است…';
    if (job.id) watch(job.id, 'مشاور منابع');
  } catch (err) { setBusy(false); status.textContent = err.message || 'مشاور پاسخ نداد.'; fail(err); }
};
for (const id of ['deep-ceiling', 'resume-ceiling']) $(id).addEventListener('input', () => $(id).setCustomValidity(''));
$('file-input').onchange = (e) => sendFile(e.target.files[0]);
const zone=$('drop-zone'); zone.ondragover=(e)=>{e.preventDefault();zone.classList.add('dragging');};
zone.ondragleave=()=>zone.classList.remove('dragging'); zone.ondrop=(e)=>{e.preventDefault();zone.classList.remove('dragging');sendFile(e.dataTransfer.files[0]);};
$('ledger').onclick = () => { if (selected) window.location.href=`/api/ledger?dossierId=${selected}`; };
$('stop-job').onclick = async () => { try { await api('/api/stop',{method:'POST'}); toast('درخواست توقف ثبت شد؛ پس از گام جاری می‌ایستد.'); } catch(e){fail(e);} };
api('/api/session').then((r)=>{csrf=r.csrf;displayAuth(true);startAgentMonitor();return refresh();}).catch((err)=>{displayAuth(false);if (!/HTTP 401|وارد حساب شو/.test(err.message)) $('login-error').textContent = 'اتصال برقرار نشد. اتصال را بررسی و دوباره تلاش کن.';});
