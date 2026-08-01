//! Annotation writing and reading, raw PDFium FFI.
//!
//! pdfium-render's safe wrappers cannot create line/circle annotations and
//! expose no /NM, /CA, or /AP setters, so this module uses the raw
//! bindings trait directly. Every call still happens on the engine thread
//! (decision 008) — raw FFI does not change the threading contract.
//!
//! Geometry crossing IPC is in page points relative to the visible box,
//! top-left origin (decision 009); conversion to PDF space happens here.
//!
//! Interop cornerstone: every annotation gets an explicit /AP appearance
//! stream, because PDFium-based and Preview-style readers render /AP
//! rather than regenerating appearances the way Acrobat does.

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use super::error::PdfError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AnnotRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AnnotPoint {
    pub x: f32,
    pub y: f32,
}

/// Wire model, mirroring the frontend `Annotation` union.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationData {
    pub id: String,
    pub page_index: u16,
    /// "#rrggbb"
    pub color: String,
    /// 0..1
    pub opacity: f32,
    pub author: String,
    /// Epoch milliseconds.
    pub created_at: i64,
    pub modified_at: i64,
    #[serde(flatten)]
    pub geom: AnnotGeom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AnnotGeom {
    Highlight {
        quads: Vec<AnnotRect>,
    },
    Underline {
        quads: Vec<AnnotRect>,
    },
    Strikeout {
        quads: Vec<AnnotRect>,
    },
    Ink {
        strokes: Vec<Vec<AnnotPoint>>,
        #[serde(rename = "strokeWidth")]
        stroke_width: f32,
    },
    Note {
        at: AnnotPoint,
        contents: String,
    },
    Rect {
        rect: AnnotRect,
        #[serde(rename = "strokeWidth")]
        stroke_width: f32,
        fill: Option<String>,
    },
    Ellipse {
        rect: AnnotRect,
        #[serde(rename = "strokeWidth")]
        stroke_width: f32,
        fill: Option<String>,
    },
    Line {
        from: AnnotPoint,
        to: AnnotPoint,
        #[serde(rename = "strokeWidth")]
        stroke_width: f32,
    },
    Arrow {
        from: AnnotPoint,
        to: AnnotPoint,
        #[serde(rename = "strokeWidth")]
        stroke_width: f32,
    },
    Stamp {
        rect: AnnotRect,
        stamp: String,
    },
    /// A placed signature image (M4). Graphical placement only — this is
    /// NOT cryptographic signing and implies no legal validity.
    Image {
        rect: AnnotRect,
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
}

/// Every annotation we write carries `/NM = "ibris:<uuid>"`. The prefix is
/// the ownership marker on reopen: it survives any tool that preserves
/// annotation identity, and cannot false-positive on foreign annotations
/// the way "looks like a UUID" can (Acrobat also writes GUID-shaped /NM).
pub const NM_PREFIX: &str = "ibris:";

/// Private annotation-dictionary key holding the full wire-model JSON.
/// Fidelity upgrade only — reopen falls back to reconstructing from the
/// standard keys when other software drops it (M2-PLAN §8).
const IBRIS_DATA_KEY: &str = "IbrisData";

// PDFium annotation subtype constants (fpdf_annot.h; stable public API).
const SUBTYPE_TEXT: i32 = 1;
const SUBTYPE_SQUARE: i32 = 5;
const SUBTYPE_CIRCLE: i32 = 6;
const SUBTYPE_HIGHLIGHT: i32 = 9;
const SUBTYPE_UNDERLINE: i32 = 10;
const SUBTYPE_STRIKEOUT: i32 = 12;
const SUBTYPE_STAMP: i32 = 13;
const SUBTYPE_INK: i32 = 15;

const COLORTYPE_COLOR: u32 = 0;
const COLORTYPE_INTERIOR: u32 = 1;
/// FPDF_ANNOT_APPEARANCEMODE_NORMAL
const APPEARANCE_NORMAL: i32 = 0;

fn subtype_of(geom: &AnnotGeom) -> i32 {
    match geom {
        AnnotGeom::Highlight { .. } => SUBTYPE_HIGHLIGHT,
        AnnotGeom::Underline { .. } => SUBTYPE_UNDERLINE,
        AnnotGeom::Strikeout { .. } => SUBTYPE_STRIKEOUT,
        AnnotGeom::Ink { .. } => SUBTYPE_INK,
        AnnotGeom::Note { .. } => SUBTYPE_TEXT,
        AnnotGeom::Rect { .. } => SUBTYPE_SQUARE,
        AnnotGeom::Ellipse { .. } => SUBTYPE_CIRCLE,
        // PDFium's FPDFPage_CreateAnnot whitelist has no /Line; lines and
        // arrows are written as /Ink strokes instead (drawn by our /AP, so
        // they render identically — readers just classify them as pencil).
        AnnotGeom::Line { .. } | AnnotGeom::Arrow { .. } => SUBTYPE_INK,
        AnnotGeom::Stamp { .. } | AnnotGeom::Image { .. } => SUBTYPE_STAMP,
    }
}

/// /Name marker distinguishing an image stamp from our glyph stamps. An
/// image stamp whose IbrisData was stripped cannot be reconstructed from
/// standard keys (the pixels live in the /AP), so recovery leaves it in
/// the viewing document — visible, read-only.
const IMAGE_STAMP_NAME: &str = "ibris-image";

/// Parses "#rrggbb" into channels; fails on anything else.
pub fn parse_color(color: &str) -> Result<(u8, u8, u8), PdfError> {
    let hex = color.strip_prefix('#').unwrap_or(color);
    if hex.len() != 6 {
        return Err(PdfError::Internal {
            detail: format!("bad colour {color:?}"),
        });
    }
    let channel = |i: usize| {
        u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| PdfError::Internal {
            detail: format!("bad colour {color:?}"),
        })
    };
    Ok((channel(0)?, channel(2)?, channel(4)?))
}

