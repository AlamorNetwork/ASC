/**
 * How much of what we have is actually supported, and whether spending more would help.
 *
 * The temptation here is a confidence score computed from the verification rate, reported
 * as if it meant something. It does not: a number derived from what we already measured
 * predicts nothing, and cannot be checked against anything. It is decoration.
 *
 * So this file does two separate jobs and keeps them apart.
 *
 * `assessEvidence` describes what we hold. It is a summary, not a prediction, and it is
 * never called confidence.
 *
 * `predictYield` makes a claim about the future — that another round will turn up
 * material that survives verification — before the round runs. That is falsifiable, it
 * is recorded, and the outcome is recorded next to it. After enough rounds `calibration`
 * can say whether the predictions were worth anything, which is the only way a number
 * like this earns trust.
 *
 * And it is the question that matters for cost: not "how sure am I", but "is the next
 * round worth paying for".
 */
import * as store from './db.js';

// ------------------------------------------------------------------ evidence

/**
 * What the claims in hand amount to. A source we could not open is left out of the
 * denominator: it says nothing about the claim, only about our reach.
 */
export function assessEvidence(claims) {
  const reasonOf = (c) => c.verify_reason ?? (c.status === 'verified' ? 'matched' : null);

  const verified = claims.filter((c) => c.status === 'verified');
  const disputed = claims.filter((c) => c.status === 'disputed');
  const fabricated = claims.filter((c) => reasonOf(c) === 'fabricated_url');
  const wrongQuote = claims.filter((c) => reasonOf(c) === 'quote_absent');
  const unreachable = claims.filter((c) => reasonOf(c) === 'unreachable');
  const unsourced = claims.filter((c) => ['no_source', 'no_quote'].includes(reasonOf(c)));

  const checkable = claims.length - unreachable.length;
  const supportRate = checkable > 0 ? verified.length / checkable : null;

  const signals = [];
  if (!claims.length) signals.push('هیچ ادعایی جمع نشده');
  if (fabricated.length) signals.push(`${fabricated.length} منبع ساختگی`);
  if (wrongQuote.length) signals.push(`${wrongQuote.length} نقل‌قول در منبع نبود`);
  if (unreachable.length) signals.push(`${unreachable.length} منبع باز نشد (تقصیر ما)`);
  if (unsourced.length) signals.push(`${unsourced.length} ادعای بی‌منبع`);
  if (disputed.length) signals.push(`${disputed.length} مورد اختلاف بین منابع`);
  if (supportRate !== null && checkable >= 3) {
    signals.push(`${verified.length} از ${checkable} ادعای قابل‌بررسی تأیید شد`);
  }

  return {
    total: claims.length,
    verified: verified.length,
    disputed: disputed.length,
    fabricated: fabricated.length,
    wrongQuote: wrongQuote.length,
    unreachable: unreachable.length,
    unsourced: unsourced.length,
    checkable,
    supportRate,
    // Fabricated sources are not a weak result, they are a broken one: a model that
    // invents a citation once has shown what it does under pressure.
    trustworthy: fabricated.length === 0 && (supportRate === null || supportRate >= 0.4),
    signals,
  };
}

// ------------------------------------------------------------------ prediction

/**
 * Will another round turn up anything that survives verification?
 *
 * Estimated from this dossier's own history, because that is the only evidence there is:
 * rounds that kept finding verified material predict more; a run that has gone quiet
 * predicts nothing. With no history it returns 0.5 and says so — an honest shrug beats
 * an invented number.
 *
 * @returns {{p:number, basis:string, rounds:number}}
 */
