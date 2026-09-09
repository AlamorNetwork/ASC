/**
 * What did the user mean — not how to do it.
 *
 * The procedures in this program are deliberately fixed: investigate follows leads
 * through the corpus, research gathers and verifies, deep alternates until the leads run
 * out. That they are written down in code is what lets the bot say VERIFIED and mean
 * something. A model that chose its own procedure could only claim to have followed one.
 *
 * So this decides which of those procedures the message is asking for, and nothing else.
 * It never sees fetched pages or document text — only what the user typed — so nothing
 * the bot reads can steer what the bot does next. Evidence comes from content; authority
 * comes only from the person.
 *
 * It is one small call, so it belongs on the cheapest model available:
 *   MODEL_ROUTER=qwen3.8-flash-free@kira,google/gemini-3.6-flash
 */
import { chatJson } from './llm.js';
import { modelFor } from './settings.js';
import { isAboutTheConversation } from './chat.js';

export const INTENTS = ['chat', 'summarise', 'search', 'research', 'deep', 'keep', 'open'];

/** The ones that spend real money are proposed, never started on a guess. */
export const COSTS_MONEY = new Set(['research', 'deep']);

const SYSTEM = `تو تشخیص می‌دهی کاربر از دستیار پژوهشی‌اش چه می‌خواهد. فقط JSON بده:

{
  "intent": "chat | summarise | search | research | deep | keep | open",
  "topic": "موضوع، اگر تحقیق تازه‌ای می‌خواهد — وگرنه null",
  "why": "در چند کلمه، چرا این را انتخاب کردی"
}

معنی هرکدام:
- chat: سؤال یا حرفی درباره‌ی پرونده‌ی باز. حالت پیش‌فرض وقتی پرونده‌ای باز است.
- summarise: می‌خواهد آنچه تا حالا هست جمع‌بندی یا مرور شود. موضوع تازه‌ای در کار نیست.
- search: می‌خواهد داخل اسناد خودش گشته شود. «توی کتاب ببین»، «تو اسناد چی هست».
- research: می‌خواهد در وب تحقیق تازه شود. topic را از حرفش دربیاور.
- deep: می‌خواهد تا ته برود و تا وقتی سرنخی هست ادامه دهد. «تا ته»، «کامل»، «هرچی هست».
- keep: فکری را می‌گوید و کاری نمی‌خواهد. فقط باید ثبت شود.
- open: می‌خواهد به پرونده‌ی دیگری برود.

قواعد:
- research فقط وقتی که واقعاً بخواهد بیرون را بگردی. سؤال درباره‌ی چیزی که در پرونده هست chat است.
- deep گران است. فقط وقتی که صریح خواسته باشد تا آخر برود.
- اگر شک داری بین chat و research، chat را بگیر — ارزان‌تر است و کاربر می‌تواند بعدش بخواهد.
- از خودت موضوع نساز. اگر topic در حرفش نیست، null بگذار.`;

/**
 * @param {object} ctx
 * @param {string} ctx.text            what the user typed
 * @param {boolean} ctx.hasDossier     is a dossier open
 * @param {string|null} ctx.topic      its subject, for context
 * @param {boolean} ctx.hasDocs        does it hold documents
 * @param {function} [ctx.ask]         injectable, for tests
 * @returns {{intent, topic, why, usage, decidedBy}}
 */
export async function route({ text, hasDossier, topic = null, hasDocs = false, ask = chatJson }) {
  const said = String(text ?? '').trim();

  // Free answers first. Most messages are one of these, and paying a model to tell us
  // what a regex already knows is the kind of cost that hides in plain sight.
  if (!said) return decided('keep', null, 'empty');
  if (isAboutTheConversation(said) && hasDossier) return decided('summarise', null, 'meta request');
  if (!hasDossier && !said.includes(' ') && said.length < 24) {
    // A single word with nothing open is a thought, not an instruction.
    return decided('keep', null, 'one word, nothing open');
  }

  try {
    const { data, usage } = await ask({
      model: modelFor('router'),
      system: SYSTEM,
      content: [
        hasDossier ? `پرونده‌ی باز: «${topic ?? '—'}»${hasDocs ? ' (سند دارد)' : ''}` : 'هیچ پرونده‌ای باز نیست.',
        '',
        `کاربر گفت: ${said}`,
      ].join('\n'),
      maxTokens: 300,
    });

    const intent = INTENTS.includes(data?.intent) ? data.intent : null;
    if (!intent) return decided(fallback(hasDossier), null, 'unrecognised reply', usage);

    // An intent that needs a subject but was given none cannot be acted on.
    if (intent === 'research' && !data.topic) {
      return decided(fallback(hasDossier), null, 'research without a topic', usage);
    }
    return decided(intent, data.topic ?? null, data.why ?? '', usage, 'model');
  } catch (err) {
    // The router failing must not swallow the message. The old behaviour is the
    // fallback, and it is the cheap one.
    console.warn('[router] could not decide, using the default:', err.message);
    return decided(fallback(hasDossier), null, 'router unavailable');
  }
}

/** What this program did before there was a router, and what it does when one fails. */
const fallback = (hasDossier) => (hasDossier ? 'chat' : 'keep');

const decided = (intent, topic, why, usage = {}, decidedBy = 'rule') =>
  ({ intent, topic, why, usage, decidedBy });
