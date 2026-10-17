//! Fixed work plans shared by application entry points.
//!
//! A plan describes requested effects and captured evidence. Preparing or
//! verifying it does not authorize execution, selection, approval or delivery.

use crate::{
    ProjectId,
    ai::{self, AiPreview},
    execution::{
        ErrorCode, ExecutionError, ExecutionId, FixedInput, InputEnvelope, MAX_INPUT_BYTES,
        Revision, UnsignedDecimal, codec,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
mod disclosure;
pub mod mcp_retrieval;
pub use mcp_retrieval::*;
mod maintenance;
pub use disclosure::{
    CapturedMcpShare, MAX_MCP_SHARE_BYTES, MAX_MCP_SHARE_PREVIEW_BYTES, MCP_SHARE_PREVIEW_VERSION,
    McpShareBasis, McpSharePreview, McpShareRequest, McpSharedContext, McpSharedSource,
    McpSharedTerm, McpSharedTermEntry, McpSharedTranslation, McpSharedUnit,
};
#[cfg(feature = "wire-schema")]
pub use maintenance::maintenance_schema;
pub use maintenance::required_maintenance;
pub use maintenance::{
    MaintenanceAction, MaintenanceAssessment, MaintenanceChoice, MaintenancePlanBasis,
    MaintenanceRow,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkStage {
    Understanding,
    Resources,
    Generation,
    Checks,
    Delivery,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum StageMode {
    Manual,
    Assisted,
    Skipped,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StageChoice {
    pub stage: WorkStage,
    pub mode: StageMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SelectionPolicy {
    CandidatesOnly,
    MissingOnly,
    ReplaceCapturedSelection,
}

/// Requested automatic effects, never a human language-review approval.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum AutomationEffect {
    SaveCandidate,
    RunChecks,
    SelectMissing,
    ReplaceCapturedSelection,
    AdoptResources,
    Deliver,
    QueryTools,
}

/// Captured by the trusted host from an installed package, never model text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanToolSpec {
    pub handle: ExecutionId,
    pub binding: tsumugi_plugin_sdk::CapabilityToolBinding,
    pub execution: crate::execution::PluginExecutionBinding,
    pub resource_id: String,
    pub settings_revision: UnsignedDecimal,
    pub package_origin: serde_json::Value,
    pub runtime_origin: serde_json::Value,
    pub target: String,
    pub selections: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanTools {
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 300)))]
    pub max_invocations: u32,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 32)))]
    pub entries: Vec<WorkPlanToolSpec>,
}

impl WorkPlanTools {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if !(1..=300).contains(&self.max_invocations)
            || self.entries.is_empty()
            || self.entries.len() > 32
            || self
                .entries
                .iter()
                .map(|tool| tool.handle)
                .collect::<BTreeSet<_>>()
                .len()
                != self.entries.len()
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "work-plan-tools",
            ));
        }
        for tool in &self.entries {
            tool.binding
                .validate()
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "work-plan-tool"))?;
            tool.execution.validate_project_or_attempt()?;
            if tool.execution.capability != tool.binding.capability
                || tool.execution.profile != tool.binding.declaration.profile
            {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "work-plan-tool-binding",
                ));
            }
            if tool.resource_id.is_empty()
                || tool.resource_id.len() > 128
                || !tool.package_origin.is_object()
                || !tool.runtime_origin.is_object()
            {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "work-plan-tool-metadata",
                ));
            }
            tool.binding
                .declaration
                .query
                .as_ref()
                .ok_or_else(|| {
                    ExecutionError::new(ErrorCode::InvalidInput, "work-plan-tool-query")
                })?
                .prepare_payload(
                    "q",
                    &tool.target,
                    &tool.selections,
                    tool.binding.capability.declaration.limits.max_input_bytes,
                )
                .map_err(|_| {
                    ExecutionError::new(ErrorCode::InvalidInput, "work-plan-tool-options")
                })?;
        }
        Ok(())
    }
    pub(crate) fn digest(&self) -> Result<String, ExecutionError> {
        Ok(codec::digest(&codec::encode(self, MAX_INPUT_BYTES)?))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AgentToolRequest {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub tool_handle: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 100)))]
    pub unit_ids: Vec<ExecutionId>,
}

