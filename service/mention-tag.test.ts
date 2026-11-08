import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionedIn, taskTag } from "../core/send.js";

// a throwaway app home, set before compat.ts reads it (hence its import after)
process.env.HERDR_APP_HOME = mkdtempSync(join(tmpdir(), "shep-mention-tag-"));
const { Compat } = await import("./compat.ts");

// A task named in a web message reaches the agent as the window's chat tags it (herdr-task list --json's status_text):
// state is the status word, not the row's second line (ASH-13's "Próximo:" line, ASH-12's "Wakes …").
test("a mentioned task's tag says its state, whatever its second line shows", () => {
  const c = new Compat() as any;
  c.spaceList = [{ id: "sp1", folder: "/srv/shop", machine: null }];
  const row = (id: number, section: string, sub: string | null, why: string | null = null) =>
    ({ ref: `SHOP-${id}`, id, title: `T${id}`, section, sub, why, folder: "/srv/shop", machine: null, prompt: "p" });
  c.rows = [
    row(1, "ready", "Próximo: aceitar (parei em Ready; quem deve: a pessoa)"),
    row(2, "working", "Wakes Tomorrow 9:00"),
    row(3, "needs", "Asks: which branch?", "Asks: which branch?"),
  ];
  const tags = mentionedIn("SHOP-1 SHOP-2 SHOP-3", c.tasksFor("p:sp1")).map((x: any) => taskTag(x, x.ref)).join("");
  expect(tags).toContain(`<hc task="SHOP-1" title="T1" state="Ready" folder="/srv/shop">`);
  expect(tags).toContain(`<hc task="SHOP-2" title="T2" state="Working" folder="/srv/shop">`);
  expect(tags).toContain(`<hc task="SHOP-3" title="T3" state="Needs you" why="Asks: which branch?" folder="/srv/shop">`);
  expect(tags).not.toContain("Próximo");
});
