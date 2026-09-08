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

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  dossier_id    INTEGER REFERENCES dossiers(id),
  role          TEXT    NOT NULL,          -- user | assistant
  text          TEXT    NOT NULL,
  cost_toman    REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_dossier ON messages(principal_id, dossier_id, id);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  dossier_id    INTEGER NOT NULL REFERENCES dossiers(id),
  filename      TEXT    NOT NULL,
  mime          TEXT,
  kind          TEXT    NOT NULL,          -- text | image | pdf
  pages         INTEGER,
  char_count    INTEGER NOT NULL DEFAULT 0,
  extraction    TEXT    NOT NULL,          -- local | model_vision | model_file
  cost_toman    REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  dossier_id    INTEGER NOT NULL,
  document_id   INTEGER NOT NULL REFERENCES documents(id),
  seq           INTEGER NOT NULL,
  page          INTEGER,
  text          TEXT    NOT NULL,
  embedding     BLOB,                       -- Float32Array; null until embedded
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_dossier ON chunks(principal_id, dossier_id, id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc     ON chunks(document_id, seq);

-- Keyword half of retrieval. Kept in step with chunks by the triggers below.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS intentions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  created_from  TEXT,                        -- the utterance that produced it
  dossier_id    INTEGER REFERENCES dossiers(id),
  trigger_kind  TEXT    NOT NULL,            -- schedule
  every_hours   INTEGER NOT NULL,
  body_kind     TEXT    NOT NULL,            -- watch_dossier
  authority     TEXT    NOT NULL DEFAULT 'notify',
  state         TEXT    NOT NULL DEFAULT 'armed',   -- armed | running | suspended | expired
  next_run_at   TEXT    NOT NULL,
  until_at      TEXT,                        -- nothing is immortal
  last_run_at   TEXT,
  runs          INTEGER NOT NULL DEFAULT 0,
  silent_runs   INTEGER NOT NULL DEFAULT 0,  -- consecutive firings with nothing new
  cost_toman    REAL    NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intentions_due ON intentions(state, next_run_at);

CREATE TABLE IF NOT EXISTS intention_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id  TEXT    NOT NULL,
  intention_id  INTEGER NOT NULL REFERENCES intentions(id),
  state         TEXT    NOT NULL,            -- succeeded | nothing_new | failed
  new_claims    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  cost_toman    REAL    NOT NULL DEFAULT 0,
  ran_at        TEXT    NOT NULL
);

-- Undirected: stored once with the lower id first, so a pair cannot be linked twice.
CREATE TABLE IF NOT EXISTS dossier_links (
  principal_id  TEXT    NOT NULL,
  a_id          INTEGER NOT NULL REFERENCES dossiers(id),
  b_id          INTEGER NOT NULL REFERENCES dossiers(id),
  note          TEXT,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (principal_id, a_id, b_id),
  CHECK (a_id < b_id)
);
`);

export const getSetting = (key) =>
  db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;

export const allSettings = () =>
  db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();

export const addMessage = (m) => db.prepare(`
  INSERT INTO messages (principal_id, dossier_id, role, text, cost_toman, created_at)
  VALUES (?,?,?,?,?,?)
