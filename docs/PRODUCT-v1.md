# ASC — Product Specification v1

**What it is:** a personal assistant that holds your open intentions, advances them while you are
not there, and brings them back when they are ready.

**Status:** draft for review — this is the document we argue over next.
**Supersedes as the primary document:** SPEC-v0.2 / IMPL-v0.1 (those become the *learning layer*
inside this, not the product).

---

## خلاصه‌ی فارسی

این سند، پروژه را از «لایه‌ی حافظه» به **محصول** تبدیل می‌کند. سه چیز از دو روز قبل نگه داشته شد و
بقیه کنار رفت:

- **شیء اصلی عوض شد.** نه «ترجیح»، نه «مهارت» — بلکه **نیت ماندگار**: محرک، بدن، ذی‌نفع، اختیار، عمر.
  هر پنج مثالی که گفتی یک نمونه از همین شیء واحدند.
- **اصل تکرارشونده‌ی هر چهار مباحثه ماند:** جایی که نمی‌توانی تأیید کنی، خودسرانه عمل نکن. اینجا به
  یک نردبان اختیار تبدیل شده که قابل پیاده‌سازی است.
- **معماری هزینه یک الگو دارد، نه پنج تا:** گیتِ ارزان و قطعی، بعد مدل گران — همه‌جا.

آنچه عمداً از v1 بیرون است: دوربین، تشخیص وضعیت سلامتی، هر عملی که با یک انسان تماس بگیرد، و کنترل
خودکار دستگاه. دلیلش در §9 آمده و هیچ‌کدام «برای همیشه» نیست.

**جاهایی که فرض گذاشته‌ام با ⚠️ علامت خورده‌اند** — چون نمونه‌ی واقعی نیت‌های امروزت را نداشتم.

---

## 1. The problem this solves

Not "the assistant forgets my preferences." The actual complaint:

> I cannot hold my open threads. The cost is not doing the work — it is keeping the work alive in my
> head between the moments I can touch it.

So the product is not a task runner and not a workflow builder. Those require you to hold the thread
long enough to specify it. This holds the thread for you, moves it while you are elsewhere, and
returns it in a state where a few minutes of your attention is enough.

**Two hard constraints that follow from that:**

1. If you have to check its work, it has failed. Checking costs more than doing. Everything it
   returns must separate what it verified from what it merely found. See §6.
2. If it interrupts you often, it has failed. It is supposed to reduce load, not add a notification
   stream. See §5.

---

## 2. The core object: Standing Intention

Every one of the motivating examples is one object with different field values.

```
StandingIntention
├── id, created_at, created_from      the utterance that produced it (verbatim, for provenance)
├── title                             human-readable, shown in the list
├── principal_id                      on whose behalf, with whose data
├── owner_id                          who created it and may edit it
├── trigger      { kind, spec }       what wakes it
├── body         { kind, spec }       what it does when woken
├── authority                         see the ladder in §4
├── lifetime     { until, review_at } when it expires, when to re-confirm it is still wanted
├── budget       { per_firing, per_day }
└── state                             armed | running | waiting_user | returned | expired | suspended
```

### Mapping the motivating examples

| Example | trigger | body | principal | authority |
|---|---|---|---|---|
| "tell me if an email from X arrives" | event | notify | user | notify |
| "go research this idea" | explicit | investigate | user | notify (then discuss) |
| mother's Android box | schedule / her request | device action | **mother** | act_reversible |
| the cat / an intruder | perception | graded | user | ladder — **v3, not now** |
| feeling unwell → emergency | signal + condition | call | user | ask_then_act — **§9** |

The point of the table is that adding a sixth example must not require a sixth subsystem.

---

## 3. How an intention is born

From ordinary conversation, not a form. You say *"if an email comes from Reza about the contract,
tell me"* — the system extracts a structured intention and **confirms it once, immediately, in the
conversation**:

```
→ Standing intention: notify you when mail from reza@… mentions "contract"
  Active until: 30 days (then I'll ask if you still want it)
  I will only notify. I will not reply to anything.
  [keep]  [change]  [cancel]
```

**Why confirm at birth, when we fought so hard to avoid asking about preferences:** a standing
intention is consequential and long-lived, and you are *already talking about it* — the confirmation
costs one second and buys correctness for a month. A silently created standing intention is the worst
object in this system: it fires for weeks and you never know why.

