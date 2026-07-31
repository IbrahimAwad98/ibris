import { useEffect } from "react";
import { TabBar } from "./features/shell/TabBar";
import { PdfViewer } from "./features/viewer/PdfViewer";
import { useTabsStore } from "./state/tabs-store";
import "./App.css";

function App() {
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

  // The active tab's final scroll position would otherwise die with the
  // window; everything else is saved on every tab switch.
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
    </div>
  );
}

export default App;
