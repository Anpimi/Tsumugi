//! Pure Rust foundation for Tsumugi's project semantics and local persistence.
//!
//! The crate owns metadata rules and the durable project boundary while
//! remaining independent of the desktop webview.

pub mod ai;
pub mod application;
pub mod content;
pub mod execution;
mod persistence;
mod project;
mod review;

#[cfg(any(test, feature = "execution-test-host"))]
pub use persistence::BuildLocaleChoice;
pub use persistence::{
    AiAdoptionHandler, ArenaAdoptionHandler, ComparisonEntry, ComparisonRequest, ComparisonSummary,
    ComparisonView, MergeBasis,
};
pub use persistence::{
    AttemptView, CaptureContext, CapturedReviewCheckExecution, ChangeScope, ChangeSnapshot,
    CheckFinding, CheckRuleResult, CheckRun, ComputedAutomaticSelection, ComputedReviewCheck,
    ComputedReviewEvidence, ContextCapture, ContextItem, ContextOmission, ContextRevision,
    DeliveryFile, DeliveryFileState, DeliveryState, DeliveryView, Eligibility, EligibilityLocale,
    EligibilityReason, FallbackDecision, FallbackWrite, GlossaryCapture, GlossaryEntry,
    GlossaryFile, ImpactItem, ImpactPage, ImpactReason, PersistenceError, PersistenceErrorCode,
    PersistenceStage, PreparedAutomaticSelection, PreparedReviewCheck, ProjectStore,
    ProviderBudget, Reconciliation, RecoveryPlan, RecoveryUnit, ReleaseAdoptionHandler,
    ReleaseException, ReleaseExceptionKind, ReleaseView, ReleasedArtifact, ResourceChangeKind,
    ResourceDecision, ResourceDecisionKind, ResourceDecisionResult, ResourceImpactConfidence,
    ResourceImpactKind, ResourceImpactStatus, ResourcePreview, ResourcePreviewRow, ReviewBasis,
    ReviewCheckEvidence, ReviewCheckOutcome, ReviewCheckPlan, ReviewDecision, ReviewDecisionKind,
    ReviewEditorSnapshot, ReviewHistoryPage, ReviewNeighbor, ReviewPage, ReviewScopeCapture,
    ReviewScopeUnit, ReviewSummary, ReviewSummaryCheck, ReviewSummaryDecision, ReviewSummaryPage,
    ReviewTarget, ReviewWrite, SaveContext, SaveTerm, SaveTranslationRevision,
    SelectTranslationRevision, TaskView, TermOrigin, TermResolution, TermResolutionEntry,
    TermRevision, TmMatchKind, TmSuggestion, TranslationAdoptionConfirmation,
    TranslationAdoptionHandler, TranslationEditBasis, TranslationHistory, TranslationMatch,
    TranslationOrigin, TranslationPreview, TranslationPreviewRow, TranslationRevision,
    TranslationSaveReceipt, TranslationSelection, TranslationSelectionDecision,
    TranslationSourceContext, Waiver, WaiverWrite, WorkItem, WorkPage,
};
pub use persistence::{PluginBuildLocaleChoice, ReleaseBuildEnvironment, ReleasePlan};

#[cfg(test)]
pub use persistence::StorageFault;
pub use project::{
    ChangeOutcome, Locale, LocaleError, MetadataChange, MetadataError, MetadataField, ProjectId,
    ProjectIdError, ProjectMetadata, ValidationIssue,
};

/// The product name shared by the desktop shell and Core package metadata.
pub const PRODUCT_NAME: &str = "Tsumugi";
