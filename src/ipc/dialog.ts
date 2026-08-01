// Native dialogs; the plugin API is the sanctioned invoke path, kept in
// src/ipc/ like every other IPC surface.
import { open } from "@tauri-apps/plugin-dialog";

/** Native file picker filtered to PDFs; null when the user cancels. */
export async function pickPdf(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
  });
  return typeof picked === "string" ? picked : null;
}
