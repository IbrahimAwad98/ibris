//! The save pipeline (M2-PLAN §3, extended for M3 page structure).
//!
//! Runs entirely on the engine thread against a *fresh* load of the on-disk
//! file — the viewing document is never touched, so undo history survives
//! saves and overlay annotations never double-render.
//!
//! Structure: when the page order differs from identity or extra rotations
//! exist, pages are imported into a brand-new document in final order
//! (`FPDF_ImportPagesByIndex`, which carries page content and existing
//! annotations along), rotations are applied additively to /Rotate, and
//! annotation page indexes are remapped source→final. Annotations whose
//! source page is not in the order (deleted pages) are dropped.
//!
//! Delete-by-/NM before writing keeps saves idempotent. Full rewrite via
//! `FPDF_SaveAsCopy` + temp file + atomic rename; a failure anywhere before
//! the rename leaves the destination untouched.

use std::os::raw::{c_int, c_ulong, c_void};
use std::path::{Path, PathBuf};

use pdfium_render::prelude::*;
use serde::Deserialize;

use super::annot::{write_annotations, AnnotationData};
use super::error::PdfError;

/// A page pulled from another file (M3 insert-from-file). Referenced by
/// negative `order` entries: order value -(k+1) means `inserts[k]`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertSource {
    pub path: PathBuf,
    pub page_index: u16,
}

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

unsafe fn doc_to_bytes(
    b: &dyn PdfiumLibraryBindings,
    doc: FPDF_DOCUMENT,
    capacity: usize,
) -> Result<Vec<u8>, PdfError> {
    let mut ctx = FileWriteCtx {
        fw: FPDF_FILEWRITE {
            version: 1,
            WriteBlock: Some(write_block),
        },
        buf: Vec::with_capacity(capacity),
    };
    if b.FPDF_SaveAsCopy(doc, std::ptr::addr_of_mut!(ctx.fw), FPDF_NO_INCREMENTAL) == 0 {
        return Err(PdfError::Internal {
            detail: "FPDF_SaveAsCopy failed".into(),
        });
    }
    Ok(ctx.buf)
}

fn write_atomically(dest: &Path, bytes: &[u8]) -> Result<(), PdfError> {
    let file_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.pdf");
    let tmp = dest.with_file_name(format!(".{file_name}.ibris-tmp"));
    std::fs::write(&tmp, bytes).map_err(|e| PdfError::Io {
        detail: format!("writing {}: {e}", tmp.display()),
    })?;
    // Same-volume rename; on Windows Rust uses MOVEFILE_REPLACE_EXISTING,
    // so this atomically replaces any existing destination.
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        PdfError::Io {
            detail: format!("replacing {}: {e}", dest.display()),
        }
    })
}

/// Saves the document at `src_path` to `dest_path` with pages in `order`
/// (source indexes; omissions are deletions; negative entries reference
/// `inserts` — pages imported from other files), extra clockwise
/// `rotations` (degrees, per own source page), and `annotations`
/// (source-page-indexed) applied. `our_ids` are the /NM ids deleted
/// before writing.
#[allow(clippy::too_many_arguments)] // mirrors the wire format
pub fn save_document(
    b: &dyn PdfiumLibraryBindings,
    src_path: &Path,
    dest_path: &Path,
    order: &[i32],
    inserts: &[InsertSource],
    rotations: &[(u16, u16)],
    annotations: &[AnnotationData],
    our_ids: &[String],
    field_values: &[super::form::FieldWrite],
    flatten: bool,
) -> Result<(), PdfError> {
    let bytes = std::fs::read(src_path).map_err(|e| PdfError::Io {
        detail: format!("reading {} for save: {e}", src_path.display()),
    })?;

    let saved = unsafe {
        let src = b.FPDF_LoadMemDocument64(&bytes, None);
        if src.is_null() {
            return Err(PdfError::Corrupt {
                detail: "the on-disk file could no longer be parsed".into(),
            });
        }
        // Form values go onto the source document first, before any page
        // import: baked /V + regenerated appearances travel with pages,
        // whereas the catalog's /AcroForm registration does not survive
        // FPDF_ImportPagesByIndex (fields on restructured saves keep
        // their looks but lose interactivity — decision 016).
        let result = super::form::apply_form_values(b, src, field_values).and_then(|()| {
            build_and_serialise(
                b,
                src,
                bytes.len(),
                order,
                inserts,
                rotations,
                annotations,
                our_ids,
                flatten,
            )
        });
        b.FPDF_CloseDocument(src);
        result?
    };

    write_atomically(dest_path, &saved)
}

