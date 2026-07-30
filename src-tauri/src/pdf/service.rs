use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

use super::engine::{DocumentInfo, EngineHandle, EngineMsg, RenderRequest, RenderedPage};
use super::error::PdfError;

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
        request_id: u64,
    ) -> Result<RenderedPage, PdfError> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.lock_cancels()?.insert(request_id, cancel.clone());

        let (reply, rx) = oneshot::channel();
        let sent = EngineHandle::global().send(EngineMsg::Render(RenderRequest {
            doc_id,
            page_index,
            scale,
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

    /// Flags a queued render as abandoned. A request that already started
    /// rendering completes anyway; its result is simply unused.
    pub fn cancel(&self, request_id: u64) -> Result<(), PdfError> {
        if let Some(flag) = self.lock_cancels()?.get(&request_id) {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    /// Closes a document; the engine drops it.
    pub fn close(&self, doc_id: u64) -> Result<(), PdfError> {
        EngineHandle::global().send(EngineMsg::Close { doc_id })
    }

    fn lock_cancels(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<u64, Arc<AtomicBool>>>, PdfError> {
        self.cancels.lock().map_err(|_| PdfError::Internal {
            detail: "cancellation registry poisoned".into(),
        })
    }
}
