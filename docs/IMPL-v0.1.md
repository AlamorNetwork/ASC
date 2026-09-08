# ASC — Implementation Decision Record, v0.1

Companion to [SPEC-v0.2.md](SPEC-v0.2.md). The spec says *what* and *why*; this says *how*, and
records the decisions that were argued out before any code was written. Where this document and the
spec disagree, this one wins and the spec is patched.

Each entry: **Decision** · **Cost** · **Risk**.

---

## خلاصه‌ی فارسی

این سند خروجی سه راند بازبینی پیاده‌سازی است (دو مدل از دو خانواده). ده تصمیم اولیه اصلاح شد و سه
مسئله‌ی جدید پیدا شد که هیچ‌کدام از دو طرف قبلاً ندیده بودند. مهم‌ترین‌هایشان:

- استخراج **بعد از** پاسخ اجرا می‌شود، نه قبلش. یادگیری ذاتاً گذشته‌نگر است و کاربر نباید منتظر بماند.
- `session_id` کلاینت **قابل اعتماد نیست**. مرز session سمت سرور و بر اساس *فاصله‌ی بی‌فعالیتی*
  محاسبه می‌شود، نه بازه‌ی زمانی سپری‌شده.
- ترتیب پردازش پس‌زمینه با ترتیب مکالمه یکی نیست. بدون `turn_seq` نتیجه‌ی یادگیری از یک مکالمه‌ی
  یکسان می‌تواند هر بار فرق کند.
- کلید idempotency نباید از timestamp ساخته شود، وگرنه هر retry یک رکورد تکراری جدید می‌سازد — و
  رکورد تکراری دقیقاً همان «شاهد مستقل دوم» را جعل می‌کند که فعال‌سازی به آن نیاز دارد.
- تشخیص‌دهنده‌ی فرمت خروجی (فایل کامل در برابر diff) فقط ابزار تست نیست؛ یک **جزء production** است،
  چون بدون آن `corrective_follow_up` اصلاً قابل تشخیص نیست.

---

## 1. Integration shape

**Decision.** ASC is a **library**, not a service, not a proxy. Two calls, and the host owns the
provider call in between:

```python
from asc import ASC

asc = ASC(db_path="asc.db", config="asc.toml")

def chat(messages, user_id, turn_id, task_scope=None):
    hint = asc.before_turn(user_id=user_id, turn_id=turn_id, task_scope=task_scope,
                           user_text=messages[-1]["content"])      # DB read only, < 5 ms
    if hint:
        messages.insert(-1, {"role": "system", "content": hint.rendered})

    reply = provider.generate(messages)                            # host owns this

    asc.after_turn(turn_id=turn_id, assistant_text=reply.text,
                   assistant_status="complete")                    # returns immediately
    return reply
```

`before_turn` performs **no model call**. `after_turn` enqueues and returns; extraction and the
reducer run on the background writer. Learning is retrospective — this turn's extraction is only
needed before the *next* turn, and a preference stated in the current turn is already obeyed by
precedence rule 2, because the model can see the user's own words.

`flush()` blocks until every submitted `turn_seq` has been processed. The harness calls it between
scenario steps; nothing on the user path calls it.

**Cost.** Preferences are visible from the next turn, not the current one. A rapid second turn may
read a projection that is a second or two stale.
**Risk.** A developer who forgets `flush()` in a test writes a race, not a bug report. Documented at
the top of the testing guide.

**Rejected alternatives.** *Sidecar:* a network hop per turn for a local-first tool. *Proxy that
impersonates the model API:* breaks streaming and tool calls, hides the injection point, and cannot
receive `task_scope`. *Synchronous extraction inside the turn:* puts a model call in front of every
user-visible response, on a system whose entire premise is being invisible.

---

## 2. Turn lifecycle, ordering, idempotency

**Decision — `turn_id` and `turn_seq`.** The host supplies a stable `turn_id` (or ASC generates one
once at the boundary and persists it *before* dispatch). ASC assigns a monotonic `turn_seq` at
ingress, before any background work.

**Decision — idempotency.** The key is `(user_id, turn_id)`. It is **never** derived from a
timestamp: a retry would produce a different key, and a duplicated evidence row is precisely the
forged "second independent observation" that activation requires.

