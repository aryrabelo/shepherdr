import { describe, expect, test } from "bun:test";
import { threadsOf, isThread, tierOf, taskActivity, isLooseAgent, agentSection, agentLine, threadHome, THREAD_SECTIONS, SHELF } from "./threads.js";
import { place } from "./tasks.js";
import { taskRest } from "./settle.js";

const NOW = 1_800_000_000_000;
const item = (key, section, at, rest = null, restInfo = null) => ({ key, section, at, rest, restInfo });
const keys = (xs) => xs.map((x) => x.key);

describe("which of a space's tasks are threads", () => {
  test("at work or waiting on someone; any put away; never To do, Scheduled or Done", () => {
    expect(THREAD_SECTIONS).toEqual(["needs", "working", "merging", "ready", "queued"]);
    for (const s of THREAD_SECTIONS) expect(isThread(s)).toBe(true);
    for (const s of ["todo", "scheduled", "done"]) expect(isThread(s)).toBe(false);
    expect(isThread("queued", "settled")).toBe(true);
  });
});

describe("the order within a space", () => {
  test("needs you, then at work, then the rest by latest activity", () => {
    const { open } = threadsOf([
      item("ready-old", "ready", 10), item("working", "working", 5), item("queued-new", "queued", 30),
      item("needs-old", "needs", 1), item("merging", "merging", 7), item("needs-new", "needs", 2), item("agent-quiet", "idle", 20),
    ]);
    expect(keys(open)).toEqual(["needs-new", "needs-old", "merging", "working", "queued-new", "agent-quiet", "ready-old"]);
    expect([tierOf("needs"), tierOf("working"), tierOf("merging"), tierOf("ready"), tierOf("idle")]).toEqual([0, 1, 1, 2, 2]);
  });
  test("one activity apart keeps a steady order (by key)", () => {
    expect(keys(threadsOf([item("b", "ready", 5), item("a", "ready", 5)]).open)).toEqual(["a", "b"]);
  });
  test("a task's activity: its latest start, ready, problem, words, queueing, or its agents' status change", () => {
    expect(taskActivity({ started: 5, ready_at: 9, attention_at: 7 })).toBe(9);
    expect(taskActivity({ started: 5, progress: { at: 12 } })).toBe(12);
    expect(taskActivity({ created: 3 }, 40)).toBe(40);
    expect(taskActivity({})).toBe(0);
  });
});

describe("the shelves: Snoozed, then Settled; one on a shelf shows nowhere else", () => {
  test("Snoozed soonest to wake first, Settled latest settled first", () => {
    const t = threadsOf([
      item("a", "needs", 1, "snoozed", { rest: "snoozed", until: NOW + 7200_000 }),
      item("b", "working", 2, "snoozed", { rest: "snoozed", until: NOW + 600_000 }),
      item("c", "needs", 3, "settled", { rest: "settled", at: NOW - 50 }),
      item("d", "ready", 4, "settled", { rest: "settled", at: NOW - 5 }),
      item("e", "working", 5),
    ]);
    expect(keys(t.open)).toEqual(["e"]);
    expect(keys(t.snoozed)).toEqual(["b", "a"]);
    expect(keys(t.settled)).toEqual(["d", "c"]);
    expect([SHELF.snoozed, SHELF.settled, SHELF.folded(2)]).toEqual(["Snoozed", "Settled", "2 settled"]);
  });
  test("a woke one is back where it was (no shelf)", () => {
    const t = threadsOf([item("w", "ready", 9, null, { rest: null, woke: NOW - 1 })]);
    expect([keys(t.open), t.snoozed.length, t.settled.length]).toEqual([["w"], 0, 0]);
  });
});

