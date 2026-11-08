// Threads in the sidebar (ASH-14), as T3 Code's projects: each space opens into its threads under its row (its
// Assistant stays the space's own row). A thread is one of the space's tasks at work or waiting on someone, or an agent
// of its own opened in one of its tabs (an omp or a Claude Code that isn't its Assistant nor a task's). Within a
// space: what needs you, then what's at work, then the rest by their latest activity; at the end its Snoozed shelf (the
// soonest to wake first) and its Settled shelf (folded until opened, the latest settled first), as T3's. A thread on a
// shelf shows in no other group; new work (a turn, a busy sub-agent, a failure, a start) brings it back where it was.
// The window's sidebar (mods/spaces-chat) and the web's (web/plugins/places) both order them here; what they read live
// (a task's place(), an agent's terminal) comes in as arguments, so nothing here reads Herdr.
// Shared core: the source is core/threads.js; bin/sync-shared copies it into the mods in lib/COPIES.
import { SETTLED, SNOOZED, REST, wordOf } from "./settle.js";
import { ago, wakesLine } from "./tasks.js";
import { REASONS } from "./needs.js";

// A space's tasks that are threads: Needs you, Working, Merging, Ready and Queued (core/tasks.js sections), and any put
// away by hand. To do, Scheduled and Done stay in the Tasks panel.
export const THREAD_SECTIONS = ["needs", "working", "merging", "ready", "queued"];
export const isThread = (section, rest = null) => Boolean(rest) || THREAD_SECTIONS.includes(section);

// Its tier in its space: needs you (0), at work (1: Working, Merging), the rest (2: Ready, Queued, a quiet agent).
export const tierOf = (section) => (section === "needs" ? 0 : section === "working" || section === "merging" ? 1 : 2);

// When a task last did something, for the order within its tier: its start, its ready, a problem found, its agent's
// latest words (herdr-task status), its queueing, its making; liveAt: its live agents' latest status change (ms).
export function taskActivity(task, liveAt = 0) {
  const t = [task?.ready_at, task?.started, task?.attention_at, task?.progress?.at, task?.queued_at, task?.created, liveAt];
  return Math.max(0, ...t.map(Number).filter(Number.isFinite));
}

// An agent opened in one of a space's tabs is a thread of its own: live, an agent (it reports a status: a shell has
// none), not the space's Assistant (assistant: its address), and neither a task's agent (those are their task's thread)
// nor another agent's helper (a reviewer, a second opinion: its parent's). k: its terminal.
export function isLooseAgent(k, assistant = null) {
  if (!k || k.state !== "live" || k.address === assistant || !wordOf(k)) return false;
  const role = k.labels?.["herdr.role"];
  return !k.labels?.["herdr.task"] && role !== "coordinator" && role !== "reviewer" && role !== "helper";
}

// An agent thread's second line, as a task's (core/tasks.js secondLine): put away says so (Wakes…, Settled 2m ago),
// woke says so until looked at; else asking ("Question for you"), failed, working, nothing while quiet.
export function agentLine(word, info = null, now = Date.now()) {
  if (info?.rest === SNOOZED) return wakesLine(info.until, now);
  if (info?.rest === SETTLED) return `${REST.settled} ${ago(info.at ?? now, true, now)}`;
  const said = word === "blocked" ? REASONS.question : word === "error" ? "Failed" : word === "working" ? "Working" : null;
  return info?.woke ? [REST.woke, said].filter(Boolean).join(" · ") : said;
}

// An agent's section, as a task's reads: asking or failed needs you, working is at work, the rest is quiet ("idle").
export const agentSection = (word) => (word === "blocked" || word === "error" ? "needs" : word === "working" ? "working" : "idle");

// Which space a task is a thread of (one only): the space that started it (herdr-task keeps it: "sp3", "vm/sp3"), while
// it is there; else the first space on its machine in its list's folder. spaces: [{ id, machine, folder }] in the
// sidebar's order; thing: { machine, folder, space }. -> a space id, or null (none here: it shows in the Tasks panel only).
const bare = (id) => (id == null ? null : String(id).slice(String(id).lastIndexOf("/") + 1));
export function threadHome(spaces, thing) {
  const m = thing?.machine ?? null;
  const mine = spaces.filter((s) => (s.machine ?? null) === m);
  const started = thing?.space != null ? mine.find((s) => bare(s.id) === bare(thing.space)) : null;
  return (started ?? mine.find((s) => Boolean(thing?.folder) && s.folder === thing.folder))?.id ?? null;
}

// A space's threads in order. items: [{ key, section, rest ("settled" | "snoozed" | null), restInfo (core/settle.js
// taskRest/agentRest: at, until), at (latest activity, ms) }]; the rest of each item is the caller's.
// -> { open: the threads in order, snoozed: the soonest to wake first, settled: the latest settled first }.
export function threadsOf(items) {
  const byKey = (a, b) => String(a.key).localeCompare(String(b.key));
  const snoozed = items.filter((x) => x.rest === SNOOZED)
    .sort((a, b) => (a.restInfo?.until ?? Infinity) - (b.restInfo?.until ?? Infinity) || byKey(a, b));
  const settled = items.filter((x) => x.rest === SETTLED)
    .sort((a, b) => (b.restInfo?.at ?? 0) - (a.restInfo?.at ?? 0) || byKey(a, b));
  const open = items.filter((x) => !x.rest && (x.section === "idle" || isThread(x.section)))
    .sort((a, b) => tierOf(a.section) - tierOf(b.section) || (b.at ?? 0) - (a.at ?? 0) || byKey(a, b));
  return { open, snoozed, settled };
}

// Words for the shelves' headings and a folded Settled's line ("3 settled").
export const SHELF = { snoozed: "Snoozed", settled: "Settled", folded: (n) => `${n} settled` };
// Where an open Settled shelf is remembered, per space (the window's localStorage, the web's device UI).
export const settledOpenKey = (space) => `threads.settled:${space}`;
