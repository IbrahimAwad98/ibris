//! The M2 read-only gap, closed (M2-PLAN §8): annotations we saved must
//! come back from disk as fully editable model objects, and must stop
//! rendering in the viewing document (the SVG overlay owns them now).
//! When another tool strips the IbrisData key, the model is reconstructed
//! from standard PDF keys — never a silent read-only regression.

use std::path::PathBuf;

use ibris_lib::pdf::annot::{AnnotGeom, AnnotPoint, AnnotRect, AnnotationData};
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

fn temp_copy(name: &str) -> PathBuf {
    let dest = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::copy(fixture("plain-text.pdf"), &dest).expect("fixture copy failed");
    dest
}

fn annot(id: &str, geom: AnnotGeom) -> AnnotationData {
    AnnotationData {
        id: id.into(),
        page_index: 0,
        color: "#e0483c".into(),
        opacity: 0.8,
        author: "reopen-test".into(),
        created_at: 1_753_999_000_000,
        modified_at: 1_753_999_100_000,
        geom,
    }
}

fn rect(x: f32, y: f32, w: f32, h: f32) -> AnnotRect {
    AnnotRect {
        x,
        y,
        width: w,
        height: h,
    }
}

fn one_of_each() -> Vec<AnnotationData> {
    vec![
        annot(
            "id-highlight",
            AnnotGeom::Highlight {
                quads: vec![
                    rect(72.0, 100.0, 120.0, 14.0),
                    rect(72.0, 118.0, 80.0, 14.0),
                ],
            },
        ),
        annot(
            "id-underline",
            AnnotGeom::Underline {
                quads: vec![rect(72.0, 140.0, 100.0, 14.0)],
            },
        ),
        annot(
            "id-strikeout",
            AnnotGeom::Strikeout {
                quads: vec![rect(72.0, 160.0, 100.0, 14.0)],
            },
        ),
        annot(
            "id-ink",
            AnnotGeom::Ink {
                strokes: vec![
                    vec![
                        AnnotPoint { x: 100.0, y: 300.0 },
                        AnnotPoint { x: 140.0, y: 320.0 },
                        AnnotPoint { x: 180.0, y: 300.0 },
                    ],
                    vec![
                        AnnotPoint { x: 100.0, y: 340.0 },
                        AnnotPoint { x: 180.0, y: 340.0 },
                    ],
                ],
                stroke_width: 2.5,
            },
        ),
        annot(
            "id-note",
            AnnotGeom::Note {
                at: AnnotPoint { x: 500.0, y: 80.0 },
                contents: "Still editable after reopen".into(),
            },
        ),
        annot(
            "id-rect",
            AnnotGeom::Rect {
                rect: rect(220.0, 200.0, 120.0, 60.0),
                stroke_width: 2.0,
                fill: Some("#ffe08a".into()),
            },
        ),
        annot(
            "id-ellipse",
            AnnotGeom::Ellipse {
                rect: rect(220.0, 280.0, 120.0, 60.0),
                stroke_width: 2.0,
                fill: None,
            },
        ),
        annot(
            "id-line",
            AnnotGeom::Line {
                from: AnnotPoint { x: 100.0, y: 420.0 },
                to: AnnotPoint { x: 250.0, y: 460.0 },
                stroke_width: 2.0,
            },
        ),
        annot(
            "id-arrow",
            AnnotGeom::Arrow {
                from: AnnotPoint { x: 100.0, y: 480.0 },
                to: AnnotPoint { x: 250.0, y: 520.0 },
                stroke_width: 2.0,
            },
        ),
        annot(
            "id-stamp",
            AnnotGeom::Stamp {
                rect: rect(400.0, 400.0, 120.0, 50.0),
                stamp: "approved".into(),
            },
        ),
    ]
}

async fn save_one_of_each(service: &PdfService, path: &PathBuf) -> Vec<AnnotationData> {
    let annots = one_of_each();
    let ids: Vec<String> = annots.iter().map(|a| a.id.clone()).collect();
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0],
            vec![],
            vec![],
            annots.clone(),
            ids,
            vec![],
            false,
        )
        .await
        .expect("save failed");
    annots
}

