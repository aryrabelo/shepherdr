import { describe, expect, test } from 'bun:test'
import { marksAfter, marksLeft, placeThreads, restMark, settleTarget, withMarks, type RestMarks } from './threads.ts'
import type { Place, PlaceTab, Snapshot, Task } from '@shared/types.ts'
import * as RS from '@core/settle.js'

const NOW = 1_800_000_000_000
const PENDING_MS = RS.PENDING_MS as number
const STATUS: Record<string, Task['status']> = { needs: 'need', working: 'work', merging: 'merging', ready: 'ready', queued: 'queued', todo: 'todo', done: 'done' }
const task = (id: string, state: string, more: Partial<Task> = {}) =>
  ({ id, name: id, status: STATUS[state], state, place: 'sp1', home: 'sp1', age: '', on: 'mini', created: '', agent: { chat: `${id}/worker` }, ...more }) as Task
const tab = (term: string, word: string, more: Partial<PlaceTab> = {}) =>
  ({ name: term, term, thread: true, word, section: word === 'blocked' ? 'needs' : word === 'working' ? 'working' : 'idle', ...more }) as PlaceTab
const place = (tabs: PlaceTab[] = []) => ({ id: 'sp1', name: 'shop', chat: 'p:sp1', tabs }) as unknown as Place
const snapOf = (tasks: Task[], tabs: PlaceTab[] = []) => ({ tasks, places: [place(tabs)] }) as unknown as Snapshot
const keys = (s: { open: { key: string }[]; snoozed: { key: string }[]; settled: { key: string }[] }) => [s.open, s.snoozed, s.settled].map((g) => g.map((x) => x.key))

describe('a space’s threads in the sidebar (ASH-14)', () => {
  test('needs you, then at work, then the rest by latest activity; its tabs’ agents among them; Snoozed then Settled', () => {
    const tasks = [
      task('S-1', 'ready', { activity: 50 }),
      task('S-2', 'working', { activity: 10 }),
      task('S-3', 'needs', { activity: 5 }),
      task('S-4', 'queued', { activity: 90 }),
      task('S-5', 'working', { rest: 'snoozed', restUntil: NOW + 7200_000 }),
      task('S-6', 'ready', { rest: 'settled', restAt: 100 }),
      task('S-7', 'needs', { rest: 'settled', restAt: 300 }),
      task('S-8', 'merging', { rest: 'snoozed', restUntil: NOW + 600_000 }),
      // To do, Done and archived ones stay in the Tasks list; another space's are its own
      task('S-9', 'todo'), task('S-10', 'done'), task('S-11', 'working', { archived: 1 }), task('S-12', 'working', { home: 'sp2' }),
    ]
    const tabs = [tab('t:t7', 'idle', { at: 70 }), tab('t:t8', 'blocked', { at: 1 }), tab('t:t9', 'idle', { rest: 'settled', restAt: 200 }), { name: 'zsh', term: 't:t3' } as PlaceTab]
    const s = placeThreads(snapOf(tasks, tabs), place(tabs), {}, NOW)
    expect(keys(s)).toEqual([
      ['S-3/worker', 't:t8', 'S-2/worker', 'S-4/worker', 't:t7', 'S-1/worker'],
      ['S-8/worker', 'S-5/worker'],
      ['S-7/worker', 't:t9', 'S-6/worker'],
    ])
    // each row: its dot (an agent asking needs you), its title, its second line (an agent's: core agentLine)
    const asking = s.open.find((x) => x.key === 't:t8')!
    expect([asking.status, asking.title, asking.line]).toEqual(['need', 't:t8', 'Question for you'])
    expect(s.settled.find((x) => x.key === 't:t9')!.line).toStartWith('Settled ')
  })

  test('a task with a settle kept on it (no live agent: To do) shows on Settled, nowhere else', () => {
    const s = placeThreads(snapOf([task('S-1', 'todo', { rest: 'settled', restAt: 10 })]), place(), {}, NOW)
    expect(keys(s)).toEqual([[], [], ['S-1/worker']])
  })
})

