import { describe, expect, test } from "bun:test";
import { settledValue, parseSettled, stillSettled, snoozedUntil, napping, woke, hidden, notNews, stale, taskRest, restFields, wordOf,
  keptSettle, agentRest, taskCan, restKey, restMark, shownRest, PENDING_MS, marksWith, marksAfter, keyVerb } from "./settle.js";
import { place, secondLine } from "./tasks.js";
import { isUnread } from "./spaces.js";
import { notifiesBy } from "./notify.js";
import { taskMenu, restMenu, SNOOZE_PICKS, SCHEDULE_PICKS } from "./menus.js";

const NOW = 1_800_000_000_000;
const term = (labels = {}, turn = 3, status = "idle") => ({ address: "t1", labels, turn, status, state: "live" });

describe("settled (herdr-t3-inbox's contract: settled=<ms>:<turn>)", () => {
  test("the label is <ms>:<turn>, and reads back", () => {
    expect(settledValue(3, NOW)).toBe(`${NOW}:3`);
    expect(parseSettled(`${NOW}:3`)).toEqual({ at: NOW, turn: 3 });
    expect(parseSettled("")).toBeNull();
    expect(parseSettled("x")).toBeNull();
  });
  test("stays settled while there's no new work; looking doesn't count", () => {
    expect(stillSettled(term({ settled: `${NOW}:3` }, 3), "idle")).toBe(true);
    expect(stillSettled(term({ settled: `${NOW}:3` }, 3), "done")).toBe(true);
  });
  test("a new turn brings it back", () => {
    expect(stillSettled(term({ settled: `${NOW}:3` }, 4), "idle")).toBe(false);
  });
  test("busy now (working or asking) brings it back", () => {
    expect(stillSettled(term({ settled: `${NOW}:3` }, 3), "working")).toBe(false);
    expect(stillSettled(term({ settled: `${NOW}:3` }, 3), "blocked")).toBe(false);
  });
  test("a busy sub-agent brings it back", () => {
    expect(stillSettled(term({ settled: `${NOW}:3` }, 3), "idle", ["working"])).toBe(false);
    expect(stillSettled(term({ settled: `${NOW}:3` }, 3), "idle", ["idle"])).toBe(true);
  });
  test("stale() says to clear a settle once there's new work", () => {
    expect(stale(term({ settled: `${NOW}:3` }, 4), "idle").settled).toBe(true);
    expect(stale(term({ settled: `${NOW}:3` }, 3), "idle").settled).toBe(false);
  });
});

describe("snoozed (snoozed=<wake ms>)", () => {
  test("hidden until it wakes, working or not", () => {
    const k = term({ snoozed: String(NOW + 3600_000) });
    expect(snoozedUntil(k)).toBe(NOW + 3600_000);
    expect(hidden(k, "idle", [], NOW)).toBe(true);
    expect(hidden(k, "working", [], NOW)).toBe(true);
  });
  test("wakes at its time, marked woke until looked at", () => {
    const k = term({ snoozed: String(NOW - 1) });
    expect(napping(k, NOW)).toBe(false);
    expect(woke(k, NOW)).toBe(true);
    expect(hidden(k, "idle", [], NOW)).toBe(false);
  });
  test("shows while it needs the person (asking), and on a failure", () => {
    const k = term({ snoozed: String(NOW + 3600_000) });
    expect(hidden(k, "blocked", [], NOW)).toBe(false);
    expect(hidden(k, "idle", ["blocked"], NOW)).toBe(false);
    expect(hidden(k, "error", [], NOW)).toBe(false);
    expect(stale(k, "error").snoozed).toBe(true);
    expect(stale(k, "idle").snoozed).toBe(false);
  });
  test("settled or snoozed isn't news; asking is", () => {
    expect(notNews(term({ settled: `${NOW}:3` }), "idle", [], NOW)).toBe(true);
    expect(notNews(term({ snoozed: String(NOW + 60_000) }), "idle", [], NOW)).toBe(true);
    expect(notNews(term({ snoozed: String(NOW + 60_000) }), "blocked", [], NOW)).toBe(false);
    expect(notNews(term({}), "idle", [], NOW)).toBe(false);
  });
  test("a status given as hc's { state } reads as a word", () => {
    expect(wordOf({ status: { state: "blocked" } })).toBe("blocked");
    expect(wordOf({ status: "idle" })).toBe("idle");
  });
});

