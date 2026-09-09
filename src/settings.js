/**
 * Runtime settings that outrank the file config, so models and budget can be changed
 * from inside the bot without editing .env or restarting.
 * Precedence: database setting -> .env -> built-in default.
 */
import { config } from './config.js';
import * as store from './db.js';

const ROLES = ['capture', 'transcribe', 'research', 'structure', 'embed', 'rerank'];

export const modelFor = (role) =>
  store.getSetting(`model.${role}`) ?? config.models[role];

export const setModel = (role, id) => {
  if (!ROLES.includes(role)) throw new Error(`نقش نامعتبر: ${role} (${ROLES.join(' | ')})`);
  store.setSetting(`model.${role}`, id);
};

export const allModels = () => Object.fromEntries(ROLES.map((r) => [r, modelFor(r)]));

/** Ceiling in US dollars of provider spend per research round. null means no ceiling. */
export function budget() {
  const raw = store.getSetting('budget.per_research');
  if (raw === null) return config.budget.perResearch;
  if (raw === 'none') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : config.budget.perResearch;
}

export const setBudget = (usdOrNull) =>
  store.setSetting('budget.per_research', usdOrNull === null ? 'none' : String(usdOrNull));

// Keyed by principal. A shared key would mean one person's open dossier became
// everyone's, which on a multi-user bot is a privacy failure, not a UX quirk.
export const activeDossier = (principalId) => {
  const v = store.getSetting(`active_dossier.${principalId}`);
  return v ? Number(v) : null;
};

export const setActiveDossier = (principalId, id) =>
  store.setSetting(`active_dossier.${principalId}`, id ?? '');

/** Average cost of recent research rounds, for warning before spending again. */
export function recentAverageCost(principalId) {
  const rows = store.recentEpisodes(principalId, 5).filter((e) => e.cost_usd > 0);
  if (!rows.length) return null;
  return rows.reduce((s, e) => s + e.cost_usd, 0) / rows.length;
}
