// OpenAI's voice (core/voice-openai.js): which voice a call takes, its session (the same prompt and Shepherdr tools as
// the ElevenLabs agent, its language, its own end_call and skip_turn), one call's turns (tools answered, a spoken yes
// still needed, the goodbye played out, a long silence; SHEP-113: what it is doing, the person's ask held before any
// [Update]), the 16 ↔ 24 kHz audio, and dictation's request.
import { expect, test, describe } from "bun:test";
import { pickVoice, providerSetting, sessionUpdate, FUNCTIONS, realtimeCall, noteItem, resampler, openaiSttRequest, openaiTranscribe,
  openaiError, NO_VOICE_KEY, RATE, MODEL, realtimeUrl } from "./voice-openai.js";
import { TOOLS, prompt, FIRST, SILENT_END_SECS, MAX_CALL_SECS, KEY_NAME, OPENAI_KEY_NAME, voiceKey, keyScript, KEY_SCRIPT, replyLine, statusLine, whereLine, needLine, batchLines, dictateKeyError } from "./voice.js";

const OKEY = "sk-proj-test0123456789abcdef0123456789abcdef";
const EKEY = "sk_test_0123456789abcdef0123456789abcdef";

describe("which voice", () => {
  const finder = (keys, why = "none") => {
    const asked = [];
    return { asked, find: async (name) => { asked.push(name); return keys[name] ? { key: keys[name], from: "here" } : { error: `no ${name}`, why }; } };
  };
  test("the setting: openai, elevenlabs, else Automatic", () => {
    expect(providerSetting({ everywhere: { voice: { provider: "openai" } } })).toBe("openai");
    expect(providerSetting({ everywhere: { voice: { provider: "elevenlabs" } } })).toBe("elevenlabs");
    expect(providerSetting({ everywhere: { voice: { provider: "codex" } } })).toBe("auto");
    expect(providerSetting({})).toBe("auto");
    expect(providerSetting(null)).toBe("auto");
  });
  test("Automatic: OpenAI when its key is kept, without asking for ElevenLabs'", async () => {
    const f = finder({ [OPENAI_KEY_NAME]: OKEY, [KEY_NAME]: EKEY });
    expect(await pickVoice("auto", f.find)).toEqual({ key: OKEY, from: "here", provider: "openai" });
    expect(f.asked).toEqual([OPENAI_KEY_NAME]);
  });
  test("Automatic: ElevenLabs when only its key is kept (today's people keep their voice)", async () => {
    const f = finder({ [KEY_NAME]: EKEY });
    expect(await pickVoice("auto", f.find)).toEqual({ key: EKEY, from: "here", provider: "elevenlabs" });
    expect(f.asked).toEqual([OPENAI_KEY_NAME, KEY_NAME]);
  });
  test("Automatic with neither: one line naming both keys", async () => {
    const r = await pickVoice("auto", finder({}).find);
    expect(r.error).toBe(NO_VOICE_KEY);
    expect(r.why).toBe("none");
    expect(dictateKeyError(r)).toBe("Dictation needs an OpenAI or ElevenLabs key in Settings › Secrets.");
  });
  test("Automatic: the machine that keeps the secrets can't be reached: says so, ElevenLabs isn't asked", async () => {
    const f = finder({}, "unreachable");
    const r = await pickVoice("auto", f.find);
    expect(r).toMatchObject({ error: `no ${OPENAI_KEY_NAME}`, why: "unreachable" });
    expect(f.asked).toEqual([OPENAI_KEY_NAME]);
  });
  test("a picked voice uses only its own key", async () => {
    const f = finder({ [KEY_NAME]: EKEY });
    const r = await pickVoice("openai", f.find);
    expect(r).toMatchObject({ why: "none" });
    expect(dictateKeyError(r)).toBe("Dictation through OpenAI needs an OpenAI key (OPENAI_API_KEY) in Settings › Secrets.");
    expect(f.asked).toEqual([OPENAI_KEY_NAME]);
    expect(await pickVoice("elevenlabs", finder({ [OPENAI_KEY_NAME]: OKEY, [KEY_NAME]: EKEY }).find)).toMatchObject({ provider: "elevenlabs", key: EKEY });
  });
  test("the OpenAI key is found as the ElevenLabs one: the vault's Everywhere entry by its own name, never the old file", async () => {
    const vault = JSON.stringify({ secrets: [{ name: "OPENAI_API_KEY", scope: "space", value: "no" }, { name: "OPENAI_API_KEY", scope: "everywhere", value: OKEY },
      { name: "ELEVENLABS_API_KEY", scope: "everywhere", value: EKEY }] });
    const io = { oldFile: () => { throw new Error("not for OpenAI"); }, where: async () => ({ here: true }), vault: () => vault, ask: async () => null };
    expect(await voiceKey(io, OPENAI_KEY_NAME)).toEqual({ key: OKEY, from: "here" });
    const none = await voiceKey({ ...io, vault: () => "{}" }, OPENAI_KEY_NAME);
    expect(none.error).toMatch(/OPENAI_API_KEY in Settings › Secrets|as OPENAI_API_KEY, for Everywhere/);
    // on the machine that keeps them: the script asks for that name
    const asked = [];
    const far = { oldFile: () => "", where: async () => ({ here: false, set: true, name: "mini" }), vault: () => null,
      ask: async (on, script) => { asked.push(script); return JSON.stringify({ key: OKEY, agent: "" }); } };
    expect(await voiceKey(far, OPENAI_KEY_NAME)).toEqual({ key: OKEY, agent: "", from: "mini" });
    expect(asked[0]).toBe(keyScript(OPENAI_KEY_NAME));
    expect(asked[0]).toContain('"OPENAI_API_KEY"');
    expect(KEY_SCRIPT).toBe(keyScript(KEY_NAME));
  });
});