/// Epoch ms → PDF date string "D:YYYYMMDDHHMMSSZ".
fn pdf_date(epoch_ms: i64) -> String {
    let dt = chrono::DateTime::from_timestamp_millis(epoch_ms).unwrap_or_else(chrono::Utc::now);
    dt.format("D:%Y%m%d%H%M%SZ").to_string()
}

/// Origin of the page's visible box (crop, falling back to media) via raw
/// FFI, mirroring `text::visible_box_origin` for safe pages.
fn raw_visible_box_origin(b: &dyn PdfiumLibraryBindings, page: FPDF_PAGE) -> (f32, f32) {
    let (mut l, mut bo, mut r, mut t) = (0f32, 0f32, 0f32, 0f32);
    unsafe {
        if b.FPDFPage_GetCropBox(page, &mut l, &mut bo, &mut r, &mut t) != 0
            || b.FPDFPage_GetMediaBox(page, &mut l, &mut bo, &mut r, &mut t) != 0
        {
            (l, t)
        } else {
            (0.0, b.FPDF_GetPageHeightF(page))
        }
    }
}

struct PageSpace {
    box_left: f32,
    box_top: f32,
}

impl PageSpace {
    fn point(&self, p: AnnotPoint) -> (f32, f32) {
        (self.box_left + p.x, self.box_top - p.y)
    }
    /// Top-left rect → PDF-space FS_RECTF (left, top, right, bottom).
    fn rect(&self, r: AnnotRect) -> FS_RECTF {
        FS_RECTF {
            left: self.box_left + r.x,
            top: self.box_top - r.y,
            right: self.box_left + r.x + r.width,
            bottom: self.box_top - r.y - r.height,
        }
    }
}

fn union(rects: impl Iterator<Item = FS_RECTF>) -> FS_RECTF {
    let mut out = FS_RECTF {
        left: f32::MAX,
        top: f32::MIN,
        right: f32::MIN,
        bottom: f32::MAX,
    };
    for r in rects {
        out.left = out.left.min(r.left);
        out.right = out.right.max(r.right);
        out.top = out.top.max(r.top);
        out.bottom = out.bottom.min(r.bottom);
    }
    out
}

fn inflate(r: FS_RECTF, by: f32) -> FS_RECTF {
    FS_RECTF {
        left: r.left - by,
        top: r.top + by,
        right: r.right + by,
        bottom: r.bottom - by,
    }
}

/// The annotation's /Rect in PDF space.
fn pdf_rect(space: &PageSpace, a: &AnnotationData) -> FS_RECTF {
    match &a.geom {
        AnnotGeom::Highlight { quads }
        | AnnotGeom::Underline { quads }
        | AnnotGeom::Strikeout { quads } => union(quads.iter().map(|q| space.rect(*q))),
        AnnotGeom::Ink {
            strokes,
            stroke_width,
        } => inflate(
            union(strokes.iter().flatten().map(|p| {
                let (x, y) = space.point(*p);
                FS_RECTF {
                    left: x,
                    top: y,
                    right: x,
                    bottom: y,
                }
            })),
            stroke_width.max(1.0),
        ),
        AnnotGeom::Note { at, .. } => {
            let (x, y) = space.point(*at);
            FS_RECTF {
                left: x,
                top: y,
                right: x + 20.0,
                bottom: y - 20.0,
            }
        }
        AnnotGeom::Rect {
            rect, stroke_width, ..
        }
        | AnnotGeom::Ellipse {
            rect, stroke_width, ..
        } => inflate(space.rect(*rect), stroke_width.max(1.0)),
        AnnotGeom::Line {
            from,
            to,
            stroke_width,
        }
        | AnnotGeom::Arrow {
            from,
            to,
            stroke_width,
        } => {
            let (x1, y1) = space.point(*from);
            let (x2, y2) = space.point(*to);
            inflate(
                FS_RECTF {
                    left: x1.min(x2),
                    top: y1.max(y2),
                    right: x1.max(x2),
                    bottom: y1.min(y2),
                },
                stroke_width.max(1.0) + 8.0, // room for the arrow head
            )
        }
        AnnotGeom::Stamp { rect, .. } | AnnotGeom::Image { rect, .. } => space.rect(*rect),
    }
}

fn fmt(v: f32) -> String {
    format!("{v:.2}")
}