describe("new work brings a thread back from its shelf (core/settle.js rules, through place())", () => {
  const list = { prefix: "APP", folder: "/r", tasks: [] };
  const worker = (more = {}) => ({ address: "t1", status: "idle", turn: 3, role: "worker", settled: `${NOW}:3`, snoozed: null, ...more });
  const row = (task, live, now = NOW + 1000) => {
    const p = place(list, task, { live, now });
    return item("APP-1", p.section, taskActivity(task), p.rest, p.restInfo);
  };
  const running = { id: 1, state: "running", started: NOW - 100, agents: [{ address: "t1", at: NOW - 100 }] };
  const shelf = (r) => {
    const t = threadsOf([r]);
    return t.settled.length ? "settled" : t.snoozed.length ? "snoozed" : "open";
  };
  test("settled while quiet; a new turn, busy, a busy sub-agent or failing checks bring it back", () => {
    expect(shelf(row(running, [worker()]))).toBe("settled");
    expect(shelf(row(running, [worker({ turn: 4 })]))).toBe("open");
    expect(shelf(row(running, [worker({ status: "working" })]))).toBe("open");
    expect(shelf(row({ ...running, attention: "Checks failing", attention_at: NOW + 5 }, [worker()], NOW + 10))).toBe("open");
    expect(taskRest(running, [worker()], [{ status: "working" }], NOW)).toBeNull();
  });
  test("snoozed until it wakes; asking or failing shows it meanwhile", () => {
    const nap = worker({ settled: null, snoozed: String(NOW + 3600_000) });
    expect(shelf(row(running, [nap]))).toBe("snoozed");
    expect(shelf(row(running, [{ ...nap, status: "blocked" }]))).toBe("open");
    expect(shelf(row(running, [nap], NOW + 3600_001))).toBe("open");
  });
  test("settled with no live agent: back on a start, a new agent or failing checks", () => {
    const stopped = { ...running, settled_at: NOW };
    expect(shelf(row(stopped, []))).toBe("settled");
    expect(shelf(row({ ...stopped, started: NOW + 1 }, []))).toBe("open");
    expect(shelf(row({ ...stopped, agents: [...stopped.agents, { address: "t7", at: NOW + 1 }] }, []))).toBe("open");
    expect(shelf(row({ ...stopped, attention_at: NOW + 1 }, []))).toBe("open");
    // its new agent live: its own labels say (none: not settled)
    expect(shelf(row(stopped, [worker({ settled: null })]))).toBe("open");
  });
});

describe("agents of a space's own (not its Assistant, nor a task's)", () => {
  const k = (labels = {}, status = "idle", more = {}) => ({ address: "t9", state: "live", status, labels, ...more });
  test("a live agent in a tab is one; a shell, the Assistant, a task's agent or a helper isn't", () => {
    expect(isLooseAgent(k())).toBe(true);
    expect(isLooseAgent(k({}, { state: "working" }))).toBe(true);
    expect(isLooseAgent(k({}, null))).toBe(false);
    expect(isLooseAgent(k(), "t9")).toBe(false);
    expect(isLooseAgent(k({ "herdr.role": "coordinator" }))).toBe(false);
    expect(isLooseAgent(k({ "herdr.task": "app#1" }))).toBe(false);
    expect(isLooseAgent(k({ "herdr.role": "reviewer" }))).toBe(false);
    expect(isLooseAgent(k({}, "idle", { state: "finished" }))).toBe(false);
  });
  test("its section and second line", () => {
    expect(["blocked", "error", "working", "done", "idle"].map(agentSection)).toEqual(["needs", "needs", "working", "idle", "idle"]);
    expect(agentLine("blocked")).toBe("Question for you");
    expect(agentLine("working")).toBe("Working");
    expect(agentLine("idle")).toBeNull();
    expect(agentLine("idle", { rest: "settled", at: NOW - 120_000 }, NOW)).toBe("Settled 2m ago");
    expect(agentLine("idle", { rest: "snoozed", until: NOW + 60_000 }, NOW)).toMatch(/^Wakes /);
    expect(agentLine("idle", { rest: null, woke: NOW - 1 }, NOW)).toBe("Woke");
    expect(agentLine("working", { rest: null, woke: NOW - 1 }, NOW)).toBe("Woke · Working");
  });
});

describe("which space a task is a thread of", () => {
  const spaces = [{ id: "sp1", machine: null, folder: "/r" }, { id: "sp2", machine: null, folder: "/r" }, { id: "vm/sp3", machine: "vm", folder: "/r" }];
  test("the space that started it, else the first in its folder, on its machine", () => {
    expect(threadHome(spaces, { machine: null, folder: "/r", space: "sp2" })).toBe("sp2");
    expect(threadHome(spaces, { machine: null, folder: "/r", space: "gone" })).toBe("sp1");
    expect(threadHome(spaces, { machine: null, folder: "/r" })).toBe("sp1");
    expect(threadHome(spaces, { machine: "vm", folder: "/r", space: "sp3" })).toBe("vm/sp3");
    expect(threadHome(spaces, { machine: null, folder: "/elsewhere" })).toBeNull();
  });
});