/// Replaces every occurrence of `from` with the same-length `to` in the
/// file's raw bytes — same length keeps every xref offset valid. Returns
/// the number of replacements (a zero would mean the test premise is
/// wrong, e.g. PDFium started compressing annotation dictionaries).
fn patch_bytes(path: &PathBuf, from: &[u8], to: &[u8]) -> usize {
    assert_eq!(from.len(), to.len(), "patch must preserve length");
    let mut bytes = std::fs::read(path).expect("read for patch");
    let mut hits = 0;
    let mut i = 0;
    while i + from.len() <= bytes.len() {
        if &bytes[i..i + from.len()] == from {
            bytes[i..i + from.len()].copy_from_slice(to);
            hits += 1;
            i += from.len();
        } else {
            i += 1;
        }
    }
    std::fs::write(path, bytes).expect("write patched file");
    hits
}

fn count_red(
    rgba: &[u8],
    width: usize,
    xs: std::ops::Range<usize>,
    ys: std::ops::Range<usize>,
) -> usize {
    let mut hits = 0;
    for y in ys {
        for x in xs.clone() {
            let i = (y * width + x) * 4;
            let (r, g, b) = (rgba[i], rgba[i + 1], rgba[i + 2]);
            if r > 150 && g < 120 && b < 120 {
                hits += 1;
            }
        }
    }
    hits
}

#[tokio::test]
async fn reopen_returns_full_fidelity_models_and_suppresses_rendering() {
    let path = temp_copy("reopen-fidelity.pdf");
    let service = PdfService::new();
    let originals = save_one_of_each(&service, &path).await;

    let (doc_id, info) = service.open(path.clone()).await.expect("reopen failed");

    // Every annotation comes back bit-identical through the IbrisData key.
    assert_eq!(info.annotations.len(), originals.len(), "recovered count");
    for original in &originals {
        let back = info
            .annotations
            .iter()
            .find(|a| a.id == original.id)
            .unwrap_or_else(|| panic!("{} missing after reopen", original.id));
        assert_eq!(
            serde_json::to_value(back).unwrap(),
            serde_json::to_value(original).unwrap(),
            "{} did not survive reopen verbatim",
            original.id
        );
    }

    // The viewing document must NOT render them any more — the red rect's
    // top edge (y≈200, x 220..340 at scale 1) has to be clean paper now.
    let page = service
        .render(doc_id, 0, 1.0, false, 1)
        .await
        .expect("render failed");
    let hits = count_red(&page.rgba, page.width as usize, 218..342, 197..204);
    assert_eq!(
        hits, 0,
        "suppressed annotation still renders in the viewing document ({hits} red pixels)"
    );
}

