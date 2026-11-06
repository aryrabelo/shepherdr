import { expect, test } from "bun:test";
import { argvFor, current, line, menuFor, modelSections, parseDefaults, parsePicks, pickKey, withPin, withRecent } from "./agents.js";

const codex = { models: Array.from({ length: 250 }, (_, i) => ({ id: `gpt-${i}`, label: `GPT ${i}`, efforts: ["low", "high"] })) };
const menus = { claude: menuFor("claude", {}), codex: menuFor("codex", codex) };

test("Codex lists every model it has, not its first five", () => {
  expect(menus.codex.models.length).toBe(250);
});

test("nothing typed: pinned, then recent, then the rest of the agent shown", () => {
  const picks = withRecent(withPin(parsePicks(""), pickKey("claude", "haiku")), pickKey("claude", "sonnet"));
  const s = modelSections(menus, "claude", picks, "");
  expect(s.map((x) => x.title)).toEqual(["Pinned", "Recent", "All models"]);
  expect(s[0].rows.map((r) => r.id)).toEqual(["haiku"]);
  expect(s[1].rows.map((r) => r.id)).toEqual(["sonnet"]);
  expect(s[2].rows.some((r) => r.id === "haiku" || r.id === "sonnet")).toBe(false);
});

test("a long list is capped and counts the rest", () => {
  const [all] = modelSections(menus, "codex", null, "");
  expect(all.rows.length).toBe(200);
  expect(all.more).toBe(50);
});

test("typed: every agent's matches, and a row to use the id typed", () => {
  const s = modelSections(menus, "codex", null, "opus 1m");
  expect(s.map((x) => x.key)).toEqual(["claude"]);
  expect(s[0].rows.map((r) => r.id)).toEqual(["opus[1m]"]);
  const t = modelSections(menus, "codex", null, "gpt-7-preview").find((x) => x.key === "typed");
  expect(t.rows.map((r) => [r.agent, r.id, r.typed])).toEqual([["codex", "gpt-7-preview", true], ["claude", "gpt-7-preview", true]]);
  expect(modelSections(menus, "codex", null, "gpt-999").map((x) => x.key)).toEqual(["typed"]);
  expect(modelSections(menus, "codex", null, "gpt-12").find((x) => x.key === "typed").rows.map((r) => r.agent)).toEqual(["claude"]);
});

test("an exact id typed needs no extra row; picks survive bad files", () => {
  expect(parsePicks("not json")).toEqual({ pinned: [], recent: [] });
  expect(withPin(withPin(parsePicks(""), "a:b"), "a:b").pinned).toEqual([]);
});

test("a running model typed by id stays in its agent's list", () => {
  expect(menuFor("claude", {}, "claude-opus-4-8").models[0]).toMatchObject({ id: "claude-opus-4-8", name: "Opus 4.8" });
});

test("a pinned or recent model typed by id stays on offer", () => {
  const picks = withRecent(withPin(parsePicks(""), "claude:claude-opus-4-8"), "codex:gpt-x");
  expect(modelSections(menus, "claude", picks, "")[0].rows[0]).toMatchObject({ id: "claude-opus-4-8", name: "Opus 4.8", pinned: true });
  expect(modelSections(menus, "codex", picks, "")[0]).toMatchObject({ title: "Recent", rows: [{ id: "gpt-x" }] });
  expect(modelSections(menus, "claude", picks, "gpt-x").map((x) => x.key)).toEqual(["codex", "typed"]);
});

