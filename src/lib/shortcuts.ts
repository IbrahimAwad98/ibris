// Pure shortcut parsing/matching for the command registry. No React, no DOM.

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Lowercased KeyboardEvent.key value ("k", "=", "tab", "pagedown"). */
  key: string;
}

/** Parses "Ctrl+Shift+Tab" style strings. The last token is the key; a
 * trailing empty token means the key itself is "+". */
export function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+");
  const last = parts[parts.length - 1];
  const key = (last === "" ? "+" : last).toLowerCase();
  const mods = new Set(
    parts.slice(0, -1).filter(Boolean).map((m) => m.toLowerCase()),
  );
  return {
    ctrl: mods.has("ctrl"),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    key,
  };
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Exact-modifier match against a (Keyboard)event. */
export function eventMatches(parsed: ParsedShortcut, e: KeyLike): boolean {
  return (
    e.key.toLowerCase() === parsed.key &&
    e.ctrlKey === parsed.ctrl &&
    e.shiftKey === parsed.shift &&
    e.altKey === parsed.alt
  );
}
