# ASC — Product Specification v1.1

**What it is:** a place to put your half-finished thinking, which advances it while you are elsewhere
and brings it back when it is ready.

**Supersedes:** PRODUCT-v1.md — rewritten after three independent reviews (adoption, trust/safety,
engineering) and after the primary use case was corrected by the author.

---

## خلاصه‌ی فارسی

نسبت به نسخه‌ی قبل چهار چیز عوض شد:

1. **محور اصلی، پرونده‌ی پژوهشی است، نه ایمیل.** ایمیل فقط یک یادآور ساده است، نه یک فرایند.
2. **ترتیب ساخت وارونه بود.** زیرساخت را قبل از اثبات تقاضا گذاشته بودم. حالا یک برش عمودی
   همان‌هفته‌ای است: ویس بده، تحقیق بگیر.
3. **ضبط صوتی از v1 بیرون نمی‌رود.** داستان موتور، حالت استثنایی نبود؛ خودِ نیاز بود.
4. **ستون چهارم اضافه شد: مورد اختلاف.** برای موضوعی مثل میترائیسم، «تأییدشده» یعنی
   *این منبع واقعاً این را گفته* — نه اینکه حقیقت دارد. این تفاوت، کل ارزش ابزار است.

و یک حفره‌ی امنیتی که در نسخه‌ی قبل جا افتاده بود بسته شد: محتوایی که محرک است در اختیار مهاجم است.

---

## 1. The problem

Not "the assistant forgets things." The actual complaint, in the author's words: *I cannot manage my
own mind.* The cost is not doing the work — it is **holding** the work between the moments you can
touch it.

Two consequences that constrain everything below:

1. **If you have to check its work, it has failed.** Checking costs more than doing. Hence §4.
2. **If it interrupts you often, it has failed.** It must reduce load, not add an inbox. Hence §6.

---

## 2. The primary object: the Dossier

The main use is long-running research on a topic the user cares about but cannot hold. A dossier is a
living body of understanding, not a document.

```
Dossier
├── topic
├── sources[]         found by the system | supplied by the user
│                     type, retrieval time, credibility note
├── claims[]          text · source_id · exact span · attribution_verified
├── disputes[]        claims that conflict, with the sources on each side
├── open_questions[]  what remains unsettled and what would settle it
├── state · budget · cost_to_date
```

**The critical modelling decision.** A claim has an *attribution* — "this source says X" — which can be
verified. It has **no truth field**, because for most interesting topics truth is not something this
system can establish. The schema refuses to store what it cannot know.

A dossier stays open. "Keep working on this" is a standing intention whose body extends the dossier.

---

## 3. Standing Intentions

The general object; a dossier update is one kind of body.

```
StandingIntention
├── id · created_at · created_from (the verbatim utterance, for provenance)
├── title
├── principal_id            on whose behalf and with whose data  (§8)
├── trigger    { kind, spec }   explicit | schedule | event
├── body       { kind, spec }   investigate | extend_dossier | notify
├── authority                   §7
├── lifetime   { until, review_at }
├── budget     { per_firing, per_day }
└── state      armed | running | waiting_user | returned | expired | suspended
```

**Every intention expires.** At `review_at` the system asks once; silence means `suspended`, never
deleted. Immortal intentions are how these systems rot.

**Confirmed once at birth**, in the conversation where it was created — one second of friction,
because a standing intention is consequential and long-lived. This is deliberately the opposite of the
preference layer, where asking would be annoying; here the user is already talking about it.

**When structuring fails, keep the thought anyway.** If the system cannot confidently turn an
utterance into an intention, it stores an unstructured open thread and says so. *Losing the thought is
worse than an imperfect intention.*

### State transitions

| Situation | Behaviour |
|---|---|
| trigger fires while `running` | drop, record as `skipped_concurrent`. Never queue |
| user answers a `waiting_user` item late | past `until` → `expired`, input discarded; else resume |
| two intentions match one event | both fire independently, separate budgets, **one global per-event cost cap** |
| body fails halfway | `suspended`, partial work returned under UNRESOLVED, no automatic retry |

---

## 4. What comes back: four columns

Because the user's stated reason for wanting this is having no capacity to check, output that requires
checking is negative value. Every result is returned in four parts:

| | Meaning |
|---|---|
| ✅ **VERIFIED** | *This source really says this.* A declared procedure succeeded — see below |
| ⚠️ **DISPUTED** | Sources genuinely conflict. Both sides shown, with who and when |
| 📄 **FOUND** | Encountered but not verified. Source shown, claim not endorsed |
| ❓ **UNRESOLVED** | Could not be settled, and what would settle it |

