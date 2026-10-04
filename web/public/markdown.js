/** Small Markdown subset for chat reports. Raw HTML is always escaped. */
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const link = (url) => {
  try {
    const parsed = new URL(url, 'https://asc.invalid');
    return ['https:', 'http:'].includes(parsed.protocol) &&
      (parsed.hostname !== 'asc.invalid' || url.startsWith('/api/idea-report?'))
      ? esc(url) : null;
  } catch { return null; }
};
function inline(text) {
  const slots = [];
  const token = (html) => { const id = slots.length; slots.push(html); return `\u0001${id}\u0002`; };
  let value = String(text ?? '').replace(/`([^`\n]+)`/g, (_all, code) => token(`<code>${esc(code)}</code>`));
  value = value.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g, (_all, label, url) => {
    const href = link(url);
    return href ? token(`<a href="${href}" ${url.startsWith('/api/idea-report?') ? 'download' : 'target="_blank" rel="noopener noreferrer"'}>${esc(label)}</a>`) : esc(label);
  });
  value = esc(value).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  return value.replace(/\u0001(\d+)\u0002/g, (_all, id) => slots[Number(id)] ?? '');
}
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const out = [];
  let list = false, code = false, codeLines = [], codeType = '';
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  const flushCode = () => {
    const nodes = codeType === 'mermaid' ? codeLines.map((line) => /^\s*\w+\["([^"]+)"\]\s*$/.exec(line)?.[1]).filter(Boolean) : [];
    if (nodes.length >= 2 && nodes.length <= 12 && codeLines.some((line) => /-->/.test(line)))
      out.push(`<div class="md-flow" role="img" aria-label="نمودار جریان">${nodes.map((label, i) =>
        `${i ? '<span class="md-flow-arrow" aria-hidden="true">↓</span>' : ''}<div class="md-flow-node">${esc(label)}</div>`).join('')}</div>`);
    else out.push(`<pre class="${codeType === 'mermaid' ? 'diagram-code' : ''}"><code>${esc(codeLines.join('\n'))}</code></pre>`);
    code = false; codeLines = []; codeType = '';
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList();
      if (code) flushCode(); else { code = true; codeType = line.slice(3).trim().toLowerCase(); }
      continue;
    }
    if (code) { codeLines.push(line); continue; }
    if (!line.trim()) { closeList(); continue; }
    if (/^\|.*\|$/.test(line) && /^\|[\s:|\-]+\|$/.test(lines[i + 1] || '')) {
      closeList(); const cells = (row) => row.slice(1, -1).split('|').map((cell) => cell.trim());
      out.push('<div class="md-table-wrap"><table><thead><tr>' + cells(line).map((cell) => `<th>${inline(cell)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      for (; i < lines.length && /^\|.*\|$/.test(lines[i]); i++)
        out.push('<tr>' + cells(lines[i]).map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>');
      out.push('</tbody></table></div>'); i--; continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { closeList(); const n = heading[1].length; out.push(`<h${n}>${inline(heading[2])}</h${n}>`); continue; }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (item) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(item[1])}</li>`); continue; }
    closeList();
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); if (code) flushCode();
  return out.join('');
}
