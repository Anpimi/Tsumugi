//! Human preparation creates a new authorization version, never a revived scope.
use super::*;
use crate::execution::{ExecutionError, ExecutionId, Revision};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamEffectiveVersion {
    pub action_id: ExecutionId,
    pub lease: AutomationLease,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamWorkReference {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub input_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamHumanWork {
    pub work_id: ExecutionId,
    pub member_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub kind: TeamWorkKind,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 8192)))]
    pub instructions: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub post_ids: Vec<ExecutionId>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub prior_work: Vec<TeamWorkReference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PrepareTeamRecovery {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub expected_lease: AutomationLease,
    pub expected_effective_version: TeamEffectiveVersion,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 8)))]
    pub members: Vec<TeamExecutionMember>,
    pub work: TeamHumanWork,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryDiscussionPreview {
    pub member_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub through_sequence: Revision,
    pub posts: Vec<TeamDiscussionPost>,
    pub artifacts: Vec<TeamArtifactRead>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryPreview {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub base_lease: AutomationLease,
    pub base_effective_version: TeamEffectiveVersion,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub digest: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 8)))]
    pub members: Vec<TeamExecutionMember>,
    pub retired_member_ids: Vec<ExecutionId>,
    pub member_previews: Vec<TeamMemberPreview>,
    pub discussion_previews: Vec<TeamRecoveryDiscussionPreview>,
    pub work: TeamHumanWork,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub input_digest: String,
    pub root_task_id: ExecutionId,
    pub expires_at_ms: u64,
    pub limits: TeamExecutionLimits,
    pub budget: crate::persistence::ProviderBudget,
    pub activations: u32,
    pub unconfirmed_completions: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AuthorizeTeamRecovery {
    pub action_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub digest: String,
    pub confirmed: bool,
    pub effects: Vec<AutomationEffect>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryReceipt {
    pub action_id: ExecutionId,
    pub base_lease: AutomationLease,
    pub effective_version: TeamEffectiveVersion,
    pub state: WorkPlanState,
    pub cancellation_revision: Revision,
    pub work_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub input_digest: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryState {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub effective_version: TeamEffectiveVersion,
    pub root_task_id: ExecutionId,
    pub expires_at_ms: u64,
    pub budget: crate::persistence::ProviderBudget,
    pub activations: u32,
    pub unconfirmed_completions: u32,
    pub unresolved_work: Vec<TeamWorkReference>,
}

/// A runtime observation is descriptive. It is not a continuation permit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamRecoveryRuntimeState {
    pub original_deadline_available: bool,
    pub producers_drained: bool,
}

#[derive(Clone, Debug)]
pub struct PreparedTeamRecovery {
    pub(crate) capture: TeamRecoveryCapture,
    pub(crate) runtime_generation: ExecutionId,
    pub(crate) deadline: std::time::Instant,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamRecoveryCapture {
    pub(crate) preview: TeamRecoveryPreview,
    pub(crate) request: PrepareTeamRecovery,
    pub(crate) plan: WorkPlan,
    pub(crate) team_inputs: Vec<TeamMemberInput>,
    pub(crate) input: crate::execution::InputEnvelope,
}
impl PreparedTeamRecovery {
    pub fn deadline(&self) -> std::time::Instant {
        self.deadline
    }
    pub fn preview(&self) -> &TeamRecoveryPreview {
        &self.capture.preview
    }
    pub fn plan(&self) -> &WorkPlan {
        &self.capture.plan
    }
    pub fn verify_digest(&self, digest: &str) -> Result<(), ExecutionError> {
        if self.preview().digest == digest {
            Ok(())
        } else {
            Err(ExecutionError::new(
                crate::execution::ErrorCode::ResultMismatch,
                "team-recovery-capture",
            ))
        }
    }
}
