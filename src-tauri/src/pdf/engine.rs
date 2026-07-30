//! The single PDFium engine thread.
//!
//! PDFium is not thread-safe. Empirically, even one binding with serialised
//! FFI calls (pdfium-render's `thread_safe` feature) crashes under
//! concurrent multi-document use — see the M1a notes in docs/DECISIONS.md.
//! The invariant is therefore structural: every PDFium call in the process
//! happens on this one thread, which owns every open `PdfDocument`. The rest
//! of the app talks to it exclusively through [`EngineHandle`]'s channel.
// ponytail: one engine thread serialises all rendering, including across
// documents. If multi-document parallelism ever matters, it needs one
// process per document — PDFium offers nothing weaker.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, OnceLock};
use std::thread;

use pdfium_render::prelude::*;
use serde::Serialize;
use tokio::sync::oneshot;

use super::error::PdfError;

/// Width/height of a page in PDF points (1/72 inch), bottom-left origin.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PageSizePt {
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub page_count: u16,
    pub pages: Vec<PageSizePt>,
}

/// One rendered page: tightly packed RGBA8 pixels.
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// A render job. The engine checks `cancel` when it dequeues the job and
/// skips the render entirely if it is set — this is what keeps fast
/// scrolling from backing up the queue.
// ponytail: cancellation is checked at dequeue, not mid-render; max wasted
// work is one in-flight page. Upgrade path is PDFium's progressive-render
// API if pdfium-render ever exposes it.
pub struct RenderRequest {
    pub doc_id: u64,
    pub page_index: u16,
    pub scale: f32,
    pub cancel: Arc<AtomicBool>,
    pub reply: oneshot::Sender<Result<RenderedPage, PdfError>>,
}

pub enum EngineMsg {
    Open {
        path: PathBuf,
        reply: oneshot::Sender<Result<(u64, DocumentInfo), PdfError>>,
    },
    Render(RenderRequest),
    Close {
        doc_id: u64,
    },
}

/// Cloneable sender into the engine thread.
#[derive(Clone)]
pub struct EngineHandle {
    tx: mpsc::Sender<EngineMsg>,
}

impl EngineHandle {
    /// The process-wide engine, spawned on first use.
    pub fn global() -> &'static EngineHandle {
        static ENGINE: OnceLock<EngineHandle> = OnceLock::new();
        ENGINE.get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            thread::spawn(move || engine_main(rx));
            EngineHandle { tx }
        })
    }

    /// Queues a message; fails only if the engine thread has died.
    pub fn send(&self, msg: EngineMsg) -> Result<(), PdfError> {
        self.tx.send(msg).map_err(|_| PdfError::Internal {
            detail: "pdf engine thread is gone".into(),
        })
    }
}

/// Locates pdfium.dll: next to the executable in installed builds, falling
/// back to `src-tauri/pdfium/` in dev (populated by scripts/get-pdfium.ps1).
fn pdfium_library_path() -> Result<PathBuf, PdfError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        candidates.push(dir);
    }
    candidates.push(PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/pdfium"
    )));

    for dir in &candidates {
        let lib = Pdfium::pdfium_platform_library_name_at_path(dir);
        if lib.is_file() {
            return Ok(lib);
        }
    }
    Err(PdfError::Internal {
        detail: "pdfium library not found — run scripts/get-pdfium.ps1".into(),
    })
}

fn pdfium() -> Result<&'static Pdfium, PdfError> {
    static PDFIUM: OnceLock<Result<Pdfium, PdfError>> = OnceLock::new();
    PDFIUM
        .get_or_init(|| {
            pdfium_library_path().and_then(|lib| {
                Pdfium::bind_to_library(&lib)
                    .map(Pdfium::new)
                    .map_err(PdfError::from)
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn engine_main(rx: mpsc::Receiver<EngineMsg>) {
    let mut docs: HashMap<u64, PdfDocument<'static>> = HashMap::new();
    let mut next_id: u64 = 0;

    while let Ok(msg) = rx.recv() {
        match msg {
            EngineMsg::Open { path, reply } => {
                let _ = reply.send(open_one(&mut docs, &mut next_id, &path));
            }
            EngineMsg::Render(req) => {
                if req.cancel.load(Ordering::Relaxed) {
                    let _ = req.reply.send(Err(PdfError::Cancelled));
                    continue;
                }
                let result = docs
                    .get(&req.doc_id)
                    .ok_or_else(|| PdfError::Internal {
                        detail: format!("unknown document id {}", req.doc_id),
                    })
                    .and_then(|doc| render_one(doc, req.page_index, req.scale));
                let _ = req.reply.send(result);
            }
            EngineMsg::Close { doc_id } => {
                docs.remove(&doc_id);
            }
        }
    }
}

fn open_one(
    docs: &mut HashMap<u64, PdfDocument<'static>>,
    next_id: &mut u64,
    path: &Path,
) -> Result<(u64, DocumentInfo), PdfError> {
    if !path.is_file() {
        return Err(PdfError::FileNotFound {
            path: path.display().to_string(),
        });
    }
    let document = pdfium()?.load_pdf_from_file(path, None)?;

    let pages: Vec<PageSizePt> = document
        .pages()
        .iter()
        .map(|page| PageSizePt {
            width: page.width().value,
            height: page.height().value,
        })
        .collect();
    let info = DocumentInfo {
        page_count: pages.len() as u16,
        pages,
    };

    let id = *next_id;
    *next_id += 1;
    docs.insert(id, document);
    Ok((id, info))
}

fn render_one(
    document: &PdfDocument<'_>,
    page_index: u16,
    scale: f32,
) -> Result<RenderedPage, PdfError> {
    let page = document.pages().get(page_index.into())?;
    let bitmap = page.render_with_config(&PdfRenderConfig::new().scale_page_by_factor(scale))?;
    let width = bitmap.width() as u32;
    let height = bitmap.height() as u32;
    let rgba = bitmap.as_rgba_bytes();
    Ok(RenderedPage {
        width,
        height,
        rgba,
    })
}