This is the corroboration discipline from the earlier design, applied where it is cheap instead of
where it is annoying.

**Every intention has an expiry.** Nothing is immortal. At `review_at` the system asks once whether
it is still wanted; no answer means it goes `suspended`, not deleted. Standing intentions that
outlive their purpose are how these systems rot.

---

## 4. The authority ladder

The single most important table in this document. Authority is a property of the *action class*, not
of how confident the system is.

| Level | Meaning | Examples |
|---|---|---|
| **1 · log** | record only, never surface | routine sensor events, everything below threshold |
| **2 · notify** | tell the user, do nothing | "mail from Reza arrived", "research finished" |
| **3 · act_reversible** | do it, then report | lock a door, turn on a light, put on a TV programme, open a draft, run a read-only query |
| **4 · ask_then_act** | prepare fully, execute on one tap | call emergency services, send any message to any human, spend money, change a setting |
| **5 · never_auto** | never without a person in the loop, regardless of confidence | confronting a human being, anything irreversible with a stranger |

**Rules that are not negotiable in v1:**

- Nothing at level 4 or 5 executes on a confidence score. Confidence moves an item *up* the ladder to
  the user faster; it never moves an action *down* into autonomy.
- **No message reaches another human without an explicit tap.** Drafting is level 3; sending is
  level 4. This includes email, chat, calendar invites, and phone calls.
- An action is level 3 only if undoing it costs seconds and embarrasses nobody.

**Why "scare off the intruder" is level 5.** Not caution for its own sake: person recognition at 95%
accuracy means one confrontation in twenty is with the cleaner, a neighbour with a key, or your
mother. The ladder gets you almost the same security outcome with no catastrophic branch:

```
motion → person? → known face? → no
   ↓
lock, record, lights on          (level 3, immediate, reversible)
   ↓
5-second clip to you             (level 2, seconds later)
   ↓
you tap                          (level 4 → siren / call)
```

Same principle as everywhere else in this project: **where you cannot verify, do not act alone.**

---

## 5. The return channel

Where products like this die. Rules:

- **One surface, not notifications.** Returned items accumulate in a briefing. The default is batched
  delivery at natural moments (⚠️ assumption: morning, and end of working day — tune to your day).
- **Interrupt is a separate class** and must be justified per intention at creation time, not decided
  at runtime. Most intentions are never interrupt-class.
- **Every returned item is a conversation entry point, not a dead card.** It carries the full state —
  what triggered it, what was done, what was found, what it cost — so "let's discuss this" continues
  with everything loaded. This is the *"like a human assistant sharing data with me"* requirement, and
  it is a data-model requirement, not a UI one.
- **Items you ignore decay.** An item returned three times and never opened moves its intention toward
  `suspended` and says so. The system must notice it is being ignored.

---

## 6. Verified vs. found

The user's stated reason for wanting this is not having capacity to check. So output that requires
checking is negative value. Every `investigate` result is returned in three parts:

```
VERIFIED     claims the system checked itself, with how it checked
             (source fetched and quoted, identifier resolved, number recomputed, test run)
FOUND        claims it encountered but did not verify, each with its source
UNRESOLVED   what it could not settle, and what it would need
```

A research result with an empty VERIFIED section is a legitimate outcome and must be shown as such,
not padded. **The system never presents FOUND material in the voice of VERIFIED material.**

This is the concrete lesson from this project's own history: a search model attributed three different
systems to one identifier, and only opening the identifier revealed the truth. That failure mode is
the default, not the exception.

---

## 7. Cost architecture

One pattern, applied everywhere:

```
cheap deterministic gate  →  small model  →  large model
                              (only on gate hit)   (only on small-model uncertainty)
```

| Surface | Gate | Escalation |
|---|---|---|
| mail | sender/keyword filter | small model classifies relevance; large model only to draft or summarise |
| research | budget per intention | small model gathers and filters; large model synthesises once |
| device | direct API call | no model at all — most device actions need no inference |
| perception (v3) | motion → on-device person detection | vision model only on unrecognised person |

