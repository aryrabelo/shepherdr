// The OpenAI voice (Settings › Voice from: OpenAI): a call through OpenAI's Realtime API over its WebSocket, with the
// person's OpenAI key (OPENAI_API_KEY in Settings › Secrets, found as the ElevenLabs key is: core/voice.js voiceKey),
// and dictation through OpenAI's speech to text with the same key. The same on both sides: the window's call
// (mods/chat/voice.ts, the machine's mic and speaker at 24 kHz) and the web's (service/voice.ts, the page's 16 kHz,
// converted here). The voice is told the same prompt and has the same Shepherdr tools as the ElevenLabs agent
// (core/voice.js prompt, TOOLS: look, open, send, screen, act with its spoken yes), plus end_call and skip_turn as
// tools of its own. It speaks the person's language (Brazilian Portuguese too). Plain data and words: each side does
// its own audio, files and sockets. Nothing is recorded or kept; the key is only ever in the socket's header.
// Shared core: the source is core/voice-openai.js.

import { prompt, TOOLS, FIRST, SILENT_END_SECS, MAX_CALL_SECS, KEY_NAME, OPENAI_KEY_NAME, DICTATE_NO_KEY, MAX_AUDIO } from "./voice.js";

export const OPENAI_API = "https://api.openai.com/v1";
export const MODEL = "gpt-realtime";
export const VOICE = "marin";
/** The Realtime API's PCM: 24 kHz, 16-bit, mono. */
export const RATE = 24000;
export const realtimeUrl = (model = MODEL) => `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

// ---- which voice ---------------------------------------------------------------------------
// Settings › Window › Voice from (~/.herdr/shepherdr.json, Everywhere's voice.provider): Automatic (OpenAI when an
// OpenAI key is kept, else ElevenLabs), OpenAI, or ElevenLabs.

export const PROVIDERS = ["auto", "openai", "elevenlabs"];
/** The choice in the settings file: "openai", "elevenlabs" or "auto" (none, or anything else). */
export function providerSetting(file) {
  const v = file?.everywhere?.voice?.provider;
  return v === "openai" || v === "elevenlabs" ? v : "auto";
}

export const NO_VOICE_KEY = "Voice calls need an OpenAI key (OPENAI_API_KEY) or an ElevenLabs key (ELEVENLABS_API_KEY): add one in Settings › Secrets, for Everywhere.";
const DICTATE_WORDS = {
  openai: "Dictation through OpenAI needs an OpenAI key (OPENAI_API_KEY) in Settings › Secrets.",
  elevenlabs: DICTATE_NO_KEY,
  auto: "Dictation needs an OpenAI or ElevenLabs key in Settings › Secrets.",
};

/**
 * The voice for a call or a dictation: { provider, key, agent?, from } or { error, why, dictate } (dictate: the words
 * for dictation). setting: providerSetting's; find(name): core/voice.js voiceKey for that secret's name. Automatic
 * asks for the OpenAI key first and only then for ElevenLabs' (a machine that can't be reached stops there).
 */
export async function pickVoice(setting, find) {
  const as = (provider, k) => ("error" in k ? { ...k, dictate: DICTATE_WORDS[provider] } : { ...k, provider });
  if (setting === "openai") return as("openai", await find(OPENAI_KEY_NAME));
  if (setting === "elevenlabs") return as("elevenlabs", await find(KEY_NAME));
  const o = await find(OPENAI_KEY_NAME);
  if (!("error" in o)) return { ...o, provider: "openai" };
  if (o.why === "unreachable") return { ...o, dictate: o.error };
  const e = await find(KEY_NAME);
  if (!("error" in e)) return { ...e, provider: "elevenlabs" };
  return e.why === "none" ? { error: NO_VOICE_KEY, why: "none", dictate: DICTATE_WORDS.auto } : { ...e, dictate: e.error };
}

// ---- the session -----------------------------------------------------------------------------

/** What the OpenAI voice is told beyond the shared prompt: its language, and its own two tools. */
export const OPENAI_RULES = `

