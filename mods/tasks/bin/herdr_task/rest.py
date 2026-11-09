"""Settle and Snooze (ASH-12) on the command line: the one way the window, the web app and agents put an agent
away by hand. The labels go on the agents' own terminals (settle.py has the rules, as core/settle.js):

  settle    settled=<ms>:<turn> on each live agent (a task's: its workers, never its reviewer); clears a snooze.
            A task with no live agent (stopped, queued, its agent closed) keeps the settle on itself (settled_at,
            ASH-14) until it has new work: a start or resume, an agent started for it, failing checks.
  unsettle  clears it (labels and a kept settle); --snooze-until puts back a snooze the settle ended, while it
            hasn't run out (Undo)
  snooze    snoozed=<wake ms> (--in / --at, Start later's words); clears a settle. Needs a live agent.
  wake      clears the snooze (also "woke, now seen")

The scheduler clears what went stale each round (rest_pass): a settle once there's new work, a snooze on a failure."""

import os

from .base import Fail, hc_json, now, run
from .agents import agent_running, detail, live_agents
from .output import say
from .settle import labels_of, settled_value, snoozed_until, stale, word_of, SETTLED, SNOOZED
from .store import open_store
from .when import clock_words, parse_in, when_from

# The words people see (core/settle.js REST.noAgent, REST.noSnooze and REST.past).
NO_AGENT = "It has no live agent to settle or snooze."
NO_SNOOZE = "It has no live agent to snooze."
PAST = "That time has passed. Choose another."
DONE = "It's done: nothing to settle."


def targets(args, none_ok=False):
    """(the terminals to label, what to call them): --agent's live terminal, or a task's live agents that aren't
    its reviewer (its worker's helpers are never among them). A task with none: [] when none_ok, else refused."""
    if bool(getattr(args, "id", None)) == bool(getattr(args, "agent", None)):
        raise Fail("Give a task id or --agent <terminal>, one of them.")
    if args.agent:
        k = hc_json("get", args.agent)
        if not k or k.get("state") != "live":
            raise Fail(NO_AGENT)
        # Labelled by the address given: another machine's (vm/t5) answers with its own name for it (t5).
        return [dict(k, address=args.agent)], args.agent
    with open_store(args, write=False) as s:
        t = s.find(args.id)
        key, ref = s.key(t), s.ref(t)
    own = [k for k in map(detail, live_agents(key)) if agent_running(k) and labels_of(k).get("herdr.role") != "reviewer"]
    if not own and not none_ok:
        raise Fail(NO_SNOOZE)
    return own, ref


def keep_settle(args, at):
    """ASH-14: a task's settle kept on the task itself (settled_at; at None: cleared). Whether one was there."""
    with open_store(args) as s:
        t = s.find(args.id)
        if at is not None and t.get("state") == "done":
            raise Fail(DONE)
        had = bool(t.get("settled_at"))
        if at is None:
            t.pop("settled_at", None)
        else:
            t["settled_at"] = at
        s.dirty = s.dirty or had or at is not None
    return had


def label(address, **values):
    """hc label; an empty value clears that label."""
    r = run(["hc", "label", address, *[f"{k}={v}" for k, v in values.items()]])
    if r.returncode != 0:
        raise Fail((r.stderr or r.stdout).strip() or "hc label failed")


def wake_time(at, within, now_ms):
    """--at / --in (Start later's words, when.py) to the wake moment; a moment already passed is refused."""
    if at is not None and within is not None:
        raise Fail("Give --in or --at, not both.")
    if at is None and within is None:
        raise Fail('Say when it wakes: --in 3h or --at "tomorrow 9:00".')
    try:
        ms = now_ms + parse_in(within) if within is not None else when_from(at, None, now_ms)
    except Fail as e:
        if "has passed" in str(e):
            raise Fail(PAST)
        raise
    if ms <= now_ms:
        raise Fail(PAST)
    return ms