/// Application-created proof. Possession does not bypass current ledger checks.
#[derive(Clone, Debug)]
pub struct PreparedWorkPlanTool {
    pub(crate) scope: WorkPlanAgentScope,
    pub(crate) request: AgentToolRequest,
    pub(crate) input: FixedInput,
    pub(crate) tool: WorkPlanToolSpec,
}
impl PreparedWorkPlanTool {
    pub fn input(&self) -> &FixedInput {
        &self.input
    }
    pub fn tool(&self) -> &WorkPlanToolSpec {
        &self.tool
    }
}

/// Independent, session-bound process consent captured by a human entry point.
/// It has no serialization or renewal API and is never a dispatch permit.
#[derive(Clone, Debug)]
pub struct WorkPlanToolConsent {
    pub(crate) project_id: ExecutionId,
    pub(crate) lease: AutomationLease,
    pub(crate) parent_task: ExecutionId,
    pub(crate) store_epoch: String,
    pub(crate) tools_digest: String,
    pub(crate) runtime_generation: ExecutionId,
    pub(crate) expires_at_ms: u64,
    pub(crate) deadline: std::time::Instant,
}
impl WorkPlanToolConsent {
    pub(crate) fn matches_scope(&self, scope: &WorkPlanAgentScope) -> bool {
        self.project_id == scope.project_id
            && self.lease == scope.lease
            && self.parent_task == scope.parent_task
            && self.store_epoch == scope.store_epoch
    }
    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkPlanToolDelegation {
    pub lease: AutomationLease,
    pub root_task: ExecutionId,
    pub tool_handle: ExecutionId,
    pub caller: String,
    pub caller_id: ExecutionId,
    #[serde(deserialize_with = "required_agent_subset")]
    pub delegation: Option<WorkPlanAgentSubset>,
}

/// The largest allowed proof includes 100 unit IDs and 32 captured tool IDs.
pub const MAX_AGENT_DELEGATION_BYTES: usize = 8192;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AgentDelegationRequest {
    pub delegation_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 100)))]
    pub unit_ids: Vec<ExecutionId>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
    pub tool_handles: Vec<ExecutionId>,
}

/// Human recovery identity. It contains no scope or execution authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentExecutionIdentity {
    pub lease: AutomationLease,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub input_digest: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanAgentReconciliationOutcome {
    Active,
    Enqueued,
    NotEnqueued,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentReconciliation {
    pub identity: WorkPlanAgentExecutionIdentity,
    pub outcome: WorkPlanAgentReconciliationOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanAgentSubset {
    pub delegation_id: ExecutionId,
    pub parent_scope_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 100)))]
    pub unit_ids: Vec<ExecutionId>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 32)))]
    pub tool_handles: Vec<ExecutionId>,
}

pub fn required_agent_subset<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WorkPlanAgentSubset>, D::Error> {
    Option::deserialize(deserializer)
}
#[cfg(feature = "wire-schema")]
pub fn agent_subset_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<WorkPlanAgentSubset> as schemars::JsonSchema>::json_schema(generator)
}

/// Immutable provenance, never a substitute for a live opaque scope.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanAgentExecutionBinding {
    pub lease: AutomationLease,
    pub root_task: ExecutionId,
    pub caller_id: ExecutionId,
    #[serde(deserialize_with = "required_agent_subset")]
    pub delegation: Option<WorkPlanAgentSubset>,
}

#[derive(Clone, Debug)]
pub struct PreparedWorkPlanAgentGeneration {
    pub(crate) scope: WorkPlanAgentScope,
    pub(crate) request: AgentGenerationRequest,
    pub(crate) input: FixedInput,
}
impl PreparedWorkPlanAgentGeneration {
    pub fn input(&self) -> &FixedInput {
        &self.input
    }
}
impl std::ops::Deref for PreparedWorkPlanAgentGeneration {
    type Target = FixedInput;
    fn deref(&self) -> &FixedInput {
        &self.input
    }
}

