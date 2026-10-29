//! Recoverable strategy input and exact requests, without session authority.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tsumugi_core::{CaptureContextStrategy, CaptureStrategyEvaluation, CaptureStrategySuite,
    ContextStrategyCandidate, CorrectionTermEvidence, PromoteContextStrategy, StrategyCheckRequest,
    StrategyJudgmentRequest, StrategyPreference, WithdrawContextStrategy,
    SourceContextSelection, ai::AiConfig, execution::{ExecutionId, Revision, UnsignedDecimal}};
use crate::commands::execution::strategy::StrategySuiteView;

macro_rules! object {
    ($name:ident {$($(#[$meta:meta])* $field:ident:$ty:ty),* $(,)?}) => {
        #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all="camelCase",deny_unknown_fields)]
        #[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
        pub struct $name {$($(#[$meta])* pub $field:$ty),*}
    };
}
object!(StrategyDraftKey {project_id:ExecutionId});
object!(StrategyCaptureOriginal {project_id:ExecutionId,capture:CaptureContextStrategy});
object!(StrategySuiteOriginal {project_id:ExecutionId,capture:CaptureStrategySuite});
object!(StrategyPrepareOriginal {project_id:ExecutionId,capture:CaptureStrategyEvaluation});
object!(StrategyStartOriginal {project_id:ExecutionId,evaluation_id:ExecutionId,attempt_id:ExecutionId,digest:String,confirmed:bool});
object!(StrategyJudgmentOriginal {project_id:ExecutionId,judgment:StrategyJudgmentRequest});
object!(StrategyPromoteOriginal {project_id:ExecutionId,promotion:PromoteContextStrategy});
object!(StrategyWithdrawOriginal {project_id:ExecutionId,withdrawal:WithdrawContextStrategy});
object!(StrategySaveOriginal {project_id:ExecutionId,evaluation_id:ExecutionId,item_id:ExecutionId,result_id:ExecutionId,action_id:ExecutionId});
object!(StrategyCheckOriginal {project_id:ExecutionId,check:StrategyCheckRequest});
object!(StrategyCheckerOriginal {project_id:ExecutionId,attempt_id:ExecutionId,input_digest:String,
    grant_id:ExecutionId,expires_at_ms:UnsignedDecimal,unsandboxed_execution:bool});
object!(StrategyCheckStartOriginal {project_id:ExecutionId,check:StrategyCheckOriginal,executions:Vec<StrategyCheckerOriginal>});

#[derive(Clone,Copy,Debug,Eq,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub enum StrategyDraftRole { Calibration, Holdout }
#[derive(Clone,Copy,Debug,Eq,PartialEq,Ord,PartialOrd,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub enum StrategyDraftNumber {SourceContextMaxBytes,SourceContextMaxItems,ConfigMaxItems,ConfigConcurrency,
    ConfigMaxRequests,ConfigMaxOutputTokens,ConfigMaxRetries,ConfigTimeoutSeconds}
object!(StrategyNumberDraft {text:String,previous:u32});
object!(StrategyJudgmentDraft {preference:Option<StrategyPreference>,notes:String,elapsed:String,modified:String,
    edit_seq:Revision,saved_seq:Revision});

#[derive(Clone,Debug,Eq,PartialEq,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="kebab-case",rename_all_fields="camelCase",deny_unknown_fields)]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub enum StrategyDraftPending {
    Candidate {request:StrategyCaptureOriginal,edit_seq:Revision,submitted_seq:Revision},
    Suite {request:StrategySuiteOriginal,candidate:ContextStrategyCandidate,edit_seq:Revision,submitted_seq:Revision},
    Prepare {request:StrategyPrepareOriginal,suite:StrategySuiteView,edit_seq:Revision,submitted_seq:Revision},
    Start {request:StrategyStartOriginal,edit_seq:Revision,submitted_seq:Revision},
    Judgment {request:StrategyJudgmentOriginal,draft_seq:Revision,edit_seq:Revision,submitted_seq:Revision},
    Promote {request:StrategyPromoteOriginal,edit_seq:Revision,submitted_seq:Revision},
    Withdraw {request:StrategyWithdrawOriginal,edit_seq:Revision,submitted_seq:Revision},
    SaveCandidate {request:StrategySaveOriginal,attempt_id:ExecutionId,unit_id:ExecutionId,edit_seq:Revision,submitted_seq:Revision},
    PrepareCheck {request:StrategyCheckOriginal,unit_id:ExecutionId,locale:String,edit_seq:Revision,submitted_seq:Revision},
    Check {request:StrategyCheckStartOriginal,edit_seq:Revision,submitted_seq:Revision},
}
impl StrategyDraftPending {
    pub fn action_id(&self)->ExecutionId {match self {
        Self::Candidate{request,..}=>request.capture.action_id,
        Self::Suite{request,..}=>request.capture.action_id,
        Self::Prepare{request,..}=>request.capture.action_id,
        Self::Start{request,..}=>request.attempt_id,
        Self::Judgment{request,..}=>request.judgment.action_id,
        Self::Promote{request,..}=>request.promotion.action_id,
        Self::Withdraw{request,..}=>request.withdrawal.action_id,
        Self::SaveCandidate{request,..}=>request.action_id,
        Self::PrepareCheck{request,..}=>request.check.action_id,
        Self::Check{request,..}=>request.check.check.action_id,
    }}
    pub fn project_id(&self)->ExecutionId {match self {
        Self::Candidate{request,..}=>request.project_id,Self::Suite{request,..}=>request.project_id,
        Self::Prepare{request,..}=>request.project_id,Self::Start{request,..}=>request.project_id,
        Self::Judgment{request,..}=>request.project_id,Self::Promote{request,..}=>request.project_id,
        Self::Withdraw{request,..}=>request.project_id,Self::SaveCandidate{request,..}=>request.project_id,
        Self::PrepareCheck{request,..}=>request.project_id,Self::Check{request,..}=>request.project_id,
    }}
    pub fn submitted_seq(&self)->Revision {match self {
        Self::Candidate{submitted_seq,..}|Self::Suite{submitted_seq,..}|Self::Prepare{submitted_seq,..}
        |Self::Start{submitted_seq,..}|Self::Judgment{submitted_seq,..}|Self::Promote{submitted_seq,..}
        |Self::Withdraw{submitted_seq,..}|Self::SaveCandidate{submitted_seq,..}|Self::PrepareCheck{submitted_seq,..}
        |Self::Check{submitted_seq,..}=>*submitted_seq,
    }}
    pub fn edit_seq(&self)->Revision {match self {
        Self::Candidate{edit_seq,..}|Self::Suite{edit_seq,..}|Self::Prepare{edit_seq,..}
        |Self::Start{edit_seq,..}|Self::Judgment{edit_seq,..}|Self::Promote{edit_seq,..}
        |Self::Withdraw{edit_seq,..}|Self::SaveCandidate{edit_seq,..}|Self::PrepareCheck{edit_seq,..}
        |Self::Check{edit_seq,..}=>*edit_seq,
    }}
}

object!(StrategyDraftValue {journal_seq:Revision,edit_seq:Revision,locale:String,correction_unit:String,
    #[serde(default,skip_serializing_if="BTreeMap::is_empty")]
    number_drafts:BTreeMap<StrategyDraftNumber,StrategyNumberDraft>,
    evidence:Option<CorrectionTermEvidence>,source_context:SourceContextSelection,reason:String,exceptions:String,
    config:AiConfig,roles:BTreeMap<String,StrategyDraftRole>,candidate:Option<ContextStrategyCandidate>,
    suite:Option<StrategySuiteView>,evaluation_id:Option<ExecutionId>,judgments:BTreeMap<String,StrategyJudgmentDraft>,
    candidate_edit_seq:Revision,candidate_saved_seq:Revision,suite_edit_seq:Revision,suite_saved_seq:Revision,
    pending:Option<StrategyDraftPending>});
object!(StrategyDraftHead {key:StrategyDraftKey,revision:Revision,writer_id:Option<ExecutionId>,value:Option<StrategyDraftValue>});
object!(StrategyDraftWrite {key:StrategyDraftKey,expected_revision:Revision,writer_id:ExecutionId,value:StrategyDraftValue});
object!(StrategyDraftClear {key:StrategyDraftKey,expected_revision:Revision});
#[derive(Clone,Copy,Debug,Eq,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub enum StrategyDraftDisposition {Recorded,Prepared,ConfirmedNotApplied,Rejected}
object!(StrategyDraftResolve {write:StrategyDraftWrite,pending:StrategyDraftPending,disposition:StrategyDraftDisposition});
object!(StrategyDraftPage {items:Vec<StrategyDraftHead>,next_after:Option<StrategyDraftKey>});
object!(StrategyDraftAction {pending:StrategyDraftPending,disposition:Option<StrategyDraftDisposition>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    rejection:Option<crate::commands::CommandError>});
