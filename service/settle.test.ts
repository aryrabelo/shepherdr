// ASH-12 Settle and Snooze on the web: what the snapshot says of a task or an Assistant put away by hand, that neither
// is news (needs, counts, push), and how the page's actions become herdr-task's settle | unsettle | snooze | wake (a
// fake herdr-task: it writes down its arguments and answers as the real one, never a real task list).
import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME_ = mkdtempSync(join(tmpdir(), "shep-settle-"));
const BIN = join(HOME_, "herdr-task"), CALLS = join(HOME_, "calls"), REPLY = join(HOME_, "reply");
writeFileSync(BIN, `#!/bin/sh\necho "$*" >> "${CALLS}"\ncat "${REPLY}"\n[ -f "${REPLY}.fail" ] && exit 1\nexit 0\n`, { mode: 0o755 });

let C: typeof import("./compat.ts");
let A: typeof import("./actions.ts");
let M: typeof import("./model.ts");
const was = { app: process.env.HERDR_APP_HOME, task: process.env.SHEPHERDR_HERDR_TASK };
beforeAll(async () => {
  process.env.HERDR_APP_HOME = HOME_;
  process.env.SHEPHERDR_HERDR_TASK = BIN;
  C = await import("./compat.ts");
  A = await import("./actions.ts");
  M = await import("./model.ts");
});
afterAll(() => {
  if (was.app === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = was.app;
  if (was.task === undefined) delete process.env.SHEPHERDR_HERDR_TASK; else process.env.SHEPHERDR_HERDR_TASK = was.task;
});

const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n") : []);
const reply = (v: unknown, fail = false) => {
  rmSync(CALLS, { force: true });
  writeFileSync(REPLY, JSON.stringify(v));
  if (fail) writeFileSync(`${REPLY}.fail`, ""); else rmSync(`${REPLY}.fail`, { force: true });
};

const NOW = Date.now();
const row = (ref: string, section: string, more: any = {}) => ({ section, ref, machine: null, folder: "/srv/shop", slug: "shop", id: Number(ref.split("-")[1]), title: ref, key: `/srv/shop#${ref}`,
  worker: "t5", sub: "line", agents: [], logs: [], ...more });
const space = (more: any = {}) => ({ id: "sp1", name: "shop", machine: null, folder: "/srv/shop", tabs: [], assistant: "t1", assistantStatus: "idle", ...more });
const snapOf = (c: any, rows: any[], spaces: any[] = [space()]) => c.snapshot({ host: "mini", user: "me", machines: [], spaces, sections: [], rows });

test("a task's rest in the snapshot: settled, snoozed, woke; what it can do", () => {
  const c = new C.Compat() as any;
  const s = snapOf(c, [
    row("SHOP-1", "needs", { rest: "settled", restInfo: { rest: "settled", at: 100 } }),
    row("SHOP-2", "working", { rest: "snoozed", restInfo: { rest: "snoozed", until: NOW + 3600_000 } }),
    row("SHOP-3", "working", { restInfo: { rest: null, woke: 200 } }),
    row("SHOP-4", "needs", { restInfo: { rest: null, until: NOW + 60_000, showing: true } }),
    row("SHOP-5", "todo", { worker: null }),
  ]);
  const t = Object.fromEntries(s.tasks.map((x: any) => [x.id, x]));
  expect([t["SHOP-1"].rest, t["SHOP-1"].restAt, t["SHOP-1"].canRest]).toEqual(["settled", 100, true]);
  expect([t["SHOP-2"].rest, t["SHOP-2"].restUntil]).toEqual(["snoozed", NOW + 3600_000]);
  expect([t["SHOP-3"].rest, t["SHOP-3"].woke]).toEqual([undefined, 200]);
  // snoozed but asking: it shows (no rest), its snooze still set
  expect([t["SHOP-4"].rest, t["SHOP-4"].restUntil]).toEqual([undefined, NOW + 60_000]);
  expect([t["SHOP-5"].rest, t["SHOP-5"].canRest]).toEqual([undefined, undefined]);
  // not news: a settled task that needs a reply isn't in Needs you; one snoozed but asking is
  expect(s.needs.map((n: any) => n.task)).toEqual(["SHOP-4"]);
});

test("an Assistant's rest in the snapshot, from its terminal's labels (core/settle.js)", () => {
  const k = (labels: any, more: any = {}) => ({ address: "t1", labels: { "herdr.role": "coordinator", ...labels }, turn: 3, status: { state: "idle" }, ...more });
  expect(M.assistantRest(k({ settled: "100:3" }), NOW)).toEqual({ rest: "settled", at: 100 });
  // a turn ended since: new work, no longer settled
  expect(M.assistantRest(k({ settled: "100:2" }), NOW)).toBeNull();
  expect(M.assistantRest(k({ snoozed: String(NOW + 1000) }), NOW)).toEqual({ rest: "snoozed", until: NOW + 1000 });
  expect(M.assistantRest(k({ snoozed: "500" }), NOW)).toEqual({ rest: null, woke: 500 });
  // asking you: it shows, snooze kept
  expect(M.assistantRest(k({ snoozed: String(NOW + 1000) }, { status: { state: "blocked" } }), NOW)).toEqual({ rest: null, until: NOW + 1000, showing: true });
  const c = new C.Compat() as any;
  const p = snapOf(c, [], [space({ assistantRest: { rest: "snoozed", until: NOW + 1000 } })]).places[0];
  expect([p.rest, p.restUntil, p.woke]).toEqual(["snoozed", NOW + 1000, undefined]);
  expect(snapOf(c, [], [space({ assistantRest: { rest: null, woke: 500 } })]).places[0].woke).toBe(500);
});

test("a space's counts leave settled and snoozed tasks out; its Assistant asking still counts", () => {
  const here = [{ section: "needs" }, { section: "needs", rest: "settled" }, { section: "ready" }, { section: "ready", rest: "snoozed" }];
  expect(M.spaceCounts(here, true)).toEqual({ red: 2, green: 1 });
});

test("push: a Ready task put away is no alert", async () => {
  const { alertsOf } = await import("./push.ts");
  const snap = { places: [], needs: [], tasks: [{ id: "SHOP-1", status: "ready", place: "sp1", name: "a" }, { id: "SHOP-2", status: "ready", place: "sp1", name: "b", rest: "settled" }] };
  expect([...alertsOf(snap).keys()]).toEqual(["ready:SHOP-1"]);
});

test("the web's counts and app icon leave them out too", async () => {
  const { attentionCounts, actionable } = await import("../web/src/attention.ts");
  const { waiting } = await import("../web/shared/alerts.ts");
  const snap: any = { places: [{ id: "sp1" }], needs: [], asks: {}, tasks: [{ id: "A-1", place: "sp1", status: "ready" }, { id: "A-2", place: "sp1", status: "ready", rest: "snoozed" }, { id: "A-3", place: "sp1", status: "need", rest: "settled" }] };
  expect(attentionCounts(snap, ["sp1"])).toEqual({ need: 0, ready: 1 });
  expect(snap.tasks.filter(actionable).map((t: any) => t.id)).toEqual(["A-1"]);
  expect(waiting(snap)).toEqual({ count: 1, tags: ["A-1"] });
});

// what restTarget() is told of chats: an Assistant's terminal on another machine, a task here
const where = {
  addrOf: (k: string) => ({ "p:vm:sp2": "vm/t9", "p:sp1": "t1", "t:vm/t4": "vm/t4" } as Record<string, string>)[k] ?? null,
  taskOf: (id: string) => (id === "SHOP-2" ? { ref: "SHOP-2", folder: "/srv/shop", machine: null } : id === "vm:WEB-3" ? { ref: "WEB-3", folder: "/srv/web", machine: "vm" } : null),
  spaceOf: (id: string) => (id === "vm/sp2" ? { id, folder: "/srv/web", machine: "vm" } : id === "sp1" ? { id, folder: "/srv/shop", machine: null } : null),
} as any;

test("a chat becomes herdr-task's target: a task by its ref, an Assistant by --agent on its machine", () => {
  expect(A.restTarget(where, "SHOP-2/worker")).toEqual({ args: ["SHOP-2"], folder: "/srv/shop", machine: null });
  expect(A.restTarget(where, "vm:WEB-3/worker")).toEqual({ args: ["WEB-3"], folder: "/srv/web", machine: "vm" });
  expect(A.restTarget(where, "p:vm:sp2")).toEqual({ args: ["--agent", "t9"], folder: "/srv/web", machine: "vm" });
  expect(A.restTarget(where, "p:sp1")).toEqual({ args: ["--agent", "t1"], folder: "/srv/shop", machine: null });
  expect(A.restTarget(where, "t:vm/t4")).toEqual({ args: ["--agent", "t4"], folder: null, machine: "vm" });
  expect(A.restTarget(where, "NOPE-1/worker")).toBeNull();
});

test("settle, unsettle (Undo), snooze and wake run herdr-task with its words, and answer with its JSON", async () => {
  reply({ ok: true, settled: ["SHOP-2"], at: 5, was_snoozed: { "SHOP-2": NOW + 9000 } });
  expect(await A.restAct(where, { type: "settle", chat: "SHOP-2/worker" })).toEqual({ ok: true, settled: ["SHOP-2"], at: 5, was_snoozed: { "SHOP-2": NOW + 9000 } });
  expect(calls()).toEqual(["settle SHOP-2 --folder /srv/shop --json"]);

  reply({ ok: true, unsettled: ["SHOP-2"] });
  await A.restAct(where, { type: "unsettle", chat: "SHOP-2/worker", snoozeUntil: NOW + 9000 });
  expect(calls()).toEqual([`unsettle SHOP-2 --snooze-until ${NOW + 9000} --folder /srv/shop --json`]);

  reply({ ok: true, snoozed: ["t9"], until: NOW + 3600_000, when: "Today 18:00" });
  expect(await A.restAct(where, { type: "snooze", chat: "p:vm:sp2", in: "3h" })).toMatchObject({ ok: true, when: "Today 18:00" });
  expect(calls()).toEqual(["--on vm snooze --agent t9 --in 3h --folder /srv/web --json"]);

  reply({ ok: true, snoozed: ["WEB-3"] });
  await A.restAct(where, { type: "snooze", chat: "vm:WEB-3/worker", at: "tomorrow 9:00" });
  expect(calls()).toEqual(["--on vm snooze WEB-3 --at tomorrow 9:00 --folder /srv/web --json"]);

  reply({ ok: true, woke: ["t1"] });
  await A.restAct(where, { type: "wake", chat: "p:sp1" });
  expect(calls()).toEqual(["wake --agent t1 --folder /srv/shop --json"]);
});

test("herdr-task's refusal comes back in its words; a snooze with no time never runs it", async () => {
  reply({ error: "That time has passed. Choose another." }, true);
  expect(await A.restAct(where, { type: "snooze", chat: "SHOP-2/worker", at: "yesterday" })).toEqual({ ok: false, error: "That time has passed. Choose another." });
  rmSync(CALLS, { force: true });
  expect(await A.restAct(where, { type: "snooze", chat: "SHOP-2/worker" })).toEqual({ ok: false, error: "Say when it wakes." });
  expect(calls()).toEqual([]);
  expect(await A.restAct(where, { type: "settle", chat: "p:gone" })).toEqual({ ok: false, error: "That chat isn't here any more." });
});

test("a pin ends a snooze; a pin of one not snoozed asks herdr-task nothing", async () => {
  const c = new C.Compat() as any;
  const d: Record<string, any> = {};
  c.shared = { value: (k: string) => d[k], set: async (k: string, v: unknown) => { d[k] = v; } };
  snapOf(c, [row("SHOP-2", "working", { rest: "snoozed", restInfo: { rest: "snoozed", until: NOW + 9000 } }), row("SHOP-3", "working")]);
  const hub: any = { terminals: new Map() };
  reply({ ok: true, woke: ["SHOP-2"] });
  expect(await A.act(hub, { type: "pin", chat: "SHOP-2/worker", on: true }, c)).toEqual({ ok: true });
  expect(calls()).toEqual(["wake SHOP-2 --folder /srv/shop --json"]);
  expect(d["tasks.pinned"]).toEqual(["/srv/shop#SHOP-2"]);
  rmSync(CALLS, { force: true });
  await A.act(hub, { type: "pin", chat: "SHOP-3/worker", on: true }, c);
  expect(calls()).toEqual([]);
  // the page's actions reach it through act()
  reply({ ok: true, settled: ["SHOP-3"], at: 1, was_snoozed: {} });
  expect(await A.act(hub, { type: "settle", chat: "SHOP-3/worker" }, c)).toMatchObject({ ok: true, settled: ["SHOP-3"] });
});