describe("a task's rest (its live agents' labels)", () => {
  const agent = (k, more = {}) => ({ address: "t1", status: k.status, turn: k.turn, role: "worker", ...restFields(k), ...more });
  test("settled while each live agent still is; a new turn or a busy helper brings it back", () => {
    const k = term({ settled: `${NOW}:3` }, 3);
    expect(taskRest({}, [agent(k)], [], NOW)).toEqual({ rest: "settled", at: NOW });
    expect(taskRest({}, [agent(k, { turn: 4 })], [], NOW)).toBeNull();
    expect(taskRest({}, [agent(k)], [{ status: "working" }], NOW)).toBeNull();
  });
  test("failing checks found after the settle are new work", () => {
    const k = term({ settled: `${NOW}:3` }, 3);
    expect(taskRest({ attention: "Checks failing", attention_at: NOW + 5 }, [agent(k)], [], NOW + 10)).toBeNull();
    expect(taskRest({ attention: "Checks failing", attention_at: NOW - 5 }, [agent(k)], [], NOW + 10)?.rest).toBe("settled");
  });
  test("snoozed until it wakes; shows (not on the shelf) while it asks or fails", () => {
    const k = term({ snoozed: String(NOW + 3600_000) });
    expect(taskRest({}, [agent(k)], [], NOW)).toEqual({ rest: "snoozed", until: NOW + 3600_000 });
    expect(taskRest({}, [agent(k, { status: "blocked" })], [], NOW)).toEqual({ rest: null, until: NOW + 3600_000, showing: true });
    expect(taskRest({ attention: "Conflict" }, [agent(k)], [], NOW)?.rest).toBeNull();
    expect(taskRest({}, [agent(k)], [], NOW + 3600_001)).toEqual({ rest: null, woke: NOW + 3600_000 });
  });
  test("a reviewer doesn't count", () => {
    const k = term({ settled: `${NOW}:3` }, 3);
    expect(taskRest({}, [agent(k), { address: "t2", status: "working", role: "reviewer" }], [], NOW)?.rest).toBe("settled");
  });
  test("place() carries it: a settled task that waited for a reply isn't on the Needs-you shelf", () => {
    const list = { slug: "x", prefix: "X", folder: "/f", machine: null, tasks: [] };
    const task = { id: 1, state: "running", started: NOW - 600_000 };
    const k = term({ settled: `${NOW - 120_000}:3` }, 3);
    const p = place(list, task, { live: [agent(k)], now: NOW });
    expect(p.section).toBe("needs");
    expect(p.rest).toBe("settled");
    expect(secondLine(p, null, null, NOW)).toBe("Settled 2m ago");
    const z = place(list, task, { live: [agent(term({ snoozed: String(NOW + 3600_000) }))], now: NOW });
    expect(z.rest).toBe("snoozed");
    expect(secondLine(z, null, null, NOW)).toMatch(/^Wakes /);
    expect(place(list, { id: 2, state: "todo" }, { now: NOW }).rest).toBeNull();
  });
});