def cmd_settle(args):
    ks, what = targets(args, none_ok=True)
    me = os.environ.get("HC_TERMINAL_ID")
    if me and any(k["address"] == me for k in ks):
        # Its own turn is at work while it runs this: the settle would end with it.
        raise Fail("You can't settle yourself while you work: the person settles your chat, or snooze it instead.")
    at, was = now(), {}
    for k in ks:
        if snoozed_until(k):
            was[k["address"]] = snoozed_until(k)
        label(k["address"], **{SETTLED: settled_value(k.get("turn"), at), SNOOZED: ""})
    # A task's: with no live agent of its own the settle is kept on the task (ASH-14); with one, its labels say it.
    if args.id:
        keep_settle(args, None if ks else at)
    addrs = [k["address"] for k in ks]
    say(args, {"ok": True, "settled": addrs, "at": at, "was_snoozed": was, **({} if ks else {"kept": True})},
        f"Settled {what}: out of the way until it has new work.")


def cmd_unsettle(args):
    ks, what = targets(args, none_ok=True)
    back = args.snooze_until if args.snooze_until and args.snooze_until > now() else None
    for k in ks:
        label(k["address"], **{SETTLED: "", **({SNOOZED: back} if back else {})})
    if args.id:
        keep_settle(args, None)
    out = {"ok": True, "unsettled": [k["address"] for k in ks], **({"until": back} if back and ks else {})}
    say(args, out, f"Unsettled {what}." + (f" Snoozed again until {clock_words(back, now())}." if back and ks else ""))


def cmd_snooze(args):
    t = now()
    until = wake_time(args.at, args.in_, t)
    ks, what = targets(args)
    for k in ks:
        label(k["address"], **{SNOOZED: until, SETTLED: ""})
    # a snooze ends a settle, a kept one too
    if args.id:
        keep_settle(args, None)
    when = clock_words(until, t)
    say(args, {"ok": True, "snoozed": [k["address"] for k in ks], "until": until, "when": when}, f"Snoozed {what}: wakes {when}.")


def cmd_wake(args):
    # nothing to wake (no live agent) is no refusal: a pin or a look wakes quietly
    ks, what = targets(args, none_ok=True)
    for k in ks:
        label(k["address"], **{SNOOZED: ""})
    say(args, {"ok": True, "woke": [k["address"] for k in ks]}, f"Woke {what}.")


# ---- the scheduler's round --------------------------------------------------------------------------------------
# Stale labels go whoever sees them first (the window, the service, here). hc ls has no labels, so each live agent
# of this machine (a terminal with a status: shells and the scheduler have none) is read with hc get, a few ms each.
# A task's worker counts its own helpers (its hc children) as sub-agents; an Assistant counts none, as the window's
# unread does (core/spaces.js), or its workers' turns would end its settle.

def rest_pass(report):
    """Clears settled once there's new work and snoozed on a failure (settle.stale()), on every live agent here
    that carries one. Never raises."""
    try:
        terms = [k for k in (hc_json("ls") or {}).get("terminals") or [] if k.get("state") == "live"]
    except Exception:
        return
    cleared = []
    for k in terms:
        addr = str(k.get("address") or "")
        if not addr or "/" in addr or k.get("status") is None:
            continue
        try:
            full = hc_json("get", addr) or {}
            lb = labels_of(full)
            if not (lb.get(SETTLED) or lb.get(SNOOZED)) or full.get("state") != "live":
                continue
            kids = [word_of(c) for c in terms if c.get("parent") == addr] if lb.get("herdr.task") else []
            gone = stale(full, word_of(full), [w for w in kids if w])
            clear = {name: "" for name, yes in gone.items() if yes}
            if clear and run(["hc", "label", addr, *[f"{n}=" for n in clear]]).returncode == 0:
                cleared.append({"address": addr, "cleared": sorted(clear)})
        except Exception:  # one terminal never stops the rest, nor the round
            continue
    if cleared:
        report.setdefault("rest_cleared", []).extend(cleared)


def resting(task, key):
    """settle.task_rest()'s rest for a task now ("settled", "snoozed" or None), from its running agents (none: a settle
    kept on the task, ASH-14)."""
    from .agents import rest_now
    running = [k for k in map(detail, live_agents(key)) if agent_running(k)]
    return (rest_now(task, key, running) or {}).get("rest")
