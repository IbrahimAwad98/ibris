use std::path::PathBuf;

use ibris_lib::pdf::error::PdfError;
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

#[tokio::test]
async fn extracts_baseline_runs_with_sane_geometry() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    let text = service
        .extract_text(doc_id, 0)
        .await
        .expect("extract failed");

    assert_eq!(text.runs.len(), 2, "fixture has two text lines");
    assert_eq!(text.runs[0].text, "Ibris M0 render smoke test");
    assert_eq!(
        text.runs[1].text,
        "The quick brown fox jumps over the lazy dog."
    );

    for run in &text.runs {
        assert!(run.x > 0.0 && run.x < 612.0, "x out of page: {}", run.x);
        assert!(run.y > 0.0 && run.y < 792.0, "y out of page: {}", run.y);
        assert!(run.width > 0.0 && run.height > 0.0);
        // 24pt font: height should be in that neighbourhood.
        assert!(
            run.height > 10.0 && run.height < 40.0,
            "implausible run height {}",
            run.height
        );
    }
    // First line starts at 72pt left margin, near y = 792-700-ascent ≈ 74-92.
    assert!((text.runs[0].x - 72.0).abs() < 3.0);
    assert!(text.runs[0].y > 60.0 && text.runs[0].y < 100.0);
    // Second line is below the first.
    assert!(text.runs[1].y > text.runs[0].y + 20.0);
}

#[tokio::test]
async fn chunked_search_streams_and_respects_toggles() {
    let service = PdfService::new();
    let (doc_id, info) = service
        .open(fixture("large-300-pages.pdf"))
        .await
        .expect("open failed");
    assert_eq!(info.page_count, 300);

    // First chunk of 20 pages: exactly one "fox" per page.
    let chunk = service
        .search(doc_id, "fox".into(), false, false, 0, 19, 1)
        .await
        .expect("search failed");
    assert_eq!(chunk.len(), 20);
    assert_eq!(chunk[0].page_index, 0);
    assert_eq!(chunk[19].page_index, 19);
    assert!(chunk[0].context.contains("quick brown fox jumps"));
    assert_eq!(chunk[0].rects.len(), 1, "single-line match, one rect");
    let r = chunk[0].rects[0];
    assert!(r.width > 5.0 && r.height > 5.0);

    // Case-insensitive by default; case-sensitive rejects wrong case.
    let upper = service
        .search(doc_id, "FOX".into(), false, false, 0, 4, 2)
        .await
        .expect("search failed");
    assert_eq!(upper.len(), 5);
    let upper_cs = service
        .search(doc_id, "FOX".into(), true, false, 0, 4, 3)
        .await
        .expect("search failed");
    assert_eq!(upper_cs.len(), 0);

    // Whole-word: "fo" matches nothing, "fox" still matches.
    let partial = service
        .search(doc_id, "fo".into(), false, true, 0, 4, 4)
        .await
        .expect("search failed");
    assert_eq!(partial.len(), 0);
    let whole = service
        .search(doc_id, "fox".into(), false, true, 0, 4, 5)
        .await
        .expect("search failed");
    assert_eq!(whole.len(), 5);
}

#[tokio::test]
async fn search_matches_across_multiple_hits_per_page() {
    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    // "e" appears many times on the page; all hits are reported.
    let hits = service
        .search(doc_id, "the".into(), false, false, 0, 0, 1)
        .await
        .expect("search failed");
    assert_eq!(hits.len(), 2, "'the' appears twice (The, the)");
}

#[tokio::test]
async fn outline_fixture_yields_tree_and_plain_fixture_yields_empty() {
    let service = PdfService::new();

    let (with_outline, info) = {
        let (id, info) = service
            .open(fixture("outline.pdf"))
            .await
            .expect("open outline fixture failed");
        (id, info)
    };
    assert_eq!(info.page_count, 5);

    let outline = service.outline(with_outline).await.expect("outline failed");
    assert_eq!(outline.len(), 3, "three top-level entries");
    assert_eq!(outline[0].title, "Introduction");
    assert_eq!(outline[0].page_index, Some(0));
    assert_eq!(outline[1].title, "Chapter One");
    assert_eq!(outline[1].page_index, Some(1));
    assert_eq!(outline[1].children.len(), 1);
    assert_eq!(outline[1].children[0].title, "Section 1.1");
    assert_eq!(outline[1].children[0].page_index, Some(2));
    assert_eq!(outline[2].title, "Appendix");
    assert_eq!(outline[2].page_index, Some(4));

    let (plain, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");
    let empty = service.outline(plain).await.expect("outline failed");
    assert!(empty.is_empty());
}

#[tokio::test]
async fn cancelled_search_chunk_returns_cancelled() {
    use ibris_lib::pdf::engine::{EngineHandle, EngineMsg};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let service = PdfService::new();
    let (doc_id, _) = service
        .open(fixture("plain-text.pdf"))
        .await
        .expect("open failed");

    let (reply, rx) = tokio::sync::oneshot::channel();
    EngineHandle::global()
        .send(EngineMsg::Search {
            doc_id,
            query: "fox".into(),
            case_sensitive: false,
            whole_word: false,
            from_page: 0,
            to_page: 0,
            cancel: Arc::new(AtomicBool::new(true)),
            reply,
        })
        .expect("send failed");

    match rx.await.expect("engine dropped reply") {
        Err(PdfError::Cancelled) => {}
        other => panic!("expected Cancelled, got {:?}", other.map(|m| m.len())),
    }
}
