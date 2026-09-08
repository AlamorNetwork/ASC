import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);
db.exec(`PRAGMA busy_timeout = 5000`);

db.exec(`
CREATE TABLE IF NOT EXISTS captures (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  source        TEXT    NOT NULL,            -- voice | text
  telegram_msg  INTEGER,
  transcript    TEXT    NOT NULL,            -- always stored, even when unclear
  kind          TEXT    NOT NULL,
  title         TEXT,
  request       TEXT,
  topic         TEXT,
  durability    TEXT,
  confidence    REAL,
  raw_json      TEXT    NOT NULL,
  cost_toman    REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS dossiers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  capture_id    INTEGER REFERENCES captures(id),
  topic         TEXT    NOT NULL,
  question      TEXT,
  state         TEXT    NOT NULL,            -- open | running | returned | failed
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS episodes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  dossier_id    INTEGER REFERENCES dossiers(id),
  kind          TEXT    NOT NULL,            -- research
  state         TEXT    NOT NULL,            -- running | succeeded | failed | budget_exhausted
  output_json   TEXT,
  cost_toman    REAL    NOT NULL DEFAULT 0,
  cost_usd      REAL    NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  user_acted    INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT    NOT NULL,
  finished_at   TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  dossier_id    INTEGER NOT NULL REFERENCES dossiers(id),
  episode_id    INTEGER REFERENCES episodes(id),
  text          TEXT    NOT NULL,
  source_url    TEXT,
  source_title  TEXT,
  quote         TEXT,                        -- the span that should appear at source_url
  status        TEXT    NOT NULL,            -- verified | found | disputed | unresolved
  verify_method TEXT,                        -- source_fetched_quote_matched | identifier_resolved | null
  verify_note   TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claims_dossier  ON claims(principal_id, dossier_id);
CREATE INDEX IF NOT EXISTS idx_episodes_dossier ON episodes(principal_id, dossier_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const getSetting = (key) =>
  db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;

export const setSetting = (key, value) =>
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));

const now = () => new Date().toISOString();

export const insertCapture = (c) => db.prepare(`
  INSERT INTO captures (principal_id, source, telegram_msg, transcript, kind, title,
                        request, topic, durability, confidence, raw_json, cost_toman, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(c.principalId, c.source, c.telegramMsg ?? null, c.transcript, c.kind, c.title ?? null,
       c.request ?? null, c.topic ?? null, c.durability ?? null, c.confidence ?? null,
       JSON.stringify(c.raw), c.costToman ?? 0, now()).lastInsertRowid;

export const getCapture = (principalId, id) =>
  db.prepare(`SELECT * FROM captures WHERE principal_id = ? AND id = ?`).get(principalId, id);

export const insertDossier = (d) => db.prepare(`
  INSERT INTO dossiers (principal_id, capture_id, topic, question, state, created_at)
  VALUES (?,?,?,?,?,?)
`).run(d.principalId, d.captureId ?? null, d.topic, d.question ?? null, d.state ?? 'open', now()).lastInsertRowid;

export const setDossierState = (principalId, id, state) =>
  db.prepare(`UPDATE dossiers SET state = ? WHERE principal_id = ? AND id = ?`).run(state, principalId, id);

export const startEpisode = (e) => db.prepare(`
  INSERT INTO episodes (principal_id, dossier_id, kind, state, started_at)
  VALUES (?,?,?,'running',?)
`).run(e.principalId, e.dossierId, e.kind, now()).lastInsertRowid;

export const finishEpisode = (principalId, id, patch) => db.prepare(`
  UPDATE episodes SET state = ?, output_json = ?, cost_toman = ?, cost_usd = ?,
                      duration_ms = ?, finished_at = ?
  WHERE principal_id = ? AND id = ?
`).run(patch.state, JSON.stringify(patch.output ?? null), patch.costToman ?? 0,
       patch.costUsd ?? 0, patch.durationMs ?? null, now(), principalId, id);

export const markActed = (principalId, episodeId) =>
  db.prepare(`UPDATE episodes SET user_acted = 1 WHERE principal_id = ? AND id = ?`).run(principalId, episodeId);

export const insertClaim = (c) => db.prepare(`
  INSERT INTO claims (principal_id, dossier_id, episode_id, text, source_url, source_title,
                      quote, status, verify_method, verify_note, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`).run(c.principalId, c.dossierId, c.episodeId ?? null, c.text, c.sourceUrl ?? null,
       c.sourceTitle ?? null, c.quote ?? null, c.status, c.verifyMethod ?? null,
       c.verifyNote ?? null, now()).lastInsertRowid;

export const dossierClaims = (principalId, dossierId) =>
  db.prepare(`SELECT * FROM claims WHERE principal_id = ? AND dossier_id = ? ORDER BY id`)
    .all(principalId, dossierId);

export const costReport = (principalId) => db.prepare(`
  SELECT d.id, d.topic,
         COUNT(e.id)                AS episodes,
         COALESCE(SUM(e.cost_toman),0) AS toman,
         COALESCE(SUM(e.user_acted),0) AS acted
  FROM dossiers d LEFT JOIN episodes e ON e.dossier_id = d.id AND e.principal_id = d.principal_id
  WHERE d.principal_id = ?
  GROUP BY d.id ORDER BY toman DESC
`).all(principalId);

export const recentCaptures = (principalId, limit = 10) =>
  db.prepare(`SELECT * FROM captures WHERE principal_id = ? ORDER BY id DESC LIMIT ?`)
    .all(principalId, limit);

// ---------------------------------------------------------------- inspection

export const stats = (principalId) => ({
  captures: db.prepare(`SELECT COUNT(*) n FROM captures WHERE principal_id = ?`).get(principalId).n,
  dossiers: db.prepare(`SELECT COUNT(*) n FROM dossiers WHERE principal_id = ?`).get(principalId).n,
  episodes: db.prepare(`SELECT COUNT(*) n FROM episodes WHERE principal_id = ?`).get(principalId).n,
  claims:   db.prepare(`SELECT COUNT(*) n FROM claims   WHERE principal_id = ?`).get(principalId).n,
  verified: db.prepare(`SELECT COUNT(*) n FROM claims WHERE principal_id = ? AND status = 'verified'`).get(principalId).n,
  spent:    db.prepare(`SELECT COALESCE(SUM(cost_toman),0) t FROM episodes WHERE principal_id = ?`).get(principalId).t
          + db.prepare(`SELECT COALESCE(SUM(cost_toman),0) t FROM captures WHERE principal_id = ?`).get(principalId).t,
});

export const getDossier = (principalId, id) =>
  db.prepare(`SELECT * FROM dossiers WHERE principal_id = ? AND id = ?`).get(principalId, id);

export const listDossiers = (principalId, limit = 10) =>
  db.prepare(`SELECT * FROM dossiers WHERE principal_id = ? ORDER BY id DESC LIMIT ?`).all(principalId, limit);

export const recentEpisodes = (principalId, limit = 10) =>
  db.prepare(`SELECT * FROM episodes WHERE principal_id = ? ORDER BY id DESC LIMIT ?`).all(principalId, limit);

/**
 * Read-only query surface for inspecting data during testing.
 * Only the owner can reach this, and only a single SELECT is allowed through.
 */
export function readOnlyQuery(sql, limit = 20) {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  if (!/^select\b/i.test(trimmed)) throw new Error('فقط SELECT مجاز است');
  if (/;/.test(trimmed)) throw new Error('فقط یک دستور در هر بار');
  if (/\b(attach|pragma|insert|update|delete|drop|alter|create|replace)\b/i.test(trimmed)) {
    throw new Error('این دستور خواندنی نیست');
  }
  const capped = /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT ${limit}`;
  return db.prepare(capped).all();
}
