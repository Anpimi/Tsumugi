use super::*;
use std::sync::atomic::Ordering;

#[test]
fn resource_original_observations_and_stable_rejections_never_reconcile_execution(){
    let (_temp,mut store,project)=super::tests::fixture_project();
    let snapshot=store.content_scope().unwrap().current_snapshot.unwrap();
    let row=store.source_content(snapshot,0,1).unwrap().rows.remove(0);
    let unit=row.unit_id.unwrap();let source=row.source_revision_id.unwrap();
    let term=SaveTerm{project_id:project,action_id:ExecutionId::new(),term_id:None,locale:"zh-CN".into(),
        source:"Source".into(),aliases:vec![],target:"Target".into(),protected:false,scope_unit_id:None,
        expected_revision_id:None,reason:"Explicit term".into()};
    let term_receipt=store.save_term(&term).unwrap();
    let context=SaveContext{project_id:project,action_id:ExecutionId::new(),unit_id:unit,locale:"zh-CN".into(),
        source_revision_id:source,expected_revision_id:None,text:"Manual note".into(),reason:"Explicit note".into()};
    let context_receipt=store.save_context(&context).unwrap();
    let capture=CaptureContext{project_id:project,action_id:ExecutionId::new(),unit_id:unit,locale:"zh-CN".into(),
        source_revision_id:source,budget_bytes:16384};
    let capture_receipt=store.capture_context(&capture).unwrap();
    let first=crate::SaveTranslationRevision{reuse_origin:None,project_id:project,action_id:ExecutionId::new(),
        unit_id:unit,locale:"zh-CN".into(),source_revision_id:source,expected_selection_id:None,text:"Before form".into()};
    let before=store.save_translation_edit(&first).unwrap();
    let after=store.save_translation_edit(&crate::SaveTranslationRevision{action_id:ExecutionId::new(),
        expected_selection_id:Some(before.selection.event_id),text:"New form".into(),..first}).unwrap();
    let evidence=store.correction_term_basis(project,unit,"zh-CN",after.selection.event_id).unwrap();
    let correction=CaptureCorrectionTerm{action_id:ExecutionId::new(),basis:evidence.basis,source:evidence.source_text,
        target:"New".into(),protected:false,reason:"Explicit correction".into()};
    let correction_receipt=store.capture_correction_term(&correction).unwrap();
    let decision=ResourceDecision{ edited_target: None,project_id:project,action_id:ExecutionId::new(),capture_id:correction_receipt.capture.capture_id,
        entry_id:"term".into(),expected_revision_id:None,decision:ResourceDecisionKind::Keep};
    let decision_receipt=store.decide_glossary_entry(&decision).unwrap();
    store.execution_unknown.store(true,Ordering::Release);
    let authority=store.planning_authority_revision.load(Ordering::Acquire);
    let changes=store.connection().unwrap().total_changes();
    let clock=store.changes_since(crate::execution::Revision::new(0).unwrap()).sequence;
    assert_eq!(store.term_save_request_observation(&term).unwrap().unwrap().receipt,term_receipt);
    assert_eq!(store.context_save_request_observation(&context).unwrap().unwrap().receipt,context_receipt);
    assert_eq!(store.context_capture_request_observation(&capture).unwrap().unwrap().receipt,capture_receipt);
    assert_eq!(store.correction_term_request_observation(&correction).unwrap(),Some(correction_receipt));
    assert_eq!(store.resource_decision_request_observation(&decision).unwrap().unwrap().receipt,decision_receipt);
    let mut altered=term.clone();altered.target="Different original".into();
    assert_eq!(store.term_save_request_observation(&altered).unwrap_err().code,ErrorCode::ResultMismatch);
    let mut altered=context.clone();altered.text="Different original".into();
    assert_eq!(store.context_save_request_observation(&altered).unwrap_err().code,ErrorCode::ResultMismatch);
    let mut altered=capture.clone();altered.budget_bytes=8192;
    assert_eq!(store.context_capture_request_observation(&altered).unwrap_err().code,ErrorCode::ResultMismatch);
    let mut altered=correction.clone();altered.reason="Different original".into();
    assert_eq!(store.correction_term_request_observation(&altered).unwrap_err().code,ErrorCode::ResultMismatch);
    let mut altered=decision.clone();altered.decision=ResourceDecisionKind::Ignore;
    assert_eq!(store.resource_decision_request_observation(&altered).unwrap_err().code,ErrorCode::ResultMismatch);
    let stale=SaveTerm{action_id:ExecutionId::new(),term_id:Some(term_receipt.term_id.clone()),..term.clone()};
    assert_eq!(store.term_save_request_settlement_observation(&stale).unwrap_err().stage,"resource-current");
    let stale=SaveContext{action_id:ExecutionId::new(),..context.clone()};
    assert_eq!(store.context_save_request_settlement_observation(&stale).unwrap_err().stage,"context-current");
    let stale=CaptureContext{action_id:ExecutionId::new(),source_revision_id:ExecutionId::new(),..capture};
    assert_eq!(store.context_capture_request_settlement_observation(&stale).unwrap_err().stage,"context-source");
    let stale=CaptureCorrectionTerm{action_id:ExecutionId::new(),..correction};
    assert_eq!(store.correction_term_request_settlement_observation(&stale).unwrap_err().stage,"correction-existing");
    let absent=SaveTerm{action_id:ExecutionId::new(),..term};
    assert!(store.term_save_request_settlement_observation(&absent).unwrap().is_none());
    assert!(store.is_reconciling());
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire),authority);
    assert_eq!(store.connection().unwrap().total_changes(),changes);
    assert_eq!(store.changes_since(clock).sequence,clock);
}
