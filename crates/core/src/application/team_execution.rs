//! Bounded, explicitly authorized collaboration within one work plan.
use super::{
    TeamArtifactReference, TeamDiscussionTarget, TeamDiscussionView, TeamMemberAuthor,
    TeamMemberRole, WorkPlanAgentExecutionBinding,
};
use crate::{
    ai::{AiConfig, AiItem, Usage},
    execution::{ExecutionId, ExecutionState, Revision, ValidationState},
};
use serde::{Deserialize, Serialize};

pub const MAX_TEAM_MESSAGES: u32 = 256;
pub const MAX_TEAM_PAGE: u32 = 16;
pub const MAX_TEAM_PAGE_BYTES: usize = 2 * 1024 * 1024;

impl super::WorkPlan {
    pub(crate) fn validate_team(
        &self,
        root: &AiConfig,
    ) -> Result<(), crate::execution::ExecutionError> {
        self.validate_team_members(root, true)
    }
    pub(crate) fn validate_team_members(
        &self,
        root: &AiConfig,
        initial: bool,
    ) -> Result<(), crate::execution::ExecutionError> {
        use std::collections::BTreeSet;
        let fail = || {
            crate::execution::ExecutionError::new(
                crate::execution::ErrorCode::InvalidInput,
                "team-policy",
            )
        };
        let Some(policy) = &self.options.team_execution else {
            return if self.team_inputs.is_empty() {
                Ok(())
            } else {
                Err(fail())
            };
        };
        let limits = policy.limits();
        if policy.members().is_empty()
            || policy.members().len() > 8
            || policy
                .members()
                .iter()
                .map(|m| m.member_id)
                .collect::<BTreeSet<_>>()
                .len()
                != policy.members().len()
            || policy
                .members()
                .iter()
                .map(|m| m.role_version_id)
                .collect::<BTreeSet<_>>()
                .len()
                != policy.members().len()
            || !(1..=root.max_requests.min(300)).contains(&limits.max_activations)
            || !(1..=8.min(root.concurrency).min(limits.max_activations))
                .contains(&limits.max_concurrency)
            || !(1..=limits.max_activations).contains(&limits.max_no_progress)
            || self.team_inputs.len() != policy.members().len()
        {
            return Err(fail());
        }
        if initial {
            let initial = policy
                .members()
                .iter()
                .find(|m| m.member_id == policy.initial_member_id())
                .ok_or_else(fail)?;
            if !initial.unit_ids.contains(&policy.initial_unit_id())
                || !initial.kinds.contains(&TeamWorkKind::Translation)
            {
                return Err(fail());
            }
        }
        for member in policy.members() {
            member.config.validate()?;
            if member.config.max_requests > root.max_requests {
                return Err(fail());
            }
            let units = member.unit_ids.iter().copied().collect::<BTreeSet<_>>();
            let tools = member.tool_handles.iter().copied().collect::<BTreeSet<_>>();
            if member.display_name.trim().is_empty()
                || member.display_name.len() > 128
                || member.role.trim().is_empty()
                || member.role.len() > 8192
                || member.kinds.is_empty()
                || member.kinds.len() > 3
                || member
                    .kinds
                    .iter()
                    .enumerate()
                    .any(|(i, k)| member.kinds[..i].contains(k))
                || units.is_empty()
                || units.len() != member.unit_ids.len()
                || units.len() > member.config.max_items as usize
                || tools.len() != member.tool_handles.len()
                || tools.len() > 32
                || units
                    .iter()
                    .any(|id| !self.selection_basis.iter().any(|b| b.unit_id == *id))
                || tools.iter().any(|id| {
                    !self
                        .tools
                        .as_ref()
                        .is_some_and(|t| t.entries.iter().any(|e| e.handle == *id))
                })
            {
                return Err(fail());
            }
            let captured = self
                .team_inputs
                .iter()
                .find(|p| p.member_id == member.member_id)
                .ok_or_else(fail)?;
            if captured.items.len() != units.len()
                || captured
                    .items
                    .iter()
                    .map(|i| i.unit_id)
                    .collect::<BTreeSet<_>>()
                    != units
            {
                return Err(fail());
            }
            for item in &captured.items {
                if !self.selection_basis.iter().any(|b| {
                    b.unit_id == item.unit_id
                        && b.source_snapshot_id == item.source_snapshot_id
                        && b.source_revision_id == item.source_revision_id
                }) || item.target_locale != self.locale
                    || !member.config.share_terms && !item.terms.is_empty()
                    || !member.config.share_context && item.context.is_some()
                {
                    return Err(fail());
                }
                crate::ai::validate_source_context(&member.config, item, Some(self.project_id))?;
            }
        }
        Ok(())
    }
}