/// A reference to durable authority. Possessing or editing this reference does
/// not grant permission; Core checks the stored generation at every boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AutomationLease {
    pub plan_id: ExecutionId,
    pub generation: Revision,
}

/// A session-bound application handle. The host may give an Agent this scope,
/// without giving it the plan authorizer, Store or runtime. Editing model text
/// cannot create this handle or change its original lease and budget anchor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkPlanAgentScope {
    pub(crate) project_id: ExecutionId,
    pub(crate) lease: AutomationLease,
    pub(crate) parent_task: ExecutionId,
    pub(crate) store_epoch: String,
    pub(crate) caller_id: ExecutionId,
    pub(crate) delegation: Option<WorkPlanAgentSubset>,
}

/// A read snapshot of the original scope's tool guidance, never an execution
/// permit. It is deliberately not serializable or constructible by a caller.
#[derive(Clone, Debug)]
pub struct CapturedWorkPlanToolGuidance {
    pub(crate) scope: WorkPlanAgentScope,
    pub(crate) tools: Vec<WorkPlanToolSpec>,
}
impl CapturedWorkPlanToolGuidance {
    pub fn tools(&self) -> &[WorkPlanToolSpec] {
        &self.tools
    }
    pub fn tool(&self, handle: ExecutionId) -> Result<&WorkPlanToolSpec, ExecutionError> {
        self.tools
            .iter()
            .find(|tool| tool.handle == handle)
            .ok_or_else(|| {
                ExecutionError::new(ErrorCode::Unauthorized, "work-plan-guidance-member")
            })
    }
}

impl WorkPlanAgentScope {
    pub fn delegation(&self) -> Option<&WorkPlanAgentSubset> {
        self.delegation.as_ref()
    }
    pub(crate) fn execution_binding(&self) -> WorkPlanAgentExecutionBinding {
        WorkPlanAgentExecutionBinding {
            lease: self.lease,
            root_task: self.parent_task,
            caller_id: self.caller_id,
            delegation: self.delegation.clone(),
        }
    }
    pub fn caller_id(&self) -> ExecutionId {
        self.caller_id
    }
    pub fn project_id(&self) -> ExecutionId {
        self.project_id
    }
    pub fn lease(&self) -> AutomationLease {
        self.lease
    }
    pub fn parent_task(&self) -> ExecutionId {
        self.parent_task
    }
}

