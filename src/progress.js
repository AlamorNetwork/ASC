/** One editable Telegram status card. The bar counts completed phases, not elapsed work. */
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function progressText({ title, stages, current = 0, detail = '', since = Date.now(), round = null }) {
  const at = Math.max(0, Math.min(stages.length - 1, current));
  const elapsed = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
  const bar = `${'▰'.repeat(at)}${'▱'.repeat(stages.length - at)}`;
  return [
    `🔎 <b>${escapeHtml(title)}</b>${round ? ` · دور ${round}` : ''}`,
    `${bar}  ${at + 1}/${stages.length} مرحله`,
    `⏳ ${clock} · <b>${escapeHtml(stages[at])}</b>`,
    detail ? escapeHtml(String(detail).slice(0, 220)) : '',
    '<i>نوار، مرحلهٔ کار را نشان می‌دهد؛ زمان باقی‌مانده تخمین زده نمی‌شود.</i>',
  ].filter(Boolean).join('\n');
}

export function liveProgress({ title, stages, edit, buttons = [], intervalMs = 5000 }) {
  const since = Date.now();
  let current = 0, detail = '', round = null, closed = false;
  let stopping = false, activeButtons = buttons;
  let lastText = '', queue = Promise.resolve();

  function render(force = false) {
    if (closed) return queue;
    const body = progressText({ title, stages, current, detail, since, round });
    if (!force && body === lastText) return queue;
    lastText = body;
    queue = queue.then(() => edit(body, activeButtons)).catch((err) => {
      console.warn('[progress] status edit failed:', err.message);
    });
    return queue;
  }

  const timer = setInterval(() => { void render(); }, intervalMs);
  timer.unref?.();
  return {
    start: () => render(true),
    set(stage, message = '', newRound = round) {
      const index = stages.indexOf(stage);
      if (index < 0 || closed || stopping) return queue;
      current = index;
      detail = message;
      round = newRound;
      return render();
    },
    buttons(keys) {
      if (closed || stopping) return queue;
      activeButtons = keys;
      return render(true);
    },
    stopping() {
      if (closed) return queue;
      stopping = true;
      activeButtons = [];
      detail = '⏹ درخواست توقف ثبت شد؛ پس از فراخوانی فعلی می‌ایستم.';
      return render(true);
    },
    async close(text, finalButtons = []) {
      if (closed) return queue;
      closed = true;
      clearInterval(timer);
      await queue;
      return edit(text, finalButtons);
    },
  };
}