/// Appearance-stream content for one annotation, in PDF page coordinates
/// (the AP form's BBox is the /Rect; PDFium applies no extra matrix).
fn appearance_stream(space: &PageSpace, a: &AnnotationData) -> Result<String, PdfError> {
    let (r, g, b) = parse_color(&a.color)?;
    let (cr, cg, cb) = (
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    );
    let stroke = format!("{} {} {} RG", fmt(cr), fmt(cg), fmt(cb));
    let fill = format!("{} {} {} rg", fmt(cr), fmt(cg), fmt(cb));
    let mut s = String::new();

    match &a.geom {
        AnnotGeom::Highlight { quads } => {
            s.push_str(&format!("{fill}\n"));
            for q in quads {
                let rc = space.rect(*q);
                s.push_str(&format!(
                    "{} {} {} {} re f\n",
                    fmt(rc.left),
                    fmt(rc.bottom),
                    fmt(rc.right - rc.left),
                    fmt(rc.top - rc.bottom)
                ));
            }
        }
        AnnotGeom::Underline { quads } | AnnotGeom::Strikeout { quads } => {
            let strike = matches!(a.geom, AnnotGeom::Strikeout { .. });
            s.push_str(&format!("{stroke}\n"));
            for q in quads {
                let rc = space.rect(*q);
                let h = rc.top - rc.bottom;
                let y = if strike {
                    rc.bottom + h * 0.45
                } else {
                    rc.bottom + h * 0.08
                };
                let w = (h * 0.07).max(0.7);
                s.push_str(&format!(
                    "{} w {} {} m {} {} l S\n",
                    fmt(w),
                    fmt(rc.left),
                    fmt(y),
                    fmt(rc.right),
                    fmt(y)
                ));
            }
        }
        AnnotGeom::Ink {
            strokes,
            stroke_width,
        } => {
            s.push_str(&format!("{stroke} {} w 1 J 1 j\n", fmt(*stroke_width)));
            for st in strokes {
                for (i, p) in st.iter().enumerate() {
                    let (x, y) = space.point(*p);
                    s.push_str(&format!(
                        "{} {} {}\n",
                        fmt(x),
                        fmt(y),
                        if i == 0 { "m" } else { "l" }
                    ));
                }
                s.push_str("S\n");
            }
        }
        AnnotGeom::Note { at, .. } => {
            let (x, y) = space.point(*at);
            // Note icon: filled speech-bubble-ish rounded box with a fold.
            s.push_str(&format!(
                "{fill} {stroke} 1 w\n{} {} 18 16 re B\n{} {} m {} {} l S\n",
                fmt(x + 1.0),
                fmt(y - 17.0),
                fmt(x + 5.0),
                fmt(y - 17.0),
                fmt(x + 9.0),
                fmt(y - 21.0)
            ));
        }
        AnnotGeom::Rect {
            rect,
            stroke_width,
            fill: fill_col,
        } => {
            let rc = space.rect(*rect);
            if let Some(fc) = fill_col {
                let (fr, fg, fb) = parse_color(fc)?;
                s.push_str(&format!(
                    "{} {} {} rg\n",
                    fmt(f32::from(fr) / 255.0),
                    fmt(f32::from(fg) / 255.0),
                    fmt(f32::from(fb) / 255.0)
                ));
            }
            s.push_str(&format!(
                "{stroke} {} w {} {} {} {} re {}\n",
                fmt(*stroke_width),
                fmt(rc.left),
                fmt(rc.bottom),
                fmt(rc.right - rc.left),
                fmt(rc.top - rc.bottom),
                if fill_col.is_some() { "B" } else { "S" }
            ));
        }
        AnnotGeom::Ellipse {
            rect,
            stroke_width,
            fill: fill_col,
        } => {
            let rc = space.rect(*rect);
            let (cx, cy) = ((rc.left + rc.right) / 2.0, (rc.top + rc.bottom) / 2.0);
            let (rx, ry) = ((rc.right - rc.left) / 2.0, (rc.top - rc.bottom) / 2.0);
            const K: f32 = 0.552_285;
            if let Some(fc) = fill_col {
                let (fr, fg, fb) = parse_color(fc)?;
                s.push_str(&format!(
                    "{} {} {} rg\n",
                    fmt(f32::from(fr) / 255.0),
                    fmt(f32::from(fg) / 255.0),
                    fmt(f32::from(fb) / 255.0)
                ));
            }
            s.push_str(&format!("{stroke} {} w\n", fmt(*stroke_width)));
            s.push_str(&format!("{} {} m\n", fmt(cx + rx), fmt(cy)));
            // Four quarter arcs, standard cubic-Bezier circle approximation.
            let arcs = [
                (cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry),
                (cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy),
                (cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry),
                (cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy),
            ];
            for (c1x, c1y, c2x, c2y, x1, y1) in arcs {
                s.push_str(&format!(
                    "{} {} {} {} {} {} c\n",
                    fmt(c1x),
                    fmt(c1y),
                    fmt(c2x),
                    fmt(c2y),
                    fmt(x1),
                    fmt(y1)
                ));
            }
            s.push_str(if fill_col.is_some() { "B\n" } else { "S\n" });
        }
        AnnotGeom::Line {
            from,
            to,
            stroke_width,
        } => {
            let (x1, y1) = space.point(*from);
            let (x2, y2) = space.point(*to);
            s.push_str(&format!(
                "{stroke} {} w 1 J {} {} m {} {} l S\n",
                fmt(*stroke_width),
                fmt(x1),
                fmt(y1),
                fmt(x2),
                fmt(y2)
            ));
        }
        AnnotGeom::Arrow {
            from,
            to,
            stroke_width,
        } => {
            let (x1, y1) = space.point(*from);
            let (x2, y2) = space.point(*to);
            let (dx, dy) = (x2 - x1, y2 - y1);
            let len = (dx * dx + dy * dy).sqrt().max(0.01);
            let (ux, uy) = (dx / len, dy / len);
            let head = (stroke_width * 4.0).max(8.0);
            // Two head strokes at ±30° off the shaft direction.
            let (hx1, hy1) = (
                x2 - head * (ux * 0.866 - uy * 0.5),
                y2 - head * (uy * 0.866 + ux * 0.5),
            );
            let (hx2, hy2) = (
                x2 - head * (ux * 0.866 + uy * 0.5),
                y2 - head * (uy * 0.866 - ux * 0.5),
            );
            s.push_str(&format!(
                "{stroke} {} w 1 J 1 j {} {} m {} {} l S {} {} m {} {} l {} {} l S\n",
                fmt(*stroke_width),
                fmt(x1),
                fmt(y1),
                fmt(x2),
                fmt(y2),
                fmt(hx1),
                fmt(hy1),
                fmt(x2),
                fmt(y2),
                fmt(hx2),
                fmt(hy2)
            ));
        }
        AnnotGeom::Image { .. } => {
            // Image stamps get their appearance from an appended image
            // object (fill_annot), not a drawn content stream.
        }
        AnnotGeom::Stamp { rect, stamp } => {
            let rc = space.rect(*rect);
            let (w, h) = (rc.right - rc.left, rc.top - rc.bottom);
            s.push_str(&format!("{stroke} 2 w\n"));
            s.push_str(&format!(
                "{} {} {} {} re S\n",
                fmt(rc.left + 1.0),
                fmt(rc.bottom + 1.0),
                fmt(w - 2.0),
                fmt(h - 2.0)
            ));
            // A path-drawn glyph per stamp kind (no fonts in AP streams).
            let (cx, cy) = ((rc.left + rc.right) / 2.0, (rc.top + rc.bottom) / 2.0);
            let u = (w.min(h) / 2.0 - 6.0).max(4.0);
            match stamp.as_str() {
                "approved" => s.push_str(&format!(
                    "3 w 1 J 1 j {} {} m {} {} l {} {} l S\n",
                    fmt(cx - u),
                    fmt(cy),
                    fmt(cx - u * 0.2),
                    fmt(cy - u * 0.6),
                    fmt(cx + u),
                    fmt(cy + u * 0.6)
                )),
                "rejected" => s.push_str(&format!(
                    "3 w 1 J {} {} m {} {} l S {} {} m {} {} l S\n",
                    fmt(cx - u),
                    fmt(cy - u),
                    fmt(cx + u),
                    fmt(cy + u),
                    fmt(cx - u),
                    fmt(cy + u),
                    fmt(cx + u),
                    fmt(cy - u)
                )),
                "draft" => s.push_str(&format!(
                    "3 w {} {} m {} {} l S\n",
                    fmt(cx - u),
                    fmt(cy),
                    fmt(cx + u),
                    fmt(cy)
                )),
                _ => s.push_str(&format!(
                    "3 w {} {} {} {} re S\n",
                    fmt(cx - u),
                    fmt(cy - u * 0.4),
                    fmt(u * 2.0),
                    fmt(u * 0.8)
                )),
            }
        }
    }
    Ok(s)
}

