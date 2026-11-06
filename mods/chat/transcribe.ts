// Dictation's writer (mods/chat dictate.js): sends record.ts's recording to the speech to text of the voice Settings ›
// Voice from picks (key.ts): OpenAI's (core/voice-openai.js openaiTranscribe) or ElevenLabs' (Scribe, core/voice.js
// transcribe), with the call's key, and prints one JSON line: { text } or { error } in plain words.
//   bun transcribe.ts <recording.wav>
// The key stays in memory: never printed or logged.
import { transcribe, dictateKeyError } from "./core/voice.js";
import { openaiTranscribe } from "./core/voice-openai.js";
import { keyFor } from "./key.ts";

const [file] = process.argv.slice(2);
if (!file) { console.error("usage: bun transcribe.ts <recording.wav>"); process.exit(2); }
try {
  const f = Bun.file(file);
  const audio = (await f.exists()) ? new Blob([await f.arrayBuffer()], { type: "audio/wav" }) : new Blob([]);
  const k = await keyFor();
  if ("error" in k) throw new Error(dictateKeyError(k));
  const text = k.provider === "openai" ? await openaiTranscribe(audio, k, fetch, "dictation.wav") : await transcribe(audio, async () => k, fetch, "dictation.wav");
  console.log(JSON.stringify({ text }));
} catch (e: any) {
  console.log(JSON.stringify({ error: String(e?.message ?? e) }));
}
