/** Live, read-only MCP connectivity probe. No model calls or writes. */
import { config } from '../src/config.js';
import { McpClient } from '../src/mcp-client.js';

if (!config.ideaMcp.githubToken && !config.ideaMcp.context7Enabled) {
  console.log('No idea MCP is enabled. Set GITHUB_MCP_TOKEN and/or CONTEXT7_MCP_ENABLED=1 in .env.');
  process.exit(0);
}

let failed = false;
if (config.ideaMcp.githubToken) try {
  const client = await new McpClient({ url: 'https://api.githubcopilot.com/mcp/',
    token: config.ideaMcp.githubToken, timeoutMs: 12000,
    headers: { 'X-MCP-Readonly': 'true', 'X-MCP-Tools': 'search_code,get_file_contents' } }).connect();
  const result = await client.call('search_code', {
    query: 'repo:github/github-mcp-server filename:README.md MCP', perPage: 1 });
  console.log(`GitHub MCP: connected; search_code returned ${result.length} characters.`);
} catch (err) {
  failed = true;
  console.error(`GitHub MCP: ${err.message}`);
}

if (config.ideaMcp.context7Enabled) try {
  const client = await new McpClient({ url: 'https://mcp.context7.com/mcp',
    token: config.ideaMcp.context7Key, timeoutMs: 12000 }).connect();
  const result = await client.call('resolve-library-id', {
    libraryName: 'Node.js', query: 'official Node.js documentation' });
  console.log(`Context7 MCP: connected; resolve-library-id returned ${result.length} characters.`);
} catch (err) {
  failed = true;
  console.error(`Context7 MCP: ${err.message}`);
}
if (failed) process.exitCode = 1;