describe('rows put away at once (ASH-14 marks)', () => {
  const tasks = [task('S-1', 'working', { activity: 5, sub: 'Building' }), task('S-2', 'needs', { rest: 'settled', restAt: 10, sub: 'Settled 2m ago' })]
  const at = (marks: RestMarks, now = NOW) => keys(placeThreads(snapOf(tasks), place(), marks, now))

  test('Settle moves a row to Settled at once, its second line saying so; Unsettle brings one back', () => {
    const marks: RestMarks = { 'S-1/worker': restMark('settle', null, NOW), 'S-2/worker': restMark('unsettle', null, NOW) }
    expect(at(marks)).toEqual([['S-2/worker'], [], ['S-1/worker']])
    const shown = withMarks(tasks, marks, NOW)
    expect([shown[0].rest, shown[0].restAt, shown[0].sub]).toEqual(['settled', NOW, 'Settled just now'])
    // the old "Settled 2m ago" goes with its settle
    expect([shown[1].rest, shown[1].sub]).toEqual([undefined, undefined])
  })

  test('Snooze moves it to Snoozed, at its wake time once herdr-task said it', () => {
    const s = placeThreads(snapOf(tasks), place(), { 'S-1/worker': restMark('snooze', NOW + 3600_000, NOW) }, NOW)
    expect(keys(s)).toEqual([[], ['S-1/worker'], ['S-2/worker']])
    expect(s.snoozed[0].restInfo).toEqual({ rest: 'snoozed', until: NOW + 3600_000 })
  })

  test('a mark stops counting after PENDING_MS: the row goes back where the snapshot has it', () => {
    const marks: RestMarks = { 'S-1/worker': restMark('settle', null, NOW) }
    expect(at(marks, NOW + PENDING_MS + 1)).toEqual([['S-1/worker'], [], ['S-2/worker']])
    expect(marksLeft(snapOf(tasks), marks, NOW + PENDING_MS + 1)).toEqual({})
  })

  test('a snapshot that agrees spends the mark; one that doesn’t yet keeps it; an agent’s tab too', () => {
    const marks: RestMarks = { 'S-1/worker': restMark('settle', null, NOW), 't:t7': restMark('snooze', NOW + 60_000, NOW) }
    expect(marksLeft(snapOf(tasks, [tab('t:t7', 'idle')]), marks, NOW + 1000)).toBe(marks)
    const agreed = snapOf([{ ...tasks[0], rest: 'settled', restAt: NOW }, tasks[1]], [tab('t:t7', 'idle', { rest: 'snoozed', restUntil: NOW + 60_000 })])
    expect(marksLeft(agreed, marks, NOW + 1000)).toEqual({})
  })
})

describe('ASH-14 review', () => {
  test('Unsettle or Wake shows the line it has awake at once, never none (item 6)', () => {
    const t = task('S-1', 'ready', { rest: 'settled', restAt: 100, sub: 'Settled 2m ago', awakeSub: 'Próximo: abrir o PR' })
    expect(withMarks([t], { 'S-1/worker': restMark('unsettle', null, NOW) }, NOW + 10)[0].sub).toBe('Próximo: abrir o PR')
    const nap = task('S-2', 'working', { rest: 'snoozed', restUntil: NOW + 3600_000, sub: 'Wakes Today 18:00', awakeSub: 'Fixing the login' })
    expect(withMarks([nap], { 'S-2/worker': restMark('wake', null, NOW) }, NOW + 10)[0].sub).toBe('Fixing the login')
    // its mark spent (the snapshot agrees): the snapshot's own line
    expect(withMarks([{ ...t, rest: undefined, restAt: undefined, sub: 'Ready 1m ago' }], { 'S-1/worker': restMark('unsettle', null, NOW) }, NOW + 10)[0].sub).toBe('Ready 1m ago')
  })

  test('Ctrl+Shift+S: a task with no live agent, an agent’s own tab, the Assistant; each as it shows with its mark (item 1)', () => {
    const stopped = task('S-1', 'needs', { agent: undefined, canSettle: true })
    const working = task('S-2', 'working', { canSettle: true, canRest: true, rest: 'settled', restAt: 5 })
    const agentTab = tab('t:t7', 'idle', { rest: 'settled', restAt: 9 })
    const p = { ...place([agentTab]), assistantTab: { live: true } } as unknown as Place
    const snap = { tasks: [stopped, working, task('S-3', 'done', { canSettle: false })], places: [p] } as unknown as Snapshot
    // the task open with no agent at all: the key falls back to its space's chat, the task is what's settled
    expect(settleTarget(snap, 'p:sp1', 'S-1')).toMatchObject({ chat: 'S-1/Agent', task: stopped })
    expect(settleTarget(snap, 'S-2/worker', null)).toMatchObject({ chat: 'S-2/worker', rest: 'settled' })
    // marked a moment ago (Unsettle): it shows awake, so the key settles it again
    expect(settleTarget(snap, 'S-2/worker', null, { 'S-2/worker': restMark('unsettle', null, NOW) }, NOW + 10)?.rest).toBeUndefined()
    expect(settleTarget(snap, 't:t7', null)).toMatchObject({ chat: 't:t7', rest: 'settled', tab: agentTab })
    expect(settleTarget(snap, 'p:sp1', null)).toMatchObject({ chat: 'p:sp1', place: p })
    expect(settleTarget(snap, 'S-3/worker', null)).toBeNull()
  })

  test('a late answer leaves a newer action’s mark alone (item 7)', () => {
    const slow = restMark('snooze', null, NOW), wake = restMark('wake', null, NOW + 5)
    const marks: RestMarks = { 't:t7': wake }
    expect(marksAfter(marks, 't:t7', slow, restMark('snooze', NOW + 3600_000, slow.at))).toBe(marks)
    expect(marksAfter(marks, 't:t7', wake, null)).toEqual({})
  })
})