/// A bounded proposal within an already-authorized plan. It contains no model,
/// destination, payload, effect, human confirmation or authority override.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AgentGenerationRequest {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 100)))]
    pub unit_ids: Vec<ExecutionId>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanState {
    Active,
    Paused,
    Stopped,
    TakenOver,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanCommand {
    Pause,
    Stop,
    TakeOver,
    Continue,
}

/// Supplied only by a trusted human-facing application entry point. Semantic
/// answers are deliberately absent from this authorization contract.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizeWorkPlan {
    pub action_id: ExecutionId,
    pub plan_digest: String,
    pub confirmed: bool,
    pub effects: Vec<AutomationEffect>,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlWorkPlan {
    pub action_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub expected_generation: Revision,
    pub command: WorkPlanCommand,
    pub confirmed: bool,
    pub expires_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanReceipt {
    /// Cancellation of the original budget root acknowledged by this grant.
    pub cancellation_revision: Revision,
    pub action_id: ExecutionId,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    /// A continuation is a child of the original budget owner. No request
    /// reservation or unknown exposure is refunded by a control operation.
    pub input: Option<InputEnvelope>,
    pub parent_task: Option<ExecutionId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanStatus {
    pub cancellation_revision: Revision,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub effects: Vec<AutomationEffect>,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkProtection {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub revision: Revision,
    pub protected: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetWorkProtection {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_revision_id: ExecutionId,
    pub selection_id: Option<ExecutionId>,
    pub expected_revision: Revision,
    pub protected: bool,
    pub confirmed_release: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PlanOptions {
    pub stages: Vec<StageChoice>,
    pub selection_policy: SelectionPolicy,
    pub advisory_checks: Vec<crate::AdvisoryReviewCheck>,
    pub adopt_resources: bool,
    pub deliver: bool,
}

impl Default for PlanOptions {
    fn default() -> Self {
        Self {
            stages: vec![
                StageChoice {
                    stage: WorkStage::Understanding,
                    mode: StageMode::Manual,
                },
                StageChoice {
                    stage: WorkStage::Resources,
                    mode: StageMode::Manual,
                },
                StageChoice {
                    stage: WorkStage::Generation,
                    mode: StageMode::Assisted,
                },
                StageChoice {
                    stage: WorkStage::Checks,
                    mode: StageMode::Manual,
                },
                StageChoice {
                    stage: WorkStage::Delivery,
                    mode: StageMode::Manual,
                },
            ],
            selection_policy: SelectionPolicy::CandidatesOnly,
            advisory_checks: Vec::new(),
            adopt_resources: false,
            deliver: false,
        }
    }
}

impl PlanOptions {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        crate::persistence::validate_choices(&self.advisory_checks)?;
        let mut stages = BTreeSet::new();
        if self.stages.is_empty()
            || self.stages.len() > 5
            || self
                .stages
                .iter()
                .any(|choice| !stages.insert(choice.stage))
            || (self.selection_policy != SelectionPolicy::CandidatesOnly
                && (!self.assisted(WorkStage::Generation) || !self.assisted(WorkStage::Checks)))
            || (!self.advisory_checks.is_empty() && !self.assisted(WorkStage::Checks))
            || (self.adopt_resources && !self.assisted(WorkStage::Resources))
            || (self.deliver && !self.assisted(WorkStage::Delivery))
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "work-plan-options",
            ));
        }
        Ok(())
    }

    fn assisted(&self, stage: WorkStage) -> bool {
        self.stages
            .iter()
            .any(|choice| choice.stage == stage && choice.mode == StageMode::Assisted)
    }

    pub fn requests(&self, effect: AutomationEffect) -> bool {
        match effect {
            AutomationEffect::SaveCandidate => self.assisted(WorkStage::Generation),
            AutomationEffect::RunChecks => self.assisted(WorkStage::Checks),
            AutomationEffect::SelectMissing => {
                self.selection_policy == SelectionPolicy::MissingOnly
            }
            AutomationEffect::ReplaceCapturedSelection => {
                self.selection_policy == SelectionPolicy::ReplaceCapturedSelection
            }
            AutomationEffect::AdoptResources => self.adopt_resources,
            AutomationEffect::Deliver => self.deliver,
            AutomationEffect::QueryTools => false,
        }
    }

    /// The current application can grant candidate generation, deterministic
    /// checks and bounded selection. Resource adoption and delivery require
    /// separate implemented contracts, rather than an enum granting permission.
    pub(crate) fn authorization_effects(&self) -> Result<Vec<AutomationEffect>, ExecutionError> {
        self.validate()?;
        if !self.requests(AutomationEffect::SaveCandidate) || self.adopt_resources || self.deliver {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "work-plan-effect",
            ));
        }
        Ok([
            AutomationEffect::SaveCandidate,
            AutomationEffect::RunChecks,
            AutomationEffect::SelectMissing,
            AutomationEffect::ReplaceCapturedSelection,
        ]
        .into_iter()
        .filter(|effect| self.requests(*effect))
        .collect())
    }
}

/// The host supplies only a saved AI revision and a durable lease. Core derives
/// the observed scope and policy from the authorized plan, never from model text.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AutomaticSelectionRequest {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub lease: AutomationLease,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub revision_id: ExecutionId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum AutomaticSelectionBlock {
    Protected,
    AlreadySelected,
    Checks,
}