**Every intention carries a budget** (per firing, per day) and a global daily cap exists. The system
**shows cost per intention**: fired N times this month, cost X, you acted on Y of them. That number is
how you prune, and it is a user-facing feature, not telemetry.

Honest tension to state plainly: background work spends tokens while you sleep, so **raw spend goes
up**. What falls is cost *per outcome*, because a thread advances without your attention. If an
intention's cost per acted-upon item is bad, the system should say so and suggest killing it.

---

## 8. Principals — built in from day one

v1 has one human user. The schema, every query, and every authority check are **principal-scoped from
the first line of code**, and there is a test proving one principal cannot read or trigger another's
intentions.

This is not speculative generality. Your own second example is your mother on the Android box, and
retrofitting a principal boundary after the data exists means rewriting every query and every
deletion path. v2 is where this gets exercised for real — which is exactly why v2 is the Android box
and not the cameras.

Each principal has: their own intentions, their own data scope, their own authority ceiling (your
mother's ceiling can be lower than yours), and their own return channel.

---

## 9. Explicitly not in v1

| Cut | Why | When |
|---|---|---|
| Perception triggers (camera, audio) | needs hardware, and it is where verification is hardest — the last thing to build, not the first | v3 |
| Health-state detection | there is no reliable signal today; a false positive here is severe | when there is a real sensor |
| **Emergency calling** — the *action* | keep the preparedness, drop the detection: one tap, with location, medical info and next-of-kin pre-loaded, gives ~90% of the value at zero detection risk | prepared button in v1, detection later |
| Any autonomous contact with a human | level 4/5, permanently | never becomes automatic |
| Device control | v2, starting with the Android box | v2 |
| Learned preference layer (SPEC-v0.2) | it is a *component* of this, not the product; it tunes how results are presented once there are results to present | after v1 works |

---

## 10. Build order

```
0  Intention model + store + principal scoping + the authority table as code     3 d
1  Creation from conversation + the one-tap confirmation + expiry/review          3 d
2  Event triggers: mail first (⚠️ assumption — see §12), then calendar/repo       3 d
3  investigate body: budgeted background run + VERIFIED/FOUND/UNRESOLVED          4 d
4  Return channel: briefing, batching, resume-into-conversation with state        3 d
5  Cost accounting and the per-intention cost report                              2 d
                                                                        total  ~18 d
```

**First usable moment is after step 4** — at which point you can say "tell me when X happens" and "go
look into Y," and both come back to you correctly. That is the whole loop, and everything later is
widening it.

---

## 11. What success looks like

Product criteria, not benchmark criteria:

- After two weeks of your own daily use, you have **≥ 8 live intentions** you did not have to be
  reminded to create.
- **≥ 60%** of returned items are acted on rather than dismissed. Below that, it is a notification
  stream and the return channel is wrong.
- **Zero** items returned as VERIFIED that turn out to be wrong. This one is a release blocker, not a
  target.
- The real test, which is subjective and still the point: **you stop holding these threads in your
  head.** Proxy signal — you stop re-asking for things you already delegated.

---

## 12. ⚠️ Assumptions to settle before building

These are where I guessed, and they are the first things to argue about:

1. **The seed intentions.** I used your examples, not your real week. Two or three actual standing
   intentions from your current life determine the trigger types in step 2 and could reorder it.
2. **Mail is the first trigger surface.** Assumed because your own example was mail. If most of your
   real threads are code, or messages, or documents, that changes step 2 entirely.
3. **Briefing rhythm** (morning + end of day). Should follow your actual day.
4. **Where you live while using it** — terminal, phone, web page? Capture friction decides whether
   this survives contact with a motorcycle. My assumption is that capture must eventually be voice,
   but v1 can be text.
5. **Whether "discuss it with me" means the existing chat or a dedicated surface.** I assumed the
   existing chat, with state attached.

---

## 13. The through-line, stated once

Four independent design debates converged on the same scarce thing, from four directions:

```
preference memory   →  when may I believe this?
skill compilation   →  when is it safe to replay this?
background thinking →  when is this ready to show?
autonomous action   →  when may I act alone?
```

They are one question: **when is something trustworthy enough to use without a person.** That is not a
subsystem of this product. It is the product. Everything else — the memory, the compilation, the
triggers — is plumbing around that judgment.
