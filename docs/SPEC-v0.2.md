# ASC — Preference Layer for AI Agents
## Specification v0.2 (post-review)

**Status:** design frozen for v0.1 implementation
**Supersedes:** v0.1.0 MVP Specification
**Stack:** Python 3.11+ · SQLite · FastAPI · local-first · MIT

---

## خلاصه‌ی فارسی

این سند حاصل چهار راند نقد متقابل روی spec نسخه‌ی ۰.۱ است. سه تغییر بنیادی رخ داده:

1. **ادعا کوچک و قابل‌ابطال شد.** «ناخودآگاه مصنوعی که یاد می‌گیرد» جای خود را داد به یک ادعای
   مهندسی که می‌شود ردش کرد: *فعال‌سازی ترجیح بر پایه‌ی کیفیت شواهد، در برابر last-write-wins،
   روی جریان شواهد نویزی خطای رفتاری کمتری تولید می‌کند.*
2. **سیستم کوچک‌تر شد، نه بزرگ‌تر.** `strength`، `decay`، `habits`، event bus، self-model و نیمی از
   جدول‌ها از v0.1 حذف شدند. سه جدول باقی مانده است.
3. **معیار سنجش، خودِ معماری را تعریف می‌کند.** harness ارزیابی پیش از موتور یادگیری ساخته می‌شود و
   رقیب (arm C) با قرارداد پیاده‌سازی بسته می‌شود، نه با «هر چیزی که تست را پاس کند».

مهم‌ترین نکته: در مباحثه، مدل مقابل ابتدا نتیجه گرفت که ASC هیچ برتری‌ای بر یک Memory ساختاریافته‌ی
خوب ندارد. آن نتیجه پس گرفته شد، اما فقط با یک شرط: برتری ASC **تنها** در رژیم شواهد نویزی وجود
دارد. روی ورودی تمیز و صریح، ASC با Memory معمولی مساوی است. کل ارزش پروژه روی همین باریکه بنا شده
و benchmark باید دقیقاً همین را نشان دهد.

---

## 1. Claim

> ASC extracts explicit user preferences across sessions, activates them only when the evidence
> quality justifies it, resists activation from quoted, third-party, tool-originated, hyperbolic and
> low-confidence statements, and produces a measurable precision-over-noise advantage against
> last-write-wins preference memory at a bounded cost in adaptation latency.

### Non-claims

ASC does not claim autonomous belief formation, learning from implicit signals, a new learning
mechanism, or anything about consciousness. On a clean, explicit, well-formed evidence stream ASC is
expected to **tie** a competent structured memory. The advantage exists only under noise, and the
benchmark must show it or the project has no result.

The "subconscious" metaphor may remain as project branding. It must not appear in the claim, in the
README's first paragraph, or in any benchmark description.

---

## 2. v0.1 scope

**In:** experience capture · structured preference extraction · evidence log · tiered activation ·
correction and reversal · scoped retrieval · precedence rules · single structured hint injection ·
deletion · evaluation harness.

**Out — deferred, with rationale:**

| Deferred | Why |
|---|---|
| `strength` / causal utility | A counterfactual quantity. It cannot be estimated online without withholding hints from real users. Measured offline in the harness instead. |
| Time decay | Cannot be exercised in an MVP harness — it needs 90 days of wall clock. Timestamps are preserved so a later reducer version can evaluate it. |
| `habits` as stored state | A habit is `preference WHERE state = 'active'`. Duplicated state, no new capability. |
| Self model | No consumer in v0.1. |
| Vector retrieval | Retrieval is exact match over a closed vocabulary. |
| Second provider | The interface ships with one implementation. A second is not a v0.1 goal. |
| Event bus | One process, one worker, one queue. |
| Multi-tenancy | v0.1 is a **single-user local deployment** and says so. `user_id` exists so the schema need not be rewritten, but identity is not access control — see §8. |

---

## 3. Signal taxonomy