#[tokio::test]
async fn stripped_ibrisdata_reconstructs_from_standard_keys() {
    let path = temp_copy("reopen-stripped.pdf");
    let service = PdfService::new();
    save_one_of_each(&service, &path).await;

    // Simulate a tool that drops private keys: rename /IbrisData in place.
    let hits = patch_bytes(&path, b"/IbrisData", b"/XbrisData");
    assert!(hits >= 10, "IbrisData keys not found to strip ({hits})");

    let (_doc_id, info) = service.open(path.clone()).await.expect("reopen failed");
    let by_id = |id: &str| {
        info.annotations
            .iter()
            .find(|a| a.id == id)
            .unwrap_or_else(|| panic!("{id} not reconstructed"))
    };
    let close = |a: f32, b: f32| (a - b).abs() < 0.6;

    // Everything reconstructs; nothing silently regresses to read-only.
    assert_eq!(info.annotations.len(), 10, "reconstructed count");

    let hl = by_id("id-highlight");
    match &hl.geom {
        AnnotGeom::Highlight { quads } => {
            assert_eq!(quads.len(), 2, "highlight quad count");
            assert!(close(quads[0].x, 72.0), "quad x: {}", quads[0].x);
            assert!(close(quads[0].y, 100.0), "quad y: {}", quads[0].y);
            assert!(close(quads[0].width, 120.0), "quad w: {}", quads[0].width);
            assert!(close(quads[0].height, 14.0), "quad h: {}", quads[0].height);
        }
        g => panic!("highlight reconstructed as {g:?}"),
    }
    // Colour survives via the appearance stream (±2/255 from 2-dp rounding).
    assert_eq!(&hl.color[..3], "#e0", "highlight colour: {}", hl.color);
    assert!((hl.opacity - 0.8).abs() < 0.01, "opacity: {}", hl.opacity);
    assert_eq!(hl.author, "reopen-test");
    // Dates come back at second precision from /M and /CreationDate.
    assert!(
        (hl.created_at - 1_753_999_000_000).abs() < 1000,
        "createdAt"
    );

    match &by_id("id-note").geom {
        AnnotGeom::Note { at, contents } => {
            assert_eq!(contents, "Still editable after reopen");
            assert!(close(at.x, 500.0) && close(at.y, 80.0), "note at {at:?}");
        }
        g => panic!("note reconstructed as {g:?}"),
    }

    match &by_id("id-ink").geom {
        AnnotGeom::Ink { strokes, .. } => {
            assert_eq!(strokes.len(), 2, "ink stroke count");
            assert_eq!(strokes[0].len(), 3, "ink first-stroke points");
            assert!(close(strokes[0][1].x, 140.0) && close(strokes[0][1].y, 320.0));
        }
        g => panic!("ink reconstructed as {g:?}"),
    }

    match &by_id("id-line").geom {
        AnnotGeom::Line { from, to, .. } => {
            assert!(close(from.x, 100.0) && close(from.y, 420.0), "line from");
            assert!(close(to.x, 250.0) && close(to.y, 460.0), "line to");
        }
        g => panic!("line reconstructed as {g:?}"),
    }

    // Documented degradation: without IbrisData an arrow comes back as a
    // line (the head cannot be told apart from the standard keys).
    match &by_id("id-arrow").geom {
        AnnotGeom::Line { from, to, .. } => {
            assert!(close(from.x, 100.0) && close(from.y, 480.0), "arrow from");
            assert!(close(to.x, 250.0) && close(to.y, 520.0), "arrow to");
        }
        g => panic!("arrow should degrade to a line, got {g:?}"),
    }

    match &by_id("id-rect").geom {
        AnnotGeom::Rect { rect, fill, .. } => {
            assert!(close(rect.x, 220.0), "rect x: {}", rect.x);
            assert!(close(rect.y, 200.0), "rect y: {}", rect.y);
            assert!(close(rect.width, 120.0), "rect w: {}", rect.width);
            let fill = fill.as_deref().expect("rect lost its fill");
            assert_eq!(&fill[..3], "#ff", "rect fill: {fill}");
        }
        g => panic!("rect reconstructed as {g:?}"),
    }

    match &by_id("id-stamp").geom {
        AnnotGeom::Stamp { stamp, rect } => {
            assert_eq!(stamp, "approved");
            assert!(close(rect.x, 400.0) && close(rect.y, 400.0), "stamp rect");
        }
        g => panic!("stamp reconstructed as {g:?}"),
    }
}

#[tokio::test]
async fn foreign_annotations_still_render_and_are_not_recovered() {
    let path = temp_copy("reopen-foreign.pdf");
    let service = PdfService::new();
    save_one_of_each(&service, &path).await;

    // Strip our identity entirely: without the ibris: /NM the annotations
    // are foreign, must not be recovered, and must keep rendering via the
    // page bitmap — visibly present, read-only, never silently dropped.
    let hits = patch_bytes(&path, b"(ibris:id-", b"(other:id-");
    assert!(hits >= 10, "prefixed /NM values not found ({hits})");

    let (doc_id, info) = service.open(path.clone()).await.expect("reopen failed");
    assert!(
        info.annotations.is_empty(),
        "foreign annotations must not be recovered"
    );
    let page = service
        .render(doc_id, 0, 1.0, false, 2)
        .await
        .expect("render failed");
    let hits = count_red(&page.rgba, page.width as usize, 218..342, 197..204);
    assert!(
        hits > 50,
        "foreign annotations stopped rendering ({hits} red pixels)"
    );
}
