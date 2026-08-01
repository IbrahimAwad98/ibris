//! The M4 gate: AcroForm structure reads correctly, values fill through
//! the form-fill pipeline (appearances regenerate — verified by pixels,
//! not just /V), and flatten bakes everything into page content.

use std::path::PathBuf;

use ibris_lib::pdf::form::FieldWrite;
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

fn temp_copy(name: &str) -> PathBuf {
    let dest = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::copy(fixture("acroform.pdf"), &dest).expect("fixture copy failed");
    dest
}

fn fills() -> Vec<FieldWrite> {
    vec![
        FieldWrite::Text {
            name: "name".into(),
            value: "Ibrahim".into(),
        },
        FieldWrite::Checkbox {
            name: "subscribe".into(),
            checked: true,
        },
        FieldWrite::Radio {
            name: "color".into(),
            kid: 1,
        },
        FieldWrite::Choice {
            name: "country".into(),
            indices: vec![2],
        },
        FieldWrite::Choice {
            name: "picks".into(),
            indices: vec![1],
        },
    ]
}

async fn save_fills(service: &PdfService, path: &PathBuf, flatten: bool) {
    service
        .save_document(
            path.clone(),
            path.clone(),
            vec![0],
            vec![],
            vec![],
            vec![],
            vec![],
            fills(),
            flatten,
        )
        .await
        .expect("form save failed");
}

/// Ink coverage in a device-pixel region at scale 1 (non-white pixels).
fn dark_pixels(
    rgba: &[u8],
    width: usize,
    xs: std::ops::Range<usize>,
    ys: std::ops::Range<usize>,
) -> usize {
    let mut hits = 0;
    for y in ys {
        for x in xs.clone() {
            let i = (y * width + x) * 4;
            if rgba[i] < 200 && rgba[i + 1] < 200 && rgba[i + 2] < 200 {
                hits += 1;
            }
        }
    }
    hits
}

#[tokio::test]
async fn form_structure_reads_correctly() {
    let path = temp_copy("forms-read.pdf");
    let service = PdfService::new();
    let (_id, info) = service.open(path).await.expect("open failed");

    assert_eq!(info.form.form_type, "acroform");
    let by = |name: &str, kid: u16| {
        info.form
            .fields
            .iter()
            .find(|f| f.name == name && f.kid == kid)
            .unwrap_or_else(|| panic!("field {name}/{kid} missing"))
    };

    let text = by("name", 0);
    assert_eq!(text.kind, "text");
    assert_eq!(text.page_index, 0);
    assert!(!text.read_only);
    // Rect [72 700 372 724] on a 792pt page → top-left y = 68.
    assert!((text.rect.x - 72.0).abs() < 0.5, "text x: {}", text.rect.x);
    assert!((text.rect.y - 68.0).abs() < 0.5, "text y: {}", text.rect.y);

    assert_eq!(by("subscribe", 0).kind, "checkbox");
    assert!(!by("subscribe", 0).checked);

    // The radio group appears as two kid widgets.
    assert_eq!(by("color", 0).kind, "radio");
    assert_eq!(by("color", 1).kind, "radio");

    let combo = by("country", 0);
    assert_eq!(combo.kind, "combo");
    assert_eq!(combo.value, "US");
    assert_eq!(combo.options, vec!["US", "DE", "EG"]);

    let list = by("picks", 0);
    assert_eq!(list.kind, "list");
    assert_eq!(list.options, vec!["Alpha", "Beta", "Gamma"]);
}

#[tokio::test]
async fn filled_values_persist_and_render() {
    let path = temp_copy("forms-fill.pdf");
    let service = PdfService::new();

    // Baseline render: the text field interior is empty paper.
    let (before_id, _) = service.open(path.clone()).await.expect("open failed");
    let before = service
        .render(before_id, 0, 1.0, false, 1)
        .await
        .expect("render failed");
    // Field rect [72 700 372 724] → device y 68..92; interior sample.
    let w = before.width as usize;
    let baseline = dark_pixels(&before.rgba, w, 80..360, 72..88);

    save_fills(&service, &path, false).await;

    let (id, info) = service.open(path.clone()).await.expect("reopen failed");
    let by = |name: &str, kid: u16| {
        info.form
            .fields
            .iter()
            .find(|f| f.name == name && f.kid == kid)
            .unwrap_or_else(|| panic!("field {name}/{kid} missing"))
    };
    assert_eq!(by("name", 0).value, "Ibrahim", "text value lost");
    assert!(by("subscribe", 0).checked, "checkbox not checked");
    assert!(!by("color", 0).checked, "wrong radio selected");
    assert!(by("color", 1).checked, "radio kid 1 not selected");
    assert_eq!(by("country", 0).value, "EG", "combo value lost");
    assert_eq!(by("picks", 0).value, "Beta", "list value lost");

    // The appearance must have regenerated: the field interior now has
    // glyph pixels a /V-only write would not produce.
    let after = service
        .render(id, 0, 1.0, false, 2)
        .await
        .expect("render failed");
    let filled = dark_pixels(&after.rgba, after.width as usize, 80..360, 72..88);
    assert!(
        filled > baseline + 30,
        "text appearance did not regenerate: {baseline} dark pixels before, {filled} after"
    );
}

#[tokio::test]
async fn flatten_bakes_fields_into_content() {
    let path = temp_copy("forms-flatten.pdf");
    let service = PdfService::new();
    save_fills(&service, &path, true).await;

    let (id, info) = service.open(path.clone()).await.expect("reopen failed");
    assert!(
        info.form.fields.is_empty(),
        "flatten left interactive fields behind: {:?}",
        info.form.fields.len()
    );

    // The filled text must still be visible as plain page content.
    let page = service
        .render(id, 0, 1.0, false, 3)
        .await
        .expect("render failed");
    let filled = dark_pixels(&page.rgba, page.width as usize, 80..360, 72..88);
    assert!(
        filled > 30,
        "flattened text vanished: {filled} dark pixels in the field area"
    );

    // And the annotations are gone from every page.
    let read = service.read_annotations(path).await.expect("read failed");
    assert!(read.is_empty(), "flatten left annotations: {}", read.len());
}
