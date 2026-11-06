"""A task's reviewer (ASH-8): its worker starts it with `herdr-task review-start`, as the brief's
recipe says. Read-only, the Reviewer line's CLI with its model and effort, an hc child of the
worker labelled herdr.role=reviewer. Codex gets the trust it needs to start without stopping: its
CLI's hash for Shepherdr's own hook (the chat's SessionStart note in its hooks.json, never another
hook), and the task's own worktree as a trusted folder (never any other folder). Then its first
minute is watched: stuck on a start screen (stopped and ended) or exited, the worker hears so at
once with the screen's first lines, and falls back to the other CLI, instead of waiting 10 minutes
on an agent that never began."""

import json
import os
import re
import shlex
import time

from .base import Fail, hc_json, run
from .agents import start_screen, status_word
from .launch import hook_hash, low_priority, own_path
from .output import say
from .settings import task_settings
from .store import open_store

# Each CLI read-only, as the worker brief names them.
READ_ONLY = {
    "codex": ["codex", "--sandbox", "read-only", "--ask-for-approval", "never"],
    "claude": ["claude", "--permission-mode", "plan"],
    # omp's read-only tools only (not lsp, which can apply edits, nor bash): it reads the diff in its prompt.
    "omp": ["omp", "--tools", "read,grep,find,glob,ast_grep"],
}
WATCH_S = 60  # how long its start is watched
STEP_S = 2
FIRST_LINES = 12


# The one Codex hook Shepherdr installs (bin/shepherdr HOOKS): the chat's SessionStart note.
OWN_HOOK = re.compile(r"sh '(/[^']*)/mods/chat/session-note\.sh'")


def codex_home():
    return os.path.abspath(os.path.expanduser(os.environ.get("CODEX_HOME") or "~/.codex"))


def own_hook_trust():
    """{hooks.state key: trusted hash} for Shepherdr's own hook in Codex's hooks.json, as it is now;
    every other hook there is left to Codex and the person."""
    path = os.path.join(codex_home(), "hooks.json")
    try:
        with open(path) as f:
            events = (json.load(f) or {}).get("hooks")
    except (OSError, ValueError, AttributeError):
        return {}
    out = {}
    for event, groups in (events.items() if isinstance(events, dict) else []):
        snake = re.sub(r"(?<!^)([A-Z])", r"_\1", str(event)).lower()
        for gi, group in enumerate(groups if isinstance(groups, list) else []):
            hooks = group.get("hooks") if isinstance(group, dict) else None
            for hi, hook in enumerate(hooks if isinstance(hooks, list) else []):
                if not isinstance(hook, dict) or hook.get("type", "command") != "command":
                    continue
                m = OWN_HOOK.fullmatch(str(hook.get("command") or ""))
                if m and os.path.isfile(os.path.join(m.group(1), "mods", "chat", "session-note.sh")):
                    out[f"{path}:{snake}:{gi}:{hi}"] = hook_hash(snake, hook)
    return out


def codex_trust(cwd, worktree):
    """Codex's -c words for this launch only: Shepherdr's own hook trusted, and the folder trusted
    only when it is the task's own worktree. Nothing is written to the person's config."""
    flags = []
    hooks = own_hook_trust()
    if hooks:
        flags += ["-c", "hooks.state={" + ",".join(f"{json.dumps(k)}={{trusted_hash={json.dumps(v)}}}" for k, v in hooks.items()) + "}"]
    if worktree and os.path.isdir(worktree) and os.path.realpath(cwd) == os.path.realpath(worktree):
        flags += ["-c", f"projects={{{json.dumps(os.path.realpath(worktree))}={{trust_level=\"trusted\"}}}}"]
    return flags


def reviewer_argv(agent, model=None, effort=None, cwd=None, worktree=None):
    """The reviewer's argv: its CLI read-only, with its model and effort (as argv_for writes them)."""
    a = list(READ_ONLY.get(agent) or [agent])
    if agent == "codex":
        a += ["-m", model] if model else []
        a += ["-c", f'model_reasoning_effort="{effort}"'] if effort else []
        a += codex_trust(cwd, worktree) if cwd else []
    elif agent == "omp":
        a += ["--model", model] if model else []
        a += ["--thinking", effort] if effort else []
    else:
        a += ["--model", model] if model else []
        a += ["--effort", effort] if effort else []
    return a


def reviewer_pick(s, t, agent=None):
    """(agent, model, effort): the Settings block's Reviewer line, or `agent` (another CLI starts
    from its own defaults: models differ per CLI)."""
    rv = next((x["value"] for x in task_settings(s, t) if x["label"] == "Reviewer"), None) or {}
    if agent and agent != rv.get("agent"):
        return agent, None, None
    return rv.get("agent") or agent or "claude", rv.get("model"), rv.get("effort")


