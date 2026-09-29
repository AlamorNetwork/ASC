const $ = (id) => document.getElementById(id);
let csrf = '', selected = null, activeJob = null, mode = 'chat', uploadId = null, busy = false;
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
  const q = selected ? `?dossierId=${selected}` : '';
  const data = await api(`/api/state${q}`);
  if (selected && !data.selected) selected = null;
  render(data);
  await loadUploads();
}
function render(data) {
  $('case-count').textContent = fa(data.dossiers.length);
  $('stat-cases').textContent = fa(data.stats.dossiers);
  $('stat-verified').textContent = fa(data.stats.verified);
  $('stat-claims').textContent = fa(data.stats.claims);
  $('case-list').innerHTML = data.dossiers.map((d) => `<button class="case-item ${selected === d.id ? 'active' : ''}" data-case="${d.id}"><span class="case-name">${esc(d.topic)}</span><small>#${d.id} · ${esc(d.state)}</small></button>`).join('');
  for (const button of document.querySelectorAll('[data-case]')) button.onclick = () => { selected = Number(button.dataset.case); $('rail').classList.remove('open'); refresh().catch(fail); };
  $('breadcrumb').textContent = selected ? data.selected?.topic || 'پرونده' : 'گفت‌وگوی تازه';
  $('inspector-subtitle').textContent = data.selected?.topic || 'پرسش‌ها و شاهدها، کنار هم.';
  $('ledger').disabled = !selected;
  $('messages').innerHTML = data.messages.map((m) => `<div class="message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="who">${m.role === 'user' ? 'YOU' : 'ASC'}</div><p>${esc(m.text)}</p></div>`).join('');
  $('messages').scrollTop = $('messages').scrollHeight;
  $('document-list').innerHTML = data.documents.map((d) => `<div class="doc-row"><span title="${esc(d.filename)}">◈ ${esc(d.filename)} ${d.pages ? `· ${fa(d.read_pages || d.pages)}/${fa(d.pages)}` : ''}</span><span class="doc-actions">${d.id && d.extraction !== 'model_vision_pages' ? `<button class="small-action" data-claims="${d.id}">ادعاها</button>` : ''}<button class="small-action" data-analyze="${d.id}" title="مدل تمام متن ذخیره‌شده را بخش‌به‌بخش تحلیل می‌کند و ممکن است هزینه داشته باشد">تحلیل عمیق</button><a class="small-action" href="/api/document-analysis?documentId=${d.id}" title="گزارش Markdown، پس از آغاز تحلیل">MD</a></span></div>`).join('');
  for (const b of document.querySelectorAll('[data-claims]')) b.onclick = async () => { try { const r = await api('/api/claims', { method:'POST', json:{ documentId:Number(b.dataset.claims) } }); watch(r.id, 'استخراج ادعاها'); } catch(e){fail(e);} };
  for (const b of document.querySelectorAll('[data-analyze]')) b.onclick = async () => { try { const r = await api('/api/analyze-document', { method:'POST', json:{ documentId:Number(b.dataset.analyze) } }); watch(r.id, 'تحلیل عمیق سند'); } catch(e){fail(e);} };
  $('claims-list').innerHTML = data.claims.length ? data.claims.slice(-15).reverse().map((c) => `<div class="claim ${c.status === 'verified' ? '' : 'found'}">${c.status === 'verified' ? '✓ تأیید' : '◇ نیاز به بررسی'} · ${esc(c.text)}<small>${esc(c.source_title || c.source_url || 'منبع نامشخص')}</small></div>`).join('') : '<p class="muted">هنوز شاهدی ثبت نشده است.</p>';
}
async function loadUploads() {
  const list = await api('/api/uploads');
  $('upload-list').innerHTML = list.slice(0, 5).map((m) => `<div class="upload-row"><span title="${esc(m.name)}">${esc(m.name)} · ${fa(Math.round(m.size/1048576))} MB</span><button class="small-action" data-upload="${esc(m.id)}">خواندن</button></div>`).join('');
  for (const b of document.querySelectorAll('[data-upload]')) b.onclick = () => beginImport(b.dataset.upload, selected, false);
}
function fail(e) { toast(e.message || String(e)); }
function setBusy(value) { busy = value; $('compose-form').querySelector('button').disabled = value; }
async function beginImport(id, dossierId, vision) {
  if (busy) return toast('یک کار دیگر در حال اجراست.');
  try {
    const r = await api('/api/import', { method: 'POST', json: { uploadId:id, dossierId, visionPages:vision ? 20 : null } });
    uploadId = id; watch(r.id, vision ? 'خواندن ۲۰ صفحه' : 'خواندن سند');
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
          if (job.result?.dossierId) selected = Number(job.result.dossierId);
          if (job.kind === 'chat' && !selected) addMessage('assistant', job.result?.text || '');
          if (job.kind === 'research') toast('تحقیق ثبت شد؛ یافته‌ها را در پرونده ببین.');
          if (job.kind === 'import') toast(job.result?.alreadyRead ? 'این سند قبلاً خوانده شده است.' : 'سند ذخیره شد.');
          if (job.kind === 'analysis') toast(`تحلیل ${fa(job.result?.sections)} بخش ثبت شد؛ فایل MD از کنار سند دریافت می‌شود.`);
        }
        if (job.state === 'needs_vision') {
          selected = Number(job.result.dossierId);
          toast(`این PDF اسکن‌شده است؛ ${fa(job.result.pages)} صفحه دارد. خواندن هر ۲۰ صفحه هزینهٔ مدل دارد.`);
          const yes = confirm(`این PDF اسکن‌شده است و ${job.result.pages} صفحه دارد. ۲۰ صفحهٔ بعدی با مدل ویژن خوانده شود؟ این کار ممکن است هزینه داشته باشد.`);
          if (yes) beginImport(job.result.uploadId, selected, true);
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
  xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
  xhr.withCredentials = true; xhr.setRequestHeader('X-CSRF-Token', csrf);
  $('upload-status').textContent = 'در حال آپلود…';
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('upload-status').textContent = `آپلود: ${fa(Math.round(e.loaded/e.total*100))}٪`; };
  xhr.onload = () => {
    try { const r = JSON.parse(xhr.responseText); if (xhr.status !== 201) throw new Error(r.error || 'آپلود ناموفق بود.');
      $('upload-status').textContent = 'آپلود کامل شد. برای شروع خواندن، دکمهٔ همان فایل را بزن.'; uploadId = r.id; loadUploads().catch(fail); }
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
$('new-case').onclick = () => { selected=null; $('messages').innerHTML=''; $('breadcrumb').textContent='گفت‌وگوی تازه'; $('rail').classList.remove('open'); refresh().catch(fail); };
$('mobile-menu').onclick = () => $('rail').classList.toggle('open');
for (const [id, value] of [['tab-chat','chat'],['tab-research','research']]) $(id).onclick = () => {
  mode=value; $('tab-chat').classList.toggle('selected',value==='chat'); $('tab-research').classList.toggle('selected',value==='research');
  $('prompt').placeholder = value==='research' ? 'در چه موضوعی تحقیق کنم؟' : 'پرسش یا ایده‌ات را بنویس…';
  $('compose-hint').textContent = value==='research' ? 'با ارسال، تحقیق وب و بررسی منابع شروع می‌شود و ممکن است هزینه داشته باشد.' : 'برای تحقیق وب، تب «تحقیق وب» را انتخاب کن؛ جست‌وجو خودکار شروع نمی‌شود.';
};
$('compose-form').onsubmit = async (e) => { e.preventDefault(); if (busy) return;
  const message=$('prompt').value.trim(); if (!message) return;
  try { const r=await api(`/api/${mode}`, { method:'POST', json:{ message, question:message, dossierId:selected } });
    $('prompt').value=''; addMessage('user',message); watch(r.id,mode==='chat'?'در حال پاسخ':'در حال تحقیق وب'); }
  catch(err){fail(err);} };
$('file-input').onchange = (e) => sendFile(e.target.files[0]);
const zone=$('drop-zone'); zone.ondragover=(e)=>{e.preventDefault();zone.classList.add('dragging');};
zone.ondragleave=()=>zone.classList.remove('dragging'); zone.ondrop=(e)=>{e.preventDefault();zone.classList.remove('dragging');sendFile(e.dataTransfer.files[0]);};
$('ledger').onclick = () => { if (selected) window.location.href=`/api/ledger?dossierId=${selected}`; };
$('stop-job').onclick = async () => { try { await api('/api/stop',{method:'POST'}); toast('درخواست توقف ثبت شد؛ پس از گام جاری می‌ایستد.'); } catch(e){fail(e);} };
api('/api/session').then((r)=>{csrf=r.csrf;displayAuth(true);return refresh();}).catch(()=>displayAuth(false));
