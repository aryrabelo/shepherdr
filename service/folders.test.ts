// ASH-15: the service's side of the person's space folders, over a temp file standing in for
// ~/.config/herdr-space-folders.json (never the real one in tests).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Folders, folderGroups, changeFolders, readText, LOCK_STALE } from "./folders.ts";
import { withFolderFolded } from "../core/folders.js";

const dir = () => mkdtempSync(join(tmpdir(), "shep-folders-"));
const AT = 1_793_812_463_000;
const DATA = {
  list: [
    { id: "a", name: "Alter", folded: false, color: "ansi2", path: "~/alter", match: "~/alter" },
    { id: "b", name: "Bora", folded: true, color: null, path: "~/bora", match: "~/bora" },
  ],
  of: {},
  at: AT,
};

test("no file: no folders, and one is never made reading it", () => {
  const d = dir();
  const path = join(d, "herdr-space-folders.json");
  const f = new Folders(path);
  expect(f.read()).toBeNull();
  expect(readText(path)).toBeNull();
  rmSync(d, { recursive: true, force: true });
});

test("a copy only counts when its at goes up", () => {
  const d = dir();
  const path = join(d, "f.json");
  writeFileSync(path, JSON.stringify(DATA));
  const f = new Folders(path);
  f.read();
  expect(f.data?.list.length).toBe(2);
  writeFileSync(path, JSON.stringify({ ...DATA, at: AT - 1, list: [] }));
  f.read();
  expect(f.data?.list.length).toBe(2);
  writeFileSync(path, JSON.stringify({ ...DATA, at: AT + 1, list: [] }));
  f.read();
  expect(f.data?.list.length).toBe(0);
  rmSync(d, { recursive: true, force: true });
});

test("fold toggles and bumps at, written over the text it was read from", () => {
  const d = dir();
  const path = join(d, "f.json");
  writeFileSync(path, JSON.stringify(DATA));
  const f = new Folders(path);
  f.read();
  f.change((x) => ({ ...x, list: x.list.map((y) => (y.id === "a" ? { ...y, folded: true } : y)), at: Date.now() }));
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.list.find((x: any) => x.id === "a").folded).toBe(true);
  expect(onDisk.at).toBeGreaterThan(AT);
  rmSync(d, { recursive: true, force: true });
});

test("a stale disk copy between read and rename: retried over the newer one, nothing lost", () => {
  const d = dir();
  const path = join(d, "f.json");
  writeFileSync(path, JSON.stringify(DATA));
  let reads = 0;
  const op = (x: typeof DATA) => {
    reads++;
    // the first read sees the original text; a save lands before the rename, forcing a retry
    if (reads === 1) writeFileSync(path, JSON.stringify({ ...DATA, at: DATA.at + 1000, list: [...DATA.list, { id: "c", name: "New", folded: false }] }));
    return { ...x, of: { ...x.of, s1: "a" }, at: Date.now() + reads };
  };
  const next = changeFolders(path, null, op as any);
  expect(reads).toBe(2);
  expect(next?.list.map((x) => x.id)).toEqual(["a", "b", "c"]);
  expect(next?.of.s1).toBe("a");
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.of.s1).toBe("a");
  expect(onDisk.list.map((x: any) => x.id)).toEqual(["a", "b", "c"]);
  rmSync(d, { recursive: true, force: true });
});

test("no change: nothing written", () => {
  const d = dir();
  const path = join(d, "f.json");
  writeFileSync(path, JSON.stringify(DATA));
  const before = readFileSync(path, "utf8");
  const next = changeFolders(path, null, (x) => x);
  expect(next).toEqual(DATA as any);
  expect(readFileSync(path, "utf8")).toBe(before);
  rmSync(d, { recursive: true, force: true });
});

const space = (id: string, over: Partial<{ machine: string | null; folder: string; place: string; pinned: boolean; section: string | null; git: { linked: boolean; repo: string } | null }> = {}) =>
  ({ id, machine: null, folder: "", pinned: false, section: null, git: null, ...over });
// a home built, so the repo's no-home-paths rule has nothing to find
const H = ["", "Users", "u"].join("/");

