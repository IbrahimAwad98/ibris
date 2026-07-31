import { useEffect, useMemo, useRef, useState } from "react";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";
import { appCommands, filterCommands, type AppCommand } from "./commands";

/** Ctrl+K overlay; also hosts the Ctrl+G "go to page" input mode. */
export function CommandPalette() {
  const mode = useUiStore((s) => s.paletteMode);
  if (mode === null) return null;
  // Keyed so switching modes resets query and selection.
  return <PaletteOverlay key={mode} mode={mode} />;
}

function PaletteOverlay({ mode }: { mode: "commands" | "goto" }) {
  const closePalette = useUiStore((s) => s.closePalette);
  const pageCount = useViewerStore((s) => s.pages.length);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const commands = useMemo(
    () => (mode === "commands" ? filterCommands(appCommands(), query) : []),
    [mode, query],
  );
  const sel = Math.min(selected, Math.max(0, commands.length - 1));

  const execute = (cmd: AppCommand) => {
    if (cmd.enabled && !cmd.enabled()) return;
    closePalette();
    cmd.run();
  };

  const gotoPage = () => {
    const n = Number.parseInt(query, 10);
    if (Number.isNaN(n) || n < 1 || n > pageCount) return;
    closePalette();
    useViewerStore.getState().scrollToPage(n - 1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    } else if (mode === "goto" && e.key === "Enter") {
      e.preventDefault();
      gotoPage();
    } else if (mode === "commands" && e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(sel + 1, commands.length - 1));
    } else if (mode === "commands" && e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(sel - 1, 0));
    } else if (mode === "commands" && e.key === "Enter") {
      e.preventDefault();
      if (commands[sel]) execute(commands[sel]);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={closePalette}>
      <div
        className="palette"
        role="dialog"
        aria-label={mode === "goto" ? "Go to page" : "Command palette"}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={
            mode === "goto"
              ? `Go to page (1–${pageCount})`
              : "Type a command…"
          }
          inputMode={mode === "goto" ? "numeric" : undefined}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setSelected(0);
          }}
        />
        {mode === "commands" && (
          <div className="palette-list" role="listbox">
            {commands.length === 0 && (
              <div className="palette-empty">No matching command</div>
            )}
            {commands.map((cmd, i) => {
              const disabled = cmd.enabled ? !cmd.enabled() : false;
              return (
                <div
                  key={cmd.id}
                  ref={i === sel ? selectedRef : undefined}
                  role="option"
                  aria-selected={i === sel}
                  className={
                    "palette-row" +
                    (i === sel ? " selected" : "") +
                    (disabled ? " disabled" : "")
                  }
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => execute(cmd)}
                >
                  <span>{cmd.label}</span>
                  {cmd.shortcut && (
                    <kbd className="palette-chip">{cmd.shortcut}</kbd>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
