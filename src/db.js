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

-- Each section is committed after its model call. A stopped analysis can resume
-- without buying the same section again; changed OCR text invalidates that section.
CREATE TABLE IF NOT EXISTS document_analysis_sections (
  principal_id TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  section_no INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, document_id, section_no)
);
CREATE TABLE IF NOT EXISTS document_analysis_synthesis (
  principal_id TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, document_id)
);
CREATE TABLE IF NOT EXISTS document_analysis_batches (
  principal_id TEXT NOT NULL,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  level INTEGER NOT NULL,
  batch_no INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, document_id, level, batch_no)
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

CREATE TABLE IF NOT EXISTS users (
  principal_id  TEXT PRIMARY KEY,            -- the Telegram chat id
  name          TEXT,
  username      TEXT,
  role          TEXT NOT NULL DEFAULT 'member',  -- owner | member
  state         TEXT NOT NULL DEFAULT 'pending', -- pending | active | blocked
  requested_at  TEXT NOT NULL,
  decided_at    TEXT
);

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

-- A deep investigation that outlives the run.
--
-- Hitting the ceiling is not the end of an investigation, it is a pause in one. Without
-- this, granting a new ceiling started the whole search again from the original question
-- and re-bought everything already paid for. What has to survive is the frontier — the
-- leads the next round would have followed — and which passages have already been
-- counted. The findings themselves already survive as claims.
CREATE TABLE IF NOT EXISTS investigations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id   TEXT    NOT NULL,
  dossier_id     INTEGER NOT NULL REFERENCES dossiers(id),
  question       TEXT    NOT NULL,
  state          TEXT    NOT NULL,          -- running | paused | done | failed
  stopped        TEXT,                      -- ceiling | stopped | exhausted | unmeasured | time
  rounds         INTEGER NOT NULL DEFAULT 0,
  leads          TEXT,                      -- JSON: where the next round would start
  seen_chunks    TEXT,                      -- JSON: passage ids already counted as new
  all_leads      TEXT,                      -- JSON: the trail, for the report
  cost_toman     REAL    NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS investigations_dossier ON investigations(principal_id, dossier_id);

-- Model providers, so adding one does not mean editing a file and restarting.
--
-- The keys live here in plain text, and they have to: they are credentials to present,
-- not passwords to compare, so there is nothing to hash. What that costs is handled
-- where it leaks — /sql refuses this table, and /backup says the file now carries keys.
CREATE TABLE IF NOT EXISTS providers (
  name       TEXT PRIMARY KEY,     -- how a model id refers to it: model@name
  base_url   TEXT NOT NULL,
  api_keys   TEXT NOT NULL,        -- JSON array; several keys means several quotas
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Predictions the system made before it knew the answer, and what happened.
--
-- The point is that a confidence figure computed from what has already been measured
-- predicts nothing and can never be wrong. A number is only worth reporting if it was
-- committed to in advance and then checked, so each one is written down here before the
-- work runs and settled afterwards.
CREATE TABLE IF NOT EXISTS predictions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT    NOT NULL,
  dossier_id   INTEGER,
  kind         TEXT    NOT NULL,      -- what was predicted, e.g. 'round_yields'
  predicted    REAL    NOT NULL,      -- 0..1, said beforehand
  actual       INTEGER,               -- 1 or 0, once known; NULL while open
  basis        TEXT,                  -- why it said that, in words
  created_at   TEXT    NOT NULL,
  settled_at   TEXT
);
CREATE INDEX IF NOT EXISTS predictions_principal ON predictions(principal_id, kind);

-- Every paid call, so "where is the money going" is a query rather than a guess.
-- Deciding what to move to a local model, or which model to drop, needs the shape of
-- the spend and not just its total.
CREATE TABLE IF NOT EXISTS spend (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  model      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,            -- chat | embed | rerank | stt
  toman      REAL    NOT NULL DEFAULT 0,
  usd        REAL    NOT NULL DEFAULT 0,
  in_tokens  INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_at ON spend(at);

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

CREATE TABLE IF NOT EXISTS research_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id),
  parent_id INTEGER REFERENCES research_nodes(id),
  title TEXT NOT NULL,
  open_question TEXT,
  assigned_role TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'pending',
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_nodes_dossier ON research_nodes(principal_id,dossier_id,parent_id,id);

CREATE TABLE IF NOT EXISTS research_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id),
  root_id INTEGER NOT NULL REFERENCES research_nodes(id),
  source_node_id INTEGER NOT NULL REFERENCES research_nodes(id),
  question_key TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  role TEXT,
  review_note TEXT,
  child_node_id INTEGER REFERENCES research_nodes(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(principal_id,root_id,question_key)
);
CREATE INDEX IF NOT EXISTS research_leads_dossier ON research_leads(principal_id,dossier_id,root_id,id);

CREATE TABLE IF NOT EXISTS document_page_reads (
  principal_id TEXT NOT NULL,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id),
  document_id INTEGER NOT NULL REFERENCES documents(id),
  page INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(principal_id,document_id,page)
);

CREATE TABLE IF NOT EXISTS source_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id),
  document_id INTEGER REFERENCES documents(id),
  url TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collected',
  created_at TEXT NOT NULL,
  UNIQUE(principal_id,dossier_id,url)
);
CREATE INDEX IF NOT EXISTS source_library_dossier ON source_library(principal_id,dossier_id,id);

