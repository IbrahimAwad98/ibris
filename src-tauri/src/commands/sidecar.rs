//! Crash-recovery sidecar storage and file fingerprints (M2-PLAN §2).
//!
//! The frontend owns the sidecar *format*; these commands only move bytes
//! to and from `<appDataDir>/sidecars/`. Sidecars deliberately do not live
//! next to the PDF — users open files from read-only media and synced
//! folders.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager;

use crate::pdf::error::PdfError;

/// Size + mtime identity of a file, for cheap change detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub size: u64,
    pub mtime_ms: i64,
}

#[tauri::command]
pub fn file_fingerprint(path: String) -> Option<FileFingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(FileFingerprint {
        size: meta.len(),
        mtime_ms,
    })
}

// ponytail: DefaultHasher is only stable within one compiler version; a
// toolchain upgrade orphans old sidecars (they are ignored and eventually
// deleted). Crash recovery is best-effort — acceptable. Swap in a fixed
// hash (e.g. fnv) if that ever bites.
fn sidecar_path(app: &tauri::AppHandle, doc_path: &str) -> Result<PathBuf, PdfError> {
    let mut hasher = DefaultHasher::new();
    doc_path.hash(&mut hasher);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| PdfError::Io {
            detail: format!("no app data dir: {e}"),
        })?
        .join("sidecars");
    std::fs::create_dir_all(&dir).map_err(|e| PdfError::Io {
        detail: format!("creating {}: {e}", dir.display()),
    })?;
    Ok(dir.join(format!("{:016x}.json", hasher.finish())))
}

#[tauri::command]
pub fn sidecar_read(app: tauri::AppHandle, doc_path: String) -> Result<Option<String>, PdfError> {
    let path = sidecar_path(&app, &doc_path)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(PdfError::Io {
            detail: format!("reading {}: {e}", path.display()),
        }),
    }
}

#[tauri::command]
pub fn sidecar_write(
    app: tauri::AppHandle,
    doc_path: String,
    contents: String,
) -> Result<(), PdfError> {
    let path = sidecar_path(&app, &doc_path)?;
    std::fs::write(&path, contents).map_err(|e| PdfError::Io {
        detail: format!("writing {}: {e}", path.display()),
    })
}

#[tauri::command]
pub fn sidecar_delete(app: tauri::AppHandle, doc_path: String) -> Result<(), PdfError> {
    let path = sidecar_path(&app, &doc_path)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(PdfError::Io {
            detail: format!("deleting {}: {e}", path.display()),
        }),
    }
}