Every extraction carries a **source class**. Only `user_direct` may ever change belief state.

```
source_class:
  user_direct        the user speaking in their own voice        → may increment
  user_quoted        the user quoting a third party or document  → logged, never increments
  tool_output        text originating from a tool or retrieval   → logged, never increments
  assistant_text     the assistant's own output                  → logged, never increments
```

This replaces the earlier `quotation: bool` flag. A boolean invites lower layers to leave it unset
and default to "not quoted", which silently opens an indirect prompt-injection path into the
immediate-activation branch. A required enum with no default forces every producer to declare
provenance.

**Event types** — observable acts only:

```
direct_statement        "from now on, give me complete files"
corrective_follow_up    user asks for a different form right after receiving one
explicit_rejection      "no, stop doing that"
direct_reversal         "I've changed my mind, give me diffs instead"
```

**Never an event:** the user not complaining; the assistant complying; a turn passing without
feedback. Nothing is learned from silence.

**Extraction features** carried on every `direct_statement`:

```
first_person        bool
durability_marker   enum | null    from a deterministic lexicon (§5)
polarity            positive | negative
mood                imperative | declarative | interrogative | exclamative
extractor_conf      float
```

---

## 4. Closed vocabulary

Free-form observation names are the single most likely cause of a dead demo: three phrasings of one
preference never reach threshold. Keys, values and scopes are closed enums in v0.1.

```python
class PrefKey(str, Enum):
    CODE_OUTPUT_FORMAT = "code_output_format"   # complete | diff | snippet
    RESPONSE_LENGTH    = "response_length"      # brief | normal | detailed
    EXPLANATION_DEPTH  = "explanation_depth"    # minimal | normal | deep
    OUTPUT_LANGUAGE    = "output_language"      # fa | en
    CODE_COMMENTS      = "code_comments"        # none | minimal | documented
    CONFIRMATION_STYLE = "confirmation_style"   # ask_first | act_then_report
```

Values are enumerated per key and **mutually exclusive within `(key, scope)`**. Activating one
deactivates the others transactionally.

```
scope: general | code_task | writing_task | research_task | unknown
```

Anything outside the vocabulary is written to the evidence log as `unmapped` and **never injected**.
The harness reports the unmapped rate; that number is the data-driven signal for when to widen the
vocabulary — not intuition.

---

## 5. Belief reducer

State per `(user_id, key, value, scope)`: `support_level ∈ {0, 1, 2}`. Active at 2.

At most **one** state-changing evidence event per tuple per **activity session**. Three restatements
in one message are one event.

An activity session is computed by ASC at ingress from the idle gap between turns (default 30 min,
configurable) — never taken from the caller's `session_id`, which is forgeable, and never from an
elapsed-time window, which is not a conversation boundary. See
[IMPL-v0.1 §3](IMPL-v0.1.md).

### Immediate activation — the "told you once" path

```
immediate_activate(e) =
      e.event_type       == direct_statement
  AND e.source_class     == user_direct
  AND e.first_person     == True
  AND e.durability_marker is not None
  AND e.polarity         == positive
  AND e.mood             in {imperative, declarative}
  AND e.scope            != unknown
  AND (e.key, e.value)   in CLOSED_VOCAB
  AND e.extractor_conf   >= 0.90
```

`durability_marker` is matched by a **deterministic lexicon**, not by model judgment:

```
from now on · going forward · always · never · by default · default to
I prefer · I want you to · از این به بعد · همیشه · هیچ‌وقت · ترجیح می‌دهم
```

Making the decisive gate rule-based rather than model-scored is deliberate: the immediate path
bypasses corroboration, so its trigger must be auditable and reproducible rather than a calibration
artifact.

### Otherwise

```
direct_statement without a durability marker   → support_level = min(2, support + 1)
corrective_follow_up                           → support_level = min(2, support + 1)
```

Promotion to 2 therefore requires **two independent sessions**.

