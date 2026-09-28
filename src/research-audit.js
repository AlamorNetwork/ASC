/** Bounded, inspectable hypotheses and provenance questions from one research round.
 * These are leads, not verdicts. A model cannot make a person biased or a theory true
 * by writing those words into JSON.
 */
import { normalise } from './verify.js';

const idOf = (value) => typeof value === 'number' && Number.isInteger(value) ? value
  : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : -1;

function evidence(items, sources) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 4).flatMap((item) => {
    const source = sources[idOf(item?.source_id)];
    const quote = String(item?.quote ?? '').trim().slice(0, 1200);
    if (!source || quote.length < 12 || !source.text.includes(quote)) return [];
    return [{ sourceId: source.id, url: source.url, title: source.title,
      quote, match: 'exact_excerpt', meaning: 'not_yet_judged' }];
  });
}

export function buildResearchAudit(data, sources) {
  const hypotheses = (Array.isArray(data?.hypotheses) ? data.hypotheses : [])
    .slice(0, 3).flatMap((raw) => {
      const text = String(raw?.text ?? '').trim().slice(0, 500);
      if (!text) return [];
      const supporting = evidence(raw.supporting, sources);
      const challenging = evidence(raw.challenging, sources);
      if (!supporting.length && !challenging.length) return [];
      return [{ text, supporting, challenging,
        missingEvidence: String(raw?.missing_evidence ?? '').trim().slice(0, 400),
        state: 'hypothesis_not_verified' }];
    });

  const peopleToCheck = (Array.isArray(data?.people_to_check) ? data.people_to_check : [])
    .slice(0, 3).flatMap((raw) => {
      const source = sources[idOf(raw?.source_id)];
      const name = String(raw?.name ?? '').trim().slice(0, 100);
      if (!source || name.length < 3 || !normalise(source.text).includes(normalise(name))) return [];
      return [{ name, seenAt: source.url,
        why: String(raw?.why ?? '').trim().slice(0, 250),
        query: String(raw?.search_query ?? `${name} source criticism historiography`)
          .trim().slice(0, 180),
        state: 'identity_and_perspective_unchecked' }];
    });

  return { hypotheses, peopleToCheck };
}

/** Only search-worthy questions enter a later round; theories are never promoted here. */
export function auditLeads(audit) {
  return [...new Set([
    ...(audit?.hypotheses ?? []).map((h) => h.missingEvidence || h.text),
    ...(audit?.peopleToCheck ?? []).map((p) => p.query),
  ].filter(Boolean))].slice(0, 4);
}
