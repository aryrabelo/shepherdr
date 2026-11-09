// ASH-12 Settle and Snooze, as the window's (core/settle.js, core/menus.js restMenu): a task's row menu, a thread's in
// the sidebar (ASH-14) and an Assistant's header put an agent away by hand. Settle (✓) until new work, Unsettle once
// settled; Snooze with Start later's picks or a time typed in herdr-task's words (Other time…), Wake while a snooze is
// set; a task with no live agent settles too, without Snooze (snooze: false). herdr-task does each (service/actions.ts
// restAct); a settle's toast undoes it (its snooze put back when one was running), a snooze's too. The row moves at once
// (ASH-14: its mark on this screen, kernel markRest), back again when herdr-task refuses. What herdr-task refuses (a time
// passed, no live agent) shows under the menu, kept open.
import clsx from 'clsx'
import { useState } from 'react'
import { ArrowUturnLeftIcon } from '@heroicons/react/16/solid'
import { answerRest, markRest, restChat, type RestAnswer } from '@client/kernel.ts'
import { restMark } from '@client/threads.ts'
import { BellIcon, CheckIcon, ClockIcon, field, ic, MenuItem, MenuLabel } from '@client/ui.tsx'
import { toast } from '@plugins/alerts/toasts.tsx'
import * as MN from '@core/menus.js'
import * as RS from '@core/settle.js'
import * as TK from '@core/tasks.js'

