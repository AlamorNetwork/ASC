# ASC

Put a half-finished thought somewhere. It gets advanced while you are elsewhere, and comes back
when it is ready.

A Telegram bot: send a voice note or a message, and it is captured, classified, and — if you ask
for it — researched in the background. Results come back in four columns, so you can see at a
glance what was actually checked and what was merely found.

Persian-first. Zero npm dependencies (Node 22+ built-ins only: `fetch`, `node:sqlite`).

### Optional Google Document AI for scanned books

The web upload screen can send a PDF of up to 500 pages to Google Document AI
**batch OCR**. ASC keeps the original PDF as the source, saves OCR text page by
page in the selected dossier, and offers a UTF-8 text download with page markers.
Blank pages remain blank; OCR text is a searchable transcript, not independent
proof that a quote appears in the image. Claim verification therefore keeps its
image-source caution. This path does not create a searchable PDF or silently
call a claim-extraction model. Google processing and storage may incur charges
outside ASC's model meter.

Create a Google Cloud project with billing, enable Document AI, create an
Enterprise Document OCR processor and a private Cloud Storage bucket in the
processor's location. Give a service account Document AI API User and bucket
object access, then put its JSON credentials on the server outside the checkout
with restrictive permissions. Set the five `GOOGLE_DOCUMENT_AI_*` and
`GOOGLE_APPLICATION_CREDENTIALS` values shown in `.env.example`, restart
`asc-web`, and use **OCR گوگل** on an incomplete PDF in the web upload list.
The cloud operation ID is saved before polling so a restart can resume without
submitting the same book again. If submission was interrupted before Google
returned an operation ID, ASC stops and asks for manual inspection to avoid
accidental duplicate billing. Test the integration without cloud calls with
`node scripts/check-google-document-ai.js`.

---

## The part that matters: four columns

Research output is never a confident paragraph. It is split by **how much the system actually
knows**:

| | |
|---|---|
| ✅ **تأییدشده** | The source was fetched, the quoted span was found, and a separate semantic judge found that the quotation supports the entire claim |
| ⚠️ **مورد اختلاف** | Reputable sources genuinely disagree, and both sides are shown |
| 📄 **پیدا شده** | Encountered but not verified — with the reason (paraphrased quote, source did not load) |
| ❓ **حل‌نشده** | What could not be settled, and what would settle it |

VERIFIED means *this source says this*, never *this is true*. `src/verify.js`
string-matches the quote against the fetched page; `src/support.js` then checks whether
the quote supports the whole claim. A missing, malformed, contradictory, or ambiguous
judgment stays in FOUND. The semantic check uses a model and can be wrong; the label
describes the procedure that ran, not certainty about historical truth.
Existing quote-only verdicts are downgraded once when the bot starts; run
`/reverify DOSSIER_ID` to apply the new semantic check without repeating research.
Claims extracted from scanned pages stay in FOUND because their quote only matches
the model's OCR text, not the original image independently.
An indirect hint in a document is stored separately as a FOUND hypothesis only if
its cue is an exact span of the stored text. It cannot become VERIFIED merely by
plausible interpretation. A user-approved deep investigation seeds its next searches
with these hypotheses and can look for independent web evidence within its budget;
the frontier is saved before the first round for stop and resume.

Web research searches from the server (Bing RSS best effort, OpenAlex open copies,
MediaWiki search and Crossref metadata), opens candidate pages or text-layer PDFs,
and gives only fetched excerpts to
`MODEL_STRUCTURE`. Search snippets and DOI metadata are leads, not evidence. Claims
are tied to a fetched source ID, rechecked against the page, then assessed for
semantic support. Scholarly metadata (DOI, author, year, venue) is saved as a lead,
not evidence; it stays attached when ASC reads an open copy. Set `OPENALEX_API_KEY`
in `.env` for a larger free daily request budget, then restart `asc` and `asc-web`.
Some sites block fetching or expose only an abstract; these stay
unresolved rather than becoming verified. `MODEL_RESEARCH` is retained for the
legacy model comparison script; ordinary bot research does not need an `:online`
model. Check outbound access without model charges with:

