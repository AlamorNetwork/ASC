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
node scripts/check.js     # optional self-check; may call embedding/rerank endpoints
node index.js
```

`scripts/check.js` skips chat-model checks unless `--paid` is passed, but its default
run can still call embedding and rerank endpoints. The installer does not run it on
deploy. Run it deliberately when checking a new provider. The chat-model checks run
with `--paid` — worth doing before a release, and after changing a model.
`--audio path/to/voice.ogg` adds a real voice note through the capture path.

```bash
node scripts/check.js --paid          # ~2,300 toman, reports what each check spent
node scripts/probe-voice.js           # compare voice models on your own note
node scripts/probe-network.js         # measure the route to the provider
```

### Configuration

| Variable | |
|---|---|
| `Bot_Token` | from [@BotFather](https://t.me/BotFather) |
| `OWNER_CHAT_ID` | leave blank on first run; the first chat to message the bot claims it and the id is printed |
| `ROUTER_KEY` / `ROUTER_BASE_URL` | any OpenAI-compatible endpoint |

### Fresh server: bot, 9router and the dashboard on 8443

On Ubuntu or Debian, clone the repo and run the installer as root. It installs Node 24,
PDF tools and 9router, then creates systemd units for both 9router and ASC. 9router
listens only on `127.0.0.1:20128`; nginx serves its dashboard with a certificate on
port 8443. The public dashboard never forwards `/v1/*` inference requests. ASC talks
to 9router on localhost.

```bash
git clone https://github.com/AlamorNetwork/ASC.git /root/ASC
cd /root/ASC
read -rsp 'Cloudflare DNS API token: ' CF_TOKEN; echo; export CF_TOKEN
ASC_DOMAIN_EMAIL=you@example.com bash scripts/setup-server.sh
unset CF_TOKEN
```

The DNS token needs DNS-edit permission for `alamornetwork.ir`. It is kept in
`/etc/letsencrypt/cloudflare.ini` with root-only permissions for renewal. The installer
prints a random initial 9router dashboard password once. It preserves an existing
`.env`, database, 9router password and certificate on later runs. Without a DNS token
or an existing certificate it still installs both services, but leaves HTTPS pending
and prints the remaining command.

On a server that already has 9router, confirm its dashboard password was changed
from the bundled default and add `PASSWORD_CHANGED=1` to the installer command. This
is required before an existing dashboard is published; a fresh install uses its
newly generated random password.

In Cloudflare, create an **Origin Rule** matching hostname `router.alamornetwork.ir`
and rewrite the destination port to **8443**; keep the DNS record proxied and SSL/TLS
mode at **Full (strict)**. The installer cannot create this rule with a DNS-edit token.
Then visit the dashboard, change its initial password and add MixRoute as an
OpenAI-compatible custom provider. [docs/9router.md](docs/9router.md) has the fields.

Fill in `/root/ASC/.env` with `Bot_Token`, the API key generated **by 9router** for
ASC, and `ROUTER_BASE_URL=http://127.0.0.1:20128/v1`. This is separate from the
MixRoute key stored in 9router. Start and check the bot:

```bash
cd /root/ASC
systemctl restart asc
systemctl is-active asc 9router nginx
```

The installer checks JavaScript syntax without making model calls. The first install
waits for `.env` to be filled before starting ASC. A DNS-only token cannot
open port 8443 through a host firewall, so allow that port there if a firewall is on.

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
/menu       the inline menu — dossiers, watches, cost, settings, help
/use        pick a dossier · /close leave the conversation
/watch      watch a dossier · /intentions · /unwatch
/link       link two dossiers · /unlink · /related
/cost       spend per dossier, and how often you acted on it
/recent     the last captures
```

The command list to paste into BotFather is in [docs/botfather.md](docs/botfather.md).

## More than one person

Each Telegram chat is a separate principal, and every table and query is scoped by it —
two people on the same bot share nothing: not dossiers, not documents, not chunks, not
conversation, not the open dossier pointer. A test asserts this across ten read paths.

The first chat to message claims ownership. Anyone else is registered as pending and the
owner is asked once, with buttons to allow or block; a blocked person stays blocked even
if they message again. `/users` shows who has access and what each has spent.

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
