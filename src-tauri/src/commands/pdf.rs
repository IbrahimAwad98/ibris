use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

use crate::pdf::engine::{DocumentInfo, TileRect};
use crate::pdf::error::PdfError;
use crate::pdf::service::PdfService;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub doc_id: u64,
    #[serde(flatten)]
    pub info: DocumentInfo,
}

#[tauri::command]
pub async fn open_document(
    state: State<'_, PdfService>,
    path: String,
) -> Result<OpenedDocument, PdfError> {
    let (doc_id, info) = state.open(PathBuf::from(path)).await?;
    Ok(OpenedDocument { doc_id, info })
}

/// Returns raw bytes: u32 LE width, u32 LE height, then tightly packed RGBA8.
#[tauri::command]
pub async fn render_page(
    state: State<'_, PdfService>,
    doc_id: u64,
    page_index: u16,
    scale: f32,
    request_id: u64,
) -> Result<Response, PdfError> {
    let page = state.render(doc_id, page_index, scale, request_id).await?;
    let mut bytes = Vec::with_capacity(8 + page.rgba.len());
    bytes.extend_from_slice(&page.width.to_le_bytes());
    bytes.extend_from_slice(&page.height.to_le_bytes());
    bytes.extend_from_slice(&page.rgba);
    Ok(Response::new(bytes))
}

/// Returns raw bytes with the same layout as `render_page`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // flat args mirror the wire format; a struct here only moves the noise
pub async fn render_tile(
    state: State<'_, PdfService>,
    doc_id: u64,
    page_index: u16,
    scale: f32,
    tile_x: i32,
    tile_y: i32,
    tile_width: i32,
    tile_height: i32,
    request_id: u64,
) -> Result<Response, PdfError> {
    let rect = TileRect {
        x: tile_x,
        y: tile_y,
        width: tile_width,
        height: tile_height,
    };
    let page = state
        .render_tile(doc_id, page_index, scale, rect, request_id)
        .await?;
    let mut bytes = Vec::with_capacity(8 + page.rgba.len());
    bytes.extend_from_slice(&page.width.to_le_bytes());
    bytes.extend_from_slice(&page.height.to_le_bytes());
    bytes.extend_from_slice(&page.rgba);
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn cancel_render(state: State<'_, PdfService>, request_id: u64) -> Result<(), PdfError> {
    state.cancel(request_id)
}

#[tauri::command]
pub async fn cancel_renders(
    state: State<'_, PdfService>,
    request_ids: Vec<u64>,
) -> Result<(), PdfError> {
    state.cancel_many(&request_ids)
}

#[tauri::command]
pub async fn close_document(state: State<'_, PdfService>, doc_id: u64) -> Result<(), PdfError> {
    state.close(doc_id)
}