CREATE TABLE IF NOT EXISTS site_crawls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  dossier_id INTEGER NOT NULL REFERENCES dossiers(id),
  seed_url TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'paused',
  pages_saved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(principal_id,dossier_id,seed_url)
);
`);

/**
 * A consistent copy of the whole database, written to `target`.
 *
 * Copying the file directly is not safe while the bot is running: with WAL, recent
 * writes live in a sidecar file and a plain copy can land mid-transaction. VACUUM INTO
 * takes a proper snapshot and compacts it on the way out.
 */
export function snapshotTo(target) {
  fs.rmSync(target, { force: true });          // VACUUM INTO refuses an existing file
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return fs.statSync(target).size;
}

/**
 * Deletes matching rows across several tables, all or nothing.
 *
 * Used only by scripts/tidy.js. The `where` clause is written by that script, never by
 * anything a user or a model supplies — this is the one place in the program that
 * deletes, and it is not going to take a clause from outside it.
 */
export function deleteWhere(tables, where) {
  let removed = 0;
  const run = db.transaction(() => {
    for (const t of tables) {
      if (!/^[a-z_]+$/.test(t)) throw new Error(`refusing an odd table name: ${t}`);
      try { removed += db.prepare(`DELETE FROM ${t} WHERE ${where}`).run().changes; }
      catch (err) {
        if (!/no such table|no such column/i.test(err.message)) throw err;
      }
    }
  });
  run();
  return removed;
}

// -------------------------------------------------------------- providers

export const listProviders = () =>
  db.prepare(`SELECT * FROM providers ORDER BY name`).all().map((r) => ({
    name: r.name,
    base: r.base_url,
    keys: (() => { try { return JSON.parse(r.api_keys); } catch { return []; } })(),
    note: r.note,
    updatedAt: r.updated_at,
  }));

export const upsertProvider = ({ name, base, keys, note = null }) => db.prepare(`
  INSERT INTO providers (name, base_url, api_keys, note, created_at, updated_at)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET
    base_url = excluded.base_url, api_keys = excluded.api_keys,
    note = excluded.note, updated_at = excluded.updated_at
`).run(name, base.replace(/\/+$/, ''), JSON.stringify(keys), note, now(), now()).changes;

export const removeProvider = (name) =>
  db.prepare(`DELETE FROM providers WHERE name = ?`).run(name).changes;

/**
 * Folds the stored providers into the ones the environment declared, database winning.
 *
 * Called at startup and again after any change, so a provider added from the bot is
 * usable on the next message rather than the next restart. config.providers is a Map
 * that everything already reads, so updating it in place needs no other call site to
 * change — and keeps config.js free of a dependency on this file, which would be a
 * cycle.
 */
export function loadProvidersIntoConfig() {
  for (const p of listProviders()) {
    if (!p.base || !p.keys.length) continue;    // half a provider is worse than none
    config.providers.set(p.name, { name: p.name, base: p.base, keys: p.keys });
  }
  return config.providers.size;
}

// ------------------------------------------------------------- predictions

export const recordPrediction = (p) => db.prepare(`
  INSERT INTO predictions (principal_id, dossier_id, kind, predicted, basis, created_at)
  VALUES (?,?,?,?,?,?)
`).run(p.principalId, p.dossierId ?? null, p.kind, p.predicted, p.basis ?? null, now()).lastInsertRowid;

/** Settled once, so a prediction cannot be quietly rescored after the fact. */
export const settlePrediction = (id, actual) => db.prepare(`
  UPDATE predictions SET actual = ?, settled_at = ? WHERE id = ? AND actual IS NULL
`).run(actual, now(), Number(id)).changes;

export const settledPredictions = (principalId, kind = null) => db.prepare(`
  SELECT * FROM predictions
  WHERE principal_id = ? AND actual IS NOT NULL ${kind ? 'AND kind = ?' : ''}
  ORDER BY id
`).all(...(kind ? [principalId, kind] : [principalId]));

// ------------------------------------------------------- deep investigations

export const startInvestigation = ({ principalId, dossierId, question, leads = [question] }) => db.prepare(`
  INSERT INTO investigations (principal_id, dossier_id, question, state, leads,
                              seen_chunks, all_leads, started_at, updated_at)
  VALUES (?,?,?,'running',?,'[]','[]',?,?)
`).run(principalId, dossierId, question, JSON.stringify(leads), now(), now()).lastInsertRowid;

export const getInvestigation = (principalId, id) =>
  db.prepare(`SELECT * FROM investigations WHERE principal_id = ? AND id = ?`)
    .get(principalId, Number(id)) ?? null;

export const latestDossierInvestigation = (principalId, dossierId) =>
  db.prepare(`SELECT * FROM investigations WHERE principal_id = ? AND dossier_id = ? ORDER BY id DESC LIMIT 1`)
    .get(principalId, Number(dossierId)) ?? null;

/** The most recent paused run for this dossier — what "carry on" should resume. */
export const resumableInvestigation = (principalId, dossierId) =>
  db.prepare(`
    SELECT * FROM investigations
    WHERE principal_id = ? AND dossier_id = ? AND state = 'paused'
    ORDER BY id DESC LIMIT 1
  `).get(principalId, Number(dossierId)) ?? null;

/** Every investigation of this principal's that is still going or waiting to carry on. */
export const openInvestigations = (principalId) => db.prepare(`
  SELECT i.*, d.topic FROM investigations i
  LEFT JOIN dossiers d ON d.id = i.dossier_id
  WHERE i.principal_id = ? AND i.state IN ('running','paused')
  ORDER BY i.updated_at DESC LIMIT 10
`).all(principalId);

export const saveInvestigation = (id, p) => db.prepare(`
  UPDATE investigations
  SET state = ?, stopped = ?, rounds = ?, leads = ?, seen_chunks = ?, all_leads = ?,
      cost_toman = ?, cost_usd = ?, updated_at = ?
  WHERE id = ?
