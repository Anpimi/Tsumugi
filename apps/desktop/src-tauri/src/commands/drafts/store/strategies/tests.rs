use super::*;
use crate::commands::{drafts::*,execution::{ai_wire::ArenaPreviewView,strategy::StrategySuiteView}};
use std::collections::BTreeMap;
use tsumugi_core::{CaptureContextStrategy,CaptureStrategySuite,CaptureStrategyEvaluation,ContextStrategyCandidate,
    CorrectionTermEvidence,StrategyCheckRequest,StrategyJudgmentRequest,StrategyPreference,PromoteContextStrategy,
    WithdrawContextStrategy,ai::{AiConfig,arena::ArenaConfig}};

fn rev(n:u64)->Revision{Revision::new(n).unwrap()}
pub(in crate::commands::drafts) fn value()->StrategyDraftValue{
    StrategyDraftValue{number_drafts:BTreeMap::new(),journal_seq:rev(1),edit_seq:rev(1),locale:"zh-CN".into(),correction_unit:String::new(),evidence:None,
        source_context:Default::default(),reason:"Unfinished reason {{name}} 中文".into(),exceptions:String::new(),
        config:AiConfig{endpoint:String::new(),model:String::new(),max_requests:0,..Default::default()},roles:BTreeMap::new(),
        candidate:None,suite:None,evaluation_id:None,judgments:BTreeMap::new(),candidate_edit_seq:rev(1),candidate_saved_seq:rev(0),
        suite_edit_seq:rev(0),suite_saved_seq:rev(0),pending:None}
}
fn originals(project:ExecutionId)->Vec<StrategyDraftPending>{
    let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../../../../test/fixtures/resourceCommands.contract.json")).unwrap();
    let mut evidence:CorrectionTermEvidence=serde_json::from_value(fixture["responses"]["correctionBasis"].clone()).unwrap();
    evidence.basis.project_id=project;
    let capture=CaptureContextStrategy{action_id:ExecutionId::new(),basis:evidence.basis.clone(),source_context:Default::default(),
        reason:"Original reason A".into(),exceptions:"Original exceptions".into()};
    let candidate=ContextStrategyCandidate{candidate_id:capture.action_id,project_id:project,locale:"zh-CN".into(),evidence,
        source_context:capture.source_context.clone(),reason:capture.reason.clone(),exceptions:capture.exceptions.clone(),digest:"a".repeat(64)};
    let suite_capture=CaptureStrategySuite{action_id:ExecutionId::new(),project_id:project,candidate_id:candidate.candidate_id,
        config:AiConfig::default(),calibration_unit_ids:vec![ExecutionId::new()],holdout_unit_ids:vec![ExecutionId::new()]};
    let suite=StrategySuiteView{suite_id:suite_capture.action_id,request:suite_capture.clone(),candidate_id:candidate.candidate_id,
        project_id:project,locale:"zh-CN".into(),preview:ArenaPreviewView{config:ArenaConfig{variants:vec![AiConfig::default();2],
            max_items:2,max_requests:4,concurrency:1,blind:true,parent_attempt_id:None},items:vec![],digest:"b".repeat(64)},units:vec![],digest:"c".repeat(64)};
    let prepare=CaptureStrategyEvaluation{action_id:ExecutionId::new(),project_id:project,candidate_id:candidate.candidate_id,suite_id:suite.suite_id};
    let check=StrategyCheckOriginal{project_id:project,check:StrategyCheckRequest{project_id:project,action_id:ExecutionId::new(),
        evaluation_id:prepare.action_id,item_id:ExecutionId::new(),result_id:ExecutionId::new()}};
    let attempt=ExecutionId::new();let unit=ExecutionId::new();
    vec![
        StrategyDraftPending::Candidate{request:StrategyCaptureOriginal{project_id:project,capture},edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Suite{request:StrategySuiteOriginal{project_id:project,capture:suite_capture},candidate,edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Prepare{request:StrategyPrepareOriginal{project_id:project,capture:prepare.clone()},suite,edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Start{request:StrategyStartOriginal{project_id:project,evaluation_id:prepare.action_id,attempt_id:attempt,digest:"d".repeat(64),confirmed:true},edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Judgment{request:StrategyJudgmentOriginal{project_id:project,judgment:StrategyJudgmentRequest{action_id:ExecutionId::new(),project_id:project,evaluation_id:prepare.action_id,unit_id:unit,expected_judgment_id:None,
            preference:StrategyPreference::Equivalent,notes:"Original judgment A".into(),elapsed_seconds:None,modified_characters:None}},draft_seq:rev(5),edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Promote{request:StrategyPromoteOriginal{project_id:project,promotion:PromoteContextStrategy{action_id:ExecutionId::new(),project_id:project,evaluation_id:prepare.action_id,expected_revision_id:None}},edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Withdraw{request:StrategyWithdrawOriginal{project_id:project,withdrawal:WithdrawContextStrategy{action_id:ExecutionId::new(),project_id:project,locale:"zh-CN".into(),expected_revision_id:None}},edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::SaveCandidate{request:StrategySaveOriginal{project_id:project,evaluation_id:prepare.action_id,item_id:check.check.item_id,result_id:check.check.result_id,action_id:ExecutionId::new()},attempt_id:attempt,unit_id:unit,edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::PrepareCheck{request:check.clone(),unit_id:unit,locale:"zh-CN".into(),edit_seq:rev(1),submitted_seq:rev(1)},
        StrategyDraftPending::Check{request:StrategyCheckStartOriginal{project_id:project,check,executions:vec![StrategyCheckerOriginal{project_id:project,attempt_id:ExecutionId::new(),input_digest:"e".repeat(64),grant_id:ExecutionId::new(),expires_at_ms:123_u64.into(),unsandboxed_execution:true}]},edit_seq:rev(1),submitted_seq:rev(1)},
    ]
}

#[test]
fn ten_strategy_requests_preserve_partial_input_independent_judgment_and_exact_ack(){
    let project=ExecutionId::new();
    for pending in originals(project){
        let temp=tempfile::tempdir().unwrap();let store=DraftStore::at(temp.path().join("drafts")).unwrap();
        let key=StrategyDraftKey{project_id:project};assert!(store.read_strategy(&key).unwrap().value.is_none());assert!(!store.directory.exists());
        let mut write=StrategyDraftWrite{key:key.clone(),expected_revision:rev(0),writer_id:ExecutionId::new(),value:value()};
        write.value.pending=Some(pending.clone());
        write.value.number_drafts.insert(StrategyDraftNumber::ConfigMaxRequests,StrategyNumberDraft{text:String::new(),previous:0});
        let unit=if let StrategyDraftPending::Judgment{request,..}=&pending{request.judgment.unit_id}else{ExecutionId::new()};
        write.value.judgments.insert(unit.to_string(),StrategyJudgmentDraft{preference:None,notes:"Newer independent judgment B".into(),
            elapsed:"1e".into(),modified:"unfinished".into(),edit_seq:rev(6),saved_seq:rev(4)});
        let first=store.write_strategy(&write).unwrap();assert_eq!(store.write_strategy(&write).unwrap(),first);
        write.expected_revision=first.revision;write.value.journal_seq=rev(2);write.value.evaluation_id=Some(ExecutionId::new());
        // Selecting an evaluation does not advance the original editor sequence.
        let saved=store.write_strategy(&write).unwrap();
        let reopened=DraftStore::at(store.directory.clone()).unwrap();assert_eq!(reopened.read_strategy(&key).unwrap(),saved);
        assert_eq!(reopened.list_strategies(&key,None,10).unwrap().items,vec![saved.clone()]);
        let snapshot=reopened.pending_snapshot(project,None).unwrap();assert!(snapshot.complete);assert_eq!(snapshot.rows.len(),1);
        assert_eq!(snapshot.rows[0].slot,PendingJournalSlot::Strategy(pending.clone()));
        assert_eq!(snapshot.rows[0].slot.action_id(),pending.action_id());assert_eq!(snapshot.rows[0].slot.submitted_seq(),rev(1));
        assert!(!serde_json::to_string(&snapshot.rows[0].slot).unwrap().contains("sessionToken"));
        let mut clear=write.clone();clear.expected_revision=saved.revision;clear.value.journal_seq=rev(3);clear.value.pending=None;
        assert_eq!(store.write_strategy(&clear).unwrap_err().stage,"drafts-pending");
        assert_eq!(store.clear_strategy(&StrategyDraftClear{key:key.clone(),expected_revision:saved.revision}).unwrap_err().stage,"drafts-pending");
        let resolve=StrategyDraftResolve{write:clear,pending,disposition:StrategyDraftDisposition::Recorded};
        let mut lost=resolve.clone();lost.write.value.judgments.clear();
        assert_eq!(store.resolve_strategy(&lost).unwrap_err().stage,"strategy-drafts-newer-input");
        let resolved=store.resolve_strategy(&resolve).unwrap();assert_eq!(store.resolve_strategy(&resolve).unwrap(),resolved);
        assert_eq!(resolved.value.as_ref().unwrap().judgments,write.value.judgments);
        assert!(store.pending_snapshot(project,None).unwrap().rows.is_empty());
        let tombstone=store.clear_strategy(&StrategyDraftClear{key:key.clone(),expected_revision:resolved.revision}).unwrap();
        assert!(tombstone.value.is_none());assert!(store.write_strategy(&write).is_err());
    }
}

#[test]
fn strategy_journal_sixteen_upgrades_fifteen_only_on_successful_shared_quota_write(){
    let temp=tempfile::tempdir().unwrap();let mut store=DraftStore::at(temp.path().join("drafts")).unwrap();
    let project=ExecutionId::new();
    let old=DraftWrite{key:DraftKey{project_id:project,unit_id:ExecutionId::new(),locale:"zh-CN".into()},expected_revision:rev(0),writer_id:ExecutionId::new(),
        value:DraftValue{basis:DraftBasis{source_revision_id:ExecutionId::new(),selection_id:None,revision_id:None,text:None},text:"Existing unfinished translation".into(),edit_seq:rev(1),pending:None,merge:None,reuse_origin:None}};
    let previous=store.write(&old).unwrap();let path=store.directory.join(DATABASE);
    set_legacy_format(&Connection::open(&path).unwrap(),TEAM_QUESTION_FORMAT).unwrap();
    let bytes=fs::read(&path).unwrap();let key=StrategyDraftKey{project_id:project};
    assert!(store.read_strategy(&key).unwrap().value.is_none());assert_eq!(fs::read(&path).unwrap(),bytes);
    let write=StrategyDraftWrite{key:key.clone(),expected_revision:rev(0),writer_id:ExecutionId::new(),value:value()};
    store.limits.project_bytes=1;
    assert_eq!(store.write_strategy(&write).unwrap_err().code,ErrorCode::LimitExceeded);assert_eq!(fs::read(&path).unwrap(),bytes);
    store.limits=Limits::default();let saved=store.write_strategy(&write).unwrap();
    let connection=Connection::open(&path).unwrap();assert_eq!(verify_schema(&connection).unwrap(),FORMAT);
    assert_eq!(store.read(&old.key).unwrap(),previous);assert_eq!(store.read_strategy(&key).unwrap(),saved);
    let (total,records,local,count)=journal_usage(&connection,FORMAT,project).unwrap();
    assert_eq!(records,2);assert_eq!(count,2);assert_eq!(total,local);
    assert_eq!(total as usize,encode_bounded(&previous,MAX_DRAFT_RECORD_BYTES).unwrap().len()+encode_bounded(&saved,MAX_RECORD).unwrap().len());
}
