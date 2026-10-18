//! Generate IPC shapes from the same Rust definitions used by Tauri and Serde.
use super::*;
use schemars::{JsonSchema, Schema, generate::SchemaSettings, transform::RecursiveTransform};

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct Requests {
    create: CreateProjectRequest,
    open: OpenProjectRequest,
    read: ReadProjectRequest,
    rename: RenameProjectRequest,
    add_target_locale: AddTargetLocaleRequest,
    set_target_locales: SetTargetLocalesRequest,
    close: CloseProjectRequest,
    changes: changes::ChangesRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct Responses {
    project_view: ProjectView,
    metadata_mutation: MetadataMutationView,
    close: CloseProjectView,
    error: CommandError,
    changes: changes::ProjectChanges,
    notification: changes::ChangeNotification,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct McpRequests {
    session: execution::SessionRequest,
    prepare: mcp::McpSharePrepareRequest,
    authorize: mcp::McpShareAuthorizeRequest,
    read: mcp::McpShareReadRequest,
    revoke: mcp::McpShareRevokeRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct McpResponses {
    session: mcp::McpShareSessionView,
    prepared: mcp::McpSharePrepared,
    authorized: mcp::McpShareAuthorized,
    share: mcp::McpShareView,
    revoked: mcp::McpShareRevocation,
    error: CommandError,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct McpRetrievalRequests {
    session: execution::SessionRequest,
    discover: mcp_retrieval::McpRetrievalDiscoverRequest,
    read: mcp_retrieval::McpRetrievalReadRequest,
    prepare: mcp_retrieval::McpRetrievalPrepareRequest,
    start: mcp_retrieval::McpRetrievalStartRequest,
    stop: mcp_retrieval::McpRetrievalStopRequest,
    capture: mcp_retrieval::McpRetrievalCaptureRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct McpRetrievalResponses {
    session: mcp_retrieval::McpRetrievalSession,
    view: mcp_retrieval::McpRetrievalView,
    stopped: mcp_retrieval::McpRetrievalStopped,
    capture: tsumugi_core::application::McpTermCaptureReceipt,
    output: tsumugi_core::application::McpTermQueryOutput,
    error: CommandError,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ConnectionRequests {
    snapshot: connections::ConnectionSnapshotRequest,
    change: tsumugi_core::model_connections::ModelConnectionChange,
    action: connections::ConnectionActionRequest,
    resolve: connections::ConnectionResolveRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ConnectionResponses {
    snapshot: connections::ConnectionReadView,
    receipt: tsumugi_core::model_connections::ModelConnectionReceipt,
    action: Option<tsumugi_core::model_connections::ModelConnectionReceipt>,
    connection: tsumugi_core::ai::AiConnection,
    error: CommandError,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct PluginRequests {
    inventory: plugins::PluginInventoryRequest,
    install: plugins::PluginInstallRequest,
    pack_install: plugins::PluginPackInstallRequest,
    repository_refresh: plugins::PluginRepositoryRefreshRequest,
    repository_resume: plugins::PluginRepositoryResumeRequest,
    repository_install: plugins::PluginRepositoryInstallRequest,
    enable: plugins::PluginEnableRequest,
    approval_removal: plugins::PluginApprovalRemovalRequest,
    uninstall: plugins::PluginUninstallRequest,
    package: plugins::PluginPackageRequest,
    lookup: plugins::PluginLookupRequest,
    runtime_install: plugins::PluginRuntimeInstallRequest,
    native_host_approval: plugins::PluginNativeHostApprovalRequest,
    defaults_install: plugins::PluginDefaultsInstallRequest,
    runtime_lookup: plugins::PluginRuntimeLookupRequest,
    source: plugins::PluginSourceRequest,
    translation: plugins::PluginTranslationRequest,
    build: plugins::PluginBuildRequest,
    tool: plugins::PluginToolRequest,
    generation_component: plugins::PluginGenerationComponentRequest,
    text_review: plugins::PluginTextReviewRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct PluginResponses {
    inventory: plugins::PluginInventoryView,
    candidate: Option<plugins::PluginCandidateView>,
    pack_candidate: Option<plugins::PluginPackCandidateView>,
    repository_selection: Option<plugins::PluginRepositorySelectionView>,
    repository_sources: plugins::PluginRepositorySourcesView,
    repository_verified: plugins::PluginRepositoryVerifiedView,
    package: plugins::PluginPackageDetailsView,
    binding: tsumugi_plugin_sdk::CapabilityBinding,
    runtime: tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor,
    source: plugins::PluginSourceView,
    translation: plugins::PluginTranslationView,
    build: plugins::PluginBuildView,
    tool: plugins::PluginToolView,
    generation_component: plugins::PluginGenerationComponentView,
    text_review: plugins::PluginTextReviewView,
    text_reviews: plugins::PluginTextReviewListView,
    error: CommandError,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExecutionRequests {
    session: execution::SessionRequest,
    list: execution::ListRequest,
    activity: execution::TaskActivityRequest,
    task: execution::TaskRequest,
    attempt: execution::AttemptRequest,
    output: execution::OutputRequest,
    cancel: execution::CancelRequest,
    cancellation_action: execution::CancelRequest,
    recovery: execution::RecoveryRequest,
    continuation: execution::ContinuationRequest,
    continuation_read: execution::ContinuationReadRequest,
    continuation_list: execution::ContinuationListRequest,
    task_view: execution::TaskViewRequest,
    prepare: execution::PrepareRequest,
    adoption_action: execution::PrepareRequest,
    adopt: execution::AdoptRequest,
    tool_prepare: execution::tools::PluginToolPrepareRequest,
    tool_start: execution::tools::PluginToolStartRequest,
    tool_discard: execution::tools::PluginToolDiscardRequest,
    application_instance: plugins::application::ApplicationInstanceRequest,
    application_instance_stop: plugins::application::StopApplicationInstanceRequest,
    application_shutdown: plugins::application::ApplicationShutdownRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExecutionResponses {
    identity: tsumugi_core::execution::ExecutionId,
    status: execution::RuntimeStatus,
    tasks: Vec<tsumugi_core::TaskView>,
    activity: tsumugi_core::TaskActivity,
    attempts: Vec<execution::AttemptSummary>,
    attempt: execution::AttemptDetail,
    output: execution::ExecutionOutputView,
    cancellation: tsumugi_core::execution::Revision,
    cancellation_action: Option<tsumugi_core::execution::CancellationReceipt>,
    recovery: execution::RecoveryView,
    continuation: tsumugi_core::execution::ContinuationReceipt,
    continuation_receipt: Option<tsumugi_core::execution::ContinuationReceipt>,
    continuations: execution::ContinuationPage,
    task_view: tsumugi_core::TaskView,
    action: tsumugi_core::execution::AdoptionAction,
    adoption: tsumugi_core::execution::AdoptionReceipt,
    adoption_action: Option<tsumugi_core::execution::AdoptionActionRead>,
    receipt: Option<tsumugi_core::execution::AdoptionReceipt>,
    tool_preflight: execution::tools::PluginToolPreflight,
    tool_discarded: bool,
    application_instance: plugins::application::ApplicationInstanceView,
    application_shutdown: plugins::application::ApplicationShutdownView,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct SourceRequests {
    session: execution::SessionRequest,
    maintenance_hook_session: execution::SessionRequest,
    maintenance_hook: source_hooks::SourceMaintenanceHookReadRequest,
    maintenance_hook_stop: source_hooks::SourceMaintenanceHookStopRequest,
    preview: execution::source::PreviewRequest,
    content: execution::source::ContentRequest,
    source_context: execution::source::SourceContextReadRequest,
    source_context_block: execution::source::SourceContextBlockReadRequest,
    comparison: execution::source::ComparisonRequest,
    history: execution::source::HistoryRequest,
    history_content: execution::source::HistoryContentRequest,
    lineage: execution::source::LineageRequest,
    impact: execution::source::ImpactRequest,
    adopt: execution::source::SourceAdoptRequest,
    adoption_action: execution::source::SourceAdoptionActionRequest,
    plugin_select: execution::source::plugin::PluginSourceSelectRequest,
    plugin_capture: execution::source::plugin::PluginCaptureRequest,
    plugin_start: execution::source::plugin::PluginStartRequest,
    check_prepare: execution::source::plugin::SourceCheckPrepareRequest,
    check_finish: execution::source::plugin::SourceCheckFinishRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct SourceResponses {
    maintenance_hook_session: tsumugi_core::content::SourceMaintenanceHookSession,
    maintenance_hook: source_hooks::SourceMaintenanceHookObservation,
    maintenance_hook_stopped: source_hooks::SourceMaintenanceHookStopped,
    attempt: tsumugi_core::execution::ExecutionId,
    cancelled: (),
    scope: tsumugi_core::content::ContentScope,
    page: tsumugi_core::content::ContentPage,
    source_context: tsumugi_core::SourceContextPage,
    source_context_block: tsumugi_core::SourceContextBlockDetail,
    comparison: tsumugi_core::content::SourceChangePage,
    history: tsumugi_core::content::SourceHistory,
    lineage: Vec<tsumugi_core::content::LineageEvidence>,
    estimates: Vec<tsumugi_core::content::SourceImpactSummary>,
    impact: tsumugi_core::content::SourceImpactPage,
    action: tsumugi_core::execution::AdoptionAction,
    adoption_action: Option<tsumugi_core::execution::AdoptionActionRead>,
    plugin_selection: Option<execution::source::plugin::PluginSourceSelection>,
    plugin_preflight: execution::source::plugin::PluginSourcePreflight,
    check_review: execution::source::plugin::SourceCheckReview,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct TranslationRequests {
    source: execution::source::plugin_translation::TranslationSourceRequest,
    plugin_select: execution::source::plugin_translation::PluginTranslationSelectRequest,
    plugin_capture: execution::source::plugin_translation::PluginTranslationCaptureRequest,
    plugin_start: execution::PluginStartRequest,
    check_prepare: execution::source::plugin_translation::TranslationCheckPrepareRequest,
    check_finish: execution::source::plugin_translation::TranslationCheckFinishRequest,
    projection_prepare: execution::source::plugin_translation::TranslationProjectionPrepareRequest,
    projection_start: execution::source::plugin_translation::TranslationProjectionStartRequest,
    files: execution::source::translation::TranslationFilesRequest,
    preview: execution::source::translation::TranslationPreviewRequest,
    adopt: execution::source::translation::TranslationAdoptRequest,
    adoption_action: execution::source::translation::TranslationAdoptionActionRequest,
    history: execution::source::translation::TranslationHistoryRequest,
    save: execution::source::translation::TranslationSaveRequest,
    action: execution::source::translation::TranslationActionRequest,
    select: execution::source::translation::TranslationSelectRequest,
    save_action: execution::source::translation::TranslationSaveRequest,
    selection_action: execution::source::translation::TranslationSelectRequest,
    candidate_decision: execution::source::translation::CandidateDecisionRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct TranslationResponses {
    source: tsumugi_core::TranslationSourceContext,
    plugin_selection: Option<execution::source::plugin_translation::PluginTranslationSelection>,
    plugin_preflight: execution::source::plugin_translation::PluginTranslationPreflight,
    check_review: execution::source::plugin_translation::TranslationCheckReview,
    projection_review: execution::source::plugin_translation::TranslationProjectionReview,
    checked: (),
    files: Vec<String>,
    attempt: tsumugi_core::execution::ExecutionId,
    preview: tsumugi_core::TranslationPreview,
    prepared: tsumugi_core::execution::AdoptionAction,
    adoption_action: Option<tsumugi_core::execution::AdoptionActionRead>,
    history: tsumugi_core::TranslationHistory,
    action: Option<tsumugi_core::TranslationSelection>,
    saved: tsumugi_core::TranslationSaveReceipt,
    selected: tsumugi_core::TranslationSelection,
    save_action: Option<tsumugi_core::TranslationSaveReceipt>,
    selection_action: Option<tsumugi_core::TranslationSelection>,
    candidate_decision: tsumugi_core::CandidateDecision,
    candidate_action: Option<tsumugi_core::CandidateDecision>,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ResourceRequests {
    session: execution::SessionRequest,
    tmx_preview: execution::resource::TmxPreviewRequest,
    tbx_preview: execution::resource::TbxPreviewRequest,
    captures: execution::resource::CaptureListRequest,
    capture: execution::resource::CaptureRequest,
    term: execution::resource::TermRequest,
    term_action: execution::resource::TermRequest,
    decision: execution::resource::DecisionRequest,
    correction_basis: execution::resource::CorrectionBasisRequest,
    correction_capture: execution::resource::CorrectionCaptureRequest,
    resource_action: execution::resource::ResourceActionRequest,
    terms: execution::resource::TermListRequest,
    term_history: execution::resource::TermHistoryRequest,
    unit_locale: execution::resource::UnitLocaleRequest,
    context: execution::resource::ContextWriteRequest,
    context_action: execution::resource::ContextWriteRequest,
    context_fact: execution::resource::ContextFactRequest,
    context_facts: execution::resource::ContextFactsRequest,
    context_fact_action: execution::resource::ContextFactActionRequest,
    context_fact_history: execution::resource::ContextFactHistoryRequest,
    context_capture: execution::resource::ContextCaptureRequest,
    context_capture_action: execution::resource::ContextCaptureRequest,
    suggestions: execution::resource::SuggestionRequest,
    impacts: execution::resource::ImpactRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ResourceResponses {
    tmx_preview: Option<execution::resource::TmxFilePreview>,
    tbx_preview: Option<execution::resource::TbxFilePreview>,
    captures: Vec<tsumugi_core::GlossaryCapture>,
    capture: Option<tsumugi_core::GlossaryCapture>,
    preview: tsumugi_core::ResourcePreview,
    decision: tsumugi_core::ResourceDecisionResult,
    correction_basis: tsumugi_core::CorrectionTermEvidence,
    correction_capture: tsumugi_core::CorrectionTermReceipt,
    correction_action: Option<tsumugi_core::CorrectionTermReceipt>,
    decision_action: Option<tsumugi_core::ResourceDecisionResult>,
    term: tsumugi_core::TermRevision,
    term_action: Option<tsumugi_core::TermSaveActionRead>,
    terms: Vec<tsumugi_core::TermRevision>,
    resolution: tsumugi_core::TermResolution,
    context: Option<tsumugi_core::ContextRevision>,
    saved_context: tsumugi_core::ContextRevision,
    context_action: Option<tsumugi_core::ContextSaveActionRead>,
    context_fact: tsumugi_core::ContextFactDecision,
    context_facts: Vec<tsumugi_core::ContextFactDecision>,
    context_fact_action: Option<tsumugi_core::ContextFactDecision>,
    context_fact_history: tsumugi_core::ContextFactHistory,
    context_capture: tsumugi_core::ContextCapture,
    context_capture_action: Option<tsumugi_core::ContextCaptureActionRead>,
    suggestions: Vec<tsumugi_core::TmSuggestion>,
    impacts: tsumugi_core::ImpactPage,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReviewRequests {
    semantic_prepare: execution::review::semantic::AiSemanticReviewPrepareRequest,
    semantic_start: execution::review::semantic::AiSemanticReviewStartRequest,
    semantic_read: execution::review::semantic::AiSemanticReviewReadRequest,
    page: execution::review::ReviewPageRequest,
    target: execution::review::ReviewTargetRequest,
    diagnostic_location: execution::review::ReviewDiagnosticLocationRequest,
    summary: execution::review::ReviewSummaryPageRequest,
    neighbor: execution::review::ReviewNeighborRequest,
    scope: execution::review::ReviewScopeRequest,
    history: execution::review::ReviewHistoryRequest,
    finding: execution::review::ReviewFindingWriteRequest,
    finding_action: execution::review::ReviewFindingActionRequest,
    findings: execution::review::ReviewHistoryRequest,
    decision: execution::review::ReviewWriteRequest,
    decision_action: execution::review::ReviewWriteRequest,
    prepare_check: execution::review::ReviewCheckRequest,
    check: execution::review::plugin::ReviewCheckStartRequest,
    cancel_check: execution::review::ReviewCancelCheckRequest,
    waiver: execution::review::WaiverRequest,
    waiver_action: execution::review::WaiverRequest,
    fallback: execution::review::FallbackRequest,
    fallback_action: execution::review::FallbackRequest,
    work: execution::review::ReviewWorkRequest,
    eligibility: execution::review::EligibilityRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReviewResponses {
    semantic_prepare: execution::review::semantic::AiSemanticReviewPrepared,
    semantic_start: tsumugi_core::execution::ExecutionId,
    semantic_read: execution::review::semantic::AiSemanticReviewLookup,
    page: tsumugi_core::ReviewPage,
    target: tsumugi_core::ReviewTarget,
    diagnostic_location: tsumugi_core::ReviewDiagnosticLocation,
    summary: tsumugi_core::ReviewSummaryPage,
    neighbor: tsumugi_core::ReviewNeighbor,
    scope: tsumugi_core::ReviewScopeCapture,
    history: tsumugi_core::ReviewHistoryPage,
    finding: tsumugi_core::ReviewFindingDecision,
    finding_action: Option<tsumugi_core::ReviewFindingDecision>,
    findings: tsumugi_core::ReviewFindingView,
    decision: tsumugi_core::ReviewDecision,
    decision_action: Option<tsumugi_core::ReviewDecisionActionRead>,
    prepare_check: execution::review::plugin::ReviewCheckPreparation,
    check: tsumugi_core::CheckRun,
    cancel_check: bool,
    waiver: tsumugi_core::Waiver,
    waiver_action: Option<tsumugi_core::ReviewWaiverActionRead>,
    fallback: tsumugi_core::FallbackDecision,
    fallback_action: Option<tsumugi_core::ReviewFallbackActionRead>,
    work: tsumugi_core::WorkPage,
    eligibility: tsumugi_core::Eligibility,
    editor: tsumugi_core::ReviewEditorSnapshot,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReleaseRequests {
    session: execution::SessionRequest,
    artifact_workflow_session: execution::SessionRequest,
    artifact_workflow_prepare:
        execution::release::plugin::workflow::ArtifactCheckWorkflowPrepareRequest,
    artifact_workflow_start:
        execution::release::plugin::workflow::ArtifactCheckWorkflowStartRequest,
    artifact_workflow_read: execution::release::plugin::workflow::ArtifactCheckWorkflowReadRequest,
    artifact_workflow_stop: execution::release::plugin::workflow::ArtifactCheckWorkflowStopRequest,
    saved_plugin_build: execution::release::plugin::SavedPluginBuildRequest,
    plugin_build: execution::release::plugin::PluginBuildPrepareRequest,
    plugin_start: execution::PluginStartRequest,
    artifact_check: execution::release::plugin::ArtifactCheckPrepareRequest,
    finish_artifact_check: execution::release::plugin::ArtifactCheckFinishRequest,
    release: execution::release::ReleaseRequest,
    preview: execution::release::PreviewRequest,
    export: execution::release::ExportRequest,
    reconcile: execution::release::ReconcileRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReleaseResponses {
    artifact_workflow_session:
        execution::release::plugin::workflow::ArtifactCheckWorkflowSessionView,
    artifact_workflow: execution::release::plugin::workflow::ArtifactCheckWorkflowView,
    artifact_workflow_observation:
        execution::release::plugin::workflow::ArtifactCheckWorkflowObservation,
    artifact_workflow_stopped:
        execution::release::plugin::workflow::ArtifactCheckWorkflowStopReceipt,
    saved_plugin_build: tsumugi_core::SavedPluginBuildView,
    plugin_build: execution::release::plugin::PluginBuildReview,
    artifact_check: execution::release::plugin::ArtifactCheckReview,
    finish_artifact_check: (),
    cancel_plugin_build: bool,
    delivery_action: Option<tsumugi_core::DeliveryView>,
    identity: tsumugi_core::execution::ExecutionId,
    releases: Vec<tsumugi_core::ReleaseView>,
    selection: Option<execution::release::DeliverySelection>,
    preview: execution::release::DeliveryPreview,
    delivery: tsumugi_core::DeliveryView,
    deliveries: Vec<tsumugi_core::DeliveryView>,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct AiRequests {
    preview: execution::ai::AiPreviewRequest,
    start: execution::ai::AiStartRequest,
    read: execution::ai::AiReadRequest,
    effect_retry: execution::ai::AiEffectRetryRequest,
    work_plan_prepare: execution::work_plans::WorkPlanPrepareRequest,
    maintenance_assessment: execution::work_plans::MaintenanceAssessmentRequest,
    work_plan_authorize: execution::work_plans::WorkPlanAuthorizeRequest,
    work_plan_start: execution::work_plans::WorkPlanStartRequest,
    work_plan_start_action: execution::work_plans::WorkPlanStartRequest,
    work_plan_generation_prepare:
        execution::work_plans::generation::WorkPlanGenerationPrepareRequest,
    work_plan_generation_start: execution::work_plans::generation::WorkPlanGenerationStartRequest,
    work_plan_generation_discard:
        execution::work_plans::generation::WorkPlanGenerationDiscardRequest,
    work_plan_agent_open: execution::work_plans::agent::WorkPlanAgentOpenRequest,
    work_plan_agent_delegate: execution::work_plans::agent::WorkPlanAgentDelegateRequest,
    work_plan_agent_reconcile: execution::work_plans::agent::WorkPlanAgentReconcileRequest,
    work_plan_agent_generation_attempt:
        execution::work_plans::agent::WorkPlanAgentGenerationAttemptRequest,
    work_plan_agent_generation_output:
        execution::work_plans::agent::WorkPlanAgentGenerationOutputRequest,
    work_plan_agent_prepare: execution::work_plans::agent::WorkPlanAgentPrepareRequest,
    work_plan_agent_start: execution::work_plans::agent::WorkPlanAgentStartRequest,
    work_plan_agent_tool_prepare: execution::work_plans::broker::WorkPlanAgentToolPrepareRequest,
    work_plan_agent_tool_start: execution::work_plans::broker::WorkPlanAgentToolStartRequest,
    work_plan_agent_tool_attempt: execution::work_plans::broker::WorkPlanAgentToolAttemptRequest,
    work_plan_agent_tool_output: execution::work_plans::broker::WorkPlanAgentToolOutputRequest,
    work_plan_agent_guidance: execution::work_plans::guidance::WorkPlanAgentGuidanceRequest,
    work_plan_agent_skill: execution::work_plans::guidance::WorkPlanAgentSkillRequest,
    work_plan_agent_resource: execution::work_plans::guidance::WorkPlanAgentResourceRequest,
    work_plan_control: execution::work_plans::WorkPlanControlRequest,
    work_plan_status: execution::work_plans::WorkPlanStatusRequest,
    work_plan_action: execution::work_plans::WorkPlanActionRequest,
    work_protection_read: execution::work_plans::WorkProtectionReadRequest,
    work_protection_set: execution::work_plans::WorkProtectionSetRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct AiResponses {
    prepared: execution::ai::AiPrepared,
    identity: tsumugi_core::execution::ExecutionId,
    view: execution::ai::AiView,
    effect_retry: bool,
    work_plan: execution::work_plans::WorkPlanView,
    maintenance_assessment: tsumugi_core::application::MaintenanceAssessment,
    work_plan_generation_preflight: execution::work_plans::generation::WorkPlanGenerationPreflight,
    work_plan_agent: execution::work_plans::agent::WorkPlanAgentView,
    work_plan_agent_reconcile: tsumugi_core::application::WorkPlanAgentReconciliation,
    work_plan_agent_generation: execution::work_plans::agent::WorkPlanAgentGenerationView,
    work_plan_agent_generation_attempt: execution::AttemptDetail,
    work_plan_agent_generation_output: execution::ExecutionOutputView,
    work_plan_agent_tool: execution::work_plans::broker::WorkPlanAgentToolView,
    work_plan_agent_tool_attempt: execution::AttemptDetail,
    work_plan_agent_tool_output: execution::ExecutionOutputView,
    work_plan_agent_guidance: execution::work_plans::guidance::WorkPlanAgentGuidanceView,
    work_plan_agent_skill: execution::work_plans::guidance::WorkPlanAgentGuidanceTextView,
    work_plan_agent_resource: execution::work_plans::guidance::WorkPlanAgentGuidanceTextView,
    work_plan_receipt: execution::work_plans::WorkPlanReceiptView,
    work_plan_status: execution::work_plans::WorkPlanStatusView,
    work_plan_action: Option<execution::work_plans::WorkPlanReceiptView>,
    work_plan_start_action: Option<tsumugi_core::application::WorkPlanStartReceipt>,
    work_protection: tsumugi_core::application::WorkProtection,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ArenaRequests {
    preview: execution::arena::PreviewRequest,
    start: execution::arena::StartRequest,
    start_action: execution::arena::StartRequest,
    read: execution::arena::ReadRequest,
    compare: execution::arena::ComparisonCommand,
    comparison_action: execution::arena::ComparisonCommand,
    comparison: execution::arena::ComparisonRead,
    session: execution::SessionRequest,
    reveal: execution::arena::RevealRequest,
    reveal_target: execution::arena::ComparisonRead,
    merge: execution::arena::MergeRequest,
    merge_action: execution::arena::MergeRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ArenaResponses {
    prepared: execution::arena::Prepared,
    start_action: Option<tsumugi_core::ai::arena::ArenaStartReceipt>,
    identity: tsumugi_core::execution::ExecutionId,
    view: execution::arena::View,
    comparison: tsumugi_core::ComparisonView,
    comparison_action: Option<tsumugi_core::ComparisonRequest>,
    merge_action: Option<tsumugi_core::ArenaMergeActionRead>,
    comparisons: Vec<tsumugi_core::ComparisonSummary>,
    reveal: (),
    reveal_target: Option<tsumugi_core::ArenaRevealTarget>,
    selection: tsumugi_core::TranslationSelection,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct StrategyRequests {
    capture: execution::strategy::CaptureRequest,
    candidate: execution::strategy::CandidateRequest,
    locale: execution::strategy::LocaleRequest,
    page: execution::strategy::PageRequest,
    suite: execution::strategy::SuiteCaptureRequest,
    prepare: execution::strategy::EvaluationPrepareRequest,
    read: execution::strategy::EvaluationRequest,
    read_start: execution::strategy::EvaluationRequest,
    start: execution::strategy::EvaluationStartRequest,
    judgment: execution::strategy::JudgmentRequest,
    promote: execution::strategy::PromoteRequest,
    withdraw: execution::strategy::WithdrawRequest,
    action: execution::strategy::ActionRequest,
    save_candidate: execution::strategy::SaveCandidateRequest,
    prepare_check: execution::review::plugin::StrategyCheckCommand,
    run_check: execution::review::plugin::StrategyCheckStartRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct StrategyResponses {
    candidate: tsumugi_core::ContextStrategyCandidate,
    candidates: tsumugi_core::ContextStrategyCandidatePage,
    suite: execution::strategy::StrategySuiteView,
    prepared: execution::strategy::Prepared,
    evaluation: execution::strategy::StrategyEvaluationView,
    evaluations: tsumugi_core::StrategyEvaluationPage,
    judgment: tsumugi_core::StrategyJudgment,
    r#default: Option<tsumugi_core::ContextStrategyDefaultRevision>,
    defaults: tsumugi_core::ContextStrategyDefaultPage,
    action: Option<execution::strategy::StrategyActionReceiptView>,
    check_preparation: execution::review::plugin::StrategyCheckPreparation,
    check: tsumugi_core::StrategyCheckReceipt,
    identity: tsumugi_core::execution::ExecutionId,
    start_receipt: Option<tsumugi_core::execution::ExecutionId>,
    adoption: tsumugi_core::execution::AdoptionReceipt,
    error: CommandError,
}

fn bound_integer(schema: &mut Schema) {
    // Schemars marks Rust's integer format but does not emit its upper bound.
    // Apply the primitive bound to scalar and tuple items without copying DTOs.
    let maximum = match schema.get("format").and_then(serde_json::Value::as_str) {
        Some("uint8") => Some(u32::from(u8::MAX)),
        Some("uint32") => Some(u32::MAX),
        _ => None,
    };
    if let Some(maximum) = maximum {
        let maximum = schema
            .get("maximum")
            .and_then(serde_json::Value::as_f64)
            .map_or(f64::from(maximum), |declared| {
                declared.min(f64::from(maximum))
            });
        let minimum = schema
            .get("minimum")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        schema.insert("minimum".into(), minimum.into());
        schema.insert("maximum".into(), maximum.into());
    }
    if schema.get("format").and_then(serde_json::Value::as_str) == Some("int32") {
        let minimum = schema
            .get("minimum")
            .and_then(serde_json::Value::as_f64)
            .map_or(f64::from(i32::MIN), |declared| {
                declared.max(f64::from(i32::MIN))
            });
        let maximum = schema
            .get("maximum")
            .and_then(serde_json::Value::as_f64)
            .map_or(f64::from(i32::MAX), |declared| {
                declared.min(f64::from(i32::MAX))
            });
        schema.insert("minimum".into(), minimum.into());
        schema.insert("maximum".into(), maximum.into());
    }
}

fn schemas<Q: JsonSchema, R: JsonSchema>() -> serde_json::Value {
    let settings = SchemaSettings::draft07().with_transform(RecursiveTransform(bound_integer));
    let requests = settings
        .clone()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<Q>();
    let responses = settings
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<R>();
    serde_json::json!({"requests": requests, "responses": responses})
}

pub(super) fn metadata_revision(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    tsumugi_core::execution::wire_schema::unsigned_decimal(u64::MAX)
}
pub(super) fn optional_metadata_revision(
    generator: &mut schemars::generate::SchemaGenerator,
) -> schemars::Schema {
    let value = metadata_revision(generator);
    if *generator.contract() == schemars::generate::Contract::Deserialize {
        schemars::json_schema!({"anyOf": [value, {"type":"null"}]})
    } else {
        value
    }
}
pub(super) fn optional_text(
    generator: &mut schemars::generate::SchemaGenerator,
) -> schemars::Schema {
    if *generator.contract() == schemars::generate::Contract::Serialize {
        String::json_schema(generator)
    } else {
        Option::<String>::json_schema(generator)
    }
}

pub(crate) fn export(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::write(
        path,
        serde_json::to_string_pretty(&serde_json::json!({
            "project": schemas::<Requests, Responses>(),
            "mcp": schemas::<McpRequests, McpResponses>(),
            "mcpRetrieval": schemas::<McpRetrievalRequests, McpRetrievalResponses>(),
            "connections": schemas::<ConnectionRequests, ConnectionResponses>(),
            "plugins": schemas::<PluginRequests, PluginResponses>(),
            "execution": schemas::<ExecutionRequests, ExecutionResponses>(),
            "source": schemas::<SourceRequests, SourceResponses>(),
            "translation": schemas::<TranslationRequests, TranslationResponses>(),
            "resource": schemas::<ResourceRequests, ResourceResponses>(),
            "review": schemas::<ReviewRequests, ReviewResponses>(),
            "release": schemas::<ReleaseRequests, ReleaseResponses>(),
            "ai": schemas::<AiRequests, AiResponses>(),
            "arena": schemas::<ArenaRequests, ArenaResponses>(),
            "strategy": schemas::<StrategyRequests, StrategyResponses>()
        }))? + "\n",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ai_items_require_an_explicit_project_fact_capture_on_both_wire_sides() {
        let schema = schemas::<execution::ai_wire::AiItemView, execution::ai_wire::AiItemView>();
        for group in ["requests", "responses"] {
            assert!(
                schema[group]["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == "projectContext")
            );
            assert!(
                schema[group]["properties"]["projectContext"]
                    .get("default")
                    .is_none()
            );
        }
    }

    #[test]
    fn maintenance_schema_requires_the_nullable_capture_and_response_field() {
        let schema = schemas::<
            execution::work_plans::WorkPlanPrepareRequest,
            execution::work_plans::WorkPlanView,
        >();
        for group in ["requests", "responses"] {
            assert!(
                schema[group]["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value == "maintenance")
            );
            assert!(
                schema[group]["properties"]["maintenance"]["anyOf"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value["type"] == "null")
            );
        }
    }

    #[test]
    fn source_adoption_read_schema_requires_an_explicit_nullable_receipt() {
        let schema = schemas::<
            execution::source::SourceAdoptionActionRequest,
            tsumugi_core::execution::AdoptionActionRead,
        >();
        let response = &schema["responses"];
        assert!(
            response["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == "receipt")
        );
        assert!(
            response["properties"]["receipt"]["anyOf"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value["type"] == "null")
        );
    }

    #[test]
    fn schema_bounds_intersect_declared_constraints_with_primitive_limits() {
        #[derive(JsonSchema)]
        #[allow(dead_code)]
        struct Bounds {
            #[schemars(range(min = 10, max = 20))]
            narrow: u32,
            #[schemars(range(min=-100,max=500))]
            widened: u8,
            #[schemars(range(min=-10,max=10))]
            signed: i32,
            unsigned_primitive: u32,
            signed_primitive: i32,
        }
        let schema = schemas::<Bounds, Bounds>();
        for group in ["requests", "responses"] {
            for (field, minimum, maximum) in [
                ("narrow", 10.0, 20.0),
                ("widened", 0.0, 255.0),
                ("signed", -10.0, 10.0),
                ("unsigned_primitive", 0.0, 4294967295.0),
                ("signed_primitive", -2147483648.0, 2147483647.0),
            ] {
                let property = &schema[group]["properties"][field];
                assert_eq!(
                    property["minimum"].as_f64(),
                    Some(minimum),
                    "{group}.{field}"
                );
                assert_eq!(
                    property["maximum"].as_f64(),
                    Some(maximum),
                    "{group}.{field}"
                );
            }
        }
    }
}
