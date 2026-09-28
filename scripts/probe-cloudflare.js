#!/usr/bin/env node
// Distinguish a Cloudflare token permission failure from a Certbot plugin failure.
// Creates one uniquely named TXT record and deletes it immediately. Never prints keys.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const zoneName = process.argv[2] || 'alamornetwork.ir';
const credentials = process.env.CF_CREDENTIALS || '/etc/letsencrypt/cloudflare.ini';
const raw = readFileSync(credentials, 'utf8');
const token = raw.match(/^dns_cloudflare_api_token\s*=\s*(.+)$/m)?.[1]?.trim();
if (!token) throw new Error(`No dns_cloudflare_api_token in ${credentials}`);

const base = 'https://api.cloudflare.com/client/v4';
function errorsOf(json) {
  return (json?.errors || []).map(({ code, message, error_chain }) => ({
    code, message,
    details: (error_chain || []).map(({ code, message }) => ({ code, message })),
  }));
}
async function request(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await response.json();
  if (!response.ok || json.success !== true) {
    const error = new Error(`${method} ${path.split('?')[0]}: HTTP ${response.status}; ${JSON.stringify(errorsOf(json))}`);
    error.status = response.status;
    throw error;
  }
  return json.result;
}

const verified = await request('/user/tokens/verify');
console.log(`token: ${verified.status}`);
const zones = await request(`/zones?name=${encodeURIComponent(zoneName)}&per_page=1`);
const zone = zones.find((item) => item.name === zoneName);
if (!zone) throw new Error(`Token cannot see zone ${zoneName}`);
console.log(`zone: ${zone.name} visible`);

const name = `_asc-certbot-probe-${randomBytes(5).toString('hex')}.${zoneName}`;
let record;
try {
  record = await request(`/zones/${zone.id}/dns_records`, 'POST', {
    type: 'TXT', name, content: 'asc-certbot-permission-probe', ttl: 120,
  });
  console.log('DNS write: allowed (temporary TXT created)');
} catch (error) {
  console.error(`DNS write: denied — ${error.message}`);
  console.error('Check Zone > DNS > Edit and the selected zone in the token settings.');
  process.exitCode = 1;
} finally {
  if (record?.id) {
    try {
      await request(`/zones/${zone.id}/dns_records/${record.id}`, 'DELETE');
      console.log('cleanup: temporary TXT deleted');
      console.log('If Certbot still gets 10000, its Cloudflare client or extra credentials are the problem.');
    } catch (error) {
      console.error(`cleanup failed for ${name} (record ${record.id}): ${error.message}`);
      process.exitCode = 1;
    }
  }
}