/// A policy action is distinct from a human review decision. Replaying this
/// receipt does not select again or restore an older authority or check basis.
/// CandidatesOnly records candidate QA with no selection, current CheckRun or
/// selection block; its rule outcomes remain evidence rather than approval.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AutomaticSelectionReceipt {
    pub request: AutomaticSelectionRequest,
    pub policy_version: String,
    pub policy: SelectionPolicy,
    pub protection_revision: Revision,
    pub candidate_basis: crate::ReviewBasis,
    pub captured_selection_id: Option<ExecutionId>,
    pub validator_version: String,
    pub rules: Vec<crate::CheckRuleResult>,
    pub evidence: Option<crate::ReviewCheckEvidence>,
    pub blocked: Option<AutomaticSelectionBlock>,
    pub selection: Option<crate::TranslationSelection>,
    pub check_run_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PlanSelectionBasis {
    pub unit_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub native_key: String,
    pub selection_id: Option<ExecutionId>,
}

/// One immutable preview, including exact destination, resource sharing, model,
/// limits, source evidence and observed selections. Secrets remain outside it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlan {
    pub version: u32,
    pub plan_id: ExecutionId,
    pub project_id: ExecutionId,
    pub input: Option<InputEnvelope>,
    pub locale: String,
    pub selection_basis: Vec<PlanSelectionBasis>,
    pub options: PlanOptions,
    pub tools: Option<WorkPlanTools>,
    #[serde(deserialize_with = "required_maintenance")]
    pub maintenance: Option<MaintenancePlanBasis>,
    pub digest: String,
}

