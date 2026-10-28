use super::*;
use crate::content::SourceAdoptionHandler;
use crate::execution::{AdoptionReceipt, FixedInput};
use crate::persistence::content::decision_mappings::tests::{extract, plugin_mapping_fixture};
use crate::persistence::review::tests::fixture;
use rusqlite::params;

const MANIFEST: &[u8] =
    br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#;

fn query() -> DecisionQuery {
    DecisionQuery { locale: None, sources: vec![DecisionSource::SourceMapping] }
}

fn read(store: &ProjectStore, project: ExecutionId) -> DecisionPage {
    store.decision_page(project, &query(), None, 100, |_| false).unwrap()
}

fn adopt_comparison(store: &mut ProjectStore, input: &FixedInput, result: ExecutionId) -> AdoptionReceipt {
    let comparison = store.source_comparison(input.envelope().attempt_id, result, 0, 100).unwrap();
    let action = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result], serde_json::to_value(comparison.confirmation).unwrap()).unwrap();
    store.adopt_execution(&action, &SourceAdoptionHandler).unwrap()
}

fn unresolved_with_pending() -> (tempfile::TempDir, ProjectStore, ExecutionId, FixedInput, ExecutionId) {
    let (directory, mut store, project, _) = fixture();
    let (input, result) = extract(&mut store, MANIFEST,
        br#"{"hello":"Revised hello","plain":"Plain"}"#);
    adopt_comparison(&mut store, &input, result);
    let (input, result) = extract(&mut store, MANIFEST,
        br#"{"hello":"Another revision","welcome":"Plain"}"#);
    (directory, store, project, input, result)
}

#[test]
fn original_adoption_replaces_pending_group_with_the_current_unresolved_occurrence() {
    let (_directory, mut store, project, input, result) = unresolved_with_pending();
    let before = read(&store, project);
    assert_eq!(before.total, Some(2));
    let pending = before.items.iter().find(|item| matches!(item.action,
        DecisionAction::CompareSourceMapping { result_id, .. } if result_id == result)).unwrap();
    assert_eq!(pending.targets, vec![DecisionTarget::SourceResult {
        attempt_id: input.envelope().attempt_id, result_id: result,
    }], "unadopted endpoints have no project occurrence or unit identity");
    let old_snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let old_content = store.source_content(old_snapshot, 0, 100).unwrap();
    let old_unresolved = old_content.rows.iter().find(|row| row.occurrence.key == "hello").unwrap();
    assert!(before.items.iter().any(|item| matches!(item.action,
        DecisionAction::ResolveSourceMapping { snapshot_id, occurrence_id, .. }
            if snapshot_id == old_snapshot && Some(occurrence_id) == old_unresolved.occurrence_id)));
    let first = store.decision_page(project, &query(), None, 1, |_| false).unwrap();
    let cursor = first.next.as_ref().unwrap();
    let receipt = adopt_comparison(&mut store, &input, result);
    let after = read(&store, project);
    assert_ne!(before.basis, after.basis);
    assert_eq!(after.total, Some(1));
    assert!(after.items.iter().all(|item| !matches!(item.action, DecisionAction::CompareSourceMapping { .. })));
    let current = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_ne!(current, old_snapshot);
    let content = store.source_content(current, 0, 100).unwrap();
    let successor = content.rows.iter().find(|row| row.occurrence.key == "hello").unwrap();
    let item = &after.items[0];
    assert_eq!(item.source_action_id, Some(receipt.action_id));
    assert!(matches!(item.action, DecisionAction::ResolveSourceMapping { snapshot_id, occurrence_id, ordinal }
        if snapshot_id == current && Some(occurrence_id) == successor.occurrence_id
            && ordinal == successor.occurrence.ordinal));
    let evidence = store.source_lineage_evidence(current, successor.occurrence.ordinal).unwrap();
    assert!(evidence.iter().any(|edge| edge.old.occurrence_id == old_unresolved.occurrence_id));
    assert_eq!(store.decision_page(project, &query(), Some(cursor), 1, |_| false).unwrap_err().code,
        ErrorCode::DependencyConflict);
}

#[test]
fn plugin_authorization_rotation_keeps_the_original_group_but_invalidates_its_read_basis() {
    let (_directory, store, project) = plugin_mapping_fixture();
    let before = read(&store, project);
    assert_eq!(before.items.len(), 1);
    assert_eq!(before.items[0].state, DecisionState::Pending);
    let cursor = DecisionCursor { basis: before.basis.clone(), after_id: before.items[0].decision_id.clone() };
    assert!(store.decision_page(project, &query(), Some(&cursor), 1, |_| false).unwrap().items.is_empty());
    store.begin_plugin_epoch(ExecutionId::new()).unwrap();
    let writes = store.connection().unwrap().total_changes();
    let after = read(&store, project);
    assert_eq!(after.items.len(), 1);
    assert_eq!(after.items[0].decision_id, before.items[0].decision_id);
    assert_eq!(after.items[0].targets, before.items[0].targets);
    assert_eq!(after.items[0].state, DecisionState::Stale);
    assert_ne!(after.items[0].basis, before.items[0].basis);
    assert_ne!(after.basis, before.basis);
    assert_eq!(store.decision_page(project, &query(), Some(&cursor), 1, |_| false).unwrap_err().code,
        ErrorCode::DependencyConflict);
    assert_eq!(store.connection().unwrap().total_changes(), writes);
}

#[test]
fn unreadable_pending_result_preserves_adopted_source_items_with_partial_coverage() {
    let (_directory, store, project, _input, result) = unresolved_with_pending();
    let before = read(&store, project);
    let adopted = before.items.iter().find(|item| matches!(item.action,
        DecisionAction::ResolveSourceMapping { .. })).unwrap().clone();
    store.connection().unwrap().execute("UPDATE execution_results SET digest=?2 WHERE result_id=?1",
        params![result.to_string(), "0".repeat(64)]).unwrap();
    let writes = store.connection().unwrap().total_changes();
    let after = read(&store, project);
    assert_eq!(after.items, vec![adopted]);
    assert_eq!(after.known_count, 1);
    assert_eq!(after.total, None);
    let coverage = &after.coverage[0];
    assert_eq!(coverage.source, DecisionSource::SourceMapping);
    assert_eq!(coverage.state, DecisionCoverageState::Partial);
    assert_eq!(coverage.known_count, 1);
    assert_eq!(coverage.total, None);
    assert_eq!(coverage.reason, Some(DecisionCoverageReason::SourceUnavailable));
    assert!(coverage.error_code.is_some());
    assert_eq!(store.connection().unwrap().total_changes(), writes);
}
