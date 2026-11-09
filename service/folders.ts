// ASH-15: the person's space folders for the web's sidebar, as the window's (mods/spaces-chat folders.js): core/folders.js
// over ~/.config/herdr-space-folders.json, the file the space-folders mod keeps, on the service's machine (its own spaces:
// machine null; other machines' spaces show as before). Read with each refresh (Model) and after a change; a copy counts
// only when its `at` goes up, and no file means no folders. A fold or a drag from the page is written over the text it
// was read from (renamed into place only while the file still says that; else read again and done again, 3 tries), its
// `at` past that one. A missing file is never made here.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { HOME } from "./paths.ts";
import * as F from "../core/folders.js";
const { foldersPath, keepFolders, foldersOf, folderColor, foldersText } = F as any;

export type FolderData = { list: { id: string; name?: string; folded?: boolean; color?: string | null; path?: string | null; match?: string | null }[]; of: Record<string, string>; at: number } | null;

/** A folder as the snapshot has it (web/shared/types.ts Folder), before compat names its machine. */
export interface FolderGroup { id: string; name: string; color?: string; folded: boolean; spaces: string[] }

/** The file's text, or null when it isn't there. */
export function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null; throw e; }
}

/** `op` on the folders the file holds now, written over the text it was read from. What to keep in hand after. */
export function changeFolders(path: string, now: FolderData, op: (d: NonNullable<FolderData>) => NonNullable<FolderData>): FolderData {
  let prev = now;
  for (let i = 0; i < 3; i++) {
    let text: string | null;
    try { text = readText(path); } catch { return prev; }
    const base = keepFolders(prev, text) as FolderData;
    if (!base || text == null) return base;
    const next = op(base);
    if (next === base) return base;
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, foldersText(next));
      // still the text it was read from: in its place at once
      if (readText(path) === text) { renameSync(tmp, path); return next; }
      unlinkSync(tmp);
    } catch {
      try { unlinkSync(tmp); } catch {}
    }
    prev = base;
  }
  return prev;
}

/** This machine's spaces in its folders, for the sidebar: those not pinned and in no section, each in the folder core
 *  folderOf gives it (a worktree space with its repo's own space, as the window nests it). Every folder, in the
 *  file's order, empty ones too. */
export function folderGroups(d: FolderData, spaces: { id: string; machine?: string | null; folder?: string; pinned?: boolean; section?: string | null; git?: { linked: boolean; repo: string } | null }[]): FolderGroup[] {
  if (!d) return [];
  const mine = spaces.filter((s) => !s.machine && !s.pinned && !s.section);
  const mains = new Map<string, string>();
  for (const s of mine) if (s.git && !s.git.linked && !mains.has(s.git.repo)) mains.set(s.git.repo, s.id);
  const placed = foldersOf(d, mine.map((s) => ({ id: s.id, path: s.folder ?? "", under: s.git?.linked ? mains.get(s.git.repo) ?? null : null }))) as Map<string, string | null>;
  return d.list.map((f) => {
    const color = folderColor(f.color) as string | null;
    return { id: `f:${f.id}`, name: String(f.name ?? ""), ...(color ? { color } : {}), folded: !!f.folded, spaces: mine.filter((s) => placed.get(s.id) === f.id).map((s) => s.id) };
  });
}

/** The folders in hand, read again and changed (the service's own copy). */
export class Folders {
  data: FolderData = null;
  /** told after a change (the snapshot is built again) */
  onChange: (() => void) | null = null;
  constructor(public path: string = foldersPath(HOME)) {}

  read() {
    try { this.data = keepFolders(this.data, readText(this.path)); } catch {}
    return this.data;
  }

  change(op: (d: NonNullable<FolderData>) => NonNullable<FolderData>) {
    this.data = changeFolders(this.path, this.data, op);
    this.onChange?.();
    return this.data;
  }

  /** a folder's id the file has, from the snapshot's f:<id>; null otherwise */
  idOf(key: unknown) {
    const id = typeof key === "string" && key.startsWith("f:") ? key.slice(2) : null;
    return id && this.data?.list.some((f) => f.id === id) ? id : null;
  }
}