impl WorkPlan {
    pub(crate) fn capture(
        project: ProjectId,
        preview: AiPreview,
        mut selection_basis: Vec<PlanSelectionBasis>,
        mut options: PlanOptions,
    ) -> Result<Self, ExecutionError> {
        options.validate()?;
        if preview.recipe != ai::RECIPE
            || preview.digest != ai::preview_digest(&preview.config, &preview.items)?
        {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "work-plan-preview",
            ));
        }
        let locale = preview
            .items
            .first()
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "work-plan-scope"))?
            .target_locale
            .clone();
        let input = Some(preview.fixed_input(project)?.envelope().clone());
        selection_basis.sort_by_key(|basis| basis.unit_id);
        options.stages.sort_by_key(|choice| choice.stage);
        let mut plan = Self {
            version: 3,
            plan_id: ExecutionId::new(),
            project_id: ExecutionId::parse(&project.to_string())?,
            input,
            locale,
            selection_basis,
            options,
            tools: None,
            maintenance: None,
            digest: String::new(),
        };
        plan.digest = plan.computed_digest()?;
        plan.validate()?;
        Ok(plan)
    }

    fn computed_digest(&self) -> Result<String, ExecutionError> {
        Ok(codec::digest(&codec::encode(
            &(
                self.version,
                self.plan_id,
                self.project_id,
                &self.input,
                &self.locale,
                &self.selection_basis,
                &self.options,
                &self.tools,
                &self.maintenance,
            ),
            MAX_INPUT_BYTES,
        )?))
    }

    pub(crate) fn capture_manual(
        project: ProjectId,
        locale: String,
        mut selection_basis: Vec<PlanSelectionBasis>,
        mut options: PlanOptions,
    ) -> Result<Self, ExecutionError> {
        options.validate()?;
        selection_basis.sort_by_key(|basis| basis.unit_id);
        options.stages.sort_by_key(|choice| choice.stage);
        let mut plan = Self {
            version: 3,
            plan_id: ExecutionId::new(),
            project_id: ExecutionId::parse(&project.to_string())?,
            input: None,
            locale,
            selection_basis,
            options,
            tools: None,
            maintenance: None,
            digest: String::new(),
        };
        plan.digest = plan.computed_digest()?;
        plan.validate()?;
        Ok(plan)
    }

    pub(crate) fn with_tools(
        mut self,
        tools: Option<WorkPlanTools>,
    ) -> Result<Self, ExecutionError> {
        self.tools = tools;
        self.digest = self.computed_digest()?;
        self.validate()?;
        Ok(self)
    }

    pub(crate) fn with_maintenance(
        mut self,
        basis: MaintenancePlanBasis,
    ) -> Result<Self, ExecutionError> {
        self.maintenance = Some(basis);
        self.digest = self.computed_digest()?;
        self.validate()?;
        Ok(self)
    }

    pub fn authorization_effects(&self) -> Result<Vec<AutomationEffect>, ExecutionError> {
        self.validate()?;
        let mut effects = self.options.authorization_effects()?;
        if self.tools.is_some() {
            effects.push(AutomationEffect::QueryTools);
        }
        Ok(effects)
    }

    /// Only plans requesting candidate generation have a model execution input.
    pub fn execution_input(&self) -> Result<&InputEnvelope, ExecutionError> {
        self.input
            .as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::Unauthorized, "work-plan-manual"))
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        self.options.validate()?;
        if let Some(basis) = &self.maintenance {
            let units = basis.repair_units()?;
            if basis.assessment.project_id != self.project_id
                || basis.assessment.locale != self.locale
                || units
                    != self
                        .selection_basis
                        .iter()
                        .map(|basis| basis.unit_id)
                        .collect::<Vec<_>>()
                || self.selection_basis.iter().any(|captured| {
                    captured.source_snapshot_id != basis.assessment.source_snapshot_id
                        || !basis.assessment.rows.iter().any(|row| {
                            // A window may show a later occurrence's display key.
                            // The plan keeps its independently captured canonical key.
                            row.unit_id == captured.unit_id
                                && row.source_revision_id == captured.source_revision_id
                                && row.selection_id == captured.selection_id
                        })
                })
            {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "maintenance-scope",
                ));
            }
        }
        if let Some(tools) = &self.tools {
            tools.validate()?;
            if self.input.is_none() {
                return Err(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "work-plan-tool-root",
                ));
            }
        }
        let locale = crate::Locale::parse(&self.locale)
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "work-plan-locale"))?;
        if self.version != 3
            || locale.as_str() != self.locale
            || self.selection_basis.is_empty()
            || self.selection_basis.len() > 1000
            || self
                .selection_basis
                .iter()
                .any(|basis| basis.native_key.is_empty())
            || !self.selection_basis.windows(2).all(|pair| {
                pair[0].unit_id < pair[1].unit_id
                    && pair[0].source_snapshot_id == pair[1].source_snapshot_id
            })
            || !self
                .options
                .stages
                .windows(2)
                .all(|pair| pair[0].stage < pair[1].stage)
            || self.digest != self.computed_digest()?
        {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "work-plan-basis",
            ));
        }
        let Some(envelope) = &self.input else {
            if self.options.requests(AutomationEffect::SaveCandidate) {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "work-plan-model",
                ));
            }
            return Ok(());
        };
        if !self.options.requests(AutomationEffect::SaveCandidate)
            || envelope.project_id != self.project_id
            || envelope.operation != ai::OPERATION
            || envelope.capability_id != ai::CAPABILITY
            || envelope.capability_version != "1"
            || envelope.previous_attempt_id.is_some()
            || envelope.automation.is_some()
            || !envelope.reused_results.is_empty()
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "work-plan-input",
            ));
        }
        let input = FixedInput::capture(envelope.clone())?;
        if input.envelope() != envelope {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "work-plan-order",
            ));
        }
        let settings = ai::settings(&input)?;
        if settings.agent.is_some() {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "work-plan-agent-root",
            ));
        }
        settings.config.validate()?;
        let mut units = BTreeSet::new();
        let mut snapshot = None;
        let mut locale = None;
        for entry in &envelope.items {
            let item = ai::item_payload(&input, entry.item_id)?;
            if !units.insert(item.unit_id)
                || snapshot.is_some_and(|value| value != item.source_snapshot_id)
                || locale
                    .as_ref()
                    .is_some_and(|value| value != &item.target_locale)
                || entry.scope.kind != "translation-unit"
                || entry.scope.id != item.unit_id.to_string()
                || entry.scope.locale.as_ref() != Some(&item.target_locale)
                || (!settings.config.share_terms && !item.terms.is_empty())
                || (!settings.config.share_context && item.context.is_some())
                || item.target_locale != self.locale
                || !self.selection_basis.iter().any(|basis| {
                    basis.unit_id == item.unit_id
                        && basis.source_snapshot_id == item.source_snapshot_id
                        && basis.source_revision_id == item.source_revision_id
                        && basis.native_key == item.native_key
                })
            {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "work-plan-scope",
                ));
            }
            snapshot = Some(item.source_snapshot_id);
            locale = Some(item.target_locale);
        }
        if units.len() > settings.config.max_items as usize
            || self.selection_basis.len() != units.len()
            || self
                .selection_basis
                .iter()
                .map(|basis| basis.unit_id)
                .collect::<BTreeSet<_>>()
                != units
            || !self
                .selection_basis
                .windows(2)
                .all(|pair| pair[0].unit_id < pair[1].unit_id)
            || !self
                .options
                .stages
                .windows(2)
                .all(|pair| pair[0].stage < pair[1].stage)
            || self.digest != self.computed_digest()?
        {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "work-plan-basis",
            ));
        }
        Ok(())
    }

    pub fn fixed_input(&self) -> Result<FixedInput, ExecutionError> {
        self.validate()?;
        FixedInput::capture(self.execution_input()?.clone())
    }
}
pub use crate::persistence::{
    PreparedWorkPlanServiceGeneration, PreparedWorkPlanServiceTool, WorkPlanServiceCall,
    WorkPlanServiceCallIdentity, WorkPlanServiceOrigin, WorkPlanServiceReceipt,
    WorkPlanToolServiceReceipt,
};

