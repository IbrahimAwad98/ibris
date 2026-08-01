// Crash-recovery sidecar IO and file fingerprints. Format lives in
// lib/sidecar.ts; these wrappers only move strings.
import { invoke } from "@tauri-apps/api/core";

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
}

/** null when the file does not exist (or cannot be statted). */
export async function fileFingerprint(
  path: string,
): Promise<FileFingerprint | null> {
  return invoke<FileFingerprint | null>("file_fingerprint", { path });
}

export async function sidecarRead(docPath: string): Promise<string | null> {
  return invoke<string | null>("sidecar_read", { docPath });
}

export async function sidecarWrite(
  docPath: string,
  contents: string,
): Promise<void> {
  await invoke("sidecar_write", { docPath, contents });
}

export async function sidecarDelete(docPath: string): Promise<void> {
  await invoke("sidecar_delete", { docPath });
}