describe("not news anywhere", () => {
  const coord = (labels, turn = 5) => ({ address: "t9", state: "live", status: "idle", turn, labels: { "herdr.role": "coordinator", "herdr.chat.read": "3", ...labels } });
  test("a settled Assistant isn't unread until a turn ends after the settle", () => {
    expect(isUnread(coord({}), {}, 0, NOW)).toBe(true);
    expect(isUnread(coord({ settled: `${NOW}:5` }), {}, 0, NOW)).toBe(false);
    expect(isUnread(coord({ settled: `${NOW}:5` }, 6), {}, 0, NOW)).toBe(true);
  });
  test("a snoozed Assistant isn't unread until it wakes", () => {
    expect(isUnread(coord({ snoozed: String(NOW + 60_000) }), {}, 0, NOW)).toBe(false);
    expect(isUnread(coord({ snoozed: String(NOW - 1) }), {}, 0, NOW)).toBe(true);
  });
  test("a settled task's agent alerts nobody; asking still does", () => {
    const k = { address: "t1", turn: 3, status: "idle", labels: { "herdr.task": "x#1", settled: `${Date.now()}:3` } };
    expect(notifiesBy({}, k, "need")).toBe(false);
    expect(notifiesBy({}, { ...k, status: "blocked" }, "need")).toBe(true);
  });
});

describe("menus", () => {
  test("Snooze offers Start later's picks", () => {
    expect(SNOOZE_PICKS).toBe(SCHEDULE_PICKS);
    expect(restMenu().filter((x) => x.id === "snooze").map((x) => x.label)).toEqual(["In 1 hour", "In 3 hours", "Tomorrow 9:00", "Monday 9:00"]);
  });
  test("Settle, or Unsettle once settled; Wake while snoozed", () => {
    expect(restMenu()[0].id).toBe("settle");
    expect(restMenu({ rest: "settled" })[0].id).toBe("unsettle");
    expect(restMenu({ snoozed: true }).some((x) => x.id === "wake")).toBe(true);
    expect(restMenu().some((x) => x.id === "wake")).toBe(false);
  });
  test("a task's menu has them only with a live agent", () => {
    expect(taskMenu({ status: "working" }).some((x) => x.id === "settle")).toBe(false);
    expect(taskMenu({ status: "working", rest: { can: true } }).some((x) => x.id === "settle")).toBe(true);
  });
  test("ASH-14: a task with no live agent settles, without Snooze", () => {
    const m = taskMenu({ status: "needs", rest: { can: false, settle: true } });
    expect(m.some((x) => x.id === "settle")).toBe(true);
    expect(m.some((x) => x.id === "snooze" || x.heading === "Snooze")).toBe(false);
    expect(taskMenu({ status: "needs", rest: { settle: true, rest: "settled" } })[0].id).toBe("unsettle");
    expect(restMenu({ snooze: false }).map((x) => x.id)).toEqual(["settle"]);
  });
});

describe("ASH-14: a task settled with no live agent (kept on the task)", () => {
  const t = { state: "running", started: NOW - 9, settled_at: NOW, agents: [{ address: "t1", at: NOW - 9 }] };
  test("settled until new work: a start, a new agent, failing checks", () => {
    expect(keptSettle(t)).toEqual({ rest: "settled", at: NOW });
    expect(taskRest(t, [], [], NOW + 5)).toEqual({ rest: "settled", at: NOW });
    expect(keptSettle({ ...t, started: NOW + 1 })).toBeNull();
    expect(keptSettle({ ...t, agents: [...t.agents, { address: "t9", at: NOW + 1 }] })).toBeNull();
    expect(keptSettle({ ...t, attention_at: NOW + 1 })).toBeNull();
    expect(keptSettle({ ...t, attention_at: NOW - 1 })).toEqual({ rest: "settled", at: NOW });
    expect(keptSettle({ ...t, state: "done" })).toBeNull();
    expect(keptSettle({ state: "running" })).toBeNull();
  });
  test("a live agent of its own says instead (its labels)", () => {
    expect(taskRest(t, [{ address: "t1", status: "idle", turn: 1, role: "worker" }], [], NOW + 5)).toBeNull();
    // a reviewer alone isn't one of its own
    expect(taskRest(t, [{ address: "t2", status: "working", turn: 1, role: "reviewer" }], [], NOW + 5)).toEqual({ rest: "settled", at: NOW });
  });
  test("place() gives it its shelf and second line, stopped or queued; never once done", () => {
    const list = { prefix: "APP", folder: "/r", tasks: [] };
    const p = place(list, t, { live: [], now: NOW + 120_000 });
    expect([p.section, p.needs, p.rest]).toEqual(["needs", "stopped", "settled"]);
    expect(secondLine(p, null, null, NOW + 120_000)).toBe("Settled 2m ago");
    expect(place(list, { ...t, state: "queued" }, { now: NOW }).rest).toBe("settled");
    expect(place(list, { ...t, state: "done" }, { now: NOW }).rest).toBeNull();
  });
  test("what a row can do: settle unless done; snooze only with a live agent of its own", () => {
    expect(taskCan("needs", [])).toEqual({ settle: true, snooze: false });
    expect(taskCan("working", [{ role: "worker" }])).toEqual({ settle: true, snooze: true });
    expect(taskCan("working", [{ role: "reviewer" }]).snooze).toBe(false);
    expect(taskCan("done", []).settle).toBe(false);
  });
});

