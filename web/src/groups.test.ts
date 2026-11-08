import { describe, expect, test } from 'bun:test'
import { groupTasks, loadGroups, saveGroups, shownGroup } from './groups.ts'
import type { Machine, Place, Task } from '@shared/types.ts'

const place = (id: string, name: string, machine: string, emoji?: string) => ({ id, name, machine, level: 2, emoji }) as unknown as Place
const places = [place('a:shep', 'shepherdr', 'a', '🐑'), place('a:tor', 'tor-gameboy', 'a', '🎮'), place('b:gtm', 'gtm', 'b')]
const machines = [{ id: 'm:a', machine: 'a', name: 'vm-a' }, { id: 'm:b', machine: 'b', name: 'mac' }] as Machine[]
let n = 0
const task = (p: string, status: Task['status'], more: Partial<Task> = {}) => {
  const pl = places.find((x) => x.id === p)!
  return { id: `${pl.machine}:T-${++n}`, name: `t${n}`, status, place: p, listName: pl.name, on: pl.machine, age: '', created: '', ...more } as Task
}

describe('For you, then space (SHEP-98)', () => {
  test('needs you then ready on top, then each space in the sidebar order, Done last', () => {
    const ts = [task('b:gtm', 'work'), task('a:shep', 'ready'), task('a:tor', 'need'), task('a:shep', 'todo'), task('a:shep', 'done', { doneAt: 5 }), task('a:shep', 'scheduled'), task('b:gtm', 'need')]
    const gs = groupTasks(places, machines, ts, 'you', 0)
    expect(gs.map((g) => [g.key, g.tasks.map((t) => t.status)])).toEqual([
      ['you', ['need', 'need', 'ready']],
      ['a:shep', ['scheduled', 'todo']],
      ['b:gtm', ['work']],
      ['done', ['done']],
    ])
    // rows under For you say their space, never their machine; a space's rows say nothing
    expect(gs[0].names).toEqual({ machine: false, project: true })
    expect(gs[1].names).toEqual({ machine: false, project: false })
    expect([gs[1].label, gs[1].emoji, gs[1].place, gs[1].note]).toEqual(['shepherdr', '🐑', 'a:shep', undefined])
  })
  test('a pinned task needing you stays in For you; other pinned ones get Pinned', () => {
    const gs = groupTasks(places, machines, [task('a:shep', 'need', { pinned: 1 }), task('a:tor', 'work', { pinned: 1 }), task('a:tor', 'work')], 'you', 0)
    expect(gs.map((g) => [g.key, g.tasks.length])).toEqual([['you', 1], ['pinned', 1], ['a:tor', 1]])
  })
  test('the machine shows only when two machines have a space of that name', () => {
    const two = [...places, place('b:shep', 'shepherdr', 'b')]
    const ts = [task('a:shep', 'work'), task('a:tor', 'work'), { ...task('a:shep', 'work'), id: 'b:T-x', place: 'b:shep', on: 'b' } as Task]
    const gs = groupTasks(two, machines, ts, 'you', 0)
    expect(gs.map((g) => [g.label, g.note])).toEqual([['shepherdr', 'vm-a'], ['tor-gameboy', undefined], ['shepherdr', 'mac']])
  })
  test("Done shows only its count while shut, and its latest five once opened", () => {
    const ts = Array.from({ length: 7 }, (_, i) => task('a:shep', 'done', { doneAt: 100 + i }))
    const [done] = groupTasks(places, machines, ts, 'you', 0)
    expect(shownGroup(done, false, true)).toMatchObject({ count: 7, tasks: [] })
    expect(shownGroup(done, false, false)).toMatchObject({ count: 7, more: 2 })
  })
  test('Status and Space say the space on rows, never the machine', () => {
    const ts = [task('a:shep', 'work'), task('b:gtm', 'need')]
    expect(groupTasks(places, machines, ts, 'status', 0).map((g) => [g.key, g.names])).toEqual([['need', { machine: false, project: true }], ['work', { machine: false, project: true }]])
    expect(groupTasks(places, machines, ts, 'project', 0).map((g) => g.key)).toEqual(['need', 'a:shep'])
  })
  test('the kept choice: For you by default; old Status split by space and the machine ones become For you', () => {
    const store = new Map<string, string>()
    globalThis.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage
    expect(loadGroups()).toEqual({ all: 'you', machine: 'you' })
    store.set('shepherdr.grouping', JSON.stringify({ all: 'status', machine: 'machine-project', split: true }))
    expect(loadGroups()).toEqual({ all: 'you', machine: 'you' })
    store.set('shepherdr.grouping', JSON.stringify({ all: 'status', machine: 'project', split: false }))
    expect(loadGroups()).toEqual({ all: 'status', machine: 'project' })
    saveGroups({ all: 'status', machine: 'you' })
    expect(loadGroups()).toEqual({ all: 'status', machine: 'you' })
  })
})

