//! Signature image placement (M4): a PNG data URL round-trips as an
//! editable annotation, actually draws through the appended image object,
//! and degrades to visible-but-read-only when IbrisData is stripped
//! (pixels live only in the /AP — nothing to reconstruct a model from).

use std::path::PathBuf;

use ibris_lib::pdf::annot::{AnnotGeom, AnnotRect, AnnotationData};
use ibris_lib::pdf::save::SaveRequest;
use ibris_lib::pdf::service::PdfService;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures")).join(name)
}

fn temp_copy(name: &str) -> PathBuf {
    let dest = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::copy(fixture("plain-text.pdf"), &dest).expect("fixture copy failed");
    dest
}

fn base64_encode(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// An 8x8 solid red PNG as a data URL.
fn red_png_data_url() -> String {
    let img = image::RgbaImage::from_pixel(8, 8, image::Rgba([220, 30, 30, 255]));
    let mut png: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("png encode failed");
    format!("data:image/png;base64,{}", base64_encode(&png))
}

fn signature(data_url: &str) -> AnnotationData {
    AnnotationData {
        id: "sig-1".into(),
        page_index: 0,
        color: "#000000".into(),
        opacity: 1.0,
        author: "signature-test".into(),
        created_at: 1_753_999_000_000,
        modified_at: 1_753_999_000_000,
        geom: AnnotGeom::Image {
            rect: AnnotRect {
                x: 200.0,
                y: 200.0,
                width: 120.0,
                height: 60.0,
            },
            data_url: data_url.into(),
        },
    }
}

fn red_hits(
    rgba: &[u8],
    width: usize,
    xs: std::ops::Range<usize>,
    ys: std::ops::Range<usize>,
) -> usize {
    let mut hits = 0;
    for y in ys {
        for x in xs.clone() {
            let i = (y * width + x) * 4;
            if rgba[i] > 150 && rgba[i + 1] < 120 && rgba[i + 2] < 120 {
                hits += 1;
            }
        }
    }
    hits
}

fn patch_bytes(path: &PathBuf, from: &[u8], to: &[u8]) -> usize {
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

#[tokio::test]
async fn signature_image_round_trips_and_draws() {
    let path = temp_copy("signature.pdf");
    let data_url = red_png_data_url();
    let service = PdfService::new();
    service
        .save_document(
            path.clone(),
            path.clone(),
            SaveRequest {
                order: vec![0],
                annotations: vec![signature(&data_url)],
                our_ids: vec!["sig-1".into()],
                ..Default::default()
            },
        )
        .await
        .expect("save failed");

    // Reopens fully editable, data URL intact.
    let (doc_id, info) = service.open(path.clone()).await.expect("reopen failed");
    let back = info
        .annotations
        .iter()
        .find(|a| a.id == "sig-1")
        .expect("signature not recovered");
    match &back.geom {
        AnnotGeom::Image { data_url: d, rect } => {
            assert_eq!(d, &data_url, "data URL lost");
            assert!((rect.x - 200.0).abs() < 0.5, "rect moved: {}", rect.x);
        }
        g => panic!("recovered as {g:?}"),
    }

    // Suppressed in the viewing document (overlay owns it): the rect
    // interior (device y 200..260, x 200..320 at scale 1) shows paper.
    let page = service
        .render(doc_id, 0, 1.0, false, 1)
        .await
        .expect("render failed");
    let w = page.width as usize;
    assert_eq!(
        red_hits(&page.rgba, w, 210..310, 210..250),
        0,
        "suppressed signature still renders"
    );

    // Strip IbrisData: the image cannot be reconstructed (pixels live in
    // the /AP), so it must stay in the file, visible and read-only.
    let hits = patch_bytes(&path, b"/IbrisData", b"/XbrisData");
    assert!(hits >= 1, "IbrisData key not found");
    let (doc_id2, info2) = service.open(path.clone()).await.expect("reopen 2 failed");
    assert!(
        !info2.annotations.iter().any(|a| a.id == "sig-1"),
        "unrebuildable image must not be recovered"
    );
    let page2 = service
        .render(doc_id2, 0, 1.0, false, 2)
        .await
        .expect("render 2 failed");
    let drawn = red_hits(&page2.rgba, page2.width as usize, 210..310, 210..250);
    assert!(
        drawn > 500,
        "image appearance did not draw ({drawn} red pixels in the rect)"
    );
}
