use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use super::engine::{
    DocumentInfo, EngineHandle, EngineMsg, OutlineNode, RenderRequest, RenderedPage, TileRect,
    TileRequest,
};
use super::error::PdfError;
use super::text::{PageText, SearchMatch};

/// Async facade over the engine thread plus the cancellation registry.
/// Lives in Tauri managed state; all methods are cheap — the PDF work
/// happens on the engine thread.
#[derive(Default)]
pub struct PdfService {
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl PdfService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens a document and returns its id plus page metadata. Fails with
    /// `FileNotFound`, `PasswordRequired`, `Corrupt`, or `Io`.
    pub async fn open(&self, path: PathBuf) -> Result<(u64, DocumentInfo), PdfError> {
        let (reply, rx) = oneshot::channel();
        EngineHandle::global().send(EngineMsg::Open { path, reply })?;
        rx.await.map_err(|_| PdfError::Internal {
            detail: "engine dropped the open request".into(),
        })?
    }

    /// Renders one page. `request_id` is caller-chosen and is the token
    /// `cancel` uses to abandon the request while it is still queued.
    pub async fn render(
        &self,
        doc_id: u64,
        page_index: u16,
        scale: f32,
        invert: bool,
        request_id: u64,
    ) -> Result<RenderedPage, PdfError> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.lock_cancels()?.insert(request_id, cancel.clone());

        let (reply, rx) = oneshot::channel();
        let sent = EngineHandle::global().send(EngineMsg::Render(RenderRequest {
            doc_id,
            page_index,
            scale,
            invert,
            cancel,
            reply,
        }));

