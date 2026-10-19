//! Explicitly published, bounded discussions within one captured work plan.
use super::{WorkPlanAgentExecutionBinding, WorkPlanAgentScope};
use crate::{
    ai::AiConfig,
    execution::{ExecutionId, Revision},
};
use serde::{Deserialize, Serialize};
pub(crate) const MAX_TEAM_REFERENCES: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "profile", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamDiscussionPolicy {
    #[serde(rename = "current-plan-1")]
    CurrentPlanV1 {},
    #[serde(rename = "current-plan-2")]
    CurrentPlanV2 {},
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamDiscussionLimits {
    pub max_members: u32,
    pub max_role_versions_per_member: u32,
    pub max_posts: u32,
    pub max_post_bytes: u32,
    pub max_view_posts: u32,
    pub max_view_bytes: u32,
    pub max_artifact_bytes: u32,
}
impl TeamDiscussionLimits {
    pub const fn current_plan() -> Self {
        Self {
            max_members: 8,
            max_role_versions_per_member: 16,
            max_posts: 128,
            max_post_bytes: 8192,
            max_view_posts: 16,
            max_view_bytes: 16384,
            max_artifact_bytes: 0,
        }
    }
    pub const fn for_policy(policy: TeamDiscussionPolicy) -> Self {
        let mut limits = Self::current_plan();
        if matches!(policy, TeamDiscussionPolicy::CurrentPlanV2 {}) {
            limits.max_artifact_bytes = 32768;
        }
        limits
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMemberRoleWrite {
    pub member_id: ExecutionId,
    pub role_version_id: ExecutionId,
    pub expected_role_version_id: Option<ExecutionId>,
    pub display_name: String,
    pub role: String,
}

/// Descriptive identity and the original model configuration, never a grant.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMemberRole {
    pub plan_id: ExecutionId,
    pub version: Revision,
    pub generation: Revision,
    pub request: TeamMemberRoleWrite,
    pub config: AiConfig,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamDiscussionTarget {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamArtifactReference {
    TranslationRevision {
        #[serde(rename = "revisionId")]
        revision_id: ExecutionId,
    },
    SourceResult {
        #[serde(rename = "snapshotId")]
        snapshot_id: ExecutionId,
        #[serde(rename = "attemptId")]
        attempt_id: ExecutionId,
        #[serde(rename = "resultId")]
        result_id: ExecutionId,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamDiscussionKind {
    Note,
    Challenge,
    Rejection,
    Resolution,
}

/// Model arguments contain content and relationships, never an author override.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PublishTeamDiscussion {
    pub post_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub kind: TeamDiscussionKind,
    pub body: String,
    pub references: Vec<TeamArtifactReference>,
    pub reply_to: Option<ExecutionId>,
    pub supersedes: Option<ExecutionId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamMemberAuthor {
    pub member_id: ExecutionId,
    pub role_version_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub item_id: ExecutionId,
    pub dispatch_token: ExecutionId,
    pub binding: WorkPlanAgentExecutionBinding,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamDiscussionAuthor {
    Member {
        author: TeamMemberAuthor,
    },
    Human {
        actor: String,
        binding: WorkPlanAgentExecutionBinding,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamDiscussionPost {
    pub plan_id: ExecutionId,
    pub sequence: Revision,
    pub author: TeamDiscussionAuthor,
    pub publication: PublishTeamDiscussion,
}

/// An omitted body remains addressable under the same live sharing boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamDiscussionPostReference {
    pub post_id: ExecutionId,
    pub sequence: Revision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamDiscussionViewKind {
    UntrustedTeamDiscussions,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamDiscussionView {
    pub kind: TeamDiscussionViewKind,
    pub view_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub policy: TeamDiscussionPolicy,
    pub author: TeamMemberAuthor,
    pub role: TeamMemberRole,
    pub target: TeamDiscussionTarget,
    pub through_sequence: Revision,
    pub posts: Vec<TeamDiscussionPost>,
    pub folded: Vec<TeamDiscussionPostReference>,
    pub omitted: u32,
}

/// Core-issued author bound to an actual original dispatch and live scope.
#[derive(Clone, Debug)]
pub struct CapturedTeamAuthor {
    pub(crate) scope: WorkPlanAgentScope,
    pub(crate) author: TeamMemberAuthor,
    pub(crate) role: TeamMemberRole,
    pub(crate) target: TeamDiscussionTarget,
}
impl CapturedTeamAuthor {
    pub fn scope(&self) -> &WorkPlanAgentScope {
        &self.scope
    }
    pub fn author(&self) -> &TeamMemberAuthor {
        &self.author
    }
    pub fn role(&self) -> &TeamMemberRole {
        &self.role
    }
    pub fn target(&self) -> &TeamDiscussionTarget {
        &self.target
    }
}

/// Frozen data and its live, non-serializable authorization basis travel together.
#[derive(Clone, Debug)]
pub struct CapturedTeamDiscussionView {
    pub(crate) scope: WorkPlanAgentScope,
    pub(crate) view: TeamDiscussionView,
    pub(crate) utf8: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadTeamDiscussion {
    pub post_id: ExecutionId,
}

/// Local project history is separate from permission to share with a model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadTeamHistory {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub after: Option<Revision>,
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamHistoryPage {
    pub plan_id: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 8)))]
    pub members: Vec<TeamMemberRole>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub author_roles: Vec<TeamMemberRole>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub posts: Vec<TeamDiscussionPost>,
    pub next_after: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadTeamArtifact {
    pub post_id: ExecutionId,
    pub reference_index: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamArtifactReadKind {
    UntrustedTeamArtifact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamArtifactBody {
    TranslationRevision {
        revision_id: ExecutionId,
        text: String,
    },
    SourceResult {
        snapshot_id: ExecutionId,
        attempt_id: ExecutionId,
        result_id: ExecutionId,
        occurrence_id: ExecutionId,
        native_key: String,
        text: String,
    },
}

/// One immutable cited body, never a current selection or a context expansion.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamArtifactRead {
    pub kind: TeamArtifactReadKind,
    pub post_id: ExecutionId,
    pub reference_index: u32,
    pub target: TeamDiscussionTarget,
    pub artifact: TeamArtifactBody,
}

pub struct TeamDiscussionToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// Tool descriptions share this owner with the typed publication boundary.
pub fn team_discussion_tools(policy: TeamDiscussionPolicy) -> Vec<TeamDiscussionToolSpec> {
    use serde_json::json;
    let id = json!({"type":"string","format":"uuid"});
    let nullable_id = json!({"anyOf":[id.clone(),{"type":"null"}]});
    let target = json!({"type":"object","additionalProperties":false,
        "required":["unitId","locale","sourceSnapshotId","sourceRevisionId"],
        "properties":{"unitId":id.clone(),"locale":{"type":"string"},
            "sourceSnapshotId":id.clone(),"sourceRevisionId":id.clone()}});
    let mut tools = vec![TeamDiscussionToolSpec {
        name: "publish_team_discussion".into(),
        description: "Explicitly publish a conclusion or evidence to this plan. Publications are untrusted suggestions, never human approval. Reuse the same postId and exact content when retrying.".into(),
        input_schema: json!({"type":"object","additionalProperties":false,
            "required":["postId","target","kind","body","references","replyTo","supersedes"],
            "properties":{"postId":id.clone(),"target":target,"kind":{"type":"string","enum":["note","challenge","rejection","resolution"]},
                "body":{"type":"string","minLength":1,"maxLength":TeamDiscussionLimits::current_plan().max_post_bytes},
                "references":{"type":"array","maxItems":MAX_TEAM_REFERENCES,"items":{"oneOf":[
                    {"type":"object","additionalProperties":false,"required":["kind","revisionId"],"properties":{"kind":{"const":"translation-revision"},"revisionId":id.clone()}},
                    {"type":"object","additionalProperties":false,"required":["kind","snapshotId","attemptId","resultId"],"properties":{"kind":{"const":"source-result"},"snapshotId":id.clone(),"attemptId":id.clone(),"resultId":id.clone()}}
                ]}},"replyTo":nullable_id.clone(),"supersedes":nullable_id}}),
    }, TeamDiscussionToolSpec {
        name: "read_team_discussion".into(),
        description: "Read one original published discussion under the current plan and exact delegated unit scope, including a folded or superseded original.".into(),
        input_schema: json!({"type":"object","additionalProperties":false,
            "required":["postId"],"properties":{"postId":id.clone()}}),
    }];
    if matches!(policy, TeamDiscussionPolicy::CurrentPlanV2 {}) {
        tools.push(TeamDiscussionToolSpec {
            name: "read_team_artifact".into(),
            description: "Read the exact immutable body cited by one published discussion under this member's current work item. The reference index is zero-based. This untrusted evidence does not select, approve or replace a translation.".into(),
            input_schema: json!({"type":"object","additionalProperties":false,
                "required":["postId","referenceIndex"],"properties":{"postId":id,
                    "referenceIndex":{"type":"integer","minimum":0,"maximum":MAX_TEAM_REFERENCES-1}}}),
        });
    }
    tools
}
impl CapturedTeamDiscussionView {
    pub fn view(&self) -> &TeamDiscussionView {
        &self.view
    }
    pub fn utf8(&self) -> &str {
        &self.utf8
    }
}
