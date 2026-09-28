//! Pure Rust foundation for Tsumugi's project semantics and local persistence.
//!
//! The crate owns metadata rules and the durable project boundary while
//! remaining independent of the desktop webview.

pub mod content;
pub mod execution;
mod persistence;
mod project;

pub use persistence::{
    AttemptView, CaptureContext, ContextCapture, ContextItem, ContextOmission, ContextRevision,
    GlossaryCapture, GlossaryEntry, GlossaryFile, ImpactItem, ImpactPage, ImpactReason,
    PersistenceError, PersistenceErrorCode, PersistenceStage, ProjectStore, Reconciliation,
    RecoveryPlan, RecoveryUnit, ResourceChangeKind, ResourceDecision, ResourceDecisionKind,
    ResourceDecisionResult, ResourcePreview, ResourcePreviewRow, SaveContext, SaveTerm,
    SaveTranslationRevision, SelectTranslationRevision, TaskView, TermResolution,
    TermResolutionEntry, TermRevision, TmSuggestion, TranslationAdoptionConfirmation,
    TranslationAdoptionHandler, TranslationHistory, TranslationMatch, TranslationPreview,
    TranslationPreviewRow, TranslationRevision, TranslationSelection, TranslationSelectionDecision,
};

#[cfg(test)]
pub use persistence::StorageFault;
pub use project::{
    ChangeOutcome, Locale, LocaleError, MetadataChange, MetadataError, MetadataField, ProjectId,
    ProjectIdError, ProjectMetadata, ValidationIssue,
};

/// The product name shared by the desktop shell and Core package metadata.
pub const PRODUCT_NAME: &str = "Tsumugi";
