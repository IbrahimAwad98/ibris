import { TabBar } from "./features/shell/TabBar";
import { PdfViewer } from "./features/viewer/PdfViewer";
import "./App.css";

function App() {
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
