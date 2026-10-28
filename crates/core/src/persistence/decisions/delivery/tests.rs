use super::*;
use crate::persistence::review::tests::{approve, check, current_release_fixture, translate};
use crate::{BuildLocaleChoice, DeliveryView, ReleaseAdoptionHandler};
use crate::execution::{ExecutionRuntime, ExecutionState};
use std::{sync::{Arc, atomic::Ordering}, time::{Duration, Instant}};

fn fixture() -> (tempfile::TempDir, ProjectStore, ExecutionId, ExecutionId) {
    let (directory, mut store, action) = current_release_fixture(false);
    let project = action.project_id;
    let receipt = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
    let release = ExecutionId::parse(&receipt.changes[0].id).unwrap();
    (directory, store, project, release)
}

fn another_release(store: &mut ProjectStore, project: ExecutionId, locales: &[&str]) -> ExecutionId {
    for locale in locales {
        let targets = store.review_page(project, locale, 0, 100).unwrap().rows;
        for target in targets {
            if target.current_decision.as_ref().is_some_and(|decision| decision.kind == crate::ReviewDecisionKind::Approve)
                && target.current_check.is_some() { continue; }
            translate(store, project, target.unit_id, locale, &format!("Synthetic {}", target.source_text));
            check(store, project, target.unit_id, locale);
            approve(store, project, target.unit_id, locale);
        }
    }
    let wanted = locales.iter().map(|locale| (*locale).to_owned()).collect::<Vec<_>>();
    let ready = store.review_eligibility(project, &wanted).unwrap();
    assert!(ready.ready);
    let choices = locales.iter().map(|locale| BuildLocaleChoice { locale: (*locale).into(),
        file_name: format!("i18n/{locale}.json") }).collect::<Vec<_>>();
    let input = store.prepare_locale_build(project, ExecutionId::new(), &choices, &ready.basis).unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(crate::content::BuildRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let results = loop {
        runtime.tick(store).unwrap();
        let attempt = store.execution_attempt(input.envelope().attempt_id, true).unwrap();
        if attempt.items.iter().all(|item| item.execution == ExecutionState::Succeeded) {
            break input.envelope().items.iter().map(|item| store.execution_current_result(
                input.envelope().attempt_id, item.item_id).unwrap().unwrap()).collect::<Vec<_>>();
        }
        assert!(Instant::now() < deadline, "synthetic build did not complete");
        std::thread::sleep(Duration::from_millis(2));
    };
    for result in &results { store.validate_execution_result(input.envelope().attempt_id, *result).unwrap(); }
    let action = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        results, serde_json::Value::Null).unwrap();
    let receipt = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

fn pending(store: &mut ProjectStore, release: ExecutionId, suffix: &str) -> DeliveryView {
    store.begin_delivery(ExecutionId::new(), release, &format!("/synthetic/unobserved/{suffix}"), false).unwrap()
}

fn read(store: &ProjectStore, project: ExecutionId, locale: Option<&str>, activity: &[DecisionDeliveryActivity]) -> SourceProjection {
    let c = store.connection().unwrap();
    review::read_snapshot(c, |c| super::project(store, c, project, locale, activity)).unwrap()
}

fn page(store: &ProjectStore, project: ExecutionId, cursor: Option<&DecisionCursor>, activity: &[DecisionDeliveryActivity]) -> DecisionPage {
    store.decision_page_with_host_observations(project, &DecisionQuery { locale: None,
        sources: vec![DecisionSource::DeliveryUnknown] }, cursor, 1, |_| false, activity, |_| Ok(None)).unwrap()
}

fn activity(kind: DecisionDeliveryJobKind, release_id: ExecutionId, action_id: Option<ExecutionId>) -> DecisionDeliveryActivity {
    DecisionDeliveryActivity { job_id: ExecutionId::new(), kind, release_id, action_id }
}

#[test]
fn original_unknowns_survive_live_jobs_while_only_exact_pending_exports_are_progress() {
    let (directory, mut store, project, release) = fixture();
    let orphan = pending(&mut store, release, "orphan");
    let live = pending(&mut store, release, "live");
    let uncertain = pending(&mut store, release, "unknown");
    let files = uncertain.files.iter().cloned().map(|mut file| { file.state = DeliveryFileState::Unknown; file }).collect();
    let uncertain = store.finish_delivery(uncertain.action_id, files).unwrap();
    let completed = pending(&mut store, release, "completed");
    let files = completed.files.iter().cloned().map(|mut file| { file.state = DeliveryFileState::Succeeded;
        file.actual_sha256 = Some(file.expected_sha256.clone()); file }).collect();
    store.finish_delivery(completed.action_id, files).unwrap();
    let jobs = vec![activity(DecisionDeliveryJobKind::Export, release, Some(live.action_id)),
        activity(DecisionDeliveryJobKind::Preview, release, Some(orphan.action_id)),
        activity(DecisionDeliveryJobKind::Reconcile, release, Some(orphan.action_id)),
        activity(DecisionDeliveryJobKind::Export, release, Some(ExecutionId::new())),
        activity(DecisionDeliveryJobKind::Export, ExecutionId::new(), Some(orphan.action_id)),
        activity(DecisionDeliveryJobKind::Export, release, Some(uncertain.action_id))];
    let current = read(&store, project, None, &jobs);
    assert!(current.complete);
    assert_eq!(current.items.len(), 2);
    assert!(current.items.iter().any(|item| item.decision_id == format!("delivery-unknown:{}", orphan.delivery_id)));
    let unknown = current.items.iter().find(|item| item.source_action_id == Some(uncertain.action_id)).unwrap();
    assert!(matches!(&unknown.evidence, Some(DecisionEvidence::DeliveryOutcome {
        state: DeliveryState::Unknown, unknown_file_count: 1, file_count: 1, .. })));
    assert_eq!(unknown.targets, vec![DecisionTarget::Delivery { release_id: release, delivery_id: uncertain.delivery_id }]);
    assert_eq!(unknown.action, DecisionAction::InspectDeliveryOutcome { release_id: release,
        delivery_id: uncertain.delivery_id, action_id: uncertain.action_id });
    let wire = serde_json::to_string(&current.items).unwrap();
    assert!(!wire.contains("directory") && !wire.contains("/synthetic/unobserved/"));

    store.execution_unknown.store(true, Ordering::Release);
    let writes = store.connection().unwrap().total_changes();
    let clock = store.changes_since(Revision::new(0).unwrap());
    let authority = store.planning_authority_revision.load(Ordering::Acquire);
    let without_jobs = read(&store, project, None, &[]).items;
    review::read_snapshot(store.connection().unwrap(), |c| {
        assert_eq!(super::project(&store, c, project, None, &jobs)?.items, current.items);
        assert!(!c.is_autocommit());
        Ok(())
    }).unwrap();
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    assert_eq!(store.changes_since(clock.sequence).sequence, clock.sequence);
    assert!(store.is_reconciling());
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire), authority);
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let writes = reopened.connection().unwrap().total_changes();
    assert_eq!(read(&reopened, project, None, &[]).items, without_jobs);
    assert_eq!(reopened.connection().unwrap().total_changes(), writes);
    assert_eq!(reopened.changes_since(Revision::new(0).unwrap()).sequence.get(), 0);
}

