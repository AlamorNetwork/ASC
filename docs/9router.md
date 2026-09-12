# 9router: pooling providers behind one endpoint

9router runs on the server at `127.0.0.1:20128`. ASC talks to it over loopback; its
dashboard is what you reach in a browser.

## Adding kiraai as a provider

Dashboard → **Providers** → **Custom Providers** → **Add Custom Provider**

| Field | Value | Why |
|---|---|---|
| Type | `openai-compatible` | kiraai speaks the OpenAI API |
| Name | `Kira AI` | label only |
| Prefix | `kira` | becomes part of every model id: `kira/qwen3.8-flash-free` |
| Base URL | `https://kiraai.vn/api/v1` | from their docs |

Then add a connection under it with your `kira_…` API key.

The prefix is the part that matters later — it is how the models are named everywhere
else, including in combos and in ASC's `.env`.

## Making a combo

Dashboard → **Combos** → new combo.

A combo is a **name** and an **ordered chain of models**, minimum two. It then appears
in `/v1/models` as a single id with `owned_by: "combo"`, and calling that id walks the
chain. The two that ship with it, `opus-gg` and `mimo-gg`, are the same idea.

For the free kira models, ordered the way the probe measured them — the ones that
returned valid JSON first, since that is all the `structure` role ever asks for:

```
name: kira-free

  kira/qwen3.8-flash-free
  kira/glm-5.3-flash-free
  kira/qwen3.8-27b-free
  kira/kira-auto
  kira/kira-mini-1.0
  kira/mimo-v2.5-free
  kira/hy3-free
  kira/glm-5.3-free
  kira/ling-3.0-flash-sante-free
  kira/mercury-2.5-free
```

Include the ones that were failing when you looked. Which of them is up flips between
runs minutes apart — a set that answered fine can be entirely 502 the next time — so a
chain built only from what worked in one thirty-second window is built from a coin toss.

## Pointing ASC at it, without making it a single point of failure

The mistake to avoid is routing *everything* through one local process. That trades
several partial outages for one total one, and we have already had a server where the
bot kept running while one piece of it was unreachable.

So keep a direct provider alongside, and make the last link of each chain bypass
9router entirely:

```bash
ROUTER_BASE_URL=http://127.0.0.1:20128/v1
ROUTER_KEY=<an API key made in the 9router dashboard>

# The same provider, reached directly — not through 9router.
LIARA_BASE_URL=https://ai.liara.ir/api/<workspace>/v1
LIARA_KEYS=<liara key>

# First link is the combo; last link does not depend on 9router being alive.
MODEL_STRUCTURE=kira-free,google/gemini-3.6-flash@liara
MODEL_ROUTER=kira/qwen3.8-flash-free,google/gemini-3.6-flash@liara
```

Embeddings and reranking have no equivalent on a chat-only provider, so they should go
direct regardless:

```bash
MODEL_EMBED=intfloat/multilingual-e5-large@liara
MODEL_RERANK=cohere/rerank-v3.5@liara
```

## Which layer handles what

Both 9router and ASC can fall back, and they are not doing the same job.

- **9router's combo** walks a chain inside one request. ASC sees one model id.
- **ASC's chain** (`providers.js`) walks across *providers*, rotates keys when one is
  rate-limited or out of credit, and rests a model for two minutes after a 5xx so a long
  chain of mostly-down free models does not cost a failed round trip on every call.

Using both is fine and is the point: the combo keeps a single call alive, and ASC's
chain keeps the bot alive when the combo — or 9router itself — is not.