export function predictYield(history) {
  const rounds = history.filter((r) => typeof r.fresh === 'number');
  if (rounds.length < 2) {
    return { p: 0.5, basis: 'سابقه‌ای برای حدس زدن نیست', rounds: rounds.length };
  }

  const recent = rounds.slice(-4);
  const productive = recent.filter((r) => r.fresh > 0).length;
  const base = productive / recent.length;

  // Diminishing returns are the norm: each round tends to find less than the last, so a
  // flat average from history overstates what the next one will do.
  const last = recent.at(-1);
  const trailing = last.fresh === 0 ? 0.35 : 1;
  const p = Math.max(0.02, Math.min(0.95, base * trailing));

  return {
    p,
    rounds: rounds.length,
    basis: `${productive} از ${recent.length} دور اخیر چیز تازه داشت` +
      (last.fresh === 0 ? '، ولی آخری خالی بود' : ''),
  };
}

// ------------------------------------------------------------------ the decision

/**
 * Whether the next round is worth its price.
 *
 * The shape is the expected-value-of-control idea from the cognitive-control literature,
 * kept deliberately crude: expected gain against known cost. It is a policy, not a
 * discovery, and every term in it is something we actually measure.
 *
 * @param stakes 0..1 — how much a wrong or thin answer costs the user
 */
export function worthSpending({ yieldP, evidence, spentUsd, ceilingUsd, roundCostUsd, stakes = 0.5 }) {
  if (ceilingUsd !== null && spentUsd >= ceilingUsd) {
    return { spend: false, why: 'به سقف رسیده', gain: 0 };
  }

  // How much there is left to gain: a run with nothing verified has everything to gain,
  // one already well supported has little.
  const shortfall = evidence.total === 0 ? 1
    : evidence.supportRate === null ? 0.7
      : Math.max(0, 1 - evidence.supportRate);

  const gain = yieldP * shortfall * (0.4 + 0.6 * stakes);

  // Cost as a fraction of what was agreed. Without a ceiling there is no scale to
  // compare against, so the yield estimate carries the decision alone.
  const price = ceilingUsd ? (roundCostUsd ?? 0) / ceilingUsd : 0;

  const spend = gain > price + 0.05;
  return {
    spend,
    gain: Number(gain.toFixed(3)),
    price: Number(price.toFixed(3)),
    why: spend
      ? `ارزشش را دارد — ${Math.round(yieldP * 100)}٪ شانس چیز تازه، و ${Math.round(shortfall * 100)}٪ جای بهتر شدن هست`
      : `نمی‌ارزد — ${Math.round(yieldP * 100)}٪ شانس چیز تازه در برابر هزینه‌اش`,
  };
}

// ------------------------------------------------------------------ calibration

/** Records a prediction so it can be judged later. Returns its id. */
export const predict = (principalId, dossierId, kind, p, basis) =>
  store.recordPrediction({ principalId, dossierId, kind, predicted: p, basis });

/** Records what actually happened. `hit` is what the prediction said would happen. */
export const observe = (id, hit) => store.settlePrediction(id, hit ? 1 : 0);

/**
 * Were the predictions worth anything?
 *
 * Grouped into bands, because that is what calibration means: of the times it said
 * roughly seventy percent, did roughly seventy percent happen? A band that is far off
 * says the estimate is not measuring what it claims to.
 */
export function calibration(principalId) {
  const rows = store.settledPredictions(principalId);
  const bands = [[0, 0.35], [0.35, 0.65], [0.65, 1.01]];

  const out = bands.map(([lo, hi]) => {
    const inBand = rows.filter((r) => r.predicted >= lo && r.predicted < hi);
    const hits = inBand.filter((r) => r.actual === 1).length;
    return {
      band: `${Math.round(lo * 100)}–${Math.round(hi * 100)}٪`,
      n: inBand.length,
      said: inBand.length ? inBand.reduce((s, r) => s + r.predicted, 0) / inBand.length : null,
      happened: inBand.length ? hits / inBand.length : null,
    };
  });

  // Brier score: the standard way to score probabilistic predictions. Lower is better;
  // 0.25 is what you get by always saying fifty percent.
  const brier = rows.length
    ? rows.reduce((s, r) => s + (r.predicted - r.actual) ** 2, 0) / rows.length
    : null;

  return { n: rows.length, bands: out, brier };
}
