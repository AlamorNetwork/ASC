/**
 * Standing intentions: work that happens without you asking again.
 *
 * The whole risk of this feature is becoming a notification stream. Two rules keep it
 * honest:
 *   - Silence is a valid outcome. A run that finds nothing new says nothing at all.
 *   - Nothing is immortal. Every intention has an expiry, and one that has gone quiet
 *     for several runs in a row asks whether it is still wanted.
 */
import { runResearch } from './research.js';
import { normalise } from './verify.js';
import { budget } from './settings.js';
import * as store from './db.js';

const HOUR = 3600 * 1000;
export const QUIET_RUNS_BEFORE_ASKING = 4;

export const nextRun = (everyHours, from = Date.now()) =>
  new Date(from + everyHours * HOUR).toISOString();

/**
 * Create a watch over a dossier.
 * @param everyHours how often to look
 * @param days how long the intention lives before it must be renewed
 */
export function createWatch({ principalId, dossierId, title, createdFrom, everyHours = 24, days = 60 }) {
  const d = store.getDossier(principalId, dossierId);
  if (!d) throw new Error('پرونده پیدا نشد');
  return store.insertIntention({
    principalId,
    title: title || `پیگیری «${d.topic}»`,
    createdFrom,
    dossierId,
    triggerKind: 'schedule',
    everyHours,
    bodyKind: 'watch_dossier',
    authority: 'notify',
    nextRunAt: nextRun(everyHours),
    untilAt: new Date(Date.now() + days * 24 * HOUR).toISOString(),
  });
}

/**
 * Is this claim already known to the dossier?
 * A claim from a source we have already cited, or whose wording we already hold, is
 * not news — reporting it again is how a watch turns into noise.
 */
export function isNew(claim, existing) {
  const url = claim.sourceUrl ?? claim.source_url;
  if (url && existing.some((e) => e.source_url === url)) return false;

  const text = normalise(claim.text);
  if (!text) return false;
  const words = new Set(text.split(' ').filter((w) => w.length > 3));
  if (!words.size) return false;

  for (const e of existing) {
    const prior = new Set(normalise(e.text).split(' ').filter((w) => w.length > 3));
    if (!prior.size) continue;
    let shared = 0;
    for (const w of words) if (prior.has(w)) shared++;
    if (shared / words.size >= 0.6) return false; // substantially the same claim
  }
  return true;
}

/**
 * Run one intention. Returns what should be said, or null when there is nothing worth
 * saying — in which case the caller stays silent.
 */
export async function fire(intention) {
  const principalId = intention.principal_id;
  const ranAt = new Date().toISOString();
  const dossier = store.getDossier(principalId, intention.dossier_id);

  if (!dossier) {
    store.setIntentionState(principalId, intention.id, 'suspended');
    return { report: `⏸ پیگیری #${intention.id} متوقف شد — پرونده‌اش دیگر نیست.` };
  }

  const before = store.dossierClaims(principalId, dossier.id);
  const openQuestions = before.filter((c) => c.status === 'disputed').map((c) => c.text);

  const question = [
    `درباره‌ی «${dossier.topic}» چه چیز تازه‌ای هست که قبلاً نمی‌دانستیم؟`,
    openQuestions.length ? `سؤال‌های باز: ${openQuestions.slice(0, 3).join(' · ')}` : null,
    'روی منابع تازه و یافته‌های جدید تمرکز کن، نه تکرار آنچه شناخته‌شده است.',
  ].filter(Boolean).join('\n');

  let costToman = 0;
  try {
    const result = await runResearch({
      principalId, dossierId: dossier.id, topic: dossier.topic, question,
    });
    costToman = result.costToman ?? 0;

    const fresh = [...(result.output.verified ?? []), ...(result.output.found ?? [])]
      .filter((c) => isNew(c, before));

    store.recordIntentionRun(principalId, intention.id, {
      ranAt,
      nextRunAt: nextRun(intention.every_hours),
      state: fresh.length ? 'succeeded' : 'nothing_new',
      newClaims: fresh.length,
      nothingNew: fresh.length === 0,
      costToman,
    });

    if (!fresh.length) return null; // silence is a valid outcome

    return { report: null, dossier, fresh, costToman, intention };
  } catch (err) {
    store.recordIntentionRun(principalId, intention.id, {
      ranAt,
      nextRunAt: nextRun(intention.every_hours),
      state: 'failed', nothingNew: true, note: String(err.message ?? err), costToman,
    });
    return { report: `⚠️ پیگیری «${intention.title}» شکست خورد: ${err.message ?? err}` };
  }
}

/** Intentions past their expiry, moved out of the way rather than deleted. */
export function retireExpired(nowIso = new Date().toISOString()) {
  const rows = store.expiredIntentions(nowIso);
  for (const r of rows) store.setIntentionState(r.principal_id, r.id, 'expired');
  return rows;
}

/** True when a watch has found nothing for long enough that it should be questioned. */
export const hasGoneQuiet = (intention) =>
  intention.silent_runs >= QUIET_RUNS_BEFORE_ASKING;

export const overBudget = (costToman) => {
  const b = budget();
  return b !== null && costToman / 310000 > b;
};
