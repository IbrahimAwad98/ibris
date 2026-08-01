//! The M5 gate, and a safety-critical one: redaction must REMOVE content,
//! not cover it. The proof extracts text from the saved file and asserts
//! the redacted string is gone — never merely that a rectangle was drawn.

use std::path::PathBuf;

use ibris_lib::pdf::annot::{AnnotGeom, AnnotPoint, AnnotRect, AnnotationData};
use ibris_lib::pdf::error::PdfError;
use ibris_lib::pdf::redact::RedactRegion;
use ibris_lib::pdf::save::SaveRequest;
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

fn temp_copy(src: &str, name: &str) -> PathBuf {
    let dest = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::copy(fixture(src), &dest).expect("fixture copy failed");
    dest
}

/// Whole extracted text of a page through the normal open path.
async fn page_text(service: &PdfService, path: &PathBuf, page: u16) -> String {
    let (doc_id, _) = service.open(path.clone()).await.expect("open failed");
    let text = service
        .extract_text(doc_id, page)
        .await
        .expect("extract failed")
        .runs
        .iter()
        .map(|r| r.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    service.close(doc_id).expect("close failed");
    text
}

/// The bounding rect (top-left page points) of the first run containing
/// `needle`, expanded slightly so the region fully covers the glyphs.
async fn run_rect(service: &PdfService, path: &PathBuf, needle: &str) -> RedactRegion {
    let (doc_id, _) = service.open(path.clone()).await.expect("open failed");
    let runs = service
        .extract_text(doc_id, 0)
        .await
        .expect("extract failed")
        .runs;
    service.close(doc_id).expect("close failed");
    let run = runs
        .iter()
        .find(|r| r.text.contains(needle))
        .unwrap_or_else(|| panic!("fixture lost its \"{needle}\" run"));
    RedactRegion {
        page_index: 0,
        rect: AnnotRect {
            x: run.x - 2.0,
            y: run.y - 2.0,
            width: run.width + 4.0,
            height: run.height + 4.0,
        },
    }
}

#[tokio::test]
async fn redacted_text_is_gone_from_the_saved_file() {
    let path = temp_copy("plain-text.pdf", "redact-text.pdf");
    let service = PdfService::new();

    let before = page_text(&service, &path, 0).await;
    assert!(before.contains("quick"), "fixture premise: {before}");
    assert!(before.contains("smoke"), "fixture premise: {before}");

    let region = run_rect(&service, &path, "quick").await;
    service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                redactions: vec![region.clone()],
                ..Default::default()
            },
        )
        .await
        .expect("redaction save failed");

    // THE assertion: the string is absent from extraction, not covered.
    let after = page_text(&service, &path, 0).await;
    assert!(
        !after.to_lowercase().contains("quick"),
        "redacted text still extractable: {after}"
    );
    // Whole-object removal is documented over-redaction; unrelated lines
    // survive.
    assert!(
        after.contains("smoke"),
        "redaction destroyed unrelated text: {after}"
    );

    // The marker box draws where the content was.
    let (doc_id, _) = service.open(path.clone()).await.expect("reopen failed");
    let page = service
        .render(doc_id, 0, 1.0, false, 91)
        .await
        .expect("render failed");
    let w = page.width as usize;
    let cx = (region.rect.x + region.rect.width / 2.0) as usize;
    let cy = (region.rect.y + region.rect.height / 2.0) as usize;
    let i = (cy * w + cx) * 4;
    assert!(
        page.rgba[i] < 40 && page.rgba[i + 1] < 40 && page.rgba[i + 2] < 40,
        "no black marker at the redaction site"
    );
}

#[tokio::test]
async fn full_page_redaction_removes_images_too() {
    let path = temp_copy("dark-photo-charts.pdf", "redact-image.pdf");
    let service = PdfService::new();

    // Page 0 is 300x200 and carries a photo image; redact all of it. The
    // engine's built-in verification re-parses the output and fails the
    // save if any image still intersects the region.
    service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0, 1],
                redactions: vec![RedactRegion {
                    page_index: 0,
                    rect: AnnotRect {
                        x: 0.0,
                        y: 0.0,
                        width: 300.0,
                        height: 200.0,
                    },
                }],
                ..Default::default()
            },
        )
        .await
        .expect("image redaction save failed");

    let after = page_text(&service, &path, 0).await;
    assert!(
        after.trim().is_empty(),
        "text survived a full-page redaction: {after}"
    );
}

#[tokio::test]
async fn redaction_refuses_when_an_annotation_elsewhere_carries_the_text() {
    let path = temp_copy("plain-text.pdf", "redact-refuse.pdf");
    let service = PdfService::new();

    // A note far from the redaction region quotes the doomed text.
    let note = AnnotationData {
        id: "leaky-note".into(),
        page_index: 0,
        color: "#ffd400".into(),
        opacity: 1.0,
        author: "refusal-test".into(),
        created_at: 1_753_999_000_000,
        modified_at: 1_753_999_000_000,
        geom: AnnotGeom::Note {
            at: AnnotPoint { x: 500.0, y: 700.0 },
            contents: "reminder: the quick brown fox line".into(),
        },
    };
    service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                annotations: vec![note],
                our_ids: vec!["leaky-note".into()],
                ..Default::default()
            },
        )
        .await
        .expect("annotation save failed");

    let region = run_rect(&service, &path, "quick").await;
    let result = service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                our_ids: vec!["leaky-note".into()],
                redactions: vec![region],
                ..Default::default()
            },
        )
        .await;
    match result {
        Err(PdfError::Unsupported { feature }) => {
            assert!(
                feature.contains("annotation"),
                "refusal names the wrong channel: {feature}"
            );
        }
        other => panic!("leaky redaction must refuse, got {other:?}"),
    }
    // And the file still contains the text — nothing was half-applied.
    let after = page_text(&service, &path, 0).await;
    assert!(after.contains("quick"), "refused save modified the file");
}
