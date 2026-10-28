use super::*;
use crate::{
    ProjectMetadata,
    execution::{FixedInput, InputEnvelope, InputItem, Scope},
    persistence::decisions::{DecisionCoverageState, DecisionPage, DecisionQuery},
};
use serde_json::json;
use std::sync::atomic::Ordering;

fn fixture() -> (tempfile::TempDir, ProjectStore, ExecutionId) {
    let directory = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(directory.path().join("project"),
        ProjectMetadata::create("Decision recovery fixture", "en", ["zh-CN", "ja"]).unwrap()).unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    (directory, store, project)
}

/// A real admitted and dispatched ledger record; no Provider or worker is used.
fn dispatched(store: &mut ProjectStore, locale: &str) -> FixedInput {
    let envelope = InputEnvelope::new(store.metadata().unwrap().project_id(),
        "fixture", "controlled", "1", vec![InputItem::new(Scope {
            kind: "fixture".into(), id: "project-operation".into(), locale: Some(locale.to_owned()),
        }, json!({}), vec![])]).unwrap();
    let input = FixedInput::capture(envelope).unwrap();
    store.enqueue_read_only_execution(&input).unwrap();
    store.dispatch_execution_item(input.envelope().attempt_id, input.envelope().items[0].item_id).unwrap();
    input
}

fn unknowns(store: &ProjectStore, project: ExecutionId, locale: Option<&str>,
    active: impl Fn(ExecutionId) -> bool,
) -> DecisionPage {
    store.decision_page(project, &DecisionQuery { locale: locale.map(str::to_owned),
        sources: vec![DecisionSource::ExecutionUnknown] }, None, 100, active).unwrap()
}

fn changes(store: &ProjectStore) -> i64 {
    store.connection().unwrap().query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap()
}

#[test]
fn active_dispatch_is_progress_and_inactive_dispatch_retains_original_unknown_identity() {
    let (_directory, mut store, project) = fixture();
    let input = dispatched(&mut store, "zh-CN");
    let attempt = input.envelope().attempt_id;
    let before = changes(&store);
    let live = unknowns(&store, project, None, |value| value == attempt);
    assert!(live.items.is_empty());
    assert_eq!(live.execution_activity, vec![crate::DecisionExecutionActivity { attempt_id: attempt, active: true }]);
    assert_eq!(live.coverage[0].state, DecisionCoverageState::Complete);
    let stopped = unknowns(&store, project, None, |_| false);
    assert_eq!(stopped.execution_activity, vec![crate::DecisionExecutionActivity { attempt_id: attempt, active: false }]);
    assert_eq!(stopped.items.len(), 1);
    let row = &stopped.items[0];
    assert_eq!(row.state, DecisionState::AwaitingRecheck);
    assert_eq!(row.locale.as_deref(), Some("zh-CN"));
    assert_eq!(row.targets, vec![DecisionTarget::Project]);
    assert_eq!(row.action, DecisionAction::InspectExecution { task_id: input.envelope().task_id,
        attempt_id: attempt, item_id: input.envelope().items[0].item_id });
    assert_eq!(row.decision_id, format!("execution-unknown:{attempt}:{}", input.envelope().items[0].item_id));
    assert_ne!(live.basis, stopped.basis);
    assert_eq!(changes(&store), before);
    assert_eq!(store.execution_attempt(attempt, true).unwrap().items[0].execution, ExecutionState::Dispatched);
}

#[test]
fn decision_observation_preserves_reconciliation_and_planning_authority() {
    let (_directory, mut store, project) = fixture();
    dispatched(&mut store, "zh-CN");
    store.execution_unknown.store(true, Ordering::Release);
    store.planning_authority_revision.store(7, Ordering::Release);
    let before = changes(&store);
    let snapshot = store.changes_since(crate::execution::Revision::new(0).unwrap());
    let first = unknowns(&store, project, None, |_| false);
    let second = unknowns(&store, project, None, |_| false);
    assert_eq!(first.items.len(), 1);
    assert_eq!(first, second);
    assert!(store.is_reconciling());
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire), 7);
    assert_eq!(changes(&store), before);
    let after = store.changes_since(crate::execution::Revision::new(0).unwrap());
    assert_eq!((snapshot.epoch, snapshot.sequence, snapshot.progress_sequence),
        (after.epoch, after.sequence, after.progress_sequence));
}

#[test]
fn explicit_language_queries_keep_unknowns_separate_without_reidentifying_them() {
    let (_directory, mut store, project) = fixture();
    dispatched(&mut store, "zh-CN");
    dispatched(&mut store, "ja");
    let all = unknowns(&store, project, None, |_| false);
    assert_eq!(all.items.len(), 2);
    for locale in ["zh-CN", "ja"] {
        let page = unknowns(&store, project, Some(locale), |_| false);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].locale.as_deref(), Some(locale));
        assert!(all.items.contains(&page.items[0]));
    }
    assert!(unknowns(&store, project, Some("fr-FR"), |_| false).items.is_empty());
}

#[test]
fn removed_language_unknown_remains_discoverable_after_reopen() {
    let (directory, mut store, project) = fixture();
    let input = dispatched(&mut store, "zh-CN");
    store.set_target_locales(1, &["ja".to_owned()]).unwrap();
    let before = unknowns(&store, project, None, |_| false);
    assert_eq!(before.items.len(), 1);
    assert_eq!(before.items[0].locale.as_deref(), Some("zh-CN"));
    assert_eq!(unknowns(&store, project, Some("zh-CN"), |_| false).items, before.items);
    assert!(unknowns(&store, project, Some("ja"), |_| false).items.is_empty());
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let after = unknowns(&reopened, project, None, |_| false);
    assert_eq!(after.items, before.items);
    assert_eq!(after.items[0].action, DecisionAction::InspectExecution {
        task_id: input.envelope().task_id, attempt_id: input.envelope().attempt_id,
        item_id: input.envelope().items[0].item_id });
}

#[test]
fn all_languages_delivery_keeps_exact_counts_and_marks_reason_samples() {
    let (_directory, mut store, project) = fixture();
    let source = (0..60).map(|index| (format!("entry-{index:03}"), "Source"))
        .collect::<BTreeMap<_, _>>();
    crate::persistence::review::tests::adopt_source(&mut store, &serde_json::to_vec(&source).unwrap());
    let page = store.decision_page(project, &DecisionQuery { locale: None,
        sources: vec![DecisionSource::DeliveryBlocker] }, None, 100, |_| false).unwrap();
    assert_eq!(page.items.len(), 2);
    for item in page.items {
        let locale = item.locale.as_ref().unwrap();
        let qualification = store.review_eligibility(project, &[locale.clone()]).unwrap();
        let expected = &qualification.locales[0];
        assert!(expected.blocker_count > 100);
        assert!(item.targets.contains(&DecisionTarget::Project));
        assert!(!item.targets_complete);
        match item.evidence.unwrap() {
            DecisionEvidence::Delivery { blocker_count, reasons, reasons_complete } => {
                assert_eq!(blocker_count, expected.blocker_count);
                assert_eq!(reasons, expected.blockers);
                assert!(!reasons_complete);
            }
        }
    }
}
