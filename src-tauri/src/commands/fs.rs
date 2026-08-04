use tauri::ipc::Response;

use crate::pdf::error::PdfError;

/// Reads a file's raw bytes (signature images and similar user-picked
/// assets). The path always comes from a native file dialog the user
/// drove — Ibris has no other source of arbitrary paths.
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Response, PdfError> {
    let bytes = std::fs::read(&path).map_err(|e| PdfError::Io {
        detail: format!("reading {path}: {e}"),
    })?;
    Ok(Response::new(bytes))
}