`).run(m.principalId, m.dossierId ?? null, m.role, m.text, m.costToman ?? 0, new Date().toISOString()).lastInsertRowid;

// ---------------------------------------------------------- documents & chunks

export const insertDocument = (d) => db.prepare(`
  INSERT INTO documents (principal_id, dossier_id, filename, mime, kind, pages,
                         char_count, extraction, cost_toman, sha256, read_pages, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`).run(d.principalId, d.dossierId, d.filename, d.mime ?? null, d.kind, d.pages ?? null,
       d.charCount ?? 0, d.extraction, d.costToman ?? 0, d.sha256 ?? null,
       d.readPages ?? null, new Date().toISOString()).lastInsertRowid;

/** The same bytes already read into this dossier, if any. */
export const findDocumentByHash = (principalId, dossierId, sha256) =>
  db.prepare(`SELECT * FROM documents
              WHERE principal_id = ? AND dossier_id = ? AND sha256 = ?
              ORDER BY id DESC LIMIT 1`).get(principalId, dossierId, sha256);

/** Same bytes anywhere, so a file sent to a second dossier can still be recognised. */
export const findDocumentAnywhere = (principalId, sha256) =>
  db.prepare(`SELECT * FROM documents WHERE principal_id = ? AND sha256 = ?
              ORDER BY id DESC LIMIT 1`).get(principalId, sha256);

export const advanceDocument = (id, patch) => db.prepare(`
  UPDATE documents SET read_pages = ?, char_count = char_count + ?, cost_toman = cost_toman + ?
  WHERE id = ?
`).run(patch.readPages, patch.addedChars ?? 0, patch.addedCost ?? 0, id);

export const maxChunkSeq = (documentId) =>
  db.prepare(`SELECT COALESCE(MAX(seq), -1) AS m FROM chunks WHERE document_id = ?`)
    .get(documentId).m;

export const getDocument = (principalId, id) =>
  db.prepare(`SELECT * FROM documents WHERE principal_id = ? AND id = ?`).get(principalId, id);

export const dossierDocuments = (principalId, dossierId) =>
  db.prepare(`SELECT * FROM documents WHERE principal_id = ? AND dossier_id = ? ORDER BY id`)
    .all(principalId, dossierId);

const insertChunkStmt = db.prepare(`
  INSERT INTO chunks (principal_id, dossier_id, document_id, seq, page, text, embedding, created_at)
  VALUES (?,?,?,?,?,?,?,?)
`);

/** One transaction for a whole document, so a partial ingest cannot leave half a file behind. */
export function insertChunks(principalId, dossierId, documentId, rows) {
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      insertChunkStmt.run(principalId, dossierId, documentId, r.seq, r.page ?? null,
                          r.text, r.embedding ?? null, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export const setChunkEmbedding = (id, blob) =>
  db.prepare(`UPDATE chunks SET embedding = ? WHERE id = ?`).run(blob, id);

export const chunksWithoutEmbedding = (principalId, dossierId, limit = 200) =>
  db.prepare(`SELECT id, text FROM chunks
              WHERE principal_id = ? AND dossier_id = ? AND embedding IS NULL
              ORDER BY id LIMIT ?`).all(principalId, dossierId, limit);

export function dossierChunks(principalId, dossierId) {
  const ids = Array.isArray(dossierId) ? dossierId : [dossierId];
  const holes = ids.map(() => '?').join(',');
  return db.prepare(`SELECT id, dossier_id, document_id, seq, page, text, embedding FROM chunks
                     WHERE principal_id = ? AND dossier_id IN (${holes}) ORDER BY id`)
    .all(principalId, ...ids);
}

// ------------------------------------------------------- links and intentions

const orderPair = (a, b) => (a < b ? [a, b] : [b, a]);

export function linkDossiers(principalId, x, y, note = null) {
  if (x === y) throw new Error('یک پرونده را نمی‌شود به خودش وصل کرد');
  const [a, b] = orderPair(Number(x), Number(y));
  db.prepare(`INSERT OR IGNORE INTO dossier_links (principal_id, a_id, b_id, note, created_at)
              VALUES (?,?,?,?,?)`).run(principalId, a, b, note, new Date().toISOString());
}

export function unlinkDossiers(principalId, x, y) {
  const [a, b] = orderPair(Number(x), Number(y));
  return db.prepare(`DELETE FROM dossier_links WHERE principal_id = ? AND a_id = ? AND b_id = ?`)
    .run(principalId, a, b).changes;
}

/** The dossiers directly linked to this one. */
export const linkedDossiers = (principalId, id) => db.prepare(`
  SELECT d.*, l.note FROM dossier_links l
  JOIN dossiers d ON d.id = CASE WHEN l.a_id = ? THEN l.b_id ELSE l.a_id END
  WHERE l.principal_id = ? AND (l.a_id = ? OR l.b_id = ?)
  ORDER BY d.id
`).all(id, principalId, id, id);

/** This dossier plus everything linked to it — the scope a question is answered from. */
export const dossierScope = (principalId, id) =>
  [Number(id), ...linkedDossiers(principalId, id).map((d) => d.id)];

export const insertIntention = (i) => db.prepare(`
  INSERT INTO intentions (principal_id, title, created_from, dossier_id, trigger_kind,
                          every_hours, body_kind, authority, next_run_at, until_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`).run(i.principalId, i.title, i.createdFrom ?? null, i.dossierId ?? null,
       i.triggerKind ?? 'schedule', i.everyHours, i.bodyKind ?? 'watch_dossier',
       i.authority ?? 'notify', i.nextRunAt, i.untilAt ?? null,
       new Date().toISOString()).lastInsertRowid;

export const listIntentions = (principalId) =>
  db.prepare(`SELECT * FROM intentions WHERE principal_id = ? ORDER BY id DESC`).all(principalId);

export const getIntention = (principalId, id) =>
  db.prepare(`SELECT * FROM intentions WHERE principal_id = ? AND id = ?`).get(principalId, id);

/**
 * Armed, due, and not past its expiry.
 * The limit caps how much work one tick starts; the rest keep their place in the
 * queue and are picked up on the next pass, oldest first.
 */
export const dueIntentions = (nowIso, limit = 5) => db.prepare(`
  SELECT * FROM intentions
  WHERE state = 'armed' AND next_run_at <= ?
    AND (until_at IS NULL OR until_at > ?)
  ORDER BY next_run_at LIMIT ?
`).all(nowIso, nowIso, limit);

export const expiredIntentions = (nowIso) => db.prepare(`
  SELECT * FROM intentions WHERE state = 'armed' AND until_at IS NOT NULL AND until_at <= ?
`).all(nowIso);

export const setIntentionState = (principalId, id, state) =>
  db.prepare(`UPDATE intentions SET state = ? WHERE principal_id = ? AND id = ?`)
    .run(state, principalId, id);

export const recordIntentionRun = (principalId, id, patch) => {
  db.prepare(`
    UPDATE intentions
    SET state = 'armed', last_run_at = ?, next_run_at = ?, runs = runs + 1,
        silent_runs = CASE WHEN ? THEN silent_runs + 1 ELSE 0 END,
        cost_toman = cost_toman + ?
    WHERE principal_id = ? AND id = ?
  `).run(patch.ranAt, patch.nextRunAt, patch.nothingNew ? 1 : 0,
         patch.costToman ?? 0, principalId, id);

  db.prepare(`INSERT INTO intention_runs (principal_id, intention_id, state, new_claims, note, cost_toman, ran_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(principalId, id, patch.state, patch.newClaims ?? 0, patch.note ?? null,
         patch.costToman ?? 0, patch.ranAt);
};

export const intentionRuns = (principalId, id, limit = 10) =>
  db.prepare(`SELECT * FROM intention_runs WHERE principal_id = ? AND intention_id = ?
              ORDER BY id DESC LIMIT ?`).all(principalId, id, limit);

/** FTS5 keyword search, scoped to one dossier or a set of them. */
export function searchChunks(principalId, dossierId, query, limit = 20) {
  // FTS5 treats punctuation as syntax, so the query is reduced to bare terms.
  const terms = String(query).replace(/["'()*:^-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 1).slice(0, 12);
  if (!terms.length) return [];
  const match = terms.map((t) => `"${t}"`).join(' OR ');
  const ids = Array.isArray(dossierId) ? dossierId : [dossierId];
  const holes = ids.map(() => '?').join(',');
  try {
    return db.prepare(`
      SELECT c.id, c.dossier_id, c.document_id, c.seq, c.page, c.text, f.rank
      FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
      WHERE f.chunks_fts MATCH ? AND c.principal_id = ? AND c.dossier_id IN (${holes})
      ORDER BY f.rank LIMIT ?
    `).all(match, principalId, ...ids, limit);
  } catch {
    return []; // a malformed match expression should not take the answer down
  }
}

export const documentText = (principalId, documentId) =>
  db.prepare(`SELECT text FROM chunks WHERE principal_id = ? AND document_id = ? ORDER BY seq`)
    .all(principalId, documentId).map((r) => r.text).join('\n');

/** Oldest-first, so it can be handed straight to a model as conversation history. */
export const conversation = (principalId, dossierId, limit = 20) =>
  db.prepare(`SELECT role, text FROM messages
              WHERE principal_id = ? AND dossier_id IS ?
              ORDER BY id DESC LIMIT ?`)
    .all(principalId, dossierId, limit).reverse();

export const setSetting = (key, value) =>
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));

/** Adds a column only if it is missing, so an existing database upgrades in place. */
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// A document is identified by its bytes, so re-sending the same file resumes it
// rather than paying to read the same pages again.
addColumn('documents', 'sha256', 'TEXT');
addColumn('documents', 'read_pages', 'INTEGER');
db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(principal_id, dossier_id, sha256)`);

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
