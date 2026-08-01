import { useEffect } from "react";
import { CommandPalette } from "./features/shell/CommandPalette";
import { handleShortcut } from "./features/shell/commands";
import { TabBar } from "./features/shell/TabBar";
import { PdfViewer } from "./features/viewer/PdfViewer";
import { useTabsStore } from "./state/tabs-store";
import { useUiStore } from "./state/ui-store";
import "./App.css";

function App() {
  // Theme: data-theme on <html> drives the CSS variable blocks; "system"
  // tracks the OS live via the media query listener.
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved =
        theme === "system" ? (mq.matches ? "light" : "dark") : theme;
      document.documentElement.dataset.theme = resolved;
      useUiStore.setState({ resolvedTheme: resolved });
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // Launch behaviour: the dev convenience path replaces the stored session;
  // otherwise the previous session's tabs come back.
  useEffect(() => {
    const devPath = import.meta.env.VITE_OPEN_PDF as string | undefined;
    if (devPath) {
      useTabsStore.setState({ tabs: [], activeTabId: null, restored: true });
      void useTabsStore.getState().openTab(devPath);
    } else {
      void useTabsStore.getState().restoreSession();
    }
  }, []);

  // The one keyboard dispatcher, driven entirely by the command registry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => void handleShortcut(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Best-effort final write only — WebView2 skips beforeunload on kill,
  // crash, and updater paths. The durable save is the debounced view-state
  // subscription in tabs-store.
  useEffect(() => {
    const save = () => useTabsStore.getState().saveActiveView();
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <TabBar />
      <div style={{ flex: 1, minHeight: 0 }}>
        <PdfViewer />
      </div>
      <CommandPalette />
    </div>
  );
}

export default App;