/// Sealed by the original Store; serialized work data alone cannot admit a run.
#[derive(Clone, Debug)]
pub struct PreparedTeamWork {
    pub(crate) scope: Option<super::WorkPlanAgentScope>,
    pub(crate) author: Option<super::TeamMemberAuthor>,
    pub(crate) request: Option<RequestTeamWork>,
    pub(crate) input: crate::execution::FixedInput,
    pub(crate) receipt: TeamWorkReceipt,
    pub(crate) authorization_action: Option<ExecutionId>,
}
impl PreparedTeamWork {
    pub fn input(&self) -> &crate::execution::FixedInput {
        &self.input
    }
    pub fn receipt(&self) -> &TeamWorkReceipt {
        &self.receipt
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamWorkKind {
    Translation,
    Review,
    Evidence,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamExecutionMember {
    pub member_id: ExecutionId,
    pub role_version_id: ExecutionId,
    pub display_name: String,
    pub role: String,
    pub config: AiConfig,
    pub unit_ids: Vec<ExecutionId>,
    pub tool_handles: Vec<ExecutionId>,
    pub kinds: Vec<TeamWorkKind>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamExecutionLimits {
    pub max_activations: u32,
    pub max_concurrency: u32,
    pub max_no_progress: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "profile", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamExecutionPolicy {
    #[serde(rename = "bounded-team-1", rename_all = "camelCase")]
    BoundedTeamV1 {
        initial_member_id: ExecutionId,
        initial_unit_id: ExecutionId,
        members: Vec<TeamExecutionMember>,
        limits: TeamExecutionLimits,
    },
}
impl TeamExecutionPolicy {
    pub fn members(&self) -> &[TeamExecutionMember] {
        let Self::BoundedTeamV1 { members, .. } = self;
        members
    }
    pub fn limits(&self) -> TeamExecutionLimits {
        let Self::BoundedTeamV1 { limits, .. } = self;
        *limits
    }
    pub fn initial_member_id(&self) -> ExecutionId {
        let Self::BoundedTeamV1 {
            initial_member_id, ..
        } = self;
        *initial_member_id
    }
    pub fn initial_unit_id(&self) -> ExecutionId {
        let Self::BoundedTeamV1 {
            initial_unit_id, ..
        } = self;
        *initial_unit_id
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMemberPreview {
    pub member_id: ExecutionId,
    pub preview: crate::ai::AiPreview,
}

/// Prepared separately under each member's actual sharing configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMemberInput {
    pub member_id: ExecutionId,
    pub items: Vec<AiItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TeamWorkBinding {
    Root {
        member_id: ExecutionId,
        role_version_id: ExecutionId,
        scope: WorkPlanAgentExecutionBinding,
    },
    Child {
        intent_id: ExecutionId,
        member_id: ExecutionId,
        role_version_id: ExecutionId,
        scope: WorkPlanAgentExecutionBinding,
    },
    HumanContinuation {
        work_id: ExecutionId,
        member_id: ExecutionId,
        role_version_id: ExecutionId,
        scope: WorkPlanAgentExecutionBinding,
    },
}
impl TeamWorkBinding {
    pub fn scope(&self) -> &WorkPlanAgentExecutionBinding {
        match self {
            Self::Root { scope, .. }
            | Self::Child { scope, .. }
            | Self::HumanContinuation { scope, .. } => scope,
        }
    }
    pub fn member_id(&self) -> ExecutionId {
        match self {
            Self::Root { member_id, .. }
            | Self::Child { member_id, .. }
            | Self::HumanContinuation { member_id, .. } => *member_id,
        }
    }
    pub fn role_version_id(&self) -> ExecutionId {
        match self {
            Self::Root {
                role_version_id, ..
            }
            | Self::Child {
                role_version_id, ..
            }
            | Self::HumanContinuation {
                role_version_id, ..
            } => *role_version_id,
        }
    }
    pub fn is_root(&self) -> bool {
        matches!(self, Self::Root { .. })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamWorkRequestView {
    pub kind: TeamWorkViewKind,
    pub view_id: ExecutionId,
    pub work: TeamWorkReceipt,
    pub author: TeamMemberAuthor,
    pub discussion: TeamDiscussionView,
    pub messages: Vec<TeamMessage>,
    pub recipients: Vec<TeamWorkRecipient>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamWorkRecipient {
    pub member_id: ExecutionId,
    pub display_name: String,
    pub role: String,
    pub unit_ids: Vec<ExecutionId>,
    pub kinds: Vec<TeamWorkKind>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TeamWorkViewKind {
    UntrustedTeamWork,
}
#[derive(Clone, Debug)]
pub struct CapturedTeamWorkView {
    pub(crate) view: TeamWorkRequestView,
    pub(crate) utf8: String,
}
impl CapturedTeamWorkView {
    pub fn view(&self) -> &TeamWorkRequestView {
        &self.view
    }
    pub fn utf8(&self) -> &str {
        &self.utf8
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct RequestTeamWork {
    pub intent_id: ExecutionId,
    pub recipient_member_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub kind: TeamWorkKind,
    pub instructions: String,
    pub post_ids: Vec<ExecutionId>,
    pub cause_message_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SendTeamMessage {
    pub message_id: ExecutionId,
    pub recipient_member_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub body: String,
    pub post_ids: Vec<ExecutionId>,
    pub cause_message_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamWorkReceipt {
    pub intent_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub member_id: ExecutionId,
    pub role_version_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMessage {
    pub message_id: ExecutionId,
    pub sequence: Revision,
    pub plan_id: ExecutionId,
    pub sender: TeamMemberAuthor,
    pub recipient_member_id: ExecutionId,
    pub recipient_role_version_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub body: String,
    pub post_ids: Vec<ExecutionId>,
    pub cause_message_id: Option<ExecutionId>,
}

/// Presentation in an admitted request, not proof of a remote model's understanding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMessageConsumption {
    pub message_id: ExecutionId,
    pub task_id: ExecutionId,
    pub provider_request_id: ExecutionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamReviewBasis {
    Post { post_id: ExecutionId },
    Artifact { reference: TeamArtifactReference },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamReviewVerdict {
    Accept,
    Revise,
    Unresolved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamWorkOutcome {
    Translation {
        unit_id: ExecutionId,
        target_locale: String,
        text: String,
    },
    Review {
        reviewed: TeamReviewBasis,
        post_ids: Vec<ExecutionId>,
        verdict: TeamReviewVerdict,
    },
    Evidence {
        post_ids: Vec<ExecutionId>,
    },
    Waiting {
        requested_intent_ids: Vec<ExecutionId>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamWorkOutput {
    pub outcome: TeamWorkOutcome,
    pub usage: Option<Usage>,
    pub requests: u32,
    pub usage_incomplete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamStopReason {
    ActivationLimit,
    NoProgress,
    Expired,
    BudgetExhausted,
    NeedsReconciliation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamWorkView {
    pub origin: TeamWorkOrigin,
    pub sequence: Revision,
    pub receipt: TeamWorkReceipt,
    pub author: Option<TeamMemberAuthor>,
    pub request: Option<RequestTeamWork>,
    pub target: TeamDiscussionTarget,
    pub execution: ExecutionState,
    pub validation: ValidationState,
    pub output: Option<TeamWorkOutput>,
    pub candidate_revision_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadTeamExecution {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub after_work: Option<Revision>,
    pub after_message: Option<Revision>,
    pub limit: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamExecutionView {
    pub plan_id: ExecutionId,
    pub effective_version: super::TeamEffectiveVersion,
    pub roster: Vec<TeamExecutionMember>,
    pub retired_member_ids: Vec<ExecutionId>,
    pub role_versions: Vec<TeamMemberRole>,
    pub members: Vec<TeamMemberRole>,
    pub works: Vec<TeamWorkView>,
    pub messages: Vec<TeamMessage>,
    pub consumptions: Vec<TeamMessageConsumption>,
    pub budget: Option<crate::persistence::ProviderBudget>,
    pub stop_reason: Option<TeamStopReason>,
    pub next_work_after: Option<Revision>,
    pub next_message_after: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamWorkOrigin {
    Start {
        action_id: ExecutionId,
    },
    Member {},
    HumanContinuation {
        action_id: ExecutionId,
        work: super::TeamHumanWork,
    },
}

pub fn team_execution_tools() -> Vec<super::TeamDiscussionToolSpec> {
    let id = serde_json::json!({"type":"string","format":"uuid"});
    let target = serde_json::json!({"type":"object","properties":{"unitId":id,"locale":{"type":"string"},"sourceSnapshotId":id,"sourceRevisionId":id},"required":["unitId","locale","sourceSnapshotId","sourceRevisionId"],"additionalProperties":false});
    let ids = serde_json::json!({"type":"array","items":id,"maxItems":16,"uniqueItems":true});
    let mut properties = serde_json::json!({"recipientMemberId":id,"target":target,"postIds":ids,"causeMessageId":{"anyOf":[id,{"type":"null"}]}});
    properties["intentId"] = id.clone();
    properties["kind"] =
        serde_json::json!({"type":"string","enum":["translation","review","evidence"]});
    properties["instructions"] =
        serde_json::json!({"type":"string","minLength":1,"maxLength":8192});
    let work=super::TeamDiscussionToolSpec{name:"request_team_work".into(),description:"Request one bounded work activation for a preauthorized member. Returns a durable queue receipt immediately; never waits for another member. Later work may return to this member after its producer drains.".into(),input_schema:serde_json::json!({"type":"object","properties":properties,"required":["intentId","recipientMemberId","target","kind","instructions","postIds","causeMessageId"],"additionalProperties":false})};
    let mut properties = serde_json::json!({"messageId":id,"recipientMemberId":id,"target":target,"body":{"type":"string","minLength":1,"maxLength":8192},"postIds":ids,"causeMessageId":{"anyOf":[id,{"type":"null"}]}});
    // Sending records the message only; a work request explicitly starts an activation.
    properties["messageId"] = id;
    let message=super::TeamDiscussionToolSpec{name:"send_team_message".into(),description:"Record a directed message. This receipt confirms local reception only; sending does not wake a member or prove model consumption.".into(),input_schema:serde_json::json!({"type":"object","properties":properties,"required":["messageId","recipientMemberId","target","body","postIds","causeMessageId"],"additionalProperties":false})};
    vec![work, message]
}
