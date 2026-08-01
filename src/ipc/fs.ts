// File reads for user-picked assets (signature images). The only
// consumer of paths is the native file dialog, driven by the user.
import { invoke } from "@tauri-apps/api/core";

/** Reads a file the user picked and returns it as a data URL. */
export async function readFileAsDataUrl(
  path: string,
  mime: string,
): Promise<string> {
  const buf = await invoke<ArrayBuffer>("read_file_bytes", { path });
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000; // btoa argument limits on big inputs
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