def first_lines(name):
    """Its screen's first lines (blank ones left out), for the worker to see why."""
    r = run(["hc", "read", name])
    lines = [x.rstrip() for x in (r.stdout or "").split("\n") if x.strip()] if r.returncode == 0 else []
    return "\n".join("  " + x[:160] for x in lines[:FIRST_LINES]) or "  (nothing on its screen)"


def watch(name):
    """How its start went: ("started"|"exited"|"screen"|"asks"|"quiet", hc get's record, why)."""
    end = time.time() + WATCH_S
    while True:
        k = hc_json("get", name)
        if not k:  # not listed yet, or gone
            if time.time() >= end:
                return "exited", {}, None
            time.sleep(STEP_S)
            continue
        if k.get("state") != "live":
            return "exited", k, None
        if status_word(k) == "working" or (k.get("turn") or 0) > 0:
            return "started", k, None
        if status_word(k) == "blocked":
            return "asks", k, None
        why = start_screen(k)
        if why:
            return "screen", k, why
        if time.time() >= end:
            return "quiet", k, None
        time.sleep(STEP_S)


CLI_NAMES = {"codex": "Codex", "claude": "Claude Code", "omp": "omp"}


def cmd_review_start(args):
    with open_store(args, write=False) as s:
        t = s.find(args.id)
        if t["state"] not in ("running", "ready"):
            raise Fail(f"{s.ref(t)} isn't being worked on: there is nothing to review.")
        ref, key = s.ref(t), s.key(t)
        worktree = t.get("worktree") if t.get("mode") == "worktree" else None
        cwd = worktree if worktree and os.path.isdir(worktree) else s.loc["folder"]
        agent, model, effort = reviewer_pick(s, t, args.agent)
        folder = s.loc["folder"]
    prompt = args.prompt
    if args.prompt_file:
        with open(os.path.expanduser(args.prompt_file)) as f:
            prompt = f.read()
    if not (prompt or "").strip():
        raise Fail("Give the reviewer its prompt: the brief, the diff against the base branch and the reviewer template.")
    name = f"{ref.lower()}-review"
    other = "codex" if agent == "claude" else "claude"
    again = f"`{own_path()} review-start {ref} --folder {shlex.quote(folder)} --agent {other} \"<prompt>\"` (the other CLI, read-only)"
    old = hc_json("get", name)
    if old and old.get("state") == "live":
        raise Fail(f"{name} is still running: read it with `hc read {name} --lines 400`, end it with `hc kill {name}`, then start again.")
    argv = reviewer_argv(agent, model, effort, cwd, worktree) + [prompt]
    me = os.environ.get("HC_TERMINAL_ID")
    r = run(["hc", "run", "--bg", "--json", "--name", name, "--cwd", cwd, "--label", f"herdr.task={key}",
             "--label", "herdr.role=reviewer", "--label", f"herdr.agent={agent}", *(["--parent", me] if me else []),
             "--", *low_priority(argv, name)])
    if r.returncode != 0:
        raise Fail(f"{CLI_NAMES.get(agent, agent)} couldn't be started: {(r.stderr or r.stdout).strip()}\nStart it with {again}")
    how, k, why = watch(name)
    cli = CLI_NAMES.get(agent, agent)
    if how == "started":
        return say(args, {"name": name, "agent": agent, "started": True},
                   f"{name} ({cli}, read-only) is reviewing. Wait for it with `hc wait {name} --timeout 600`, read its report with "
                   f"`hc read {name} --lines 400`, then end it with `hc kill {name}`.")
    lines = first_lines(name)
    if how == "exited":
        code = k.get("exit_code")
        raise Fail(f"{name} ({cli}) exited before its review began" + (f" (exit code {code})" if code not in (None, 0) else "")
                   + f". Its screen's first lines:\n{lines}\nStart the other CLI instead: {again}")
    if how in ("screen", "asks"):
        # Never answered here (no folder but the task's own worktree is ever trusted for it): ended,
        # so the other CLI can take its name.
        run(["hc", "kill", name])
        what = why or f"{cli} asks something before its review"
        raise Fail(f"{name} stopped on its start screen ({what}), which herdr-task never answers for it: ended it. "
                   f"Its screen's first lines:\n{lines}\nStart the other CLI instead: {again}")
    raise Fail(f"{name} ({cli}) hasn't begun its review after {WATCH_S} s and is still running. Its screen's first lines:\n"
               f"{lines}\nWait for it with `hc wait {name} --timeout 600`, or end it with `hc kill {name}` and start the other "
               f"CLI: {again}")
