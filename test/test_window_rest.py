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


# lib/rest.js with its imports swapped for fakes: exec records each herdr-task call and answers from `answers`; the
# at-once marks are core/settle.js's own (CORE).
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
const REST = { settledToast: (w) => ({ title: `Settled ${w}`, body: "Click to undo." }),
  snoozedToast: (w, when) => ({ title: `Snoozed ${w}`, body: `Wakes ${when}. Click to undo.` }) };
CORE
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
// ASH-14 review: a slow Snooze answering after a Wake on the same row leaves the Wake's mark (awake) alone
let open;
gates.snooze = new Promise((r) => { open = r; });
const slow = snooze({ agent: "t8" }, "t8", { in: "1h", label: "In 1 hour" });
await tick();
await wake({ agent: "t8" }, "t8");
open();
await slow;
await tick();
out.markAfterLateSnooze = "agent:t8" in (store["tasks.restnow"] ?? {}) ? store["tasks.restnow"]["agent:t8"].rest : "none";
delete gates.snooze;
// a refusal takes the mark back
answers.settle = "refuse";
await settle({ agent: "t9" }, "t9").catch(() => {});
await tick();
out.markAfterRefusal = "agent:t9" in (store["tasks.restnow"] ?? {});
console.log(JSON.stringify(out));
"""


class WindowRest(unittest.TestCase):
    def run_harness(self):
        if not shutil.which("node"):
            self.skipTest("node isn't installed")
        src = read("lib", "rest.js")
        src = re.sub(r'^import .*?;\n', "", src, flags=re.M | re.S)
        core = f'import {{ PENDING, restKey, restMark, marksWith, marksAfter }} from "file://{J("core", "settle.js")}";'
        script = HARNESS.replace("CORE", core).replace("SOURCE", src)
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

    def test_review_undo_snooze_back_and_late_answers(self):
        """ASH-14 review (items 4 and 7): undoing a settle that ended a snooze marks the row snoozed until then at
        once, never awake; a slow Snooze's answer after a Wake on the same row leaves the Wake's mark alone."""
        out = self.run_harness()
        self.assertEqual((out["markOnUndo"]["rest"], out["markOnUndo"]["until"]), ("snoozed", out["wasSnoozed"]))
        self.assertIsNone(out["markAfterLateSnooze"])

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
        # ASH-14 review (item 1): the key reaches a task's thread with no live agent (its kept settle, from its list's
        # file) and what shows now (its row's mark): core keyVerb, never only a live terminal's labels
        key = chat[chat.index("  settleKey() {"):]
        key = key[:key.index("\n  }\n")]
        for n in ("keyVerb(shownRest(", "keptSettle(t)", "if (!k && !task) return;", ".herdr/tasks/${key.slug}.json"):
            self.assertIn(n, key)
        self.assertNotIn("if (!k) return;", key)
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
