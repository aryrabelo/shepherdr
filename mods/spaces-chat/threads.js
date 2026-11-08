// Threads under each space (ASH-14, as T3 Code's projects open into their threads; core/threads.js orders them): the
// space's tasks at work or waiting on someone, and the agents of its own opened in its tabs (an omp or a Claude Code that
// isn't its Assistant, a task's agent or a helper). Then its Snoozed shelf, and its Settled one folded to "3 settled"
// until a click opens it (remembered per space). Only at full width: the rail shows none.
// Every machine's task lists are read as the Tasks panel reads them (mods/tasks): this computer's again whenever
// ~/.herdr/tasks changes, another machine's every 10 s. A task is placed, opened and put away as its Tasks row is
// (taskthread.js: a click opens its chat in the Tasks panel, a right-click the row's menu); an agent goes to its terminal
// (inbox.js toAgent), a right-click opens its Snooze menu. A row settled, snoozed, woken or unsettled moves at once (the
// window's marks: taskthread.js).

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { machines, exec, watchFolder, home, shared } from "herdr";
import { spaces, panes, agents, terminals } from "./live.js";
import { taskDot, ownProgress } from "./dot.js";
import { toAgent, fit } from "./inbox.js";
import { READ_LISTS, taskLists } from "./core/tasklists.js";
import { machineOf, autoPrefix, refOf, taskKey, reportOf, secondLine, capital } from "./core/tasks.js";
import { isThread, isLooseAgent, agentSection, agentLine, taskActivity, threadHome, threadsOf, SHELF, settledOpenKey } from "./core/threads.js";
import { SETTLED, agentRest, taskCan, restKey, wordOf } from "./core/settle.js";
import { assistantOf } from "./core/spaces.js";
import { placeTask, marked, dropSpent, queueNote, taskTarget, openRowMenu, openRestMenu } from "./taskthread.js";
import { TEXT, RADIUS } from "./ui.js";

// Under the space's name: its row's 8, the # column's 18 and the 9 between.
const INDENT = 35;

export class Threads {
  constructor() {
    this.lists = [];            // [{ folder, name, slug, prefix, machine, tasks }]: every machine's
    this.byMachine = new Map(); // "" (this computer) or a machine's name -> its lists, as read
    this.raw = new Map();       // the same -> what was read last, to skip unchanged reads
    this.reads = new Map();     // machines being read now -> whether to read again after (a change came meanwhile)
    this.open = new Map();      // space -> its Settled shelf open (localStorage, settledOpenKey)
    this.frame = null;          // this render's reads (taskthread.js), and the threads by space found in it
    this.index = null;
  }

  // As the Tasks panel: this computer's lists now and on every change, the other machines' every 10 s.
  start(cx) {
    cx.spawn(async (cx) => this.load(cx, null));
    this.watch(cx);
    this.loadRemote(cx);
    cx.timer.every(10000, (cx) => this.loadRemote(cx));
  }

  // ~/.herdr/tasks here changes: read again. At most 5 s per wait, so a reload's old build ends at its next cx use.
  watch(cx) {
    cx.spawn(async (cx) => {
      try {
        let w = null;
        for (;;) {
          w ??= watchFolder(`${home()}/.herdr/tasks`).then(() => true);
          if (!(await Promise.race([w, cx.sleep(5000)]))) continue;
          w = null;
          await this.load(cx, null);
        }
      } catch {}
    });
  }

  // Every connected machine's lists (one out of reach keeps its last); a machine gone takes its lists with it.
  loadRemote(cx) {
    const ms = machines().map((m) => m.name).filter(Boolean);
    for (const m of [...this.byMachine.keys()]) if (m && !ms.includes(m)) { this.byMachine.delete(m); this.raw.delete(m); this.merge(); cx.notify(); }
    for (const m of machines()) if (m.name && m.layout !== "unavailable") cx.spawn(async (cx) => this.load(cx, m.name));
  }

