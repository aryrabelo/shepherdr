"""Settle and Snooze (ASH-12): an agent put away by hand, as T3 Code does with a thread. The same labels
as herdr-t3-inbox (Apache-2.0) and the same rules as core/settle.js (keep them equal):

  settled=<ms>:<turn>  stays while there's no new work: not busy (working or blocked), no sub-agent busy,
                       and no turn ended since (turn <= the label's turn).
  snoozed=<wake ms>    out of sight until then, unless it needs the person or failed; past it, "woke"
                       until looked at. An empty value clears either label.

Settled or snoozed isn't news: no needs-you event, alert or count for it. A task is its live agents':
settled while each of them still is (and no failing checks came up since), snoozed while one is. A task
with no live agent settles too (ASH-14): the settle is kept on the task (settled_at) until new work."""

SETTLED = "settled"
SNOOZED = "snoozed"


def _busy(s):
    return s in ("working", "blocked")


def word_of(k):
    """A terminal's status as a plain word (hc's records may give {state})."""
    s = (k or {}).get("status")
    return s.get("state") if isinstance(s, dict) else s


def settled_value(turn, at):
    return f"{int(at)}:{max(0, int(turn or 0))}"


def parse_settled(v):
    """"<ms>:<turn>" -> (at, turn), or None."""
    if not v:
        return None
    parts = str(v).split(":")
    try:
        at = int(float(parts[0]))
    except ValueError:
        return None
    if at <= 0:
        return None
    try:
        turn = int(float(parts[1])) if len(parts) > 1 else 0
    except ValueError:
        turn = 0
    return at, turn


def labels_of(k):
    return (k or {}).get("labels") or {}


def still_settled(k, word, kids=()):
    s = parse_settled(labels_of(k).get(SETTLED))
    if not s:
        return False
    return not _busy(word) and not any(_busy(x) for x in kids) and (k.get("turn") or 0) <= s[1]


def snoozed_until(k):
    try:
        return int(float(labels_of(k).get(SNOOZED) or 0))
    except ValueError:
        return 0


def failed(word, kids=()):
    return word == "error" or "error" in kids


def hidden(k, word, kids, now_ms):
    return (not still_settled(k, word, kids) and snoozed_until(k) > now_ms and word != "blocked"
            and "blocked" not in kids and not failed(word, kids))


def not_news(k, word, kids, now_ms):
    return still_settled(k, word, kids) or hidden(k, word, kids, now_ms)


def stale(k, word, kids=()):
    """Which labels to clear now: settled once there's new work, snoozed on a failure."""
    return {"settled": bool(labels_of(k).get(SETTLED)) and not still_settled(k, word, kids),
            "snoozed": snoozed_until(k) > 0 and failed(word, kids)}


def kept_settle(task):
    """As core/settle.js keptSettle(): a task settled with no live agent to label keeps when on itself
    (settled_at). A start or resume since (started), an agent started for it since (agents[].at), or failing
    checks or a conflict found since (attention_at) end it. A done task has none."""
    task = task or {}
    try:
        at = int(float(task.get("settled_at") or 0))
    except (TypeError, ValueError):
        at = 0
    if not at or task.get("state") == "done":
        return None

    def since(x):
        try:
            return int(float(x or 0)) > at
        except (TypeError, ValueError):
            return False
    if since(task.get("started")) or since(task.get("attention_at")) or any(since((a or {}).get("at")) for a in task.get("agents") or []):
        return None
    return {"rest": SETTLED, "at": at}


def task_rest(task, live, helpers, now_ms):
    """As core/settle.js taskRest(): live = its agents (hc records with labels), helpers = its worker's
    helper agents. -> None, {"rest": "settled", "at"}, {"rest": "snoozed", "until"},
    {"rest": None, "until", "showing": True} or {"rest": None, "woke": until}. With no live agent of its
    own: kept_settle()."""
    own = [k for k in live if labels_of(k).get("herdr.role") != "reviewer"]
    if not own:
        return kept_settle(task)
    kids = [w for w in (word_of(h) for h in helpers) if w]
    settled = [parse_settled(labels_of(k).get(SETTLED)) for k in own]
    if all(settled) and all(still_settled(k, word_of(k), kids) for k in own):
        at = max(s[0] for s in settled)
        if not (task.get("attention") and (task.get("attention_at") or 0) > at):
            return {"rest": SETTLED, "at": at}
    until = max([0] + [snoozed_until(k) for k in own])
    if not until:
        return None
    if until <= now_ms:
        return {"rest": None, "woke": until}
    asks = any(word_of(k) in ("blocked", "error") for k in own) or any(w in ("blocked", "error") for w in kids) \
        or bool(task.get("attention"))
    return {"rest": None, "until": until, "showing": True} if asks else {"rest": SNOOZED, "until": until}
