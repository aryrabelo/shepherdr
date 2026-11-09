"""Settle and Snooze in the window (ASH-12): lib/rest.js runs herdr-task for every surface (the Tasks row menu, the
Assistant's header, the chat's key) and undoes from its toast; the lists and counts leave settled and snoozed work out.
lib/rest.js runs here under node with Herdr's API faked (the window's runtime isn't on this machine)."""
import json
import os
import re
import shutil
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda *p: os.path.join(ROOT, *p)


def read(*p):
    with open(J(*p), encoding="utf-8") as f:
        return f.read()


# lib/rest.js with Herdr's API and ui.js swapped for fakes: exec records each herdr-task call and answers from `answers`;
# its core/settle.js is the real one (its import pointed at the source: node_script).
HARNESS = r"""
const calls = [], toasts = [], store = {};
const answers = { settle: { ok: true, settled: ["t1"], at: 1, was_snoozed: { t1: Date.now() + 3600000 } },
  unsettle: { ok: true }, snooze: { ok: true, until: 2, when: "Tomorrow 9:00" }, wake: { ok: true } };
// gates[verb]: a promise that herdr-task's answer waits on (a slow call)
const gates = {};
const exec = async (cmd, args) => { calls.push(args); const verb = args.find((a) => answers[a]);
  if (gates[verb]) await gates[verb];
  if (answers[verb] === "refuse") return { code: 1, stdout: JSON.stringify({ error: "No." }) };
  return { code: 0, stdout: JSON.stringify(answers[verb]) }; };
const appHome = () => "/app";
const shared = (k) => store[k];
const setShared = (k, v) => { store[k] = v; };
const toast = (n) => toasts.push(n);
const plainError = (e) => String(e?.message ?? e);
SOURCE
const tick = () => new Promise((r) => setTimeout(r, 0));
const out = {};
out.agentHere = targetArgs({ agent: "t7" });
out.agentThere = targetArgs({ agent: "vm/t7" });
out.task = targetArgs({ machine: "vm", folder: "/w", ref: "HERD-3" });
store["tasks.pinned"] = ["vm:/w#3"];
await settle({ machine: "vm", folder: "/w", ref: "HERD-3" }, "HERD-3", { pin: "vm:/w#3" });
await tick();
out.pinsAfterSettle = store["tasks.pinned"];
out.toast = toasts[0];
// the row moved at once (ASH-14): a settled mark by its key, before and after herdr-task answered
out.markAfterSettle = store["tasks.restnow"]?.["task:vm:/w:HERD-3"]?.rest ?? null;
undoRest(Number(toasts[0].action.name.split("undo-rest-")[1]));
// ASH-14 review: the undo put the snooze the settle ended back: snoozed until then at once, not awake
out.markOnUndo = store["tasks.restnow"]?.["task:vm:/w:HERD-3"] ?? null;
out.wasSnoozed = answers.settle.was_snoozed.t1;
await tick();
out.pinsAfterUndo = store["tasks.pinned"];
out.calls = calls;
out.leftAfterUndo = store["tasks.rested"].length;
await snooze({ agent: "t7" }, "the Assistant", { in: "3h", label: "In 3 hours" });
await tick();
out.snoozeToast = toasts[1];
undoRest(Number(toasts[1].action.name.split("undo-rest-")[1]));
await tick();
out.lastCall = calls[calls.length - 1];
out.markAfterSnoozeUndo = "agent:t7" in (store["tasks.restnow"] ?? {}) ? store["tasks.restnow"]["agent:t7"].rest : "none";
// ASH-14 review: a slow Snooze answering after a Wake on the same row leaves the Wake's mark (awake) alone; recheck item
// 3: both asked in the same millisecond (the clock held still), so only each request's own number tells them apart
let open;
gates.snooze = new Promise((r) => { open = r; });
const realNow = Date.now, held = realNow();
Date.now = () => held;
const slow = snooze({ agent: "t8" }, "t8", { in: "1h", label: "In 1 hour" });
await tick();
await wake({ agent: "t8" }, "t8");
open();
await slow;
await tick();
out.sameMs = store["tasks.restnow"]?.["agent:t8"]?.at === held;
out.markAfterLateSnooze = "agent:t8" in (store["tasks.restnow"] ?? {}) ? store["tasks.restnow"]["agent:t8"].rest : "none";
Date.now = realNow;
delete gates.snooze;
// and a refusal of the slow one, after the wake, leaves the wake's mark too
gates.snooze = new Promise((r) => { open = r; });
answers.snooze = "refuse";
Date.now = () => held + 1;
const refused = snooze({ agent: "t6" }, "t6", { in: "1h", label: "In 1 hour" });
await tick();
await wake({ agent: "t6" }, "t6");
open();
await refused;
await tick();
out.markAfterLateRefusal = "agent:t6" in (store["tasks.restnow"] ?? {}) ? store["tasks.restnow"]["agent:t6"].rest : "none";
Date.now = realNow;
delete gates.snooze;
// a refusal takes the mark back
answers.settle = "refuse";
await settle({ agent: "t9" }, "t9").catch(() => {});
await tick();
out.markAfterRefusal = "agent:t9" in (store["tasks.restnow"] ?? {});
console.log(JSON.stringify(out));
"""