/// Deletes every annotation on `page` whose /NM is in `ids`, then returns.
/// Descending index order so removal does not shift what is left to scan.
/// Matches both prefixed (`ibris:<id>`) and bare `<id>` /NM values — files
/// saved before the prefix existed carry the bare form.
unsafe fn delete_ours(b: &dyn PdfiumLibraryBindings, page: FPDF_PAGE, ids: &[String]) {
    let count = b.FPDFPage_GetAnnotCount(page);
    for i in (0..count).rev() {
        let annot = b.FPDFPage_GetAnnot(page, i);
        if annot.is_null() {
            continue;
        }
        let nm = get_string_value(b, annot, "NM");
        b.FPDFPage_CloseAnnot(annot);
        let bare = nm.strip_prefix(NM_PREFIX).unwrap_or(&nm);
        if ids.iter().any(|id| id == bare) {
            b.FPDFPage_RemoveAnnot(page, i);
        }
    }
}

/// Reads the /AP normal-appearance content stream as text.
unsafe fn get_appearance(b: &dyn PdfiumLibraryBindings, annot: FPDF_ANNOTATION) -> String {
    let len = b.FPDFAnnot_GetAP(annot, APPEARANCE_NORMAL, std::ptr::null_mut(), 0);
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) / 2];
    b.FPDFAnnot_GetAP(annot, APPEARANCE_NORMAL, buf.as_mut_ptr(), len);
    String::from_utf16_lossy(&buf[..buf.len().saturating_sub(1)])
}

/// Reads a UTF-16LE string value from an annotation dictionary key.
unsafe fn get_string_value(
    b: &dyn PdfiumLibraryBindings,
    annot: FPDF_ANNOTATION,
    key: &str,
) -> String {
    let len = b.FPDFAnnot_GetStringValue(annot, key, std::ptr::null_mut(), 0);
    if len <= 2 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) / 2];
    b.FPDFAnnot_GetStringValue(annot, key, buf.as_mut_ptr(), len);
    // Drop the trailing NUL.
    String::from_utf16_lossy(&buf[..buf.len().saturating_sub(1)])
}

/// Writes `annots` (all pages) onto `doc`, first deleting any annotation
/// carrying one of `our_ids` — which makes repeated saves idempotent.
///
/// Fails on unknown pages, bad colours, or PDFium refusing an operation.
///
/// # Safety
/// `doc` must be a live document handle from the same PDFium instance as
/// `b`, and the caller must be on the engine thread (decision 008).
pub unsafe fn write_annotations(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    annots: &[AnnotationData],
    our_ids: &[String],
) -> Result<(), PdfError> {
    let page_count = unsafe { b.FPDF_GetPageCount(doc) };
    let mut by_page: std::collections::BTreeMap<u16, Vec<&AnnotationData>> =
        std::collections::BTreeMap::new();
    for a in annots {
        if i32::from(a.page_index) >= page_count {
            return Err(PdfError::Internal {
                detail: format!("annotation {} targets missing page {}", a.id, a.page_index),
            });
        }
        by_page.entry(a.page_index).or_default().push(a);
    }

    // Pages that only need deletions (an annotation moved off or removed).
    let all_pages: std::collections::BTreeSet<u16> = (0..page_count as u16).collect();

    for page_index in all_pages {
        let wanted = by_page.get(&page_index);
        unsafe {
            let page = b.FPDF_LoadPage(doc, i32::from(page_index));
            if page.is_null() {
                return Err(PdfError::Internal {
                    detail: format!("failed to load page {page_index} for annotation"),
                });
            }
            let result = write_page(b, doc, page, wanted.map_or(&[][..], |v| &v[..]), our_ids);
            b.FPDF_ClosePage(page);
            result?;
        }
    }
    Ok(())
}

unsafe fn write_page(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    page: FPDF_PAGE,
    annots: &[&AnnotationData],
    our_ids: &[String],
) -> Result<(), PdfError> {
    delete_ours(b, page, our_ids);
    let (box_left, box_top) = raw_visible_box_origin(b, page);
    let space = PageSpace { box_left, box_top };

    for a in annots {
        let annot = b.FPDFPage_CreateAnnot(page, subtype_of(&a.geom));
        if annot.is_null() {
            return Err(PdfError::Internal {
                detail: format!("PDFium refused to create annotation {}", a.id),
            });
        }
        let result = fill_annot(b, doc, annot, &space, a);
        b.FPDFPage_CloseAnnot(annot);
        result?;
    }
    Ok(())
}

