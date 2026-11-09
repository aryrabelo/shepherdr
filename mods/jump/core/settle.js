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
// A task is its live agents': settled when each of them still is (and nothing failed since), snoozed while one is. A task
// with no live agent settles too (ASH-14): herdr-task keeps the settle on the task (settled_at) until it has new work.
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
// too (failing checks, a conflict). Reviewers don't count (theirs is the worker's turn). With no live agent of its own,
// a settle herdr-task kept on the task itself (keptSettle, ASH-14).
// -> null, or { rest: "settled", at } | { rest: "snoozed", until } | { rest: null, until, showing: true } (snoozed
// but it needs the person) | { rest: null, woke: until } (woke, not looked at yet).
export function taskRest(task, live = [], helpers = [], now = Date.now()) {
  const own = live.filter((a) => a.role !== "reviewer");
  if (!own.length) return keptSettle(task);
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

// ASH-14: a task settled with no live agent to label (stopped, queued, its agent closed): herdr-task keeps when on the
// task itself (task.settled_at). New work ends it: a start or resume since (task.started), an agent started for it since
// (task.agents[].at), failing checks or a conflict found since (task.attention_at). While a live agent of its own runs,
// its labels say instead (taskRest). A done task has none.
export function keptSettle(task) {
  const at = Number(task?.settled_at) || 0;
  if (!at || task.state === "done") return null;
  const since = (x) => (Number(x) || 0) > at;
  if (since(task.started) || since(task.attention_at) || (Array.isArray(task.agents) ? task.agents : []).some((a) => since(a?.at))) return null;
  return { rest: SETTLED, at };
}

// An agent of its own (an Assistant, an agent opened in a tab): settled (until new work), snoozed (out of sight until
// `until`), or woke (its snooze ran out, not looked at yet: the label stays until then). One asking you is never out of
// sight: { rest: null, until, showing: true }. k: its terminal (labels, turn, status).
export function agentRest(k, now = Date.now()) {
  if (!k) return null;
  const word = wordOf(k), until = snoozedUntil(k);
  if (stillSettled(k, word)) return { rest: SETTLED, at: parseSettled(k.labels?.[SETTLED])?.at ?? null };
  if (hidden(k, word, [], now)) return { rest: SNOOZED, until };
  if (woke(k, now)) return { rest: null, woke: until };
  return until > now ? { rest: null, until, showing: true } : null;
}

// What can be put away from a row: a task settles unless it is done (with no live agent too: keptSettle); it snoozes
// only with a live agent of its own to label. live: its live agents.
export const taskCan = (section, live = []) => ({ settle: section !== "done", snooze: live.some((a) => a.role !== "reviewer") });

// ---- at once (ASH-14) ---------------------------------------------------------------------------------------------
// A row put away (or back) moves the moment it's asked, not when herdr-task's labels or the task's file come back: the
// asker keeps a mark { rest: "settled" | "snoozed" | null, until?, at, seq } by the row's key (restKey) for PENDING_MS at
// most, and the views show it until what they read agrees (shownRest). A refusal drops it. An answer only touches the
// mark its own request set (marksAfter, by its seq): a later action on the same row wins over an earlier one's late
// answer, in the same millisecond too.
export const PENDING_MS = 20000;
// the window's marks, in its shared state (lib/rest.js writes them; the sidebar and the Tasks panel read them)
export const PENDING = "tasks.restnow";
// the marks with one set (mark) or dropped (null), the ones past PENDING_MS gone
export function marksWith(marks, key, mark, now = Date.now()) {
  const out = Object.fromEntries(Object.entries(marks ?? {}).filter(([k, m]) => k !== key && now - (m?.at ?? 0) <= PENDING_MS));
  return mark ? { ...out, [key]: mark } : out;
}
// The marks after an answer to the request that set `asked`: its mark replaced (mark) or dropped (null), unless a newer
// request on that row has set its own meanwhile; then they stay as they are. A request is its seq (its time can be
// another's: two in one millisecond).
export function marksAfter(marks, key, asked, mark, now = Date.now()) {
  const m = (marks ?? {})[key];
  return m && m.seq === asked?.seq && m.at === asked?.at ? marksWith(marks, key, mark, now) : marks ?? {};
}
// a row's key for its mark: a task (its machine, folder and id) or an agent (its address)
export const restKey = (x) => (x?.ref ? `task:${x.machine ?? ""}:${x.folder ?? ""}:${x.ref}` : `agent:${x?.agent ?? ""}`);
// Each request's own number. It starts at random: every mod of the window has its own copy of this file, all writing one
// shared set of marks, so two copies' numbers never meet by chance.
let seq = Math.floor(Math.random() * 1e9);
// the mark for a verb asked now: settle, unsettle, snooze (its wake time, when known), wake. An answer's mark keeps its
// request's at and seq (asked: that request's mark).
export const restMark = (verb, until = null, at = Date.now(), asked = null) => ({ rest: verb === "settle" ? SETTLED : verb === "snooze" ? SNOOZED : null,
  ...(verb === "snooze" && until ? { until } : {}), at: asked?.at ?? at, seq: asked?.seq ?? ++seq });
// -> { info: the rest to show, keep: whether the mark still counts }. info as taskRest's. What's read agrees with the
// mark once it has the same rest and, for a snooze, the same wake time (a snooze moved to another time keeps the mark
// until the new time is read); for a mark of none (Unsettle, Wake), once no snooze is set either (a snooze showing
// because it needs you still has one).
const agrees = (info, mark) => (info?.rest ?? null) === mark.rest
  && (mark.rest === SNOOZED ? !mark.until || info?.until === mark.until : mark.rest === null ? !info?.until : true);
export function shownRest(info, mark, now = Date.now()) {
  if (!mark || now - (mark.at ?? 0) > PENDING_MS) return { info, keep: false };
  if (agrees(info, mark)) return { info, keep: false };
  if (mark.rest === SETTLED) return { info: { rest: SETTLED, at: mark.at }, keep: true };
  if (mark.rest === SNOOZED) return { info: { rest: SNOOZED, until: mark.until ?? null }, keep: true };
  return { info: null, keep: true };
}

// chat.settle (Ctrl+Shift+S) on what's in view, as it shows now (info: its rest, its mark applied: shownRest): Unsettle
// once settled; else Settle, unless its agent is at work or asking (word: its status; a task with no live agent: none),
// whose turn would end the settle at once. -> "settle" | "unsettle" | null.
export const keyVerb = (info, word = null) => (info?.rest === SETTLED ? "unsettle" : busy(word) ? null : "settle");

// ---- words --------------------------------------------------------------------------------------------------------
export const REST = {
  settle: "Settle", unsettle: "Unsettle", snooze: "Snooze", wake: "Wake",
  settled: "Settled", snoozed: "Snoozed", woke: "Woke",
  // the toast right after a settle (click it to undo), and after a snooze
  settledToast: (what) => ({ title: `Settled ${what}`, body: "Click to undo." }),
  snoozedToast: (what, when) => ({ title: `Snoozed ${what}`, body: `Wakes ${when}. Click to undo.` }),
  // why it can't: no live agent to label (--agent); a task with none settles (kept on the task) but can't snooze
  noAgent: "It has no live agent to settle or snooze.",
  noSnooze: "It has no live agent to snooze.",
  past: "That time has passed. Choose another.",
};
// The groups at the end of a list (after everything else, as T3's): Snoozed (with its wake time), Settled (folded).
export const REST_GROUPS = [SNOOZED, SETTLED];
