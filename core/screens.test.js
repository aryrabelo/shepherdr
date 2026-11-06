import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readScreen, ScreenWatch, starting, mayStart, cliOf, pressKeys, SCREEN } from "./screens.js";

const TRUST = [
  "Do you trust the files in this folder?",
  "",
  " ❯ 1. Yes, proceed",
  "   2. No, exit",
  "",
  "Enter to confirm · Esc to exit",
].join("\n");

describe("a CLI's start screen, read the same by the window and the service", () => {
  test("its words and choices, the cursor's one", () => {
    expect(readScreen(TRUST)).toEqual({ words: "Do you trust the files in this folder?", choices: [{ label: "Yes, proceed" }, { label: "No, exit" }], at: 0 });
    expect(pressKeys(0, 1)).toEqual(["down", "enter"]);
  });
  test("starting: live, no status, no turn, a CLI", () => {
    expect(starting({ state: "live", foreground: { name: "claude" } })).toBe(true);
    expect(starting({ state: "live", status: { state: "working" }, foreground: { name: "claude" } })).toBe(false);
  });
  test("two matching reads put a card up; a press on it presses the choice", async () => {
    const store = new Map();
    const sent = [];
    const io = { hc: async (a) => (a[0] === "read" ? { code: 0, stdout: TRUST } : (sent.push(a), { code: 0, stdout: "" })), cards: (x) => store.get(x) ?? [], save: (x, l) => store.set(x, l) };
    const w = new ScreenWatch(io);
    const k = { address: "t1", state: "live", foreground: { name: "claude" }, created_ms: 0 };
    await w.tick("t1", k, 100000);
    expect(store.get("t1")).toBeUndefined();
    await w.tick("t1", k, 102000);
    const card = store.get("t1")[0];
    expect(card).toMatchObject({ cli: "Claude Code", state: "open", choices: [{ label: "Yes, proceed" }, { label: "No, exit" }] });
    expect(await w.press(card, 0)).toBe(null);
    expect(sent).toEqual([["keys", "t1", "enter"]]);
    expect(store.get("t1")[0]).toMatchObject({ state: "answered", how: SCREEN.answered("Yes, proceed") });
  });
  // Issue 755: a task's worker, started low (herdr-task's LOW), on Claude Code's folder-trust dialog. hc ls names
  // only the wrapper ("sh"); hc get's foreground is Claude Code's build, named for its version.
  const FOLDER = JSON.parse(readFileSync(join(import.meta.dir, "start-screen.cases.json"), "utf8")).trust;
  const ARGV = ["sh", "-c", "low", "herdr-low", "env", "HERDR_BROWSER_TASK=dev#6", "/bin/zsh", "-lic", '"$@"; exec "$0" -i', "/bin/zsh", "claude", "--settings", "{}", "Brief"];
  const listed = { address: "t5", agent: "sh", state: "live", turn: 0, argv: ARGV };
  const got = (fg) => ({ ...listed, created_ms: 0, cols: 200, foreground: fg });
  test("the folder-trust dialog reads as its two choices, No first", () => {
    const s = readScreen(FOLDER, 200);
    expect(s.choices).toEqual([{ label: "No, exit" }, { label: "Yes, I trust this folder" }]);
    expect(s.at).toBe(0);
    expect(s.words).toContain("Quick safety check");
  });
  test("a worker started low is Claude Code by its foreground's command, maybe so while only listed", () => {
    expect(cliOf(got({ name: "2.1.319", argv: ["claude", "--settings", "{}"] }))).toBe("claude");
    expect(starting(got({ name: "2.1.319", argv: ["claude"] }))).toBe(true);
    expect(cliOf(listed)).toBe(null); // a lost session's check still sees no CLI there
    expect(mayStart(listed)).toBe(true);
    expect(mayStart({ ...listed, argv: ["sh", "-c", "low", "herdr-low", "omp"] })).toBe(false);
    expect(mayStart({ ...listed, turn: 1 })).toBe(false);
    expect(starting(got({ name: "zsh", argv: ["/bin/zsh", "-i"] }))).toBe(false);
  });
  const watch = (fg, screen = FOLDER) => {
    const store = new Map(), sent = [];
    const io = { hc: async (a) => (a[0] === "read" ? { code: 0, stdout: screen } : a[0] === "get" ? { code: 0, stdout: JSON.stringify(got(fg)) } : (sent.push(a), { code: 0, stdout: "" })),
      cards: (x) => store.get(x) ?? [], save: (x, l) => store.set(x, l) };
    return { w: new ScreenWatch(io), store, sent };
  };
  test("its dialog becomes a card from the list's record, never pressed until the person picks", async () => {
    const { w, store, sent } = watch({ name: "2.1.319", argv: ["claude", "--settings", "{}"] });
    await w.tick("t5", listed, 100000);
    await w.tick("t5", listed, 102000);
    const card = store.get("t5")[0];
    expect(card).toMatchObject({ cli: "Claude Code", state: "open", at: 0, choices: [{ label: "No, exit" }, { label: "Yes, I trust this folder" }] });
    await w.tick("t5", listed, 104000);
    expect(sent).toEqual([]);
    expect(await w.press(card, 1)).toBe(null);
    expect(sent).toEqual([["keys", "t5", "down", "enter"]]);
  });
  test("the service's record, its foreground still the wrapper it was made with, gets the card too", async () => {
    const { w, store } = watch({ name: "2.1.319", argv: ["claude"] });
    const stale = { ...listed, created_ms: 0, cols: 200, foreground: { name: "sh", argv: ARGV } };
    expect(mayStart(stale)).toBe(true);
    await w.tick("t5", stale, 100000);
    await w.tick("t5", stale, 102000);
    expect(store.get("t5")?.[0]).toMatchObject({ cli: "Claude Code", state: "open" });
  });
  test("its shell in front (the CLI ended): no card", async () => {
    const { w, store } = watch({ name: "zsh", argv: ["/bin/zsh", "-i"] }, "% ");
    await w.tick("t5", listed, 100000);
    await w.tick("t5", listed, 102000);
    expect(store.get("t5")).toBeUndefined();
  });
  test("the window's chat watches with this core", () => {
    expect(readFileSync(join(import.meta.dir, "..", "mods/chat/screens.js"), "utf8")).toContain('from "./core/screens.js"');
  });
});
