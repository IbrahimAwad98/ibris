use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use ibris_lib::pdf::engine::{EngineHandle, EngineMsg, RenderRequest};
use ibris_lib::pdf::error::PdfError;
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

#[tokio::test]
async fn open_reports_page_count_and_sizes() {
    let service = PdfService::new();
    let (_, info) = service
        .open(fixture("large-300-pages.pdf"))
        .await
        .expect("open failed");

    assert_eq!(info.page_count, 300);
    assert_eq!(info.pages.len(), 300);
    for page in &info.pages {
        assert!((page.width - 612.0).abs() < 0.5, "width {}", page.width);
        assert!((page.height - 792.0).abs() < 0.5, "height {}", page.height);
    }
}

#[tokio::test]
async fn renders_page_with_real_ink() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    let page = service
        .render(doc_id, 0, 2.0, false, 1)
        .await
        .expect("render failed");

    assert_eq!(page.width, 1224);
    assert_eq!(page.height, 1584);
    assert_eq!(page.rgba.len(), (page.width * page.height * 4) as usize);

    let dark = page
        .rgba
        .chunks_exact(4)
        .filter(|p| p[0] < 128 && p[3] == 255)
        .count();
    assert!(dark > 1_000, "page rendered blank: {dark} dark pixels");
    assert!(
        dark < (page.width * page.height / 2) as usize,
        "page rendered mostly black: {dark} dark pixels"
    );
}

#[tokio::test]
async fn cancelled_request_is_skipped_without_rendering() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    // Pre-set cancel flag: the engine must reply Cancelled at dequeue.
    let (reply, rx) = tokio::sync::oneshot::channel();
    EngineHandle::global()
        .send(EngineMsg::Render(RenderRequest {
            doc_id,
            page_index: 0,
            scale: 2.0,
            invert: false,
            cancel: Arc::new(AtomicBool::new(true)),
            reply,
        }))
        .expect("send failed");

    match rx.await.expect("engine dropped reply") {
        Err(PdfError::Cancelled) => {}
        other => panic!(
            "expected Cancelled, got {:?}",
            other.map(|p| (p.width, p.height))
        ),
    }

    // The engine must still serve later requests normally.
    let page = service
        .render(doc_id, 0, 1.0, false, 99)
        .await
        .expect("render after cancel failed");
    assert_eq!(page.width, 612);
}

#[tokio::test]
async fn corrupt_file_returns_typed_error() {
    let service = PdfService::new();
    match service.open(fixture("corrupt.pdf")).await {
        Err(PdfError::Corrupt { .. }) => {}
        other => panic!(
            "expected Corrupt, got {:?}",
            other.err().map(|e| e.to_string())
        ),
    }
}

#[tokio::test]
async fn missing_file_returns_file_not_found() {
    let service = PdfService::new();
    match service.open(fixture("does-not-exist.pdf")).await {
        Err(PdfError::FileNotFound { .. }) => {}
        other => panic!(
            "expected FileNotFound, got {:?}",
            other.err().map(|e| e.to_string())
        ),
    }
}
