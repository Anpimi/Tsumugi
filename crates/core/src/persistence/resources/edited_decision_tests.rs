use super::*;
use super::tests::fixture_project;

fn captured(store: &mut ProjectStore, project_id: ExecutionId) -> ResourceDecision {
    let capture = store.capture_glossary(project_id, ExecutionId::new(),
        include_bytes!("../../../tests/fixtures/resource-updates/g1.json")).unwrap();
    ResourceDecision { project_id, action_id: ExecutionId::new(), capture_id: capture.capture_id,
        entry_id: "barrel".into(), expected_revision_id: None, decision: ResourceDecisionKind::Adopt,
        edited_target: Some("人工 e\u{301} 👩🏽‍💻".into()) }
}

#[test]
fn edited_decision_is_one_exact_receipt_with_original_provenance_and_cas() {
    let (temp, mut store, project) = fixture_project();
    let request = captured(&mut store, project);
    let receipt = store.decide_glossary_entry(&request).unwrap();
    let term = receipt.revision.as_ref().unwrap();
    assert_eq!(term.target, request.edited_target.as_ref().unwrap().as_str());
    assert_eq!(term.capture_id, Some(request.capture_id));
    assert_eq!(term.external_entry_id.as_deref(), Some("barrel"));
    assert_eq!(term.origin_kind, TermOrigin::External);
    assert_eq!(store.decide_glossary_entry(&request).unwrap(), receipt);
    let mut changed = request.clone(); changed.edited_target = Some("different".into());
    assert_eq!(store.decide_glossary_entry(&changed).unwrap_err().code, ErrorCode::ResultMismatch);
    changed.action_id = ExecutionId::new();
    assert_eq!(store.decide_glossary_entry(&changed).unwrap_err().code, ErrorCode::DependencyConflict);
    assert_eq!(store.resource_decision_request_observation(&request).unwrap().unwrap().receipt, receipt);
    assert_eq!(store.connection().unwrap().query_row("SELECT COUNT(*) FROM term_revisions", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
    drop(store);
    let store = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(store.resource_decision_request_observation(&request).unwrap().unwrap().receipt, receipt);
}

#[test]
fn edited_decision_rejects_empty_invalid_oversize_and_non_adopting_actions() {
    let (_temp, mut store, project) = fixture_project();
    let mut request = captured(&mut store, project);
    for target in ["".into(), " \n\t".into(), "bad\0text".into(), "界".repeat(MAX_FIELD_BYTES / 3 + 1)] {
        request.edited_target = Some(target);
        assert!(store.decide_glossary_entry(&request).is_err());
        assert!(store.resource_decision_request_observation(&request).unwrap().is_none());
    }
    request.edited_target = Some("Valid".into());
    for decision in [ResourceDecisionKind::Keep, ResourceDecisionKind::Ignore] {
        request.decision = decision;
        assert_eq!(store.decide_glossary_entry(&request).unwrap_err().code, ErrorCode::InvalidInput);
    }
    assert_eq!(store.connection().unwrap().query_row("SELECT COUNT(*) FROM resource_decisions", [], |r|r.get::<_,i64>(0)).unwrap(), 0);
}
