/** Static, model-free contract check for the React research workspace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const source = (...parts) => read('web', 'client', ...parts);

const main = source('main.tsx');
const api = source('lib', 'api.ts');
const base = source('base.css');
const login = source('pages', 'login.tsx');
const session = source('contexts', 'SessionContext.tsx');
const dashboard = source('pages', 'dashboard.tsx');
const dossiers = source('pages', 'dossiers.tsx');
const sources = source('pages', 'sources.tsx');
const agents = source('pages', 'agents.tsx');
const evidence = source('pages', 'evidence.tsx');
const settings = source('pages', 'settings.tsx');
const builtHtml = read('web', 'public', 'index.html');

for (const route of ['/', '/login', '/dossiers', '/dashboard', '/sources', '/agents', '/evidence', '/settings']) {
  assert.ok(main.includes(`path=\"${route}\"`), `missing React route ${route}`);
}
assert.match(main, /RequireSession/, 'private routes need an authentication guard');
assert.match(api, /X-CSRF-Token/, 'API mutations need the session CSRF token');
assert.match(login, /useSession/, 'login page is not connected to the session provider');
assert.match(session, /\/api\/login/, 'session provider is not connected to login');
assert.match(session, /\/api\/signup/, 'session provider is not connected to signup');
assert.match(dashboard, /\/api\/chat/, 'dashboard composer is not connected to chat');
assert.match(dossiers, /\/api\/(?:select-dossier|delete-dossier)/, 'dossier actions are not connected');
assert.match(sources, /\/api\/(?:upload|import-url|source-passages)/, 'source actions are not connected');
assert.match(agents, /\/api\/research-nodes\/run/, 'agent resume action is not connected');
assert.match(evidence, /useWorkspace/, 'evidence page is not using live workspace data');
assert.match(settings, /logout/, 'settings logout action is missing');
assert.match(session, /\/api\/logout/, 'session provider is not connected to logout');

assert.match(base, /:focus-visible/, 'keyboard focus is not visible');
assert.match(base, /prefers-reduced-motion:\s*reduce/, 'reduced motion is not respected');
assert.match(base, /@font-face/, 'local Persian font is missing');
assert.match(builtHtml, /<script[^>]+src="\/assets\/index-[^"]+\.js"/, 'production React bundle is missing');
assert.match(builtHtml, /lang="fa"/, 'built document language must be Persian');

for (const asset of [
  'hero-atlas-1920x1080.jpg', 'workflow-capture-1200x675.jpg',
  'feature-mother-agent-1200x675.jpg', 'privacy-local-system-1600x900.jpg',
  'dashboard-overview-1600x1000.png',
]) {
  assert.ok(fs.existsSync(path.join(root, 'web', 'public', 'landing-assets', asset)), `missing visual asset ${asset}`);
}

console.log('dashboard check passed — React routes, live API bindings, accessibility, build, and visuals; 0 model calls');
