const $ = (id) => document.getElementById(id);
let csrf = '', selected = null, freshCase = false, activeJob = null, mode = 'chat', busy = false;
let investigation = null;
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const formatTime = (ms) => `${fa(Math.round(ms / 1000))} ثانیه`;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; setTimeout(() => $('toast').hidden = true, 5500); }
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
  $('case-count').textContent = fa(data.dossiers.length);
  $('stat-cases').textContent = fa(data.stats.dossiers);
  $('stat-verified').textContent = fa(data.stats.verified);
  $('stat-claims').textContent = fa(data.stats.claims);
  $('case-list').innerHTML = data.dossiers.map((d) => `<button class="case-item ${selected === d.id ? 'active' : ''}" data-case="${d.id}"><span class="case-name">${esc(d.topic)}</span><small>#${d.id} · ${esc(d.state)}</small></button>`).join('');
  for (const button of document.querySelectorAll('[data-case]')) button.onclick = async () => {
    try {
      const id = Number(button.dataset.case);
      await api('/api/select-dossier', { method:'POST', json:{ dossierId:id } });
      selected = id; freshCase = false; $('rail').classList.remove('open'); await refresh();
    } catch(e) { fail(e); }
  };
  $('breadcrumb').textContent = selected ? data.selected?.topic || 'پرونده' : 'گفت‌وگوی تازه';
  $('inspector-subtitle').textContent = data.selected?.topic || 'پرسش‌ها و شاهدها، کنار هم.';
  $('ledger').disabled = !selected;
  $('upload-target').textContent = freshCase || !selected
    ? 'مقصد فایل بعدی: پروندهٔ تازه'
    : `مقصد فایل بعدی: ${data.selected?.topic || 'پرونده'} (#${fa(selected)})`;
  $('messages').innerHTML = data.messages.map((m) => `<div class="message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="who">${m.role === 'user' ? 'YOU' : 'ASC'}</div><p>${esc(m.text)}</p></div>`).join('');
  $('messages').scrollTop = $('messages').scrollHeight;
  $('document-list').innerHTML = data.documents.map((d) => `<div class="doc-row"><span title="${esc(d.filename)}">◈ ${esc(d.filename)} ${d.pages ? `· ${fa(d.read_pages ?? d.pages)}/${fa(d.pages)}` : ''}</span><span class="doc-actions">${d.id && d.extraction !== 'model_vision_pages' ? `<button class="small-action" data-claims="${d.id}">ادعاها</button>` : ''}<button class="small-action" data-analyze="${d.id}" title="مدل تمام متن ذخیره‌شده را بخش‌به‌بخش تحلیل می‌کند و ممکن است هزینه داشته باشد">تحلیل عمیق</button><a class="small-action" href="/api/document-analysis?documentId=${d.id}" title="گزارش Markdown، پس از آغاز تحلیل">MD</a></span></div>`).join('');
  for (const b of document.querySelectorAll('[data-claims]')) b.onclick = async () => { try { const r = await api('/api/claims', { method:'POST', json:{ documentId:Number(b.dataset.claims) } }); watch(r.id, 'استخراج ادعاها'); } catch(e){fail(e);} };
  for (const b of document.querySelectorAll('[data-analyze]')) b.onclick = async () => { try { const r = await api('/api/analyze-document', { method:'POST', json:{ documentId:Number(b.dataset.analyze) } }); watch(r.id, 'تحلیل عمیق سند'); } catch(e){fail(e);} };
  $('claims-list').innerHTML = data.claims.length ? data.claims.slice(-15).reverse().map((c) => `<div class="claim ${c.status === 'verified' ? '' : 'found'}">${c.status === 'verified' ? '✓ تأیید' : '◇ نیاز به بررسی'} · ${esc(c.text)}<small>${esc(c.source_title || c.source_url || 'منبع نامشخص')}</small></div>`).join('') : '<p class="muted">هنوز شاهدی ثبت نشده است.</p>';
  renderResearch(data.researchNodes);
  renderSources(data.sources);
  renderInvestigation();
}
function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
function renderResearch(rawNodes) {
  const form = $('research-node-form');
  form.hidden = !selected;
  if (!selected) {
    $('research-tree').innerHTML = '<p class="muted">برای دیدن پرسش‌ها، پرونده‌ای انتخاب کن.</p>';
    $('research-parent').innerHTML = '';
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
  const options = ['<option value="">پرسش اصلی (ریشه)</option>'];
  function branch(node, depth) {
    const id = Number(node.id);
    if (visited.has(id)) return '';
    visited.add(id);
    options.push(`<option value="${id}">${esc(`${'— '.repeat(Math.min(depth, 12))}${node.title || 'بی‌عنوان'}`)}</option>`);
    const status = node.status ? `<span class="research-status">${esc(node.status)}</span>` : '';
    const question = node.open_question ? `<p>${esc(node.open_question)}</p>` : '';
    let result = null;
    try { result = JSON.parse(node.result_json || 'null'); } catch { /* unfinished output */ }
    const summary = result?.summary ? `<p class="research-summary">${esc(result.summary)}</p>` : '';
    const findings = Array.isArray(result?.findings) ? result.findings.slice(0, 5).map((f) =>
      `<li>${esc(f.text)} <small>سند #${fa(f.documentId)}${f.page ? ` · ص ${fa(f.page)}` : ''} · نقل‌قول در متن موجود است؛ صحت ادعا هنوز داوری نشده</small></li>`).join('') : '';
    const resultView = summary || findings ? `<details><summary>گزارش عامل</summary>${summary}${findings ? `<ul>${findings}</ul>` : ''}</details>` : '';
    const role = node.assigned_role ? `<small>نقش: ${esc(node.assigned_role)}</small>` : '';
    const run = (node.parent_id == null || node.parent_id === '' || node.parent_id === 0) && ['pending', 'paused'].includes(node.status)
      ? `<button type="button" class="small-action" data-research-run="${id}" aria-label="اجرای پژوهش ${esc(node.title || 'بی‌عنوان')}" ${busy ? 'disabled' : ''}>اجرای پژوهش</button>` : '';
    const descendants = (children.get(id) || []).map((child) => branch(child, depth + 1)).join('');
    return `<li><div class="research-node"><strong>${esc(node.title || 'بی‌عنوان')}</strong>${status}${question}${role}${resultView}<div class="research-actions"><button type="button" class="small-action" data-research-child="${id}" aria-label="افزودن زیرپرسش به ${esc(node.title || 'بی‌عنوان')}">＋ زیرپرسش</button>${run}</div></div>${descendants ? `<ul>${descendants}</ul>` : ''}</li>`;
  }
  const roots = children.get(0) || [];
  const tree = [...roots, ...nodes.filter((n) => !roots.includes(n))].map((node) => branch(node, 0)).join('');
  $('research-tree').innerHTML = tree ? `<ul class="research-roots">${tree}</ul>` : '<p class="muted">هنوز پرسشی ثبت نشده است. یک پرسش اصلی بساز.</p>';
  const parent = $('research-parent');
  const prior = parent.value;
  parent.innerHTML = options.join('');
  if (options.some((option) => option.includes(`value="${prior}"`))) parent.value = prior;
  for (const button of $('research-tree').querySelectorAll('[data-research-child]')) button.onclick = () => {
    parent.value = button.dataset.researchChild;
    $('research-title').focus();
  };
  for (const button of $('research-tree').querySelectorAll('[data-research-run]')) button.onclick = async () => {
    if (busy || !selected) return;
    if (!confirm('گروه پژوهش تا ۳ عامل متنی را موازی اجرا می‌کند و برای برنامه‌ریزی و جمع‌بندی هم مدل صدا می‌زند. هزینه بسته به مدل تنظیم‌شده است. شروع شود؟')) return;
    setBusy(true);
    try {
      const job = await api('/api/research-nodes/run', { method:'POST', json:{ nodeId:Number(button.dataset.researchRun) } });
      if (job.id) watch(job.id, 'اجرای پژوهش');
      else { setBusy(false); await refresh(); }
    } catch (err) { setBusy(false); fail(err); }
  };
  form.querySelector('button[type="submit"]').disabled = busy;
}
function renderSources(rawSources) {
  $('site-form').hidden = !selected;
  $('site-form').querySelector('button[type="submit"]').disabled = busy;
  $('consult-form').hidden = !selected;
  $('consult-form').querySelector('button[type="submit"]').disabled = busy;
  if (!selected) {
    $('source-list').innerHTML = '<p class="muted">برای دیدن منابع، پرونده‌ای انتخاب کن.</p>';
    return;
  }
  const sources = Array.isArray(rawSources) ? rawSources.filter((source) => source && typeof source === 'object') : [];
  $('source-list').innerHTML = sources.length ? `<ul>${sources.map((source) => {
    const url = safeWebUrl(source.url);
    const title = esc(source.title || source.url || 'منبع بی‌عنوان');
    const heading = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<strong>${title}</strong>`;
    const pages = source.pages ? ` · ${fa(source.readPages ?? 0)}/${fa(source.pages)} صفحه` : '';
    const status = source.analysisStatus ? ` · ${esc(source.analysisStatus)}` : '';
    const relations = Array.isArray(source.relations) ? source.relations.slice(0, 5) : [];
    return `<li><div class="source-heading">${heading}</div><small>${esc(source.type || 'منبع')}${pages}${status}</small>${source.summary ? `<p>${esc(source.summary)}</p>` : ''}${relations.length ? `<details><summary>ارتباط بخش‌ها</summary><ul>${relations.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}</li>`;
  }).join('')}</ul>` : '<p class="muted">هنوز منبعی در این پرونده ثبت نشده است.</p>';
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
  $('upload-list').innerHTML = list.map((m) => {
    const progress = m.pages ? ` · ${fa(m.readPages ?? 0)}/${fa(m.pages)} صفحه` : '';
    const destination = m.dossierId ? `پرونده #${fa(m.dossierId)}` : m.newDossier ? 'پروندهٔ تازه' : 'پروندهٔ فعال';
    return `<div class="upload-row"><span title="${esc(m.name)}">${esc(m.name)}<small>${destination}${progress}</small></span><span class="upload-actions"><button class="small-action" data-upload="${esc(m.id)}" data-mode="detect">بررسی</button>${/\.pdf$/i.test(m.name) && (!m.pages || m.readPages < m.pages) ? `<button class="small-action" data-upload="${esc(m.id)}" data-mode="batch">۲۰ صفحه</button><button class="small-action" data-upload="${esc(m.id)}" data-mode="all">تا پایان</button>` : ''}</span></div>`;
  }).join('');
  for (const b of document.querySelectorAll('[data-upload]')) b.onclick = () => beginImport(b.dataset.upload, b.dataset.mode);
}
function fail(e) { toast(e.message || String(e)); }
function setBusy(value) { busy = value; $('compose-form').querySelector('button').disabled = value; $('resume-deep').disabled = value; $('research-node-form').querySelector('button[type="submit"]').disabled = value; $('site-form').querySelector('button[type="submit"]').disabled = value; $('consult-form').querySelector('button[type="submit"]').disabled = value; for (const button of $('research-tree').querySelectorAll('[data-research-run]')) button.disabled = value; }
async function beginImport(id, visionMode = 'detect') {
  if (busy) return toast('یک کار دیگر در حال اجراست.');
  if (visionMode !== 'detect' && !confirm(visionMode === 'all'
    ? 'همهٔ صفحه‌های باقی‌ماندهٔ این PDF با مدل ویژن خوانده می‌شود و ممکن است هزینه و زمان زیادی داشته باشد. هر صفحه پس از خواندن ذخیره می‌شود و می‌توانی کار را نگه داری و ادامه بدهی. شروع شود؟'
    : '۲۰ صفحهٔ بعدی با مدل ویژن خوانده می‌شود و ممکن است هزینه داشته باشد. شروع شود؟')) return;
  try {
    const r = await api('/api/import', { method: 'POST', json: {
      uploadId:id, dossierId:selected, visionMode:visionMode === 'detect' ? null : visionMode,
    } });
    watch(r.id, visionMode === 'all' ? 'خواندن تا پایان' : visionMode === 'batch' ? 'خواندن ۲۰ صفحه' : 'بررسی سند');
  } catch(e) { fail(e); }
}
async function watch(id, title) {
  activeJob = id; setBusy(true); $('progress').hidden = false; $('progress-title').textContent = title;
  const started = Date.now();
  while (activeJob === id) {
    try {
      const job = await api(`/api/jobs/${id}`);
      $('progress-time').textContent = formatTime(Date.now() - started);
      $('progress-detail').textContent = job.stage || 'در حال انجام…';
      if (job.kind === 'deep' && job.state === 'running') {
        const status = `در حال کاوش · ${job.stage || 'در حال آماده‌سازی…'}`;
        if ($('investigation-status').textContent !== status) $('investigation-status').textContent = status;
      }
      const page = /صفحه\s+(\d+)\s+از\s+(\d+)/.exec(job.stage || '');
      const vector = /بردار\s+(\d+)\s+از\s+(\d+)/.exec(job.stage || '');
      const analysis = /(?:تحلیل )?بخش\s+(\d+)\s+از\s+(\d+)/.exec(job.stage || '');
      const part = page || vector || analysis;
      $('progress-fill').classList.toggle('indeterminate', !part);
      if (part) $('progress-fill').style.width = `${Math.max(3, Math.min(100, Math.round(Number(part[1]) / Number(part[2]) * 100)))}%`;
      if (job.state !== 'running') {
        activeJob = null; setBusy(false); $('progress-fill').classList.remove('indeterminate'); $('progress-fill').style.width = '100%';
        setTimeout(() => { $('progress').hidden = true; $('progress-fill').style.width = '5%'; }, 1400);
        if (job.state === 'failed') toast(job.savedScan ? `${job.error} · تا صفحه ${job.savedScan.readPages} ذخیره شد.` : job.error);
        if (job.state === 'done') {
          if (job.result?.dossierId) {
            selected = Number(job.result.dossierId); freshCase = false;
          }
          if (job.kind === 'chat' && !selected) addMessage('assistant', job.result?.text || '');
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
          selected = Number(job.result.dossierId);
          freshCase = false;
          toast(`PDF اسکن‌شده است؛ ${fa(job.result.readPages)} از ${fa(job.result.pages)} صفحه خوانده شده. برای ادامه، «۲۰ صفحه» یا «تا پایان» را بزن.`);
        }
        await refresh();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch(e) { activeJob = null; setBusy(false); $('progress').hidden = true; fail(e); break; }
  }
}
function addMessage(role, text) {
  const box = document.createElement('div'); box.className = `message ${role}`;
  const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'user' ? 'YOU' : 'ASC';
  const p = document.createElement('p'); p.textContent = text;
  box.append(who, p); $('messages').append(box); $('messages').scrollTop = $('messages').scrollHeight;
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
      $('upload-status').textContent = 'آپلود کامل شد. مقصد پرونده ثبت شد؛ برای شروع خواندن، دکمهٔ همان فایل را بزن.';
      refresh().catch(fail); }
    catch(e){ $('upload-status').textContent=''; fail(e); }
  };
  xhr.onerror = () => { $('upload-status').textContent=''; toast('اتصال هنگام آپلود قطع شد.'); };
  xhr.send(file);
}
$('login-form').onsubmit = async (e) => { e.preventDefault(); $('login-error').textContent = '';
  try { const r = await api('/api/login', { method:'POST', json:{ password:$('password').value } }); csrf = r.csrf; $('password').value=''; displayAuth(true); await refresh(); }
  catch(err){ $('login-error').textContent = err.message; } };
$('logout').onclick = async () => { await api('/api/logout', { method:'POST' }).catch(() => {}); csrf=''; displayAuth(false); };
$('refresh').onclick = () => refresh().catch(fail);
$('new-case').onclick = () => { selected=null; freshCase=true; $('messages').innerHTML=''; $('breadcrumb').textContent='گفت‌وگوی تازه'; $('rail').classList.remove('open'); refresh().catch(fail); };
$('mobile-menu').onclick = () => $('rail').classList.toggle('open');
for (const [id, value] of [['tab-chat','chat'],['tab-research','research'],['tab-deep','deep']]) $(id).onclick = () => {
  mode=value;
  for (const [tab, kind] of [['tab-chat','chat'],['tab-research','research'],['tab-deep','deep']]) {
    $(tab).classList.toggle('selected', value === kind);
    $(tab).setAttribute('aria-pressed', String(value === kind));
  }
  $('deep-options').hidden = value !== 'deep';
  $('deep-ceiling').disabled = value !== 'deep';
  $('prompt').placeholder = value === 'deep' ? 'پرسش اصلی کاوش عمیق چیست؟' : value === 'research' ? 'در چه موضوعی تحقیق کنم؟' : 'پرسش یا ایده‌ات را بنویس…';
  $('compose-hint').textContent = value === 'deep' ? 'کاوش تنها با ارسال و پس از تأیید سقف هزینه شروع می‌شود. در پروندهٔ انتخابی ثبت خواهد شد.' : value === 'research' ? 'با ارسال، تحقیق وب و بررسی منابع شروع می‌شود و ممکن است هزینه داشته باشد.' : 'برای تحقیق وب، تب «تحقیق وب» را انتخاب کن؛ جست‌وجو خودکار شروع نمی‌شود.';
};
$('compose-form').onsubmit = async (e) => { e.preventDefault(); if (busy) return;
  const message=$('prompt').value.trim(); if (!message) return;
  if (mode === 'deep') return startDeep();
  try { const r=await api(`/api/${mode}`, { method:'POST', json:{ message, question:message, dossierId:selected } });
    $('prompt').value=''; addMessage('user',message); watch(r.id,mode==='chat'?'در حال پاسخ':'در حال تحقیق وب'); }
  catch(err){fail(err);} };
$('resume-deep').onclick = () => startDeep({ resume:true });
$('research-node-form').onsubmit = async (e) => {
  e.preventDefault();
  if (busy || !selected) return;
  const title = $('research-title').value.trim();
  const openQuestion = $('research-question').value.trim();
  const parentId = $('research-parent').value ? Number($('research-parent').value) : null;
  if (!title) return $('research-title').focus();
  const status = $('research-form-status');
  status.textContent = 'در حال ثبت…';
  setBusy(true);
  try {
    await api('/api/research-nodes', { method:'POST', json:{ dossierId:selected, ...(parentId ? { parentId } : {}), title, ...(openQuestion ? { openQuestion } : {}) } });
    $('research-title').value = '';
    $('research-question').value = '';
    status.textContent = 'پرسش ثبت شد.';
    await refresh();
  } catch (err) { status.textContent = err.message || 'ثبت پرسش ناموفق بود.'; fail(err); }
  finally { setBusy(false); }
};
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
api('/api/session').then((r)=>{csrf=r.csrf;displayAuth(true);return refresh();}).catch(()=>displayAuth(false));
