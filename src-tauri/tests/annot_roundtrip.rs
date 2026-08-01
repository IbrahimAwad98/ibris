//! The M2 gate: one of each annotation type is written to a copy of a
//! fixture, the file is reopened cold, and every annotation must come back
//! with the right subtype, /NM identity, geometry, colour, opacity, and an
//! appearance stream. A render pass proves the appearance streams actually
//! draw ink. Third-party reader rendering (Acrobat, Edge, Preview) cannot
//! be verified here — that is on the user's manual checklist.

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
        author: "roundtrip-test".into(),
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
                contents: "A round-trip note ✓".into(),
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

// PDFium subtype constants (fpdf_annot.h).
const TEXT: i32 = 1;
const SQUARE: i32 = 5;
const CIRCLE: i32 = 6;
const HIGHLIGHT: i32 = 9;
const UNDERLINE: i32 = 10;
const STRIKEOUT: i32 = 12;
const STAMP: i32 = 13;
const INK: i32 = 15;

#[tokio::test]
async fn every_annotation_type_round_trips() {
    let path = temp_copy("roundtrip.pdf");
    let annots = one_of_each();
    let ids: Vec<String> = annots.iter().map(|a| a.id.clone()).collect();

    let service = PdfService::new();
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0],
            vec![],
            vec![],
            annots.clone(),
            ids.clone(),
        )
        .await
        .expect("save failed");

    // Reopen cold through the normal open path and read everything back.
    let (_doc_id, info) = service.open(path.clone()).await.expect("reopen failed");
    assert!(info.page_count > 0);
    let read = service
        .read_annotations(path.clone())
        .await
        .expect("read failed");

    let expect_subtype = [
        ("id-highlight", HIGHLIGHT),
        ("id-underline", UNDERLINE),
        ("id-strikeout", STRIKEOUT),
        ("id-ink", INK),
        ("id-note", TEXT),
        ("id-rect", SQUARE),
        ("id-ellipse", CIRCLE),
        // PDFium cannot create /Line annotations; lines and arrows are
        // written as /Ink (see pdf/annot.rs).
        ("id-line", INK),
        ("id-arrow", INK),
        ("id-stamp", STAMP),
    ];
    for (id, subtype) in expect_subtype {
        // /NM carries the ownership prefix on disk (M2-PLAN §8).
        let a = read
            .iter()
            .find(|a| a.id == format!("ibris:{id}"))
            .unwrap_or_else(|| panic!("{id} missing after round trip"));
        assert_eq!(a.subtype, subtype, "{id} came back as the wrong subtype");
        assert_eq!(a.page_index, 0, "{id} moved page");
        assert!(!a.appearance.is_empty(), "{id} lost its appearance stream");
        assert_eq!(a.author, "roundtrip-test", "{id} lost its author");
        // #e0483c → 0.88 0.28 0.24 in the appearance stream; that is the
        // colour readers actually draw. (FPDFAnnot_GetColor refuses to
        // answer once an /AP exists, so /C is asserted via the stream.)
        assert!(
            a.appearance.contains("0.88 0.28 0.24"),
            "{id} appearance lost its colour: {}",
            &a.appearance[..a.appearance.len().min(120)]
        );
        let ca = a.opacity.unwrap_or_else(|| panic!("{id} lost /CA opacity"));
        assert!((ca - 0.8).abs() < 0.01, "{id} opacity changed: {ca}");
    }

    // Geometry spot checks (PDF space; page is 792 pt tall, zero-origin
    // fixture, so pdf_y = 792 - y).
    let hl = read
        .iter()
        .find(|a| a.id == "ibris:id-highlight")
        .expect("highlight");
    assert_eq!(hl.quad_count, 2, "highlight quad count");
    assert!(
        (hl.rect.0 - 72.0).abs() < 0.5,
        "highlight left: {}",
        hl.rect.0
    );
    assert!(
        (hl.rect.1 - 692.0).abs() < 0.5,
        "highlight top: {}",
        hl.rect.1
    );

    let note = read.iter().find(|a| a.id == "ibris:id-note").expect("note");
    assert_eq!(note.contents, "A round-trip note ✓", "note contents");

    let rc = read.iter().find(|a| a.id == "ibris:id-rect").expect("rect");
    // /Rect is the drawn rect inflated by the stroke width (2.0).
    assert!((rc.rect.0 - 218.0).abs() < 0.5, "rect left: {}", rc.rect.0);
    assert!((rc.rect.2 - 342.0).abs() < 0.5, "rect right: {}", rc.rect.2);

    // Saving again over the annotated file must not duplicate anything.
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0],
            vec![],
            vec![],
            annots,
            ids,
        )
        .await
        .expect("second save failed");
    let read2 = service
        .read_annotations(path)
        .await
        .expect("second read failed");
    assert_eq!(
        read2.len(),
        read.len(),
        "second save duplicated annotations"
    );
}

#[tokio::test]
async fn appearance_streams_actually_draw() {
    let path = temp_copy("roundtrip-render.pdf");
    let annots = vec![annot(
        "id-rect-render",
        AnnotGeom::Rect {
            rect: rect(200.0, 200.0, 100.0, 50.0),
            stroke_width: 4.0,
            fill: None,
        },
    )];

    let service = PdfService::new();
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0],
            vec![],
            vec![],
            annots,
            vec!["id-rect-render".into()],
        )
        .await
        .expect("save failed");

    // Opening would recover-and-suppress our own annotation (M2-PLAN §8),
    // so de-tag it first: this test proves the /AP stream itself draws,
    // exactly as a third-party PDFium-based reader would draw it.
    let mut bytes = std::fs::read(&path).expect("read saved file");
    let tag = b"(ibris:";
    let pos = bytes
        .windows(tag.len())
        .position(|w| w == tag)
        .expect("prefixed /NM not found in saved bytes");
    bytes[pos..pos + tag.len()].copy_from_slice(b"(third:");
    std::fs::write(&path, bytes).expect("write de-tagged file");

    let (doc_id, _) = service.open(path).await.expect("reopen failed");
    let page = service
        .render(doc_id, 0, 1.0, false, 1)
        .await
        .expect("render failed");

    // The rect's top edge runs y=200 (device, top-left origin) from x=200
    // to x=300. Look for distinctly red pixels along it.
    let w = page.width as usize;
    let mut red_hits = 0;
    for x in 200..300 {
        for y in 197..204 {
            let i = (y * w + x) * 4;
            let (r, g, b) = (page.rgba[i], page.rgba[i + 1], page.rgba[i + 2]);
            if r > 150 && g < 120 && b < 120 {
                red_hits += 1;
            }
        }
    }
    assert!(
        red_hits > 50,
        "annotation appearance did not render: {red_hits} red pixels on the top edge"
    );
}