#[test]
fn project_seek_crosses_releases_and_locale_filters_keep_the_complete_original_language_set() {
    let (_directory, mut store, project, first_release) = fixture();
    let second_release = another_release(&mut store, project, &["zh-CN", "fr-FR"]);
    let one = pending(&mut store, first_release, "one-locale");
    let many = pending(&mut store, second_release, "two-locales");
    let all = read(&store, project, None, &[]);
    assert_eq!(all.items.len(), 2);
    assert!(all.complete);
    let fr = read(&store, project, Some("fr-FR"), &[]);
    assert_eq!(fr.items.len(), 1);
    assert_eq!(fr.items[0].source_action_id, Some(many.action_id));
    assert_eq!(fr.items[0].locale, None, "querying one language cannot rewrite a multi-language target");
    assert!(matches!(&fr.items[0].evidence, Some(DecisionEvidence::DeliveryOutcome { locales, file_count: 2, .. })
        if locales == &vec!["fr-FR".to_owned(), "zh-CN".to_owned()]));
    assert_eq!(read(&store, project, Some("zh-CN"), &[]).items.len(), 2);
    assert!(read(&store, project, Some("ja"), &[]).items.is_empty());
    let metadata_revision = store.metadata().unwrap().metadata_revision();
    store.set_target_locales(metadata_revision, &["zh-CN".into()]).unwrap();
    assert_eq!(read(&store, project, Some("fr-FR"), &[]).items, fr.items);
    assert_eq!(super::project(&store, store.connection().unwrap(), ExecutionId::new(), None, &[]).err().unwrap().code,
        ErrorCode::Unauthorized);
    let c = store.connection().unwrap();
    review::read_snapshot(c, |c| {
        let first = super::super::super::release::project_delivery_observations_in(c, project, None, 1)?;
        assert_eq!(first.rows.len(), 1);
        let second = super::super::super::release::project_delivery_observations_in(c, project, first.next, 1)?;
        assert_eq!(second.rows.len(), 1);
        assert!(second.next.is_none());
        assert_ne!(first.rows[0].release_id, second.rows[0].release_id);
        Ok(())
    }).unwrap();
    let first = page(&store, project, None, &[]);
    assert_eq!((first.known_count, first.total), (2, Some(2)));
    let next = page(&store, project, first.next.as_ref(), &[]);
    assert_eq!(next.basis, first.basis);
    assert!(next.next.is_none());
    assert_ne!(first.items[0].decision_id, next.items[0].decision_id);
    assert!(all.items.iter().any(|item| item.source_action_id == Some(one.action_id)));
}

