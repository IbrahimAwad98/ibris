//! The save pipeline (M2-PLAN section 3).
//!
//! Runs entirely on the engine thread against a *fresh* load of the on-disk
//! file — the viewing document is never touched, so undo history survives
//! saves and overlay annotations never double-render. Delete-by-/NM before
//! writing makes repeated saves idempotent. Full rewrite via
//! `FPDF_SaveAsCopy` + temp file + atomic rename; a failure anywhere before
//! the rename leaves the original file byte-identical.

use std::os::raw::{c_int, c_ulong, c_void};
use std::path::Path;

use pdfium_render::prelude::*;

use super::annot::{write_annotations, AnnotationData};
use super::error::PdfError;

/// fpdf_save.h: force a full regeneration, never an incremental append.
const FPDF_NO_INCREMENTAL: u32 = 2;

#[repr(C)]
struct FileWriteCtx {
    // Must be the first field: PDFium hands `pThis` back to the callback,
    // which casts it to this struct.
    fw: FPDF_FILEWRITE,
    buf: Vec<u8>,
}

unsafe extern "C" fn write_block(
    this: *mut FPDF_FILEWRITE,
    data: *const c_void,
    size: c_ulong,
) -> c_int {
    let ctx = this.cast::<FileWriteCtx>();
    let slice = std::slice::from_raw_parts(data.cast::<u8>(), size as usize);
    (*ctx).buf.extend_from_slice(slice);
    1
}

/// Applies `annotations` to the PDF at `path` and rewrites it in place
/// (temp file + rename). `our_ids` are the /NM ids to delete first —
/// pass every id the app has ever written for this document, including
/// ids of annotations that have since been removed or moved.
pub fn save_annotated(
    bindings: &dyn PdfiumLibraryBindings,
    path: &Path,
    annotations: &[AnnotationData],
    our_ids: &[String],
) -> Result<(), PdfError> {
    let bytes = std::fs::read(path).map_err(|e| PdfError::Io {
        detail: format!("reading {} for save: {e}", path.display()),
    })?;

    let saved = unsafe {
        let doc = bindings.FPDF_LoadMemDocument64(&bytes, None);
        if doc.is_null() {
            return Err(PdfError::Corrupt {
                detail: "the on-disk file could no longer be parsed".into(),
            });
        }
        let result = write_annotations(bindings, doc, annotations, our_ids).and_then(|()| {
            let mut ctx = FileWriteCtx {
                fw: FPDF_FILEWRITE {
                    version: 1,
                    WriteBlock: Some(write_block),
                },
                buf: Vec::with_capacity(bytes.len() + 64 * 1024),
            };
            let ok =
                bindings.FPDF_SaveAsCopy(doc, std::ptr::addr_of_mut!(ctx.fw), FPDF_NO_INCREMENTAL);
            if ok == 0 {
                Err(PdfError::Internal {
                    detail: "FPDF_SaveAsCopy failed".into(),
                })
            } else {
                Ok(ctx.buf)
            }
        });
        bindings.FPDF_CloseDocument(doc);
        result?
    };

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf");
    let tmp = path.with_file_name(format!(".{file_name}.ibris-tmp"));
    std::fs::write(&tmp, &saved).map_err(|e| PdfError::Io {
        detail: format!("writing {}: {e}", tmp.display()),
    })?;
    // Same-volume rename; on Windows Rust uses MOVEFILE_REPLACE_EXISTING,
    // so this atomically replaces the original.
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        PdfError::Io {
            detail: format!("replacing {}: {e}", path.display()),
        }
    })
}