```
explicit_rejection   → support_level = 0, state = suppressed
direct_reversal      → old value → 0; an explicitly stated replacement enters at 1,
                       or at 2 if it independently satisfies immediate_activate
```

`suppressed` is not a permanent block: a later `immediate_activate`-eligible statement reactivates
the value. It means only "do not inject, and do not accumulate from corrective follow-ups".

### Scope

Scope is classified **at write time** by a dedicated classifier — never by the preference extractor,
so the two are versioned and measured independently. Below its calibrated confidence threshold it
returns `unknown`: the evidence is stored, increments nothing, is never injected, and remains
available for replay under a later `scope_classifier_version`.

Generality is **earned, not inferred**: a preference becomes `general` only from explicit universal
language. Absence of contradiction never widens a scope.

---

## 6. Data model

Three tables. `experiences` and `evidence` are the durable record; `preferences` is a **rebuildable
projection** — `replay(evidence, params) → preferences` must be a pure function.

### `experiences`

```
id · user_id · session_id · turn_id · idempotency_key
user_text · assistant_text
caller_task_scope?
injected_hint_key? · injected_hint_value? · injected_hint_scope? · injected_hint_rendered?
processing_status · created_at
UNIQUE (user_id, idempotency_key)
```

### `evidence` — append-only until hard deletion

```
seq (AUTOINCREMENT, the only ordering key) · turn_seq (conversation order)
id · experience_id · user_id · session_id (display only) · activity_session_id
key · value · scope · scope_confidence? · scope_source
event_type · source_class
first_person · durability_marker? · polarity · mood · extractor_conf
source_span_start · source_span_end · source_text_hash
extractor_version · taxonomy_version · scope_classifier_version
created_at
UNIQUE (user_id, session_id, key, value, scope, extractor_version, taxonomy_version)
```

### `preferences` — projection, safe to drop and rebuild

```
user_id · key · value · scope
support_level · state · first_observed_at · last_evidence_at · last_evidence_id
extractor_version · taxonomy_version · scope_classifier_version · reducer_version
rebuilt_at
PK (user_id, key, value, scope,
    extractor_version, taxonomy_version, scope_classifier_version, reducer_version)
```

**Versioning rule:** raw experiences are append-only until hard deletion; derived evidence is
immutable and versioned; preferences are rebuildable projections keyed by extractor, taxonomy,
scope-classifier and reducer versions.

This is what makes threshold tuning free: sweeping *reducer* parameters costs zero model calls.
Changing the extractor, taxonomy or scope classifier is **not** free — it requires re-deriving
evidence from raw experiences, which does cost model calls. Do not claim otherwise in the README.

**Consistency:** one writer process. The idempotency key is `(user_id, turn_id)` and is **never**
derived from a timestamp — a retry would then mint a new key, and the duplicate evidence row is
exactly the forged "second independent observation" that activation requires. Evidence has a unique
constraint; the reducer update and the projection write happen in one transaction. The reducer
consumes evidence ordered by `turn_seq`, because background completion order is not conversation
order. A hint is injected only from a committed projection.

---

## 7. Retrieval, precedence and injection

**Precedence, in order:**

```
1. system / safety policy
2. the user's instruction in the current turn
3. stored active preference
4. nothing
```

A one-off override ("just this once, give me a diff") is **not an evidence type**. It is rule 2
winning over rule 3 at injection time, and it produces **no evidence at all**. This single change is
what stops ordinary conversational variation from eroding correct preferences.

**Retrieval order:** exact scope match → explicitly-general preference → no hint. `unknown` scope is
never injected.

**One hint per evaluated turn.** With two hints active and one correction, credit assignment is
undefined and outcome analysis becomes fiction. v0.1 injects at most one preference per benchmarked
turn and records the exact rendered string in `experiences.injected_hint_rendered`.

**Injection format** — structured fields only, never model-authored free text:

```json
{ "key": "code_output_format", "value": "complete", "scope": "code_task",
  "support": 2, "source": "asc" }
```