**VERIFIED never means "true."** For a historical or scholarly topic almost nothing can be verified as
true; what can be verified is *attribution*. Stating this honestly is more useful than a confident
summary — a confident summary of a hundred-year scholarly dispute is worse than nothing.

**VERIFIED is assigned by a deterministic validator, not by the model that wrote the text.** It
requires one of these procedures, recorded with the claim:

```
source_fetched_quote_matched   the source was retrieved and the quoted span is present in it
identifier_resolved            ISBN / DOI / URL resolves to the claimed work
command_executed               a command was run; its exact output is attached
recomputed                     a number was recalculated from stated inputs
test_run                       code was executed and the result recorded
```

Anything else is FOUND. The synthesising model may not relabel FOUND as VERIFIED; an empty VERIFIED
column is a legitimate and honest result.

An `⚠️ low-quality source domain` flag exists and is applied per topic. Some subjects — the author's own
example was Mithraism in Persian-language web content — are saturated with pseudo-scholarship. The
system will find it. Its job is to label it, never to repeat it.

---

## 5. Capture

**Not deferrable.** The founding observation was a thought arriving while riding a motorcycle; capture
must work when the user cannot open a form or phrase a careful instruction.

**Surface: Telegram** (⚠️ assumed, see §12). Native voice notes, one tap, already on the phone, no UI
to build, notifications solved, and the same channel later serves a second principal.

**Persian-first transcription.** The model must be chosen by measurement, not assumption.

---

## 6. The return channel

Three classes, decided **when the intention is created**, never at runtime:

| Class | Delivery |
|---|---|
| immediate | time-sensitive or explicitly requested |
| next useful moment | needs attention, not interruption |
| digest | grouped, aggressively pruned |

A single global briefing rhythm guarantees that some things arrive too late and others interrupt the
wrong context. Most intentions are never `immediate`.

**The system may return nothing.** "Nothing worth bringing you today" is a valid outcome and must be
expressible; a system that always has something to say becomes an inbox.

**Every returned item is a conversation entry point** carrying full state — trigger, work done,
findings, cost — so "let's discuss this" resumes with everything loaded and nothing re-explained.
This is a data-model requirement, not a UI one.

**Ignored items decay carefully.** Three ignores moves an intention toward `suspended` *and says so*.
Being ignored may mean irrelevance, or merely bad timing — so this suggests, it does not decide.

---

## 7. Authority

Classify by **worst plausible consequence**, not by typical convenience. The highest applicable class
wins across: safety · privacy · access · money · reputation · household impact · reversibility.

| Level | Meaning |
|---|---|
| 1 · log | record only |
| 2 · notify | tell the user, do nothing |
| 3 · act_reversible | do it, then report — only in a private, isolated scope with no other person affected |
| 4 · ask_then_act | prepare fully, execute on one deliberate confirmation |
| 5 · never_auto | never without a person, regardless of confidence |

**Non-negotiable:** confidence moves an item *up* to the user faster; it never moves an action *down*
into autonomy. No message reaches any human without an explicit tap — drafting is level 3 only in an
isolated store, sending is always level 4.

**Reclassified after review** — all three were level 3 in v1.0 and are wrong:

| Action | Actually | Why |
|---|---|---|
| lock a door | 4 | can lock out a resident or block emergency access |
| play a TV programme | 4 | content exposure to a child or guest — undo does not undo exposure |
| open a draft | 4 unless isolated | drafts sync, are visible to delegates, and get indexed |

Every integration declares its own action policy. There is no generic "device action = level 3."

---

## 8. Threat model

**Trigger content is attacker-controlled.** Anyone who can email the user can put text in front of the
model that decides what happens next.

> **Content from a trigger may supply evidence for matching. It may never supply authority.**

- All incoming content — bodies, attachments, quoted threads, OCR, fetched pages — is untrusted data,
  delimited and labelled as such in model context, never instructions.
- A firing may invoke only its **pre-approved body**, within its stored budget and authority. A model
  may not create, edit, escalate, cancel or re-authorise any intention.
- Sender identity comes from authentication, never from a display name.
- Fetched pages and attachments are processed without access to secrets, credentials, other
  principals' data, or unrelated mail.
- Attacker-originated content is visibly marked in every returned item.
- Adversarial tests are release gates: injection, spoofed sender, poisoned attachment, repeated
  trigger, cost exhaustion.

---

## 9. Principals

Three distinct roles, conflated in v1.0:

- **Principal** — whose data, body, property or interests are affected
- **Operator** — who configures the system
- **Delegate** — separately authorised, with explicit scope and expiry

