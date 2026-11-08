// A task as the window reads it live, and where a click on it goes: the Tasks panel's rows (mods/tasks) and the
// sidebar's threads under each space (mods/spaces-chat, ASH-14) read and open tasks the same way.
// - its live agents and its worker's helpers (liveOf, helpersOf), its place (core/tasks.js place()) with the rows put
//   away or back a moment ago (placeTask: core/settle.js shownRest over shared "tasks.restnow", lib/rest.js writes it);
// - a click opens its chat in the Tasks panel (taskTarget, openThread), a right-click the row menu (openRowMenu: Pin,
//   Start later, Settle and Snooze; mods/tasks-menu "row"); an agent of its own the Snooze menu (openRestMenu: "rest").
// f: the caller's cache for one render ({}: none), so each list is read once a render, not once a row.
// Shared: the source is lib/taskthread.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/taskthread.js, never a mod's copy, then run bin/sync-shared.

import { machines, shared, setShared, run, layout, openOverlay } from "herdr";
import { agents, panes, terminals } from "./live.js";
import { RANK, machineOf, place, refOf, capital, queueReason } from "./core/tasks.js";
import { restFields, restKey, shownRest, marksWith, PENDING } from "./core/settle.js";
import { taskMenu, restMenu } from "./core/menus.js";

// a worker's own helper agent (SHEP-54): an hc child labelled reviewer or helper
export const helper = (k) => ["reviewer", "helper"].includes(k.labels?.["herdr.role"]) && !!k.parent;

const shownAgents = (f) => (f.agents ??= new Map(agents().map((a) => [a.address, a])));
// The live terminals by their task (herdr.task label), once a render.
function byTask(f) {
  if (f.byTask) return f.byTask;
  f.byTask = new Map();
  for (const k of (f.terminals ??= terminals())) {
    const key = k.state === "live" ? k.labels?.["herdr.task"] : null;
    if (key) f.byTask.set(key, [...(f.byTask.get(key) ?? []), k]);
  }
  return f.byTask;
}

// A task's agents now: live terminals labelled with its key, on the folder's machine.
export function liveOf(list, task, f = {}) {
  const m = list.machine ?? null;
  const shown = shownAgents(f);
  return (byTask(f).get(`${list.slug}#${task.id}`) ?? []).filter((k) => machineOf(k.address) === m)
    .filter((k) => k.program?.key !== "shell" && !k.program?.shell && !helper(k))
    .map((k) => {
      // agents() knows when someone looked at a finished agent (done -> idle), as Herdr shows it.
      const a = shown.get(k.address);
      // No report yet: starting (counts as working).
      const st = a?.status ?? (RANK[k.status] ? k.status : null);
      const tab = k.labels?.["herdr.tab"];
      // Where it shows: its own pane, else the chat pane it's parked behind (mods/chat).
      const chat = k.labels?.["herdr.chat"];
      const pane = (f.panes ??= panes()).find((p) => p.terminal === k.address)?.pane ?? (chat ? (m ? `${m}/${chat}` : chat) : null);
      return { address: k.address, status: st, program: a?.program ?? k.program, tab: tab && m ? `${m}/${tab}` : tab, pane,
        role: k.labels?.["herdr.role"] ?? "worker", turn: k.turn, ...restFields(k) };
    });
}

// Its worker's own helper agents (SHEP-54: a reviewer it started as its hc child): never among its agents; one at
// work or asking keeps the task Working (core/tasks.js place()).
export function helpersOf(list, task, live, f = {}) {
  const m = list.machine ?? null;
  const mine = new Set(live.map((a) => a.address.split("/").pop()));
  const shown = shownAgents(f);
  // on the folder's machine, a child of one of its agents
  return (byTask(f).get(`${list.slug}#${task.id}`) ?? []).filter((k) => helper(k) && machineOf(k.address) === m
    && mine.has(String(k.parent).split("/").pop()))
    .map((k) => ({ address: k.address, status: shown.get(k.address)?.status ?? (RANK[k.status] ? k.status : null) }));
}

// A task's status (its section), why it needs the person, its live agents and its rest: core/tasks.js's place(), with
// what Herdr knows live (its agents now, whether its machine has loaded). A row settled, snoozed, woken or unsettled a
// moment ago shows so at once (ASH-14), until what's read agrees: then its mark is spent (dropSpent).
export function placeTask(list, task, f = {}) {
  const st = task.state;
  const live = st === "running" || st === "ready" ? liveOf(list, task, f) : [];
  f.loading ??= new Set(machines().filter((m) => m.layout === "loading").map((m) => m.name ?? null));
  const p = place(list, task, { live, loaded: !f.loading.has(list.machine ?? null), helpers: live.length ? helpersOf(list, task, live, f) : [] });
  const key = restKey({ machine: list.machine ?? null, folder: list.folder, ref: refOf(list, task) });
  return marked(p, key, f);
}

// p with its at-once mark (key: core/settle.js restKey) applied: { ...p, rest, restInfo }.
export function marked(p, key, f = {}) {
  const mark = (f.marks ??= shared(PENDING) ?? {})[key];
  if (!mark) return p;
  const { info, keep } = shownRest(p.restInfo ?? null, mark);
  if (!keep) (f.spent ??= new Set()).add(key);
  return { ...p, rest: info?.rest ?? null, restInfo: info };
}