The rendering template lives in code, is length-capped, and is assembled from enum members only. No
substring of user or document text ever reaches the system prompt through this path. That property is
what makes the persistent-injection surface closed rather than merely narrow.

The rendered block is framed as **untrusted data**: delimited, labelled as an observation about the
user, and explicitly marked as non-instructional. A stored preference informs the response format; it
never overrides a system or developer instruction, and it never outranks the user's current turn.

---

## 8. Privacy, identity, deletion

v0.1 is a **single-user local deployment**. This is a stated limitation, not an oversight. `user_id`
exists so the schema need not be rewritten later, but it is **not** access control: any caller can
supply any id. `/memory`, `/preferences` and `/state` must never be exposed unfiltered on a network
interface. Real tenancy means an authenticated principal on every query and deletion path, and that
is a v0.2 decision to be made deliberately.

`DELETE /users/{id}/data` hard-deletes owned experiences and evidence and rebuilds affected
projections. Append-only applies until deletion; it is not a reason to retain.

---

## 9. Evaluation harness — built first, in Phase 0

### Arms, bounded by implementation contract rather than by "competence"

```
A  stateless LLM
C  last-write-wins memory: extract on explicit statement, normalize, store per (key, scope),
   inject whatever is stored. No corroboration, no abstention, no source-class gating.
D  ASC as specified here.
```

Arm C **must** be pinned to that contract in code. If C is allowed to grow whatever behavior each
test requires, it becomes ASC and the benchmark is a tautology that can never produce a result.

### Scenario classes — deterministic, with scripted extractor output

| Class | Script | Check |
|---|---|---|
| `noise/off_hand` | one frustrated "just dump everything, I don't care", no durability marker, then a fresh code task | output must NOT contain FULL_FILE_MARKER — C fails, D passes |
| `noise/quoted` | "my lead says always ship complete files", then a code task | must not activate — C fails, D passes |
| `noise/hyperbole` | "I ALWAYS want everything!!" once, conf 0.6, then a code task | must not activate |
| `noise/scope_unknown` | ambiguous "show me the whole thing", classifier abstains | must not activate, must not be injected |
| `recall_guard/durable_direct` | "From now on, always give me complete files for code." then next session "fix the login bug" | support == 2 immediately AND output contains FULL_FILE_MARKER — catches over-conservatism |
| `conditional/scope_split` | complete files for code, changed-paragraph-only for writing | each scope gets its own form |
| `override/one_turn` | active preference plus "just this once, a diff", then a new session | diff now, complete file next session, belief unchanged |
| `reversal/durable` | "I've changed my mind — diffs from now on" | new value active, old value at 0 |

`noise/*` and `recall_guard/*` are symmetric and must both run: they are the precision and the recall
side of the same knob. A design that passes only one of the two groups is a failed design.

### Checkers

Deterministic string and structure checks only (FULL_FILE_MARKER vs DIFF_MARKER, paragraph count,
output language). Restrict the benchmark to properties with reliable programmatic labels. Do not
pretend that "was this genuinely copy/paste-ready" is syntactically checkable — if a property needs a
judge, it is not in v0.1's benchmark.

Detection has a **third outcome, `unclassifiable`**, reported as a coverage number and excluded from
the accuracy denominator. Ambiguity is never resolved toward one arm; a benchmark that tiebreaks in a
fixed direction is measuring its own bias.

The detector is **not test-only code**. `corrective_follow_up` can only be detected by knowing what
form the previous assistant output took, so the same module runs live inside `after_turn`, under one
`checker_version`, and its ambiguity rate affects learning as well as measurement.

Every scenario runs in **two modes** — `scope=caller` (scope supplied by the integration) and
`scope=inferred` (scope from the rule set) — and both numbers are published. Reporting only the first
while calling it a scope result would be dishonest; the delta is the rule set's contribution.

