// Settle and Snooze (ASH-12): putting an agent away by hand, as T3 Code does with a thread. The same contract as
// herdr-t3-inbox (mods/t3-inbox/tree.js, Apache-2.0), so both can run on one machine and read each other's marks:
//   settled=<ms>:<turn>  on the agent's own terminal (hc label). It stays settled while there's no new work: not busy
//                        (working or blocked), no sub-agent busy, and no turn ended since (turn <= the label's turn).
//                        New work clears it (whoever sees it first: the window, the service, herdr-task's scheduler).
//                        Looking doesn't count.
//   snoozed=<wake ms>    hides the agent, working or not, on a shelf of its own until then; it wakes where it was,
//                        marked Woke until looked at (the label stays, in the past, until then). It shows meanwhile
//                        while it needs the person; a failure, a new turn in view, Wake, a pin or Settle ends it.
//                        An empty value clears either label.
// Settled or snoozed isn't news: neither counts in a "waits for you" mark (red counts, unread, toasts, news).
// A task is its live agents': settled when each of them still is (and nothing failed since), snoozed while one is.
// Shepherdr's own words and rules here; herdr-task keeps the same in herdr_task/settle.py (keep them equal).
// Shared core: the source is core/settle.js; bin/sync-shared copies it into the mods in lib/COPIES.

export const SETTLED = "settled";
export const SNOOZED = "snoozed";

const busy = (s) => s === "working" || s === "blocked";
// A terminal's status as a plain word (the window's terminals() has a word; hc's records may have { state }).
export const wordOf = (k) => (k?.status && typeof k.status === "object" ? k.status.state : k?.status) ?? null;

// The label's value for an agent settled now on its turn: "<ms>:<turn>".
export const settledValue = (turn, at = Date.now()) => `${Math.round(at)}:${Math.max(0, Number(turn) || 0)}`;
// "<ms>:<turn>" -> { at, turn }; null when there's none (or it can't be read).
export function parseSettled(v) {
  if (!v) return null;
  const [at, turn] = String(v).split(":").map(Number);
  return Number.isFinite(at) && at > 0 ? { at, turn: Number.isFinite(turn) ? turn : 0 } : null;
}

// An agent's terminal (k: { labels, turn }) is still settled: its own word and its sub-agents' words (kids) not busy,
// and no turn ended since it was settled. As herdr-t3-inbox's stillSettled().
export function stillSettled(k, word, kids = []) {
  const s = parseSettled(k?.labels?.[SETTLED]);
  if (!s) return false;
  return !busy(word) && !kids.some(busy) && (k?.turn ?? 0) <= s.turn;
}

// When its snooze ends (0: none). Past it, the label stays as "woke, not looked at yet".
export const snoozedUntil = (k) => Number(k?.labels?.[SNOOZED]) || 0;
export const napping = (k, now = Date.now()) => snoozedUntil(k) > now;
export const woke = (k, now = Date.now()) => { const u = snoozedUntil(k); return u > 0 && u <= now; };

// A failure in it or under it ends a snooze (a program reports "error").
export const failed = (word, kids = []) => word === "error" || kids.includes("error");

// Out of sight on the Snoozed shelf: snoozing, not settled, and not needing the person (asking, or failed).
export function hidden(k, word, kids = [], now = Date.now()) {
  return !stillSettled(k, word, kids) && napping(k, now) && word !== "blocked" && !kids.includes("blocked") && !failed(word, kids);
}

// Not news: settled, or snoozed and out of sight. What every "waits for you" mark leaves out.
export const notNews = (k, word, kids = [], now = Date.now()) => stillSettled(k, word, kids) || hidden(k, word, kids, now);

// Which of its labels are stale and should be cleared now (what anyone who sees it may do; the clear is idempotent):
// settled once there's new work; snoozed on a failure. (A new turn in view and Woke seen are the views' own.)
export function stale(k, word, kids = []) {
  return {
    settled: Boolean(k?.labels?.[SETTLED]) && !stillSettled(k, word, kids),
    snoozed: snoozedUntil(k) > 0 && failed(word, kids),
  };
}

// ---- a task's rest ------------------------------------------------------------------------------------------------
// live: its agents ([{ address, status, turn, role, settled?, snoozed? }]: settled and snoozed are the raw label
// values); helpers: its worker's helper agents (their status words). task.attention_at after the settle is new work
// too (failing checks, a conflict). Reviewers don't count (theirs is the worker's turn).
// -> null, or { rest: "settled", at } | { rest: "snoozed", until } | { rest: null, until, showing: true } (snoozed
// but it needs the person) | { rest: null, woke: until } (woke, not looked at yet).
export function taskRest(task, live = [], helpers = [], now = Date.now()) {
  const own = live.filter((a) => a.role !== "reviewer");
  if (!own.length) return null;
  const kids = helpers.map((h) => h.status).filter(Boolean);
  const term = (a) => ({ labels: { [SETTLED]: a.settled, [SNOOZED]: a.snoozed }, turn: a.turn });
  const settled = own.map((a) => parseSettled(a.settled));
  if (settled.every(Boolean) && own.every((a) => stillSettled(term(a), a.status, kids))) {
    const at = Math.max(...settled.map((s) => s.at));
    if (!(task?.attention && (task.attention_at ?? 0) > at)) return { rest: SETTLED, at };
  }
  const until = Math.max(0, ...own.map((a) => Number(a.snoozed) || 0));
  if (!until) return null;
  if (until <= now) return { rest: null, woke: until };
  const asks = own.some((a) => a.status === "blocked" || a.status === "error") || kids.some((s) => s === "blocked" || s === "error")
    || Boolean(task?.attention);
  return asks ? { rest: null, until, showing: true } : { rest: SNOOZED, until };
}

// A live agent's entry as taskRest() reads it, from its terminal (hc ls / terminals() / the hub's record).
export const restFields = (k) => ({ settled: k?.labels?.[SETTLED] || null, snoozed: k?.labels?.[SNOOZED] || null });

// ---- words --------------------------------------------------------------------------------------------------------
export const REST = {
  settle: "Settle", unsettle: "Unsettle", snooze: "Snooze", wake: "Wake",
  settled: "Settled", snoozed: "Snoozed", woke: "Woke",
  // the toast right after a settle (click it to undo), and after a snooze
  settledToast: (what) => ({ title: `Settled ${what}`, body: "Click to undo." }),
  snoozedToast: (what, when) => ({ title: `Snoozed ${what}`, body: `Wakes ${when}. Click to undo.` }),
  // why it can't: no live agent to label
  noAgent: "It has no live agent to settle or snooze.",
  past: "That time has passed. Choose another.",
};
// The groups at the end of a list (after everything else, as T3's): Snoozed (with its wake time), Settled (folded).
export const REST_GROUPS = [SNOOZED, SETTLED];
