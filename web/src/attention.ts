import { resting, type Snapshot, type Task } from '@shared/types.ts'

/** What waits on you at these places, each number what its own list shows: need is the Needs you view's cards here,
 *  ready the Ready tasks of Tasks. Settled or snoozed (ASH-12) is no news: the service leaves those out of needs. */
export function attentionCounts(snap: Snapshot, places: string[]) {
  const ids = new Set(places)
  return { need: snap.needs.filter((n) => ids.has(n.place)).length, ready: snap.tasks.filter((t) => ids.has(t.place) && !t.archived && t.status === 'ready' && !resting(t)).length }
}

export const actionable = (t: Task) => (t.status === 'need' || t.status === 'ready') && !resting(t)
