# ASC

Put a half-finished thought somewhere. It gets advanced while you are elsewhere, and comes back
when it is ready.

A Telegram bot: send a voice note or a message, and it is captured, classified, and — if you ask
for it — researched in the background. Results come back in four columns, so you can see at a
glance what was actually checked and what was merely found.

Persian-first. Zero npm dependencies (Node 22+ built-ins only: `fetch`, `node:sqlite`).

---

## The part that matters: four columns

Research output is never a confident paragraph. It is split by **how much the system actually
knows**:

| | |
|---|---|
| ✅ **تأییدشده** | The source was fetched and the quoted span was found in it. Assigned by code, not by a model |
| ⚠️ **مورد اختلاف** | Reputable sources genuinely disagree, and both sides are shown |
| 📄 **پیدا شده** | Encountered but not verified — with the reason (paraphrased quote, source did not load) |
| ❓ **حل‌نشده** | What could not be settled, and what would settle it |

VERIFIED means *this source really says this*, never *this is true*. For a contested historical
subject almost nothing can be verified as true, and an honest empty ✅ column beats a confident
summary. `src/verify.js` fetches each cited page and string-matches the quote; the model that wrote
the text cannot assign or upgrade the label.

---

## Run it

```bash
cp .env.example .env      # then fill in Bot_Token and the model provider
node scripts/check.js     # 9 checks, no Telegram needed
node index.js
```

`node scripts/check.js --audio` additionally runs a real voice file through the capture path.

### Configuration

| Variable | |
|---|---|
| `Bot_Token` | from [@BotFather](https://t.me/BotFather) |
| `OWNER_CHAT_ID` | leave blank on first run; the first chat to message the bot claims it and the id is printed |
| `ROUTER_KEY` / `ROUTER_BASE_URL` | any OpenAI-compatible endpoint |

**Deployment note.** A local 9router at `127.0.0.1:20128` is not reachable from a server, so a
deployed instance needs its own provider base URL and key. Nothing else changes — the code only
ever speaks OpenAI-compatible HTTP.

---

## Layout

```
index.js            entry point
src/config.js       env + provider credentials
src/telegram.js     long polling, voice download, message rendering
src/capture.js      voice or text -> one structured capture object, in a single model call
src/verify.js       fetch the source, match the quote. The only thing that may say "verified"
src/research.js     the research episode: gather -> verify -> assemble four columns
src/db.js           sqlite schema and queries, principal-scoped
src/app.js          the loop that wires it together
scripts/check.js    self-check
scripts/try-research.js   run one research episode from the terminal
```

Data lives in `data/asc.db` (SQLite, WAL). Nothing leaves the machine except model and search calls.

---

## Design notes

- **Nothing is lost.** Every capture is stored, including when the model cannot tell what you
  wanted. `kind: "unclear"` with the transcript intact beats a confidently wrong interpretation.
- **A request is never invented.** Thinking out loud produces `request: null`, not a task.
- **Single principal.** Every table and every query is scoped by `principal_id` from the first
  line, with a test asserting one principal cannot read another's rows — so adding a second person
  later does not mean rewriting every query.
- **Failures stay contained.** A failed research episode reports itself and leaves the original
  capture intact.
- **Cost is visible.** `/cost` reports spend per dossier and how often you acted on the result.
  Voice capture runs about 700–1,300 toman; a research round is several thousand.

The longer reasoning behind these choices, and the reviews that produced them, are in `docs/`.

---

## Commands

```
/start      what it does
/cost       spend per dossier, and how often you acted on it
/recent     the last captures
```

Inspection, for looking at what was actually stored:

```
/db         row counts and total spend
/c <id>     one capture, including the raw model output
/d <id>     one dossier: every claim with its verification method and note
/eps        recent research episodes: state, cost, duration
/sql SELECT …   read-only query, 20 rows max
```

`/sql` accepts a single `SELECT` and nothing else — no second statement, no `PRAGMA`,
no `ATTACH`, no writes — and only the owner chat can reach it.
