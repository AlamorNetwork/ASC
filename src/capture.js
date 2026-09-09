/**
 * One voice note or message in, one structured capture out.
 *
 * There are two ways to get there and the choice is a cost decision, not a quality one:
 * a multimodal model can listen and structure in a single call, or a speech-to-text
 * model can transcribe for a fraction of the price and a cheap text model can structure
 * what it heard. The second is two calls and still much cheaper, because audio tokens
 * dominate the bill on the first.
 *
 * Which one runs depends on whether a transcription model is configured. If that route
 * fails, the multimodal one still runs — losing the thought is the worst outcome, and a
 * more expensive capture beats no capture.
 */
import { chatJson, transcribe, audioPart, textPart } from './llm.js';
import { modelFor } from './settings.js';

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

const sumUsage = (...parts) => parts.reduce((acc, u) => ({
  inTokens: acc.inTokens + (u?.inTokens ?? 0),
  outTokens: acc.outTokens + (u?.outTokens ?? 0),
  costUsd: acc.costUsd + (u?.costUsd ?? 0),
  costToman: acc.costToman + (u?.costToman ?? 0),
}), { inTokens: 0, outTokens: 0, costUsd: 0, costToman: 0 });

/** The transcription model, or null when the one-call path should be used instead. */
export function transcriptionModel() {
  const id = modelFor('transcribe');
  return id && id !== 'none' ? id : null;
}

/** Structures an already-known transcript. Text-only, so any cheap model will do. */
async function structureTranscript(text) {
  const { data, usage } = await chatJson({
    model: modelFor('structure'),
    system: SYSTEM,
    content: `این متن، پیاده‌سازی یک ویس است. آن را به یک capture object تبدیل کن. ` +
      `transcript دقیقاً همین متن است — بازنویسی‌اش نکن.\n\n${text}`,
  });
  const capture = normalise(data);
  if (!capture.transcript) capture.transcript = text;
  return { capture, usage };
}

/** One call: a multimodal model hears the audio and returns the structure directly. */
async function captureInOneCall(buffer) {
  const { data, usage } = await chatJson({
    model: modelFor('capture'),
    system: SYSTEM,
    content: [audioPart(buffer.toString('base64')), textPart('این ویس را به یک capture object تبدیل کن.')],
  });
  return { capture: normalise(data), usage };
}

/** Voice note (ogg buffer) -> capture object. */
export async function captureFromAudio(buffer) {
  const stt = transcriptionModel();
  if (stt) {
    try {
      const heard = await transcribe({ model: stt, buffer });
      if (heard.text) {
        const { capture, usage } = await structureTranscript(heard.text);
        return { capture, usage: sumUsage(heard.usage, usage), route: 'stt' };
      }
      console.warn(`[capture] ${stt} returned nothing; falling back to the audio model`);
    } catch (err) {
      // A cheaper route that fails is worse than an expensive one that works.
      console.warn(`[capture] transcription failed (${err.message}); falling back to the audio model`);
    }
  }
  return { ...await captureInOneCall(buffer), route: 'audio-model' };
}

/** Typed message -> the same capture object, so both inputs share one path. */
export async function captureFromText(text) {
  const { data, usage } = await chatJson({
    model: modelFor('capture'),
    system: SYSTEM,
    content: `این پیام را به یک capture object تبدیل کن. transcript دقیقاً همین متن است.\n\n${text}`,
  });
  const capture = normalise(data);
  if (!capture.transcript) capture.transcript = text; // never lose the thought
  return { capture, usage };
}
