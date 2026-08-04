import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Screenshot tooling, dev builds only (store-driven, no synthetic input).
if (import.meta.env.DEV) {
  void import("./dev/shot-harness").then((m) => m.startShotHarness());
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
