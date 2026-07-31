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
}

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
        AnnotGeom::Stamp { .. } => SUBTYPE_STAMP,
    }
}

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
        AnnotGeom::Stamp { rect, .. } => space.rect(*rect),
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
unsafe fn delete_ours(b: &dyn PdfiumLibraryBindings, page: FPDF_PAGE, ids: &[String]) {
    let count = b.FPDFPage_GetAnnotCount(page);
    for i in (0..count).rev() {
        let annot = b.FPDFPage_GetAnnot(page, i);
        if annot.is_null() {
            continue;
        }
        let nm = get_string_value(b, annot, "NM");
        b.FPDFPage_CloseAnnot(annot);
        if ids.contains(&nm) {
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
            let result = write_page(b, page, wanted.map_or(&[][..], |v| &v[..]), our_ids);
            b.FPDF_ClosePage(page);
            result?;
        }
    }
    Ok(())
}

unsafe fn write_page(
    b: &dyn PdfiumLibraryBindings,
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
        let result = fill_annot(b, annot, &space, a);
        b.FPDFPage_CloseAnnot(annot);
        result?;
    }
    Ok(())
}

unsafe fn fill_annot(
    b: &dyn PdfiumLibraryBindings,
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
    }

    b.FPDFAnnot_SetStringValue_str(annot, "NM", &a.id);
    b.FPDFAnnot_SetStringValue_str(annot, "T", &a.author);
    b.FPDFAnnot_SetStringValue_str(annot, "M", &pdf_date(a.modified_at));
    b.FPDFAnnot_SetStringValue_str(annot, "CreationDate", &pdf_date(a.created_at));

    let ap = appearance_stream(space, a)?;
    if b.FPDFAnnot_SetAP_str(annot, APPEARANCE_NORMAL, &ap) == 0 {
        return Err(PdfError::Internal {
            detail: format!("failed to set appearance stream for {}", a.id),
        });
    }
    Ok(())
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