unsafe fn fill_annot(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    annot: FPDF_ANNOTATION,
    space: &PageSpace,
    a: &AnnotationData,
) -> Result<(), PdfError> {
    let rect = pdf_rect(space, a);
    b.FPDFAnnot_SetRect(annot, &rect);

    let (r, g, cb) = parse_color(&a.color)?;
    let alpha = (a.opacity.clamp(0.0, 1.0) * 255.0).round() as u32;
    b.FPDFAnnot_SetColor(
        annot,
        COLORTYPE_COLOR,
        u32::from(r),
        u32::from(g),
        u32::from(cb),
        alpha,
    );

    match &a.geom {
        AnnotGeom::Highlight { quads }
        | AnnotGeom::Underline { quads }
        | AnnotGeom::Strikeout { quads } => {
            for q in quads {
                let rc = space.rect(*q);
                let qp = FS_QUADPOINTSF {
                    x1: rc.left,
                    y1: rc.top,
                    x2: rc.right,
                    y2: rc.top,
                    x3: rc.left,
                    y3: rc.bottom,
                    x4: rc.right,
                    y4: rc.bottom,
                };
                b.FPDFAnnot_AppendAttachmentPoints(annot, &qp);
            }
        }
        AnnotGeom::Ink {
            strokes,
            stroke_width,
        } => {
            b.FPDFAnnot_SetBorder(annot, 0.0, 0.0, *stroke_width);
            for st in strokes {
                let pts: Vec<FS_POINTF> = st
                    .iter()
                    .map(|p| {
                        let (x, y) = space.point(*p);
                        FS_POINTF { x, y }
                    })
                    .collect();
                b.FPDFAnnot_AddInkStroke(annot, pts.as_ptr(), pts.len());
            }
        }
        AnnotGeom::Note { contents, .. } => {
            b.FPDFAnnot_SetStringValue_str(annot, "Contents", contents);
            b.FPDFAnnot_SetStringValue_str(annot, "Name", "Comment");
        }
        AnnotGeom::Rect {
            stroke_width, fill, ..
        }
        | AnnotGeom::Ellipse {
            stroke_width, fill, ..
        } => {
            b.FPDFAnnot_SetBorder(annot, 0.0, 0.0, *stroke_width);
            if let Some(fc) = fill {
                let (fr, fg, fb) = parse_color(fc)?;
                b.FPDFAnnot_SetColor(
                    annot,
                    COLORTYPE_INTERIOR,
                    u32::from(fr),
                    u32::from(fg),
                    u32::from(fb),
                    alpha,
                );
            }
        }
        AnnotGeom::Line {
            from,
            to,
            stroke_width,
        } => {
            b.FPDFAnnot_SetBorder(annot, 0.0, 0.0, *stroke_width);
            let (x1, y1) = space.point(*from);
            let (x2, y2) = space.point(*to);
            let pts = [FS_POINTF { x: x1, y: y1 }, FS_POINTF { x: x2, y: y2 }];
            b.FPDFAnnot_AddInkStroke(annot, pts.as_ptr(), pts.len());
        }
        AnnotGeom::Arrow {
            from,
            to,
            stroke_width,
        } => {
            b.FPDFAnnot_SetBorder(annot, 0.0, 0.0, *stroke_width);
            let (x1, y1) = space.point(*from);
            let (x2, y2) = space.point(*to);
            let pts = [FS_POINTF { x: x1, y: y1 }, FS_POINTF { x: x2, y: y2 }];
            b.FPDFAnnot_AddInkStroke(annot, pts.as_ptr(), pts.len());
        }
        AnnotGeom::Stamp { stamp, .. } => {
            b.FPDFAnnot_SetStringValue_str(annot, "Name", stamp);
        }
        AnnotGeom::Image { .. } => {
            b.FPDFAnnot_SetStringValue_str(annot, "Name", IMAGE_STAMP_NAME);
        }
    }

    b.FPDFAnnot_SetStringValue_str(annot, "NM", &format!("{NM_PREFIX}{}", a.id));
    b.FPDFAnnot_SetStringValue_str(annot, "T", &a.author);
    b.FPDFAnnot_SetStringValue_str(annot, "M", &pdf_date(a.modified_at));
    b.FPDFAnnot_SetStringValue_str(annot, "CreationDate", &pdf_date(a.created_at));
    // Full wire-model JSON for lossless reopen; reconstruction from the
    // standard keys above covers files where a tool strips this key.
    let json = serde_json::to_string(a).map_err(|e| PdfError::Internal {
        detail: format!("serialising {}: {e}", a.id),
    })?;
    b.FPDFAnnot_SetStringValue_str(annot, IBRIS_DATA_KEY, &json);

    if let AnnotGeom::Image { rect, data_url } = &a.geom {
        // The appearance is an appended image object; PDFium builds the
        // /AP form for us. Never also SetAP - it would replace it.
        append_image_object(b, doc, annot, space.rect(*rect), data_url)?;
        return Ok(());
    }
    let ap = appearance_stream(space, a)?;
    if b.FPDFAnnot_SetAP_str(annot, APPEARANCE_NORMAL, &ap) == 0 {
        return Err(PdfError::Internal {
            detail: format!("failed to set appearance stream for {}", a.id),
        });
    }
    Ok(())
}