describe("the session", () => {
  const s = sessionUpdate("Home on This computer").session;
  test("the same prompt as the ElevenLabs agent (SHEP-105: a call with Shepherdr itself), with its language and its own tools", () => {
    expect(s.instructions.startsWith(prompt("Home on This computer"))).toBe(true);
    expect(s.instructions).toContain("The person called Shepherdr itself");
    expect(s.instructions).toContain("Where the call is now: Home on This computer");
    expect(s.instructions).toContain("Brazilian Portuguese");
    // ElevenLabs' language_detection tool isn't there: it switches by speaking
    expect(s.instructions).toContain("There is no language_detection tool here");
    expect(FUNCTIONS.some((f) => f.name === "language_detection")).toBe(false);
    expect(s.instructions).toContain("end_call");
    expect(s.instructions).toContain("Never end_call without that yes");
    expect(s.model).toBe(MODEL);
    expect(realtimeUrl()).toBe(`wss://api.openai.com/v1/realtime?model=${MODEL}`);
  });
  test("Shepherdr's tools as they are, plus end_call and skip_turn", () => {
    expect(FUNCTIONS.map((f) => f.name)).toEqual([...TOOLS.map((t) => t.name), "end_call", "skip_turn"]);
    for (const t of TOOLS) {
      const f = FUNCTIONS.find((x) => x.name === t.name);
      expect(f).toEqual({ type: "function", name: t.name, description: t.description, parameters: t.parameters });
    }
    // act still needs its spoken yes
    expect(FUNCTIONS.find((f) => f.name === "act").parameters.required).toContain("confirmed");
    expect(s.tools).toBe(FUNCTIONS);
  });
  test("24 kHz PCM both ways, the server hears the person and stops the voice when talked over", () => {
    expect(s.audio.input.format).toEqual({ type: "audio/pcm", rate: RATE });
    expect(s.audio.output.format).toEqual({ type: "audio/pcm", rate: RATE });
    expect(RATE).toBe(24000);
    expect(s.audio.input.turn_detection).toMatchObject({ type: "server_vad", create_response: true, interrupt_response: true });
  });
  test("[Update] lines: told quietly, or told and answered", () => {
    expect(noteItem(whereLine("Home"))).toEqual({ event: { type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "[Update] The person's app now shows: Home" }] } }, answer: false });
    const r = noteItem(replyLine("the Home Assistant", "Done."));
    expect(r.answer).toBe(true);
    expect(r.event.item.role).toBe("user");
    expect(noteItem(statusLine("x", "blocked", "Which branch?")).answer).toBe(true);
    // SHEP-105: what the call hears anywhere, and several at once, as ElevenLabs is told them
    expect(noteItem(needLine("the shop Assistant needs the person: Which port?")).answer).toBe(true);
    const batch = batchLines([whereLine("Tasks"), replyLine("the shop Assistant", "Fixed."), replyLine("SHEP 45's agent", "Done.")]).map(noteItem);
    expect(batch.map((n) => n.answer)).toEqual([false, true]);
    expect(batch[1].event.item.content[0].text).toContain("2 things came in together");
    expect(noteItem(null)).toBeNull();
  });
});

