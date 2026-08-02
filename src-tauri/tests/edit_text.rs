//! The M6a gate. The refusal path is proven BEFORE the happy path
//! (M6-PLAN §2): a replacement needing a glyph the embedded subset lacks
//! must be refused with the character named and the file left
//! byte-identical — never accepted and rendered as tofu.
//!
//! Fixture: subset-font.pdf carries "Hello world" in a synthetic embedded
//! TrueType font whose glyph set is exactly {H, e, l, o, w, r, d, space}.

use std::path::PathBuf;

use ibris_lib::pdf::edit_text::TextEdit;
use ibris_lib::pdf::error::PdfError;
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

/// Whole extracted text of page 0 through the normal open path.
async fn page_text(service: &PdfService, path: &PathBuf) -> String {
    let (doc_id, _) = service.open(path.clone()).await.expect("open failed");
    let text = service
        .extract_text(doc_id, 0)
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

/// Index of the first text object on page 0 whose text contains `needle`.
async fn object_index_of(service: &PdfService, path: &PathBuf, needle: &str) -> u32 {
    let (doc_id, _) = service.open(path.clone()).await.expect("open failed");
    let objects = service
        .list_text_objects(doc_id, 0)
        .await
        .expect("list failed");
    service.close(doc_id).expect("close failed");
    objects
        .iter()
        .find(|o| o.text.contains(needle))
        .unwrap_or_else(|| panic!("no text object containing {needle:?}: {objects:?}"))
        .object_index
}

// ---- Refusal path FIRST -------------------------------------------------

#[tokio::test]
async fn missing_glyph_refuses_the_save_and_leaves_the_file_untouched() {
    let path = temp_copy("subset-font.pdf", "edit-refuse.pdf");
    let service = PdfService::new();
    let original = std::fs::read(&path).expect("read fixture");

    let idx = object_index_of(&service, &path, "Hello").await;
    // 'x' is genuinely absent from the embedded subset.
    let result = service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                text_edits: vec![TextEdit {
                    page_index: 0,
                    object_index: idx,
                    before: "Hello world".into(),
                    after: "Hexed world".into(),
                }],
                ..Default::default()
            },
        )
        .await;

    match result {
        Err(PdfError::Unsupported { feature }) => {
            assert!(
                feature.contains('x'),
                "refusal must name the missing character: {feature}"
            );
            assert!(
                feature.to_lowercase().contains("font"),
                "refusal must name the font subset as the reason: {feature}"
            );
        }
        other => panic!("missing-glyph edit must refuse, got {other:?}"),
    }
    // Byte-identical: nothing was half-applied.
    let after = std::fs::read(&path).expect("read after");
    assert_eq!(original, after, "refused save modified the file on disk");
}

#[tokio::test]
async fn check_text_edit_names_the_missing_glyphs_before_any_save() {
    let path = fixture("subset-font.pdf");
    let service = PdfService::new();
    let idx = object_index_of(&service, &path, "Hello").await;

    let result = service
        .check_text_edit(path.clone(), 0, idx, "Hexagon!".into())
        .await;
    match result {
        Err(PdfError::Unsupported { feature }) => {
            for missing in ["x", "a", "g", "n", "!"] {
                assert!(
                    feature.contains(missing),
                    "check must name '{missing}': {feature}"
                );
            }
            // Present glyphs must NOT be reported missing.
            assert!(!feature.contains("'H'"), "H is in the subset: {feature}");
            assert!(!feature.contains("'e'"), "e is in the subset: {feature}");
        }
        other => panic!("check must refuse missing glyphs, got {other:?}"),
    }

    // A replacement drawn purely from the subset passes.
    service
        .check_text_edit(path.clone(), 0, idx, "Held word".into())
        .await
        .expect("subset-only replacement must pass the gate");
}

