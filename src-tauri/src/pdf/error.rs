use pdfium_render::prelude::{PdfiumError, PdfiumInternalError};
use serde::Serialize;
use thiserror::Error;

/// Typed errors crossing the IPC boundary, serialised as a discriminated
/// union on `kind` — see "Error handling" in docs/ARCHITECTURE.md.
///
/// `Cancelled` and `Internal` extend the documented union: `Cancelled` is
/// normal control flow for abandoned renders and is never shown to the user;
/// `Internal` is the fallback for engine errors with no better mapping.
#[derive(Debug, Clone, Error, Serialize)]
#[serde(tag = "kind")]
pub enum PdfError {
    #[error("file not found: {path}")]
    FileNotFound { path: String },
    #[error("password required")]
    PasswordRequired,
    #[error("corrupt document: {detail}")]
    Corrupt { detail: String },
    #[error("unsupported feature: {feature}")]
    Unsupported { feature: String },
    #[error("io error: {detail}")]
    Io { detail: String },
    #[error("render cancelled")]
    Cancelled,
    #[error("internal error: {detail}")]
    Internal { detail: String },
}

impl From<PdfiumError> for PdfError {
    fn from(e: PdfiumError) -> Self {
        match e {
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError) => {
                PdfError::PasswordRequired
            }
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => {
                PdfError::Corrupt {
                    detail: "invalid or damaged PDF structure".into(),
                }
            }
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FileError) => {
                PdfError::Io {
                    detail: "could not read file".into(),
                }
            }
            other => PdfError::Internal {
                detail: format!("{other:?}"),
            },
        }
    }
}
