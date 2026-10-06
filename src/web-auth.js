/** Password and session authentication for the web surface. */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as store from './db.js';

const derive = promisify(scrypt);
const COOKIE_NAME = 'asc_session';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_SALT = Buffer.from('asc-web-unknown-account-v1');
let dummyHash;

export class WebAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'WebAuthError';
    this.status = status;
  }
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new WebAuthError(400, 'ایمیل را وارد کن.');
  const email = value.normalize('NFKC').trim().toLowerCase();
  const atom = "[a-z0-9.!#$%&'*+/=?^_`{|}~-]+";
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  if (email.length > 254 || !new RegExp(`^${atom}@${label}(?:\\.${label})+$`, 'i').test(email))
    throw new WebAuthError(400, 'ایمیل معتبر نیست.');
  return email;
}

function validDisplayName(value) {
  if (typeof value !== 'string') throw new WebAuthError(400, 'نام نمایشی را وارد کن.');
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80 || /[\x00-\x1f\x7f]/.test(name))
    throw new WebAuthError(400, 'نام نمایشی باید بین ۲ تا ۸۰ نویسه باشد.');
  return name;
}

function signupPassword(value) {
  if (typeof value !== 'string' || value.length < 12)
    throw new WebAuthError(400, 'رمز عبور باید دست‌کم ۱۲ نویسه باشد.');
  if (value.length > 256 || Buffer.byteLength(value) > 1024)
    throw new WebAuthError(400, 'رمز عبور بیش از حد بلند است.');
  return value;
}

function loginPassword(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || Buffer.byteLength(value) > 1024)
    throw new WebAuthError(401, 'ایمیل یا رمز عبور درست نیست.');
  return value;
}

async function scryptHash(password, salt) {
  return Buffer.from(await derive(password, salt, 64, SCRYPT_OPTIONS));
}

function equalHash(expected, actual) {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function storedBlob(value) {
  return value instanceof Uint8Array ? Buffer.from(value) : null;
}

export async function createAccount({ email, displayName, password }) {
  if (!config.web.signupEnabled)
    throw new WebAuthError(403, 'ثبت‌نام در این سامانه غیرفعال است.');
  const normalizedEmail = normalizeEmail(email);
  const name = validDisplayName(displayName);
  const secret = signupPassword(password);
  const salt = randomBytes(16);
  const hash = await scryptHash(secret, salt);
  try {
    return store.createWebAccount({ principalId: `web:${randomUUID()}`,
      email: normalizedEmail, displayName: name, passwordSalt: salt, passwordHash: hash });
  } catch (err) {
    if (/UNIQUE constraint failed: web_accounts\.email/i.test(err.message))
      throw new WebAuthError(409, 'این ایمیل قبلاً ثبت شده است.');
    throw err;
  }
}

export async function authenticateAccount(email, password) {
  let normalizedEmail;
  try { normalizedEmail = normalizeEmail(email); }
  catch { normalizedEmail = ''; }
  let secret;
  try { secret = loginPassword(password); }
  catch { throw new WebAuthError(401, 'ایمیل یا رمز عبور درست نیست.'); }
  const account = normalizedEmail ? store.getWebAccountByEmail(normalizedEmail) : null;
  const accountSalt = storedBlob(account?.password_salt);
  const accountHash = storedBlob(account?.password_hash);
  const salt = account?.password_scheme === 'scrypt-v1' && accountSalt
    ? accountSalt : DUMMY_SALT;
  const expected = account?.password_scheme === 'scrypt-v1' && accountHash
    ? accountHash
    : (dummyHash ??= await scryptHash('not-a-real-password', DUMMY_SALT));
  const actual = await scryptHash(secret, salt);
  if (!account || !equalHash(expected, actual))
    throw new WebAuthError(401, 'ایمیل یا رمز عبور درست نیست.');
  return { principalId: account.principal_id, email: account.email, displayName: account.display_name };
}

export async function authenticateLegacy(password) {
  let secret;
  try { secret = loginPassword(password); }
  catch { throw new WebAuthError(401, 'رمز درست نیست.'); }
  if (!config.web.password) throw new WebAuthError(401, 'رمز درست نیست.');
  const salt = Buffer.from('asc-web-password-v1');
  const [expected, actual] = await Promise.all([
    scryptHash(config.web.password, salt),
    scryptHash(secret, salt),
  ]);
  if (!equalHash(expected, actual)) throw new WebAuthError(401, 'رمز درست نیست.');
  return { principalId: legacyPrincipalId(), email: null, displayName: null };
}

export function legacyPrincipalId() {
  const id = config.web.principalId || store.getSetting('owner_chat_id') || config.ownerChatId;
  if (!id) throw new Error('WEB_PRINCIPAL_ID is not set and the Telegram owner is unknown. Add WEB_PRINCIPAL_ID to .env.');
  return String(id);
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function issueSession(account) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + config.web.sessionHours * 60 * 60 * 1000).toISOString();
  store.pruneWebSessions();
  store.createWebSession({ tokenHash: tokenDigest(token), principalId: account.principalId,
    csrfToken: csrf, expiresAt });
  return { token, principalId: String(account.principalId), csrf,
    expiresAt, email: account.email ?? null, displayName: account.displayName ?? null };
}

export function readSession(cookieHeader) {
  const token = String(cookieHeader || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = store.getWebSession(tokenDigest(token));
  if (!row) return null;
  return { token, principalId: String(row.principal_id), csrf: row.csrf_token,
    expiresAt: row.expires_at, email: row.email ?? null, displayName: row.display_name ?? null };
}

export function revokeSession(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return store.revokeWebSession(tokenDigest(token)) > 0;
}

export function publicSession(session) {
  return { csrf: session.csrf, user: { email: session.email,
    displayName: session.displayName, legacy: session.email === null } };
}

export function sessionCookie(token = '') {
  const secure = process.env.NODE_ENV === 'production' || config.web.origin.startsWith('https:');
  const maxAge = token ? Math.floor(config.web.sessionHours * 60 * 60) : 0;
  return `${COOKIE_NAME}=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
