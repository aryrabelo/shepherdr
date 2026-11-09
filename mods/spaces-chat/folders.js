// ASH-15: the person's space folders in the sidebar, the same ones the space-folders mod (the main-folders layout)
// shows: core/folders.js reads ~/.config/herdr-space-folders.json. This computer's spaces only. Read at the start and
// every 5 s; a copy read counts only when its `at` goes up (keepFolders), and no file means no folders. Folding a
// folder or dragging a space writes the same file: shown at once, then written over the text it was read from
// (writeTextFile's expected), its `at` past that one; changed meanwhile, read again and done again (3 tries). A file
// that isn't there is never made here.

import { home, readTextFile, writeTextFile } from "herdr";
import { keepFolders, foldersPath, foldersText, withFolderFolded, withSpaceIn } from "./core/folders.js";

export class SpaceFolders {
  constructor() {
    this.data = null; // { list, of, at }, or null: no folders
  }

  start(cx) {
    this.read(cx);
    cx.timer.every(5000, (cx) => this.read(cx));
  }

  read(cx) {
    if (this.writing) return;
    cx.spawn(async (cx) => {
      let text;
      try { text = await readTextFile(foldersPath(home())); } catch { return; }
      if (this.writing) return;
      const next = keepFolders(this.data, text);
      if (next === this.data) return;
      this.data = next;
      cx.notify();
    });
  }

  folded(id) {
    return Boolean(this.data?.list.find((f) => f.id === id)?.folded);
  }

  // A folder folded or opened.
  fold(cx, id) {
    this.change(cx, (d) => withFolderFolded(d, id));
  }

  // A space (this computer's) dragged into a folder, or out of every folder (null); `path`: where it works.
  put(cx, space, folder, path) {
    this.change(cx, (d) => withSpaceIn(d, space, folder, path));
  }

  change(cx, op) {
    const before = this.data;
    if (!before) return;
    const shown = op(before);
    if (shown === before) return;
    this.data = shown;
    this.writing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const path = foldersPath(home());
      let prev = before;
      try {
        for (let i = 0; i < 3; i++) {
          let text;
          try { text = await readTextFile(path); } catch { break; }
          const base = keepFolders(prev, text);
          if (!base || text == null) { this.data = base; return; }
          const next = op(base);
          if (next === base) { this.data = base; return; }
          try {
            await writeTextFile(path, foldersText(next), text);
            this.data = next;
            return;
          } catch {
            prev = base;
            this.data = base;
          }
        }
        // not written: what the file says stands
        this.data = prev;
      } finally {
        this.writing = false;
        cx.notify();
      }
    });
  }
}