On this call (OpenAI's voice):
- Speak the language the person speaks, Brazilian Portuguese included, with the same short replies. Shepherdr's words (task ids, space names) stay as they are.
- Ending: ask the end question in their language; after a clear yes, say a one-word goodbye ("Bye." or "Tchau.") and use end_call. Never end_call without that yes.
- When the person says to wait or hold on, or is clearly talking to someone else, use skip_turn and say nothing.
- A change the person asks for (accept, start, stop, schedule, done, delete, Autopilot, a setting...) is act, never open: act with confirmed false first (it changes nothing and says what to ask), ask that, and after their clear yes act again with confirmed true.
- One task: look with what "task" and its id (SHEP-45, or just its number); "tasks" lists them (id there is a space).`;

/** Shepherdr's tools as the Realtime API's function tools (the same names, words and parameters). */
export const FUNCTIONS = [
  ...TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
  { type: "function", name: "end_call", description: "End the call. Only after the person said yes to ending it on this call, and after your goodbye.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "skip_turn", description: "Say nothing this turn: the person said to wait or hold on, or is clearly talking to someone else.", parameters: { type: "object", properties: {} } },
];

/** The call's session: the prompt with where the call is, the tools, 24 kHz PCM both ways, the server hearing when the
 *  person speaks (and stopping the voice when they talk over it). */
export const sessionUpdate = (who, where = "") => ({ type: "session.update", session: {
  type: "realtime", model: MODEL, output_modalities: ["audio"],
  instructions: prompt(who, where) + OPENAI_RULES,
  audio: {
    input: { format: { type: "audio/pcm", rate: RATE }, noise_reduction: { type: "near_field" },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: true, interrupt_response: true } },
    output: { format: { type: "audio/pcm", rate: RATE }, voice: VOICE },
  },
  tools: FUNCTIONS, tool_choice: "auto",
} });

/** A note for the voice as a conversation item (an ElevenLabs-shaped line from core/voice.js: whereLine, replyLine,
 *  statusLine): a contextual_update is only told (system), a user_message is told and answered. */
export function noteItem(line) {
  if (!line?.text) return null;
  const role = line.type === "user_message" ? "user" : "system";
  return { event: { type: "conversation.item.create", item: { type: "message", role, content: [{ type: "input_text", text: String(line.text) }] } }, answer: line.type === "user_message" };
}

/** OpenAI's error codes a call goes on through (a race between its turns and ours). */
const HARMLESS = new Set(["conversation_already_has_active_response", "response_cancel_not_active", "item_truncate_invalid_item_id"]);
/** An error that ends the call (a bad key, no credit, a model it can't use). */
const FATAL = /api_key|quota|billing|insufficient|model_not_found|unsupported_model|authentication|permission/i;

/** An error from OpenAI in words, without anything that looks like a key. */
export const openaiError = (status, body) => {
  let why = "";
  try { const e = typeof body === "string" ? JSON.parse(body)?.error : body; why = typeof e?.message === "string" ? e.message : ""; } catch {}
  why = why.replace(/(sk-|sess_|ek_)[A-Za-z0-9_*-]+/g, "…").replace(/[A-Za-z0-9_-]{32,}/g, "…").replace(/\s+/g, " ").trim().slice(0, 200);
  return why ? `OpenAI said: ${why}` : `OpenAI said ${status}.`;
};

/**
 * One call's talk with the Realtime API, without its socket or audio. io:
 *   send(event)          an event to OpenAI's socket (an object; the side writes it as JSON)
 *   audio(b64)           24 kHz PCM of the voice to play, as base64
 *   state(s)             "listening" | "thinking" (the side shows it)
 *   interrupt()          the person talks over the voice: stop playing what it was saying
 *   tool(name, params)   Shepherdr's answer to a tool: { result, error? }
 *   end(why)             the call is over: why null for a clean end (its goodbye plays out first), else the words
 *   now()                ms (a test's clock)
 * Returns open(who, where) once the socket opens, hear(raw) for each message, note(line) for a [Update] line, mic(b64)
 * for 24 kHz PCM of the person, tick() about once a second (a long silence or an hour ends it).
 */
export function realtimeCall(io) {
  const now = io.now ?? (() => Date.now());
  const started = now();
  let heardAt = started, active = false, want = false, ending = false, over = false, spoke = false;
  const answering = new Set();
  const finish = (why) => { if (over) return; over = true; io.end(why); };
  /** a response from the voice, once the one it's giving is done */
  const respond = (extra) => {
    if (over) return;
    if (active || answering.size) { want = want || extra || true; return; }
    want = false;
    io.send(extra && extra !== true ? { type: "response.create", response: extra } : { type: "response.create" });
  };
  const calls = async (items) => {
    let more = false;
    for (const c of items) {
      if (c.name === "end_call") { ending = true; io.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: "The call is ending." } }); continue; }
      if (c.name === "skip_turn") { io.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: "ok" } }); continue; }
      answering.add(c.call_id);
      let params = {};
      try { params = c.arguments ? JSON.parse(c.arguments) : {}; } catch {}
      io.state("thinking");
      let a;
      try { a = await io.tool(String(c.name ?? ""), params ?? {}); } catch (e) { a = { result: String(e?.message ?? e).slice(0, 500), error: true }; }
      answering.delete(c.call_id);
      if (over) return;
      io.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: String(a?.result ?? "") } });
      more = true;
    }
    if (ending) {
      // its goodbye was said with the end_call: the call ends once it has played; none said: one first
      if (spoke) return finish(null);
      return respond({ instructions: "Say only a one-word goodbye in the person's language, like \"Bye.\", and nothing else." });
    }
    // skip_turn keeps it quiet only when it was all that was asked: a tool's answer is still said
    if (more) respond(true);
    else if (want) respond(want);
  };
  return {
    open(who, where = "") {
      io.send(sessionUpdate(who, where));
      // what it says first: short, then it listens
      io.send({ type: "response.create", response: { instructions: `Say exactly "${FIRST}" and nothing else.` } });
      io.state("listening");
    },
    hear(raw) {
      if (over) return;
      let m;
      try { m = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
      const t = String(m?.type ?? "");
      if (t === "response.output_audio.delta" && typeof m.delta === "string") { spoke = true; io.audio(m.delta); return; }
      if (t === "input_audio_buffer.speech_started") { heardAt = now(); io.interrupt(); io.state("listening"); return; }
      if (t === "input_audio_buffer.speech_stopped") { heardAt = now(); io.state("thinking"); return; }
      if (t === "response.created") { active = true; spoke = false; return; }
      if (t === "response.done") {
        active = false;
        heardAt = now();
        const out = Array.isArray(m.response?.output) ? m.response.output : [];
        const fn = out.filter((x) => x?.type === "function_call" && x.call_id);
        if (fn.length) { void calls(fn); return; }
        if (ending) return finish(null);
        io.state("listening");
        if (want) respond(want);
        return;
      }
      if (t === "error") {
        const e = m.error ?? {};
        if (HARMLESS.has(e.code)) return;
        // OpenAI's own longest session ran out: the call ends as a long one does, without an error
        if (e.code === "session_expired") return finish(null);
        if (FATAL.test(`${e.code ?? ""} ${e.type ?? ""}`)) return finish(openaiError(0, e));
      }
    },
    note(line) {
      const n = noteItem(line);
      if (!n || over) return;
      io.send(n.event);
      if (n.answer) respond(true);
    },
    mic(b64) { if (!over && b64) io.send({ type: "input_audio_buffer.append", audio: b64 }); },
    tick() {
      if (over) return;
      const t = now();
      if (t - started > MAX_CALL_SECS * 1000) return finish(null);
      if (!active && !answering.size && t - heardAt > SILENT_END_SECS * 1000) finish(null);
    },
    get ending() { return ending; },
    get over() { return over; },
  };
}

// ---- audio -------------------------------------------------------------------------------------

/**
 * 16-bit PCM from one rate to another, piece by piece (the web page's 16 kHz to the voice's 24 kHz and back): each
 * sample out is read between the two it falls on, the last one carried across pieces.
 */
export function resampler(from, to) {
  const step = from / to;
  let pos = 0, last = 0, first = true;
  return (bytes) => {
    const n = bytes.length >> 1;
    if (!n) return new Uint8Array(0);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const at = (i) => (i < 0 ? last : dv.getInt16(i * 2, true));
    if (first) { last = at(0); first = false; }
    const out = [];
    // pos counts from the carried sample (-1) up to the last one of this piece
    while (pos <= n - 1) {
      const i = Math.floor(pos), f = pos - i;
      const a = at(i), b = i + 1 <= n - 1 ? at(i + 1) : a;
      out.push(Math.round(a + (b - a) * f));
      pos += step;
    }
    pos -= n;
    last = at(n - 1);
    return new Uint8Array(new Int16Array(out).buffer);
  };
}

// ---- dictation -----------------------------------------------------------------------------------

export const STT_MODEL = "gpt-4o-transcribe";

/** OpenAI's speech to text request: POST /audio/transcriptions, the recording and the model; it finds the language. */
export function openaiSttRequest(key, audio, filename = "dictation.webm") {
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("response_format", "json");
  form.append("file", audio, filename);
  return { url: `${OPENAI_API}/audio/transcriptions`, init: { method: "POST", body: form, redirect: "error", headers: { authorization: `Bearer ${key}` } } };
}

/** Writes a recording down through OpenAI: its words ("" when nothing was said), or throws an Error in plain words.
 *  k: pickVoice's answer for OpenAI ({ key }). */
export async function openaiTranscribe(audio, k, fetchFn = fetch, filename) {
  if (!audio?.size) throw new Error("Nothing was recorded.");
  if (audio.size > MAX_AUDIO) throw new Error("That recording is too long.");
  const { url, init } = openaiSttRequest(k.key, audio, filename);
  let r;
  try { r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(60000) }); }
  catch (e) { throw new Error(e?.name === "TimeoutError" ? "OpenAI didn't answer in time. Try again." : "Can't reach OpenAI. Check this machine's internet, then try again."); }
  const body = await r.text().catch(() => "");
  if (!r.ok) throw new Error(openaiError(r.status, body));
  let text = "";
  try { text = JSON.parse(body)?.text; } catch {}
  if (typeof text !== "string") throw new Error("OpenAI gave no words back.");
  return text.replace(/\s+/g, " ").trim();
}