  // One machine's lists (null: this computer's). One read at a time per machine.
  async load(cx, machine = null) {
    const k = machine ?? "";
    if (this.reads.has(k)) { this.reads.set(k, true); return; }
    this.reads.set(k, false);
    let text;
    try { text = (await exec("sh", ["-c", READ_LISTS], { on: machine ?? undefined })).stdout; }
    catch { return; } // its last lists stay
    finally {
      const again = this.reads.get(k);
      this.reads.delete(k);
      if (again) cx.spawn(async (cx) => this.load(cx, machine));
    }
    if (this.raw.get(k) === text) return;
    this.raw.set(k, text);
    this.byMachine.set(k, taskLists(text)
      .map((d) => ({ ...d, machine, prefix: d.prefix || autoPrefix(d.folder), tasks: Array.isArray(d.tasks) ? d.tasks : [] })));
    this.merge();
    cx.notify();
  }

  merge() {
    const order = [null, ...machines().map((m) => m.name).filter(Boolean)];
    this.lists = [...this.byMachine.entries()].sort(([a], [b]) => order.indexOf(a || null) - order.indexOf(b || null)).flatMap(([, ls]) => ls);
  }

  // Around a render (the sidebar's render()): its reads once, then the at-once marks it found spent go.
  begin() { this.frame = {}; this.index = null; }
  end(cx) { dropSpent(this.frame, cx); this.frame = null; this.index = null; }

  // Every space's threads this render: space id -> core/threads.js threadsOf's { open, snoozed, settled }.
  bySpace() {
    if (this.index) return this.index;
    const f = this.frame ?? {};
    const all = spaces(), ts = (f.terminals ??= terminals()), ps = (f.panes ??= panes());
    const byAddress = new Map(ts.map((k) => [k.address, k]));
    const items = new Map();
    const add = (id, x) => items.set(id, [...(items.get(id) ?? []), x]);
    // Its tasks: each in the one space it's a thread of.
    const homes = all.map((s) => ({ id: s.id, machine: s.machine ?? null, folder: s.folder }));
    for (const list of this.lists) for (const task of list.tasks) {
      if (task.state === "done") continue;
      const home = threadHome(homes, { machine: list.machine ?? null, folder: list.folder, space: task.space ?? null });
      if (!home) continue;
      const p = placeTask(list, task, f);
      if (!isThread(p.section, p.rest)) continue;
      const liveAt = Math.max(0, ...p.live.map((a) => Number(byAddress.get(a.address)?.status_ms) || 0));
      add(home, { key: restKey({ machine: list.machine ?? null, folder: list.folder, ref: refOf(list, task) }), section: p.section,
        rest: p.rest, restInfo: p.restInfo, at: taskActivity(task, liveAt), p });
    }
    // Its own agents: in a pane of its tabs, or parked behind a chat pane there (herdr.chat: that machine's pane id).
    const paneOf = new Map(ps.filter((p) => p.terminal).map((p) => [p.terminal, p]));
    const tabOf = new Map(ps.map((p) => [p.pane, p.tab]));
    const inTab = new Map();
    for (const k of ts) {
      if (k.state !== "live" || k.program?.shell || k.program?.key === "shell") continue;
      const own = paneOf.get(k.address), chat = k.labels?.["herdr.chat"], m = machineOf(k.address);
      const tab = own ? (own.program?.agent || k.program?.agent ? own.tab : null) : chat ? tabOf.get(m ? `${m}/${chat}` : chat) : null;
      if (tab) inTab.set(tab, [...(inTab.get(tab) ?? []), k]);
    }
    const shown = (f.agents ??= new Map(agents().map((a) => [a.address, a])));
    for (const s of all) {
      const assistant = assistantOf(s, ts)?.address ?? null;
      for (const tab of s.tabs ?? []) for (const k of inTab.get(tab.id) ?? []) {
        if (!isLooseAgent(k, assistant)) continue;
        const info = agentRest(k);
        const r = marked({ rest: info?.rest ?? null, restInfo: info }, restKey({ agent: k.address }), f);
        // agents() knows when someone looked at a finished agent (done -> idle), as Herdr shows it.
        const word = shown.get(k.address)?.status ?? wordOf(k);
        add(s.id, { key: restKey({ agent: k.address }), section: agentSection(word), rest: r.rest, restInfo: r.restInfo,
          at: Number(k.status_ms) || tab.changed_at || 0, k, word });
      }
    }
    this.index = new Map([...items].map(([id, xs]) => [id, threadsOf(xs)]));
    return this.index;
  }