describe("ASH-14: an agent's own rest (an Assistant, an agent in a tab)", () => {
  const k = (labels, status = "idle", turn = 3) => ({ address: "t4", labels, turn, status });
  test("settled, snoozed, woke; asking shows", () => {
    expect(agentRest(k({ settled: "100:3" }), NOW)).toEqual({ rest: "settled", at: 100 });
    expect(agentRest(k({ settled: "100:3" }, "idle", 4), NOW)).toBeNull();
    expect(agentRest(k({ snoozed: String(NOW + 9) }), NOW)).toEqual({ rest: "snoozed", until: NOW + 9 });
    expect(agentRest(k({ snoozed: String(NOW + 9) }, "blocked"), NOW)).toEqual({ rest: null, until: NOW + 9, showing: true });
    expect(agentRest(k({ snoozed: "500" }), NOW)).toEqual({ rest: null, woke: 500 });
    expect(agentRest(k({}), NOW)).toBeNull();
    expect(agentRest(null, NOW)).toBeNull();
  });
});

describe("ASH-14: a row moves the moment it's asked", () => {
  test("each row has its key: a task's or an agent's", () => {
    expect(restKey({ machine: null, folder: "/r", ref: "APP-1" })).toBe("task::/r:APP-1");
    expect(restKey({ agent: "vm/t4" })).toBe("agent:vm/t4");
  });
  test("the mark shows until what's read agrees, at most PENDING_MS", () => {
    const settle = restMark("settle", null, NOW);
    expect(shownRest(null, settle, NOW + 10)).toEqual({ info: { rest: "settled", at: NOW }, keep: true });
    // herdr-task's labels came back: what's read shows, the mark goes
    expect(shownRest({ rest: "settled", at: NOW + 3 }, settle, NOW + 10)).toEqual({ info: { rest: "settled", at: NOW + 3 }, keep: false });
    expect(shownRest(null, settle, NOW + PENDING_MS + 1)).toEqual({ info: null, keep: false });
    expect(shownRest(null, restMark("snooze", NOW + 3600_000, NOW), NOW).info).toEqual({ rest: "snoozed", until: NOW + 3600_000 });
    expect(shownRest(null, restMark("snooze", null, NOW), NOW).info).toEqual({ rest: "snoozed", until: null });
    // Unsettle and Wake: back among the rest at once
    expect(shownRest({ rest: "settled", at: 1 }, restMark("unsettle", null, NOW), NOW)).toEqual({ info: null, keep: true });
    expect(shownRest({ rest: null, woke: 5 }, restMark("wake", null, NOW), NOW)).toEqual({ info: { rest: null, woke: 5 }, keep: false });
    expect(shownRest({ rest: "snoozed", until: 9 }, null, NOW)).toEqual({ info: { rest: "snoozed", until: 9 }, keep: false });
  });
});