/// Decodes a `data:image/png;base64,` URL and appends the pixels to the
/// annotation as an image object scaled into `rect`. Fails on malformed
/// data URLs, non-PNG payloads, or PDFium refusing the object.
unsafe fn append_image_object(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    annot: FPDF_ANNOTATION,
    rect: FS_RECTF,
    data_url: &str,
) -> Result<(), PdfError> {
    let b64 = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| PdfError::Internal {
            detail: "signature image is not a PNG data URL".into(),
        })?;
    let png = base64_decode(b64).ok_or_else(|| PdfError::Internal {
        detail: "signature image base64 is malformed".into(),
    })?;
    let rgba = image::load_from_memory(&png)
        .map_err(|e| PdfError::Internal {
            detail: format!("signature image failed to decode: {e}"),
        })?
        .to_rgba8();
    let (w, h) = (rgba.width() as i32, rgba.height() as i32);

    let bitmap = unsafe { b.FPDFBitmap_Create(w, h, 1) };
    if bitmap.is_null() {
        return Err(PdfError::Internal {
            detail: "FPDFBitmap_Create failed".into(),
        });
    }
    let result = (|| unsafe {
        let buf = b.FPDFBitmap_GetBuffer(bitmap).cast::<u8>();
        if buf.is_null() {
            return Err(PdfError::Internal {
                detail: "FPDFBitmap_GetBuffer failed".into(),
            });
        }
        let stride = b.FPDFBitmap_GetStride(bitmap) as usize;
        // RGBA rows -> BGRA rows (PDFium bitmap format when alpha = 1).
        let src = rgba.as_raw();
        for y in 0..h as usize {
            let row = &src[y * (w as usize) * 4..][..(w as usize) * 4];
            let out = buf.add(y * stride);
            for x in 0..w as usize {
                *out.add(x * 4) = row[x * 4 + 2];
                *out.add(x * 4 + 1) = row[x * 4 + 1];
                *out.add(x * 4 + 2) = row[x * 4];
                *out.add(x * 4 + 3) = row[x * 4 + 3];
            }
        }

        let obj = b.FPDFPageObj_NewImageObj(doc);
        if obj.is_null() {
            return Err(PdfError::Internal {
                detail: "FPDFPageObj_NewImageObj failed".into(),
            });
        }
        if b.FPDFImageObj_SetBitmap(std::ptr::null_mut(), 0, obj, bitmap) == 0 {
            b.FPDFPageObj_Destroy(obj);
            return Err(PdfError::Internal {
                detail: "FPDFImageObj_SetBitmap failed".into(),
            });
        }
        // Unit-square image scaled and translated into the target rect.
        let matrix = FS_MATRIX {
            a: rect.right - rect.left,
            b: 0.0,
            c: 0.0,
            d: rect.top - rect.bottom,
            e: rect.left,
            f: rect.bottom,
        };
        b.FPDFPageObj_SetMatrix(obj, &matrix);
        if b.FPDFAnnot_AppendObject(annot, obj) == 0 {
            b.FPDFPageObj_Destroy(obj);
            return Err(PdfError::Internal {
                detail: "FPDFAnnot_AppendObject failed".into(),
            });
        }
        Ok(())
    })();
    // SetBitmap copies the pixels into the object; the bitmap is ours to
    // free regardless of the outcome.
    unsafe { b.FPDFBitmap_Destroy(bitmap) };
    result
}

/// Standard-alphabet base64 (with padding); None on any invalid input.
/// Hand-rolled: ~25 lines beats a dependency for one call site.
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        if chunk.len() != 4 || pad > 2 {
            return None;
        }
        let mut acc = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = if c == b'=' {
                if i < 4 - pad {
                    return None; // padding only at the end
                }
                0
            } else {
                val(c)?
            };
            acc = (acc << 6) | v;
        }
        out.push((acc >> 16) as u8);
        if pad < 2 {
            out.push((acc >> 8) as u8);
        }
        if pad < 1 {
            out.push(acc as u8);
        }
    }
    Some(out)
}

// ---- Reopen: reading our annotations back into the model (M2-PLAN §8) ----

impl PageSpace {
    /// PDF space → top-left page point (inverse of [`PageSpace::point`]).
    fn inv_point(&self, x: f32, y: f32) -> AnnotPoint {
        AnnotPoint {
            x: x - self.box_left,
            y: self.box_top - y,
        }
    }
    /// PDF-space FS_RECTF → top-left rect (inverse of [`PageSpace::rect`]).
    fn inv_rect(&self, r: &FS_RECTF) -> AnnotRect {
        AnnotRect {
            x: r.left - self.box_left,
            y: self.box_top - r.top,
            width: r.right - r.left,
            height: r.top - r.bottom,
        }
    }
}

/// First colour set by `op` ("RG" stroke / "rg" fill) in an appearance
/// stream, as "#rrggbb". Best-effort: used only when FPDFAnnot_GetColor
/// refuses to answer (it does once an /AP exists).
fn ap_color(ap: &str, op: &str) -> Option<String> {
    let tokens: Vec<&str> = ap.split_ascii_whitespace().collect();
    let at = tokens.iter().position(|t| *t == op)?;
    if at < 3 {
        return None;
    }
    let chan = |s: &str| -> Option<u8> {
        let v: f32 = s.parse().ok()?;
        Some((v.clamp(0.0, 1.0) * 255.0).round() as u8)
    };
    let (r, g, b) = (
        chan(tokens[at - 3])?,
        chan(tokens[at - 2])?,
        chan(tokens[at - 1])?,
    );
    Some(format!("#{r:02x}{g:02x}{b:02x}"))
}

