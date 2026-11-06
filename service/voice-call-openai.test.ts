// A web call through OpenAI's voice end to end, but for OpenAI: a fake Realtime socket gets the session (with the key
// only in its header), asks the real call (voice.ts) for a tool that the page that started the call shows, hears the
// page's 16 kHz microphone as 24 kHz, and its 24 kHz voice reaches the page as 16 kHz; its end_call after a goodbye ends
// the call with no error.
import { afterAll, expect, test } from "bun:test";
import { voiceCall, type Voice } from "./voice.ts";
import type { VoiceIO, Where } from "./voice-tools.ts";

const KEY = "sk-proj-test0123456789abcdef0123456789abcdef";
const now = Date.now();
const snap: any = {
  host: "mini", name: "Shepherdr", user: "You",
  machines: [{ id: "m:mini", machine: "mini", name: "This computer", status: "idle", here: true }],
  places: [{ id: "h1", name: "Home", home: true, machine: "mini", chat: "p:h1" }],
  tasks: [], needs: [], automations: {}, settings: [], asks: {},
  artifacts: [{ id: "hulk", title: "Hulk mini game · Proof", place: "h1", v: 1, at: now, when: "1m", by: "x" }],
};
const io: VoiceIO = { snap: () => snap, chat: async () => null, send: async () => {}, action: async () => ({ ok: true }) };

// the fake Realtime API: keeps what it was sent and the header it was opened with
let oai: any = null, auth: string | null = null;
const got: any[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req, srv) { auth = req.headers.get("authorization"); return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
  websocket: {
    open(ws) { oai = ws; },
    message(_ws, m) { got.push(JSON.parse(String(m))); },
  },
});
afterAll(() => server.stop(true));
const until = async (f: () => boolean) => { for (let i = 0; i < 150 && !f(); i++) await Bun.sleep(20); };

function phone() {
  const msgs: any[] = [], audio: Uint8Array[] = [];
  let call: ReturnType<typeof voiceCall>;
  const p = {
    msgs, audio,
    send(x: string | Uint8Array) {
      if (typeof x !== "string") { audio.push(x); return; }
      const m = JSON.parse(x);
      msgs.push(m);
      if (m.type === "nav") queueMicrotask(() => call.message(JSON.stringify({ type: "navved", id: m.id, ok: true, where: { device: "phone", artifact: m.nav.artifact } })));
    },
    close() {},
    start(where: Where) {
      call = voiceCall({} as any, "the Home Assistant", { view: { lastReply: () => null, status: () => null, asking: () => null }, io, where, follow: () => () => {},
        pick: async () => ({ provider: "openai", key: KEY }) as Voice, dialOpenAI: (k) => ({ url: `ws://127.0.0.1:${server.port}/`, headers: { authorization: `Bearer ${k}` } }), navWait: 1000 }, p);
      return call;
    },
  };
  return p;
}

test("an OpenAI call from a phone: its session, a tool shown on that phone, the audio both ways, and its end", async () => {
  const ph = phone();
  const c = ph.start({ client: "web", device: "phone", machine: "mini", call: "p:h1" });
  await until(() => got.length >= 2);
  // the key goes only in the socket's header
  expect(auth).toBe(`Bearer ${KEY}`);
  expect(got[0].type).toBe("session.update");
  expect(JSON.stringify(got[0])).not.toContain(KEY);
  expect(got[0].session.tools.map((t: any) => t.name)).toEqual(["look", "open", "send", "screen", "act", "end_call", "skip_turn"]);
  expect(got[0].session.instructions).toContain("the Home Assistant");
  expect(got[1].type).toBe("response.create");

  // the voice opens an artifact: it shows on this phone, then the voice is told it's on screen and answers
  oai.send(JSON.stringify({ type: "response.created" }));
  oai.send(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "open", call_id: "c1", arguments: JSON.stringify({ what: "artifact", id: "the hulk mini game" }) }] } }));
  await until(() => got.some((m) => m.item?.type === "function_call_output"));
  await until(() => got.at(-1)?.type === "response.create");
  expect(ph.msgs.filter((m) => m.type === "nav").map((m) => m.nav)).toEqual([{ kind: "artifact", artifact: "hulk", title: "Hulk mini game · Proof", v: 1, machine: null }]);
  const out = got.find((m) => m.item?.type === "function_call_output");
  expect(out.item.call_id).toBe("c1");
  expect(JSON.parse(out.item.output)).toEqual({ ok: true, shown: "the artifact \"Hulk mini game · Proof\"" });

  // the phone's 16 kHz microphone (100 ms) reaches OpenAI as 24 kHz
  c.message(new Uint8Array(3200).buffer);
  await until(() => got.some((m) => m.type === "input_audio_buffer.append"));
  const sent = Buffer.from(got.find((m) => m.type === "input_audio_buffer.append").audio, "base64");
  expect(Math.abs(sent.length - 4800)).toBeLessThanOrEqual(4);

  // its 24 kHz voice (100 ms) reaches the phone as 16 kHz; talked over, the phone stops it
  oai.send(JSON.stringify({ type: "response.created" }));
  oai.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") }));
  await until(() => ph.audio.length > 0);
  expect(Math.abs(ph.audio[0].length - 3200)).toBeLessThanOrEqual(4);
  oai.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  await until(() => ph.msgs.some((m) => m.type === "interrupt"));

  // the goodbye, then end_call: the phone hears it ended, with no error
  oai.send(JSON.stringify({ type: "response.created" }));
  oai.send(JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(480).toString("base64") }));
  oai.send(JSON.stringify({ type: "response.done", response: { output: [{ type: "function_call", name: "end_call", call_id: "c2", arguments: "{}" }] } }));
  await until(() => ph.msgs.some((m) => m.type === "ended"));
  expect(ph.msgs.filter((m) => m.type === "ended" || m.type === "error")).toEqual([{ type: "ended" }]);
});

test("no OpenAI key kept: the call says where to add it, and nothing is dialled", async () => {
  const msgs: any[] = [];
  const before = got.length;
  voiceCall({} as any, "the Home Assistant", { view: { lastReply: () => null, status: () => null, asking: () => null }, io, where: { client: "web", call: "p:h1" } as Where, follow: () => () => {},
    pick: async () => ({ error: "Voice calls through OpenAI need an OpenAI key: add it in Settings › Secrets (as OPENAI_API_KEY, for Everywhere).", why: "none" }) }, { send: (x: any) => { if (typeof x === "string") msgs.push(JSON.parse(x)); }, close() {} });
  await until(() => msgs.some((m) => m.type === "error"));
  expect(msgs.find((m) => m.type === "error").message).toContain("OPENAI_API_KEY");
  expect(got.length).toBe(before);
});