/** a call with a fake socket and clock: what it sent, played, showed, and how it ended */
function call(tools = {}) {
  let t = 0;
  const sent = [], played = [], states = [], ends = [], said = [];
  let interrupts = 0;
  const rt = realtimeCall({
    send: (m) => sent.push(m), audio: (b) => played.push(b), state: (s, doing) => states.push(doing ? `${s}: ${doing}` : s), interrupt: () => interrupts++,
    said: (text) => said.push(text),
    tool: async (name, params) => (tools[name] ? tools[name](params) : { result: `no ${name}`, error: true }),
    end: (why) => ends.push(why), now: () => t,
  });
  return { rt, sent, played, states, ends, said, interrupts: () => interrupts, at: (ms) => { t = ms; }, types: () => sent.map((m) => m.type) };
}
const fnCall = (name, args, id = `call_${name}`) => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("a call", () => {
  test("opens with the session and its short first words, then listens", () => {
    const c = call();
    c.rt.open("Home");
    expect(c.types()).toEqual(["session.update", "response.create"]);
    expect(c.sent[1].response.instructions).toContain(FIRST);
    expect(c.states).toEqual(["listening"]);
  });
  test("the voice plays, and stops when the person talks over it", () => {
    const c = call();
    c.rt.hear(JSON.stringify({ type: "response.created" }));
    c.rt.hear({ type: "response.output_audio.delta", delta: "AAA=" });
    c.rt.hear({ type: "input_audio_buffer.speech_started" });
    expect(c.played).toEqual(["AAA="]);
    expect(c.interrupts()).toBe(1);
    c.rt.mic("BBBB");
    expect(c.sent.at(-1)).toEqual({ type: "input_audio_buffer.append", audio: "BBBB" });
  });
  test("a tool is answered by Shepherdr, then the voice says it", async () => {
    const asked = [];
    const c = call({ look: (p) => { asked.push(p); return { result: "Two spaces: Shop and Home." }; } });
    c.rt.hear({ type: "response.created" });
    c.rt.hear({ type: "response.done", response: { output: [fnCall("look", { what: "spaces" })] } });
    await flush();
    expect(asked).toEqual([{ what: "spaces" }]);
    expect(c.sent).toEqual([
      { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_look", output: "Two spaces: Shop and Home." } },
      { type: "response.create" },
    ]);
    // SHEP-113: what it was doing, in plain words, then its answer next
    expect(c.states).toEqual(["working: checking spaces", "thinking"]);
  });
  test("an act without the spoken yes changes nothing: the voice is told to ask (confirmed false goes as asked)", async () => {
    const acts = [];
    const c = call({ act: (p) => { acts.push(p); return p.confirmed ? { result: "Accepted SHEP 45." } : { result: "Ask first: accept SHEP 45? It merges it.", error: true }; } });
    c.rt.hear({ type: "response.done", response: { output: [fnCall("act", { action: "accept", id: "SHEP-45", confirmed: false })] } });
    await flush();
    expect(acts).toEqual([{ action: "accept", id: "SHEP-45", confirmed: false }]);
    expect(c.sent[0].item.output).toContain("Ask first");
  });
  test("a response still going: the next waits for its end, never two at once", async () => {
    const c = call({ look: () => ({ result: "ok" }) });
    c.rt.hear({ type: "response.done", response: { output: [fnCall("look", { what: "here" })] } });
    c.rt.hear({ type: "response.created" }); // the person spoke meanwhile: the server answers them
    await flush();
    expect(c.types()).toEqual(["conversation.item.create"]);
    c.rt.hear({ type: "response.done", response: { output: [] } });
    expect(c.types()).toEqual(["conversation.item.create", "response.create"]);
  });
  test("an agent's reply is told and said; a quiet note isn't answered", () => {
    const c = call();
    c.rt.note(whereLine("Tasks"));
    expect(c.types()).toEqual(["conversation.item.create"]);
    c.rt.note(replyLine("the Home Assistant", "Done."));
    expect(c.types()).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
  });
  test("end_call after its goodbye: the call ends cleanly once that response is done", async () => {
    const c = call();
    c.rt.hear({ type: "response.created" });
    c.rt.hear({ type: "response.output_audio.delta", delta: "Ynll" });
    c.rt.hear({ type: "response.done", response: { output: [{ type: "message" }, fnCall("end_call", {})] } });
    await flush();
    expect(c.ends).toEqual([null]);
    expect(c.types()).toEqual(["conversation.item.create"]);
    expect(c.rt.over).toBe(true);
  });
  test("end_call with no goodbye said: one first, then the end", async () => {
    const c = call();
    c.rt.hear({ type: "response.created" });
    c.rt.hear({ type: "response.done", response: { output: [fnCall("end_call", {})] } });
    await flush();
    expect(c.ends).toEqual([]);
    expect(c.sent.at(-1).type).toBe("response.create");
    expect(c.sent.at(-1).response.instructions).toContain("goodbye");
    c.rt.hear({ type: "response.created" });
    c.rt.hear({ type: "response.output_audio.delta", delta: "VGNoYXU=" });
    c.rt.hear({ type: "response.done", response: { output: [] } });
    expect(c.ends).toEqual([null]);
  });
  test("skip_turn: nothing said, no response asked", async () => {
    const c = call();
    c.rt.hear({ type: "response.done", response: { output: [fnCall("skip_turn", {})] } });
    await flush();
    expect(c.types()).toEqual(["conversation.item.create"]);
  });
  test("skip_turn beside a real tool: the tool's answer is still said", async () => {
    const c = call({ look: () => ({ result: "ok" }) });
    c.rt.hear({ type: "response.done", response: { output: [fnCall("skip_turn", {}), fnCall("look", { what: "here" })] } });
    await flush();
    expect(c.types()).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
  });
  test("SHEP-113: the person's ask holds [Update]s until it is answered, tools and all", async () => {
    let done;
    const c = call({ look: () => new Promise((r) => { done = () => r({ result: "Nothing is working." }); }) });
    expect(c.rt.holding()).toBe(false);
    c.rt.hear({ type: "input_audio_buffer.speech_started" });
    c.rt.hear({ type: "input_audio_buffer.speech_stopped" });
    expect(c.rt.holding()).toBe(true);
    // "On it." then the tool: still owed while it runs
    c.rt.hear({ type: "response.created" });
    c.rt.hear({ type: "response.done", response: { output: [{ type: "message" }, fnCall("look", { what: "tasks", query: "working" })] } });
    await flush();
    expect(c.rt.holding()).toBe(true);
    done();
    await flush();
    // its answer is next: still owed
    expect(c.rt.holding()).toBe(true);
    c.rt.hear({ type: "response.created" });
    c.rt.hear({ type: "response.output_audio_transcript.done", transcript: " Nothing is working now. " });
    c.rt.hear({ type: "response.done", response: { output: [{ type: "message" }] } });
    expect(c.rt.holding()).toBe(false);
    expect(c.said).toEqual(["Nothing is working now."]);
    expect(c.states).toEqual(["listening", "thinking", "working: checking tasks", "thinking", "listening"]);
  });
  test("SHEP-113: a voice that never answers holds no longer than the gate's limit; skip_turn owes nothing", async () => {
    const c = call();
    c.at(1000);
    c.rt.hear({ type: "input_audio_buffer.speech_stopped" });
    expect(c.rt.holding(1000 + 29_000)).toBe(true);
    expect(c.rt.holding(1000 + 31_000)).toBe(false);
    const d = call();
    d.rt.hear({ type: "input_audio_buffer.speech_stopped" });
    d.rt.hear({ type: "response.done", response: { output: [fnCall("skip_turn", {})] } });
    await flush();
    expect(d.rt.holding()).toBe(false);
    expect(d.states.at(-1)).toBe("listening");
  });
  test("OpenAI's own session running out ends the call cleanly, as a long one does", () => {
    const c = call();
    c.rt.hear({ type: "error", error: { type: "invalid_request_error", code: "session_expired", message: "Your session hit the maximum duration." } });
    expect(c.ends).toEqual([null]);
  });
  test("silence: the voice never prompts; 15 quiet minutes end the call, an hour ends any", () => {
    const c = call();
    c.at(SILENT_END_SECS * 1000 - 1); c.rt.tick();
    expect(c.ends).toEqual([]);
    c.rt.hear({ type: "input_audio_buffer.speech_started" });
    c.at(SILENT_END_SECS * 2000 - 2); c.rt.tick();
    expect(c.ends).toEqual([]);
    c.at(SILENT_END_SECS * 2000 + 10); c.rt.tick();
    expect(c.ends).toEqual([null]);
    const d = call();
    for (let m = 1; m <= 61; m++) { d.at(m * 60_000); d.rt.hear({ type: "input_audio_buffer.speech_started" }); d.rt.tick(); }
    expect(d.ends).toEqual([null]);
    expect(MAX_CALL_SECS).toBe(3600);
  });
  test("a bad key ends the call in words without the key; a race between turns doesn't", () => {
    const c = call();
    c.rt.hear({ type: "error", error: { type: "invalid_request_error", code: "conversation_already_has_active_response", message: "x" } });
    expect(c.ends).toEqual([]);
    c.rt.hear({ type: "error", error: { type: "invalid_request_error", code: "invalid_api_key", message: `Incorrect API key provided: ${OKEY}.` } });
    expect(c.ends.length).toBe(1);
    expect(c.ends[0]).toStartWith("OpenAI said: Incorrect API key provided");
    expect(c.ends[0]).not.toContain("test0123456789");
  });
});

describe("audio", () => {
  const pcm = (xs) => new Uint8Array(new Int16Array(xs).buffer);
  const samples = (b) => Array.from(new Int16Array(b.buffer, b.byteOffset, b.length >> 1));
  test("16 kHz to 24 kHz and back keeps the length and the shape, across pieces", () => {
    const tone = Array.from({ length: 1600 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)));
    const up = resampler(16000, 24000), down = resampler(24000, 16000);
    const a = up(pcm(tone.slice(0, 800))), b = up(pcm(tone.slice(800)));
    const upN = (a.length + b.length) / 2;
    expect(Math.abs(upN - 2400)).toBeLessThanOrEqual(2);
    const back = [...samples(down(a)), ...samples(down(b))];
    expect(Math.abs(back.length - 1600)).toBeLessThanOrEqual(2);
    // the same tone, within a little
    let err = 0;
    for (let i = 10; i < 1590; i++) err = Math.max(err, Math.abs(back[i] - tone[i]));
    expect(err).toBeLessThan(400);
  });
  test("an empty piece is nothing", () => {
    expect(resampler(16000, 24000)(new Uint8Array(0)).length).toBe(0);
  });
});