type Words = { placeholder: string; label: string; button: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REST = RS.REST as any
export const SNOOZE_OTHER = MN.SNOOZE_OTHER as Words
export type MenuEntry = { id?: string; label?: string; icon?: string; heading?: string; sep?: boolean; at?: string; in?: string; typed?: boolean }
export const restMenu = MN.restMenu as (o: { rest?: string | null; snoozed?: boolean; snooze?: boolean }) => MenuEntry[]

/** who it is, a chat put away: its key, what a toast calls it ("SHEP-7", "gtm Assistant"), and what it is now */
export type Resting = { chat: string; what: string; rest?: 'settled' | 'snoozed'; restUntil?: number }

const said = (r: RestAnswer, fallback: string) => {
  if (r?.ok === false || r?.error) throw new Error(r.error || fallback)
  return r
}

type Verb = 'settle' | 'unsettle' | 'snooze' | 'wake'
/** herdr-task asked for a chat, its row moved at once: its mark set before, dropped on a refusal; a snooze's gets its
 *  wake time from the answer, an Undo putting a snooze back is snoozed until then. An answer touches only this request's
 *  mark: a newer action on the row (a Wake after a slow Snooze) keeps its own (kernel answerRest) */
async function restNow(chat: string, verb: Verb, more: Parameters<typeof restChat>[2] = {}): Promise<RestAnswer> {
  const back = verb === 'unsettle' && (more?.snoozeUntil ?? 0) > Date.now() ? more!.snoozeUntil! : 0
  const asked = back ? restMark('snooze', back) : restMark(verb)
  markRest(chat, asked)
  try {
    const r = await restChat(chat, verb, more)
    if (r?.ok === false || r?.error) answerRest(chat, asked, null)
    else if ((verb === 'snooze' || verb === 'unsettle') && r?.until) answerRest(chat, asked, restMark('snooze', r.until, undefined, asked))
    return r
  } catch (e) {
    answerRest(chat, asked, null)
    throw e
  }
}

/** Settle: put away until new work; its toast undoes it, a snooze it ended put back */
export async function settleNow(x: Resting): Promise<RestAnswer> {
  const r = said(await restNow(x.chat, 'settle'), "It didn't settle.")
  const back = Math.max(0, ...Object.values(r.was_snoozed ?? {}).map(Number).filter(Number.isFinite))
  toast({ ...REST.settledToast(x.what), level: 'info', timeout: 8000,
    go: () => void restNow(x.chat, 'unsettle', back > Date.now() ? { snoozeUntil: back } : {}).catch(() => undefined) })
  return r
}

export const unsettleNow = async (x: Resting): Promise<RestAnswer> => said(await restNow(x.chat, 'unsettle'), "It didn't unsettle.")
export const wakeNow = async (x: Resting): Promise<RestAnswer> => said(await restNow(x.chat, 'wake'), "It didn't wake.")

/** Snooze until then ({ in } or { at }, herdr-task's words); its toast undoes it: the snooze before it back, settled
 *  again, or awake */
export async function snoozeNow(x: Resting, when: { in?: string; at?: string }): Promise<RestAnswer> {
  const r = said(await restNow(x.chat, 'snooze', when), "It didn't snooze.")
  const before = x.rest === 'snoozed' && (x.restUntil ?? 0) > Date.now() ? x.restUntil! : 0
  const undo = () => (before ? restNow(x.chat, 'unsettle', { snoozeUntil: before }) : x.rest === 'settled' ? restNow(x.chat, 'settle') : restNow(x.chat, 'wake'))
  toast({ ...REST.snoozedToast(x.what, r.when ?? ''), level: 'info', timeout: 8000, go: () => void undo().catch(() => undefined) })
  return r
}

/** the Ctrl+Shift+S key (chat.settle): the chat in view settled, or back once it is */
export function toggleSettle(x: Resting) {
  return (x.rest === 'settled' ? unsettleNow(x) : settleNow(x)).catch((e: Error) => toast({ title: e.message, level: 'error' }))
}

/** a time typed in herdr-task's words, under the picks (Start later's and Snooze's Other time…); what herdr-task refused
 *  under it, never widening the menu */
export function WhenField({ words, busy, error, onSubmit, onChange }: { words: Words; busy: boolean; error: string | null; onSubmit: (text: string) => void; onChange?: () => void }) {
  const [text, setText] = useState('')
  return (
    <div>
      <form className="flex items-center gap-2 px-2 py-1 phone:px-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSubmit(text.trim()) }}>
        <input name="when" aria-label={words.label} autoFocus placeholder={words.placeholder} value={text} disabled={busy}
          onChange={(e) => { setText(e.target.value); onChange?.() }}
          className={clsx(field, 'h-7 min-w-0 flex-1 rounded-md bg-bg px-2 text-[0.8125rem] max-sm:text-base/6 phone:h-9')} />
        <button type="submit" disabled={busy || !text.trim()} className="press-dim h-7 shrink-0 rounded-md bg-bubble px-2.5 text-[0.75rem] font-medium text-fg enabled:hover:bg-sel disabled:opacity-40 phone:h-9 phone:px-3 phone:text-[0.8125rem]">{words.button}</button>
      </form>
      {error ? <p role="alert" className="w-0 min-w-full px-2 pb-1.5 text-[0.75rem]/4 text-need-fg phone:px-3 phone:text-[0.8125rem]/5">{error}</p> : null}
    </div>
  )
}

/** what a rest item does, as one menu row: busy while herdr-task works on it, its refusal shown by the menu */
export function useRest(x: Resting, close: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const go = async (f: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await f()
      close()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  /** one of restMenu()'s items as a menu row, or null when it is none of them */
  const item = (it: MenuEntry, i: number) => {
    if (it.heading === REST.snooze) return <MenuLabel key={`h${i}`}>{x.rest === 'snoozed' && x.restUntil ? `${it.heading} · ${wakes(x.restUntil)}` : it.heading}</MenuLabel>
    if (it.id === 'settle') return <MenuItem key="settle" disabled={busy} icon={<CheckIcon className={ic} />} onClick={() => void go(() => settleNow(x))}>{it.label}</MenuItem>
    if (it.id === 'unsettle') return <MenuItem key="unsettle" disabled={busy} icon={<ArrowUturnLeftIcon className={ic} />} onClick={() => void go(() => unsettleNow(x))}>{it.label}</MenuItem>
    if (it.id === 'snooze') return <MenuItem key={`snooze${it.label}`} disabled={busy} icon={<ClockIcon className={ic} />} onClick={() => void go(() => snoozeNow(x, it.in ? { in: it.in } : { at: it.at }))}>{it.label}</MenuItem>
    if (it.id === 'snooze-other')
      return typing ? <WhenField key="snooze-other" words={SNOOZE_OTHER} busy={busy} error={error} onChange={() => setError(null)} onSubmit={(at) => void go(() => snoozeNow(x, { at }))} />
        : <MenuItem key="snooze-other" disabled={busy} icon={<ClockIcon className={ic} />} onClick={() => setTyping(true)}>{it.label}</MenuItem>
    if (it.id === 'wake') return <MenuItem key="wake" disabled={busy} icon={<BellIcon className={ic} />} onClick={() => void go(() => wakeNow(x))}>{it.label}</MenuItem>
    return null
  }
  return { item, busy, error: typing ? null : error }
}

/** "Wakes Today 18:00" (core/tasks.js wakesLine) */
export const wakes = (ms: number) => (TK.wakesLine as (ms: number) => string)(ms)
