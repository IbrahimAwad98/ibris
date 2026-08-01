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

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::thread;

use pdfium_render::prelude::*;
use serde::Serialize;
use tokio::sync::oneshot;

use super::dark;
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
    /// Our own saved annotations, recovered from the file at open
    /// (M2-PLAN §8). The frontend seeds its document store with these; the
    /// viewing document has them suppressed so the bitmap never
    /// double-renders against the SVG overlay.
    pub annotations: Vec<super::annot::AnnotationData>,
    /// The document's interactive form, if any (M4).
    pub form: super::form::FormInfo,
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
    /// Dark mode: flip lightness in place, skipping embedded images.
    pub invert: bool,
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
    /// Dark mode: flip lightness in place, skipping embedded images.
    pub invert: bool,
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
    /// Applies structure + annotations to the file at `src_path` and writes
    /// the result to `dest_path` (pdf/save.rs). Works on a fresh load; the
    /// viewing document is untouched.
    SaveDocument {
        src_path: PathBuf,
        dest_path: PathBuf,
        /// Final page sequence as source indexes; omissions are deletions;
        /// negative entries reference `inserts` (order -(k+1) = inserts[k]).
        order: Vec<i32>,
        /// Pages imported from other files.
        inserts: Vec<super::save::InsertSource>,
        /// Extra clockwise rotation in degrees per source page.
        rotations: Vec<(u16, u16)>,
        annotations: Vec<super::annot::AnnotationData>,
        our_ids: Vec<String>,
        /// Form field values to fill (M4).
        field_values: Vec<super::form::FieldWrite>,
        /// Flatten annotations and fields into page content (M4).
        flatten: bool,
        reply: oneshot::Sender<Result<(), PdfError>>,
    },
    /// Concatenates whole files into a new document.
    MergeDocuments {
        paths: Vec<PathBuf>,
        dest_path: PathBuf,
        reply: oneshot::Sender<Result<(), PdfError>>,
    },
    /// Enumerates the annotations of the file at `path` (fresh raw load).
    /// Verification/debug aid; the viewer renders annotations via bitmap.
    ReadAnnotations {
        path: PathBuf,
        reply: oneshot::Sender<Result<Vec<super::annot::ReadAnnotation>, PdfError>>,
    },
    Close {
        doc_id: u64,
    },
}

impl EngineMsg {
    /// The document this message concerns; `None` for messages that are not
    /// tied to an open document (`Open`), which are always user-initiated.
    fn doc_id(&self) -> Option<u64> {
        match self {
            EngineMsg::Open { .. }
            | EngineMsg::SaveDocument { .. }
            | EngineMsg::MergeDocuments { .. }
            | EngineMsg::ReadAnnotations { .. } => None,
            EngineMsg::Render(r) => Some(r.doc_id),
            EngineMsg::RenderTile(r) => Some(r.doc_id),
            EngineMsg::ExtractText { doc_id, .. }
            | EngineMsg::Search { doc_id, .. }
            | EngineMsg::Outline { doc_id, .. }
            | EngineMsg::Close { doc_id } => Some(*doc_id),
        }
    }
}

/// Index of the next message the engine should run: the first *hot* one —
/// doc-less, or belonging to the active document — falling back to plain
/// FIFO so background documents drain whenever the visible one is idle.
fn next_index(doc_ids: &[Option<u64>], active: Option<u64>) -> Option<usize> {
    if doc_ids.is_empty() {
        return None;
    }
    doc_ids
        .iter()
        .position(|d| d.is_none() || (active.is_some() && *d == active))
        .or(Some(0))
}

/// Sentinel for "no active document" in [`EngineQueue::active`].
const NO_ACTIVE: u64 = u64::MAX;

/// The engine's inbox: an unbounded queue whose dequeue order favours the
/// active (visible) document — decision 008's follow-up. Not a second
/// thread; just a smarter channel.
// ponytail: dequeue is an O(n) scan over the queued messages. The queue is
// tens of entries deep at the very worst (one viewport of tiles plus one
// progressive-preview pass per open tab); index it per-doc if that changes.
struct EngineQueue {
    inner: Mutex<VecDeque<EngineMsg>>,
    cond: Condvar,
    active: AtomicU64,
}

impl EngineQueue {
    fn new() -> Self {
        EngineQueue {
            inner: Mutex::new(VecDeque::new()),
            cond: Condvar::new(),
            active: AtomicU64::new(NO_ACTIVE),
        }
    }

    // The engine thread is the only place a panic could poison these locks,
    // and it holds them only around queue plumbing that cannot panic; if it
    // somehow does, the queue data is still consistent, so keep going.
    fn send(&self, msg: EngineMsg) {
        let mut q = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        q.push_back(msg);
        self.cond.notify_one();
    }

