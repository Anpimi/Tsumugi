//! Fixed work plans shared by application entry points.
//!
//! A plan describes requested effects and captured evidence. Preparing or
//! verifying it does not authorize execution, selection, approval or delivery.

use crate::{
    ProjectId,
    ai::{self, AiPreview},
    execution::{
        ErrorCode, ExecutionError, ExecutionId, FixedInput, InputEnvelope, MAX_INPUT_BYTES,
        Revision, codec,
    },
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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
            adopt_resources: false,
            deliver: false,
        }
    }
}

impl PlanOptions {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        let mut stages = BTreeSet::new();
        if self.stages.is_empty()
            || self.stages.len() > 5
            || self
                .stages
                .iter()
                .any(|choice| !stages.insert(choice.stage))
            || (self.selection_policy != SelectionPolicy::CandidatesOnly
                && (!self.assisted(WorkStage::Generation) || !self.assisted(WorkStage::Checks)))
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
        if self.requests(AutomationEffect::RunChecks)
            && self.selection_policy == SelectionPolicy::CandidatesOnly
        {
            // Standalone automatic checking is not yet assembled. The current
            // check permission is exercised by the checked-selection service.
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
pub enum AutomaticSelectionBlock {
    Protected,
    AlreadySelected,
    Checks,
}

/// A policy action is distinct from a human review decision. Replaying this
/// receipt does not select again or restore an older authority or check basis.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomaticSelectionReceipt {
    pub request: AutomaticSelectionRequest,
    pub policy_version: String,
    pub policy: SelectionPolicy,
    pub protection_revision: Revision,
    pub candidate_basis: crate::ReviewBasis,
    pub validator_version: String,
    pub rules: Vec<crate::CheckRuleResult>,
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
            version: 1,
            plan_id: ExecutionId::new(),
            project_id: ExecutionId::parse(&project.to_string())?,
            input,
            locale,
            selection_basis,
            options,
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
            version: 1,
            plan_id: ExecutionId::new(),
            project_id: ExecutionId::parse(&project.to_string())?,
            input: None,
            locale,
            selection_basis,
            options,
            digest: String::new(),
        };
        plan.digest = plan.computed_digest()?;
        plan.validate()?;
        Ok(plan)
    }

    /// Only plans requesting candidate generation have a model execution input.
    pub fn execution_input(&self) -> Result<&InputEnvelope, ExecutionError> {
        self.input
            .as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::Unauthorized, "work-plan-manual"))
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        self.options.validate()?;
        let locale = crate::Locale::parse(&self.locale)
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "work-plan-locale"))?;
        if self.version != 1
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
