use super::*;
use crate::persistence::review::tests::{fixture,adopt_source,translate,approve,check};
use std::sync::atomic::Ordering;

#[test]
fn correction_receipt_precedes_unknown_session_and_preserves_b_approval_without_transfer() {
    let (directory,mut store,project,units)=fixture();
    translate(&mut store,project,units[0],"zh-CN","A {{name}}");
    let a=approve(&mut store,project,units[0],"zh-CN");
    let s1=store.content_scope().unwrap().current_snapshot.unwrap();
    let old=store.source_content(s1,0,10).unwrap().rows[0].clone();
    adopt_source(&mut store,br#"{"hello":"Changed {{name}}","plain":"Plain"}"#);
    let s2=store.content_scope().unwrap().current_snapshot.unwrap();
    let b_unit=store.source_content(s2,0,10).unwrap().rows[0].unit_id.unwrap();
    translate(&mut store,project,b_unit,"zh-CN","B {{name}}");
    let b=approve(&mut store,project,b_unit,"zh-CN");
    check(&mut store,project,b_unit,"zh-CN");
    let request=CorrectSourceLineage {project_id:project,action_id:ExecutionId::new(),basis:store.source_lineage_correction_basis(project,s2,0).unwrap(),
        old_occurrence_id:old.occurrence_id.unwrap(),decision:SourceLineageCorrectionDecision::Continue,actor:"Maintainer".into(),reason:"Explicit identity correction".into()};
    let receipt=store.correct_source_lineage(&request).unwrap();
    assert!(receipt.preserved_work.iter().any(|w|w.unit_id==b_unit&&w.review_action_ids.contains(&b.action_id)));
    assert!(receipt.preserved_work.iter().any(|w|w.unit_id==units[0]&&w.review_action_ids.contains(&a.action_id)));
    let current=store.review_target(project,units[0],"zh-CN").unwrap();
    assert!(current.current_decision.is_none());assert!(current.current_check.is_none());
    let saved:i64=store.connection().unwrap().query_row("SELECT COUNT(*) FROM review_decisions WHERE action_id IN (?1,?2)",params![a.action_id.to_string(),b.action_id.to_string()],|r|r.get(0)).unwrap();
    assert_eq!(saved,2);
    let writes=store.connection().unwrap().total_changes();
    store.execution_unknown.store(true,Ordering::Release);
    assert_eq!(store.correct_source_lineage(&request).unwrap(),receipt);
    assert_eq!(store.cancel_source_lineage_correction(&request).unwrap(),SourceLineageCorrectionObservation::Recorded{receipt:receipt.clone()});
    assert_eq!(store.connection().unwrap().total_changes(),writes);
    let mut different=request.clone();different.reason="Different request cannot reuse the action".into();
    assert_eq!(store.source_lineage_correction_request_observation(&different).unwrap_err().code,ErrorCode::ResultMismatch);
    store.execution_unknown.store(false,Ordering::Release);
    drop(store);
    let reopened=ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.source_lineage_correction_request_observation(&request).unwrap(),SourceLineageCorrectionObservation::Recorded{receipt});
}

#[test]
fn cancelling_a_nonmonotonic_stale_request_fences_late_apply_and_preserves_b_work() {
    let (directory,mut store,project,_)=fixture();
    adopt_source(&mut store,br#"{"hello":"Changed {{name}}","plain":"Plain"}"#);
    let snapshot=store.content_scope().unwrap().current_snapshot.unwrap();
    let row=store.source_content(snapshot,0,10).unwrap().rows[0].clone();
    translate(&mut store,project,row.unit_id.unwrap(),"zh-CN","B {{name}}");
    let basis=store.source_lineage_correction_basis(project,snapshot,0).unwrap();
    let request=CorrectSourceLineage{project_id:project,action_id:ExecutionId::new(),old_occurrence_id:basis.candidates[0].old.occurrence_id.unwrap(),basis,
        decision:SourceLineageCorrectionDecision::Continue,actor:"Maintainer".into(),reason:"Original pending action".into()};
    store.validate_source_lineage_correction(&request).unwrap();
    store.save_context(&crate::SaveContext{project_id:project,action_id:ExecutionId::new(),unit_id:row.unit_id.unwrap(),locale:"zh-CN".into(),source_revision_id:row.source_revision_id.unwrap(),expected_revision_id:None,text:"Changed context".into(),reason:"Keep the current observation".into()}).unwrap();
    assert_eq!(store.source_lineage_correction_request_observation(&request).unwrap(),SourceLineageCorrectionObservation::ReceiptAbsent);
    assert_eq!(store.correct_source_lineage(&request).unwrap_err().stage,"source-lineage-stale");
    let before=store.source_content(snapshot,0,10).unwrap();
    assert_eq!(store.cancel_source_lineage_correction(&request).unwrap(),SourceLineageCorrectionObservation::ConfirmedNotApplied);
    assert_eq!(store.correct_source_lineage(&request).unwrap_err().code,ErrorCode::Cancelled);
    assert_eq!(store.source_content(snapshot,0,10).unwrap(),before);
    assert_eq!(store.translation_history(project,row.unit_id.unwrap(),"zh-CN",0,10).unwrap().current_text.as_deref(),Some("B {{name}}"));
    let mut wrong=request.clone();wrong.reason="Different original request".into();
    assert_eq!(store.source_lineage_correction_request_observation(&wrong).unwrap_err().code,ErrorCode::ResultMismatch);
    drop(store);
    let mut reopened=ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.source_lineage_correction_request_observation(&request).unwrap(),SourceLineageCorrectionObservation::ConfirmedNotApplied);
    assert_eq!(reopened.correct_source_lineage(&request).unwrap_err().code,ErrorCode::Cancelled);
}

#[test]
fn schema69_correction_migration_is_atomic_and_keeps_original_adoption_frames() {
    let (directory,store,_,_)=fixture();
    let path=directory.path().join("project");drop(store);
    let mut c=Connection::open(path.join(crate::persistence::DATABASE_FILENAME)).unwrap();
    make_legacy_schema(&c).unwrap();c.pragma_update(None,"user_version",69).unwrap();
    let before:Vec<(String,Vec<u8>,String)>=c.prepare("SELECT action_id,request,digest FROM execution_actions ORDER BY rowid").unwrap()
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>().unwrap();
    {let tx=c.transaction().unwrap();initialize(&tx).unwrap();tx.pragma_update(None,"user_version",70).unwrap();}
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_lineage_corrections')",[],|r|r.get(0)).unwrap();
    assert!(!exists);assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),69);
    drop(c);
    let reopened=ProjectStore::open(&path).unwrap();
    let after:Vec<(String,Vec<u8>,String)>=reopened.connection().unwrap().prepare("SELECT action_id,request,digest FROM execution_actions ORDER BY rowid").unwrap()
        .query_map([],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap().collect::<Result<_,_>>().unwrap();
    assert_eq!(before,after);
    assert_eq!(reopened.connection().unwrap().pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),70);
}