DOI links are resolved to their public publisher page before crawling. After that
single resolver step the crawler locks itself to the publisher origin; ordinary
cross-site redirects remain blocked by the SSRF and same-origin guard.
Anti-bot interstitials such as JSTOR's `Client Challenge` are transport failures,
not article text: ASC tries the configured browser fallback, otherwise keeps the
source unresolved. If an older run stored such a page, retrying the DOI removes that
page and revokes claims that were incorrectly verified from its error message.

Book-oriented queries also consult Open Library for work and edition metadata,
and Gutendex for public-domain ebook text. Open Library records stay unread leads;
Gutendex text is eligible as evidence only after ASC fetches it and matches a
quote. These public APIs need no additional key, and are not called for ordinary
non-book queries.

```
node scripts/probe-web-search.js "Mithraism Roman Iranian origins"
```

Each web round now plans bounded parallel searches for direct evidence, contrary
accounts and source attribution. Results from the lanes are interleaved before
opening pages so one lane cannot consume the entire reading budget. Every readable
result returned by the search providers is tried in small network batches, and
each saved page is passed to the research worker in a small analysis batch. There
is no fixed eight-page fetch or five-source worker cutoff. A stop, the configured
cost ceiling, or the research run's time limit can still pause the remaining
results; saved pages and worker progress are kept for resume. Search providers
can themselves return only a finite result set or block access to a page. This uses one
planning model call; it does not pretend that three independent agents verified the
answer. The Telegram status card shows the current phase, elapsed time and stop
control. Its bar counts phases, not the percentage of unknown work remaining.

The web round also keeps a small audit of competing interpretations and people
mentioned in fetched sources. Each cited passage in that audit must occur in a
server-fetched excerpt. The passages, theories, and questions about a person's
role or perspective remain **unverified leads**: finding their words does not
establish the theory or prove bias. Deep investigation searches those questions
in later rounds and saves the frontier when stopped or when the cost ceiling is
reached. A claim about a person's motives needs independent sources and must be
checked claim by claim. Search is bounded by accessible pages and the agreed
budget; it cannot claim to have read every source or settled every hypothesis.

Every dossier has a generated Markdown research ledger under `data/asc-ledgers/`.
It records the saved frontier, rounds, documents, verified claims and open questions.
The database is authoritative; the file is regenerated after research and on
`/ledger [DOSSIER_ID]`, which also sends it in Telegram. A short bounded part is
given to the planner to avoid repeating work, and to the chat model when asked
about progress. Ledger text is context, never a new citation or instruction.

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

### Private web workspace

The web workspace uses the same SQLite dossiers and research engine as the Telegram bot.
It uploads PDFs directly from the browser, up to the app's 100 MB limit; it does not
pass them through Telegram's hosted Bot API. The upload itself never calls a model.
Select **Read** after upload to extract and index the file. A scanned book asks
separately before reading the next 20 pages with vision. Chat, web research, claims,
evidence status and a Markdown research ledger are available in the same interface.
The workspace has separate pages for the mother conversation, source library, live
agent tree, and evidence. The source library lists documents from every dossier owned
by the signed-in principal. It offers stored passages, a document-specific conversation,
and a PDF preview/download when the original upload is still on this server. The
original cannot be reconstructed from OCR text if it was imported elsewhere. A case
can be deleted from the case rail after an explicit confirmation; its documents,
research state and conversations are removed, while copies in other cases survive.
After a file has been read, **Deep analysis** walks every stored section, checks each
quoted detail against that section, and writes a resumable `document-N-analysis.md`
beside the dossier ledger. It describes topics, events, people, concepts, links between
sections and unresolved questions. For scanned PDFs, coverage explicitly says how many
pages were read; a quote match against OCR does not verify the image itself. The
analysis runs only when requested and may cost model credits. Set `MODEL_ANALYSIS` to
a reasoning-capable model chain, or use `/model analysis MODEL@PROVIDER`; its default
is `MODEL_STRUCTURE`. The Jev Decisions model is unsuitable for this prose/JSON role.

