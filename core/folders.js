// ASH-15: the person's space folders, as the space-folders mod (herdr-desktop-config's main-folders layout) keeps them,
// so both layouts show the same folders. One file in the machine's home, ~/.config/herdr-space-folders.json:
// { list: [{ id, name, folded, color, path, match }], of: { space id: folder id, "" out of every folder }, at: ms }.
// `list` is the folders in the sidebar's order; `color` ansi1..ansi6, "#hex" or null; `match` comma-separated rules
// ("~" any home, "*" one folder name, a rule starting with neither "/" nor "~" a folder name at any depth). Where a
// space goes: where it was dragged (`of`, "" for out of every folder) beats the rules; else the folder whose rule
// reaches deepest into where the space works, the first one on a tie. `at` only counts when it goes up: a copy read
// with an `at` no newer than the one in hand is ignored, and every change written goes past it.
// The window's sidebar (mods/spaces-chat) and the service (the web's sidebar) read and write it with these.
// No file: no folders (the sidebar as before).

export const FOLDERS_FILE = ".config/herdr-space-folders.json";
export const foldersPath = (home) => `${String(home ?? "").replace(/\/+$/, "")}/${FOLDERS_FILE}`;

const isObj = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);

// The file's text as folders: { ...its other keys, list, of, at }, or null when it's missing or not in that format.
export function readFolders(text) {
  if (text == null) return null;
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!isObj(d) || !Array.isArray(d.list)) return null;
  const list = d.list.filter((f) => isObj(f) && typeof f.id === "string" && f.id);
  const of = isObj(d.of) ? Object.fromEntries(Object.entries(d.of).filter(([, v]) => typeof v === "string")) : {};
  return { ...d, list, of, at: Number(d.at) || 0 };
}

// The copy to keep after reading the file again: none once the file is gone, the one in hand when the file can't be
// read as folders, the file's only when its `at` is newer than the one in hand.
export function keepFolders(now, text) {
  if (text == null) return null;
  const read = readFolders(text);
  if (!read) return now ?? null;
  return !now || read.at > (Number(now.at) || 0) ? read : now;
}

// A rule of a folder's `match` as a RegExp: a folder and everything in it.
export function rule(pattern) {
  const p = String(pattern ?? "").trim().replace(/\/+$/, "");
  if (!p) return null;
  const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

// How deep into `path` a folder's rules reach: 0 when none match. ~/code/client reaches past ~/code.
export function reach(folder, path) {
  if (!path) return 0;
  return Math.max(0, ...String(folder?.match ?? "").split(",").map((p) => {
    const m = rule(p)?.exec(path);
    return m ? 1 + m.index + m[0].replace(/\/$/, "").length : 0;
  }));
}

// The folder (its id) whose rules reach deepest into `path`, the first on a tie; null when none do.
export function ruleFolder(d, path) {
  let best = null, most = 0;
  for (const f of d?.list ?? []) {
    const n = reach(f, path);
    if (n > most) { best = f.id; most = n; }
  }
  return best;
}

// The folder a space (its id on its machine) is in: where it was dragged, else by the rules. null: in none.
export function folderOf(d, space, path) {
  if (!d) return null;
  const id = d.of?.[space];
  if (id !== undefined) return d.list.some((f) => f.id === id) ? id : null;
  return ruleFolder(d, path);
}

// Each row's folder: { id, path, under } (`under`: the space a worktree space shows under, which it follows). A Map.
export function foldersOf(d, rows) {
  const out = new Map();
  for (const r of rows) if (!r.under) out.set(r.id, folderOf(d, r.id, r.path));
  for (const r of rows) if (r.under) out.set(r.id, out.has(r.under) ? out.get(r.under) : folderOf(d, r.id, r.path));
  return out;
}

// A change to write: its `at` past the one it came from (and now).
export const stampFolders = (d, now = Date.now()) => ({ ...d, at: Math.max(now, (Number(d.at) || 0) + 1) });

// A folder folded or opened (`folded` omitted: the other way). The same object when nothing changes.
export function withFolderFolded(d, id, folded, now = Date.now()) {
  const f = d?.list.find((x) => x.id === id);
  if (!f) return d;
  const next = folded === undefined ? !f.folded : Boolean(folded);
  if (Boolean(f.folded) === next) return d;
  return stampFolders({ ...d, list: d.list.map((x) => (x.id === id ? { ...x, folded: next } : x)) }, now);
}

// A space dragged into a folder (its id), or out of every folder (null): out of one its rules would put it in, it
// stays out (""); else it goes back to the rules. The same object when nothing changes.
export function withSpaceIn(d, space, folder, path, now = Date.now()) {
  if (!d) return d;
  if (folder && !d.list.some((f) => f.id === folder)) return d;
  const want = folder ? folder : ruleFolder(d, path) ? "" : undefined;
  if (d.of[space] === want) return d;
  const of = { ...d.of };
  if (want === undefined) delete of[space];
  else of[space] = want;
  return stampFolders({ ...d, of }, now);
}

// The file's text for a copy.
export const foldersText = (d) => `${JSON.stringify(d)}\n`;

// A folder's color as the window's space avatars draw it: ansi1..ansi6, "#hex" as it is, else null (grey).
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export function folderColor(color) {
  if (typeof color !== "string") return null;
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  return MARK[color] ?? null;
}
