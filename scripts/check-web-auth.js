/** High-value web authentication and tenant-isolation checks; makes zero model calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-web-auth-check-'));
process.env.ASC_DB = path.join(temp, 'auth.db');
process.env.WEB_PASSWORD = 'legacy-test-password-long-enough';
process.env.WEB_ORIGIN = 'https://auth-check.example';
process.env.WEB_PRINCIPAL_ID = 'legacy-web-owner';
process.env.WEB_SIGNUP_ENABLED = 'true';
process.env.WEB_SESSION_HOURS = '12';
process.env.NODE_ENV = 'production';

const { createWebServer } = await import('../src/web.js');
const store = await import('../src/db.js');
const cancel = await import('../src/cancel.js');
const { config } = await import('../src/config.js');
const { db } = store;
const waiting = new Map();
const server = createWebServer({ runChat: (input) => new Promise((resolve) => {
  waiting.set(String(input.principalId), resolve);
}) });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const origin = process.env.WEB_ORIGIN;

async function post(endpoint, body, session = null, extraHeaders = {}) {
  const headers = { Origin: origin, 'Content-Type': 'application/json', ...extraHeaders };
  if (session) {
    headers.Cookie = session.cookie;
    headers['X-CSRF-Token'] = session.csrf;
  }
  return fetch(`${base}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function signup(email, displayName, password) {
  const response = await post('/api/signup', { email, displayName, password });
  const body = await response.json();
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: body.csrf };
}

async function login(body) {
  const response = await post('/api/login', body);
  const data = await response.json();
  return { response, body: data, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: data.csrf };
}

try {
  const wrongOrigin = await fetch(`${base}/api/signup`, { method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'x@example.com', displayName: 'مهاجم', password: 'long-password-123' }) });
  assert.equal(wrongOrigin.status, 403, 'cross-origin signup was accepted');

  config.web.signupEnabled = false;
  const disabled = await signup('disabled@example.com', 'کاربر غیرفعال', 'long-password-123');
  assert.equal(disabled.response.status, 403, 'signup setting was ignored');
  assert.match(disabled.body.error, /غیرفعال/);
  config.web.signupEnabled = true;

  const weak = await signup('weak@example.com', 'کاربر ضعیف', 'short');
  assert.equal(weak.response.status, 400);
  assert.match(weak.body.error, /۱۲/);
  const badEmail = await signup('not-an-email', 'کاربر آزمایشی', 'strong-password-123');
  assert.equal(badEmail.response.status, 400);
  assert.match(badEmail.body.error, /ایمیل/);

  const passwordA = 'correct horse battery staple';
  const alice = await signup('  Alice@Example.COM ', '  آلیس   پژوهشگر  ', passwordA);
  assert.equal(alice.response.status, 201, JSON.stringify(alice.body));
  assert.equal(alice.body.user.email, 'alice@example.com');
  assert.equal(alice.body.user.displayName, 'آلیس پژوهشگر');
  assert.equal(alice.body.user.legacy, false);
  assert.ok(alice.cookie && alice.csrf);
  const aliceSetCookie = alice.response.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax'])
    assert.ok(aliceSetCookie.includes(attribute), `production cookie lacks ${attribute}`);
  assert.ok(!JSON.stringify(alice.body).includes(passwordA));
  assert.ok(!Object.hasOwn(alice.body.user, 'passwordHash'));

  const accountA = db.prepare(`SELECT * FROM web_accounts WHERE email = ?`).get('alice@example.com');
  assert.ok(accountA.principal_id.startsWith('web:'));
  assert.equal(accountA.display_name, 'آلیس پژوهشگر');
  assert.equal(accountA.password_scheme, 'scrypt-v1');
  assert.equal(Buffer.from(accountA.password_salt).length, 16);
  assert.equal(Buffer.from(accountA.password_hash).length, 64);
  assert.ok(!Buffer.from(accountA.password_hash).includes(Buffer.from(passwordA)));

  const duplicate = await signup('alice@example.com', 'آلیس دوم', 'another-password-123');
  assert.equal(duplicate.response.status, 409, 'normalized duplicate email was accepted');
  assert.match(duplicate.body.error, /قبلاً/);

  const wrongPassword = await login({ email: 'ALICE@example.com', password: 'wrong-password-123' });
  assert.equal(wrongPassword.response.status, 401);
  assert.match(wrongPassword.body.error, /ایمیل یا رمز/);
  const aliceLogin = await login({ email: ' ALICE@EXAMPLE.COM ', password: passwordA });
  assert.equal(aliceLogin.response.status, 200, JSON.stringify(aliceLogin.body));
  assert.equal(aliceLogin.body.user.email, 'alice@example.com');

  const tokenA = aliceLogin.cookie.slice('asc_session='.length);
  const sessionRows = db.prepare(`SELECT * FROM web_sessions WHERE principal_id = ?`).all(accountA.principal_id);
  assert.ok(sessionRows.length >= 2, 'sessions were not persisted');
  assert.ok(sessionRows.every((row) => row.token_hash !== tokenA), 'plaintext session token was stored');
  assert.ok(sessionRows.some((row) => row.token_hash === createHash('sha256').update(tokenA).digest('hex')),
    'session token digest was not stored');

  store.addMessage({ principalId: accountA.principal_id, dossierId: null, role: 'user', text: 'پیام آلیس' });
  const bob = await signup('bob@example.com', 'باب پژوهشگر', 'bob-password-long-123');
  assert.equal(bob.response.status, 201, JSON.stringify(bob.body));
  const accountB = db.prepare(`SELECT * FROM web_accounts WHERE email = ?`).get('bob@example.com');
  store.addMessage({ principalId: accountB.principal_id, dossierId: null, role: 'user', text: 'پیام باب' });
  const aliceState = await fetch(`${base}/api/state`, { headers: { Cookie: alice.cookie } });
  const bobState = await fetch(`${base}/api/state`, { headers: { Cookie: bob.cookie } });
  const [aliceData, bobData] = await Promise.all([aliceState.json(), bobState.json()]);
  assert.ok(aliceData.messages.some((row) => row.text === 'پیام آلیس'));
  assert.ok(!aliceData.messages.some((row) => row.text === 'پیام باب'), 'Alice saw Bob data');
  assert.ok(bobData.messages.some((row) => row.text === 'پیام باب'));
  assert.ok(!bobData.messages.some((row) => row.text === 'پیام آلیس'), 'Bob saw Alice data');

  const noCsrf = await post('/api/chat', { message: 'بدون توکن' },
    { cookie: alice.cookie, csrf: '' });
  assert.equal(noCsrf.status, 403, 'mutation without CSRF was accepted');
  const aliceJobResponse = await post('/api/chat', { message: 'کار آلیس' }, alice);
  const bobJobResponse = await post('/api/chat', { message: 'کار باب' }, bob);
  assert.equal(aliceJobResponse.status, 202);
  assert.equal(bobJobResponse.status, 202, 'Alice job globally blocked Bob');
  const aliceJob = await aliceJobResponse.json();
  const bobJob = await bobJobResponse.json();
  assert.ok(waiting.has(accountA.principal_id) && waiting.has(accountB.principal_id));

  const aliceActive = await fetch(`${base}/api/active-job`, { headers: { Cookie: alice.cookie } }).then((r) => r.json());
  const bobActive = await fetch(`${base}/api/active-job`, { headers: { Cookie: bob.cookie } }).then((r) => r.json());
  assert.equal(aliceActive.job.id, aliceJob.id);
  assert.equal(bobActive.job.id, bobJob.id);
  assert.ok(!Object.hasOwn(aliceActive.job, 'principalId'), 'job response exposed tenant key');
  assert.equal((await fetch(`${base}/api/jobs/${aliceJob.id}`, { headers: { Cookie: bob.cookie } })).status, 404,
    'Bob polled Alice job');
  assert.equal((await fetch(`${base}/api/jobs/${bobJob.id}`, { headers: { Cookie: alice.cookie } })).status, 404,
    'Alice polled Bob job');

  const stopped = await post('/api/stop', {}, alice);
  assert.equal(stopped.status, 200);
  assert.equal(cancel.isWanted(accountA.principal_id), true);
  assert.equal(cancel.isWanted(accountB.principal_id), false, 'Alice stop affected Bob');
  waiting.get(accountA.principal_id)({ text: 'پایان آلیس' });
  waiting.get(accountB.principal_id)({ text: 'پایان باب' });
  await new Promise((resolve) => setImmediate(resolve));

  const legacy = await login({ password: process.env.WEB_PASSWORD });
  assert.equal(legacy.response.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.user.legacy, true);
  store.addMessage({ principalId: process.env.WEB_PRINCIPAL_ID, dossierId: null,
    role: 'user', text: 'میراث قدیمی' });
  const legacyState = await fetch(`${base}/api/state`, { headers: { Cookie: legacy.cookie } }).then((r) => r.json());
  assert.ok(legacyState.messages.some((row) => row.text === 'میراث قدیمی'));
  assert.ok(!legacyState.messages.some((row) => row.text === 'پیام آلیس'), 'legacy principal saw account data');

  const logout = await post('/api/logout', {}, aliceLogin);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: aliceLogin.cookie } })).status, 401,
    'logged-out session was replayable');
  const revoked = db.prepare(`SELECT revoked_at FROM web_sessions WHERE token_hash = ?`)
    .get(createHash('sha256').update(tokenA).digest('hex'));
  assert.ok(revoked.revoked_at, 'logout did not persist revocation');

  const expiring = await login({ email: 'alice@example.com', password: passwordA });
  const expiringToken = expiring.cookie.slice('asc_session='.length);
  db.prepare(`UPDATE web_sessions SET expires_at = ? WHERE token_hash = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), createHash('sha256').update(expiringToken).digest('hex'));
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: expiring.cookie } })).status, 401,
    'expired session remained valid');

  console.log('web auth check passed — signup, login, legacy access, persisted sessions, CSRF, and tenant/job isolation; 0 model calls');
} finally {
  for (const resolve of waiting.values()) resolve({ text: 'test cleanup' });
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