describe("the window's grouping (core/tasks.js groupNow)", () => {
  test('For you until chosen; old Status split by space and the machine ones become For you', async () => {
    const { groupNow } = (await import('@core/tasks.js')) as { groupNow: (s: (k: string) => unknown) => string }
    const from = (v: Record<string, unknown>) => groupNow((k) => v[k])
    expect(from({})).toBe('you')
    expect(from({ 'tasks.groupby': 'status' })).toBe('you')
    expect(from({ 'tasks.groupby': 'status', 'tasks.split': false })).toBe('status')
    expect(from({ 'tasks.groupby': 'machine-space' })).toBe('you')
    expect(from({ 'tasks.groupby': 'folder' })).toBe('space')
    expect(from({ 'tasks.group': 'status', 'tasks.groupby': 'space' })).toBe('status')
  })
})

describe('Settle and Snooze shelves (ASH-12)', () => {
  const shelf = () => [
    task('a:shep', 'need'),
    task('a:shep', 'need', { rest: 'settled', restAt: 10 }),
    task('a:tor', 'work', { rest: 'snoozed', restUntil: 900 }),
    task('b:gtm', 'ready', { rest: 'snoozed', restUntil: 500 }),
    task('b:gtm', 'work', { rest: 'settled', restAt: 30, pinned: 1 }),
    task('a:shep', 'done', { doneAt: 5 }),
  ]
  test('Snoozed (soonest first) then Settled (latest first) at the very end, in every grouping, in no other group', () => {
    for (const by of ['you', 'project', 'status'] as const) {
      const gs = groupTasks(places, machines, shelf(), by, 0)
      expect(gs.slice(-2).map((g) => [g.key, g.label, g.tasks.map((t) => t.restUntil ?? t.restAt)])).toEqual([
        ['snoozed', 'Snoozed', [500, 900]],
        ['settled', 'Settled', [30, 10]],
      ])
      // a task on a shelf is nowhere else: not For you, Needs you, Ready, Pinned or its space
      const before = gs.slice(0, -2).flatMap((g) => g.tasks)
      expect(before.some((t) => t.rest)).toBe(false)
      expect(gs.some((g) => g.key === 'pinned')).toBe(false)
      // their rows say their space, as far as the view doesn't
      expect(gs.at(-1)!.names).toEqual({ machine: false, project: true })
    }
  })
  test('only when they hold some; archived ones are on neither', () => {
    expect(groupTasks(places, machines, [task('a:shep', 'work')], 'you', 0).map((g) => g.key)).toEqual(['a:shep'])
    expect(groupTasks(places, machines, [task('a:shep', 'work', { rest: 'settled', archived: 3 })], 'you', 0)).toEqual([])
  })
  test('Settled shows only its count while shut', () => {
    const settled = groupTasks(places, machines, shelf(), 'status', 0).at(-1)!
    expect(shownGroup(settled, false, true)).toMatchObject({ key: 'settled', count: 2, tasks: [] })
  })
})