#[cfg(test)]
mod agent_binding_tests {
    use super::*;
    #[test]
    fn agent_subset_maximum_proof_fits_the_shared_bound_and_nullable_fields_are_required() {
        let mut units = (0..100).map(|_| ExecutionId::new()).collect::<Vec<_>>();
        units.sort();
        let mut tools = (0..32).map(|_| ExecutionId::new()).collect::<Vec<_>>();
        tools.sort();
        let binding = WorkPlanAgentExecutionBinding {
            lease: AutomationLease {
                plan_id: ExecutionId::new(),
                generation: Revision::new(i64::MAX as u64).unwrap(),
            },
            root_task: ExecutionId::new(),
            caller_id: ExecutionId::new(),
            delegation: Some(WorkPlanAgentSubset {
                delegation_id: ExecutionId::new(),
                parent_scope_id: ExecutionId::new(),
                unit_ids: units,
                tool_handles: tools,
            }),
        };
        let tool = WorkPlanToolDelegation {
            lease: binding.lease,
            root_task: binding.root_task,
            caller_id: binding.caller_id,
            caller: "work-plan-agent".into(),
            tool_handle: ExecutionId::new(),
            delegation: binding.delegation.clone(),
        };
        let bytes = codec::encode(&tool, MAX_AGENT_DELEGATION_BYTES).unwrap();
        assert!(bytes.len() > 4096);
        assert!(bytes.len() <= MAX_AGENT_DELEGATION_BYTES);
        assert_eq!(
            codec::decode::<WorkPlanToolDelegation>(&bytes, MAX_AGENT_DELEGATION_BYTES).unwrap(),
            tool
        );
        assert_eq!(
            codec::decode::<WorkPlanAgentExecutionBinding>(
                &codec::encode(&binding, MAX_AGENT_DELEGATION_BYTES).unwrap(),
                MAX_AGENT_DELEGATION_BYTES
            )
            .unwrap(),
            binding
        );
        let mut root = serde_json::to_value(binding).unwrap();
        root["delegation"] = serde_json::Value::Null;
        serde_json::from_value::<WorkPlanAgentExecutionBinding>(root.clone()).unwrap();
        root.as_object_mut().unwrap().remove("delegation");
        assert!(serde_json::from_value::<WorkPlanAgentExecutionBinding>(root).is_err());
        let mut settings = serde_json::to_value(ai::AiSettings {
            recipe: ai::RECIPE.into(),
            config: ai::AiConfig::default(),
            agent: None,
        })
        .unwrap();
        serde_json::from_value::<ai::AiSettings>(settings.clone()).unwrap();
        settings.as_object_mut().unwrap().remove("agent");
        assert!(serde_json::from_value::<ai::AiSettings>(settings).is_err());
    }
}
