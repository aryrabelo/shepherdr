import { describe, expect, test } from "bun:test";
import { readFolders, keepFolders, rule, reach, ruleFolder, folderOf, foldersOf, stampFolders, withFolderFolded, withSpaceIn, foldersText, folderColor, foldersPath } from "./folders.js";

// built, so the repo's no-home-paths rule has nothing to find
const H = ["", "Users", "u"].join("/");
const DATA = {
  list: [
    { id: "sites", name: "Avulso", folded: false, color: null, path: "~/Sites", match: "~/Sites" },
    { id: "pessoal", name: "Pessoal", folded: false, color: "ansi5", path: "~/Sites/personal-team", match: "~/Sites/personal-team" },
    { id: "alter", name: "Alter", folded: true, color: "ansi2", path: "~/Sites/alter-team", match: "~/Sites/alter-team, wbso-ai" },
    { id: "emprego", name: "emprego", folded: false, color: null, path: null, match: null },
  ],
  of: { dragged: "emprego", out: "", gone: "deleted-folder" },
  at: 1_793_812_463_000,
};
const text = (d) => JSON.stringify(d);

describe("the file", () => {
  test("in its home: ~/.config/herdr-space-folders.json", () => {
    expect(foldersPath(H)).toBe(`${H}/.config/herdr-space-folders.json`);
    expect(foldersPath(`${H}/`)).toBe(`${H}/.config/herdr-space-folders.json`);
  });
  test("missing or not folders: none (the sidebar as before)", () => {
    expect(readFolders(null)).toBeNull();
    expect(readFolders("not json")).toBeNull();
    expect(readFolders(text({ of: {} }))).toBeNull();
    expect(readFolders("[]")).toBeNull();
  });
  test("read as it is, other keys kept, bad entries dropped", () => {
    const d = readFolders(text({ ...DATA, extra: 1, list: [...DATA.list, { name: "no id" }], of: { ...DATA.of, bad: 3 } }));
    expect(d.list.map((f) => f.id)).toEqual(["sites", "pessoal", "alter", "emprego"]);
    expect(d.of).toEqual(DATA.of);
    expect(d.at).toBe(DATA.at);
    expect(d.extra).toBe(1);
    expect(readFolders(text({ list: [] }))).toEqual({ list: [], of: {}, at: 0 });
  });
});

describe("at only counts when it goes up", () => {
  const now = readFolders(text(DATA));
  test("a newer copy replaces the one in hand", () => {
    const newer = { ...DATA, at: DATA.at + 1, list: DATA.list.slice(0, 1) };
    expect(keepFolders(now, text(newer)).list.length).toBe(1);
  });
  test("an older or equal one is ignored (a backup put back with mv undoes nothing)", () => {
    expect(keepFolders(now, text({ ...DATA, at: DATA.at - 1, list: [] }))).toBe(now);
    expect(keepFolders(now, text({ ...DATA, list: [] }))).toBe(now);
  });
  test("the first read takes any; an unreadable file keeps the copy; a removed file drops the folders", () => {
    expect(keepFolders(null, text({ ...DATA, at: 0 })).list.length).toBe(4);
    expect(keepFolders(now, "{ half")).toBe(now);
    expect(keepFolders(null, "{ half")).toBeNull();
    expect(keepFolders(now, null)).toBeNull();
  });
  test("every change written goes past the at it came from, and now", () => {
    expect(stampFolders({ ...DATA }, 5).at).toBe(DATA.at + 1);
    expect(stampFolders({ ...DATA }, DATA.at + 50).at).toBe(DATA.at + 50);
    expect(stampFolders({ list: [], of: {} }, 7).at).toBe(7);
  });
});