// SHEP-41: Fast was hidden (and stuck on) for a Codex whose config.toml set service_tier.
test("every agent with a fast mode shows the Fast switch, and turning it off sticks", () => {
  const cache = JSON.stringify({ models: [{ slug: "gpt-x", display_name: "GPT-X", supported_reasoning_levels: [{ effort: "high" }], service_tiers: [{ id: "priority" }] },
    { slug: "gpt-slow", display_name: "GPT-Slow", service_tiers: [] }] });
  const dflt = parseDefaults("codex", `model\tgpt-x\nservice_tier\tfast\nmodels\t${cache}\n`);
  const codexMenu = menuFor("codex", dflt);
  expect(codexMenu.models.find((m) => m.id === "gpt-x").fast).toBe(true);
  expect(codexMenu.models.find((m) => m.id === "gpt-slow").fast).toBe(false);
  expect(codexMenu.fastLocked).toBeUndefined();
  expect(menuFor("claude", {}).models.find((m) => m.id === "opus").fast).toBe(true);
  // off: said on the command line, so config.toml's fast loses, and the label reads it back
  const off = argvFor({ agent: "codex", model: "gpt-x", effort: "high", fast: false }, { agent: "codex", argv: ["codex", "-c", 'service_tier="fast"'] }).argv;
  expect(off.filter((a) => a.startsWith("service_tier"))).toEqual(['service_tier="default"']);
  expect(current("codex", off, {}, dflt).fast).toBe(false);
  expect(line(current("codex", off, {}, dflt))).toBe("Codex · GPT-X · High");
  const on = argvFor({ agent: "codex", model: "gpt-x", fast: true }, { agent: "codex", argv: off }).argv;
  expect(current("codex", on, {}, dflt).fast).toBe(true);
  const claudeOff = argvFor({ agent: "claude", model: "opus", fast: false }, { agent: "claude", argv: ["claude"] }).argv;
  expect(current("claude", claudeOff, {}, { fast: true }).fast).toBe(false);
});

test("omp: its models from `omp models --json`, its levels, its argv (ASH-2)", () => {
  const raw = JSON.stringify({ models: [{ selector: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", thinking: ["off", "low", "high", "auto"] }, { selector: "zai/glm-5", name: "GLM 5" }] });
  for (const out of [`models\t${raw}`, `models\t${JSON.stringify([{ id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "high"] }, { id: "zai/glm-5", label: "GLM 5", efforts: [] }])}`]) {
    const d = parseDefaults("omp", out);
    const m = menuFor("omp", d);
    expect(m.name).toBe("omp");
    expect(m.perms.map((p) => p.id)).toEqual(["always-ask", "write", "yolo"]);
    expect(m.models[0]).toMatchObject({ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "high"] });
    expect(m.models[1].efforts).toEqual([]); // one that lists no thinking levels offers none
    const c = current("omp", ["omp", "--model", "anthropic/claude-opus-5-5", "--thinking", "high", "--approval-mode", "write"], {}, d);
    expect(c).toMatchObject({ agent: "omp", effort: "high", perm: "write" });
    expect(line(c)).toBe("omp · Claude Opus 5.5 · High");
  }
  expect(parseDefaults("omp", "").models).toBeNull(); // omp not here
  expect(argvFor({ agent: "omp", model: "zai/glm-5", effort: "low", perm: "yolo" }, { agent: "claude", argv: ["claude"] }).argv)
    .toEqual(["omp", "--model", "zai/glm-5", "--thinking", "low", "--approval-mode", "yolo"]);
});

test("omp's model list is kept: a second read doesn't run omp again (ASH-2 review)", async () => {
  const { DEFAULTS } = await import("./agents.js");
  const { mkdtempSync, chmodSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "omp-cache-")), bin = join(dir, "bin"), runs = join(dir, "runs");
  await Bun.write(join(bin, "omp"), `#!/bin/sh\necho x >> "${runs}"\necho '{"models":[{"selector":"a/b","name":"B","thinking":["low"]}]}'\n`);
  chmodSync(join(bin, "omp"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: join(dir, "cache") };
  for (let i = 0; i < 2; i++) {
    const p = Bun.spawnSync(["sh", "-c", DEFAULTS, "defaults", "omp"], { env });
    expect(parseDefaults("omp", p.stdout.toString()).models).toEqual([{ id: "a/b", label: "B", efforts: ["low"], fast: false, defaultEffort: null }]);
  }
  expect(readFileSync(runs, "utf8").trim().split("\n").length).toBe(1);
  expect(existsSync(join(dir, "cache", "herdr", "omp-models.json"))).toBe(true);
});