**Decision — ordering.** Background completion order is not conversation order. Evidence carries
`turn_seq`, and the reducer consumes a stream ordered by `turn_seq` only — never by completion time,
never by wall clock. `flush()` waits for all *submitted* sequences, not merely an empty queue.

**Decision — crash recovery.** `after_turn` is an outbox job with retry state. A crash after the
provider succeeded but before ASC committed is recovered by replaying the same `turn_id`; a crash
after commit is a no-op.

**Decision — streaming.** The host adapter buffers chunks against `turn_id` and calls `after_turn`
only on normal completion. Cancelled, truncated or failed streams are recorded with
`assistant_status = incomplete` and **produce no evidence** — in particular they can never produce a
`corrective_follow_up`, because the user never saw the output being "corrected".

**Cost.** One extra column and a strict ordering discipline in the writer.
**Risk.** If a host integration forgets to report stream failure, an incomplete answer looks
complete. Mitigation: `assistant_status` has no default.

---

## 3. Activity sessions — the rule that replaces "session"

The spec's "one state-changing event per tuple per session" is load-bearing, and neither a
client-supplied id nor an elapsed-time window implements it correctly.

- A **client id** is forgeable: a UI that mints a UUID per turn silently converts ASC into
  last-write-wins — the exact arm it must beat.
- An **elapsed window** is not a conversation boundary: in one continuous three-hour session, the
  same preference stated at 10:00 and 10:40 would count as two independent observations.

**Decision.** ASC computes an **activity session** at ingress from the *idle gap* between turns:

```
new activity_session  ⇔  received_at(turn) - received_at(previous turn of this user) > idle_gap
idle_gap default: 30 minutes, configurable, recorded in the run manifest
```

`received_at` is stamped by ASC at ingress from the server clock; client timestamps and extraction
completion times are never used. Deduplication key:
`(user_id, activity_session_id, key, value, scope)`. The caller's `session_id` is retained as
display metadata and has no effect on belief.

**Cost.** A genuine re-statement inside one conversation is suppressed — deliberately.
**Risk.** Two concurrent conversations by one user collapse into one activity stream unless the host
supplies a partition key. v0.1 is single-user local, so this is documented, not solved.

---

## 4. Extraction pipeline

**Decision — recall-only pre-filter.** The extractor runs only on turns where a cheap regex
pre-filter fires: any durability-lexicon hit, any format-request cue, any correction cue. It may
over-fire freely; precision is the extractor's job. Expected hit rate 10–20% of turns, so a 5–10×
reduction in model calls. It is **not** calibrated; its *miss rate* is measured against the labeled
fixture set, and that number is reported.

**Decision — extractor.** A cheap model on a separate provider instance from the host's. Output is
parsed with Pydantic against the signal schema. Any validation failure, refusal, or timeout →
recorded as `unmapped`, `extractor_conf = 0.0`, **increments nothing**. No retries.

**Decision — Persian normalization.** A deterministic `normalize(text)` runs before lexicon matching
only; the extractor always receives raw text. It applies NFC, `ي → ی`, `ك → ک`, ZWNJ to canonical
spacing, tatweel removal, and Arabic-Indic digit folding.

**Decision — the gate is regex-only.** `first_person` on the immediate-activation path is decided by
a bilingual pattern list (`من`, first-person enclitic `ـم`, `ترجیح می‌دهم`, `I`, `my`, `me`) within a
bounded window of the durability marker. If the regex cannot confirm it, the statement **does not**
immediate-activate — it lands at `support_level = 1` and needs a second occurrence. A model judgment
never participates in the gate; that is the whole point of the gate.

Interrogative override, adopted: a durability marker inside a question (`آیا`, `؟`, `?`) forces
`mood = interrogative` and fails the gate. This catches the most dangerous false-positive class —
"should I always ...?" read as "always ...".

**Cost.** Some true Persian first-person statements take one extra session to activate.
**Risk.** The pre-filter is now the silent-failure surface: a novel phrasing that never fires is
never extracted. Measured, not assumed.

---

## 5. Scope resolution in v0.1

There is no labeled data and no users on day one, so there is nothing to calibrate a learned
classifier against. The proposal to "abstain always until calibrated" was rejected: `unknown` is
never injected, every headline scenario is scoped, so that fallback would ship a system that
activates nothing and a demo that shows nothing.

