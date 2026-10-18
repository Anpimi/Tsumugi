//! Project-local context strategies, independent experiments and explicit promotion.
use super::*;
use crate::{
    ai::{AiConfig, arena::ArenaPreview},
    content::SourceReviewBinding,
    execution::{Cancellation, FixedInput},
    persistence::review::{CheckRuleResult, ReviewBasis, ReviewCheckEvidence},
};

mod storage;
pub(in crate::persistence) use storage::{
    initialize, table_names, validate, verify_admission, verify_config, verify_input_binding,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextStrategyReference {
    pub project_id: ExecutionId,
    pub revision_id: ExecutionId,
    pub candidate_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CaptureContextStrategy {
    pub action_id: ExecutionId,
    pub basis: CorrectionTermBasis,
    pub source_context: SourceContextSelection,
    pub reason: String,
    pub exceptions: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextStrategyCandidate {
    pub candidate_id: ExecutionId,
    pub project_id: ExecutionId,
    pub locale: String,
    /// Exact reads project `current` from the original correction chain;
    /// immutable action receipts retain its value at capture time.
    pub evidence: CorrectionTermEvidence,
    pub source_context: SourceContextSelection,
    pub reason: String,
    pub exceptions: String,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CaptureStrategySuite {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub candidate_id: ExecutionId,
    pub config: AiConfig,
    pub calibration_unit_ids: Vec<ExecutionId>,
    pub holdout_unit_ids: Vec<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategySuiteUnit {
    pub unit_id: ExecutionId,
    pub holdout: bool,
    pub source_revision_id: ExecutionId,
    pub review_basis: ReviewBasis,
    pub terms: TermResolution,
    pub source_binding: SourceReviewBinding,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategySuite {
    pub suite_id: ExecutionId,
    pub request: CaptureStrategySuite,
    pub candidate_id: ExecutionId,
    pub project_id: ExecutionId,
    pub locale: String,
    pub preview: ArenaPreview,
    pub units: Vec<StrategySuiteUnit>,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct CaptureStrategyEvaluation {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub candidate_id: ExecutionId,
    pub suite_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyEvaluation {
    pub evaluation_id: ExecutionId,
    pub request: CaptureStrategyEvaluation,
    pub project_id: ExecutionId,
    pub candidate_id: ExecutionId,
    pub suite_id: ExecutionId,
    pub locale: String,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyEvaluationBinding {
    pub project_id: ExecutionId,
    pub evaluation_id: ExecutionId,
    pub candidate_id: ExecutionId,
    pub suite_id: ExecutionId,
    pub suite_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyCheckRequest {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub evaluation_id: ExecutionId,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyCheckReceipt {
    pub request: StrategyCheckRequest,
    pub revision_id: ExecutionId,
    pub basis: ReviewBasis,
    pub rules: Vec<CheckRuleResult>,
    pub evidence: ReviewCheckEvidence,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum StrategyPreference {
    CandidatePreferred,
    Equivalent,
    BaselinePreferred,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyJudgmentRequest {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub evaluation_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub expected_judgment_id: Option<ExecutionId>,
    pub preference: StrategyPreference,
    pub notes: String,
    /// Explicit human reports, never provider/clock measurements.
    pub elapsed_seconds: Option<u32>,
    pub modified_characters: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyJudgment {
    pub judgment_id: ExecutionId,
    pub request: StrategyJudgmentRequest,
    pub baseline_result_id: ExecutionId,
    pub candidate_result_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PromoteContextStrategy {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub evaluation_id: ExecutionId,
    pub expected_revision_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WithdrawContextStrategy {
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub locale: String,
    pub expected_revision_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContextStrategyDefaultRevision {
    pub revision_id: ExecutionId,
    pub action_id: ExecutionId,
    pub project_id: ExecutionId,
    pub locale: String,
    pub previous_revision_id: Option<ExecutionId>,
    pub reference: Option<ContextStrategyReference>,
    pub evaluation_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum StrategyActionReceipt {
    Candidate {
        request: CaptureContextStrategy,
        candidate: ContextStrategyCandidate,
    },
    Suite {
        request: CaptureStrategySuite,
        suite: StrategySuite,
    },
    Evaluation {
        request: CaptureStrategyEvaluation,
        evaluation: StrategyEvaluation,
    },
    Check {
        receipt: StrategyCheckReceipt,
    },
    Judgment {
        judgment: StrategyJudgment,
    },
    Promoted {
        request: PromoteContextStrategy,
        revision: ContextStrategyDefaultRevision,
    },
    Withdrawn {
        request: WithdrawContextStrategy,
        revision: ContextStrategyDefaultRevision,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyEvaluationStartRead {
    pub project_id: ExecutionId,
    pub evaluation_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub task_id: ExecutionId,
    pub digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyCandidateSaveRequest {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub evaluation_id: ExecutionId,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyCandidateSaveRead {
    pub request: StrategyCandidateSaveRequest,
    pub adoption: crate::execution::AdoptionActionRead,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyEvaluationView {
    pub evaluation: StrategyEvaluation,
    pub candidate: ContextStrategyCandidate,
    pub suite: StrategySuite,
    pub checks: Vec<StrategyCheckReceipt>,
    pub judgments: Vec<StrategyJudgment>,
    pub slots: Vec<StrategyEvaluationSlot>,
    pub current: bool,
}

/// Original profile roles, independent of Arena's randomized display labels.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyEvaluationSlot {
    pub item_id: ExecutionId,
    pub unit_id: ExecutionId,
    /// Zero is the direct baseline; one is the proposed context selection.
    pub slot: u32,
    pub result_id: Option<ExecutionId>,
}

macro_rules! page {
    ($name:ident,$row:ty) => {
        #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
        pub struct $name {
            pub rows: Vec<$row>,
            pub next_offset: Option<u32>,
        }
    };
}
page!(ContextStrategyCandidatePage, ContextStrategyCandidate);
page!(ContextStrategyDefaultPage, ContextStrategyDefaultRevision);
page!(StrategyEvaluationPage, StrategyEvaluation);