    fn set_active(&self, doc_id: Option<u64>) {
        self.active
            .store(doc_id.unwrap_or(NO_ACTIVE), Ordering::Relaxed);
    }

    /// Blocks until a message is available and returns the highest-priority
    /// one per [`next_index`].
    fn recv(&self) -> EngineMsg {
        let mut q = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            let raw = self.active.load(Ordering::Relaxed);
            let active = (raw != NO_ACTIVE).then_some(raw);
            let ids: Vec<Option<u64>> = q.iter().map(EngineMsg::doc_id).collect();
            if let Some(i) = next_index(&ids, active) {
                if let Some(msg) = q.remove(i) {
                    return msg;
                }
            }
            q = self.cond.wait(q).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// Cloneable handle into the engine thread.
#[derive(Clone)]
pub struct EngineHandle {
    queue: Arc<EngineQueue>,
}

impl EngineHandle {
    /// The process-wide engine, spawned on first use.
    pub fn global() -> &'static EngineHandle {
        static ENGINE: OnceLock<EngineHandle> = OnceLock::new();
        ENGINE.get_or_init(|| {
            let queue = Arc::new(EngineQueue::new());
            let worker = queue.clone();
            thread::spawn(move || engine_main(worker));
            EngineHandle { queue }
        })
    }

    /// Queues a message. Never fails: the engine thread lives for the whole
    /// process, and even if it died, callers learn via their dropped reply
    /// channel. The `Result` is kept so the send site's contract is stable.
    pub fn send(&self, msg: EngineMsg) -> Result<(), PdfError> {
        self.queue.send(msg);
        Ok(())
    }

    /// Declares which document is visible; its queued work runs first.
    /// `None` (no document open) restores plain FIFO.
    pub fn set_active(&self, doc_id: Option<u64>) {
        self.queue.set_active(doc_id);
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

fn engine_main(queue: Arc<EngineQueue>) {
    let mut docs: HashMap<u64, PdfDocument<'static>> = HashMap::new();
    let mut next_id: u64 = 0;

    loop {
        match queue.recv() {
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
                    .and_then(|doc| render_one(doc, req.page_index, req.scale, req.invert));
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
                    .and_then(|doc| {
                        render_tile(doc, req.page_index, req.scale, req.rect, req.invert)
                    });
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
            EngineMsg::SaveDocument {
                src_path,
                dest_path,
                order,
                inserts,
                rotations,
                annotations,
                our_ids,
                field_values,
                flatten,
                reply,
            } => {
                // pdfium()? guarantees the bindings global is initialised
                // before the raw-FFI save path reaches for it.
                let result = pdfium().map(|_| ()).and_then(|()| {
                    struct Access;
                    impl PdfiumLibraryBindingsAccessor<'static> for Access {}
                    super::save::save_document(
                        Access.bindings(),
                        &src_path,
                        &dest_path,
                        &order,
                        &inserts,
                        &rotations,
                        &annotations,
                        &our_ids,
                        &field_values,
                        flatten,
                    )
                });
                let _ = reply.send(result);
            }
            EngineMsg::MergeDocuments {
                paths,
                dest_path,
                reply,
            } => {
                let result = pdfium().map(|_| ()).and_then(|()| {
                    struct Access;
                    impl PdfiumLibraryBindingsAccessor<'static> for Access {}
                    super::save::merge_documents(Access.bindings(), &paths, &dest_path)
                });
                let _ = reply.send(result);
            }
            EngineMsg::ReadAnnotations { path, reply } => {
                let result = pdfium().map(|_| ()).and_then(|()| {
                    struct Access;
                    impl PdfiumLibraryBindingsAccessor<'static> for Access {}
                    let b = Access.bindings();
                    let bytes = std::fs::read(&path).map_err(|e| PdfError::Io {
                        detail: format!("reading {}: {e}", path.display()),
                    })?;
                    unsafe {
                        let doc = b.FPDF_LoadMemDocument64(&bytes, None);
                        if doc.is_null() {
                            return Err(PdfError::Corrupt {
                                detail: "file could not be parsed".into(),
                            });
                        }
                        let annots = super::annot::read_annotations(b, doc);
                        b.FPDF_CloseDocument(doc);
                        Ok(annots)
                    }
                });
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
    // Loaded from bytes, not by path: PDFium's file loader keeps an OS
    // handle open, which on Windows would block the save pipeline's atomic
    // rename over the file while it is being viewed.
    let bytes = std::fs::read(path).map_err(|e| PdfError::Io {
        detail: format!("reading {}: {e}", path.display()),
    })?;

    // Recover our own saved annotations (raw scan of a throwaway load)
    // before the viewing document exists. Failures here must not block
    // opening — a corrupt-but-parseable file still opens read-only.
    let recovered = {
        struct Access;
        impl PdfiumLibraryBindingsAccessor<'static> for Access {}
        let b = pdfium().map(|_| Access.bindings())?;
        unsafe {
            let raw = b.FPDF_LoadMemDocument64(&bytes, None);
            if raw.is_null() {
                None
            } else {
                let r = super::annot::read_ibris_annotations(b, raw);
                b.FPDF_CloseDocument(raw);
                Some(r)
            }
        }
    };

    let mut document = pdfium()?.load_pdf_from_byte_vec(bytes, None)?;

    // Suppress the recovered annotations in the viewing document (memory
    // only — the disk file is untouched): they now live in the frontend
    // model and render through the SVG overlay.
    let annotations = match recovered {
        Some(r) => {
            suppress_annotations(&mut document, &r.suppress_names);
            r.annotations
        }
        None => Vec::new(),
    };

    let pages: Vec<PageSizePt> = document
        .pages()
        .iter()
        .map(|page| PageSizePt {
            width: page.width().value,
            height: page.height().value,
        })
        .collect();
    let form = super::form::read_form(&document);
    let info = DocumentInfo {
        page_count: pages.len() as u16,
        pages,
        annotations,
        form,
    };

    let id = *next_id;
    *next_id += 1;
    docs.insert(id, document);
    Ok((id, info))
}

/// Deletes every annotation whose /NM is in `names` from the in-memory
/// viewing document. Never touches disk; best-effort — an annotation that
/// refuses deletion just keeps rendering via the bitmap (read-only), which
/// is the graceful degradation M2-PLAN §8 specifies.
fn suppress_annotations(document: &mut PdfDocument<'_>, names: &[String]) {
    if names.is_empty() {
        return;
    }
    let count = document.pages().len();
    for page_index in 0..count {
        let Ok(mut page) = document.pages().get(page_index) else {
            continue;
        };
        loop {
            // Through annotations_mut() so the fetched annotation borrows
            // the page's true lifetime, not this statement's.
            let annots = page.annotations_mut();
            let target = annots
                .iter()
                .position(|a| a.name().is_some_and(|n| names.contains(&n)));
            let Some(at) = target else { break };
            let Ok(annot) = annots.get(at) else { break };
            if annots.delete_annotation(annot).is_err() {
                break;
            }
        }
    }
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
    invert: bool,
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
    let mut rgba = bitmap.as_rgba_bytes();
    if invert {
        let skip = image_skip_rects(&page, scale, rect);
        dark::invert_page(&mut rgba, rect.width as u32, &skip);
    }
    Ok(RenderedPage {
        width: rect.width as u32,
        height: rect.height as u32,
        rgba,
    })
}

/// Device-pixel rects of the page's image objects, relative to this tile —
/// the regions dark mode must leave positive. Coordinates go through the
/// visible-box origin exactly like text geometry (decision 009).
// ponytail: only top-level page objects are scanned; an image nested inside
// a Form XObject still gets inverted. Recurse into form objects if a
// real-world document surfaces one.
fn image_skip_rects(page: &PdfPage<'_>, scale: f32, tile: TileRect) -> Vec<dark::PixelRect> {
    let (box_left, box_top) = super::text::visible_box_origin(page);
    page.objects()
        .iter()
        .filter_map(|object| {
            if object.object_type() != PdfPageObjectType::Image {
                return None;
            }
            let b = object.bounds().ok()?;
            Some(dark::PixelRect {
                x: ((b.left().value - box_left) * scale).floor() as i32 - tile.x,
                y: ((box_top - b.top().value) * scale).floor() as i32 - tile.y,
                width: (b.width().value * scale).ceil() as i32 + 1,
                height: (b.height().value * scale).ceil() as i32 + 1,
            })
        })
        .collect()
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
    invert: bool,
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
        invert,
    )
}

#[cfg(test)]
mod queue_tests {
    use super::next_index;

    #[test]
    fn active_doc_message_jumps_the_queue() {
        assert_eq!(next_index(&[Some(1), Some(1), Some(2)], Some(2)), Some(2));
    }

    #[test]
    fn doc_less_messages_are_always_hot() {
        assert_eq!(next_index(&[Some(1), None], Some(2)), Some(1));
    }

    #[test]
    fn fifo_within_the_active_doc() {
        assert_eq!(next_index(&[Some(2), Some(2)], Some(2)), Some(0));
    }

    #[test]
    fn falls_back_to_front_when_active_absent() {
        assert_eq!(next_index(&[Some(1), Some(3)], Some(2)), Some(0));
    }

    #[test]
    fn no_active_doc_means_plain_fifo() {
        assert_eq!(next_index(&[Some(1), Some(2)], None), Some(0));
    }

    #[test]
    fn empty_queue_yields_none() {
        assert_eq!(next_index(&[], Some(1)), None);
    }
}