`).run(p.state, p.stopped ?? null, p.rounds, JSON.stringify(p.leads ?? []),
       JSON.stringify(p.seenChunks ?? []), JSON.stringify(p.allLeads ?? []),
       p.costToman ?? 0, p.costUsd ?? 0, now(), Number(id));

/** Set from the bot while a run is in flight; the run notices between steps. */
/**
 * Nothing is running at startup, whatever the table says. A row still marked 'running'
 * belonged to a process that died, and leaving it there would strand its frontier where
 * no button could reach it.
 */
export function reopenInterruptedInvestigations() {
  const rows = db.prepare(`SELECT * FROM investigations WHERE state = 'running'`).all();
  if (rows.length) {
    db.prepare(`UPDATE investigations SET state = 'paused', stopped = 'interrupted',
                stop_requested = 0, updated_at = ? WHERE state = 'running'`).run(now());
  }
  // Only the ones with somewhere left to go are worth offering.
  return rows.filter((r) => { try { return JSON.parse(r.leads ?? '[]').length > 0; } catch { return false; } });
}

export const requestStop = (principalId, id) =>
  db.prepare(`UPDATE investigations SET stop_requested = 1, updated_at = ?
              WHERE principal_id = ? AND id = ? AND state = 'running'`)
    .run(now(), principalId, Number(id)).changes;

export const stopRequested = (id) =>
  !!db.prepare(`SELECT stop_requested FROM investigations WHERE id = ?`)
    .get(Number(id))?.stop_requested;

/** Reopen one interrupted run without disturbing a run owned by another process. */
export const pauseInterruptedInvestigation = (principalId, id) => db.prepare(`
  UPDATE investigations SET state = 'paused', stopped = 'interrupted',
    stop_requested = 0, updated_at = ?
  WHERE principal_id = ? AND id = ? AND state = 'running'
`).run(now(), principalId, Number(id)).changes;

export const clearStop = (id) =>
  db.prepare(`UPDATE investigations SET stop_requested = 0 WHERE id = ?`).run(Number(id));

export const recordSpendRow = (r) => db.prepare(`
  INSERT INTO spend (model, kind, toman, usd, in_tokens, out_tokens, at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
`).run(r.model, r.kind, r.toman ?? 0, r.usd ?? 0, r.inTokens ?? 0, r.outTokens ?? 0);

/** Where the money went, by model, over the last `days`. */
export const spendByModel = (days = 7) => db.prepare(`
  SELECT model, kind, count(*) AS calls, sum(toman) AS toman, sum(usd) AS usd,
         sum(in_tokens) AS in_tokens, sum(out_tokens) AS out_tokens
  FROM spend WHERE at >= datetime('now', ?)
  GROUP BY model, kind ORDER BY toman DESC
`).all(`-${Number(days) || 7} days`);

/** Drops the rows for one model. Used by the self-check to remove its own fixtures. */
export const forgetSpend = (model) =>
  db.prepare(`DELETE FROM spend WHERE model = ?`).run(model).changes;

export const spendTotal = (days = 7) => db.prepare(`
  SELECT count(*) AS calls, coalesce(sum(toman), 0) AS toman, coalesce(sum(usd), 0) AS usd
  FROM spend WHERE at >= datetime('now', ?)
`).get(`-${Number(days) || 7} days`);

export const getSetting = (key) =>
  db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null;

export const allSettings = () =>
  db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();

export const addMessage = (m) => db.prepare(`
  INSERT INTO messages (principal_id, dossier_id, role, text, cost_toman, prompt_json, created_at)
  VALUES (?,?,?,?,?,?,?)
`).run(m.principalId, m.dossierId ?? null, m.role, m.text, m.costToman ?? 0,
  m.prompt ? JSON.stringify(m.prompt) : null, new Date().toISOString()).lastInsertRowid;

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

export function createResearchNode({ principalId, dossierId, parentId = null, title,
  openQuestion = null, assignedRole = 'local', targetDocumentId = null }) {
  if (!getDossier(principalId, dossierId)) throw new Error('پرونده پیدا نشد.');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM research_nodes WHERE principal_id=? AND dossier_id=?`)
    .get(principalId, dossierId).n;
  if (count >= 100) throw new Error('سقف ۱۰۰ نیت برای این پرونده پر شده است.');
  if (parentId) {
    const parent = getResearchNode(principalId, parentId);
    if (!parent || parent.dossier_id !== dossierId) throw new Error('نیت مادر در این پرونده پیدا نشد.');
    let depth = 1, cursor = parent;
    while (cursor.parent_id && depth < 8) { depth++; cursor = getResearchNode(principalId, cursor.parent_id); }
    if (depth >= 6) throw new Error('عمق نیت‌ها حداکثر شش سطح است.');
  }
  if (targetDocumentId != null && getDocument(principalId, targetDocumentId)?.dossier_id !== dossierId)
    throw new Error('سند هدف در این پرونده پیدا نشد.');
  const now = new Date().toISOString();
  const id = Number(db.prepare(`INSERT INTO research_nodes
    (principal_id,dossier_id,parent_id,title,open_question,assigned_role,target_document_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(principalId, dossierId, parentId,
      String(title).trim().slice(0, 500), openQuestion?.slice(0, 1000) ?? null,
      assignedRole, targetDocumentId, now, now).lastInsertRowid);
  if (parentId) {
    let ancestor = getResearchNode(principalId, parentId);
    while (ancestor?.parent_id) ancestor = getResearchNode(principalId, ancestor.parent_id);
    if (ancestor?.status === 'done') db.prepare(`UPDATE research_nodes SET status='paused',updated_at=?
      WHERE principal_id=? AND id=?`).run(now, principalId, ancestor.id);
  }
  return id;
}

export const getResearchNode = (principalId, id) => db.prepare(`SELECT * FROM research_nodes
  WHERE principal_id=? AND id=?`).get(principalId, id);

export const dossierResearchNodes = (principalId, dossierId) => db.prepare(`SELECT * FROM research_nodes
  WHERE principal_id=? AND dossier_id=? ORDER BY id`).all(principalId, dossierId);

/** Lightweight public progress view: leave reports and source text in their own routes. */
export const dossierResearchProgress = (principalId, dossierId) => db.prepare(`
  SELECT id,parent_id,title,open_question,assigned_role,status,progress_stage,updated_at
  FROM research_nodes WHERE principal_id=? AND dossier_id=? ORDER BY id
`).all(principalId, dossierId);

export const researchLeadKey = (question) => String(question ?? '').normalize('NFKC').toLowerCase()
  .replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);

export function recordResearchLead(principalId, dossierId, rootId, sourceNodeId, question) {
  const root = getResearchNode(principalId, rootId);
  const source = getResearchNode(principalId, sourceNodeId);
  if (!root || root.dossier_id !== dossierId || root.parent_id ||
      !source || source.dossier_id !== dossierId) throw new Error('سرنخ خارج از نیت اصلی است.');
  const key = researchLeadKey(question);
  if (key.length < 5) return null;
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO research_leads
    (principal_id,dossier_id,root_id,source_node_id,question_key,question,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,root_id,question_key) DO NOTHING`)
    .run(principalId, dossierId, rootId, sourceNodeId, key, String(question).trim().slice(0, 500), at, at);
  return db.prepare(`SELECT * FROM research_leads WHERE principal_id=? AND root_id=? AND question_key=?`)
    .get(principalId, rootId, key);
}

