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
use super::text::{extract_runs, search_page, PageText, SearchMatch};

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

/// A tile of a page in device pixels at a given scale. `x`/`y` are the
/// tile's top-left corner in the scaled page's coordinate space.
#[derive(Debug, Clone, Copy)]
pub struct TileRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Like [`RenderRequest`], but for one tile of a page instead of the whole
/// page. Rotation is deliberately absent: the frontend renders rotation as a
/// CSS transform, so the engine only ever rasterises unrotated pages.
pub struct TileRequest {
    pub doc_id: u64,
    pub page_index: u16,
    pub scale: f32,
    pub rect: TileRect,
    pub cancel: Arc<AtomicBool>,
    pub reply: oneshot::Sender<Result<RenderedPage, PdfError>>,
}

/// A bookmark tree node. `page_index` is `None` for bookmarks without a
/// resolvable destination.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub title: String,
    pub page_index: Option<u16>,
    pub children: Vec<OutlineNode>,
}

pub enum EngineMsg {
    Open {
        path: PathBuf,
        reply: oneshot::Sender<Result<(u64, DocumentInfo), PdfError>>,
    },
    Render(RenderRequest),
    RenderTile(TileRequest),
    ExtractText {
        doc_id: u64,
        page_index: u16,
        reply: oneshot::Sender<Result<PageText, PdfError>>,
    },
    /// Searches one bounded page range; the caller streams the whole
    /// document by sending successive ranges, so long documents never
    /// monopolise the engine queue.
    Search {
        doc_id: u64,
        query: String,
        case_sensitive: bool,
        whole_word: bool,
        from_page: u16,
        to_page: u16,
        cancel: Arc<AtomicBool>,
        reply: oneshot::Sender<Result<Vec<SearchMatch>, PdfError>>,
    },
    Outline {
        doc_id: u64,
        reply: oneshot::Sender<Result<Vec<OutlineNode>, PdfError>>,
    },
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
            EngineMsg::RenderTile(req) => {
                if req.cancel.load(Ordering::Relaxed) {
                    let _ = req.reply.send(Err(PdfError::Cancelled));
                    continue;
                }
                let result = docs
                    .get(&req.doc_id)
                    .ok_or_else(|| PdfError::Internal {
                        detail: format!("unknown document id {}", req.doc_id),
                    })
                    .and_then(|doc| render_tile(doc, req.page_index, req.scale, req.rect));
                let _ = req.reply.send(result);
            }
            EngineMsg::ExtractText {
                doc_id,
                page_index,
                reply,
            } => {
                let result = with_page(&docs, doc_id, page_index, extract_runs);
                let _ = reply.send(result);
            }
            EngineMsg::Search {
                doc_id,
                query,
                case_sensitive,
                whole_word,
                from_page,
                to_page,
                cancel,
                reply,
            } => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = reply.send(Err(PdfError::Cancelled));
                    continue;
                }
                let result = docs
                    .get(&doc_id)
                    .ok_or_else(|| PdfError::Internal {
                        detail: format!("unknown document id {doc_id}"),
                    })
                    .map(|doc| {
                        let mut matches = Vec::new();
                        for page_index in from_page..=to_page {
                            if cancel.load(Ordering::Relaxed) {
                                break; // return what we have; caller re-queries
                            }
                            if let Ok(page) = doc.pages().get(page_index.into()) {
                                matches.extend(search_page(
                                    &page,
                                    page_index,
                                    &query,
                                    case_sensitive,
                                    whole_word,
                                ));
                            }
                        }
                        matches
                    });
                let _ = reply.send(result);
            }
            EngineMsg::Outline { doc_id, reply } => {
                let result = docs
                    .get(&doc_id)
                    .ok_or_else(|| PdfError::Internal {
                        detail: format!("unknown document id {doc_id}"),
                    })
                    .map(outline_of);
                let _ = reply.send(result);
            }
            EngineMsg::Close { doc_id } => {
                docs.remove(&doc_id);
            }
        }
    }
}

fn with_page<T>(
    docs: &HashMap<u64, PdfDocument<'static>>,
    doc_id: u64,
    page_index: u16,
    f: impl FnOnce(&PdfPage<'_>) -> Result<T, PdfError>,
) -> Result<T, PdfError> {
    let doc = docs.get(&doc_id).ok_or_else(|| PdfError::Internal {
        detail: format!("unknown document id {doc_id}"),
    })?;
    let page = doc.pages().get(page_index.into())?;
    f(&page)
}

fn outline_of(document: &PdfDocument<'static>) -> Vec<OutlineNode> {
    let Some(root) = document.bookmarks().root() else {
        return Vec::new();
    };
    // root() is the first top-level bookmark; its siblings are the rest.
    std::iter::once(root.clone())
        .chain(root.iter_siblings())
        .map(|b| outline_node(&b))
        .collect()
}

fn outline_node(bookmark: &PdfBookmark<'_>) -> OutlineNode {
    OutlineNode {
        title: bookmark.title().unwrap_or_default(),
        page_index: bookmark
            .destination()
            .and_then(|d| d.page_index().ok())
            .map(|i| i as u16),
        children: bookmark
            .iter_direct_children()
            .map(|c| outline_node(&c))
            .collect(),
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

/// Renders one tile of a page: the region `rect` of the page as it would
/// appear scaled by `scale`, into a tile-sized bitmap. Regions past the page
/// edge come back as the white clear colour, so callers may request the full
/// tile grid without edge-clamping.
fn render_tile(
    document: &PdfDocument<'_>,
    page_index: u16,
    scale: f32,
    rect: TileRect,
) -> Result<RenderedPage, PdfError> {
    if rect.width <= 0 || rect.height <= 0 {
        return Err(PdfError::Internal {
            detail: format!("degenerate tile rect {rect:?}"),
        });
    }
    let page = document.pages().get(page_index.into())?;
    let mut bitmap = PdfBitmap::empty(rect.width, rect.height, PdfBitmapFormat::BGRA)?;
    let config = PdfRenderConfig::new()
        .scale_page_by_factor(scale)
        .set_origin(-rect.x, -rect.y);
    page.render_into_bitmap_with_config(&mut bitmap, &config)?;
    Ok(RenderedPage {
        width: rect.width as u32,
        height: rect.height as u32,
        rgba: bitmap.as_rgba_bytes(),
    })
}

/// Whole-page render, implemented as a full-page tile so that page renders
/// and tile renders share one PDFium pipeline — the two pipelines
/// (`render_with_config` vs `render_into_bitmap` + origin) produce subtly
/// different rasterisation, which would make tiles visibly seam against
/// whole-page output.
fn render_one(
    document: &PdfDocument<'_>,
    page_index: u16,
    scale: f32,
) -> Result<RenderedPage, PdfError> {
    let page = document.pages().get(page_index.into())?;
    let width = (page.width().value * scale).round().max(1.0) as i32;
    let height = (page.height().value * scale).round().max(1.0) as i32;
    drop(page);
    render_tile(
        document,
        page_index,
        scale,
        TileRect {
            x: 0,
            y: 0,
            width,
            height,
        },
    )
}