describe("ASH-14 review: what's read agrees with a mark only when it says the same", () => {
  test("a snooze moved to another time keeps its mark until the new time is read (item 5)", () => {
    const again = restMark("snooze", NOW + 7200_000, NOW);
    expect(shownRest({ rest: "snoozed", until: NOW + 3600_000 }, again, NOW + 10)).toEqual({ info: { rest: "snoozed", until: NOW + 7200_000 }, keep: true });
    expect(shownRest({ rest: "snoozed", until: NOW + 7200_000 }, again, NOW + 10).keep).toBe(false);
    // a snooze's mark not answered yet (no time): any snooze read agrees
    expect(shownRest({ rest: "snoozed", until: NOW + 3600_000 }, restMark("snooze", null, NOW), NOW + 10).keep).toBe(false);
  });
  test("Wake on a snooze showing because it needs you: awake at once, until no snooze is read (item 5)", () => {
    const showing = { rest: null, until: NOW + 3600_000, showing: true };
    expect(shownRest(showing, restMark("wake", null, NOW), NOW + 10)).toEqual({ info: null, keep: true });
    expect(shownRest(null, restMark("wake", null, NOW), NOW + 10)).toEqual({ info: null, keep: false });
  });
});

describe("ASH-14 review: a late answer never overwrites a newer action's mark (item 7)", () => {
  test("marksAfter touches only the mark its own request set", () => {
    const snooze = restMark("snooze", null, NOW), wake = restMark("wake", null, NOW + 5);
    let marks = marksWith({}, "agent:t1", snooze, NOW);
    marks = marksWith(marks, "agent:t1", wake, NOW + 5);
    // the slow snooze answers after the wake: the wake's mark stays
    expect(marksAfter(marks, "agent:t1", snooze, restMark("snooze", NOW + 3600_000, undefined, snooze), NOW + 6)).toBe(marks);
    expect(marksAfter(marks, "agent:t1", snooze, null, NOW + 6)).toBe(marks);
    // its own: replaced (keeping its request's at and seq) or dropped
    expect(marksAfter(marks, "agent:t1", wake, null, NOW + 6)).toEqual({});
    expect(marksAfter(marks, "agent:t1", wake, restMark("snooze", 9, undefined, wake), NOW + 6)["agent:t1"]).toEqual({ rest: "snoozed", until: 9, at: NOW + 5, seq: wake.seq });
  });
  test("two actions on a row in the same millisecond are two requests (recheck item 3)", () => {
    const snooze = restMark("snooze", null, NOW), wake = restMark("wake", null, NOW);
    expect(snooze.at).toBe(wake.at);
    expect(snooze.seq).not.toBe(wake.seq);
    const marks = marksWith(marksWith({}, "agent:t1", snooze, NOW), "agent:t1", wake, NOW);
    // the snooze's late answer (or refusal) leaves the wake's mark, though both were asked at NOW
    expect(marksAfter(marks, "agent:t1", snooze, restMark("snooze", NOW + 3600_000, undefined, snooze), NOW)).toBe(marks);
    expect(marksAfter(marks, "agent:t1", snooze, null, NOW)).toBe(marks);
    expect(marksAfter(marks, "agent:t1", wake, null, NOW)).toEqual({});
  });
});

describe("ASH-14 review: Ctrl+Shift+S on what shows now (item 1)", () => {
  test("Unsettle once settled (a task with no live agent too), else Settle, never over a working or asking agent", () => {
    expect(keyVerb({ rest: "settled", at: 1 }, "idle")).toBe("unsettle");
    expect(keyVerb(keptSettle({ state: "running", settled_at: NOW, started: 1 }), null)).toBe("unsettle");
    expect(keyVerb(null, null)).toBe("settle");
    expect(keyVerb(null, "idle")).toBe("settle");
    expect(keyVerb({ rest: "snoozed", until: NOW + 1 }, "idle")).toBe("settle");
    expect(keyVerb(null, "working")).toBeNull();
    expect(keyVerb(null, "blocked")).toBeNull();
    // its row's mark counts: settled a moment ago, the key unsettles it
    expect(keyVerb(shownRest(null, restMark("settle", null, NOW), NOW + 10).info, "idle")).toBe("unsettle");
  });
});
