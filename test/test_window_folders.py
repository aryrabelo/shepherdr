"""The person's space folders in the window's sidebar (ASH-15): mods/spaces-chat/folders.js reads
~/.config/herdr-space-folders.json (core/folders.js) and writes folds and drags back to it. Run here under node with
Herdr's file API faked over an in-memory home (the window's runtime isn't on this machine); never the real file."""
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


# folders.js with its imports swapped: files is the fake home; writeTextFile refuses a stale `expected`, as Herdr's;
# `race` changes the file once just before the next write (another layout saving meanwhile).
HARNESS = r"""
const PATH = "/h/.config/herdr-space-folders.json";
const files = {}, writes = [];
let race = null;
const home = () => "/h";
const readTextFile = async (p) => files[p] ?? null;
const writeTextFile = async (p, text, expected) => {
  if (race) { files[p] = race; race = null; }
  if ((files[p] ?? null) !== expected) throw new Error("stale");
  writes.push(text);
  files[p] = text;
  return null;
};
CORE
SOURCE
const tasks = [];
const cx = { notified: 0, notify() { this.notified++; }, spawn(body) { tasks.push(body(cx)); }, timer: { every() {} } };
const settle = async () => { while (tasks.length) await tasks.shift(); };
const file = () => (files[PATH] ? JSON.parse(files[PATH]) : null);
const AT = 1793812463000;
const DATA = { list: [{ id: "a", name: "Alter", folded: false, match: "~/alter" }, { id: "b", name: "Bora", folded: true, match: "~/bora" }], of: {}, at: AT };
const out = {};

const f = new SpaceFolders();
f.start(cx); await settle();
out.missing = f.data;
f.fold(cx, "a"); await settle();
out.missingMade = PATH in files;

files[PATH] = JSON.stringify(DATA);
f.read(cx); await settle();
out.read = f.data?.list.map((x) => x.id) ?? null;

// an older copy (a backup put back) is ignored; a newer one is taken
files[PATH] = JSON.stringify({ ...DATA, at: AT - 5, list: [] });
f.read(cx); await settle();
out.olderIgnored = f.data.list.length;
files[PATH] = JSON.stringify({ ...DATA, at: AT + 1 });
f.read(cx); await settle();
out.newerAt = f.data.at;

// a fold: shown at once, then written, at past the one read
f.fold(cx, "b");
out.foldShownAtOnce = f.folded("b");
await settle();
out.foldWritten = file().list.find((x) => x.id === "b").folded;
out.foldAt = file().at > AT + 1;

// a drag in: of; out of a folder its rules take it to: ""; back out of one none take it to: gone from of
// (a home built, so the repo's no-home-paths rule has nothing to find)
const U = ["", "Users", "x"].join("/");
f.put(cx, "s1", "a", `${U}/elsewhere`); await settle();
out.dragIn = file().of.s1;
f.put(cx, "s1", null, `${U}/alter/app`); await settle();
out.dragOutRule = file().of.s1;
f.put(cx, "s1", null, `${U}/elsewhere`); await settle();
out.dragOutNone = "s1" in file().of;

// another layout saved between the read and the write: done again over its copy, both kept
const before = writes.length;
const raced = file().at + 1000;
race = JSON.stringify({ ...file(), at: raced, list: [...file().list, { id: "c", name: "New" }] });
f.put(cx, "s2", "b", "/x"); await settle();
out.raceWrites = writes.length - before;
out.raceKept = file().list.map((x) => x.id);
out.raceOf = file().of.s2;
out.raceAt = file().at > raced;

// nothing to change: nothing written
const n = writes.length;
f.put(cx, "s2", "b", "/x"); await settle();
out.noop = writes.length - n;

// the file gone: no folders
delete files[PATH];
f.read(cx); await settle();
out.gone = f.data;
console.log(JSON.stringify(out));
"""


class WindowFolders(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node isn't installed")
    def test_reads_and_writes_the_folders_file(self):
        src = re.sub(r'^import .*?;\n', "", read("mods", "spaces-chat", "folders.js"), flags=re.M | re.S)
        core = f'import {{ keepFolders, foldersPath, foldersText, withFolderFolded, withSpaceIn }} from "file://{J("core", "folders.js")}";'
        script = HARNESS.replace("CORE", core).replace("SOURCE", src)
        r = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertIsNone(out["missing"])
        self.assertFalse(out["missingMade"], "a missing file is never made")
        self.assertEqual(out["read"], ["a", "b"])
        self.assertEqual(out["olderIgnored"], 2, "a copy whose at doesn't go up is ignored")
        self.assertEqual(out["newerAt"], 1793812463001)
        self.assertFalse(out["foldShownAtOnce"])
        self.assertFalse(out["foldWritten"])
        self.assertTrue(out["foldAt"])
        self.assertEqual(out["dragIn"], "a")
        self.assertEqual(out["dragOutRule"], "")
        self.assertFalse(out["dragOutNone"])
        self.assertEqual(out["raceWrites"], 1)
        self.assertEqual(out["raceKept"], ["a", "b", "c"])
        self.assertEqual(out["raceOf"], "b")
        self.assertTrue(out["raceAt"], "the write goes past the at of the copy it was done over")
        self.assertEqual(out["noop"], 0)
        self.assertIsNone(out["gone"])

    def test_sidebar_wiring(self):
        main = read("mods", "spaces-chat", "main.js")
        # this computer's spaces go in folders, under the machine, before those in none; pinned and sectioned ones don't
        self.assertIn('const out = m === null ? this.foldered(loose, t)', main)
        self.assertIn("const loose = this.ordered(list.filter((r) => !filed.has(r.w.id)));", main)
        self.assertIn('const all = visible.filter((r) => !pins.includes(r.w.id));', main)
        # a folder's header folds it (written) and takes a dragged space; a drop among a folder's spaces goes in
        self.assertIn(".on_click((_e, cx) => this.folders.fold(cx, f.id))", main)
        self.assertIn('this.drag(`folder:${f.id}`, null, cx)', main)
        self.assertIn('else if (kind === "folder")', main)
        self.assertIn("this.refile(from, this.folderRows.get(id), cx)", main)
        self.assertIn("core/folders.js: spaces-chat", read("lib", "COPIES"))


if __name__ == "__main__":
    unittest.main()
