// THE command registry. Every user-facing command, its label, and its
// shortcut live here and nowhere else: the palette renders this list and
// the global keydown handler dispatches from it, so the two can never
// disagree. Do not bind a shortcut anywhere else.
import { pickPdf, pickSavePath } from "../../ipc/dialog";
import { eventMatches, parseShortcut } from "../../lib/shortcuts";
import { saveDocument, saveToPath } from "../../state/annotation-io";
import {
  removeAnnotation,
  useDocumentStore,
} from "../../state/document-store";
import { useTabsStore } from "../../state/tabs-store";
import { useToolStore } from "../../state/tool-store";
import { useUiStore } from "../../state/ui-store";
import { useViewerStore } from "../../state/viewer-store";
import {
  fitTo,
  resetZoom,
  rotateCurrentPage,
  rotateDocument,
  zoomInCentred,
  zoomOutCentred,
} from "../viewer/view-actions";

export interface AppCommand {
  id: string;
  label: string;
  /** Primary shortcut, shown in the palette. */
  shortcut?: string;
  /** Extra bindings (e.g. fallbacks where WebView2 reserves the primary). */
  extraShortcuts?: string[];
  enabled?: () => boolean;
  run: () => void;
}

const docOpen = () => useViewerStore.getState().docId !== null;
const hasTabs = () => useTabsStore.getState().tabs.length > 0;

function activePath(): string | null {
  const { tabs, activeTabId } = useTabsStore.getState();
  return tabs.find((t) => t.id === activeTabId)?.path ?? null;
}

/** The full registry, reading store state lazily at call time. */
export function appCommands(): AppCommand[] {
  return [
    {
      id: "open",
      label: "Open PDF…",
      shortcut: "Ctrl+O",
      run: () =>
        void pickPdf().then((path) => {
          if (path) void useTabsStore.getState().openTab(path);
        }),
    },
    {
      id: "close-tab",
      label: "Close tab",
      shortcut: "Ctrl+W",
      enabled: hasTabs,
      run: () => {
        const s = useTabsStore.getState();
        if (s.activeTabId !== null) s.requestCloseTab(s.activeTabId);
      },
    },
    {
      id: "save",
      label: "Save",
      shortcut: "Ctrl+S",
      enabled: docOpen,
      run: () => {
        const path = activePath();
        if (path) void saveDocument(path);
      },
    },
    {
      id: "save-as",
      label: "Save as…",
      shortcut: "Ctrl+Shift+S",
      enabled: docOpen,
      run: () => {
        const path = activePath();
        if (!path) return;
        void pickSavePath(path).then((target) => {
          if (target) void saveToPath(path, target);
        });
      },
    },
    {
      id: "undo",
      label: "Undo",
      shortcut: "Ctrl+Z",
      enabled: () => useDocumentStore.getState().canUndo(),
      run: () => useDocumentStore.getState().undo(),
    },
    {
      id: "redo",
      label: "Redo",
      shortcut: "Ctrl+Y",
      extraShortcuts: ["Ctrl+Shift+Z"],
      enabled: () => useDocumentStore.getState().canRedo(),
      run: () => useDocumentStore.getState().redo(),
    },
    {
      id: "delete-annotation",
      label: "Delete selected annotation",
      shortcut: "Delete",
      enabled: () => useToolStore.getState().selectedId !== null,
      run: () => {
        const { selectedId, setSelectedId } = useToolStore.getState();
        if (selectedId === null) return;
        const a = useDocumentStore.getState().annotations[selectedId];
        if (a) useDocumentStore.getState().execute(removeAnnotation(a));
        setSelectedId(null);
      },
    },
    {
      id: "next-tab",
      label: "Next tab",
      shortcut: "Ctrl+Tab",
      extraShortcuts: ["Ctrl+PageDown"],
      enabled: hasTabs,
      run: () => useTabsStore.getState().nextTab(),
    },
    {
      id: "prev-tab",
      label: "Previous tab",
      shortcut: "Ctrl+Shift+Tab",
      extraShortcuts: ["Ctrl+PageUp"],
      enabled: hasTabs,
      run: () => useTabsStore.getState().prevTab(),
    },
    {
      id: "find",
      label: "Find in document",
      shortcut: "Ctrl+F",
      enabled: docOpen,
      run: () => useUiStore.getState().focusSearch(),
    },
    {
      id: "goto-page",
      label: "Go to page…",
      shortcut: "Ctrl+G",
      enabled: docOpen,
      run: () => useUiStore.getState().openPalette("goto"),
    },
    {
      id: "zoom-in",
      label: "Zoom in",
      shortcut: "Ctrl+=",
      extraShortcuts: ["Ctrl++"],
      enabled: docOpen,
      run: zoomInCentred,
    },
    {
      id: "zoom-out",
      label: "Zoom out",
      shortcut: "Ctrl+-",
      enabled: docOpen,
      run: zoomOutCentred,
    },
    {
      id: "zoom-reset",
      label: "Zoom to 100%",
      shortcut: "Ctrl+0",
      enabled: docOpen,
      run: resetZoom,
    },
    {
      id: "fit-width",
      label: "Fit width",
      shortcut: "Ctrl+1",
      enabled: docOpen,
      run: () => fitTo("width"),
    },
    {
      id: "fit-page",
      label: "Fit page",
      shortcut: "Ctrl+2",
      enabled: docOpen,
      run: () => fitTo("page"),
    },
    {
      id: "rotate-page",
      label: "Rotate page",
      shortcut: "Ctrl+R",
      enabled: docOpen,
      run: rotateCurrentPage,
    },
    {
      id: "rotate-doc",
      label: "Rotate document",
      shortcut: "Ctrl+Shift+R",
      enabled: docOpen,
      run: rotateDocument,
    },
    {
      id: "toggle-sidebar",
      label: "Toggle sidebar",
      shortcut: "Ctrl+B",
      enabled: docOpen,
      run: () => useUiStore.getState().toggleSidebar(),
    },
    {
      id: "toggle-theme",
      label: "Toggle light/dark theme",
      shortcut: "Ctrl+Shift+L",
      run: () => useUiStore.getState().toggleTheme(),
    },
    {
      id: "palette",
      label: "Command palette",
      shortcut: "Ctrl+K",
      run: () => {
        const u = useUiStore.getState();
        if (u.paletteMode === "commands") u.closePalette();
        else u.openPalette("commands");
      },
    },
  ];
}

/** Every binding of a command, primary first. */
export function commandBindings(cmd: AppCommand): string[] {
  return [
    ...(cmd.shortcut ? [cmd.shortcut] : []),
    ...(cmd.extraShortcuts ?? []),
  ];
}

/** The palette's filter: empty query lists everything. */
export function filterCommands(
  commands: AppCommand[],
  query: string,
): AppCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => c.label.toLowerCase().includes(q));
}

interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

/** The one keydown dispatcher; returns whether a command consumed the key. */
export function handleShortcut(e: KeyEventLike): boolean {
  for (const cmd of appCommands()) {
    for (const binding of commandBindings(cmd)) {
      if (eventMatches(parseShortcut(binding), e)) {
        if (cmd.enabled && !cmd.enabled()) return false;
        e.preventDefault();
        cmd.run();
        return true;
      }
    }
  }
  return false;
}
