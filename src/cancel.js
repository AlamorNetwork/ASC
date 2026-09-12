/**
 * "Stop what you are doing."
 *
 * Deep investigation could already be stopped, because it keeps its state in a table and
 * checks a flag between rounds. Nothing else could: a research round and a multi-hop
 * search ran to completion once begun, so when one went off after the wrong subject the
 * only option was to watch it spend.
 *
 * This is deliberately in memory rather than in the database. It is about a job running
 * in this process right now, and a stop that outlived a restart would silently cancel
 * the next thing the user asked for.
 *
 * What it cannot do is interrupt a model call already in flight — that money is spent
 * the moment the request leaves. What it can do is stop the next hop, the next round,
 * the next verification, which on a multi-hop search is most of the cost.
 */

const wanted = new Map();     // principalId -> { at, label }
const running = new Map();    // principalId -> label of what is in flight

/** Marks this principal's work as no longer wanted. Returns what was running, if any. */
export function request(principalId) {
  const label = running.get(principalId) ?? null;
  wanted.set(String(principalId), { at: Date.now(), label });
  return label;
}

/**
 * Checked at every point where work would continue. Reading it does not clear it: one
 * stop should end the whole job, not just its next step.
 */
export const isWanted = (principalId) => wanted.has(String(principalId));

export const clear = (principalId) => wanted.delete(String(principalId));

/**
 * A new instruction cancels an old stop.
 *
 * This is the invariant the first version was missing, and it took the bot down: the
 * flag was only cleared by `underway`, deep runs did not use it, so one press of the
 * stop button left a flag that killed every later search at its first hop. From outside
 * the bot simply stopped doing anything.
 *
 * A stop is about the job that was running when it was pressed. The moment the user
 * asks for something else, it is spent.
 */
export function newInstruction(principalId) {
  const had = wanted.delete(String(principalId));
  if (had) console.warn(`[cancel] a stale stop for ${principalId} was cleared by a new request`);
  return had;
}

/**
 * Wraps a job so it is named while it runs and cleared afterwards, however it ends.
 * The name is what the stop button reports back.
 */
export async function underway(principalId, label, fn) {
  const id = String(principalId);
  clear(id);                          // a stop from an earlier job is not this job's
  running.set(id, label);
  try {
    return await fn();
  } finally {
    running.delete(id);
    clear(id);
  }
}

export const whatIsRunning = (principalId) => running.get(String(principalId)) ?? null;

/** Thrown when a job notices it was asked to stop, so callers can say so plainly. */
export class Stopped extends Error {
  constructor(where) {
    super('نگه داشته شد');
    this.name = 'Stopped';
    this.where = where;
  }
}

/** Call at a continuation point. Throws if the user asked to stop. */
export function checkpoint(principalId, where) {
  if (isWanted(principalId)) throw new Stopped(where);
}
