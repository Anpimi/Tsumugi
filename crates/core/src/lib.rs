//! Pure Rust foundation for Tsumugi's project semantics and local persistence.
//!
//! The crate owns metadata rules and the durable project boundary while
//! remaining independent of the desktop webview.

pub mod ai;
pub mod application;
pub use persistence::model_connections;
pub mod content;
pub mod execution;
mod persistence;
mod project;
mod review;

#[cfg(any(test, feature = "execution-test-host"))]
pub use persistence::BuildLocaleChoice;
pub use persistence::{
    AdvisoryFinding, AdvisoryReviewCheck, AttemptView, CandidateDecision, CandidateDecisionWrite,
    CandidateDisposition, CaptureContext, CapturedAutomaticSelection, CapturedReviewCheckExecution,
    ChangeScope, ChangeSnapshot, CheckFinding, CheckRuleResult, CheckRun,
    ComputedAutomaticSelection, ComputedReviewEvidence, ContextCapture, ContextItem,
    ContextOmission, ContextRevision, DeliveryFile, DeliveryFileState, DeliveryState, DeliveryView,
    Eligibility, EligibilityLocale, EligibilityReason, FallbackDecision, FallbackWrite,
    GlossaryCapture, GlossaryEntry, GlossaryFile, ImpactItem, ImpactPage, ImpactReason,
    PersistenceError, PersistenceErrorCode, PersistenceStage, PreparedAutomaticSelection,
    PreparedReviewCheck, ProjectStore, ProviderBudget, Reconciliation, RecoveryPlan, RecoveryUnit,
    ReleaseAdoptionHandler, ReleaseException, ReleaseExceptionKind, ReleaseView, ReleasedArtifact,
    ResourceChangeKind, ResourceDecision, ResourceDecisionKind, ResourceDecisionResult,
    ResourceImpactConfidence, ResourceImpactKind, ResourceImpactStatus, ResourcePreview,
    ResourcePreviewRow, ReviewBasis, ReviewCheckEvidence, ReviewCheckOrigin,
    ReviewCheckOriginEvidence, ReviewCheckOutcome, ReviewCheckPlan, ReviewChecker,
    ReviewCheckerKey, ReviewCheckerKind, ReviewDecision, ReviewDecisionKind, ReviewEditorSnapshot,
    ReviewFindingDecision, ReviewFindingDisposition, ReviewFindingRepair, ReviewFindingView,
    ReviewFindingWrite, ReviewHistoryPage, ReviewInvocationOutcome, ReviewNeighbor, ReviewPage,
    ReviewRepairStatus, ReviewScopeCapture, ReviewScopeUnit, ReviewSummary, ReviewSummaryCheck,
    ReviewSummaryDecision, ReviewSummaryPage, ReviewTarget, ReviewWrite, SaveContext, SaveTerm,
    SaveTranslationRevision, SelectTranslationRevision, TaskActivity, TaskActivityPhase,
    TaskActivityRow, TaskView, TermOrigin, TermResolution, TermResolutionEntry, TermRevision,
    TmMatchKind, TmSuggestion, TranslationAdoptionConfirmation, TranslationAdoptionHandler,
    TranslationEditBasis, TranslationHistory, TranslationMatch, TranslationOrigin,
    TranslationPreview, TranslationPreviewRow, TranslationRevision, TranslationSaveReceipt,
    TranslationSelection, TranslationSelectionDecision, TranslationSourceContext, Waiver,
    WaiverWrite, WorkItem, WorkPage,
};
pub use persistence::{
    AiAdoptionHandler, ArenaAdoptionHandler, ComparisonEntry, ComparisonRequest, ComparisonSummary,
    ComparisonView, MergeBasis,
};
pub use persistence::{MAX_SOURCE_CONTEXT_PAGE_BYTES, SourceContextPage, SourceContextPageEntry};
pub use persistence::{
    MAX_TBX_INPUT_BYTES, MAX_TBX_REPORT_BYTES, MAX_TMX_INPUT_BYTES, MAX_TMX_REPORT_BYTES,
    TbxExchangePreview, TbxExchangeRow, TbxLicenseStatus, TbxLossEntry, TbxLossKind, TbxLossSample,
    TbxRowReason, TbxRowStatus, TbxTermPreview, TbxTermReason, TmxExchangePreview, TmxExchangeRow,
    TmxLicenseStatus, TmxLossEntry, TmxLossKind, TmxLossSample, TmxProvenance, TmxRowReason,
    TmxRowStatus, preview_tbx_exchange, preview_tmx_exchange,
};
pub use persistence::{PluginBuildLocaleChoice, ReleaseBuildEnvironment, ReleasePlan};
pub use persistence::{
    SavedBuildArtifact, SavedBuildLocale, SavedBuildResult, SavedPluginBuildView,
    SelectedSourceContext, SelectedSourceFact, SourceContextAdjacency, SourceContextBlock,
    SourceContextCapture, SourceContextDirection, SourceContextNeighbor, SourceContextObservations,
    SourceContextOccurrence, SourceContextOmissionReason, SourceContextOmissionSample,
    SourceContextOmissions, SourceContextProviderFact, SourceContextProviderNeighbor,
    SourceContextProviderOrigin, SourceContextProviderProjection, SourceContextRequest,
    SourceContextSelection, SourceContextView, UnknownSourceBlockSample, select_source_context,
};

#[cfg(test)]
pub use persistence::StorageFault;
pub use project::{
    ChangeOutcome, Locale, LocaleError, MetadataChange, MetadataError, MetadataField, ProjectId,
    ProjectIdError, ProjectMetadata, ValidationIssue,
};

/// The product name shared by the desktop shell and Core package metadata.
pub const PRODUCT_NAME: &str = "Tsumugi";

#[cfg(any(test, feature = "execution-test-host"))]
pub use persistence::ComputedReviewCheck;