# chat.settle (lib/rest.js settleInView, mods/chat settleKey) on what's in view, faked as above; files: what readTextFile
# reads (a task's list on its machine).
KEY_HARNESS = r"""
const calls = [], toasts = [], store = {}, reads = [];
const answers = { settle: { ok: true, settled: [], at: 1, was_snoozed: {} }, unsettle: { ok: true }, snooze: { ok: true }, wake: { ok: true } };
const exec = async (cmd, args) => { calls.push(args); const verb = args.find((a) => answers[a]); return { code: 0, stdout: JSON.stringify(answers[verb]) }; };
const appHome = () => "/app";
const home = () => "/home/me";
const files = {};
const readTextFile = async (path, opts) => { reads.push([path, opts?.on ?? null]); if (!(path in files)) throw new Error("no file"); return files[path]; };
const shared = (k) => store[k];
const setShared = (k, v) => { store[k] = v; };
const toast = (n) => toasts.push(n);
const plainError = (e) => String(e?.message ?? e);
SOURCE
const NOW = Date.now();
const task = { machine: "vm", folder: "/w", ref: "HERD-3", slug: "w", id: 3 };
const list = (t) => JSON.stringify({ folder: "/w", tasks: [{ id: 3, state: "running", started: NOW - 9000, agents: [{ address: "t1", at: NOW - 9000 }], ...t }] });
// each from a clean slate: the marks a previous run left (a settle marks its row) aside
const run = async (view, marks = {}) => { calls.length = 0; store["tasks.restnow"] = marks; const verb = await settleInView({ what: "x", ...view }); return { verb, calls: calls.map((c) => c.join(" ")) }; };
const out = {};
// a task's thread whose agent has ended, settled (kept on the task): the key unsettles it, on its machine
files["/home/me/.herdr/tasks/w.json"] = list({ settled_at: NOW - 1000 });
out.kept = await run({ task });
// the same, not settled: the key settles it (no live agent needed)
files["/home/me/.herdr/tasks/w.json"] = list({});
out.stopped = await run({ task });
// its list unreadable: not known to be settled, so it settles
delete files["/home/me/.herdr/tasks/w.json"];
out.noFile = await run({ task });
// an agent of its own at work or asking: nothing (its turn would end the settle)
out.working = await run({ live: { address: "t4", turn: 2, status: "working", labels: {} }, agent: "t4" });
out.asking = await run({ live: { address: "t4", turn: 2, status: "blocked", labels: {} }, agent: "t4" });
// settled by its label: unsettled; settled a moment ago from its row (its mark; the label not read yet): unsettled too
out.labelled = await run({ live: { address: "t4", turn: 2, status: "idle", labels: { settled: `${NOW}:2` } }, agent: "t4" });
out.marked = await run({ live: { address: "t4", turn: 2, status: "idle", labels: {} }, agent: "t4" }, { "agent:t4": { rest: "settled", at: NOW, seq: 1 } });
out.reads = reads;
console.log(JSON.stringify(out));
"""


