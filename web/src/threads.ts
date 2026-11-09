// Threads in the sidebar (ASH-14), as the window's (core/threads.js): under each space's row its threads, its tasks at
// work or waiting on someone (or put away by hand) and the agents of its own in its tabs, in core order, then its
// Snoozed and Settled shelves. And rows put away at once: Settle, Unsettle, Snooze and Wake keep a mark on this device
// by the row's chat key (core/settle.js restMark) until the snapshot agrees, refuses, or PENDING_MS passes, so the row
// moves the moment it's asked, here and in the Tasks list.
import type { Place, PlaceTab, Snapshot, Status, Task } from '@shared/types.ts'
import { panesHere, type Pane, type Panes } from './panes.ts'
import * as THc from '@core/threads.js'
import * as RSc from '@core/settle.js'

type Rest = 'settled' | 'snoozed'
/** a row's rest as core/settle.js taskRest/agentRest give it */
export type RestInfo = { rest: Rest | null; at?: number | null; until?: number | null; woke?: number; showing?: boolean } | null
/** a row put away (or back) just now: core/settle.js restMark */
export type RestMark = { rest: Rest | null; until?: number; at: number; seq?: number }
/** the marks on this device, by chat key */
export type RestMarks = Record<string, RestMark>
/** what the snapshot says of a row's rest (a task, a tab, a space's Assistant) */
type Restable = { rest?: Rest; restAt?: number; restUntil?: number; woke?: number }

const shownRest = RSc.shownRest as (info: RestInfo, mark: RestMark | undefined, now?: number) => { info: RestInfo; keep: boolean }
const marksWith = RSc.marksWith as (marks: RestMarks, key: string, mark: RestMark | null, now?: number) => RestMarks
const marksAfter = RSc.marksAfter as (marks: RestMarks, key: string, asked: RestMark, mark: RestMark | null, now?: number) => RestMarks
const restMark = RSc.restMark as (verb: string, until?: number | null, at?: number, asked?: RestMark | null) => RestMark
const isThread = THc.isThread as (section: string, rest?: Rest | null) => boolean
const agentSection = THc.agentSection as (word: string | null) => 'needs' | 'working' | 'idle'
const agentLine = THc.agentLine as (word: string | null, info: RestInfo, now?: number) => string | null
const threadsOf = THc.threadsOf as <T extends { key: string; section: string; rest: Rest | null; restInfo: RestInfo; at: number }>(items: T[]) => { open: T[]; snoozed: T[]; settled: T[] }

export { marksAfter, marksWith, restMark }

/** a task's chat key, as its row menu's actions name it */
export const taskChat = (t: Task): string => t.agent?.chat ?? `${t.id}/Agent`

/** the snapshot's rest fields back in core's shape */
export function restInfoOf(x: Restable): RestInfo {
  if (x.rest === 'settled') return { rest: 'settled', at: x.restAt ?? null }
  if (x.rest === 'snoozed') return { rest: 'snoozed', until: x.restUntil ?? null }
  if (x.woke) return { rest: null, woke: x.woke }
  return x.restUntil ? { rest: null, until: x.restUntil, showing: true } : null
}

/** a row as it shows with its mark, while the mark counts: put away (or back) at once */
export function marked<T extends Restable>(x: T, mark: RestMark | undefined, now = Date.now()): T {
  if (!mark) return x
  const { info, keep } = shownRest(restInfoOf(x), mark, now)
  if (!keep) return x
  const { rest: _rest, restAt: _at, restUntil: _until, woke: _woke, ...own } = x
  return { ...own, ...(info?.rest ? { rest: info.rest } : {}), ...(info?.rest === 'settled' && info.at ? { restAt: info.at } : {}), ...(info?.until ? { restUntil: info.until } : {}) } as T
}

/** a task as it shows with its mark: its second line says its new rest (core/threads.js agentLine's words, as
 *  core/tasks.js secondLine's), never the old one's; back among the rest (Unsettle, Wake), the line it has awake
 *  (compat awakeSub: core secondLine without its rest, "Próximo: …"), never none */
export function markedTask(t: Task, mark: RestMark | undefined, now = Date.now()): Task {
  const m = marked(t, mark, now)
  if (m === t) return t
  const line = agentLine(null, restInfoOf(m), now) ?? t.awakeSub ?? (t.rest ? undefined : t.sub)
  const { sub: _sub, ...own } = m
  return { ...own, ...(line ? { sub: line } : {}) }
}

/** where the keys are on this screen: the focused split pane (none: no split, or the open task on the right has the
 *  focus: split.pane -1), the open task, the tab shown in the middle (ui.term), the space shown */
export type KeysAt = { pane: Pane | null; task: string | null; term: string | null; place: string }
/** KeysAt from the screen's UI state (kernel UI: device, split, task, term, place) */
export function settleKeys(ui: { device: string; split: Panes; task: string | null; term: string | null; place: string }): KeysAt {
  return { pane: panesHere(ui)[ui.split.pane] ?? null, task: ui.task ?? null, term: ui.term ?? null, place: ui.place }
}

