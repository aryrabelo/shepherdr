// The tailnet side: who owns this machine, its name, and sharing /shepherdr privately with tailscale serve.
// Never funnel: serving stops when Funnel is on for the port /shepherdr is served on. The HTTPS port is 443 unless
// install's --https chose another (SHEPHERDR_HTTPS), as when 443 is a raw TCP forward (GitHub #754).
import { MOUNT, HTTPS } from "./paths.ts";

export type Me = { login: string; name: string; dns: string; host: string };

// SHEPHERDR_TAILSCALE: a fake tailscale in tests (Bun.spawn ignores a PATH changed inside a test)
async function run(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn([process.env.SHEPHERDR_TAILSCALE || "tailscale", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { ok: (await p.exited) === 0, out, err };
  } catch {
    return { ok: false, out: "", err: "" };
  }
}

/** The web app's address on the tailnet: https://<machine>, with the port when it isn't 443. */
export function site(dns: string, https = HTTPS) {
  return `https://${dns}${https === 443 ? "" : `:${https}`}`;
}

/** The machine owner's login and the machine's tailnet name, or null without Tailscale. */
export async function whoami(): Promise<Me | null> {
  const r = await run(["status", "--json"]);
  if (!r.ok) return null;
  try {
    const s = JSON.parse(r.out);
    const user = s.User?.[String(s.Self?.UserID)];
    const dns = String(s.Self?.DNSName ?? "").replace(/\.$/, "");
    if (!user?.LoginName || !dns) return null;
    return { login: user.LoginName, name: user.DisplayName ?? user.LoginName, dns, host: s.Self?.HostName ?? dns.split(".")[0] };
  } catch {
    return null;
  }
}

export type Served = { proxy: string | null; port: string | null; funnel: boolean };

async function serveStatus(): Promise<any> {
  const r = await run(["serve", "status", "--json"]);
  if (!r.ok) return {};
  try { return JSON.parse(r.out || "{}") ?? {}; } catch { return {}; }
}

function servedIn(s: any, dns: string): Served {
  for (const [hostPort, web] of Object.entries<any>(s?.Web ?? {})) {
    const [host, port] = hostPort.split(":");
    if (host !== dns) continue;
    const h = web?.Handlers?.[MOUNT];
    if (h) return { proxy: h.Proxy ?? null, port, funnel: !!s.AllowFunnel?.[hostPort] };
  }
  return { proxy: null, port: null, funnel: false };
}

/** What tailscale serve does with /shepherdr now: its target, the HTTPS port, and whether Funnel is on there. */
export async function served(dns: string): Promise<Served> {
  return servedIn(await serveStatus(), dns);
}

/** Where a raw TCP forward (tailscale serve --tcp) sends this port, or null. Such a port can't also serve /shepherdr. */
export function tcpForward(s: any, https: number): string | null {
  return s?.TCP?.[String(https)]?.TCPForward ?? null;
}

/** What to say when a TCP forward holds the HTTPS port. bin/shepherdr's doctor says the same words. */
export function heldWords(https: number, to: string) {
  return `Tailscale's port ${https} is a raw TCP forward to ${to} (tailscale serve --tcp), so /shepherdr can't be served there: ` +
    `move that forward off ${https}, or install again with --https <another port> (e.g. --https 8443)`;
}

export async function funnelAnywhere(): Promise<boolean> {
  return Object.values((await serveStatus()).AllowFunnel ?? {}).some(Boolean);
}

/** Shares 127.0.0.1:<port> at https://<machine>[:https]/shepherdr. Refuses to replace /shepherdr when it points
 *  elsewhere, and a port Funnel or a raw TCP forward holds; a /shepherdr of ours on another port moves to this one. */
export async function share(dns: string, port: number, https = HTTPS): Promise<string | null> {
  const s = await serveStatus();
  const now = servedIn(s, dns);
  const ours = `http://127.0.0.1:${port}`;
  if (now.funnel) return "Funnel is on for this machine's HTTPS port: Shepherdr won't serve there";
  if (now.proxy === ours && now.port === String(https)) return null;
  if (now.proxy && now.proxy !== ours) return `${MOUNT} is already shared to ${now.proxy}`;
  // the port it is to be served on: never under Funnel, never over a raw TCP forward
  if (s?.AllowFunnel?.[`${dns}:${https}`]) return `Funnel is on for port ${https}: Shepherdr won't serve there`;
  const to = tcpForward(s, https);
  if (to) return heldWords(https, to);
  const r = await run(["serve", "--bg", `--https=${https}`, "--set-path", MOUNT, String(port)]);
  // ours on another port: stopped there only once the new port serves it
  if (r.ok && now.proxy === ours) await run(["serve", `--https=${now.port}`, "--set-path", MOUNT, "off"]);
  if (r.ok) return null;
  // tailscale's own words, on one line (the window's Settings › Web and doctor show them)
  const said = (r.err.trim() || r.out.trim()).replace(/\s+/g, " ").slice(0, 300);
  return `tailscale serve failed on port ${https}` + (said ? `: ${said}` : "");
}

/** Stops sharing /shepherdr. port: only when it leads to this service (another one's share is left alone). */
export async function unshare(dns: string, port?: number): Promise<void> {
  const now = await served(dns);
  if (now.proxy && (port === undefined || now.proxy === `http://127.0.0.1:${port}`)) await run(["serve", `--https=${now.port ?? 443}`, "--set-path", MOUNT, "off"]);
}

/** What a move here set aside (shepherdr web serve-from --take-link: ~/.herdr/shepherdr/replaced-share.json), shared
 *  again once this machine no longer serves the web app. */
export async function restoreShare(file: string): Promise<boolean> {
  let r: { port?: string; proxy?: string } | null = null;
  try { r = JSON.parse(await Bun.file(file).text()); } catch { return false; }
  if (!r?.proxy || !/^\d+$/.test(String(r.port)) || !/^https?:\/\/127\.0\.0\.1:\d+\/?$/.test(r.proxy)) return false;
  const ok = (await run(["serve", "--bg", `--https=${r.port}`, "--set-path", MOUNT, r.proxy])).ok;
  if (ok) try { (await import("node:fs")).unlinkSync(file); } catch {}
  return ok;
}