**Decision.** No learned classifier in v0.1. Resolution order:

```
caller-supplied task_scope  →  deterministic bilingual keyword rules  →  unknown
```

The rule set is versioned, small, and tested independently with positive, negative and adversarial
fixtures. `"fix the login bug"` is an **explicit required fixture**: if the rules cannot resolve it
to `code_task`, the rules are wrong, not the scenario.

**Decision — the harness runs every scenario in two modes** and reports both:

```
scope=caller     the integration path — tests plumbing, reducer, injection
scope=inferred   the rules path       — tests scope resolution as well
```

Reporting only the first while calling it a scope result would be dishonest; the two numbers are
published side by side, and their delta is the rule set's contribution.

The 200 hand-labeled bilingual examples (≈50 per scope, including `unknown`) are the **test set for
the rules**, not training data. A learned classifier is a v0.2 decision, made with real data.

---

## 6. The form classifier is a production component

Detecting `corrective_follow_up` — "the user asked for a different form right after receiving one" —
requires knowing what form the assistant actually produced. That makes the FULL_FILE / DIFF detector
**live code inside `after_turn`**, not test scaffolding. Its ambiguity rate now affects *learning*,
not just measurement.

**Decision — detection rules** (identical code in production and in the harness, imported from one
module, versioned as `checker_version`):

```
DIFF        a fence whose header contains diff|patch, OR content containing @@,
            OR ≥30% of fence lines beginning with + - or space
FULL_FILE   a fence that matches none of the DIFF conditions, ≥5 lines,
            and containing no elision marker (... or …)
otherwise   unclassifiable
```

**Decision — `unclassifiable` is a first-class outcome, never a tiebreak.** In production it emits no
form evidence, so no `corrective_follow_up` can fire from that turn. In the benchmark it is excluded
from the accuracy denominator and reported as a coverage number. A benchmark that resolves its own
ambiguity in a fixed direction (the earlier proposal was "tiebreak toward DIFF") is measuring its own
bias.

**Cost.** Real recall gap: prose-only compliance is invisible to the detector.
**Risk.** If the production path and the benchmark path ever diverge, production recall and reported
recall silently disagree. Mitigation: one module, one version number, asserted equal in a test.

---

## 7. Persistence and concurrency

**Decision.**

```
SQLite, WAL, busy_timeout = 5000, foreign_keys = ON, explicit transactions
one engine/connection per thread — a connection is never shared across threads
one dedicated writer thread; readers use their own connections
check_same_thread=False is not a concurrency design and is not relied upon
```

Experience, evidence and projection for a turn commit in **one** transaction in the writer. An async
host calls ASC through a bounded executor and never blocks the event loop.

**Decision — single process, enforced.** v0.1 refuses to start a second writer: an advisory lock row
plus a PID/startup check, failing loudly. Multi-process means PostgreSQL or an external writer
service, and that is a v0.2 decision.

**Cost.** Throughput ceiling far above what a single user can generate.
**Risk.** A reader may observe the projection from before the current turn's commit. That is the
documented semantics — learning is visible from the next turn.

---

## 8. Failure isolation

A memory layer must never be able to break the host's chat.

**Decision — fail open, at the adapter boundary.**

| Failure | Behavior |
|---|---|
| `before_turn` raises (locked DB, corrupt row) | return no hint, log with correlation id, chat proceeds |
| extractor timeout / refusal / bad JSON | evidence recorded as `unmapped`, increments nothing |
| writer transaction fails | rollback, `processing_status = failed` + failure class, never marked complete |
| queue full | drop the ASC work, record `dropped`, never block the host |
| disk full / DB unavailable | ASC disables itself for the process, emits one loud log line, chat continues |

`flush()` may raise — it is for tests and tooling. Nothing on the user path may raise out of ASC.

---

## 9. Replay purity

**Decision.** `evidence` carries `seq INTEGER PRIMARY KEY AUTOINCREMENT`. **All** ordering — across
sessions, within a session, and tie-breaking — uses `seq` alone. `created_at` is informational.
Truncating timestamps to stabilise ties (the earlier proposal) couples replay to the clock and was
rejected.

A replay is bit-identical iff: evidence rows unchanged · same params · ordering by `seq` · no clock
read and no model call inside the reducer. The reducer is integer state transitions, so there is no
floating-point accumulation to worry about — and this is a second reason time decay stays out of
v0.1: it would put `now()` inside the reducer and destroy purity.

