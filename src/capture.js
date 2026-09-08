import { config } from './config.js';
import { chatJson, audioPart, textPart } from './llm.js';

const SYSTEM = `You turn one Persian voice note or message into a structured capture object.
Reply with a JSON object only — no prose, no code fence.

{
  "transcript": "verbatim Persian transcription with correct punctuation; keep proper nouns exact",
  "language": "fa | en | mixed",
  "kind": "research | standing_intention | note | question | action_request | unclear",
  "title": "short Persian title, at most 8 words",
  "request": "what the speaker wants, one Persian sentence — null if they asked for nothing",
  "topic": "the subject, or null",
  "durability_marker": "the exact phrase implying something ongoing (از این به بعد / همیشه / هر روز / هر وقت / دیگه همیشه), or null",
  "confidence": 0.0,
  "needs_confirmation": true
}

Rules:
- kind=research when they ask you to look something up, study, or investigate a topic.
- kind=standing_intention ONLY when a durability_marker is actually present.
- kind=note when they are thinking out loud and asked for nothing.
- kind=unclear when you cannot tell. Set confidence low and request null.
- NEVER invent a request that was not made. An absent request is null.
- Always fill transcript, even when kind=unclear. Losing the thought is the worst outcome.`;

function normalise(data) {
  const kinds = ['research', 'standing_intention', 'note', 'question', 'action_request', 'unclear'];
  const kind = kinds.includes(data.kind) ? data.kind : 'unclear';
  return {
    transcript: String(data.transcript ?? '').trim(),
    language: data.language ?? 'fa',
    kind,
    title: data.title ?? null,
    request: data.request ?? null,
    topic: data.topic ?? null,
    durability: data.durability_marker ?? null,
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    needsConfirmation: data.needs_confirmation !== false,
  };
}

/** Voice note (ogg buffer) -> capture object. One model call. */
export async function captureFromAudio(buffer) {
  const { data, usage } = await chatJson({
    model: config.models.capture,
    system: SYSTEM,
    content: [audioPart(buffer.toString('base64')), textPart('این ویس را به یک capture object تبدیل کن.')],
  });
  return { capture: normalise(data), usage };
}

/** Typed message -> the same capture object, so both inputs share one path. */
export async function captureFromText(text) {
  const { data, usage } = await chatJson({
    model: config.models.capture,
    system: SYSTEM,
    content: `این پیام را به یک capture object تبدیل کن. transcript دقیقاً همین متن است.\n\n${text}`,
  });
  const capture = normalise(data);
  if (!capture.transcript) capture.transcript = text; // never lose the thought
  return { capture, usage };
}
