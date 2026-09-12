import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildProviders } from './providers.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["'](.*)["']$/s, '$1');
  }
  return out;
}

const env = { ...parseEnvFile(path.join(ROOT, '.env')), ...process.env };

/**
 * Model provider credentials. Any OpenAI-compatible endpoint works — 9router locally,
 * or a hosted provider on a server. Env wins; the local Claude settings file is only a
 * convenience for the author's own machine and is absent in deployment.
 */
function routerCreds() {
  let key = env.ROUTER_KEY;
  let base = env.ROUTER_BASE_URL;

  if (!key || !base) {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(file)) {
      try {
        const e = JSON.parse(fs.readFileSync(file, 'utf8')).env ?? {};
        key ||= e.ANTHROPIC_AUTH_TOKEN;
        base ||= e.ANTHROPIC_BASE_URL;
      } catch { /* a malformed settings file is not this program's problem */ }
    }
  }

  base = (base ?? '').replace(/\/+$/, '');
  if (!key || !base) {
    throw new Error(
      'No model provider configured. Set ROUTER_KEY and ROUTER_BASE_URL in .env ' +
      '(an OpenAI-compatible endpoint, e.g. http://127.0.0.1:20128/v1 for a local 9router).'
    );
  }
  return { key, base };
}

const botToken = env.Bot_Token || env.BOT_TOKEN;
if (!botToken) throw new Error('Bot_Token missing from .env');

const router = routerCreds();

export const config = {
  root: ROOT,
  // Overridable so the self-check writes somewhere else. It had been creating its
  // dossiers, users and documents in the real database — principal scoping kept them
  // out of anyone's view, but every run still left hundreds of rows behind in the file
  // holding the user's actual work.
  dbPath: env.ASC_DB || path.join(ROOT, 'data', 'asc.db'),
  botToken,
  router,

  /**
   * Every endpoint this can talk to, keyed by name. ROUTER_* is the default one; any
   * other is declared as <NAME>_BASE_URL with <NAME>_KEYS, and reached by writing
   * `model@name`. See providers.js.
   */
  providers: buildProviders(env, router),

  // Model ids are provider-namespaced differently depending on the endpoint
  // (a gateway may prefix them, a direct provider will not), so they are configurable.
  models: {
    // Must accept audio input: transcription and extraction happen in one call.
    capture: env.MODEL_CAPTURE || 'google/gemini-3.7-flash',
    // Optional. A dedicated speech-to-text model, billed by audio length rather than
    // by token, which is far cheaper than paying a multimodal model to listen. When
    // set, a voice note is transcribed here and structured by `structure` instead —
    // two cheap calls in place of one expensive one. Empty keeps the one-call path.
    transcribe: env.MODEL_TRANSCRIBE || '',
    // Should be search-grounded, or research has nothing to cite.
    research: env.MODEL_RESEARCH || 'openai/gpt-6-astra:online',
    // Cheap text work.
    structure: env.MODEL_STRUCTURE || 'google/gemini-3.7-flash',
    // One small classification per message: which procedure the user is asking for.
    // The cheapest thing that can follow instructions is the right model here — put a
    // free one first and something dependable behind it.
    router: env.MODEL_ROUTER || env.MODEL_STRUCTURE || 'google/gemini-3.7-flash',
    // Multilingual embeddings for retrieval. 1024 dims, and good on Persian.
    embed: env.MODEL_EMBED || 'intfloat/multilingual-e5-large',
    // Cross-encoder for the last step of retrieval. Empty disables reranking.
    rerank: env.MODEL_RERANK || 'cohere/rerank-v3.5',
  },

  // Budget per research episode, in US dollars of provider spend.
  budget: { perResearch: 0.05 },

  // Only this chat id may talk to the bot. Set after the first message.
  ownerChatId: env.OWNER_CHAT_ID ? Number(env.OWNER_CHAT_ID) : null,
};
