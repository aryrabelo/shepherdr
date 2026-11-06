import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { share, site, tcpForward } from "./tailscale.ts";

// A fake tailscale (SHEPHERDR_TAILSCALE): `serve status --json` prints status.json; every call is logged; `serve --bg`
// fails with tailscale's own words when fail exists. Never the real tailscale or the person's serve config.
const dir = mkdtempSync(join(tmpdir(), "shepherdr-ts-"));
const fake = join(dir, "tailscale");
writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ "$1 $2" = "serve status" ]; then cat "${dir}/status.json"; exit 0; fi
if [ "$2" = "--bg" ] && [ -f "${dir}/fail" ]; then cat "${dir}/fail" >&2; exit 1; fi
exit 0
`);
chmodSync(fake, 0o755);
process.env.SHEPHERDR_TAILSCALE = fake;
afterAll(() => { delete process.env.SHEPHERDR_TAILSCALE; rmSync(dir, { recursive: true, force: true }); });

const DNS = "box.tailnet.example";
const status = (s: any) => writeFileSync(join(dir, "status.json"), JSON.stringify(s));
const calls = () => { try { return readFileSync(join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; } };
beforeEach(() => { rmSync(join(dir, "calls"), { force: true }); rmSync(join(dir, "fail"), { force: true }); status({}); });

// what `tailscale serve status --json` says with a raw TCP forward on 443 (tailscale serve --tcp=443 …)
const FORWARD = { TCP: { "443": { TCPForward: "127.0.0.1:8443" } } };

test("a raw TCP forward on 443 is named, with the fix, and nothing is changed (GitHub #754)", async () => {
  status(FORWARD);
  const why = await share(DNS, 7788, 443);
  expect(why).toContain("port 443 is a raw TCP forward to 127.0.0.1:8443");
  expect(why).toContain("--https <another port>");
  expect(calls()).toEqual(["serve status --json"]);
});

test("an HTTPS serve on 443 isn't a TCP forward", () => {
  expect(tcpForward({ TCP: { "443": { HTTPS: true } } }, 443)).toBeNull();
  expect(tcpForward(FORWARD, 443)).toBe("127.0.0.1:8443");
  expect(tcpForward(FORWARD, 8443)).toBeNull();
});

test("another HTTPS port is shared there although 443 is a TCP forward", async () => {
  status(FORWARD);
  expect(await share(DNS, 7788, 8443)).toBeNull();
  expect(calls()).toContain("serve --bg --https=8443 --set-path /shepherdr 7788");
});

test("tailscale's own error is passed through", async () => {
  writeFileSync(join(dir, "fail"), "error: port 443 is already in use\nby something else\n");
  expect(await share(DNS, 7788, 443)).toBe("tailscale serve failed on port 443: error: port 443 is already in use by something else");
});

test("ours on 443 moves to the chosen port; ours there already is left alone", async () => {
  status({ TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/shepherdr": { Proxy: "http://127.0.0.1:7788" } } } } });
  expect(await share(DNS, 7788, 8443)).toBeNull();
  expect(calls()).toEqual(["serve status --json", "serve --bg --https=8443 --set-path /shepherdr 7788", "serve --https=443 --set-path /shepherdr off"]);
  rmSync(join(dir, "calls"));
  expect(await share(DNS, 7788, 443)).toBeNull();
  expect(calls()).toEqual(["serve status --json"]);
});

test("Funnel still wins over everything", async () => {
  status({ ...FORWARD, Web: { [`${DNS}:443`]: { Handlers: { "/shepherdr": { Proxy: "http://127.0.0.1:7788" } } } }, AllowFunnel: { [`${DNS}:443`]: true } });
  expect(await share(DNS, 7788, 443)).toContain("Funnel");
});

test("Funnel on the chosen port is refused before anything is served there", async () => {
  status({ AllowFunnel: { [`${DNS}:8443`]: true } });
  expect(await share(DNS, 7788, 8443)).toContain("Funnel is on for port 8443");
  expect(calls()).toEqual(["serve status --json"]);
});

test("ours stays where it was when the new port fails", async () => {
  status({ Web: { [`${DNS}:443`]: { Handlers: { "/shepherdr": { Proxy: "http://127.0.0.1:7788" } } } } });
  writeFileSync(join(dir, "fail"), "error: nope\n");
  expect(await share(DNS, 7788, 8443)).toContain("error: nope");
  expect(calls()).not.toContain("serve --https=443 --set-path /shepherdr off");
});

test("the link carries the port only when it isn't 443", () => {
  expect(site(DNS, 443)).toBe(`https://${DNS}`);
  expect(site(DNS, 8443)).toBe(`https://${DNS}:8443`);
});
