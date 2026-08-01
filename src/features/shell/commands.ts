// THE command registry. Every user-facing command, its label, and its
// shortcut live here and nowhere else: the palette renders this list and
// the global keydown handler dispatches from it, so the two can never
// disagree. Do not bind a shortcut anywhere else.
import { pickPdf, pickPdfs, pickSavePath } from "../../ipc/dialog";
import { closeDocument, mergeDocuments, openDocument } from "../../ipc/pdf";
import { siblingPartPath } from "../../lib/page-ops";
import { eventMatches, parseShortcut } from "../../lib/shortcuts";
import {
  saveDocument,
  saveSubset,
  saveToPath,
} from "../../state/annotation-io";
import {
  insertPages,
  insertRef,
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
      id: "insert-pages",
      label: "Insert pages from file…",
      enabled: docOpen,
      run: () => {
        void pickPdf().then(async (file) => {
          if (!file) return;
          // Metadata-only open: page count and sizes for the placeholders.
          const doc = await openDocument(file);
          void closeDocument(doc.docId).catch(() => undefined);
          const s = useDocumentStore.getState();
          const v = useViewerStore.getState();
          const before = s.pageOrder ?? v.pages.map((_, i) => i);
          const base = s.inserts.length;
          const pages = doc.pages.map((pt, i) => ({
            path: file,
            pageIndex: i,
            width: pt.width,
            height: pt.height,
          }));
          const refs = pages.map((_, i) => insertRef(base + i));
          const at = Math.min(v.currentPage + 1, before.length);
          const after = [...before.slice(0, at), ...refs, ...before.slice(at)];
          const name = file.split(/[\\/]/).pop() ?? file;
          s.execute(
            insertPages(
              before,
              after,
              base,
              pages,
              pages.length === 1
                ? `Insert page from ${name}`
                : `Insert ${pages.length} pages from ${name}`,
            ),
          );
        });
      },
    },
    {
      id: "extract-page",
      label: "Extract current page…",
      enabled: docOpen,
      run: () => {
        const path = activePath();
        if (!path) return;
        const v = useViewerStore.getState();
        const slot = v.currentPage;
        void pickSavePath(
          path.replace(/\.pdf$/i, "") + ` - page ${slot + 1}.pdf`,
        ).then(async (target) => {
          if (!target) return;
          await saveSubset(path, target, [slot]);
          void useTabsStore.getState().openTab(target);
        });
      },
    },
    {
      id: "split-doc",
      label: "Split at current page…",
      // Splitting before the first page would leave an empty first part.
      enabled: () => docOpen() && useViewerStore.getState().currentPage > 0,
      run: () => {
        const path = activePath();
        if (!path) return;
        const v = useViewerStore.getState();
        const slotCount =
          useDocumentStore.getState().pageOrder?.length ?? v.pages.length;
        const at = v.currentPage;
        void pickSavePath(
          path.replace(/\.pdf$/i, "") + " - part 1.pdf",
        ).then(async (first) => {
          if (!first) return;
          const second = siblingPartPath(first);
          const range = (from: number, to: number) =>
            Array.from({ length: to - from }, (_, i) => from + i);
          await saveSubset(path, first, range(0, at));
          await saveSubset(path, second, range(at, slotCount));
          void useTabsStore.getState().openTab(first);
          void useTabsStore.getState().openTab(second);
        });
      },
    },
    {
      id: "merge-pdfs",
      label: "Merge PDFs…",
      run: () => {
        void pickPdfs().then(async (paths) => {
          if (paths.length < 2) return;
          const target = await pickSavePath(
            paths[0].replace(/\.pdf$/i, "") + " - merged.pdf",
          );
          if (!target) return;
          await mergeDocuments(paths, target);
          void useTabsStore.getState().openTab(target);
        });
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