describe("dictation through OpenAI", () => {
  const audio = new Blob([new Uint8Array(500).fill(3)], { type: "audio/webm" });
  test("the recording and the model, with the key only in the header", async () => {
    const { url, init } = openaiSttRequest(OKEY, audio, "dictation.webm");
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers.authorization).toBe(`Bearer ${OKEY}`);
    const f = init.body;
    expect(f.get("model")).toBe("gpt-4o-transcribe");
    expect(f.has("language")).toBe(false); // found from the audio (Portuguese, English...)
    expect((f.get("file")).name).toBe("dictation.webm");
  });
  test("its words come back tidied; a refusal is said without the key", async () => {
    const ok = async () => new Response(JSON.stringify({ text: "  Oi,  abre a\ntarefa SHEP 45. " }));
    expect(await openaiTranscribe(audio, { key: OKEY }, ok)).toBe("Oi, abre a tarefa SHEP 45.");
    const no = async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${OKEY}` } }), { status: 401 });
    const e = await openaiTranscribe(audio, { key: OKEY }, no).catch((x) => x.message);
    expect(e).toStartWith("OpenAI said: Incorrect API key provided");
    expect(e).not.toContain("test0123");
    await expect(openaiTranscribe(new Blob([]), { key: OKEY }, ok)).rejects.toThrow("Nothing was recorded.");
    expect(openaiError(500, "")).toBe("OpenAI said 500.");
  });
});
