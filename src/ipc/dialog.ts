// Native dialogs; the plugin API is the sanctioned invoke path, kept in
// src/ipc/ like every other IPC surface.
import { ask, open, save } from "@tauri-apps/plugin-dialog";

/** Native file picker filtered to PDFs; null when the user cancels. */
export async function pickPdf(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Native multi-file picker filtered to PDFs; empty when cancelled. */
export async function pickPdfs(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
  });
  if (Array.isArray(picked)) return picked;
  return typeof picked === "string" ? [picked] : [];
}

/** Native picker for a signature image. PNG only — that is what the
 * engine embeds (image crate built with the png feature alone). */
export async function pickPngImage(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    filters: [{ name: "PNG images", extensions: ["png"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Native save-as picker; null when the user cancels. */
export async function pickSavePath(
  defaultPath?: string,
): Promise<string | null> {
  return save({
    defaultPath,
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
  });
}

/** Native yes/no question; `okLabel` names the destructive choice. */
export async function askUser(
  message: string,
  title: string,
  okLabel: string,
): Promise<boolean> {
  return ask(message, { title, okLabel, kind: "warning" });
}