export const researchLeads = (principalId, dossierId, rootId = null) => rootId
  ? db.prepare(`SELECT * FROM research_leads WHERE principal_id=? AND dossier_id=? AND root_id=? ORDER BY id`)
    .all(principalId, dossierId, rootId)
  : db.prepare(`SELECT * FROM research_leads WHERE principal_id=? AND dossier_id=? ORDER BY id`)
    .all(principalId, dossierId);

export function deferResearchLead(principalId, dossierId, id, note = '') {
  return db.prepare(`UPDATE research_leads SET status='deferred',review_note=?,updated_at=?
    WHERE principal_id=? AND dossier_id=? AND id=? AND status='pending'`)
    .run(String(note).slice(0, 350), new Date().toISOString(), principalId, dossierId, id).changes;
}

/** Create the follow-up and record the mother's approval atomically. */
export function promoteResearchLead(principalId, dossierId, id, role, note = '') {
  if (!['source-analyst', 'web-researcher'].includes(role)) throw new Error('نقش سرنخ نامعتبر است.');
  db.exec('BEGIN');
  try {
    const lead = db.prepare(`SELECT * FROM research_leads WHERE principal_id=? AND dossier_id=? AND id=?`)
      .get(principalId, dossierId, id);
    if (!lead || lead.status !== 'pending') { db.exec('ROLLBACK'); return null; }
    // A long research trail can exceed the tree's six-level display/storage limit.
    // Keep the exact origin in research_leads.source_node_id and attach later work
    // to the root, so an approved lead is not silently stranded at that depth.
    let parentId = lead.source_node_id;
    let depth = 1;
    for (let cursor = getResearchNode(principalId, parentId); cursor?.parent_id;
      cursor = getResearchNode(principalId, cursor.parent_id)) depth++;
    if (depth >= 5) parentId = lead.root_id;
    const childId = createResearchNode({ principalId, dossierId, parentId,
      title: lead.question, openQuestion: lead.question, assignedRole: role });
    setResearchNodeStage(principalId, childId, `سرنخ #${id} با تأیید عامل مادر؛ در صف بررسی`);
    db.prepare(`UPDATE research_leads SET status='approved',role=?,review_note=?,child_node_id=?,updated_at=?
      WHERE id=?`).run(role, String(note).slice(0, 350), childId, new Date().toISOString(), id);
    db.exec('COMMIT');
    return childId;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function updateResearchNode(principalId, id, { status, openQuestion, result }) {
  if (!['pending','running','paused','done','failed'].includes(status)) throw new Error('وضعیت نیت نامعتبر است.');
  return db.prepare(`UPDATE research_nodes SET status=?,open_question=?,result_json=?,updated_at=?
    WHERE principal_id=? AND id=?`).run(status, openQuestion?.slice(0, 1000) ?? null,
      result == null ? null : JSON.stringify(result), new Date().toISOString(), principalId, id).changes;
}

/** A durable, principal-scoped live checkpoint; preserves the last saved result. */
export function setResearchNodeStage(principalId, id, stage) {
  return db.prepare(`UPDATE research_nodes SET progress_stage=?,updated_at=?
    WHERE principal_id=? AND id=?`).run(String(stage ?? '').slice(0, 240),
      new Date().toISOString(), principalId, id).changes;
}

export const pauseInterruptedResearchNodes = () => db.prepare(`UPDATE research_nodes
  SET status='paused', progress_stage='اجرا قطع شد؛ آمادهٔ ادامه', updated_at=?
  WHERE status='running'`).run(new Date().toISOString()).changes;

export const dossierDocuments = (principalId, dossierId) =>
  db.prepare(`SELECT * FROM documents WHERE principal_id = ? AND dossier_id = ? ORDER BY id`)
    .all(principalId, dossierId);

/** Every stored document this principal owns, with its real dossier and analysis. */
export const sourceInventory = (principalId) => db.prepare(`
  SELECT d.id,d.dossier_id,d.filename,d.kind,d.pages,d.read_pages,d.char_count,
         o.topic AS dossier_topic,a.result_json AS analysis_json,
         (SELECT c.text FROM chunks c WHERE c.principal_id=d.principal_id
          AND c.document_id=d.id ORDER BY c.seq LIMIT 1) AS opening_text
  FROM documents d JOIN dossiers o ON o.id=d.dossier_id AND o.principal_id=d.principal_id
  LEFT JOIN document_analysis_synthesis a ON a.principal_id=d.principal_id AND a.document_id=d.id
  WHERE d.principal_id=? ORDER BY d.id DESC
`).all(principalId);

/** Remove one owner's dossier and its dependent rows as a single SQLite transaction. */
export function deleteDossier(principalId, dossierId) {
  const id = Number(dossierId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const dossier = getDossier(principalId, id);
  if (!dossier) return null;
  const documentIds = dossierDocuments(principalId, id).map((doc) => doc.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    const remove = (table, column = 'dossier_id') => db.prepare(
      `DELETE FROM ${table} WHERE principal_id=? AND ${column}=?`
    ).run(principalId, id);
    remove('research_leads');
    db.prepare(`UPDATE research_nodes SET parent_id=NULL WHERE principal_id=? AND dossier_id=?`)
      .run(principalId, id);
    remove('research_nodes');
    remove('document_page_reads');
    remove('source_library');
    remove('site_crawls');
    for (const docId of documentIds) {
      for (const table of ['document_analysis_sections', 'document_analysis_synthesis',
        'document_analysis_batches']) db.prepare(
        `DELETE FROM ${table} WHERE principal_id=? AND document_id=?`
      ).run(principalId, docId);
    }
    remove('chunks');
    remove('documents');
    remove('claims');
    remove('episodes');
    db.prepare(`DELETE FROM intention_runs WHERE principal_id=? AND intention_id IN
      (SELECT id FROM intentions WHERE principal_id=? AND dossier_id=?)`)
      .run(principalId, principalId, id);
    remove('intentions');
    remove('investigations');
    remove('messages');
    remove('predictions');
    db.prepare(`DELETE FROM dossier_links WHERE principal_id=? AND (a_id=? OR b_id=?)`)
      .run(principalId, id, id);
    remove('dossiers', 'id');
    if (dossier.capture_id) db.prepare(`DELETE FROM captures WHERE principal_id=? AND id=?
      AND NOT EXISTS (SELECT 1 FROM dossiers WHERE capture_id=?)`)
      .run(principalId, dossier.capture_id, dossier.capture_id);
    db.exec('COMMIT');
    return { dossier, documentIds };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export const documentsInOtherDossiers = (principalId, dossierId, limit = 8) => db.prepare(`
  SELECT d.id,d.filename,d.dossier_id AS dossierId,d.pages,d.read_pages AS readPages,
         o.topic AS dossierTopic
  FROM documents d JOIN dossiers o ON o.id=d.dossier_id AND o.principal_id=d.principal_id
  WHERE d.principal_id=? AND d.dossier_id<>? ORDER BY d.id DESC LIMIT ?
`).all(principalId, dossierId, limit);

export function sourceCatalogue(principalId, dossierId) {
  const docs = db.prepare(`SELECT d.*, a.result_json AS analysis_json,
    s.url AS source_url, s.summary AS source_summary,
    s.status AS source_status,
    s.metadata_json AS source_metadata_json FROM documents d
    LEFT JOIN document_analysis_synthesis a ON a.principal_id=d.principal_id AND a.document_id=d.id
    LEFT JOIN source_library s ON s.principal_id=d.principal_id AND s.dossier_id=d.dossier_id AND s.document_id=d.id
    WHERE d.principal_id=? AND d.dossier_id=? ORDER BY d.id`).all(principalId, dossierId);
  const sites = db.prepare(`SELECT * FROM source_library WHERE principal_id=? AND dossier_id=?
    AND document_id IS NULL ORDER BY id`).all(principalId, dossierId);
  return [...docs.map((d) => {
    let analysis = null;
    try { analysis = JSON.parse(d.analysis_json); } catch { /* incomplete analysis */ }
    const pageReads = documentPageReads(principalId, d.id);
    const blank = pageReads.filter((r) => r.outcome === 'blank');
    const noOutput = pageReads.filter((r) => r.outcome === 'model_no_text');
    return { id: `document-${d.id}`, type: d.source_url ? 'site' : 'document', documentId: d.id, title: d.filename,
      summary: analysis?.overview ?? d.source_summary ?? '', url: d.source_url ?? null,
      sourceStatus: d.source_status ?? null,
      extraction: d.extraction,
      provenance: d.source_metadata_json ? JSON.parse(d.source_metadata_json) : null,
      readPages: d.read_pages ?? d.pages,
      pages: d.pages, analysisStatus: analysis ? 'done' : 'pending',
      blankPageCount: blank.length, blankPages: blank.slice(0, 20).map((r) => r.page),
      noOutputPageCount: noOutput.length, noOutputPages: noOutput.slice(0, 20).map((r) => r.page),
      relations: Array.isArray(analysis?.structure) ? analysis.structure.slice(0, 8) : [],
      openQuestions: Array.isArray(analysis?.openQuestions) ? analysis.openQuestions.slice(0, 8) : [] };
  }), ...sites.map((s) => ({ id: `site-${s.id}`, type: s.source_kind, title: s.title,
    summary: s.summary ?? '', url: s.url, analysisStatus: s.status,
    sourceStatus: s.status,
    provenance: s.metadata_json ? JSON.parse(s.metadata_json) : null }))];
}

/** Bibliographic records are leads until their actual full text is read. */
export function addScholarlyLead({ principalId, dossierId, lead }) {
  if (!getDossier(principalId, dossierId)) throw new Error('پرونده پیدا نشد.');
  if (!['openalex', 'crossref', 'openlibrary', 'gutendex'].includes(lead.engine) ||
      !/^https?:\/\//i.test(lead.url)) return;
  const metadata = JSON.stringify({ catalogue: lead.engine, metadataOnly: !!lead.metadataOnly,
    ...(lead.provenance ?? {}) }).slice(0, 4000);
  db.prepare(`INSERT INTO source_library
    (principal_id,dossier_id,url,title,summary,source_kind,status,metadata_json,created_at)
    VALUES(?,?,?,?,?,'scholarly_lead','candidate',?,?)
    ON CONFLICT(principal_id,dossier_id,url) DO UPDATE SET
      metadata_json=excluded.metadata_json`)
    .run(principalId, dossierId, lead.url, String(lead.title).slice(0, 200),
      'نمایهٔ کتاب‌شناختی؛ متن منبع هنوز بررسی نشده است.', metadata, new Date().toISOString());
}

export function addSourcePage({ principalId, dossierId, url, title, summary }) {
  if (!getDossier(principalId, dossierId)) throw new Error('پرونده پیدا نشد.');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO source_library(principal_id,dossier_id,url,title,summary,source_kind,created_at)
    VALUES(?,?,?,?,?,'site',?) ON CONFLICT(principal_id,dossier_id,url)
    DO UPDATE SET title=excluded.title, summary=excluded.summary`)
    .run(principalId, dossierId, url, title, summary, now);
  return db.prepare(`SELECT * FROM source_library WHERE principal_id=? AND dossier_id=? AND url=?`)
    .get(principalId, dossierId, url);
}

export function addSourceCandidate({ principalId, dossierId, url, title, why }) {
  if (!getDossier(principalId, dossierId)) throw new Error('پرونده پیدا نشد.');
  db.prepare(`INSERT INTO source_library(principal_id,dossier_id,url,title,summary,source_kind,status,created_at)
    VALUES(?,?,?,?,?,'web_lead','candidate',?) ON CONFLICT(principal_id,dossier_id,url) DO NOTHING`)
    .run(principalId, dossierId, url, title || url, why || '', new Date().toISOString());
}

export function deferSourceCandidate(principalId, dossierId, url, reason) {
  return db.prepare(`UPDATE source_library SET status='deferred', summary=?
    WHERE principal_id=? AND dossier_id=? AND url=?
      AND source_kind='web_lead' AND status='candidate'`)
    .run(String(reason || 'خواندن منبع نتیجه نداد.').slice(0, 500), principalId, dossierId, url).changes;
}

export function saveCrawledPage({ principalId, dossierId, url, title, text, chunks,
  mime = 'text/html', extraction = 'site_crawl' }) {
  if (!getDossier(principalId, dossierId)) throw new Error('پرونده پیدا نشد.');
  title = String(title || url).slice(0, 200);
  const existing = db.prepare(`SELECT * FROM source_library WHERE principal_id=? AND dossier_id=? AND url=?`)
    .get(principalId, dossierId, url);
  if (existing?.document_id) return { documentId: existing.document_id, created: false };
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const documentId = Number(insertDocument({ principalId, dossierId, filename: title,
      mime, kind: 'text', charCount: text.length, extraction }));
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i];
      insertChunkStmt.run(principalId, dossierId, documentId, i,
        typeof part === 'object' ? part.page ?? null : null,
        typeof part === 'object' ? part.text : part, null, now);
    }
    db.prepare(`INSERT INTO source_library(principal_id,dossier_id,document_id,url,title,summary,source_kind,status,created_at)
      VALUES(?,?,?,?,?,?,'site','collected',?) ON CONFLICT(principal_id,dossier_id,url)
      DO UPDATE SET document_id=excluded.document_id,title=excluded.title,
        summary=excluded.summary,source_kind='site',status='collected'`)
      .run(principalId, dossierId, documentId, url, title, text.slice(0, 500), now);
    db.exec('COMMIT');
    return { documentId, created: true };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

/** Remove a previously stored anti-bot page and revoke claims that quoted it. */
export function invalidateCrawledPage(principalId, dossierId, url) {
  const source = db.prepare(`SELECT s.document_id,d.extraction FROM source_library s
    LEFT JOIN documents d ON d.id=s.document_id AND d.principal_id=s.principal_id
    WHERE s.principal_id=? AND s.dossier_id=? AND s.url=?`)
    .get(principalId, dossierId, url);
  const documentId = Number(source?.document_id);
  if (!Number.isSafeInteger(documentId) || source.extraction !== 'site_crawl') return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE claims SET status='unresolved',verify_method=NULL,
      verify_note='صفحهٔ ذخیره‌شده یک مانع ضدربات بود، نه متن منبع.',verify_reason='bot_challenge'
      WHERE principal_id=? AND dossier_id=? AND source_url=?`)
      .run(principalId, dossierId, url);
    db.prepare(`UPDATE research_nodes SET target_document_id=NULL
      WHERE principal_id=? AND dossier_id=? AND target_document_id=?`)
      .run(principalId, dossierId, documentId);
    db.prepare(`DELETE FROM source_library WHERE principal_id=? AND dossier_id=? AND url=?`)
      .run(principalId, dossierId, url);
    for (const table of ['document_page_reads', 'document_analysis_sections',
      'document_analysis_synthesis', 'document_analysis_batches', 'chunks'])
      db.prepare(`DELETE FROM ${table} WHERE principal_id=? AND document_id=?`)
        .run(principalId, documentId);
    db.prepare(`DELETE FROM documents WHERE principal_id=? AND id=?`).run(principalId, documentId);
    db.exec('COMMIT');
    return documentId;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function getOrCreateSiteCrawl(principalId, dossierId, seedUrl) {
  if (!getDossier(principalId, dossierId)) throw new Error('پرونده پیدا نشد.');
  db.prepare(`INSERT OR IGNORE INTO site_crawls(principal_id,dossier_id,seed_url,updated_at)
    VALUES(?,?,?,?)`).run(principalId, dossierId, seedUrl, new Date().toISOString());
  return db.prepare(`SELECT * FROM site_crawls WHERE principal_id=? AND dossier_id=? AND seed_url=?`)
    .get(principalId, dossierId, seedUrl);
}

export const dossierSiteCrawls = (principalId, dossierId) => db.prepare(`SELECT * FROM site_crawls
  WHERE principal_id=? AND dossier_id=? ORDER BY id DESC`).all(principalId, dossierId);

export function saveSiteCrawl(principalId, id, { checkpoint, state, pagesSaved }) {
  if (!['running','paused','done','failed'].includes(state)) throw new Error('وضعیت خزنده نامعتبر است.');
  return db.prepare(`UPDATE site_crawls SET checkpoint_json=?,state=?,pages_saved=?,updated_at=?
    WHERE principal_id=? AND id=?`).run(JSON.stringify(checkpoint), state, pagesSaved,
      new Date().toISOString(), principalId, id).changes;
}

export const pauseInterruptedSiteCrawls = () => db.prepare(`UPDATE site_crawls
  SET state='paused', updated_at=? WHERE state='running'`).run(new Date().toISOString()).changes;

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

/** Commit a scanned page and its cursor together; a crash cannot leave one without the other. */
export function saveScannedPage(principalId, dossierId, documentId, page, text, costToman, rows, outcome = 'vision_text') {
  const doc = getDocument(principalId, documentId);
  if (!doc || doc.dossier_id !== dossierId) throw new Error('سند برای این کاربر پیدا نشد.');
  if (page !== (doc.read_pages ?? 0) + 1) throw new Error(`صفحهٔ بعدی باید ${(doc.read_pages ?? 0) + 1} باشد.`);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) insertChunkStmt.run(principalId, dossierId, documentId,
      r.seq, page, r.text, null, now);
    db.prepare(`INSERT INTO document_page_reads
      (principal_id,dossier_id,document_id,page,outcome,char_count,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(principalId, dossierId, documentId, page, outcome, text.length, now);
    advanceDocument(documentId, { readPages: page, addedChars: text.length, addedCost: costToman });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

export const documentPageReads = (principalId, documentId) => db.prepare(`
  SELECT page,outcome,char_count FROM document_page_reads
  WHERE principal_id=? AND document_id=? ORDER BY page
`).all(principalId, documentId);

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

// ---------------------------------------------------------------------- users

export const getUser = (principalId) =>
  db.prepare(`SELECT * FROM users WHERE principal_id = ?`).get(String(principalId));

export const upsertUser = (u) => db.prepare(`
  INSERT INTO users (principal_id, name, username, role, state, requested_at, decided_at)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(principal_id) DO UPDATE SET
    name = COALESCE(excluded.name, users.name),
    username = COALESCE(excluded.username, users.username)
`).run(String(u.principalId), u.name ?? null, u.username ?? null,
       u.role ?? 'member', u.state ?? 'pending',
       new Date().toISOString(), u.decidedAt ?? null);

export const setUserState = (principalId, state, role = null) => db.prepare(`
  UPDATE users SET state = ?, decided_at = ?${role ? ', role = ?' : ''}
  WHERE principal_id = ?
`).run(...(role
  ? [state, new Date().toISOString(), role, String(principalId)]
  : [state, new Date().toISOString(), String(principalId)]));

export const listUsers = () =>
  db.prepare(`SELECT * FROM users ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, requested_at`).all();

/** What one person has spent, across every kind of work. */
export const userSpend = (principalId) => {
  const one = (sql) => db.prepare(sql).get(String(principalId))?.t ?? 0;
  return {
    captures: one(`SELECT COALESCE(SUM(cost_toman),0) t FROM captures  WHERE principal_id = ?`),
    research: one(`SELECT COALESCE(SUM(cost_toman),0) t FROM episodes  WHERE principal_id = ?`),
    documents: one(`SELECT COALESCE(SUM(cost_toman),0) t FROM documents WHERE principal_id = ?`),
    chat: one(`SELECT COALESCE(SUM(cost_toman),0) t FROM messages  WHERE principal_id = ?`),
  };
};

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
                          every_hours, body_kind, authority, next_run_at, until_at,
                          question, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`).run(i.principalId, i.title, i.createdFrom ?? null, i.dossierId ?? null,
       i.triggerKind ?? 'schedule', i.everyHours, i.bodyKind ?? 'watch_dossier',
       i.authority ?? 'notify', i.nextRunAt, i.untilAt ?? null, i.question ?? null,
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

/** Mother-agent retrieval across this principal's entire library. */
export function searchOwnerChunks(principalId, query, limit = 8) {
  const terms = String(query).replace(/["'()*:^-]/g, ' ').split(/\s+/)
    .filter((word) => word.length > 1).slice(0, 12);
  if (!terms.length) return [];
  try {
    return db.prepare(`SELECT c.id,c.dossier_id,c.document_id,c.seq,c.page,c.text,f.rank
      FROM chunks_fts f JOIN chunks c ON c.id=f.rowid
      WHERE f.chunks_fts MATCH ? AND c.principal_id=? ORDER BY f.rank LIMIT ?`)
      .all(terms.map((word) => `"${word}"`).join(' OR '), principalId, limit);
  } catch { return []; }
}

export const documentText = (principalId, documentId) =>
  db.prepare(`SELECT text FROM chunks WHERE principal_id = ? AND document_id = ? ORDER BY seq`)
    .all(principalId, documentId).map((r) => r.text).join('\n');

export const documentChunks = (principalId, documentId) =>
  db.prepare(`SELECT id, seq, page, text FROM chunks WHERE principal_id = ? AND document_id = ? ORDER BY seq`)
    .all(principalId, documentId);

export function documentPassages(principalId, documentId, query = '', limit = 6, { fallback = true } = {}) {
  const doc = getDocument(principalId, documentId);
  if (!doc) return null;
  const terms = String(query).replace(/["'()*:^-]/g, ' ').split(/\s+/)
    .filter((word) => word.length > 1).slice(0, 10);
  if (terms.length) try {
    const hits = db.prepare(`SELECT c.id,c.seq,c.page,c.text FROM chunks_fts f
      JOIN chunks c ON c.id=f.rowid WHERE f.chunks_fts MATCH ?
      AND c.principal_id=? AND c.document_id=? ORDER BY f.rank LIMIT ?`)
      .all(terms.map((word) => `"${word}"`).join(' OR '), principalId, documentId, limit);
    if (hits.length) return hits;
  } catch { /* fall back to first stored passages */ }
  if (terms.length && !fallback) return [];
  return db.prepare(`SELECT id,seq,page,text FROM chunks WHERE principal_id=? AND document_id=?
    ORDER BY seq LIMIT ?`).all(principalId, documentId, limit);
}

export const analysisSections = (principalId, documentId) =>
  db.prepare(`SELECT * FROM document_analysis_sections WHERE principal_id = ? AND document_id = ? ORDER BY section_no`)
    .all(principalId, documentId);

export const saveAnalysisSection = (principalId, documentId, n, hash, model, data) =>
  db.prepare(`INSERT INTO document_analysis_sections VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(principal_id, document_id, section_no) DO UPDATE SET
    source_hash = excluded.source_hash, model = excluded.model,
    result_json = excluded.result_json, updated_at = excluded.updated_at`)
    .run(principalId, documentId, n, hash, model, JSON.stringify(data), new Date().toISOString());

export const analysisSynthesis = (principalId, documentId) =>
  db.prepare(`SELECT * FROM document_analysis_synthesis WHERE principal_id = ? AND document_id = ?`)
    .get(principalId, documentId);

export const saveAnalysisSynthesis = (principalId, documentId, hash, model, data) =>
  db.prepare(`INSERT INTO document_analysis_synthesis VALUES (?,?,?,?,?,?)
    ON CONFLICT(principal_id, document_id) DO UPDATE SET
    source_hash = excluded.source_hash, model = excluded.model,
    result_json = excluded.result_json, updated_at = excluded.updated_at`)
    .run(principalId, documentId, hash, model, JSON.stringify(data), new Date().toISOString());

export const analysisBatch = (principalId, documentId, level, n) =>
  db.prepare(`SELECT * FROM document_analysis_batches WHERE principal_id = ? AND document_id = ? AND level = ? AND batch_no = ?`)
    .get(principalId, documentId, level, n);

export const saveAnalysisBatch = (principalId, documentId, level, n, sourceHash, data) =>
  db.prepare(`INSERT INTO document_analysis_batches VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(principal_id, document_id, level, batch_no) DO UPDATE SET
    source_hash = excluded.source_hash, result_json = excluded.result_json,
    updated_at = excluded.updated_at`)
    .run(principalId, documentId, level, n, sourceHash, JSON.stringify(data), new Date().toISOString());

/** Oldest-first, so it can be handed straight to a model as conversation history. */
export const conversation = (principalId, dossierId, limit = 20) =>
  db.prepare(`SELECT id, role, text, prompt_json FROM messages
              WHERE principal_id = ? AND dossier_id IS ?
              ORDER BY id DESC LIMIT ?`)
    .all(principalId, dossierId, limit).reverse();

export const setSetting = (key, value) =>
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));

/**
 * Removes a setting so the file config takes over again.
 *
 * Distinct from setting it empty: empty is a value, and for a model role it means
 * "no model", which is not the same as "whatever .env says".
 */
export const clearSetting = (key) =>
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key).changes;

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
addColumn('messages', 'prompt_json', 'TEXT');
addColumn('documents', 'read_pages', 'INTEGER');
addColumn('research_nodes', 'progress_stage', 'TEXT');
addColumn('research_nodes', 'target_document_id', 'INTEGER');
addColumn('source_library', 'metadata_json', 'TEXT');
// A watch can carry its own question, so "keep looking into this" is not limited to
// the dossier's headline topic.
addColumn('intentions', 'question', 'TEXT');
// Why a claim is not verified: the model's fault or ours. See verify.js.
addColumn('claims', 'verify_reason', 'TEXT');
// Old VERIFIED rows passed only the literal quote test. Under the new two-gate
// definition they must not remain in the verified column without semantic review.
export function downgradeLegacyVerifications() {
  const changed = db.prepare(`UPDATE claims SET status = 'found',
    verify_reason = 'support_unchecked',
    verify_note = COALESCE(verify_note, '') || ' · پشتیبانی معنایی طبق معیار جدید هنوز بررسی نشده'
    WHERE status = 'verified' AND verify_method IN
      ('document_quote_matched', 'source_fetched_quote_matched', 'archived_copy_quote_matched')`).run().changes;
  db.prepare(`UPDATE claims SET verify_reason = 'vision_unverified',
    verify_note = 'متن از تصویر با ویژن خوانده شد؛ تأیید مستقل از روی تصویر انجام نشده'
    WHERE verify_reason = 'support_unchecked' AND EXISTS (
      SELECT 1 FROM documents d WHERE d.principal_id = claims.principal_id
      AND d.dossier_id = claims.dossier_id AND d.filename = claims.source_title
      AND d.extraction = 'model_vision_pages'
    )`).run();
  return changed;
}
downgradeLegacyVerifications();
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
                      quote, status, verify_method, verify_note, verify_reason, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`).run(c.principalId, c.dossierId, c.episodeId ?? null, c.text, c.sourceUrl ?? null,
       c.sourceTitle ?? null, c.quote ?? null, c.status, c.verifyMethod ?? null,
       c.verifyNote ?? null, c.verifyReason ?? null, now()).lastInsertRowid;

export const updateClaimVerdict = (principalId, id, row) => db.prepare(`
  UPDATE claims SET status = ?, verify_method = ?, verify_note = ?, verify_reason = ?
  WHERE principal_id = ? AND id = ?
`).run(row.status, row.verifyMethod ?? null, row.verifyNote ?? null,
       row.verifyReason ?? null, principalId, id).changes;

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

export const dossierEpisodes = (principalId, dossierId, limit = 6) =>
  db.prepare(`SELECT * FROM episodes WHERE principal_id = ? AND dossier_id = ? ORDER BY id DESC LIMIT ?`)
    .all(principalId, Number(dossierId), limit);

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
  // The providers table holds credentials in plain text, and this prints its results
  // into a chat. Read-only is not the same as safe to read.
  if (/\bproviders\b/i.test(trimmed)) {
    throw new Error('جدول providers کلید دارد و از اینجا خوانده نمی‌شود. از /provider استفاده کن.');
  }
  const capped = /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT ${limit}`;
  return db.prepare(capped).all();
}

// Stored providers take effect at import, before anything asks for a model — so a
// provider added from the bot works on the next message, not the next restart.
loadProvidersIntoConfig();