def node_script(body):
    """lib/rest.js inside a harness: Herdr's API and ui.js as the harness fakes them, core/settle.js the real source."""
    src = read("lib", "rest.js")
    src = src.replace('from "./core/settle.js"', f'from "file://{J("core", "settle.js")}"')
    src = re.sub(r'^import .*? from "(herdr|\./ui\.js)";\n', "", src, flags=re.M)
    return body.replace("SOURCE", src)


class WindowRest(unittest.TestCase):
    def run_harness(self):
        if not shutil.which("node"):
            self.skipTest("node isn't installed")
        script = node_script(HARNESS)
        r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_rest_runs_herdr_task_and_undoes(self):
        out = self.run_harness()
        # another machine's agent goes by its own address there, through --on
        self.assertEqual(out["agentHere"], {"machine": None, "args": ["--agent", "t7"]})
        self.assertEqual(out["agentThere"], {"machine": "vm", "args": ["--agent", "t7"]})
        self.assertEqual(out["task"], {"machine": "vm", "args": ["HERD-3", "--folder", "/w"]})
        settle, unsettle = out["calls"][0], out["calls"][1]
        self.assertEqual(settle, ["--on", "vm", "settle", "HERD-3", "--folder", "/w", "--json"])
        # settling takes the pin; its toast undoes it all: the pin back, the snooze it ended back
        self.assertEqual(out["pinsAfterSettle"], [])
        self.assertEqual(out["toast"]["title"], "Settled HERD-3")
        self.assertTrue(out["toast"]["action"]["name"].startswith("tabs-tasks.undo-rest-"))
        self.assertEqual(unsettle[:6], ["--on", "vm", "unsettle", "HERD-3", "--folder", "/w"])
        self.assertIn("--snooze-until", unsettle)
        self.assertEqual(out["pinsAfterUndo"], ["vm:/w#3"])
        self.assertEqual(out["leftAfterUndo"], 0, "an undo is used once")
        # a snooze says when it wakes, and its undo wakes it
        self.assertEqual(out["snoozeToast"]["title"], "Snoozed the Assistant")
        self.assertIn("Tomorrow 9:00", out["snoozeToast"]["body"])
        self.assertEqual(out["lastCall"], ["wake", "--agent", "t7", "--json"])
        # ASH-14: each verb marks its row at once (shared "tasks.restnow"); a wake's mark is "awake" (null); a refusal
        # takes it back
        self.assertEqual(out["markAfterSettle"], "settled")
        self.assertIsNone(out["markAfterSnoozeUndo"])
        self.assertFalse(out["markAfterRefusal"])

    def test_settle_key_on_what_is_in_view(self):
        """ASH-14 recheck (item 1): Ctrl+Shift+S in the window (mods/chat settleKey -> lib/rest.js settleInView) reaches a
        task's thread with no live agent (its kept settle, read from its list's file on its machine) and goes by what
        shows now (a live agent's label, its row's mark); never over an agent at work or asking."""
        if not shutil.which("node"):
            self.skipTest("node isn't installed")
        r = subprocess.run(["node", "--input-type=module", "-e", node_script(KEY_HARNESS)], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        task = "--on vm {} HERD-3 --folder /w --json"
        self.assertEqual(out["kept"], {"verb": "unsettle", "calls": [task.format("unsettle")]})
        self.assertEqual(out["stopped"], {"verb": "settle", "calls": [task.format("settle")]})
        self.assertEqual(out["noFile"], {"verb": "settle", "calls": [task.format("settle")]})
        self.assertEqual(out["working"], {"verb": None, "calls": []})
        self.assertEqual(out["asking"], {"verb": None, "calls": []})
        self.assertEqual(out["labelled"], {"verb": "unsettle", "calls": ["unsettle --agent t4 --json"]})
        self.assertEqual(out["marked"], {"verb": "unsettle", "calls": ["unsettle --agent t4 --json"]})
        # the task's list, on the task's machine
        self.assertEqual(out["reads"], [["/home/me/.herdr/tasks/w.json", "vm"]] * 3)
        # mods/chat's key goes through it
        key = read("mods", "chat", "main.js")
        self.assertIn("settleInView({ live: k, task, agent: this.addr", key)

    def test_review_undo_snooze_back_and_late_answers(self):
        """ASH-14 review (items 4 and 7): undoing a settle that ended a snooze marks the row snoozed until then at
        once, never awake; a slow Snooze's answer after a Wake on the same row leaves the Wake's mark alone."""
        out = self.run_harness()
        self.assertEqual((out["markOnUndo"]["rest"], out["markOnUndo"]["until"]), ("snoozed", out["wasSnoozed"]))
        self.assertIsNone(out["markAfterLateSnooze"])
        # recheck (item 3): in one millisecond too, a late answer or a late refusal; the wake's mark stays
        self.assertTrue(out["sameMs"])
        self.assertIsNone(out["markAfterLateRefusal"])

    def test_window_wiring(self):
        """Every surface goes through rest.js and core's lists; what counts as news leaves rest out."""
        menu = read("mods", "tasks-menu", "main.js")
        for n in ("restMenu", "taskMenu", "rest: p.rest", "from \"./rest.js\""):
            self.assertIn(n, menu)
        head = read("mods", "pane-chat", "main.js")
        for n in ("restMenu", "menu: \"rest\"", "wakeSeen", "from \"./rest.js\""):
            self.assertIn(n, head)
        chat = read("mods", "chat", "main.js")
        for n in ('c === "settle"', "settleKey", "wakeSeen", "notNews"):
            self.assertIn(n, chat)
        self.assertIn('c.startsWith("undo-rest-")', read("mods", "tabs-tasks", "main.js"))
        tasks = read("mods", "tasks", "main.js")
        for n in ("REST.snoozed", "REST.settled", '"settled:open"', "openRowMenu(pin)", "taskCan("):
            self.assertIn(n, tasks)
        # a task live, its marks and its menus: lib/taskthread.js, the Tasks panel's and the sidebar's threads' (ASH-14)
        thread = read("lib", "taskthread.js")
        for n in ("restFields(k)", "rest: pin.rest", "shownRest", 'menu: "rest"'):
            self.assertIn(n, thread)
        self.assertRegex(read("lib", "COPIES"), r"(?m)^taskthread\.js: .*\bspaces-chat\b")
        sidebar = read("mods", "spaces-chat", "threads.js")
        for n in ("threadsOf", "openRestMenu", "taskCan(", "settledOpenKey"):
            self.assertIn(n, sidebar)
        self.assertIn("notNews", read("lib", "inbox.js"))
        self.assertIn("notNews", read("lib", "parked.js"))
        self.assertIn("briefStatus(task, live)", read("mods", "jump", "main.js"))
        copies = read("lib", "COPIES")
        self.assertRegex(copies, r"(?m)^rest\.js: .*\btabs-tasks\b")
        # the key: Ctrl+Shift+S in a chat, named, in the Tasks add-on; Cmd+Shift+S stays herdr-t3-inbox's
        keys = json.loads(read("keys.json"))
        self.assertEqual(keys["mod:chat"]["ctrl-shift-s"], "chat.settle")
        self.assertNotIn("cmd-shift-s", json.dumps(keys))
        tasks_addon = next(a for a in json.loads(read("lib", "addons.json"))["addons"] if a["id"] == "tasks")
        self.assertIn("mod:chat ctrl-shift-s", tasks_addon["keys"])


if __name__ == "__main__":
    unittest.main()
