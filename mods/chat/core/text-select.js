// Copying text selected in the window's chat (mods/chat, ASH-10).
//
// A message's text is a selectable TextView, and Herdr's mod root (gpui-kit's ShellRoot) binds Cmd+C to copying
// the window's text selection. The composer, where the chat keeps the keyboard, binds the same chord to copying
// its own selection, and being deeper in the focus path it wins: with nothing selected in the box, nothing is
// copied. So once a press selects text in the messages (a drag, or a double or triple click), the chat moves the
// keyboard off the composer onto an element of its own: Cmd+C then reaches the root's copy, and nothing in a
// terminal or the box takes the chord. Typing, Escape or Cmd+V there go back to the composer.

/** How far (px) the pointer moves between press and release to be a drag that selects. */
export const DRAG = 4;
/** The messages area and the chat's root each note a press; this close (ms) they are the same one. */
export const SAME_PRESS = 250;

/**
 * Did this press and release select text in the messages?
 * down: { x, y, count, at }, the press as the messages area saw it (window position, click count, Date.now());
 * up: { x, y }, where the button came up; pressAt: when the chat's root saw its latest press (a press outside the
 * messages leaves `down` behind, older than that).
 */
export function selects(down, up, pressAt = null) {
  if (!down || !up || !Number.isFinite(down.x) || !Number.isFinite(up.x)) return false;
  if (pressAt != null && Math.abs(pressAt - (down.at ?? 0)) > SAME_PRESS) return false;
  if ((down.count ?? 1) >= 2) return true;
  return Math.hypot(up.x - down.x, (up.y ?? 0) - (down.y ?? 0)) >= DRAG;
}

const BACK = new Set(["escape", "enter", "tab", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);

/**
 * What a key does while the messages hold the keyboard (a KeyEvent: key, key_char, modifiers):
 * { act: "type", text } types it in the composer; { act: "paste" } pastes the clipboard's text there;
 * { act: "back" } just gives the composer the keyboard; null leaves the key alone (Cmd+C copies through the root).
 */
export function readingKey(e) {
  const m = e?.modifiers ?? {};
  const key = String(e?.key ?? "").toLowerCase();
  if (m.platform || m.control) return key === "v" ? { act: "paste" } : null;
  if (BACK.has(key)) return { act: "back" };
  const text = e?.key_char;
  return typeof text === "string" && text.length ? { act: "type", text } : null;
}