// After a render: the marks it found spent go, so new work (a turn, a start) moves the row back at once.
export function dropSpent(f, cx) {
  const gone = f?.spent;
  if (!gone?.size) return;
  cx.timer.after(0, () => {
    let marks = shared(PENDING) ?? {};
    for (const key of gone) if (key in marks) marks = marksWith(marks, key, null);
    if (Object.keys(marks).length !== Object.keys(shared(PENDING) ?? {}).length) setShared(PENDING, marks);
  });
}

// Why a queued task waits (core/tasks.js): the tasks it comes after, else the folder is full.
export function queueNote(list, task, f = {}) {
  const running = f.running ??= new Map();
  if (!running.has(list)) running.set(list, list.tasks.filter((x) => x.state === "running" && liveOf(list, x, f).length).length);
  return queueReason(list, task, running.get(list));
}

// Task threads: a click drills into the task inside the Tasks panel (the layout's "tasks" stack: its list is
// "tasks-list", the task "tasks-thread", mods/chat/panel.js), never a side chat. Only where the shown layout has that
// view. Shared "tasks.thread" = { terminal (its agent, live or its last one; null: never started), task (its id),
// title, key ({ machine, folder, slug, id }), log ({ path, kind }: an ended agent's own log), note (why one never
// started waits), at }. From outside the panel (the sidebar), the panel shows on its Tasks view first.
const hasThread = (n) => Boolean(n && typeof n === "object") && (n.id === "tasks-thread" || (n.children ?? []).some(hasThread));
export const threadsShown = (f = {}) => (f.threads ??= hasThread(layout()));
export function openThread({ terminal = null, task = null, title = null, key = null, log = null, note = null }) {
  setShared("tasks.thread", { terminal, task, title, key, log, note, at: Date.now() });
  run("layout.select", { stack: "panel-body", child: "tasks" });
  run("layout.select", { stack: "tasks", child: "tasks-thread" });
  run("layout.show", { id: "panel" });
}

// Where a click on a task goes: always into it, in the Tasks panel (drill in; never a tab, a peek or the Assistant's
// box). Its worker while one runs (the one asking first; a reviewer alone too); else its last agent's conversation, read
// from that agent's own log, with Resume (mods/chat); a task that never started says why it waits. Nowhere in a layout
// without the view (null). p: placeTask's.
export function taskTarget(p, f = {}) {
  if (!threadsShown(f)) return null;
  const { list, task } = p;
  const m = list.machine ?? null;
  const key = { machine: m, folder: list.folder, slug: list.slug, id: task.id };
  const open = (terminal, more = {}) => () => openThread({ terminal, task: refOf(list, task), title: task.title, key, ...more });
  const worker = p.live.find((x) => x.role !== "reviewer" && x.status === "blocked") ?? p.live.find((x) => x.role !== "reviewer") ?? p.live[0];
  if (worker) return open(worker.address);
  const last = task.agents?.[task.agents.length - 1];
  if (last?.address) return open(m ? `${m}/${last.address}` : last.address, { log: last.log ? { path: last.log, kind: last.agent ?? null } : null });
  return open(null, { note: p.section === "queued" ? capital(queueNote(list, task, f)) : "This task hasn't started." });
}

// A menu's height, as tasks-menu draws it: a section per line or heading, 4 apart; a heading 28, a row 32.
export function menuHeight(items) {
  let height = 8, first = true;
  for (const x of items) {
    if ((x.sep || x.heading) && !first) height += 4;
    height += x.sep ? 0 : x.heading ? 28 : 32;
    first = false;
  }
  return height;
}

// A task row's right-click menu (mods/tasks-menu "row", core/menus.js taskMenu), at the pointer: Pin / Unpin; a task not
// started yet starts later (SHEP-38), a scheduled one Start now and Unschedule; Settle or Unsettle, and with a live
// agent of its own Snooze's times and Wake (ASH-12, ASH-14). pin: { key, on, status, machine, folder, ref, sub,
// rest: { can (snooze), settle, rest, snoozed } }.
export function openRowMenu(pin) {
  const items = taskMenu({ pinned: pin.on, status: pin.status, rest: pin.rest }).filter((x) => !x.typed);
  openOverlay({ mod: "tasks-menu", kind: "popup", at: "pointer", width: 220, height: menuHeight(items), props: { menu: "row", key: pin.key, on: pin.on,
    status: pin.status, machine: pin.machine, folder: pin.folder, ref: pin.ref, sub: pin.sub, rest: pin.rest } });
}

// An agent of its own's Snooze menu (mods/tasks-menu "rest", core/menus.js restMenu), as an Assistant's header opens it:
// Settle or Unsettle, Snooze's times, Wake. agent: its address; what: its name in the toasts.
export function openRestMenu({ agent, what, rest = null, snoozed = false }) {
  const items = restMenu({ rest, snoozed }).filter((x) => !x.typed);
  openOverlay({ mod: "tasks-menu", kind: "popup", at: "pointer", width: 220, height: menuHeight(items),
    props: { menu: "rest", agent, what, rest, snoozed } });
}