On the server, point a proxied Cloudflare DNS record for `asc.alamornetwork.ir`
at it. Set SSL/TLS to **Full (strict)** and create an **Origin Rule** for that
hostname that rewrites the destination port to **2083**. Xray keeps 443 and
9router keeps 8443. Then run as root:

```bash
cd /root/ASC && git pull
read -rsp 'Cloudflare DNS API token: ' CF_TOKEN; echo; export CF_TOKEN
bash scripts/setup-web.sh asc.alamornetwork.ir you@example.com
unset CF_TOKEN
```

The installer generates a long password and shows it once, then puts the app behind
nginx and a certificate on origin port 2083. It binds Node to `127.0.0.1:3000`.
The DNS token is stored in `/etc/letsencrypt/cloudflare.ini` with root-only
permissions for certificate renewal. The script checks the local origin; verify
the public URL separately after the Cloudflare rule is active. If 2083 is occupied,
choose a free `WEB_HTTPS_PORT` and set the Origin Rule to the same port.
The existing Telegram service keeps running during migration. To run the web smoke
test without model spend: `node scripts/check-web.js` and
`node scripts/check-document-analysis.js`.

#### Research team and source library

Talk to ASC normally in the web workspace. When you explicitly ask it to research a
topic, its coordinator chooses the root question and up to three distinct subquestions,
saves them before work starts, and sends local-document or web-search agents in
parallel. A plain question or request for conversation does not launch research.
The coordinator reviews agent reports, approves traceable leads, can create one new
subquestion from a documented gap, and runs approved follow-ups automatically.
It may set the search depth from 1 to 12 rounds; the default is 6. A single run also
stops at 25 minutes or when the user-set research spending ceiling is reached.
Only the user can raise that spending ceiling. If a run stops, say "ادامه بده" in
that dossier to resume its saved frontier without repeating completed agents.
The intention tree shows status, round progress and open questions; it is managed
from chat. `MODEL_COORDINATOR` handles planning and synthesis (falling back to the
structure model until set with `/model coordinator MODEL@PROVIDER`); workers use
`MODEL_STRUCTURE`. Each web agent searches for its own subquestion and reads fetched
page excerpts. Its quotations are checked against the excerpt, but its report remains
a lead; the separate full-source claim verification gate is unchanged. A restart
pauses running nodes in SQLite. The dossier's Markdown ledger lists their status.

