// Threads in the sidebar (ASH-14), as the window's (core/threads.js): under each space's row its threads, its tasks at
// work or waiting on someone (or put away by hand) and the agents of its own in its tabs, in core order, then its
// Snoozed and Settled shelves. And rows put away at once: Settle, Unsettle, Snooze and Wake keep a mark on this device
// by the row's chat key (core/settle.js restMark) until the snapshot agrees, refuses, or PENDING_MS passes, so the row
// moves the moment it's asked, here and in the Tasks list.
import type { Place, PlaceTab, Snapshot, Status, Task } from '@shared/types.ts'
import * as THc from '@core/threads.js'
import * as RSc from '@core/settle.js'

type Rest = 'settled' | 'snoozed'
/** a row's rest as core/settle.js taskRest/agentRest give it */
export type RestInfo = { rest: Rest | null; at?: number | null; until?: number | null; woke?: number; showing?: boolean } | null
/** a row put away (or back) just now: core/settle.js restMark */
export type RestMark = { rest: Rest | null; until?: number; at: number }
/** the marks on this device, by chat key */
export type RestMarks = Record<string, RestMark>
/** what the snapshot says of a row's rest (a task, a tab, a space's Assistant) */
type Restable = { rest?: Rest; restAt?: number; restUntil?: number; woke?: number }

const shownRest = RSc.shownRest as (info: RestInfo, mark: RestMark | undefined, now?: number) => { info: RestInfo; keep: boolean }
const marksWith = RSc.marksWith as (marks: RestMarks, key: string, mark: RestMark | null, now?: number) => RestMarks
const restMark = RSc.restMark as (verb: string, until?: number | null, at?: number) => RestMark
const isThread = THc.isThread as (section: string, rest?: Rest | null) => boolean
const agentSection = THc.agentSection as (word: string | null) => 'needs' | 'working' | 'idle'
const agentLine = THc.agentLine as (word: string | null, info: RestInfo, now?: number) => string | null
const threadsOf = THc.threadsOf as <T extends { key: string; section: string; rest: Rest | null; restInfo: RestInfo; at: number }>(items: T[]) => { open: T[]; snoozed: T[]; settled: T[] }

export { marksWith, restMark }

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
 *  core/tasks.js secondLine's), never the old one's */
export function markedTask(t: Task, mark: RestMark | undefined, now = Date.now()): Task {
  const m = marked(t, mark, now)
  if (m === t) return t
  const line = agentLine(null, restInfoOf(m), now) ?? (t.rest ? undefined : t.sub)
  const { sub: _sub, ...own } = m
  return { ...own, ...(line ? { sub: line } : {}) }
}

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
