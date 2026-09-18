//! Pure Rust foundation for Tsumugi's project semantics.
//!
//! M01 keeps this crate free of desktop, webview, and persistence concerns.

mod project;

pub use project::{
    ChangeOutcome, Locale, LocaleError, MetadataChange, MetadataError, MetadataField, ProjectId,
    ProjectIdError, ProjectMetadata, ValidationIssue,
};

/// The product name shared by the desktop shell and Core package metadata.
pub const PRODUCT_NAME: &str = "Tsumugi";