/// "D:YYYYMMDDHHMMSS…" → epoch ms; 0 when unparseable (display-only data).
fn parse_pdf_date(m: &str) -> i64 {
    let digits: String = m
        .strip_prefix("D:")
        .unwrap_or(m)
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if digits.len() < 14 {
        return 0;
    }
    chrono::NaiveDateTime::parse_from_str(&digits[..14], "%Y%m%d%H%M%S")
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

unsafe fn read_quads(
    b: &dyn PdfiumLibraryBindings,
    annot: FPDF_ANNOTATION,
    space: &PageSpace,
) -> Vec<AnnotRect> {
    let count = b.FPDFAnnot_CountAttachmentPoints(annot);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let mut q = FS_QUADPOINTSF {
            x1: 0.0,
            y1: 0.0,
            x2: 0.0,
            y2: 0.0,
            x3: 0.0,
            y3: 0.0,
            x4: 0.0,
            y4: 0.0,
        };
        if b.FPDFAnnot_GetAttachmentPoints(annot, i, &mut q) != 0 {
            out.push(space.inv_rect(&FS_RECTF {
                left: q.x1.min(q.x3),
                top: q.y1.max(q.y2),
                right: q.x2.max(q.x4),
                bottom: q.y3.min(q.y4),
            }));
        }
    }
    out
}

unsafe fn read_ink_strokes(
    b: &dyn PdfiumLibraryBindings,
    annot: FPDF_ANNOTATION,
    space: &PageSpace,
) -> Vec<Vec<AnnotPoint>> {
    let strokes = b.FPDFAnnot_GetInkListCount(annot);
    let mut out = Vec::with_capacity(strokes as usize);
    for i in 0..strokes {
        let len = b.FPDFAnnot_GetInkListPath(annot, i, std::ptr::null_mut(), 0);
        if len == 0 {
            continue;
        }
        let mut buf = vec![FS_POINTF { x: 0.0, y: 0.0 }; len as usize];
        b.FPDFAnnot_GetInkListPath(annot, i, buf.as_mut_ptr(), len);
        out.push(buf.iter().map(|p| space.inv_point(p.x, p.y)).collect());
    }
    out
}

/// Best-effort model rebuild from standard PDF keys, for an `ibris:`-tagged
/// annotation whose IbrisData key was stripped by other software. Returns
/// `None` for shapes we cannot faithfully model — the caller then leaves
/// the annotation in the viewing document, visible but read-only.
unsafe fn reconstruct_geom(
    b: &dyn PdfiumLibraryBindings,
    annot: FPDF_ANNOTATION,
    space: &PageSpace,
    ap: &str,
) -> Option<AnnotGeom> {
    let mut rect = FS_RECTF {
        left: 0.0,
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
    };
    b.FPDFAnnot_GetRect(annot, &mut rect);
    let (mut hr, mut vr, mut border) = (0f32, 0f32, 1f32);
    b.FPDFAnnot_GetBorder(annot, &mut hr, &mut vr, &mut border);

    match b.FPDFAnnot_GetSubtype(annot) {
        SUBTYPE_HIGHLIGHT => Some(AnnotGeom::Highlight {
            quads: read_quads(b, annot, space),
        }),
        SUBTYPE_UNDERLINE => Some(AnnotGeom::Underline {
            quads: read_quads(b, annot, space),
        }),
        SUBTYPE_STRIKEOUT => Some(AnnotGeom::Strikeout {
            quads: read_quads(b, annot, space),
        }),
        SUBTYPE_TEXT => Some(AnnotGeom::Note {
            at: space.inv_point(rect.left, rect.top),
            contents: get_string_value(b, annot, "Contents"),
        }),
        SUBTYPE_SQUARE | SUBTYPE_CIRCLE => {
            // We wrote /Rect inflated by the stroke width; deflate it back.
            let deflated = inflate(rect, -border.max(1.0));
            let r = space.inv_rect(&deflated);
            let fill = ap_color(ap, "rg");
            if b.FPDFAnnot_GetSubtype(annot) == SUBTYPE_SQUARE {
                Some(AnnotGeom::Rect {
                    rect: r,
                    stroke_width: border,
                    fill,
                })
            } else {
                Some(AnnotGeom::Ellipse {
                    rect: r,
                    stroke_width: border,
                    fill,
                })
            }
        }
        SUBTYPE_INK => {
            let strokes = read_ink_strokes(b, annot, space);
            // A single two-point stroke is one of our lines or arrows; the
            // head cannot be told apart from the standard keys, so an arrow
            // degrades to a line (documented in M2-PLAN §8).
            if strokes.len() == 1 && strokes[0].len() == 2 {
                Some(AnnotGeom::Line {
                    from: strokes[0][0],
                    to: strokes[0][1],
                    stroke_width: border,
                })
            } else if strokes.is_empty() {
                None
            } else {
                Some(AnnotGeom::Ink {
                    strokes,
                    stroke_width: border,
                })
            }
        }
        SUBTYPE_STAMP => {
            let name = get_string_value(b, annot, "Name");
            if name == IMAGE_STAMP_NAME {
                // The pixels live only in the /AP; without IbrisData the
                // model cannot be rebuilt. Leave it visible, read-only.
                return None;
            }
            Some(AnnotGeom::Stamp {
                rect: space.inv_rect(&rect),
                stamp: name,
            })
        }
        _ => None,
    }
}

/// Everything `open` recovers about our own saved annotations.
pub struct RecoveredAnnotations {
    /// Rebuilt wire models, ready for the frontend document store.
    pub annotations: Vec<AnnotationData>,
    /// The exact /NM values to suppress in the viewing document so the
    /// page bitmap never double-renders against the SVG overlay. Only
    /// successfully modelled annotations are listed — anything else stays
    /// visible (read-only), never silently dropped.
    pub suppress_names: Vec<String>,
}

