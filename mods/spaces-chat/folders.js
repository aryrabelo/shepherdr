// ASH-15: the person's space folders in the sidebar, the same ones the space-folders mod (the main-folders layout)
// shows: core/folders.js reads ~/.config/herdr-space-folders.json. This computer's spaces only. Read at the start and
// every 5 s; a copy read counts only when its `at` goes up (keepFolders), and no file means no folders. Folding a
// folder or dragging a space writes the same file: shown at once, then written over the text it was read from
// (writeTextFile's expected), its `at` past that one; changed meanwhile, read again and done again (3 tries). A fold
// carries the state it was clicked to (never a toggle done again on another copy). Changes are written one after the
// other, in the order they were made. A file that isn't there is never made here.

import { home, readTextFile, writeTextFile } from "herdr";
import { keepFolders, foldersPath, foldersText, withFolderFolded, withSpaceIn } from "./core/folders.js";

export class SpaceFolders {
  constructor() {
    this.data = null; // what shows: { list, of, at }, or null: no folders
    this.saved = null; // the copy last read from or written to the file
    this.pending = 0; // changes not written yet
    this.queue = Promise.resolve();
  }

  start(cx) {
    this.read(cx);
    cx.timer.every(5000, (cx) => this.read(cx));
  }

  read(cx) {
    if (this.pending) return;
    cx.spawn(async (cx) => {
      let text;
      try { text = await readTextFile(foldersPath(home())); } catch { return; }
      if (this.pending) return;
      const next = keepFolders(this.saved, text);
      if (next === this.saved && next === this.data) return;
      this.saved = next;
      this.data = next;
      cx.notify();
    });
  }

  folded(id) {
    return Boolean(this.data?.list.find((f) => f.id === id)?.folded);
  }

  // A folder folded or opened: the other way from how it shows now.
  fold(cx, id) {
    const next = !this.folded(id);
    this.change(cx, (d) => withFolderFolded(d, id, next));
  }

  // A space (this computer's) dragged into a folder, or out of every folder (null); `path`: where it works.
  put(cx, space, folder, path) {
    this.change(cx, (d) => withSpaceIn(d, space, folder, path));
  }

  change(cx, op) {
    if (!this.data) return;
    const shown = op(this.data);
    if (shown === this.data) return;
    this.data = shown;
    this.pending++;
    cx.notify();
    const before = this.queue;
    this.queue = new Promise((done) => cx.spawn(async (cx) => {
      try {
        await before;
        await this.write(op);
      } finally {
        this.pending--;
        // the last one written: what the file says shows
        if (!this.pending) this.data = this.saved;
        cx.notify();
        done();
      }
    }));
  }

  async write(op) {
    const path = foldersPath(home());
    for (let i = 0; i < 3; i++) {
      let text;
      try { text = await readTextFile(path); } catch { return; }
      const base = keepFolders(this.saved, text);
      this.saved = base;
      if (!base || text == null) return;
      const next = op(base);
      if (next === base) return;
      try {
        await writeTextFile(path, foldersText(next), text);
        this.saved = next;
        return;
      } catch {}
    }
  }
}
