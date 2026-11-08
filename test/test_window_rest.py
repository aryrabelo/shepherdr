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


# lib/rest.js with its imports swapped for fakes: exec records each herdr-task call and answers from `answers`.
HARNESS = r"""
const calls = [], toasts = [], store = {};
const answers = { settle: { ok: true, settled: ["t1"], at: 1, was_snoozed: { t1: Date.now() + 3600000 } },
  unsettle: { ok: true }, snooze: { ok: true, until: 2, when: "Tomorrow 9:00" }, wake: { ok: true } };
const exec = async (cmd, args) => { calls.push(args); const verb = args.find((a) => answers[a]); return { code: 0, stdout: JSON.stringify(answers[verb]) }; };
const appHome = () => "/app";
const shared = (k) => store[k];
const setShared = (k, v) => { store[k] = v; };
const toast = (n) => toasts.push(n);
const plainError = (e) => String(e?.message ?? e);
const REST = { settledToast: (w) => ({ title: `Settled ${w}`, body: "Click to undo." }),
  snoozedToast: (w, when) => ({ title: `Snoozed ${w}`, body: `Wakes ${when}. Click to undo.` }) };
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
undoRest(Number(toasts[0].action.name.split("undo-rest-")[1]));
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
console.log(JSON.stringify(out));
"""


class WindowRest(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node isn't installed")
    def test_rest_runs_herdr_task_and_undoes(self):
        src = read("lib", "rest.js")
        src = re.sub(r'^import .*?;\n', "", src, flags=re.M | re.S)
        script = HARNESS.replace("SOURCE", src)
        r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
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
        for n in ("restFields(k)", "REST.snoozed", "REST.settled", '"settled:open"', "rest: pin.rest"):
            self.assertIn(n, tasks)
        self.assertIn("notNews", read("lib", "inbox.js"))
        self.assertIn("notNews", read("lib", "parked.js"))
        self.assertIn("taskRest", read("mods", "jump", "main.js"))
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
