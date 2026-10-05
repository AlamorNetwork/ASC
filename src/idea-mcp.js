/** Optional GitHub and Context7 lookups for the idea handoff. Their text is a lead, not verified evidence. */
import { config } from './config.js';
import { McpClient } from './mcp-client.js';

const short = (value, n = 240) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const idFromContext7 = (text) => text.match(/(?:Library ID|Context7-compatible library ID):\s*(\/[\w.\-/]+)/i)?.[1] || null;
const githubFile = (text) => {
  const match = text.match(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/[^\s"<>]+?\/([^\s"<>?#]+\.(?:md|mdx))/i);
  return match ? { owner: match[1], repo: match[2], path: match[3], url: match[0] } : null;
};

export async function inspectIdeaTools({ idea, summary, ask, onProgress, structureModel,
  clientFactory = (options) => new McpClient(options) }) {
  const { githubToken, context7Enabled, context7Key } = config.ideaMcp;
  if (!githubToken && !context7Enabled) return [];
  // This planning call is limited to technology identifiers and a public-repo search term.
  // It cannot ask a model to choose or invoke arbitrary MCP tools.
  let plan;
  try {
    const response = await ask({ model: structureModel,
      system: 'Only JSON: {"library":"one real framework or SDK name, or empty", "githubQuery":"2-5 English words for a public GitHub DESIGN.md / architecture example"}. Use the research summary, avoid invented packages, omit private details.',
      content: JSON.stringify({ idea: short(idea, 400), summary: short(summary, 700) }), maxTokens: 180 });
    plan = response.data;
  } catch { return []; }
  const notes = [];
  if (githubToken && plan?.githubQuery) {
    try {
      onProgress?.('عامل فنی: جست‌وجوی نمونهٔ عمومی GitHub از طریق MCP');
      const client = await clientFactory({ url: 'https://api.githubcopilot.com/mcp/', token: githubToken,
        headers: { 'X-MCP-Readonly': 'true', 'X-MCP-Tools': 'search_code,get_file_contents' } }).connect();
      const term = short(plan.githubQuery, 90).replace(/[^a-zA-Z0-9 .+_-]/g, '').trim();
      if (term) {
        const found = await client.call('search_code', { query: `${term} filename:DESIGN.md is:public`, perPage: 5 });
        const file = githubFile(found);
        if (file) {
          const body = await client.call('get_file_contents', { owner: file.owner, repo: file.repo, path: file.path });
          notes.push({ service: 'GitHub', topic: term, url: file.url,
            text: short(body, 4000), status: 'unverified' });
        } else notes.push({ service: 'GitHub', topic: term, text: short(found, 1200), status: 'lead_only' });
      }
    } catch (err) { onProgress?.(`GitHub MCP در دسترس نبود: ${short(err.message, 120)}`); }
  }
  if (context7Enabled && plan?.library) {
    try {
      onProgress?.('عامل فنی: بررسی مستندات فناوری در Context7');
      const client = await clientFactory({ url: 'https://mcp.context7.com/mcp', token: context7Key }).connect();
      const library = short(plan.library, 70);
      const resolved = await client.call('resolve-library-id', { libraryName: library,
        query: 'official architecture, security and deployment guidance for this product idea' });
      const id = idFromContext7(resolved);
      if (id) {
        const doc = await client.call('query-docs', { libraryId: id,
          query: 'What are the current official architecture and security recommendations for a production application?' });
        notes.push({ service: 'Context7', topic: library, url: `https://context7.com${id}`,
          text: short(doc, 4000), status: 'unverified' });
      } else notes.push({ service: 'Context7', topic: library, text: short(resolved, 1200), status: 'lead_only' });
    } catch (err) { onProgress?.(`Context7 MCP در دسترس نبود: ${short(err.message, 120)}`); }
  }
  return notes;
}
