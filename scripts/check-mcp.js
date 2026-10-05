/** Free protocol and idea-handoff check. No external network or model calls. */
import assert from 'node:assert/strict';
const { McpClient } = await import('../src/mcp-client.js');
const { inspectIdeaTools } = await import('../src/idea-mcp.js');
const { config } = await import('../src/config.js');
const seen = [];
const fetcher = async (url, request) => {
  const body = JSON.parse(request.body);
  seen.push({ url, body, headers: request.headers });
  const response = body.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
    : body.method === 'tools/list' ? { tools: [{ name: 'search_code' }, { name: 'get_file_contents' },
      { name: 'resolve-library-id' }, { name: 'query-docs' }] }
      : body.method === 'tools/call' ? { content: [{ type: 'text', text: body.params.name === 'search_code'
        ? 'https://github.com/example/public/blob/main/docs/DESIGN.md'
        : body.params.name === 'get_file_contents' ? '# Design\nKeep permission boundaries explicit.'
          : body.params.name === 'resolve-library-id' ? 'Library ID: /nodejs/node'
            : 'Official guidance: validate input at the boundary.' }] } : null;
  if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: response }),
    { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-1' } });
};
assert.throws(() => new McpClient({ url: 'http://127.0.0.1/mcp' }), /allowlisted/);
const client = await new McpClient({ url: 'https://api.githubcopilot.com/mcp/', token: 'test-token',
  fetcher }).connect();
assert.ok((await client.call('search_code', { query: 'test' })).includes('DESIGN.md'));
assert.equal(seen[1].headers['Mcp-Session-Id'], 'session-1');
assert.equal(seen[0].headers.Authorization, 'Bearer test-token');
await assert.rejects(client.call('delete_repository', {}), /unavailable/);
const sse = async (_url, request) => {
  const body = JSON.parse(request.body);
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } });
};
assert.deepEqual((await new McpClient({ url: 'https://mcp.context7.com/mcp', fetcher: sse })
  .request('tools/list')).tools, []);
const before = { ...config.ideaMcp };
try {
  Object.assign(config.ideaMcp, { githubToken: 'test-token', context7Enabled: true });
  const notes = await inspectIdeaTools({ idea: 'medical booking app', summary: 'Node.js API',
    ask: async () => ({ data: { library: 'Node.js', githubQuery: 'medical booking' } }),
    structureModel: 'test', clientFactory: (options) => new McpClient({ ...options, fetcher }) });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].url, 'https://github.com/example/public/blob/main/docs/DESIGN.md');
  assert.equal(notes[1].url, 'https://context7.com/nodejs/node');
  assert.ok(notes.every((note) => note.status === 'unverified'));
  assert.ok(seen.some((request) => request.body.params?.name === 'query-docs'));
  Object.assign(config.ideaMcp, { githubToken: '', context7Enabled: false });
  assert.deepEqual(await inspectIdeaTools({ idea: 'x', summary: 'y' }), []);
} finally { Object.assign(config.ideaMcp, before); }
console.log('MCP check passed — allowlist, session, tools, SSE, GitHub and Context7; 0 model calls');