/// Scans `doc` for `ibris:`-tagged annotations and rebuilds their models:
/// from the IbrisData JSON when present, else from standard keys
/// (M2-PLAN §8). Never fails — a file with no recoverable annotations
/// yields empty vectors.
///
/// # Safety
/// `doc` must be a live document handle from the same PDFium instance as
/// `b`, and the caller must be on the engine thread (decision 008).
pub unsafe fn read_ibris_annotations(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
) -> RecoveredAnnotations {
    let mut annotations = Vec::new();
    let mut suppress_names = Vec::new();
    let page_count = unsafe { b.FPDF_GetPageCount(doc) };
    for page_index in 0..page_count {
        unsafe {
            let page = b.FPDF_LoadPage(doc, page_index);
            if page.is_null() {
                continue;
            }
            let (box_left, box_top) = raw_visible_box_origin(b, page);
            let space = PageSpace { box_left, box_top };
            let count = b.FPDFPage_GetAnnotCount(page);
            for i in 0..count {
                let annot = b.FPDFPage_GetAnnot(page, i);
                if annot.is_null() {
                    continue;
                }
                let nm = get_string_value(b, annot, "NM");
                if let Some(id) = nm.strip_prefix(NM_PREFIX) {
                    if let Some(a) = recover_one(b, annot, &space, id, page_index as u16) {
                        annotations.push(a);
                        suppress_names.push(nm.clone());
                    }
                }
                b.FPDFPage_CloseAnnot(annot);
            }
            b.FPDF_ClosePage(page);
        }
    }
    RecoveredAnnotations {
        annotations,
        suppress_names,
    }
}

unsafe fn recover_one(
    b: &dyn PdfiumLibraryBindings,
    annot: FPDF_ANNOTATION,
    space: &PageSpace,
    id: &str,
    page_index: u16,
) -> Option<AnnotationData> {
    // Full fidelity: the embedded wire model. Identity and page come from
    // the file itself — another tool may have reordered pages since.
    let json = get_string_value(b, annot, IBRIS_DATA_KEY);
    if !json.is_empty() {
        if let Ok(mut a) = serde_json::from_str::<AnnotationData>(&json) {
            a.id = id.to_string();
            a.page_index = page_index;
            return Some(a);
        }
    }

    // Reconstruction from standard keys.
    let ap = get_appearance(b, annot);
    let geom = reconstruct_geom(b, annot, space, &ap)?;
    let (mut cr, mut cg, mut cb, mut ca) = (0u32, 0u32, 0u32, 0u32);
    let color =
        if b.FPDFAnnot_GetColor(annot, COLORTYPE_COLOR, &mut cr, &mut cg, &mut cb, &mut ca) != 0 {
            format!("#{:02x}{:02x}{:02x}", cr as u8, cg as u8, cb as u8)
        } else {
            // GetColor refuses once an /AP exists; the stream knows the colour.
            let op = if matches!(geom, AnnotGeom::Highlight { .. }) {
                "rg"
            } else {
                "RG"
            };
            ap_color(&ap, op).unwrap_or_else(|| "#e0483c".to_string())
        };
    let mut opacity = 1.0f32;
    b.FPDFAnnot_GetNumberValue(annot, "CA", &mut opacity);
    Some(AnnotationData {
        id: id.to_string(),
        page_index,
        color,
        opacity,
        author: get_string_value(b, annot, "T"),
        created_at: parse_pdf_date(&get_string_value(b, annot, "CreationDate")),
        modified_at: parse_pdf_date(&get_string_value(b, annot, "M")),
        geom,
    })
}

/// A saved annotation read back for verification: identity plus enough
/// geometry/colour to prove a faithful round trip.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadAnnotation {
    pub id: String,
    pub page_index: u16,
    pub subtype: i32,
    /// PDF-space rect (left, top, right, bottom).
    pub rect: (f32, f32, f32, f32),
    /// From FPDFAnnot_GetColor, which refuses once an /AP exists; the
    /// drawn colour is asserted through `appearance` instead.
    pub color: Option<(u8, u8, u8, u8)>,
    /// /CA opacity, when present.
    pub opacity: Option<f32>,
    pub quad_count: usize,
    pub contents: String,
    pub author: String,
    /// The /AP normal-appearance content stream (what readers draw).
    pub appearance: String,
}

/// Enumerates every annotation in the document (all pages). Test/debug aid.
///
/// # Safety
/// `doc` must be a live document handle from the same PDFium instance as
/// `b`, and the caller must be on the engine thread (decision 008).
pub unsafe fn read_annotations(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
) -> Vec<ReadAnnotation> {
    let mut out = Vec::new();
    let page_count = unsafe { b.FPDF_GetPageCount(doc) };
    for page_index in 0..page_count {
        unsafe {
            let page = b.FPDF_LoadPage(doc, page_index);
            if page.is_null() {
                continue;
            }
            let count = b.FPDFPage_GetAnnotCount(page);
            for i in 0..count {
                let annot = b.FPDFPage_GetAnnot(page, i);
                if annot.is_null() {
                    continue;
                }
                let mut rect = FS_RECTF {
                    left: 0.0,
                    top: 0.0,
                    right: 0.0,
                    bottom: 0.0,
                };
                b.FPDFAnnot_GetRect(annot, &mut rect);
                let (mut cr, mut cg, mut cb, mut ca) = (0u32, 0u32, 0u32, 0u32);
                let has_color = b.FPDFAnnot_GetColor(
                    annot,
                    COLORTYPE_COLOR,
                    &mut cr,
                    &mut cg,
                    &mut cb,
                    &mut ca,
                ) != 0;
                let mut ca_value = 0f32;
                let has_ca = b.FPDFAnnot_GetNumberValue(annot, "CA", &mut ca_value) != 0;
                out.push(ReadAnnotation {
                    id: get_string_value(b, annot, "NM"),
                    page_index: page_index as u16,
                    subtype: b.FPDFAnnot_GetSubtype(annot),
                    rect: (rect.left, rect.top, rect.right, rect.bottom),
                    color: has_color.then_some((cr as u8, cg as u8, cb as u8, ca as u8)),
                    opacity: has_ca.then_some(ca_value),
                    quad_count: b.FPDFAnnot_CountAttachmentPoints(annot),
                    contents: get_string_value(b, annot, "Contents"),
                    author: get_string_value(b, annot, "T"),
                    appearance: get_appearance(b, annot),
                });
                b.FPDFPage_CloseAnnot(annot);
            }
            b.FPDF_ClosePage(page);
        }
    }
    out
}