/// Documents inserted pages are imported from, loaded once per distinct
/// path and closed when the save finishes (drop).
struct InsertDocs<'a> {
    b: &'a dyn PdfiumLibraryBindings,
    // Bytes must outlive the FPDF documents parsed from them.
    loaded: Vec<(PathBuf, Vec<u8>, FPDF_DOCUMENT)>,
}

impl<'a> InsertDocs<'a> {
    fn get(&mut self, path: &Path) -> Result<FPDF_DOCUMENT, PdfError> {
        if let Some((_, _, doc)) = self.loaded.iter().find(|(p, _, _)| p == path) {
            return Ok(*doc);
        }
        let bytes = std::fs::read(path).map_err(|e| PdfError::Io {
            detail: format!("reading {} for insert: {e}", path.display()),
        })?;
        let doc = unsafe { self.b.FPDF_LoadMemDocument64(&bytes, None) };
        if doc.is_null() {
            return Err(PdfError::Corrupt {
                detail: format!("{} could not be parsed", path.display()),
            });
        }
        self.loaded.push((path.to_path_buf(), bytes, doc));
        Ok(doc)
    }
}

impl Drop for InsertDocs<'_> {
    fn drop(&mut self) {
        for (_, _, doc) in &self.loaded {
            unsafe { self.b.FPDF_CloseDocument(*doc) };
        }
    }
}

