// Settle and Snooze from the window (ASH-12): the Tasks row menu (mods/tasks-menu), the Assistant's header
// (mods/pane-chat), the chat's key (mods/chat, keys.json chat.settle) and the undo on their toasts. The labels and
// rules are core/settle.js; every change goes through herdr-task (settle, unsettle, snooze, wake), the one way the
// window, the web app and agents change them, here or (--on) on the agent's machine.
// A target is a task ({ machine, folder, ref }: its live agents) or one agent ({ agent }: its terminal's address,
// "vm/t3" on another machine), an Assistant's.
// Undo: a settle's or snooze's toast runs tabs-tasks.undo-rest-<at> when clicked (the tab bar is always loaded; a mod
// command carries no args), which finds what to undo in shared "tasks.rested" (the last few, by their at).
// Shared: the source is lib/rest.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/rest.js, never a mod's copy, then run bin/sync-shared.

import { exec, appHome, shared, setShared } from "herdr";
import { toast, plainError } from "./ui.js";
import { REST, PENDING, restKey, restMark, marksWith } from "./core/settle.js";

const CLI = () => `${appHome()}/mods/tasks/bin/herdr-task`;
const RESTED = "tasks.rested";
const PINS = "tasks.pinned"; // the Tasks panel's pins (mods/tasks): settling a task takes its pin, as T3's does
const UNDO_MS = 60000;       // a toast's undo after this long does nothing (the toast itself goes after 8 s)

// What herdr-task takes for a target: where it runs (--on) and what names it.
export function targetArgs(x) {
  if (x?.ref) return { machine: x.machine ?? null, args: [x.ref, ...(x.folder ? ["--folder", x.folder] : [])] };
  const a = String(x?.agent ?? "");
  const m = a.includes("/") ? a.split("/")[0] : null;
  return { machine: m, args: ["--agent", m ? a.slice(m.length + 1) : a] };
}

// herdr-task <verb> on a target: its JSON, or throws with its words. The row moves at once (ASH-14): a mark in shared
// "tasks.restnow" (core/settle.js PENDING) the sidebar and the Tasks panel show until what they read agrees; a refusal
// takes it back, a snooze's answer gives it its wake time.
export async function restCli(verb, x, more = []) {
  const key = restKey(x);
  const put = (m) => setShared(PENDING, marksWith(shared(PENDING), key, m));
  put(restMark(verb));
  const { machine, args } = targetArgs(x);
  let out = null;
  try {
    const r = await exec(CLI(), [...(machine ? ["--on", machine] : []), verb, ...args, ...more, "--json"]);
    try { out = JSON.parse(r.stdout || "null"); } catch {}
    if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim() || "herdr-task refused it.");
  } catch (e) {
    put(null);
    throw e;
  }
  if (verb === "snooze" && out.until) put(restMark(verb, out.until));
  return out;
}

const failed = (verb, what) => (e) => toast({ level: "error", title: `Couldn't ${verb} ${what}`, body: plainError(e) });

// Keeps what a toast's click undoes: the last few, so an older toast still undoes its own.
function remember(entry) {
  const kept = (shared(RESTED) ?? []).filter((x) => Date.now() - (x?.at ?? 0) < UNDO_MS).slice(-4);
  setShared(RESTED, [...kept, entry]);
  return `tabs-tasks.undo-rest-${entry.at}`;
}

// Settle (✓): the toast says so and undoes it. A snooze it ended comes back with the undo (herdr-task settle says
// which: was_snoozed), and so does a pin it took (pin: the task's key in the Tasks panel's pins).
export function settle(x, what, { pin = null } = {}) {
  if (pin) {
    const pins = Array.isArray(shared(PINS)) ? shared(PINS) : [];
    if (pins.includes(pin)) setShared(PINS, pins.filter((k) => k !== pin)); else pin = null;
  }
  return restCli("settle", x).then((out) => {
    const was = Math.max(0, ...Object.values(out?.was_snoozed ?? {}).map(Number).filter(Number.isFinite));
    const name = remember({ kind: "settle", ...pick(x), was: was || null, pin, at: Date.now() });
    toast({ ...REST.settledToast(what), level: "info", timeout: 8000, action: { name } });
  }, (e) => {
    if (pin) setShared(PINS, [...new Set([...(Array.isArray(shared(PINS)) ? shared(PINS) : []), pin])]);
    failed("settle", what)(e);
  });
}

// Unsettle: back where it was, as news again only once something new comes.
export const unsettle = (x, what) => restCli("unsettle", x).catch(failed("unsettle", what));

// Snooze until a pick's time (core/menus.js SNOOZE_PICKS: herdr-task's --in or --at words); its toast undoes it.
export function snooze(x, what, p) {
  return restCli("snooze", x, p.in ? ["--in", p.in] : ["--at", p.at]).then((out) => {
    const name = remember({ kind: "snooze", ...pick(x), at: Date.now() });
    toast({ ...REST.snoozedToast(what, out?.when ?? p.label), level: "info", timeout: 8000, action: { name } });
  }, failed("snooze", what));
}

// Wake: off the Snoozed shelf now. quiet: a wake nobody asked for in words (a pin, a look, a message), no toast.
export const wake = (x, what, { quiet = false } = {}) => restCli("wake", x).catch(quiet ? () => {} : failed("wake", what));

// A woke agent looked at (its chat in front) or written to: its snooze is over, the Woke mark goes. Once a minute at
// most per agent, as a look comes every render.
const woken = new Map();
export function wakeSeen(agent) {
  if (!agent || Date.now() - (woken.get(agent) ?? 0) < 60000) return;
  woken.set(agent, Date.now());
  wake({ agent }, null, { quiet: true });
}

// A toast's click (tabs-tasks.undo-rest-<at>): that settle or snooze undone, once.
export function undoRest(at) {
  const all = shared(RESTED) ?? [];
  const x = all.find((e) => e?.at === at);
  if (!x || Date.now() - x.at > UNDO_MS) return;
  setShared(RESTED, all.filter((e) => e !== x));
  if (x.kind === "snooze") { wake(x, x.ref ?? "the agent"); return; }
  if (x.pin) {
    const pins = Array.isArray(shared(PINS)) ? shared(PINS) : [];
    if (!pins.includes(x.pin)) setShared(PINS, [...pins, x.pin]);
  }
  restCli("unsettle", x, x.was > Date.now() ? ["--snooze-until", String(x.was)] : []).catch(failed("undo the settle of", x.ref ?? "the agent"));
}

const pick = (x) => (x.ref ? { machine: x.machine ?? null, folder: x.folder ?? null, ref: x.ref } : { agent: x.agent });