Live re-derivation while new evidence arrives is **not** pure. Re-derivation snapshots
`max(seq)` at start, processes `seq <= max`, then makes a final pass over what arrived meanwhile.

---

## 10. Configuration and reproducibility

**Decision.** Every load-bearing parameter lives in one version-controlled manifest `asc.toml`:
reducer/taxonomy/extractor/scope-rule/checker/normalization versions, the durability lexicon, keyword
rules, thresholds, `idle_gap`, and prompt templates.

A benchmark run copies the manifest into a run record and stores its content hash, the repo commit,
the dependency lock hash, the model identifier, and the fixture-set hash. Results reference the run
id. **Publication is refused when the working tree or config is dirty.** Production evidence retains
the parameter versions that produced it.

**Why:** a published score that a local lexicon edit can silently change is not a result.

---

## 11. Observability

**Decision.** `GET /debug/turn/{turn_id}` (development only, gated) returns the whole causal chain:

```
experience → extraction (all fields) → immediate_activate check with the list of FAILING GATES
→ reducer decision and reason → projection before/after → the rendered hint and its precedence
```

The `failing_gates` list is the single most useful field: "why did this not activate" is the question
a developer actually asks. Raw text exposure is off by default.

---

## 12. Testing below the benchmark

**Decision.**

- **Fixtures** are versioned records: input text · normalized text · expected extractor signal ·
  expected gate outcome · expected reducer state · expected hint.
- **Reducer tests** consume *evidence* fixtures, not text, and assert every transition: duplicate,
  contradiction, rejection, reversal, scope mismatch, activity-session boundary, replay.
- **Golden replay tests** pair an append-only evidence log with a **hand-authored** expected
  projection and activation trace. The expected output is never generated by the reducer or the
  harness — otherwise the suite certifies whatever the implementation happens to do.
- **Mutation tests** deliberately break ordering, thresholds, gate logic and dedup, and *require*
  the suite to fail. A suite that still passes is not testing what it claims.
- **A separate real-extractor suite** runs the same scenarios through the live extractor. The delta
  against the scripted numbers *is* the extractor's error contribution, and it is reported, not
  hidden.

**Why the harness alone is not enough:** with scripted extractor output, the reducer is proven correct
in a world where extraction is perfect. Extractor recall failure is structurally invisible to it.

---

## 13. Build order and effort

```
0  Harness · schema · pre-filter · scope rule set · checker module · fixtures      3 d
1  Library core · turn_id/turn_seq · writer thread · flush/drain · fail-open       2 d
2  Extractor · normalization · regex gates · pre-filter wiring                     2 d
3  Reducer · replay · retrieval · precedence · rendering                           2 d
4  Form classifier wired into after_turn (production path)                         1 d
5  Benchmark, dual-mode scope reporting, parameter sweep, write-up                 3 d
                                                                          total  ~13 d
```

**Top schedule risk — the deterministic scope rule set.** Once the activation gate is regex-only and
its failure degrades gracefully to `support_level = 1`, the Persian extractor is no longer the
critical path. The scope rules are: they gate every headline scenario, they must work in two
languages, and `"fix the login bug"` must resolve to `code_task` without a file path, a language name
or a code fence in sight. Build them on day 0 against the 200-example set, before anything else.

**Second risk — `unclassifiable` rate.** If the form detector cannot classify a large fraction of real
assistant output, both the benchmark's sensitivity and production's corrective-follow-up recall fall
at the same time, from the same cause.

---

## 14. Spec amendments produced by this review

| SPEC-v0.2 section | Amendment |
|---|---|
| §5 "per session" | means **activity session** (idle-gap derived, server-side), never the client's `session_id` |
| §6 `evidence` | gains `seq` (ordering) and `turn_seq` (conversation order); idempotency key is `(user_id, turn_id)`, never timestamp-derived |
| §7 injection | the rendered hint is framed as untrusted data with delimiters and an explicit non-instruction preamble |
| §9 checkers | third outcome `unclassifiable`; the detector is a production component shared with the harness, not test-only code |
| §9 harness | every scenario runs in both `scope=caller` and `scope=inferred` mode, both reported |
