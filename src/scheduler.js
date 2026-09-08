/**
 * Fires due intentions in the background.
 *
 * Sequential on purpose: two research rounds at once would double the spend spike and
 * make the cost report harder to read. Nothing here is time-critical.
 */
import * as store from './db.js';
import { fire, retireExpired, hasGoneQuiet } from './intentions.js';

const TICK_MS = 5 * 60 * 1000;

export function startScheduler({ onReport, onExpired, onQuiet }) {
  let running = false;

  async function tick() {
    if (running) return; // a long research round must not overlap the next tick
    running = true;
    try {
      for (const expired of retireExpired()) {
        await onExpired?.(expired).catch?.(() => {});
      }

      const due = store.dueIntentions(new Date().toISOString());
      for (const intention of due) {
        store.setIntentionState(intention.principal_id, intention.id, 'running');
        try {
          const result = await fire(intention);
          if (result) await onReport?.(result);

          const after = store.getIntention(intention.principal_id, intention.id);
          if (after && hasGoneQuiet(after)) await onQuiet?.(after);
        } catch (err) {
          console.error('[scheduler] intention failed:', intention.id, err.message);
          store.setIntentionState(intention.principal_id, intention.id, 'armed');
        }
      }
    } catch (err) {
      console.error('[scheduler] tick failed:', err);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
  setTimeout(() => { tick().catch(() => {}); }, 20_000).unref?.(); // one pass shortly after boot
  return () => clearInterval(timer);
}