#[allow(clippy::too_many_arguments)] // mirrors save_document
unsafe fn build_and_serialise(
    b: &dyn PdfiumLibraryBindings,
    src: FPDF_DOCUMENT,
    src_size: usize,
    order: &[i32],
    inserts: &[InsertSource],
    rotations: &[(u16, u16)],
    annotations: &[AnnotationData],
    our_ids: &[String],
    flatten: bool,
) -> Result<Vec<u8>, PdfError> {
    let src_count = b.FPDF_GetPageCount(src);
    let identity = rotations.iter().all(|(_, deg)| deg % 360 == 0)
        && order.len() == src_count as usize
        && order.iter().enumerate().all(|(i, s)| *s == i as i32);

    if identity {
        // Plain annotation save: no structural rebuild needed.
        write_annotations(b, src, annotations, our_ids)?;
        if flatten {
            super::form::flatten_all_pages(b, src)?;
        }
        return doc_to_bytes(b, src, src_size + 64 * 1024);
    }

    let out = b.FPDF_CreateNewDocument();
    if out.is_null() {
        return Err(PdfError::Internal {
            detail: "FPDF_CreateNewDocument failed".into(),
        });
    }
    let mut insert_docs = InsertDocs {
        b,
        loaded: Vec::new(),
    };
    let result = (|| {
        // Import runs of consecutive own pages in one call; inserted pages
        // come from their own (cached) documents one at a time.
        let mut position: c_int = 0;
        let mut i = 0;
        while i < order.len() {
            if order[i] >= 0 {
                let mut run: Vec<c_int> = Vec::new();
                while i < order.len() && order[i] >= 0 {
                    run.push(order[i]);
                    i += 1;
                }
                if b.FPDF_ImportPagesByIndex(out, src, run.as_ptr(), run.len() as c_ulong, position)
                    == 0
                {
                    return Err(PdfError::Internal {
                        detail: "importing pages in the new order failed".into(),
                    });
                }
                position += run.len() as c_int;
            } else {
                let k = (-order[i] - 1) as usize;
                let source = inserts.get(k).ok_or_else(|| PdfError::Internal {
                    detail: format!("order references missing insert {k}"),
                })?;
                let doc = insert_docs.get(&source.path)?;
                let index = [c_int::from(source.page_index)];
                if b.FPDF_ImportPagesByIndex(out, doc, index.as_ptr(), 1, position) == 0 {
                    return Err(PdfError::Internal {
                        detail: format!(
                            "importing page {} of {} failed",
                            source.page_index + 1,
                            source.path.display()
                        ),
                    });
                }
                position += 1;
                i += 1;
            }
        }

        // Additive /Rotate per final position (own pages only).
        for (final_idx, source) in order.iter().enumerate() {
            let extra = rotations
                .iter()
                .find(|(s, _)| i32::from(*s) == *source)
                .map_or(0, |(_, deg)| deg / 90);
            if extra % 4 == 0 {
                continue;
            }
            let page = b.FPDF_LoadPage(out, final_idx as c_int);
            if page.is_null() {
                return Err(PdfError::Internal {
                    detail: format!("failed to load imported page {final_idx}"),
                });
            }
            let current = b.FPDFPage_GetRotation(page);
            b.FPDFPage_SetRotation(page, (current + c_int::from(extra)) % 4);
            b.FPDF_ClosePage(page);
        }

        // Remap annotations source→final; annotations on deleted pages drop.
        let remapped: Vec<AnnotationData> = annotations
            .iter()
            .filter_map(|a| {
                order
                    .iter()
                    .position(|s| *s == i32::from(a.page_index))
                    .map(|final_idx| {
                        let mut copy = a.clone();
                        copy.page_index = final_idx as u16;
                        copy
                    })
            })
            .collect();

        write_annotations(b, out, &remapped, our_ids)?;
        if flatten {
            super::form::flatten_all_pages(b, out)?;
        }
        doc_to_bytes(b, out, src_size + 64 * 1024)
    })();
    b.FPDF_CloseDocument(out);
    result
}

/// Concatenates whole files into a new document at `dest`.
pub fn merge_documents(
    b: &dyn PdfiumLibraryBindings,
    paths: &[std::path::PathBuf],
    dest: &Path,
) -> Result<(), PdfError> {
    if paths.is_empty() {
        return Err(PdfError::Internal {
            detail: "nothing to merge".into(),
        });
    }
    let saved = unsafe {
        let out = b.FPDF_CreateNewDocument();
        if out.is_null() {
            return Err(PdfError::Internal {
                detail: "FPDF_CreateNewDocument failed".into(),
            });
        }
        let result = (|| {
            let mut total_size = 0;
            let mut insert_at: c_int = 0;
            for path in paths {
                let bytes = std::fs::read(path).map_err(|e| PdfError::Io {
                    detail: format!("reading {}: {e}", path.display()),
                })?;
                total_size += bytes.len();
                let src = b.FPDF_LoadMemDocument64(&bytes, None);
                if src.is_null() {
                    return Err(PdfError::Corrupt {
                        detail: format!("{} could not be parsed", path.display()),
                    });
                }
                let count = b.FPDF_GetPageCount(src);
                let all: Vec<c_int> = (0..count).collect();
                let ok = b.FPDF_ImportPagesByIndex(
                    out,
                    src,
                    all.as_ptr(),
                    all.len() as c_ulong,
                    insert_at,
                );
                b.FPDF_CloseDocument(src);
                if ok == 0 {
                    return Err(PdfError::Internal {
                        detail: format!("importing {} failed", path.display()),
                    });
                }
                insert_at += count;
            }
            doc_to_bytes(b, out, total_size + 64 * 1024)
        })();
        b.FPDF_CloseDocument(out);
        result?
    };
    write_atomically(dest, &saved)
}
