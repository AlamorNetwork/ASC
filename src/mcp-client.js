/** Minimal Streamable HTTP MCP client for the two fixed, read-only research servers. */
export class McpClient {
  constructor({ url, token = '', headers = {}, fetcher = fetch, timeoutMs = 15000 }) {
    if (!['https://mcp.context7.com/mcp', 'https://api.githubcopilot.com/mcp/'].includes(url))
      throw new Error('MCP endpoint is not allowlisted');
    this.url = url;
    this.token = token;
    this.headers = headers;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.id = 0;
    this.session = '';
    this.version = '2025-06-18';
  }

  async request(method, params, notification = false) {
    const id = notification ? undefined : ++this.id;
    const body = { jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }), ...(params ? { params } : {}) };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...this.headers, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
      ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': this.version }) };
    const response = await this.fetcher(this.url, { method: 'POST', headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`MCP ${method}: HTTP ${response.status}`);
    if (response.headers.get('mcp-session-id')) this.session = response.headers.get('mcp-session-id');
    if (notification || response.status === 202) return null;
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new Error('MCP response too large');
    let message;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      message = raw.split(/\r?\n\r?\n/).flatMap((event) => event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:')).map((line) => {
          try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
        })).find((entry) => entry?.id === id);
    } else message = JSON.parse(raw);
    if (!message || message.id !== id) throw new Error(`MCP ${method}: response id missing`);
    if (message.error) throw new Error(`MCP ${method}: ${String(message.error.message).slice(0, 180)}`);
    return message.result;
  }

  async connect() {
    const info = await this.request('initialize', { protocolVersion: this.version,
      capabilities: {}, clientInfo: { name: 'asc', version: '0.1.0' } });
    this.version = info?.protocolVersion || this.version;
    await this.request('notifications/initialized', undefined, true);
    const listed = await this.request('tools/list');
    this.tools = new Set((listed?.tools || []).map((tool) => tool.name));
    return this;
  }

  async call(name, args) {
    if (!this.tools?.has(name)) throw new Error(`MCP tool unavailable: ${name}`);
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(`MCP ${name}: ${String(result.content?.[0]?.text || 'tool failed').slice(0, 180)}`);
    return (result?.content || []).filter((item) => item.type === 'text')
      .map((item) => item.text).join('\n').slice(0, 12000);
  }
}