#[test]
fn delivery_writes_invalidate_the_original_release_scope_and_reads_do_not_settle_unknown() {
    let (_directory, mut store, project, release) = fixture();
    let empty = page(&store, project, None, &[]);
    let before = store.changes_since(Revision::new(0).unwrap()).sequence;
    let delivery = pending(&mut store, release, "clock");
    let changed = store.changes_since(before);
    assert!(changed.sequence > before);
    assert_eq!(changed.scopes, vec![crate::ChangeScope::Release]);
    let original = page(&store, project, None, &[]);
    assert_ne!(original.basis, empty.basis);
    let before = changed.sequence;
    assert_eq!(store.begin_delivery(delivery.action_id, release, &delivery.directory, false).unwrap(), delivery);
    assert!(store.begin_delivery(delivery.action_id, release, "changed", false).is_err());
    assert_eq!(store.changes_since(before).sequence, before);
    let files = delivery.files.iter().cloned().map(|mut file| { file.state = DeliveryFileState::Unknown; file }).collect();
    let unknown = store.finish_delivery(delivery.action_id, files).unwrap();
    let finished = store.changes_since(before);
    assert!(finished.sequence > before);
    assert_eq!(finished.scopes, vec![crate::ChangeScope::Release]);
    let uncertain = page(&store, project, None, &[]);
    assert_ne!(uncertain.basis, original.basis);
    let writes = store.connection().unwrap().total_changes();
    assert_eq!(store.reconcile_delivery(delivery.action_id, unknown.files.clone()).unwrap(), unknown);
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    assert_eq!(store.changes_since(finished.sequence).sequence, finished.sequence);
    let mut files = unknown.files;
    for file in &mut files { file.state = DeliveryFileState::Failed; file.actual_sha256 = None; }
    store.reconcile_delivery(delivery.action_id, files).unwrap();
    let settled = store.changes_since(finished.sequence);
    assert!(settled.sequence > finished.sequence);
    assert_eq!(settled.scopes, vec![crate::ChangeScope::Release]);
    let resolved = page(&store, project, None, &[]);
    assert!(resolved.items.is_empty());
    assert_ne!(resolved.basis, uncertain.basis);
    assert_eq!(store.changes_since(settled.sequence).sequence, settled.sequence);
}

#[test]
fn more_than_one_hundred_deliveries_are_read_until_the_explicit_source_cap() {
    let (_directory, mut store, project, release) = fixture();
    for index in 0..=SOURCE_LIMIT { pending(&mut store, release, &format!("bounded-{index}")); }
    assert_eq!(store.list_deliveries(release).unwrap().len(), 100, "the historical UI list remains independently bounded");
    let source = read(&store, project, None, &[]);
    assert_eq!(source.items.len(), SOURCE_LIMIT);
    assert!(!source.complete);
    let page = page(&store, project, None, &[]);
    assert_eq!(page.known_count, SOURCE_LIMIT as u32);
    assert_eq!(page.total, None);
    assert_eq!(page.coverage[0].state, DecisionCoverageState::Partial);
}

#[test]
fn inconsistent_final_state_cannot_hide_an_unknown_file_or_pass_the_original_decoder() {
    let (_directory, mut store, project, release) = fixture();
    let delivery = pending(&mut store, release, "corrupt-final");
    let files = delivery.files.iter().cloned().map(|mut file| { file.state = DeliveryFileState::Unknown; file }).collect();
    store.finish_delivery(delivery.action_id, files).unwrap();
    store.connection().unwrap().execute("UPDATE release_deliveries SET state='failed' WHERE delivery_id=?1",
        [delivery.delivery_id.to_string()]).unwrap();
    let writes = store.connection().unwrap().total_changes();
    assert_eq!(store.delivery_by_action(delivery.action_id).unwrap_err().code, ErrorCode::CorruptLedger);
    let result = super::project(&store, store.connection().unwrap(), project, None, &[]);
    assert!(matches!(result, Err(error) if error.code == ErrorCode::CorruptLedger));
    let result = page(&store, project, None, &[]);
    assert_eq!(result.total, None);
    assert_eq!(result.coverage[0].state, DecisionCoverageState::Unavailable);
    assert_eq!(store.connection().unwrap().total_changes(), writes);
}