#[tokio::test]
async fn stale_before_text_refuses_instead_of_overwriting() {
    let path = temp_copy("subset-font.pdf", "edit-stale.pdf");
    let service = PdfService::new();
    let original = std::fs::read(&path).expect("read fixture");
    let idx = object_index_of(&service, &path, "Hello").await;

    let result = service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                text_edits: vec![TextEdit {
                    page_index: 0,
                    object_index: idx,
                    // Claims the object said something it does not.
                    before: "Howdy world".into(),
                    after: "Held word".into(),
                }],
                ..Default::default()
            },
        )
        .await;
    assert!(
        matches!(result, Err(PdfError::Unsupported { .. })),
        "stale edit must refuse, got {result:?}"
    );
    let after = std::fs::read(&path).expect("read after");
    assert_eq!(original, after, "refused save modified the file on disk");
}

// ---- Happy path ---------------------------------------------------------

#[tokio::test]
async fn subset_only_edit_lands_and_survives_reopen() {
    let path = temp_copy("subset-font.pdf", "edit-happy.pdf");
    let service = PdfService::new();
    let idx = object_index_of(&service, &path, "Hello").await;

    service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                text_edits: vec![TextEdit {
                    page_index: 0,
                    object_index: idx,
                    before: "Hello world".into(),
                    after: "Held word".into(),
                }],
                ..Default::default()
            },
        )
        .await
        .expect("subset-only edit save failed");

    let text = page_text(&service, &path).await;
    assert!(
        text.contains("Held word"),
        "edit not present after save: {text}"
    );
    assert!(
        !text.contains("Hello world"),
        "old text still present after save: {text}"
    );
}

#[tokio::test]
async fn other_text_on_the_page_is_untouched() {
    // plain-text.pdf has several standard-font lines; edit one, verify the
    // rest — including the engine's always-on verification pass — hold.
    let path = temp_copy("plain-text.pdf", "edit-others.pdf");
    let service = PdfService::new();

    let before_all = page_text(&service, &path).await;
    assert!(
        before_all.contains("quick"),
        "fixture premise: {before_all}"
    );
    assert!(
        before_all.contains("smoke"),
        "fixture premise: {before_all}"
    );

    let idx = object_index_of(&service, &path, "quick").await;
    let (doc_id, _) = service.open(path.clone()).await.expect("open");
    let objects = service.list_text_objects(doc_id, 0).await.expect("list");
    service.close(doc_id).expect("close");
    let old = objects
        .iter()
        .find(|o| o.object_index == idx)
        .expect("edited object listed")
        .text
        .clone();
    let new = old.replace("quick", "rapid");

    service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                text_edits: vec![TextEdit {
                    page_index: 0,
                    object_index: idx,
                    before: old,
                    after: new,
                }],
                ..Default::default()
            },
        )
        .await
        .expect("standard-font edit save failed");

    let after_all = page_text(&service, &path).await;
    assert!(after_all.contains("rapid"), "edit missing: {after_all}");
    assert!(
        !after_all.contains("quick"),
        "old word still present: {after_all}"
    );
    assert!(
        after_all.contains("smoke"),
        "unrelated text lost by the edit: {after_all}"
    );
}

#[tokio::test]
async fn text_edit_plus_redaction_on_the_same_page_is_refused() {
    let path = temp_copy("subset-font.pdf", "edit-and-redact.pdf");
    let service = PdfService::new();
    let idx = object_index_of(&service, &path, "Hello").await;

    let result = service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                text_edits: vec![TextEdit {
                    page_index: 0,
                    object_index: idx,
                    before: "Hello world".into(),
                    after: "Held word".into(),
                }],
                redactions: vec![ibris_lib::pdf::redact::RedactRegion {
                    page_index: 0,
                    rect: ibris_lib::pdf::annot::AnnotRect {
                        x: 400.0,
                        y: 400.0,
                        width: 50.0,
                        height: 20.0,
                    },
                }],
                ..Default::default()
            },
        )
        .await;
    assert!(
        matches!(result, Err(PdfError::Unsupported { .. })),
        "same-page edit+redact must refuse, got {result:?}"
    );
}
