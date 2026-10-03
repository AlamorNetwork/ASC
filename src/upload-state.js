/** Raw web uploads are not yet searchable documents. Expose that distinction to the UI and mother. */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';

const uploadDir = path.join(path.dirname(config.dbPath), 'web-uploads');

export function pendingUploadsFor(principalId, dossierId) {
  if (!store.getDossier(principalId, dossierId)) return [];
  let names;
  try { names = fs.readdirSync(uploadDir); } catch { return []; }
  const pending = [];
  for (const name of names.filter((x) => /^[a-f0-9-]{36}\.json$/.test(x)).slice(-500)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(uploadDir, name), 'utf8'));
      if (meta.id !== name.slice(0, -5) || Number(meta.dossierId) !== Number(dossierId) ||
          (meta.principalId && String(meta.principalId) !== String(principalId))) continue;
      const linked = meta.documentId && store.getDocument(principalId, meta.documentId);
      if (linked && Number(linked.dossier_id) === Number(dossierId)) continue;
      if (!fs.existsSync(path.join(uploadDir, `${meta.id}.bin`))) continue;
      pending.push({ id: meta.id, name: String(meta.name ?? '').slice(0, 180),
        size: Number(meta.size) || 0, createdAt: meta.createdAt });
    } catch { /* An interrupted upload cannot be treated as a source. */ }
  }
  return pending.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20);
}
