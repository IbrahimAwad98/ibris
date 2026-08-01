//! The M3 gate: page structure edits materialise correctly at save, and
//! annotations travel with their pages.

use std::path::PathBuf;

use ibris_lib::pdf::annot::{AnnotGeom, AnnotRect, AnnotationData};
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

/// dark-photo-charts.pdf: 2 pages, 300x200 pt each.
fn temp_copy(name: &str) -> PathBuf {
    let dest = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::copy(fixture("dark-photo-charts.pdf"), &dest).expect("fixture copy failed");
    dest
}

fn rect_annot(id: &str, page_index: u16) -> AnnotationData {
    AnnotationData {
        id: id.into(),
        page_index,
        color: "#e0483c".into(),
        opacity: 1.0,
        author: "m3-test".into(),
        created_at: 1_753_999_000_000,
        modified_at: 1_753_999_000_000,
        geom: AnnotGeom::Rect {
            rect: AnnotRect {
                x: 30.0,
                y: 30.0,
                width: 50.0,
                height: 25.0,
            },
            stroke_width: 2.0,
            fill: None,
        },
    }
}

#[tokio::test]
async fn reordering_moves_annotations_with_their_pages() {
    let path = temp_copy("restructure-reorder.pdf");
    let service = PdfService::new();

    // Annotation on source page 0; pages saved in order [1, 0].
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![1, 0],
            vec![],
            vec![],
            vec![rect_annot("m3-a", 0)],
            vec!["m3-a".into()],
            vec![],
            false,
        )
        .await
        .expect("save failed");

    let (_id, info) = service.open(path.clone()).await.expect("reopen failed");
    assert_eq!(info.page_count, 2);
    let read = service.read_annotations(path).await.expect("read failed");
    let a = read
        .iter()
        .find(|a| a.id == "ibris:m3-a") // /NM ownership prefix, M2-PLAN §8
        .expect("annotation lost");
    // Source page 0 now sits at final position 1 — the annotation moved.
    assert_eq!(a.page_index, 1, "annotation did not move with its page");
}

#[tokio::test]
async fn deleting_a_page_drops_it_and_its_annotations() {
    let path = temp_copy("restructure-delete.pdf");
    let service = PdfService::new();

    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![1],
            vec![], // keep only source page 1
            vec![],
            vec![rect_annot("m3-b", 0)], // annotation on the deleted page
            vec!["m3-b".into()],
            vec![],
            false,
        )
        .await
        .expect("save failed");

    let (_id, info) = service.open(path.clone()).await.expect("reopen failed");
    assert_eq!(info.page_count, 1, "page was not deleted");
    let read = service.read_annotations(path).await.expect("read failed");
    assert!(
        read.iter().all(|a| a.id != "m3-b"),
        "annotation on a deleted page survived"
    );
}

#[tokio::test]
async fn rotation_is_saved_into_the_file() {
    let path = temp_copy("restructure-rotate.pdf");
    let service = PdfService::new();

    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0, 1],
            vec![],
            vec![(0, 90)],
            vec![],
            vec![],
            vec![],
            false,
        )
        .await
        .expect("save failed");

    // A rotated 300x200 page reports 200x300.
    let (_id, info) = service.open(path).await.expect("reopen failed");
    let p0 = &info.pages[0];
    assert!(
        (p0.width - 200.0).abs() < 0.5 && (p0.height - 300.0).abs() < 0.5,
        "page 0 not rotated: {}x{}",
        p0.width,
        p0.height
    );
    let p1 = &info.pages[1];
    assert!(
        (p1.width - 300.0).abs() < 0.5,
        "page 1 should be untouched: {}x{}",
        p1.width,
        p1.height
    );
}

#[tokio::test]
async fn extraction_to_another_file_leaves_the_source_alone() {
    let path = temp_copy("restructure-extract-src.pdf");
    let extracted = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("restructure-extracted.pdf");
    let before = std::fs::read(&path).expect("read source");

    let service = PdfService::new();
    service
        .save_document(
            path.clone(),
            extracted.clone(),
            vec![1],
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
            false,
        )
        .await
        .expect("extract failed");

    assert_eq!(
        before,
        std::fs::read(&path).expect("re-read source"),
        "extraction modified the source file"
    );
    let (_id, info) = service
        .open(extracted)
        .await
        .expect("open extracted failed");
    assert_eq!(info.page_count, 1);
}

#[tokio::test]
async fn merge_concatenates_documents() {
    let a = temp_copy("merge-a.pdf");
    let b = temp_copy("merge-b.pdf");
    let dest = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("merged.pdf");

    let service = PdfService::new();
    service
        .merge_documents(vec![a, b], dest.clone())
        .await
        .expect("merge failed");

    let (_id, info) = service.open(dest).await.expect("open merged failed");
    assert_eq!(info.page_count, 4);
}

#[tokio::test]
async fn inserted_pages_from_another_file_materialise_at_save() {
    let path = temp_copy("restructure-insert.pdf"); // 2 pages, 300x200
    let service = PdfService::new();

    // Insert plain-text.pdf (612x792) page 0 between our two pages:
    // order [0, -1, 1] where -1 references inserts[0]. The annotation on
    // own source page 1 must land on final page 2.
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0, -1, 1],
            vec![ibris_lib::pdf::save::InsertSource {
                path: fixture("plain-text.pdf"),
                page_index: 0,
            }],
            vec![],
            vec![rect_annot("m3-i", 1)],
            vec!["m3-i".into()],
            vec![],
            false,
        )
        .await
        .expect("insert save failed");

    let (_id, info) = service.open(path.clone()).await.expect("reopen failed");
    assert_eq!(info.page_count, 3, "inserted page missing");
    let sizes: Vec<(f32, f32)> = info.pages.iter().map(|p| (p.width, p.height)).collect();
    assert!(
        (sizes[1].0 - 612.0).abs() < 0.5 && (sizes[1].1 - 792.0).abs() < 0.5,
        "final page 1 is not the inserted letter page: {sizes:?}"
    );
    assert!(
        (sizes[0].0 - 300.0).abs() < 0.5 && (sizes[2].0 - 300.0).abs() < 0.5,
        "own pages moved: {sizes:?}"
    );

    let read = service.read_annotations(path).await.expect("read failed");
    let a = read
        .iter()
        .find(|a| a.id == "ibris:m3-i")
        .expect("annotation lost across insert");
    assert_eq!(a.page_index, 2, "annotation did not follow its page");
}
