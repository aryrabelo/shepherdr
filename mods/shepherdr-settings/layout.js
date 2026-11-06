// The Window section (was Layout): on/off switches for how the window looks and what a new space
// opens with (DECISIONS.md, "Shepherdr settings: layout switches"). The same everywhere, no scope. Each
// default is today's choice, so nothing changes until one is flipped; each takes effect at once:
// - Tabs: shared "tabbar.tabs" (mods/tabs-tasks). Only the tabs go: the bar also holds +, the
//   side panels' buttons, and work for the rest of the app (new spaces, tasks' watcher).
// - Worktrees: shared "sidebar.worktrees" (mods/spaces-chat).
// - Red counts / Green counts: shared "counts.red" / "counts.green" (mods/spaces-chat, mods/tabs-tasks).
// - Bold unread spaces: shared "sidebar.unread" (mods/spaces-chat).
// - Status filters, Show space on task rows: shared "tasks.filters", "tasks.place" (mods/tasks).
// - Show subagents above the chat box: shared "chat.helpers" (mods/chat).
// - Assistant: shared "coordinator.auto" (coordinator.js watchNewSpaces, mods/newspace).
// Under them, Add-ons: a switch for each add-on lib/addons.json gives one (lib/addons.js). Off is
// shared "addons.off" (the mods follow at once) and Everywhere's "off" in ~/.herdr/shepherdr.json
// (herdr-task, here and on other machines). One that others need, or that needs one that's off,
// can't flip until they do: its line says which. Under Voice and dictation (on): Voice from, whose voice calls and
// dictation use (Everywhere's voice.provider; core/voice-openai.js pickVoice).

import { v_flex } from "gpui-base";
import { shared, setShared } from "herdr";
import { toggleSwitch, segmented } from "./ui.js";
import { on, blockers, flip } from "./addons.js";
// The switches, their words and an add-on's line: core/settings.js, shared with the web app.
import { SWITCHES, ADDONS, SECTIONS, addonAbout, VOICE_FROM } from "./core/settings.js";
export { SWITCHES };

// A switch kept in shared state: on unless set to false.
const flag = (key) => ({ on: shared(key) !== false, flip: (on) => setShared(key, !on) });

// `view`: the settings window, for its title, heading, row and change; view.addons: lib/addons.json
// once read (null until then).
export function layoutSection(view, t) {
  const m = view.addons, title = (id) => m.addons.find((a) => a.id === id)?.title ?? id;
  return v_flex()
    .child(view.title(t, SECTIONS.find((s) => s.id === "window").title))
    .children(SWITCHES.map((s) => {
      const st = flag(s.key);
      return view.row(t, s.title, s.about, toggleSwitch(`layout-${s.id}`, st.on, () => st.flip(st.on)));
    }))
    .when(Boolean(m?.addons?.some((a) => a.switch)), (el) => el
      .child(view.heading(t, ADDONS))
      .children(m.addons.filter((a) => a.switch).flatMap((a) => {
        const now = on(a.id), stop = blockers(m, a.id, !now);
        const about = addonAbout(a.about, now, stop.map(title));
        const row = view.row(t, a.title, about, toggleSwitch(`addon-${a.id}`, now, (next, _e, cx) => {
          const list = flip(a.id, next);
          view.change((cfg) => { const e = (cfg.everywhere ??= {}); if (list.length) e.off = list; else delete e.off; }, cx);
        }, { disabled: stop.length > 0 }));
        return a.id === "voice" && now ? [row, voiceFrom(view, t)] : [row];
      })));
}

// Voice from: Automatic (no voice.provider), OpenAI or ElevenLabs.
function voiceFrom(view, t) {
  const v = view.cfg?.everywhere?.voice?.provider;
  const now = v === "openai" || v === "elevenlabs" ? v : "auto";
  return view.row(t, VOICE_FROM.title, VOICE_FROM.about, segmented("voice-from", VOICE_FROM.choices, now, (pick, _e, cx) => {
    view.change((cfg) => {
      const e = (cfg.everywhere ??= {});
      if (pick === "auto") { if (e.voice) { delete e.voice.provider; if (!Object.keys(e.voice).length) delete e.voice; } }
      else e.voice = { ...(e.voice ?? {}), provider: pick };
    }, cx);
  }));
}
