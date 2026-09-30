//! Pure Rust foundation for Tsumugi's project semantics and local persistence.
//!
//! The crate owns metadata rules and the durable project boundary while
//! remaining independent of the desktop webview.

pub mod ai;
pub mod content;
pub mod execution;
mod persistence;
mod project;

pub use persistence::AiAdoptionHandler;
pub use persistence::{
    AttemptView, BuildLocaleChoice, CaptureContext, CheckFinding, CheckRuleResult, CheckRun,
    ContextCapture, ContextItem, ContextOmission, ContextRevision, DeliveryFile, DeliveryView,
    Eligibility, EligibilityLocale, EligibilityReason, FallbackDecision, FallbackWrite,
    GlossaryCapture, GlossaryEntry, GlossaryFile, ImpactItem, ImpactPage, ImpactReason,
    PersistenceError, PersistenceErrorCode, PersistenceStage, ProjectStore, Reconciliation,
    RecoveryPlan, RecoveryUnit, ReleaseAdoptionHandler, ReleaseView, ReleasedArtifact,
    ResourceChangeKind, ResourceDecision, ResourceDecisionKind, ResourceDecisionResult,
    ResourcePreview, ResourcePreviewRow, ReviewBasis, ReviewDecision, ReviewDecisionKind,
    ReviewHistoryPage, ReviewPage, ReviewTarget, ReviewWrite, SaveContext, SaveTerm,
    SaveTranslationRevision, SelectTranslationRevision, TaskView, TermResolution,
    TermResolutionEntry, TermRevision, TmSuggestion, TranslationAdoptionConfirmation,
    TranslationAdoptionHandler, TranslationHistory, TranslationMatch, TranslationPreview,
    TranslationPreviewRow, TranslationRevision, TranslationSelection, TranslationSelectionDecision,
    Waiver, WaiverWrite, WorkItem, WorkPage,
};

#[cfg(test)]
pub use persistence::StorageFault;
pub use project::{
    ChangeOutcome, Locale, LocaleError, MetadataChange, MetadataError, MetadataField, ProjectId,
    ProjectIdError, ProjectMetadata, ValidationIssue,
};

/// The product name shared by the desktop shell and Core package metadata.
pub const PRODUCT_NAME: &str = "Tsumugi";
