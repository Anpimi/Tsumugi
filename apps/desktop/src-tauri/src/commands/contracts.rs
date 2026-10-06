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
struct PluginRequests {
    inventory: plugins::PluginInventoryRequest,
    install: plugins::PluginInstallRequest,
    enable: plugins::PluginEnableRequest,
    package: plugins::PluginPackageRequest,
    lookup: plugins::PluginLookupRequest,
    runtime_install: plugins::PluginRuntimeInstallRequest,
    defaults_install: plugins::PluginDefaultsInstallRequest,
    runtime_lookup: plugins::PluginRuntimeLookupRequest,
    source: plugins::PluginSourceRequest,
    translation: plugins::PluginTranslationRequest,
    build: plugins::PluginBuildRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct PluginResponses {
    inventory: plugins::PluginInventoryView,
    candidate: Option<plugins::PluginCandidateView>,
    package: plugins::PluginPackageDetailsView,
    binding: tsumugi_plugin_sdk::CapabilityBinding,
    runtime: tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor,
    source: plugins::PluginSourceView,
    translation: plugins::PluginTranslationView,
    build: plugins::PluginBuildView,
    error: CommandError,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExecutionRequests {
    session: execution::SessionRequest,
    list: execution::ListRequest,
    task: execution::TaskRequest,
    attempt: execution::AttemptRequest,
    output: execution::OutputRequest,
    cancel: execution::CancelRequest,
    recovery: execution::RecoveryRequest,
    prepare: execution::PrepareRequest,
    adopt: execution::AdoptRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExecutionResponses {
    identity: tsumugi_core::execution::ExecutionId,
    status: execution::RuntimeStatus,
    tasks: Vec<tsumugi_core::TaskView>,
    attempts: Vec<execution::AttemptSummary>,
    attempt: execution::AttemptDetail,
    output: tsumugi_core::execution::ResultEnvelope,
    cancellation: tsumugi_core::execution::Revision,
    recovery: execution::RecoveryView,
    action: tsumugi_core::execution::AdoptionAction,
    adoption: tsumugi_core::execution::AdoptionReceipt,
    receipt: Option<tsumugi_core::execution::AdoptionReceipt>,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct SourceRequests {
    session: execution::SessionRequest,
    preview: execution::source::PreviewRequest,
    content: execution::source::ContentRequest,
    comparison: execution::source::ComparisonRequest,
    history: execution::source::HistoryRequest,
    history_content: execution::source::HistoryContentRequest,
    lineage: execution::source::LineageRequest,
    impact: execution::source::ImpactRequest,
    adopt: execution::source::SourceAdoptRequest,
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
    attempt: tsumugi_core::execution::ExecutionId,
    cancelled: (),
    scope: tsumugi_core::content::ContentScope,
    page: tsumugi_core::content::ContentPage,
    comparison: tsumugi_core::content::SourceChangePage,
    history: tsumugi_core::content::SourceHistory,
    lineage: Vec<tsumugi_core::content::LineageEvidence>,
    estimates: Vec<tsumugi_core::content::SourceImpactSummary>,
    impact: tsumugi_core::content::SourceImpactPage,
    action: tsumugi_core::execution::AdoptionAction,
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
    history: execution::source::translation::TranslationHistoryRequest,
    save: execution::source::translation::TranslationSaveRequest,
    action: execution::source::translation::TranslationActionRequest,
    select: execution::source::translation::TranslationSelectRequest,
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
    history: tsumugi_core::TranslationHistory,
    action: Option<tsumugi_core::TranslationSelection>,
    saved: tsumugi_core::TranslationSaveReceipt,
    selected: tsumugi_core::TranslationSelection,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ResourceRequests {
    session: execution::SessionRequest,
    captures: execution::resource::CaptureListRequest,
    capture: execution::resource::CaptureRequest,
    term: execution::resource::TermRequest,
    decision: execution::resource::DecisionRequest,
    terms: execution::resource::TermListRequest,
    term_history: execution::resource::TermHistoryRequest,
    unit_locale: execution::resource::UnitLocaleRequest,
    context: execution::resource::ContextWriteRequest,
    context_capture: execution::resource::ContextCaptureRequest,
    suggestions: execution::resource::SuggestionRequest,
    impacts: execution::resource::ImpactRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ResourceResponses {
    captures: Vec<tsumugi_core::GlossaryCapture>,
    capture: Option<tsumugi_core::GlossaryCapture>,
    preview: tsumugi_core::ResourcePreview,
    decision: tsumugi_core::ResourceDecisionResult,
    term: tsumugi_core::TermRevision,
    terms: Vec<tsumugi_core::TermRevision>,
    resolution: tsumugi_core::TermResolution,
    context: Option<tsumugi_core::ContextRevision>,
    saved_context: tsumugi_core::ContextRevision,
    context_capture: tsumugi_core::ContextCapture,
    suggestions: Vec<tsumugi_core::TmSuggestion>,
    impacts: tsumugi_core::ImpactPage,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReviewRequests {
    page: execution::review::ReviewPageRequest,
    target: execution::review::ReviewTargetRequest,
    summary: execution::review::ReviewSummaryPageRequest,
    neighbor: execution::review::ReviewNeighborRequest,
    scope: execution::review::ReviewScopeRequest,
    history: execution::review::ReviewHistoryRequest,
    decision: execution::review::ReviewWriteRequest,
    prepare_check: execution::review::ReviewCheckRequest,
    check: execution::review::plugin::ReviewCheckStartRequest,
    cancel_check: execution::review::ReviewCancelCheckRequest,
    waiver: execution::review::WaiverRequest,
    fallback: execution::review::FallbackRequest,
    work: execution::review::ReviewWorkRequest,
    eligibility: execution::review::EligibilityRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReviewResponses {
    page: tsumugi_core::ReviewPage,
    target: tsumugi_core::ReviewTarget,
    summary: tsumugi_core::ReviewSummaryPage,
    neighbor: tsumugi_core::ReviewNeighbor,
    scope: tsumugi_core::ReviewScopeCapture,
    history: tsumugi_core::ReviewHistoryPage,
    decision: tsumugi_core::ReviewDecision,
    prepare_check: execution::review::plugin::ReviewCheckPreparation,
    check: tsumugi_core::CheckRun,
    cancel_check: bool,
    waiver: tsumugi_core::Waiver,
    fallback: tsumugi_core::FallbackDecision,
    work: tsumugi_core::WorkPage,
    eligibility: tsumugi_core::Eligibility,
    editor: tsumugi_core::ReviewEditorSnapshot,
}

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ReleaseRequests {
    session: execution::SessionRequest,
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
    work_plan_authorize: execution::work_plans::WorkPlanAuthorizeRequest,
    work_plan_start: execution::work_plans::WorkPlanStartRequest,
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
    work_plan_receipt: execution::work_plans::WorkPlanReceiptView,
    work_plan_status: execution::work_plans::WorkPlanStatusView,
    work_plan_action: Option<execution::work_plans::WorkPlanReceiptView>,
    work_protection: tsumugi_core::application::WorkProtection,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ArenaRequests {
    preview: execution::arena::PreviewRequest,
    start: execution::arena::StartRequest,
    read: execution::arena::ReadRequest,
    compare: execution::arena::ComparisonCommand,
    comparison: execution::arena::ComparisonRead,
    session: execution::SessionRequest,
    reveal: execution::arena::RevealRequest,
    merge: execution::arena::MergeRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ArenaResponses {
    prepared: execution::arena::Prepared,
    identity: tsumugi_core::execution::ExecutionId,
    view: execution::arena::View,
    comparison: tsumugi_core::ComparisonView,
    comparisons: Vec<tsumugi_core::ComparisonSummary>,
    reveal: (),
    selection: tsumugi_core::TranslationSelection,
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
            "plugins": schemas::<PluginRequests, PluginResponses>(),
            "execution": schemas::<ExecutionRequests, ExecutionResponses>(),
            "source": schemas::<SourceRequests, SourceResponses>(),
            "translation": schemas::<TranslationRequests, TranslationResponses>(),
            "resource": schemas::<ResourceRequests, ResourceResponses>(),
            "review": schemas::<ReviewRequests, ReviewResponses>(),
            "release": schemas::<ReleaseRequests, ReleaseResponses>(),
            "ai": schemas::<AiRequests, AiResponses>(),
            "arena": schemas::<ArenaRequests, ArenaResponses>()
        }))? + "\n",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
