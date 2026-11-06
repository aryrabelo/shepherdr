import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAG, SAME_PRESS, selects, readingKey } from "./text-select.js";

const ROOT = join(import.meta.dir, "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const mods = (o = {}) => ({ shift: false, alt: false, control: false, platform: false, function: false, ...o });

describe("a press that selects text in the messages (ASH-10)", () => {
  const at = 1_000_000;
  test("a drag selects", () => {
    expect(selects({ x: 10, y: 10, count: 1, at }, { x: 10 + DRAG, y: 10 }, at)).toBe(true);
    expect(selects({ x: 10, y: 10, count: 1, at }, { x: 40, y: 90 }, at + 5)).toBe(true);
  });
  test("a click doesn't: the composer keeps the keyboard", () => {
    expect(selects({ x: 10, y: 10, count: 1, at }, { x: 11, y: 11 }, at)).toBe(false);
    expect(selects({ x: 10, y: 10, count: 1, at }, { x: 10, y: 10 }, at)).toBe(false);
  });
  test("a double or triple click (a word, a line) selects without moving", () => {
    expect(selects({ x: 10, y: 10, count: 2, at }, { x: 10, y: 10 }, at)).toBe(true);
    expect(selects({ x: 10, y: 10, count: 3, at }, { x: 10, y: 10 }, at)).toBe(true);
  });
  test("a press elsewhere (the composer) doesn't count an old press in the messages", () => {
    expect(selects({ x: 10, y: 10, count: 1, at }, { x: 90, y: 90 }, at + SAME_PRESS + 1)).toBe(false);
  });
  test("nothing noted, nothing selected", () => {
    expect(selects(null, { x: 1, y: 1 }, at)).toBe(false);
    expect(selects({ x: 1, y: 1, at }, null, at)).toBe(false);
    expect(selects({ x: undefined, y: 1, at }, { x: 9, y: 9 }, at)).toBe(false);
  });
});

describe("keys while the messages hold the keyboard", () => {
  test("Cmd+C (Ctrl+C) is left to the window's own copy of the selection", () => {
    expect(readingKey({ key: "c", keystroke: "cmd-c", modifiers: mods({ platform: true }) })).toBe(null);
    expect(readingKey({ key: "c", keystroke: "ctrl-c", modifiers: mods({ control: true }) })).toBe(null);
  });
  test("Cmd+V (Ctrl+V) pastes into the composer", () => {
    expect(readingKey({ key: "v", modifiers: mods({ platform: true }) })).toEqual({ act: "paste" });
    expect(readingKey({ key: "v", modifiers: mods({ control: true }) })).toEqual({ act: "paste" });
  });
  test("typing goes on in the composer, letter included", () => {
    expect(readingKey({ key: "a", key_char: "a", modifiers: mods() })).toEqual({ act: "type", text: "a" });
    expect(readingKey({ key: "a", key_char: "A", modifiers: mods({ shift: true }) })).toEqual({ act: "type", text: "A" });
    expect(readingKey({ key: "space", key_char: " ", modifiers: mods() })).toEqual({ act: "type", text: " " });
    // Option+key types a character on a Mac keyboard
    expect(readingKey({ key: "5", key_char: "[", modifiers: mods({ alt: true }) })).toEqual({ act: "type", text: "[" });
  });
  test("Escape, Enter and the arrows just give the composer the keyboard back", () => {
    for (const key of ["escape", "enter", "tab", "backspace", "up", "left"]) expect(readingKey({ key, key_char: key === "enter" ? "\n" : undefined, modifiers: mods() })).toEqual({ act: "back" });
  });
  test("other chords stay where they are", () => {
    expect(readingKey({ key: "f", modifiers: mods({ control: true }) })).toBe(null);
    expect(readingKey({ key: "f1", modifiers: mods() })).toBe(null);
  });
});

describe("the window's chat uses it", () => {
  const src = read("mods/chat/main.js");
  test("imports the shared copy", () => {
    expect(src).toContain('from "./core/text-select.js"');
    expect(read("lib/COPIES")).toMatch(/^core\/text-select\.js: chat$/m);
  });
  test("the messages hold the keyboard after a selection, and the box doesn't take it back meanwhile", () => {
    expect(src).toMatch(/track_focus\(this\.readFocus\)/);
    expect(src).toMatch(/selects\(this\.bodyDown, e\.position, this\.press\?\.at\)/);
    expect(src).toMatch(/this\.focused === false && !this\.reading/);
  });
});