  // A space's rows under its own: its threads in order, its Snoozed shelf, its Settled one (folded: "3 settled").
  rows(w, t) {
    const g = this.bySpace().get(w.id);
    if (!g) return [];
    const out = g.open.map((x) => this.row(x, t));
    if (g.snoozed.length) out.push(this.shelf(`threads-snoozed-${w.id}`, SHELF.snoozed, null, t), ...g.snoozed.map((x) => this.row(x, t)));
    if (g.settled.length) {
      const open = this.settledOpen(w.id);
      out.push(this.shelf(`threads-settled-${w.id}`, open ? SHELF.settled : SHELF.folded(g.settled.length), () => this.foldSettled(w.id, !open), t, open));
      if (open) out.push(...g.settled.map((x) => this.row(x, t)));
    }
    return out;
  }

  settledOpen(id) {
    if (!this.open.has(id)) {
      let v = false;
      try { v = localStorage.getItem(settledOpenKey(id)) === "1"; } catch {}
      this.open.set(id, v);
    }
    return this.open.get(id);
  }

  foldSettled(id, open) {
    this.open.set(id, open);
    try { if (open) localStorage.setItem(settledOpenKey(id), "1"); else localStorage.removeItem(settledOpenKey(id)); } catch {}
  }

  // A shelf's heading under the space's name, dim; Settled's opens and folds on a click.
  shelf(id, words, toggle, t, open = false) {
    return h_flex().id(id).h(24).flex_none().pl(INDENT).pr(8).gap(6).items_center().rounded(RADIUS.card)
      .text_size(TEXT.label).font_medium().text_color(t.dim)
      .when(Boolean(toggle), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { toggle(); cx.notify(); }))
      .child(div().min_w(0).truncate().child(words))
      .when(Boolean(toggle), (el) => el.child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none()));
  }

  // One thread: its dot level with its title, under it one quiet line (a task's core/tasks.js secondLine, an agent's
  // core/threads.js agentLine), both cut at the sidebar's edge. Highlighted while its agent is the focused one.
  row(x, t) {
    const f = this.frame ?? {};
    const shown = (f.agents ??= new Map(agents().map((a) => [a.address, a])));
    let dot, title, sub, go, menu, selected;
    if (x.p) {
      const { p } = x, { list, task, live, section } = p;
      const w = reportOf(task, section, ownProgress(live.map((a) => a.address)));
      dot = taskDot(p.rest ?? section, { pct: w?.done });
      title = task.title;
      sub = secondLine(p, w, section === "queued" ? queueNote(list, task, f) : null);
      go = taskTarget(p, f);
      selected = live.some((a) => shown.get(a.address)?.focused);
      const key = taskKey(list, task), can = taskCan(section, live), pins = shared("tasks.pinned");
      menu = () => openRowMenu({ key, on: Array.isArray(pins) && pins.includes(key), status: section, machine: list.machine ?? null,
        folder: list.folder, ref: refOf(list, task), sub: section === "scheduled" ? sub : null,
        rest: { can: can.snooze, settle: can.settle, rest: p.rest, snoozed: Boolean(p.restInfo?.until || p.restInfo?.woke) } });
    } else {
      const { k, word } = x;
      dot = taskDot(x.rest ?? x.section, { pct: x.section === "working" ? ownProgress([k.address])?.pct : null });
      // the name it was given (hc --name), else its program's
      title = k.name || k.program?.name || "Agent";
      sub = agentLine(word, x.restInfo);
      go = () => toAgent(k.address);
      selected = Boolean(shown.get(k.address)?.focused);
      menu = () => openRestMenu({ agent: k.address, what: title, rest: x.rest === SETTLED ? SETTLED : null,
        snoozed: Boolean(x.restInfo?.until || x.restInfo?.woke) });
    }
    const said = sub ? fit(capital(sub)) : null;
    return h_flex().id(`thread-${x.key}`).h(said ? 36 : 28).flex_none().pl(INDENT).pr(8).pt(said ? 2 : 6).gap(8).items_start()
      .rounded(RADIUS.card).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => { go?.(); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); menu(); })
      .child(h_flex().w(14).h(16).flex_none().items_center().justify_center().child(dot))
      .child(v_flex().flex_1().min_w(0)
        .child(div().h(16).min_w(0).truncate().text_color(x.rest === SETTLED ? t.dim : selected ? t.foreground : t.muted).child(title))
        .when(Boolean(said), (el) => el.child(div().h(16).min_w(0).truncate().text_size(TEXT.label).text_color(t.dim).child(said))));
  }
}
