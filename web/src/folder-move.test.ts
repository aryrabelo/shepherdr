// ASH-15 review item 5: a space dropped among a folder's spaces shows where the service will put it (last: a folder
// keeps Herdr's order), never before a space there only to jump back.
import { expect, test } from 'bun:test'
import { moveIn } from '../shared/order.ts'

const isGroup = (k: string) => k === 'pinned' || k.startsWith('s:') || k.startsWith('m:') || k.startsWith('f:')
const lists = { 'm:mac': ['a', 'b'], 'f:x': ['c', 'd'], 's:1': ['e'] }

test('into a folder: last, no before, compared loosely', () => {
  const m = moveIn(lists, 'a', 'f:x', 'c', isGroup)!
  expect(m.before).toBeUndefined()
  expect(m.next['f:x']).toEqual(['c', 'd', 'a'])
  expect(m.next['m:mac']).toEqual(['b'])
  expect(m.loose).toBe(true)
})

test('within its own folder: nothing moves', () => {
  expect(moveIn(lists, 'c', 'f:x', 'd', isGroup)).toBeNull()
})

test('a section keeps the place it was dropped at', () => {
  const m = moveIn(lists, 'a', 's:1', 'e', isGroup)!
  expect(m.next['s:1']).toEqual(['a', 'e'])
  expect(m.before).toBe('e')
  expect(m.loose).toBe(false)
})