test("which spaces go in which folder: pinned and sectioned excluded, rule precedence, of override, other machines never", () => {
  const d = { ...DATA, of: { s3: "b" } };
  const { groups, shown } = folderGroups(d, [
    space("s1", { folder: `${H}/alter/app` }),
    space("s2", { folder: `${H}/bora` }),
    space("s3", { folder: `${H}/alter` }), // dragged into b (of) over its own rule (a)
    space("pinned-one", { folder: `${H}/alter`, pinned: true }),
    space("sectioned-one", { folder: `${H}/alter`, section: "sec1" }),
    space("vm/s4", { machine: "vm", folder: `${H}/alter` }),
    space("loose", { folder: `${H}/other` }),
  ] as any);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  expect(byId["f:a"].spaces).toEqual(["s1"]);
  expect(byId["f:b"].spaces).toEqual(["s2", "s3"]);
  expect(byId["f:a"].folded).toBe(false);
  expect(byId["f:b"].folded).toBe(true);
  expect(byId["f:a"].color).toBe("#3fae6a");
  expect(byId["f:b"].color).toBeUndefined();
  // item 6: only a space listed in a folder counts as in one (a pinned or sectioned space isn't taken out by a move)
  expect(shown.get("s1")).toBe("a");
  expect(shown.get("loose")).toBeNull();
  expect(shown.has("pinned-one")).toBe(false);
  expect(shown.has("sectioned-one")).toBe(false);
});

test("where it works now (its first terminal's live folder) beats where it was made (item 2)", () => {
  const { groups } = folderGroups(DATA, [space("s1", { folder: `${H}/other`, place: `${H}/bora/x` })] as any);
  expect(groups.find((g) => g.id === "f:b")?.spaces).toEqual(["s1"]);
});

test("a worktree space follows its repo's main checkout on this machine", () => {
  const { groups } = folderGroups(DATA, [
    space("repo", { folder: `${H}/alter/app`, git: { linked: false, repo: "/x/.git" } }),
    space("wt", { folder: `${H}/.herdr/worktrees/app/br`, git: { linked: true, repo: "/x/.git" } }),
  ] as any);
  expect(groups.find((g) => g.id === "f:a")?.spaces).toEqual(["repo", "wt"]);
});

test("item 7: its repo pinned or in a section, a worktree space still follows it", () => {
  for (const over of [{ pinned: true }, { section: "sec1" }]) {
    const { groups } = folderGroups(DATA, [
      space("repo", { folder: `${H}/alter/app`, git: { linked: false, repo: "/x/.git" }, ...over }),
      space("wt", { folder: `${H}/.herdr/worktrees/app/br`, git: { linked: true, repo: "/x/.git" } }),
    ] as any);
    expect(groups.find((g) => g.id === "f:a")?.spaces).toEqual(["wt"]);
  }
});

test("no file: no folders at all", () => {
  expect(folderGroups(null, [space("s1", { folder: `${H}/alter` })] as any).groups).toEqual([]);
});

test("item 1: a fold sets the state it was tapped to, over a newer copy too (never a toggle done again)", () => {
  const d = dir();
  const path = join(d, "f.json");
  // another layout already folded "a" meanwhile (a newer at)
  writeFileSync(path, JSON.stringify({ ...DATA, at: AT + 500, list: DATA.list.map((x) => (x.id === "a" ? { ...x, folded: true } : x)) }));
  const next = changeFolders(path, DATA as any, (x) => withFolderFolded(x, "a", true));
  expect(next?.list.find((x) => x.id === "a")?.folded).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).list.find((x: any) => x.id === "a").folded).toBe(true);
  rmSync(d, { recursive: true, force: true });
});

test("item 3: a write waits for the lock; a held one blocks it, a stale one is cleared", () => {
  const d = dir();
  const path = join(d, "f.json");
  writeFileSync(path, JSON.stringify(DATA));
  const before = readFileSync(path, "utf8");
  writeFileSync(`${path}.lock`, "");
  const op = (x: any) => withFolderFolded(x, "a", true);
  changeFolders(path, null, op);
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(existsSync(`${path}.lock`)).toBe(true);
  // left behind long ago: cleared, and the next write goes in (and lets go of its own lock)
  utimesSync(`${path}.lock`, new Date(Date.now() - LOCK_STALE - 1000), new Date(Date.now() - LOCK_STALE - 1000));
  const next = changeFolders(path, null, op);
  expect(next?.list.find((x) => x.id === "a")?.folded).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).list.find((x: any) => x.id === "a").folded).toBe(true);
  expect(existsSync(`${path}.lock`)).toBe(false);
  rmSync(d, { recursive: true, force: true });
});