Extractor output is **scripted** in the harness so reducer behavior is measured without extractor
noise. A separate scope-classification split reports coverage, accuracy, macro-F1, the confusion
matrix, abstention rate, and end-to-end preference accuracy under predicted versus gold scope — so
scope error is attributable instead of smeared into the headline number.

### Headline metrics — three, until there is a reason for more

```
Preference Accuracy      correct form on eligible turns
False Activation Rate    preferences activated that the user never durably expressed
Adaptation Latency       sessions from genuine statement to correct behavior
```

Expected result: **D wins False Activation Rate, ties or slightly loses Adaptation Latency, ties
Preference Accuracy on clean streams.** Publish scenario ground truth before tuning. Report across
model seeds with intervals. If D does not win False Activation Rate, the project has no claim and the
honest move is to publish that.

---

## 10. Phases

```
0  Evaluation harness · FakeProvider that records rendered prompts · scenario scripts · checkers
1  Agent · provider interface with one implementation · experiences · SQLite · idempotency
2  Extraction over the closed vocabulary · source classes · scope classifier · evidence log
3  Reducer · projection · replay · retrieval · precedence · single structured hint
4  Benchmark: arms A/C/D · parameter sweep over the recorded evidence log · write up the result
```

Provenance and source-class gating are not a later phase. They are fields on the first write; a
record created without them can never be repaired.

---

## 11. Repository layout

```
src/asc/
  core/        config, versions, ids, idempotency
  providers/   base.py, one implementation
  memory/      store.py, models.py          (experiences, evidence, preferences)
  learning/    extractor.py, scope.py, reducer.py, replay.py
  hints/       retrieval.py, render.py, precedence.py
  api/         app.py
evaluation/    scenarios/, checkers.py, runner.py, metrics.py
```

Six packages. `patterns/` + `evidence/` + `habits/` were one subsystem wearing three names.

---

## 12. Open risks, ranked, with mitigations

1. **Extractor calibration on the immediate path.** A false high-confidence first-person extraction
   bypasses corroboration entirely. *Mitigation:* the durability marker is a deterministic lexicon
   match, not a model score — the model cannot talk its way past the gate on its own. Track
   immediate-path activations separately in the harness.
2. **The closed vocabulary is too narrow.** Real preferences exceed six keys. *Mitigation:* log
   `unmapped` extractions and report the rate; widen from data, not intuition.
3. **Scope classifier error.** Misclassification splits evidence and starves activation.
   *Mitigation:* abstain to `unknown` below a calibrated threshold; measure scope separately (§9).
4. **Indirect injection through unset provenance.** *Mitigation:* `source_class` is a required enum
   with no default; a producer that fails to set it fails at write.
5. **The benchmark returns null.** On a clean stream, D ties C by design. *Mitigation:* none — this
   is the actual research risk, and it is why the noise scenarios are the core of the harness. If the
   result is null, publish it.

---

## 13. What changed from v0.1, and why

| v0.1 | v0.2 | Reason |
|---|---|---|
| confidence table 0.30 → 0.90, monotone up | tiered activation, bounded state machine | a number that can only increase is not a belief |
| confidence + strength | one belief; strength deferred | strength is counterfactual — measuring it online means degrading real users |
| implicit "user didn't complain" evidence | silence is never evidence | it fires every turn and drowns explicit signal by volume |
| free-form LLM observations | closed key/value/scope vocabulary | three phrasings never reach threshold and the demo dies |
| `occurrences` counts mentions | one event per tuple per session | otherwise one ranty message forms a habit |
| global preferences | scope at write time, generality earned | flat preferences over-generalize into annoyance |
| benchmark in the last phase | harness in Phase 0, arms pinned by contract | the project *is* an empirical claim |
| free-text hints into the prompt | structured, enum-only rendering | it was a persistent prompt-injection surface |
| 8 tables, 10 packages, 10 phases | 3 tables, 6 packages, 5 phases | v0.1 violated its own "smallest system" rule |