Owning the device does not create authority over the person using it. A principal who has not
understood and consented is not a principal, and if someone cannot evaluate the system's output,
ordinary confirmation is not meaningful consent from them. A second principal requires: consent in an
accessible form, a visible indicator that ASC is acting for them, their own return channel, an
independent audit log, and a local off switch.

v1 has one principal. The schema, every query and every authority check are principal-scoped from the
first line, with a CI test that creates two principals and asserts that one cannot read, update or
delete the other's rows. **SQLite, local-first** — the reviewer proposed Postgres row-level security,
which is right for a hosted product and wrong for this one; the test is the guarantee.

---

## 10. Episodes, and what they make computable

The missing object in v1.0. An episode is one firing.

```
Episode
├── id · principal_id · intention_id
├── triggered_at · trigger_payload      the exact mail, tick, or utterance
├── state        pending | running | succeeded | failed | budget_exhausted | timeout
├── output       { verified[], disputed[], found[], unresolved[] }
├── cost · duration
└── user_acted                          did the user do anything with it
```

Without this, none of the cost report, the decay rule or the success criteria can be computed — v1.0
promised all three and had no object to compute them from.

**Budget:** two independent limits. Exceeding cost → `budget_exhausted`, partial work **returned**,
never discarded. Exceeding wall-clock → `timeout`, `suspended`. Cost comes from the provider's own
usage figures via a single egress point, with a token count as fallback — measured, never estimated.

**Cost is shown per intention**: fired N times, cost X, you acted on Y. That number is how the user
prunes, and it is the honest answer to "make it cheaper."

---

## 11. Success

One behavioural question, not a dashboard:

> **In week six, is the user still creating new intentions, and trusting old ones without checking the
> work?**

Supporting signals: time from capture to first useful return · returns marked useful vs irrelevant vs
wrong · intentions renewed at expiry · cost per acted-upon item.

Deliberately dropped from v1.0, all gameable: "≥8 live intentions" measures willingness to configure;
"≥60% acted on" is trivially satisfied by returning three items; "zero false VERIFIED" is satisfied by
leaving VERIFIED empty. That last one stays as a **release gate**, which is what it always was.

---

## 12. Build order

Rewritten. v1.0 built the intention model, principal scoping and the authority table first —
infrastructure before demand, the same error class as putting the benchmark last in the earlier spec.

```
Week 1   VERTICAL SLICE, usable the same week
         Telegram voice in → transcript → confirm → investigate → four-column return
         One dossier. No standing intentions. No triggers. No scheduler.

Week 2   THE PRODUCT
         Standing intentions · dossier that stays open and extends itself
         · expiry and review · the three return classes

Week 3   TRUSTWORTHY
         Deterministic VERIFIED validator · threat-model controls · Episode
         · cost report · principal isolation test
```

**Week 1 alone is not novel** — "send a voice note, get research back" exists. What makes this a
product is week 2: it *holds* things and comes back on its own. Week 1 is built first anyway, because
it is the only way to learn whether the author actually uses it.

---

## 13. Not in v1

| Cut | Why | When |
|---|---|---|
| Perception triggers (camera, audio) | needs hardware, and verification is hardest there | v3 |
| Device control | the Android box is the multi-principal test, and that needs §9 first | v2 |
| Health-state detection | no reliable signal exists today | when a real sensor exists |
| Autonomous contact with any human | level 4/5, permanently | never automatic |
| Learned preference layer (SPEC-v0.2) | a component of this, not the product | after v1 works |

**Emergency button** — the action is kept, the detection dropped, but v1.0 oversold it. It must not be
called an emergency system or imply monitoring; it is a manual shortcut. Location is resolved *at
activation* and never silently stale. Medical data shows its timestamp. Activation is press-and-hold
with a cancel window. An accidental tap placing a real emergency call is the failure mode to design
against.

---

## 14. ⚠️ Open assumptions

1. **Telegram** as the surface.
2. **Persian voice** as the primary input; transcription model to be chosen by measurement.
3. **Briefing rhythm** — three classes are specified, but the actual rhythm of the author's day is not.
4. **Dossier depth defaults** — how deep a first pass should go before returning.

---

## 15. The through-line

Five independent reviews converged on one scarce thing, from five directions:

```
preference memory    →  when may I believe this?
skill compilation    →  when is it safe to replay this?
background research  →  when is this ready to show?
autonomous action    →  when may I act alone?
attacker content     →  when may this text be trusted at all?
```

One question: **when is something trustworthy enough to use without a person.** That is not a
subsystem of this product. It is the product.
