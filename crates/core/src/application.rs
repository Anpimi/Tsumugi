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
pub enum WorkStage {
    Understanding,
    Resources,
    Generation,
    Checks,
    Delivery,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StageMode {
    Manual,
    Assisted,
    Skipped,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageChoice {
    pub stage: WorkStage,
    pub mode: StageMode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelectionPolicy {
    CandidatesOnly,
    MissingOnly,
    ReplaceCapturedSelection,
}

/// Requested automatic effects, never a human language-review approval.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
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
pub struct AutomationLease {
    pub plan_id: ExecutionId,
    pub generation: Revision,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkPlanState {
    Active,
    Paused,
    Stopped,
    TakenOver,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
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
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub effects: Vec<AutomationEffect>,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
                && !self.assisted(WorkStage::Generation))
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
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanSelectionBasis {
    pub unit_id: ExecutionId,
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
    pub input: InputEnvelope,
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
        let input = preview.fixed_input(project)?.envelope().clone();
        selection_basis.sort_by_key(|basis| basis.unit_id);
        options.stages.sort_by_key(|choice| choice.stage);
        let mut plan = Self {
            version: 1,
            plan_id: ExecutionId::new(),
            project_id: ExecutionId::parse(&project.to_string())?,
            input,
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
                &self.selection_basis,
                &self.options,
            ),
            MAX_INPUT_BYTES,
        )?))
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        self.options.validate()?;
        if self.version != 1
            || self.input.project_id != self.project_id
            || self.input.operation != ai::OPERATION
            || self.input.capability_id != ai::CAPABILITY
            || self.input.capability_version != "1"
            || self.input.previous_attempt_id.is_some()
            || self.input.automation.is_some()
            || !self.input.reused_results.is_empty()
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "work-plan-input",
            ));
        }
        let input = FixedInput::capture(self.input.clone())?;
        // Capture is canonical. Reject noncanonical payloads instead of allowing
        // different authorization identities for the same logical plan.
        if input.envelope() != &self.input {
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
        for entry in &self.input.items {
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
        FixedInput::capture(self.input.clone())
    }
}