        let result = match sent {
            Ok(()) => rx.await.unwrap_or(Err(PdfError::Internal {
                detail: "engine dropped the render request".into(),
            })),
            Err(e) => Err(e),
        };

        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(&request_id);
        }
        result
    }

    /// Renders one tile of a page. Same cancellation contract as `render`.
    #[allow(clippy::too_many_arguments)] // mirrors the wire format
    pub async fn render_tile(
        &self,
        doc_id: u64,
        page_index: u16,
        scale: f32,
        rect: TileRect,
        invert: bool,
        request_id: u64,
    ) -> Result<RenderedPage, PdfError> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.lock_cancels()?.insert(request_id, cancel.clone());

        let (reply, rx) = oneshot::channel();
        let sent = EngineHandle::global().send(EngineMsg::RenderTile(TileRequest {
            doc_id,
            page_index,
            scale,
            rect,
            invert,
            cancel,
            reply,
        }));

        let result = match sent {
            Ok(()) => rx.await.unwrap_or(Err(PdfError::Internal {
                detail: "engine dropped the tile request".into(),
            })),
            Err(e) => Err(e),
        };

        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(&request_id);
        }
        result
    }

    /// Extracts baseline-grouped text runs for one page.
    pub async fn extract_text(&self, doc_id: u64, page_index: u16) -> Result<PageText, PdfError> {
        let (reply, rx) = oneshot::channel();
        EngineHandle::global().send(EngineMsg::ExtractText {
            doc_id,
            page_index,
            reply,
        })?;
        rx.await.map_err(|_| PdfError::Internal {
            detail: "engine dropped the text request".into(),
        })?
    }

    /// Searches one page range. Cancellable via `request_id` like renders;
    /// the caller streams a whole document as successive ranges.
    #[allow(clippy::too_many_arguments)] // mirrors the wire format
    pub async fn search(
        &self,
        doc_id: u64,
        query: String,
        case_sensitive: bool,
        whole_word: bool,
        from_page: u16,
        to_page: u16,
        request_id: u64,
    ) -> Result<Vec<SearchMatch>, PdfError> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.lock_cancels()?.insert(request_id, cancel.clone());

        let (reply, rx) = oneshot::channel();
        let sent = EngineHandle::global().send(EngineMsg::Search {
            doc_id,
            query,
            case_sensitive,
            whole_word,
            from_page,
            to_page,
            cancel,
            reply,
        });

        let result = match sent {
            Ok(()) => rx.await.unwrap_or(Err(PdfError::Internal {
                detail: "engine dropped the search request".into(),
            })),
            Err(e) => Err(e),
        };

        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(&request_id);
        }
        result
    }

    /// Returns the document's bookmark tree; empty when there is none.
    pub async fn outline(&self, doc_id: u64) -> Result<Vec<OutlineNode>, PdfError> {
        let (reply, rx) = oneshot::channel();
        EngineHandle::global().send(EngineMsg::Outline { doc_id, reply })?;
        rx.await.map_err(|_| PdfError::Internal {
            detail: "engine dropped the outline request".into(),
        })?
    }

    /// Flags a queued render as abandoned. A request that already started
    /// rendering completes anyway; its result is simply unused.
    pub fn cancel(&self, request_id: u64) -> Result<(), PdfError> {
        if let Some(flag) = self.lock_cancels()?.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Batch cancel: one sweep for a page's worth of stale tiles (or the
    /// whole in-flight set on a zoom change) instead of one IPC per request.
    pub fn cancel_many(&self, request_ids: &[u64]) -> Result<(), PdfError> {
        let cancels = self.lock_cancels()?;
        for id in request_ids {
            if let Some(flag) = cancels.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    /// Applies structure and annotations to the file at `src_path`, writing
    /// the result to `dest_path` (same path means an in-place save; a
    /// subset order with another path is an extraction). The viewing
    /// document is untouched (see pdf/save.rs). Fails with `Io`,
    /// `Corrupt`, or `Internal`.
    #[allow(clippy::too_many_arguments)] // mirrors the wire format
    pub async fn save_document(
        &self,
        src_path: PathBuf,
        dest_path: PathBuf,
        order: Vec<i32>,
        inserts: Vec<super::save::InsertSource>,
        rotations: Vec<(u16, u16)>,
        annotations: Vec<super::annot::AnnotationData>,
        our_ids: Vec<String>,
    ) -> Result<(), PdfError> {
        let (reply, rx) = oneshot::channel();
        EngineHandle::global().send(EngineMsg::SaveDocument {
            src_path,
            dest_path,
            order,
            inserts,
            rotations,
            annotations,
            our_ids,
            reply,
        })?;
        rx.await.map_err(|_| PdfError::Internal {
            detail: "engine dropped the save request".into(),
        })?
    }

    /// Concatenates whole files into a new document at `dest_path`.
    pub async fn merge_documents(
        &self,
        paths: Vec<PathBuf>,
        dest_path: PathBuf,
    ) -> Result<(), PdfError> {
        let (reply, rx) = oneshot::channel();
        EngineHandle::global().send(EngineMsg::MergeDocuments {
            paths,
            dest_path,
            reply,
        })?;
        rx.await.map_err(|_| PdfError::Internal {
            detail: "engine dropped the merge request".into(),
        })?
    }

    /// Enumerates the annotations in the file at `path` (fresh load, not
    /// the viewing document). Verification aid for tests and diagnostics.
    pub async fn read_annotations(
        &self,
        path: PathBuf,
    ) -> Result<Vec<super::annot::ReadAnnotation>, PdfError> {
        let (reply, rx) = oneshot::channel();
        EngineHandle::global().send(EngineMsg::ReadAnnotations { path, reply })?;
        rx.await.map_err(|_| PdfError::Internal {
            detail: "engine dropped the read request".into(),
        })?
    }

    /// Closes a document; the engine drops it.
    pub fn close(&self, doc_id: u64) -> Result<(), PdfError> {
        EngineHandle::global().send(EngineMsg::Close { doc_id })
    }

    /// Declares the visible document; its queued engine work runs first.
    /// `None` (no document open) restores plain FIFO.
    pub fn set_active(&self, doc_id: Option<u64>) {
        EngineHandle::global().set_active(doc_id);
    }

    fn lock_cancels(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<u64, Arc<AtomicBool>>>, PdfError> {
        self.cancels.lock().map_err(|_| PdfError::Internal {
            detail: "cancellation registry poisoned".into(),
        })
    }
}
