//! Explicit member questions and local human responses share the team post history.
use super::{TeamArtifactReference, TeamDiscussionPost, TeamDiscussionTarget};
use crate::execution::{ExecutionId, Revision};
use serde::{Deserialize, Serialize};

pub const MAX_TEAM_QUESTION_OPTIONS: usize = 8;
pub const MAX_TEAM_QUESTION_OPTION_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "profile", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamQuestionPolicy {
    #[serde(rename = "current-plan-1")]
    CurrentPlanV1 {},
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamQuestionOption {
    pub option_id: ExecutionId,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AskHumanQuestion {
    pub post_id: ExecutionId,
    pub target: TeamDiscussionTarget,
    pub body: String,
    pub options: Vec<TeamQuestionOption>,
    pub references: Vec<TeamArtifactReference>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamQuestionAnswer {
    Choice { option_id: ExecutionId },
    Text {},
}

/// The body and target remain in the original publication fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamQuestionEvent {
    Open { options: Vec<TeamQuestionOption> },
    Resolve { question_post_id: ExecutionId, answer: TeamQuestionAnswer },
    Dismiss { question_post_id: ExecutionId },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamQuestionResponse {
    Choice { option_id: ExecutionId },
    Text { body: String },
    Dismiss { reason: String },
}

/// An immutable local action identity; it never captures an automation permit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct RespondTeamQuestion {
    pub post_id: ExecutionId,
    pub question_post_id: ExecutionId,
    pub response: TeamQuestionResponse,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamQuestionState { Open, Resolved, Dismissed }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamQuestionView {
    pub question: TeamDiscussionPost,
    pub state: TeamQuestionState,
    pub response: Option<TeamDiscussionPost>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadTeamQuestions {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub after: Option<Revision>,
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamQuestionsPage {
    pub plan_id: ExecutionId,
    pub questions: Vec<TeamQuestionView>,
    pub next_after: Option<Revision>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TeamQuestionResponseOutcome {
    Recorded { receipt: TeamDiscussionPost },
    Pending {},
    ClosedByOther { receipt: TeamDiscussionPost },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamQuestionResponseSettlement {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub request: RespondTeamQuestion,
    pub outcome: TeamQuestionResponseOutcome,
}

pub fn team_question_tool() -> super::TeamDiscussionToolSpec {
    let id = serde_json::json!({"type":"string","format":"uuid"});
    let mut parameters = super::team_discussion_tools(super::TeamDiscussionPolicy::CurrentPlanV1 {})
        .remove(0).input_schema;
    let properties = parameters["properties"].as_object_mut().unwrap();
    for name in ["kind", "replyTo", "supersedes"] { properties.remove(name); }
    properties.insert("options".into(), serde_json::json!({"type":"array","maxItems":MAX_TEAM_QUESTION_OPTIONS,
        "items":{"type":"object","additionalProperties":false,"required":["optionId","label"],
            "properties":{"optionId":id,"label":{"type":"string","minLength":1,"maxLength":MAX_TEAM_QUESTION_OPTION_BYTES}}}}));
    parameters["required"] = serde_json::json!(["postId","target","body","options","references"]);
    super::TeamDiscussionToolSpec {
        name: "ask_human".into(),
        description: "Publish one explicit question for a local human about this captured work item. Supply optional choices; free-text answers remain possible. Reuse the same postId and exact content when retrying. This records a question without waiting synchronously or granting permissions. Finish with awaiting-human and the returned question postId when a human answer is needed.".into(),
        input_schema: parameters,
    }
}