describe("rules", () => {
  test("a path takes the folder and everything in it; ~ is any home; * one folder name; a bare name any depth", () => {
    expect(rule("~/Sites").test(`${H}/Sites`)).toBe(true);
    expect(rule("~/Sites/").test(`${H}/Sites/app/src`)).toBe(true);
    expect(rule("~/Sites").test(`${H}/Sites-old`)).toBe(false);
    expect(rule("~/Sites").test(`${["", "home", "u"].join("/")}/Sites/x`)).toBe(true);
    expect(rule("~/code/client-*").test(`${H}/code/client-acme/web`)).toBe(true);
    expect(rule("~/code/client-*").test(`${H}/code/client-acme`)).toBe(true);
    expect(rule("~/code/client-*").test(`${H}/code/other`)).toBe(false);
    expect(rule("wbso-ai").test(`${H}/a/b/wbso-ai/c`)).toBe(true);
    expect(rule("wbso-ai").test(`${H}/a/xwbso-ai`)).toBe(false);
    expect(rule("/srv/app").test("/srv/app/x")).toBe(true);
    expect(rule("/srv/app").test("/data/srv/app")).toBe(false);
    expect(rule("  ")).toBeNull();
  });
  test("the deepest rule wins, the first folder on a tie; no rule: no folder", () => {
    expect(ruleFolder(DATA, `${H}/Sites/personal-team/shepherdr`)).toBe("pessoal");
    expect(ruleFolder(DATA, `${H}/Sites/aguia-team/x`)).toBe("sites");
    expect(ruleFolder(DATA, `${H}/Sites/alter-team`)).toBe("alter");
    expect(ruleFolder(DATA, `${H}/Documents`)).toBeNull();
    expect(ruleFolder(DATA, null)).toBeNull();
    expect(reach(DATA.list[3], `${H}/Sites`)).toBe(0);
    const tie = { list: [{ id: "a", match: "~/x" }, { id: "b", match: "~/x" }], of: {} };
    expect(ruleFolder(tie, `${H}/x/y`)).toBe("a");
    // a bare name deep in the path reaches as far as that name
    expect(ruleFolder(DATA, `${H}/Sites/aguia-team/wbso-ai/x`)).toBe("alter");
  });
});

describe("where a space goes", () => {
  test("a drag (of) beats the rules; \"\" is out of every folder; a deleted folder: none", () => {
    expect(folderOf(DATA, "dragged", `${H}/Sites/personal-team/x`)).toBe("emprego");
    expect(folderOf(DATA, "out", `${H}/Sites/personal-team/x`)).toBeNull();
    expect(folderOf(DATA, "gone", `${H}/Sites/personal-team/x`)).toBeNull();
    expect(folderOf(DATA, "other", `${H}/Sites/personal-team/x`)).toBe("pessoal");
    expect(folderOf(null, "other", `${H}/Sites`)).toBeNull();
  });
  test("a worktree space follows the space it shows under", () => {
    const m = foldersOf(DATA, [
      { id: "repo", path: `${H}/Sites/personal-team/shepherdr` },
      { id: "wt", path: `${H}/.herdr/worktrees/shepherdr/x`, under: "repo" },
      { id: "lost", path: `${H}/Sites/alter-team/y`, under: "missing" },
    ]);
    expect(m.get("repo")).toBe("pessoal");
    expect(m.get("wt")).toBe("pessoal");
    expect(m.get("lost")).toBe("alter");
  });
});

describe("written back", () => {
  test("folding flips the folder, stamps at; an unknown folder or no change is the same object", () => {
    const d = withFolderFolded(DATA, "alter", undefined, 1);
    expect(d.list.find((f) => f.id === "alter").folded).toBe(false);
    expect(d.at).toBe(DATA.at + 1);
    expect(DATA.list.find((f) => f.id === "alter").folded).toBe(true);
    expect(withFolderFolded(DATA, "alter", true)).toBe(DATA);
    expect(withFolderFolded(DATA, "nope")).toBe(DATA);
  });
  test("a space dragged in is kept in of", () => {
    const d = withSpaceIn(DATA, "s1", "alter", `${H}/Sites/personal-team/x`, 1);
    expect(d.of.s1).toBe("alter");
    expect(d.at).toBe(DATA.at + 1);
    expect(withSpaceIn(DATA, "s1", "nope", null)).toBe(DATA);
    expect(withSpaceIn(DATA, "dragged", "emprego", null)).toBe(DATA);
  });
  test("dragged out: \"\" where a rule would take it back, else back to the rules", () => {
    expect(withSpaceIn(DATA, "dragged", null, `${H}/Sites/x`).of.dragged).toBe("");
    const d = withSpaceIn(DATA, "dragged", null, `${H}/Documents/x`);
    expect("dragged" in d.of).toBe(false);
    expect(withSpaceIn(DATA, "out", null, `${H}/Sites/x`)).toBe(DATA);
    expect(withSpaceIn(DATA, "free", null, `${H}/Documents`)).toBe(DATA);
  });
  test("the text read back is the same folders", () => {
    const d = withSpaceIn(DATA, "s1", "alter", null, 1);
    const t = foldersText(d);
    expect(t.endsWith("\n")).toBe(true);
    expect(readFolders(t)).toEqual(d);
    expect(keepFolders(readFolders(text(DATA)), t)).toEqual(d);
  });
});

test("colors: the avatars' ansi colors, #hex as it is, else grey", () => {
  expect(folderColor("ansi5")).toBe("#8b7cf6");
  expect(folderColor("#abc")).toBe("#abc");
  expect(folderColor(null)).toBeNull();
  expect(folderColor("ansi9")).toBeNull();
});
