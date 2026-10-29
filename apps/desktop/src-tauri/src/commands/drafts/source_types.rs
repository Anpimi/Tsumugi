//! Source input and original request identities, without a restored native lease.
use serde::{Deserialize, Serialize};
use tsumugi_core::{content::{LineageChoice, SourceConfirmation, StopSourceMaintenanceHook},
    execution::{ExecutionId, Revision, UnsignedDecimal}};
use crate::commands::plugins::PluginSourceRequest;

macro_rules! input {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
        pub struct $name { $(pub $field: $ty,)* }
    };
}
input!(SourceDraftKey { project_id: ExecutionId });
input!(SourceDraftCaptureRequest { project_id: ExecutionId, selection_id: ExecutionId,
    source_language: String, attempt_id: ExecutionId });
input!(SourceDraftStartRequest { project_id: ExecutionId, attempt_id: ExecutionId,
    input_digest: String, grant_id: ExecutionId, expires_at_ms: UnsignedDecimal,
    unsandboxed_execution: bool, start_metadata: tsumugi_core::content::SourcePluginStartMetadata });
input!(SourceDraftCheckPrepareRequest { project_id: ExecutionId, source_attempt_id: ExecutionId,
    source_result_id: ExecutionId, attempt_id: ExecutionId, source: PluginSourceRequest });
input!(SourceDraftCheckFinishRequest { project_id: ExecutionId, attempt_id: ExecutionId, result_id: ExecutionId });
input!(SourceDraftAdoptRequest { project_id: ExecutionId, attempt_id: ExecutionId,
    result_id: ExecutionId, action_id: ExecutionId, confirmation: SourceConfirmation });
input!(SourceDraftHookStopRequest { project_id: ExecutionId, stop: StopSourceMaintenanceHook });
input!(SourceDraftHookStop { request: SourceDraftHookStopRequest, submitted_seq: Revision });
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceDraftPreparationRef {
    Capture { request: SourceDraftCaptureRequest },
    PrepareCheck { request: SourceDraftCheckPrepareRequest },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceDraftPending {
    Capture { request: SourceDraftCaptureRequest, submitted_seq: Revision, submitted_mapping_seq: Revision },
    Start { request: SourceDraftStartRequest, submitted_seq: Revision, submitted_mapping_seq: Revision },
    PrepareCheck { request: SourceDraftCheckPrepareRequest, submitted_seq: Revision, submitted_mapping_seq: Revision },
    StartCheck { request: SourceDraftStartRequest, submitted_seq: Revision, submitted_mapping_seq: Revision },
    FinishCheck { request: SourceDraftCheckFinishRequest, submitted_seq: Revision, submitted_mapping_seq: Revision },
    Adopt { request: SourceDraftAdoptRequest, unit_id: ExecutionId, submitted_seq: Revision, submitted_mapping_seq: Revision },
}
impl SourceDraftPending {
    pub fn project_id(&self) -> ExecutionId { match self {
        Self::Capture { request, .. } => request.project_id,
        Self::Start { request, .. } | Self::StartCheck { request, .. } => request.project_id,
        Self::PrepareCheck { request, .. } => request.project_id,
        Self::FinishCheck { request, .. } => request.project_id,
        Self::Adopt { request, .. } => request.project_id,
    } }
    pub fn action_id(&self) -> ExecutionId { match self {
        Self::Capture { request, .. } => request.attempt_id,
        Self::Start { request, .. } | Self::StartCheck { request, .. } => request.attempt_id,
        Self::PrepareCheck { request, .. } => request.attempt_id,
        Self::FinishCheck { request, .. } => request.result_id,
        Self::Adopt { request, .. } => request.action_id,
    } }
    pub fn submitted_seq(&self) -> Revision { match self {
        Self::Capture { submitted_seq, .. } | Self::Start { submitted_seq, .. }
        | Self::PrepareCheck { submitted_seq, .. } | Self::StartCheck { submitted_seq, .. }
        | Self::FinishCheck { submitted_seq, .. } | Self::Adopt { submitted_seq, .. } => *submitted_seq,
    } }
    pub fn submitted_mapping_seq(&self) -> Revision { match self {
        Self::Capture { submitted_mapping_seq, .. } | Self::Start { submitted_mapping_seq, .. }
        | Self::PrepareCheck { submitted_mapping_seq, .. } | Self::StartCheck { submitted_mapping_seq, .. }
        | Self::FinishCheck { submitted_mapping_seq, .. } | Self::Adopt { submitted_mapping_seq, .. } => *submitted_mapping_seq,
    } }
}
input!(SourceDraftComparisonRef { attempt_id: ExecutionId, result_id: ExecutionId,
    previous_snapshot_id: Option<ExecutionId>, expected_content_revision: Revision,
    expected_current_snapshot: Option<ExecutionId> });
input!(SourceDraftReceiptRef { action_id: ExecutionId, unit_id: ExecutionId,
    snapshot_id: ExecutionId, attempt_id: ExecutionId, result_id: ExecutionId });
input!(SourceDraftHistoricalSearch { snapshot_id: ExecutionId, query: String, after: u32, new_ordinal: u32 });
input!(SourceDraftHook { locale: String, enabled_intent: bool, source_action_id: Option<ExecutionId> });
input!(SourceDraftValue {
    edit_seq: Revision, mapping_seq: Revision, domain: String, source: Option<PluginSourceRequest>,
    source_language: String, declared: bool, selection_label: Option<String>, updating: bool,
    attempt_id: Option<ExecutionId>, check_attempt_id: Option<ExecutionId>,
    capture_request: Option<SourceDraftCaptureRequest>, check_prepare_request: Option<SourceDraftCheckPrepareRequest>,
    comparison_ref: Option<SourceDraftComparisonRef>, lineage: Vec<LineageChoice>, actor: String,
    filter: String, applied_filter: String, manual_ordinal: Option<u32>, historical_query: String,
    preview_after: u32, comparison_after: u32, historical_search: Option<SourceDraftHistoricalSearch>,
    receipt_ref: Option<SourceDraftReceiptRef>, picker_uncertain: bool, hook: SourceDraftHook,
    pending: Option<SourceDraftPending>, hook_stop: Option<SourceDraftHookStop>
});
input!(SourceDraftHead { key: SourceDraftKey, revision: Revision, writer_id: Option<ExecutionId>, value: Option<SourceDraftValue> });
input!(SourceDraftWrite { key: SourceDraftKey, expected_revision: Revision, writer_id: ExecutionId, value: SourceDraftValue });
input!(SourceDraftClear { key: SourceDraftKey, expected_revision: Revision });
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceDraftResolveTarget {
    Primary { pending: SourceDraftPending },
    HookStop { pending: SourceDraftHookStop },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceDraftDisposition { Recorded, ConfirmedNotApplied, PreparationExpired }
input!(SourceDraftResolve { write: SourceDraftWrite, target: SourceDraftResolveTarget, disposition: SourceDraftDisposition });
