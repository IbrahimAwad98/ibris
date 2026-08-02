// Dev-only screenshot harness. Polls /shot.json (gitignored, written by
// tooling) and applies STORE state — never synthetic input — so app
// surfaces can be captured reproducibly. Stripped from production builds
// by the import.meta.env.DEV guard at the import site (main.tsx).
import { listTextObjects } from "../ipc/pdf";
import {
  addRedaction,
  editText,
  textEditKey,
  useDocumentStore,
} from "../state/document-store";
import { useTabsStore } from "../state/tabs-store";
import { useToolStore, type Tool } from "../state/tool-store";
import { useUiStore, type SidebarTab } from "../state/ui-store";
import { useViewerStore } from "../state/viewer-store";

type ShotAction =
  | { do: "open"; path: string }
  | { do: "closeAll" }
  | { do: "sidebar"; open: boolean; tab?: SidebarTab }
  | { do: "tool"; tool: Tool }
  | { do: "palette"; mode: "commands" | "goto" | null }
  | { do: "closePrompt" }
  | { do: "theme"; theme: "system" | "light" | "dark" }
  | { do: "demoRedaction" }
  | { do: "demoTextEdit" };

interface ShotFile {
  seq: number;
  actions: ShotAction[];
}

async function apply(action: ShotAction): Promise<void> {
  switch (action.do) {
    case "open":
      await useTabsStore.getState().openTab(action.path);
      return;
    case "closeAll": {
      useTabsStore.setState({ tabs: [], activeTabId: null });
      useViewerStore.setState({ docId: null });
      return;
    }
    case "sidebar":
      useUiStore.setState({ sidebarOpen: action.open });
      if (action.tab) useUiStore.getState().setSidebarTab(action.tab);
      return;
    case "tool":
      useToolStore.getState().setTool(action.tool);
      return;
    case "palette":
      if (action.mode === null) useUiStore.getState().closePalette();
      else useUiStore.getState().openPalette(action.mode);
      return;
    case "closePrompt": {
      const id = useTabsStore.getState().activeTabId;
      if (id !== null) useUiStore.getState().setClosePrompt(id);
      return;
    }
    case "theme":
      useUiStore.getState().setTheme(action.theme);
      return;
    case "demoRedaction": {
      const docId = useViewerStore.getState().docId;
      if (docId === null) return;
      const objects = await listTextObjects(docId, 0);
      const o = objects.find((t) => t.text.trim().length > 8) ?? objects[0];
      if (!o) return;
      useDocumentStore.getState().execute(
        addRedaction({
          id: "shot-demo-redaction",
          pageIndex: 0,
          rect: { x: o.x - 2, y: o.y - 2, width: o.width + 4, height: o.height + 4 },
        }),
      );
      return;
    }
    case "demoTextEdit": {
      const docId = useViewerStore.getState().docId;
      if (docId === null) return;
      const objects = await listTextObjects(docId, 0);
      const o = objects.find((t) => t.text.trim().length > 8) ?? objects[0];
      if (!o) return;
      useDocumentStore.getState().execute(
        editText(textEditKey(0, o.objectIndex), null, {
          pageIndex: 0,
          objectIndex: o.objectIndex,
          original: o.text,
          text: o.text.replace(/\w+/, "Edited"),
          rect: { x: o.x, y: o.y, width: o.width, height: o.height },
        }),
      );
      return;
    }
  }
}

export function startShotHarness(): void {
  let lastSeq = -1;
  let running = false;
  setInterval(() => {
    if (running) return;
    void (async () => {
      running = true;
      try {
        const res = await fetch(`/shot.json?t=${Date.now()}`);
        if (!res.ok) return;
        const file = (await res.json()) as ShotFile;
        if (typeof file.seq !== "number" || file.seq === lastSeq) return;
        lastSeq = file.seq;
        for (const action of file.actions) await apply(action);
        document.title = `ibris-shot-${file.seq}`;
      } catch {
        // No shot file or malformed: harness stays idle.
      } finally {
        running = false;
      }
    })();
  }, 400);
}