/** what Ctrl+Shift+S (chat.settle) puts away or back, as it shows with its mark: the focused pane's (a space, or a
 *  task); else the open task (it takes the keys, as kernel keysChat); else the shown space. A space is the tab it shows
 *  (ui.term, as the tab bar's shownTab: an agent's tab of its own is a thread, which a thread's click shows, ASH-14),
 *  else its Assistant. A task is one that can be settled (canSettle: with no live agent too), by its agent's chat or,
 *  with none at all, its own key. null: nothing there to settle (a shell's tab, a done task, a space without its
 *  Assistant). */
export type SettleTarget = { chat: string; rest?: Rest; restUntil?: number; task?: Task; tab?: PlaceTab; place?: Place }
export function settleFor(snap: Snapshot, at: KeysAt, marks: RestMarks = {}, now = Date.now()): SettleTarget | null {
  const ofTask = (id: string): SettleTarget | null => {
    const task = snap.tasks.find((x) => x.id === id)
    if (!task?.canSettle || task.archived) return null
    const m = marked(task, marks[taskChat(task)], now)
    return { chat: taskChat(task), rest: m.rest, restUntil: m.restUntil, task }
  }
  const ofPlace = (id: string): SettleTarget | null => {
    const place = snap.places.find((x) => x.id === id)
    const tab = at.term?.startsWith('t:') ? place?.tabs?.find((x) => x.term === at.term) : undefined
    if (tab) {
      if (!tab.thread) return null
      const m = marked(tab, marks[tab.term], now)
      return { chat: tab.term, rest: m.rest, restUntil: m.restUntil, tab }
    }
    if (!place?.assistantTab?.live) return null
    const m = marked(place, marks[place.chat], now)
    return { chat: place.chat, rest: m.rest, restUntil: m.restUntil, place }
  }
  if (at.pane) return at.pane.kind === 'task' ? ofTask(at.pane.id) : at.pane.kind === 'place' ? ofPlace(at.pane.id) : null
  return at.task ? ofTask(at.task) : ofPlace(at.place)
}

/** what a thread of an agent's own (its tab) opening leaves on the screen, after its space is shown (kernel goPlace:
 *  no open task): its tab in the middle (ThreadRow's click) */
export const threadTabShown = (tab: PlaceTab): { term: string; arts: null; menu: false; plus: null; pick: null } =>
  ({ term: tab.term, arts: null, menu: false, plus: null, pick: null })

/** the tasks as they show with the marks on this device */
export const withMarks = (ts: Task[], marks: RestMarks, now = Date.now()): Task[] =>
  Object.keys(marks).length ? ts.map((t) => markedTask(t, marks[taskChat(t)], now)) : ts

/** the marks that still count once a snapshot comes: one the snapshot agrees with, or past PENDING_MS, goes */
export function marksLeft(snap: Snapshot, marks: RestMarks, now = Date.now()): RestMarks {
  const keys = Object.keys(marks)
  if (!keys.length) return marks
  const rows = new Map<string, Restable>()
  for (const t of snap.tasks) rows.set(taskChat(t), t)
  for (const p of snap.places) {
    rows.set(p.chat, p)
    for (const tab of p.tabs ?? []) rows.set(tab.term, tab)
  }
  const left = Object.fromEntries(Object.entries(marks).filter(([k, m]) => shownRest(restInfoOf(rows.get(k) ?? {}), m, now).keep))
  return Object.keys(left).length === keys.length ? marks : left
}

/** one thread row: its key (its chat), what core orders it by, and what the row shows */
export interface Thread {
  key: string
  section: string
  rest: Rest | null
  restInfo: RestInfo
  at: number
  /** its status mark (the Tasks list's dot) */
  status: Status
  title: string
  /** its second line: a task's (core/tasks.js secondLine), an agent's (core/threads.js agentLine) */
  line: string | null
  task?: Task
  tab?: PlaceTab
}

const AGENT_STATUS: Record<string, Status> = { needs: 'need', working: 'work', idle: 'idle' }

/** a space's threads in core order (core/threads.js threadsOf): its tasks whose home it is and that are threads, and its
 *  tabs' agents of its own, each with its mark on this device */
export function placeThreads(snap: Snapshot, place: Place, marks: RestMarks = {}, now = Date.now()): { open: Thread[]; snoozed: Thread[]; settled: Thread[] } {
  const tasks: Thread[] = snap.tasks
    .filter((t) => t.home === place.id && !t.archived)
    .map((t) => markedTask(t, marks[taskChat(t)], now))
    .filter((t) => isThread(t.state, t.rest ?? null))
    .map((t) => ({ key: taskChat(t), section: t.state, rest: t.rest ?? null, restInfo: restInfoOf(t), at: t.activity ?? t.at ?? 0, status: t.status, title: t.name, line: t.sub ?? null, task: t }))
  const agents: Thread[] = (place.tabs ?? [])
    .filter((x) => x.thread)
    .map((x) => marked(x, marks[x.term], now))
    .map((x) => {
      const section = x.section ?? agentSection(x.word ?? null)
      const info = restInfoOf(x)
      return { key: x.term, section, rest: x.rest ?? null, restInfo: info, at: x.at ?? 0, status: AGENT_STATUS[section] ?? 'idle', title: x.name, line: agentLine(x.word ?? null, info, now), tab: x }
    })
  return threadsOf([...tasks, ...agents])
}