The source library lists documents, analysis overviews and cross-section links.
Submit a site URL to read up to 10 same-origin HTML pages per run; submit the same URL
again to continue. Pages and the crawl cursor are stored after each page. The crawler
rejects private destinations and observes `robots.txt` where available. It cannot
read sign-in pages, PDFs, or an unlimited site. For JavaScript-only pages or native
fetch failures, optional fallbacks can render one page with a local
[Scrapling](https://github.com/D4Vinci/Scrapling) browser or the hosted
[Firecrawl](https://github.com/firecrawl/firecrawl) scrape API. The fallback never
changes the same-origin, robots, page-size, or persisted-cursor rules. It makes at
most two fallback calls in one crawl batch.

Web research agents use the same reader after an ordinary page fetch fails:
at most one rendered search result per subquestion. They save the fetched text
and URL in the dossier before citing an excerpt. Browser processes are
serialized across the bot and web services, so parallel agents do not launch
parallel Chromium instances. Scrapling opens pages found by search; it does not
replace the search engines themselves.

The fallbacks are disabled until explicitly configured. On the server, run
`bash scripts/setup-scrapling.sh` if local Chromium fits, then set
`WEB_FETCH_FALLBACK=scrapling` and
`SCRAPLING_PYTHON=/opt/asc-scrapling/bin/python` in `.env`. The browser
can load the public host of each search result; optional
`SCRAPLING_ALLOWED_HOSTS` adds explicit CDN hosts needed by some sites.
To use Firecrawl credits
instead, set `WEB_FETCH_FALLBACK=firecrawl` and `FIRECRAWL_API_KEY`. The chain
`WEB_FETCH_FALLBACK=scrapling,firecrawl` tries the local browser first. Restart
`asc-web` after editing `.env`. Firecrawl is billed outside ASC's model meter;
its cloud API may receive page URLs and content. Scrapling's Chromium download
and runtime need additional disk and memory. Neither service is required for the
ordinary crawler.

An existing
document's **Deep analysis** button analyzes all its stored text; this is separate
from crawling and can incur model charges.

### Book library

Uploaded PDFs form an owner-scoped library across dossiers. Each book has a
numeric ID; copies with the same SHA-256 share the ID of the first uploaded
copy. The library searches filenames, analyzed section topics, summaries, and
stored text. The mother can search the library, then request a page or up to
four short passages by book ID. It sees a small catalogue in each turn, not the
entire book. Text and page-specific quotes remain necessary for evidence;
model-generated summaries are only navigation hints.

The generated book index is `data/asc-ledgers/<principal-id>/library.md` and the
all-document index is `data/asc-ledgers/<principal-id>/sources.md` when the database
is `data/asc.db`. Both update after import, OCR and deep analysis, and rebuild at
web startup. The source index can also be downloaded from the library page. The
mother can discover and retrieve passages across its owner's dossiers, with each
passage labelled by dossier and document ID. The SQLite database remains authoritative; keep
it when migrating servers. Check this path for another database name with
`node scripts/check-library.js` (free, no model calls).

Optional source consultation uses one OpenRouter completion with the Perplexity web
search tool. Add OpenRouter as a direct provider, then set
`/model consult MODEL@openrouter` in Telegram. The web button asks before the call.
Its URLs are stored as *unverified candidates*; the research team can crawl one
candidate in parallel with local analysts. OpenRouter may perform more than one search
inside that completion, so this is a bounded workflow call, not a guaranteed dollar
ceiling. Check reported usage before routine use.

Free local checks: `node scripts/check-mother.js`, `node scripts/check-research-team.js`,
`node scripts/check-site-crawl.js`, `node scripts/check-site-library.js`, and
`node scripts/check-page-fetchers.js`, and `node scripts/check-source-consult.js`.

### Scanned books and vision comparison

Send a scanned PDF to the bot and approve 20 pages or the full book. Each page's
transcription, chunks, cursor and reported cost are committed together before the next
vision call. If a model fails, send the **same PDF bytes** again to continue at the
next unsaved page. Pages already stored are not sent to vision again. Keep `/backup`
off the old server before moving the database; progress lives in SQLite.

Telegram's hosted Bot API cannot download a document over 20 MB. For larger books,
obtain `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org),
then run `bash scripts/setup-telegram-local.sh` as root on the ASC server. The script
builds Telegram's official local Bot API, binds it to `127.0.0.1:8082`, logs the bot
out of the hosted API, updates `.env` and restarts ASC. It asks for the two values
privately and keeps them in `/etc/asc-telegram-api.env`. The app accepts documents
up to 100 MB; resend the PDF after the migration. This is separate from 9router.

To choose a vision model, manually transcribe three representative pages into
`truth.json`: one clear page, one ordinary page, and one difficult page with small
print or a table. The page numbers are PDF page numbers, starting at 1:

```json
{"2":"Exact text on PDF page 2", "19":"Exact text on PDF page 19", "37":"Exact text on PDF page 37"}
```

Run from the server with the same provider models configured in ASC:

```bash
node scripts/benchmark-vision.js book.pdf truth.json gemini-3.1-flash-lite@mixdirect MODEL_2@mixdirect
node scripts/benchmark-vision.js book.pdf truth.json gemini-3.1-flash-lite@mixdirect MODEL_2@mixdirect --run
```

The first command makes no model calls. `--run` compares transcription character
error rate (CER), completion rate, time and reported cost. A zero or missing provider
cost is shown as unknown, so compare actual balance usage too. Pick the model that
finishes every page with the fewest errors at an acceptable cost; a short picture
recognition probe is insufficient for book OCR.

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

## Optional MCP research for software ideas

The software-idea handoff can consult two fixed, read-only MCP services before
writing its Markdown report:

- GitHub MCP searches public `DESIGN.md` examples and reads at most one matching file.
  Set `GITHUB_MCP_TOKEN` to a token with the least public-repository access needed.
  The client exposes only `search_code,get_file_contents` with `X-MCP-Readonly: true`.
- Context7 MCP resolves one framework and reads its current documentation. Set
  `CONTEXT7_MCP_ENABLED=1`; `CONTEXT7_API_KEY` is optional for higher limits.

Both are used only for a software-idea report. One small model call chooses the
technical search terms. MCP results appear as **technical leads**, never as verified
citations; the quote gate still requires the original source text. Missing credentials
or an unavailable server does not stop the report. Browser fetching remains in ASC's
existing web research path. `node scripts/check-mcp.js` runs offline protocol
checks; `node scripts/probe-mcp.js` checks configured services live without
model calls.

After setting the variables in `/root/ASC/.env`, restart `asc` and `asc-web`.

## OpenAlex tools for the mother agent

The mother agent has a bounded, read-only OpenAlex adapter for scholarly discovery.
It can search works by keyword or semantic similarity, read a work by OpenAlex ID or
DOI, resolve up to 25 references, traverse citing/referenced/related works with pages,
search or read authors/sources/institutions/topics/publishers/funders, group and profile
works, validate OQL for free, and run a validated OQL calculation below the configured
20-credit safety ceiling. The adapter mirrors the useful read-only surface of the
official OpenAlex MCP without requiring its interactive OAuth login.

Ask the mother agent explicitly, for example: `در OpenAlex با جست‌وجوی معنایی آثار
مرتبط با Dura-Europos Mithraeum را پیدا کن` or `ارجاعات و استنادهای DOI ... را جدا
فهرست کن`. Every returned item is saved as a **bibliographic lead**. It becomes evidence
only after ASC opens the source text and the quote gate matches the claimed passage.
`OPENALEX_API_KEY` is optional; a free account key raises the daily credit budget.
`node scripts/check-openalex-tools.js` checks the full adapter without network or model calls.

Crossref remains an independent no-key metadata fallback in normal web research. OpenAlex
already supplies incoming citations, references and related works, so ASC does not call a
second citation-graph service by default. CORE is not integrated yet; it is the next useful
addition when an API key is available because its value is access to open full text.

For medical or clinical product ideas, ASC narrows the report to evidence mapping, risks,
human oversight and stop conditions. The report explicitly says it is not reliable for
diagnosis, treatment, prescribing, triage or another clinical decision.

## Scholarly discovery benchmark

`node scripts/benchmark-scholarly.js` previews three fixed questions about Dura-Europos,
Ostia and Roman Mithraism. Add `--run` to compare the OpenAlex and Semantic Scholar
**underlying search APIs** with the same query and top-K. This isolates the value of
each catalogue before deciding whether to run a Semantic Scholar MCP server. No model
is called. `--limit=5`, `--fetch=2` and `--case=dura,ostia,origins` control the run.
An optional `SEMANTIC_SCHOLAR_API_KEY` in `.env` is sent as `x-api-key`.

The script writes Markdown and raw JSON under `data/benchmarks/`. It records API
errors separately from empty results, title-anchor matches separately from human
relevance, and open-copy links separately from text actually fetched by ASC. A
readable page is not a verified claim. If an endpoint returns 403 or 429 on one
machine, rerun on the deployment server before comparing quality.

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
