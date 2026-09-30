use super::*;
use crate::{ProjectMetadata, ProjectStore};
use serde_json::json;
use std::{
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

fn bundle() -> SourceBundle {
    SourceBundle::capture(
        include_bytes!("../../tests/fixtures/stardew-lookup/manifest.json"),
        include_bytes!("../../tests/fixtures/stardew-lookup/i18n/default.json"),
        "en",
    )
    .unwrap()
}
fn small(source: &str) -> SourceBundle {
    SourceBundle::capture(br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,source.as_bytes(),"en").unwrap()
}
fn create(path: &std::path::Path) -> ProjectStore {
    ProjectStore::create(
        path,
        ProjectMetadata::create("Source fixture", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap()
}
fn generate(store: &mut ProjectStore, bundle: SourceBundle) -> (FixedInput, FixedResult) {
    let input = bundle
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        runtime.tick(store).unwrap();
        let status = store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap();
        if status.items[0].execution == ExecutionState::Succeeded {
            assert_eq!(status.items[0].validation, ValidationState::Valid);
            let id = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, id)
                .unwrap();
            return (input, result);
        }
        assert!(
            !matches!(
                status.items[0].execution,
                ExecutionState::Failed | ExecutionState::Unknown
            ),
            "{status:?}"
        );
        assert!(Instant::now() < deadline, "runner did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn prepare(store: &mut ProjectStore, input: &FixedInput, result: &FixedResult) -> AdoptionAction {
    let page = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            50,
        )
        .unwrap();
    store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&page.confirmation).unwrap(),
        )
        .unwrap()
}

#[test]
fn upstream_comparison_and_adoption_preserve_history_and_selected_lineage() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let old_bundle = SourceBundle::capture(
        include_bytes!("../../tests/fixtures/upstream-maintenance/s1/manifest.json"),
        include_bytes!("../../tests/fixtures/upstream-maintenance/s1/i18n/default.json"),
        "en",
    )
    .unwrap();
    let (old_input, old_result) = generate(&mut store, old_bundle);
    let first = prepare(&mut store, &old_input, &old_result);
    store
        .adopt_execution(&first, &SourceAdoptionHandler)
        .unwrap();
    let first_scope = store.content_scope().unwrap();
    let old_snapshot = first_scope.current_snapshot.unwrap();
    let old_page = store.source_content(old_snapshot, 0, 50).unwrap();
    let old: std::collections::BTreeMap<_, _> = old_page
        .rows
        .iter()
        .map(|row| (row.occurrence.key.as_str(), row))
        .collect();

    let new_bundle = SourceBundle::capture(
        include_bytes!("../../tests/fixtures/upstream-maintenance/s2/manifest.json"),
        include_bytes!("../../tests/fixtures/upstream-maintenance/s2/i18n/default.json"),
        "en",
    )
    .unwrap();
    let (input, result) = generate(&mut store, new_bundle);
    let comparison = store
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            50,
        )
        .unwrap();
    let oracle: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../tests/fixtures/upstream-maintenance/oracle.json"
    ))
    .unwrap();
    assert_eq!(comparison.previous_snapshot_id, old_snapshot);
    assert_eq!(
        comparison.unchanged as usize,
        oracle["unchanged"].as_array().unwrap().len()
    );
    assert_eq!(
        comparison.changed as usize,
        oracle["changed"].as_array().unwrap().len()
    );
    assert_eq!(
        comparison.added as usize,
        oracle["added"].as_array().unwrap().len()
    );
    assert_eq!(
        comparison.removed as usize,
        oracle["removed"].as_array().unwrap().len()
    );
    assert_eq!(comparison.total, 16);
    for (kind, keys) in [
        ("unchanged", "unchanged"),
        ("changed", "changed"),
        ("removed", "removed"),
    ] {
        for key in oracle[keys].as_array().unwrap() {
            assert!(comparison.rows.iter().any(|row| {
                (row.kind == kind || (kind == "unchanged" && row.kind == "moved"))
                    && row
                        .new
                        .as_ref()
                        .map(|new| new.key.as_str())
                        .or_else(|| row.old.as_ref().map(|old| old.occurrence.key.as_str()))
                        == key.as_str()
            }));
        }
    }
    assert_eq!(comparison.moved, 4);
    assert!(
        comparison
            .rows
            .iter()
            .any(|row| row.kind == "moved" && row.new.as_ref().unwrap().key == "moved")
    );
    assert_eq!(comparison.ambiguous, 3);
    for (key, candidates) in [
        ("split-a", vec!["split-old"]),
        ("split-b", vec!["split-old"]),
        ("merge-new", vec!["merge-a", "merge-b"]),
    ] {
        let row = comparison
            .rows
            .iter()
            .find(|row| row.new.as_ref().is_some_and(|item| item.key == key))
            .unwrap();
        assert_eq!(row.kind, "ambiguous");
        let actual: Vec<_> = row
            .candidates
            .iter()
            .map(|candidate| candidate.occurrence.key.as_str())
            .collect();
        assert_eq!(actual, candidates);
    }
    assert!(
        comparison
            .rows
            .iter()
            .any(|row| row.kind == "rename-candidate"
                && row.new.as_ref().unwrap().key == "rename-new"
                && row.old.as_ref().unwrap().occurrence.key == "rename-old")
    );
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Maintainer".into());
    for (new_key, old_key, decision) in [
        ("edited", "edited", LineageDecision::Continue),
        ("rename-new", "rename-old", LineageDecision::Continue),
        ("reuse", "reuse", LineageDecision::Reject),
    ] {
        let new_ordinal = comparison
            .rows
            .iter()
            .find_map(|row| {
                row.new
                    .as_ref()
                    .filter(|item| item.key == new_key)
                    .map(|item| item.ordinal)
            })
            .unwrap();
        confirmation.lineage.push(LineageChoice {
            new_ordinal,
            old_occurrence_id: old[old_key].occurrence_id.unwrap(),
            decision,
            reason: format!("Reviewed {new_key} against {old_key}"),
        });
    }
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
    let scope = store.content_scope().unwrap();
    assert_eq!(scope.revision.get(), 3);
    let new_snapshot = scope.current_snapshot.unwrap();
    let new_page = store.source_content(new_snapshot, 0, 50).unwrap();
    let new: std::collections::BTreeMap<_, _> = new_page
        .rows
        .iter()
        .map(|row| (row.occurrence.key.as_str(), row))
        .collect();
    for key in ["stable", "moved", "same-text-a", "same-text-b"] {
        assert_eq!(new[key].unit_id, old[key].unit_id);
        assert_eq!(new[key].source_revision_id, old[key].source_revision_id);
    }
    assert_eq!(new["edited"].unit_id, old["edited"].unit_id);
    assert_ne!(
        new["edited"].source_revision_id,
        old["edited"].source_revision_id
    );
    assert_eq!(new["rename-new"].unit_id, old["rename-old"].unit_id);
    assert_eq!(
        new["rename-new"].source_revision_id,
        old["rename-old"].source_revision_id
    );
    assert_ne!(new["reuse"].unit_id, old["reuse"].unit_id);
    assert!(!new.contains_key("removed"));
    assert_eq!(
        store.source_content(old_snapshot, 0, 50).unwrap().rows,
        old_page.rows
    );
    drop(store);
    let database = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    let mut query = database
        .prepare(
            "SELECT old.native_key,e.decision,e.actor,e.reason FROM source_lineage_evidence e
         JOIN source_occurrences new ON new.occurrence_id=e.new_occurrence_id
         JOIN source_occurrences old ON old.occurrence_id=e.old_occurrence_id
         WHERE new.snapshot_id=?1 AND new.native_key=?2 ORDER BY old.native_key",
        )
        .unwrap();
    for (key, expected) in [
        ("split-a", vec![("split-old", "candidate", None, None)]),
        ("split-b", vec![("split-old", "candidate", None, None)]),
        (
            "merge-new",
            vec![
                ("merge-a", "candidate", None, None),
                ("merge-b", "candidate", None, None),
            ],
        ),
        (
            "edited",
            vec![(
                "edited",
                "continue",
                Some("Maintainer"),
                Some("Reviewed edited against edited"),
            )],
        ),
        (
            "reuse",
            vec![(
                "reuse",
                "reject",
                Some("Maintainer"),
                Some("Reviewed reuse against reuse"),
            )],
        ),
    ] {
        let actual: Vec<_> = query
            .query_map(rusqlite::params![new_snapshot.to_string(), key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            actual
                .iter()
                .map(|(old, decision, actor, reason)| (
                    old.as_str(),
                    decision.as_str(),
                    actor.as_deref(),
                    reason.as_deref()
                ))
                .collect::<Vec<_>>(),
            expected
        );
    }
    drop(query);
    drop(database);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.source_content(new_snapshot, 0, 50).unwrap(),
        new_page
    );
    assert_eq!(
        reopened.source_content(old_snapshot, 0, 50).unwrap().rows,
        old_page.rows
    );
    assert_eq!(
        reopened.source_lineage_evidence(new_snapshot, 0).unwrap()[0]
            .applied_relation
            .as_deref(),
        Some("unchanged")
    );
    reopened.close().unwrap();
    let database = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    database
        .execute(
            "DELETE FROM source_lineage_evidence WHERE new_occurrence_id=?1",
            [new["merge-new"].occurrence_id.unwrap().to_string()],
        )
        .unwrap();
    drop(database);
    assert!(
        ProjectStore::open(&path).is_err(),
        "missing ambiguity evidence must be rejected"
    );
}

#[test]
fn upstream_competing_confirmation_and_split_identity_fail_atomically() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = create(&directory.path().join("project"));
    let (initial, result) = generate(&mut store, small(r#"{"old":"Shared"}"#));
    let first = prepare(&mut store, &initial, &result);
    store
        .adopt_execution(&first, &SourceAdoptionHandler)
        .unwrap();
    let original = store
        .source_content(
            store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            10,
        )
        .unwrap()
        .rows[0]
        .clone();
    let (input, result) = generate(&mut store, small(r#"{"a":"Shared","b":"Shared"}"#));
    let mut confirmation = store
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap()
        .confirmation;
    confirmation.actor = Some("Maintainer".into());
    for ordinal in [0, 1] {
        confirmation.lineage.push(LineageChoice {
            new_ordinal: ordinal,
            old_occurrence_id: original.occurrence_id.unwrap(),
            decision: LineageDecision::Continue,
            reason: "Test split cardinality".into(),
        });
    }
    let split = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&split, &SourceAdoptionHandler)
            .unwrap_err()
            .stage,
        "lineage-split"
    );
    assert!(store.adoption_receipt(split.action_id).unwrap().is_none());
    confirmation.lineage.truncate(1);
    let stale = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    let (competing_input, competing_result) = generate(&mut store, small(r#"{"old":"Updated"}"#));
    let competing = store
        .source_comparison(
            competing_input.envelope().attempt_id,
            competing_result.envelope().result_id,
            0,
            10,
        )
        .unwrap()
        .confirmation;
    let action = store
        .prepare_adoption(
            competing_input.envelope().attempt_id,
            competing_input.envelope().units[0].unit_id,
            vec![competing_result.envelope().result_id],
            value(&competing).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let current = store.content_scope().unwrap();
    assert_eq!(
        store
            .adopt_execution(&stale, &SourceAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(store.content_scope().unwrap(), current);
    assert!(store.adoption_receipt(stale.action_id).unwrap().is_none());
    assert_eq!(store.source_history(0, 10).unwrap().total, 2);
}

#[test]
fn source_maintenance_migration_child() {
    if let Ok(path) = std::env::var("TSUMUGI_SOURCE_MIGRATION_CHILD") {
        let _ = ProjectStore::open(path);
        panic!("migration hook did not abort");
    }
}

#[test]
fn schema_eight_migration_interruptions_preserve_source_and_backup() {
    for point in [
        "before-maintenance-migration-commit",
        "after-maintenance-migration-commit",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project");
        let mut store = create(&path);
        let (input, result) = generate(&mut store, small(r#"{"key":"Original"}"#));
        let action = prepare(&mut store, &input, &result);
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        let original = store.content_scope().unwrap();
        store.close().unwrap();
        let database = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        crate::persistence::restore_legacy_translation_fixture(&database).unwrap();
        database.execute_batch("DROP TABLE source_lineage_evidence; DROP TABLE source_lineage; PRAGMA user_version=8;").unwrap();
        drop(database);
        let hook = directory.path().join("hook");
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "content::tests::source_maintenance_migration_child",
                "--nocapture",
            ])
            .env("TSUMUGI_SOURCE_MIGRATION_CHILD", &path)
            .env("TSUMUGI_MIGRATION_CRASH", point)
            .env("TSUMUGI_MIGRATION_HOOK", &hook)
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        let reopened = ProjectStore::open(&path).unwrap();
        assert_eq!(reopened.content_scope().unwrap(), original);
        assert_eq!(reopened.source_history(0, 10).unwrap().total, 1);
        reopened.close().unwrap();
        let backups = std::fs::read_dir(&path)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("project.sqlite3.pre-v8-")
            })
            .collect::<Vec<_>>();
        // An interrupted pre-commit migration leaves schema 8 and the next
        // open takes another independent pre-upgrade backup.
        assert_eq!(
            backups.len(),
            if point == "before-maintenance-migration-commit" {
                2
            } else {
                1
            }
        );
        for path in backups {
            let backup = rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            assert_eq!(
                backup
                    .query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))
                    .unwrap(),
                8
            );
            assert_eq!(
                backup
                    .query_row("SELECT COUNT(*) FROM source_snapshots", [], |row| row
                        .get::<_, u32>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                backup
                    .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
    }
}

#[test]
fn schema_eight_source_upgrade_keeps_s1_and_a_recoverable_backup() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, small(r#"{"greeting":"Hello"}"#));
    let action = prepare(&mut store, &input, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    store.close().unwrap();
    let database = path.join("project.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    crate::persistence::restore_legacy_translation_fixture(&connection).unwrap();
    connection
        .execute_batch(
            "DROP TABLE source_lineage_evidence; DROP TABLE source_lineage; PRAGMA user_version=8;",
        )
        .unwrap();
    drop(connection);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.source_content(snapshot, 0, 50).unwrap().rows[0]
            .occurrence
            .key,
        "greeting"
    );
    let backup = std::fs::read_dir(&path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("project.sqlite3.pre-v8-")
        })
        .unwrap();
    let previous =
        rusqlite::Connection::open_with_flags(backup, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    assert_eq!(
        previous
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        previous
            .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn upstream_filter_correction_and_history_keep_fixed_endpoints_and_full_scope() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let mut store = create(&path);
    let (first_input, first_result) = generate(&mut store, small(r#"{"a":"Alpha","b":"Beta"}"#));
    let first_action = prepare(&mut store, &first_input, &first_result);
    store
        .adopt_execution(&first_action, &SourceAdoptionHandler)
        .unwrap();
    let s1 = store.content_scope().unwrap().current_snapshot.unwrap();
    let old = store.source_content(s1, 0, 10).unwrap();
    let successor = r#"{"a":"Changed alpha","c":"Beta","d":"New"}"#;
    let (input, result) = generate(&mut store, small(successor));
    let scope = store.content_scope().unwrap();
    let comparison = store
        .source_comparison_filtered(
            input.envelope().attempt_id,
            result.envelope().result_id,
            None,
            "Changed alpha",
            0,
            1,
        )
        .unwrap();
    assert_eq!(
        (
            comparison.total,
            comparison.filtered_total,
            comparison.rows.len()
        ),
        (4, 1, 1)
    );
    assert_eq!(store.content_scope().unwrap(), scope);
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Maintainer".into());
    confirmation.lineage.push(LineageChoice {
        new_ordinal: 0,
        old_occurrence_id: old.rows[0].occurrence_id.unwrap(),
        decision: LineageDecision::Reject,
        reason: "Initial key reuse decision".into(),
    });
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let s2 = store.content_scope().unwrap().current_snapshot.unwrap();
    let before = store.source_content(s2, 0, 10).unwrap();
    assert_ne!(before.rows[0].unit_id, old.rows[0].unit_id);

    // Correction is a new fixed attempt and action, preserving the earlier rejection.
    let (correction_input, correction_result) = generate(&mut store, small(successor));
    let comparison = store
        .source_comparison_filtered(
            correction_input.envelope().attempt_id,
            correction_result.envelope().result_id,
            Some(s1),
            "",
            0,
            10,
        )
        .unwrap();
    let mut correction = comparison.confirmation;
    correction.actor = Some("Second maintainer".into());
    for (new_ordinal, old_row) in [(0, &old.rows[0]), (1, &old.rows[1])] {
        correction.lineage.push(LineageChoice {
            new_ordinal,
            old_occurrence_id: old_row.occurrence_id.unwrap(),
            decision: LineageDecision::Continue,
            reason: "Corrected against historical source evidence".into(),
        });
    }
    let correction_action = store
        .prepare_adoption(
            correction_input.envelope().attempt_id,
            correction_input.envelope().units[0].unit_id,
            vec![correction_result.envelope().result_id],
            value(&correction).unwrap(),
        )
        .unwrap();
    let receipt = store
        .adopt_execution(&correction_action, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&correction_action, &SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
    let s3 = store.content_scope().unwrap().current_snapshot.unwrap();
    let after = store.source_content(s3, 0, 10).unwrap();
    assert_eq!(after.rows[0].unit_id, old.rows[0].unit_id);
    assert_ne!(
        after.rows[0].source_revision_id,
        old.rows[0].source_revision_id
    );
    assert_eq!(after.rows[1].unit_id, old.rows[1].unit_id);
    assert_eq!(after.rows[2].unit_id, before.rows[2].unit_id);
    assert_eq!(store.source_content(s2, 0, 10).unwrap().rows, before.rows);
    assert_eq!(
        store.source_lineage_evidence(s2, 0).unwrap()[0].decision,
        "reject"
    );
    assert_eq!(
        store.source_lineage_evidence(s3, 0).unwrap()[0]
            .actor
            .as_deref(),
        Some("Second maintainer")
    );
    assert_eq!(
        store
            .source_history_content(s1, "Beta", 0, 10)
            .unwrap()
            .rows,
        vec![old.rows[1].clone()]
    );
    let history = store.source_history(0, 2).unwrap();
    assert_eq!((history.total, history.next_offset), (3, Some(2)));
    assert_eq!(history.snapshots[0].snapshot_id, s3);
    assert!(history.snapshots[0].current);

    // A choice from outside its fixed historical source is rejected at the mutation boundary.
    let (invalid_input, invalid_result) = generate(&mut store, small(successor));
    let mut invalid = store
        .source_comparison_filtered(
            invalid_input.envelope().attempt_id,
            invalid_result.envelope().result_id,
            Some(s1),
            "",
            0,
            1,
        )
        .unwrap()
        .confirmation;
    invalid.actor = Some("Maintainer".into());
    invalid.lineage.push(LineageChoice {
        new_ordinal: 0,
        old_occurrence_id: before.rows[0].occurrence_id.unwrap(),
        decision: LineageDecision::Continue,
        reason: "Invalid endpoint".into(),
    });
    let invalid_action = store
        .prepare_adoption(
            invalid_input.envelope().attempt_id,
            invalid_input.envelope().units[0].unit_id,
            vec![invalid_result.envelope().result_id],
            value(&invalid).unwrap(),
        )
        .unwrap();
    assert!(
        store
            .adopt_execution(&invalid_action, &SourceAdoptionHandler)
            .is_err()
    );
    assert_eq!(store.content_scope().unwrap().current_snapshot, Some(s3));
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_history(0, 2).unwrap(), history);
    assert_eq!(reopened.source_content(s1, 0, 10).unwrap().rows, old.rows);
}

#[test]
fn real_532_key_source_can_compare_and_adopt_a_controlled_successor() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = create(&temp.path().join("project"));
    let original = bundle();
    let source = original.files[1]
        .utf8
        .replace("\"generic.now\": \"now\"", "\"generic.now\": \"right now\"");
    assert_ne!(source, original.files[1].utf8);
    let successor =
        SourceBundle::capture(original.files[0].utf8.as_bytes(), source.as_bytes(), "en").unwrap();
    let (first_input, first_result) = generate(&mut store, original);
    let first_action = prepare(&mut store, &first_input, &first_result);
    store
        .adopt_execution(&first_action, &SourceAdoptionHandler)
        .unwrap();
    let first_snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let old = store.source_content(first_snapshot, 0, 10).unwrap();
    assert_eq!(old.total, 532);
    let (input, result) = generate(&mut store, successor);
    let comparison = store
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    assert_eq!(
        (
            comparison.unchanged,
            comparison.changed,
            comparison.added,
            comparison.removed
        ),
        (531, 1, 0, 0)
    );
    assert_eq!(comparison.total, 532);
    assert_eq!(comparison.rows[2].new.as_ref().unwrap().key, "generic.now");
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Fixture maintainer".into());
    confirmation.lineage.push(LineageChoice {
        new_ordinal: 2,
        old_occurrence_id: old.rows[2].occurrence_id.unwrap(),
        decision: LineageDecision::Continue,
        reason: "Controlled source wording update".into(),
    });
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let second_snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let new = store.source_content(second_snapshot, 0, 10).unwrap();
    assert_eq!(new.total, 532);
    assert_eq!(new.rows[2].unit_id, old.rows[2].unit_id);
    assert_ne!(
        new.rows[2].source_revision_id,
        old.rows[2].source_revision_id
    );
    assert_eq!(
        new.rows[0].source_revision_id,
        old.rows[0].source_revision_id
    );
    assert_eq!(
        store.source_content(first_snapshot, 0, 10).unwrap().rows,
        old.rows
    );
}

#[test]
fn oversized_multi_locale_build_is_rejected_before_execution() {
    let directory = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Build failure", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let entries = (0..70)
        .map(|ordinal| BuildEntry {
            ordinal,
            unit_id: ExecutionId::new(),
            source_revision_id: ExecutionId::new(),
            native_key: format!("key-{ordinal}"),
            source_text: "Source".into(),
            value: "Small".into(),
            selection_id: Some(ExecutionId::new()),
            revision_id: Some(ExecutionId::new()),
            fallback_id: None,
            decision_id: Some(ExecutionId::new()),
            check_id: ExecutionId::new(),
            waiver_ids: vec![],
        })
        .collect::<Vec<_>>();
    let mut oversized = entries.clone();
    for entry in &mut oversized {
        entry.value = "\n".repeat(8192);
    }
    let manifest = BuildManifest {
        version: 1,
        project_id: project,
        source_snapshot_id: ExecutionId::new(),
        policy_version: "balanced-1".into(),
        eligibility_basis: "0".repeat(64),
        plugin_id: PLUGIN_ID.into(),
        plugin_version: PLUGIN_VERSION.into(),
        builder_version: BUILDER_VERSION.into(),
        validator_version: VALIDATOR_VERSION.into(),
        source_files: vec![
            BuildSourceFile {
                logical_path: MANIFEST_PATH.into(),
                sha256: "0".repeat(64),
            },
            BuildSourceFile {
                logical_path: SOURCE_PATH.into(),
                sha256: "0".repeat(64),
            },
        ],
        locales: vec![
            BuildLocale {
                locale: "zh-CN".into(),
                file_name: "i18n/zh.json".into(),
                entries,
            },
            BuildLocale {
                locale: "fr-FR".into(),
                file_name: "i18n/fr.json".into(),
                entries: oversized,
            },
        ],
    };
    assert_eq!(
        manifest.fixed_input(ExecutionId::new()).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert!(store.list_releases(project).unwrap().is_empty());
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert!(reopened.list_releases(project).unwrap().is_empty());
}

#[test]
fn real_source_matches_independent_oracle_and_keeps_byte_locations() {
    let bundle = bundle();
    let output = extract(&bundle, &Cancellation::default()).unwrap();
    let oracle: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../tests/fixtures/stardew-lookup/oracle.json"
    ))
    .unwrap();
    assert_eq!(output.occurrences.len(), 532);
    for (row, expected) in output
        .occurrences
        .iter()
        .zip(oracle["occurrences"].as_array().unwrap())
    {
        assert_eq!(row.ordinal, expected["ordinal"].as_u64().unwrap() as u32);
        assert_eq!(row.key, expected["key"].as_str().unwrap());
        assert_eq!(row.text, expected["text"].as_str().unwrap());
        for (range, expected) in [
            (row.key_byte_range, &row.key),
            (row.value_byte_range, &row.text),
        ] {
            let decoded: String =
                serde_json::from_str(&bundle.files[1].utf8[range[0] as usize..range[1] as usize])
                    .unwrap();
            assert_eq!(&decoded, expected);
        }
    }
    assert_eq!(output.diagnostics, vec!["source-template"]);
    assert_eq!(
        bundle.files[1].sha256,
        "29c4c299dee077481a98c1de612a678a6a16e55988ba88a73fa8f1cd92deb609"
    );
}

#[test]
fn non_string_source_values_have_an_actionable_diagnostic() {
    for value in ["42", "true", "null", "[]", "{}"] {
        let error = extract(
            &small(&format!(r#"{{"key":{value}}}"#)),
            &Cancellation::default(),
        )
        .unwrap_err();
        assert_eq!(error.stage, "source-value-not-string");
    }
    assert!(
        extract(
            &small(r#"{"number":"42","empty":""}"#),
            &Cancellation::default(),
        )
        .is_ok()
    );
}

#[test]
fn profile_rejects_ambiguous_structure_and_preserves_unicode_and_empty_values() {
    for source in [
        r#"{"A":"x","a":"y"}"#,
        r#"{"a":"x","a":"x"}"#,
        r#"{"a":null}"#,
        r#"{"a":{}}"#,
        "{'a':'x'}",
        r#"{a:"x"}"#,
        r#"{"a":"x" "b":"y"}"#,
        r#"{"é":"x"}"#,
        "{}",
    ] {
        assert!(
            extract(&small(source), &Cancellation::default()).is_err(),
            "accepted {source}"
        );
    }
    let output = extract(
        &small("\u{feff}{/*context*/\"a\":\"中文😀\\n{{x}}\",\"b\":\"\",}"),
        &Cancellation::default(),
    )
    .unwrap();
    assert_eq!(output.occurrences[0].text, "中文😀\n{{x}}");
    assert_eq!(output.occurrences[1].text, "");
    let deep = format!("{}0{}", "[".repeat(17), "]".repeat(17));
    assert_eq!(
        extract(&small(&deep), &Cancellation::default())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let cancel = Cancellation::default();
    cancel.request();
    assert_eq!(
        extract(&bundle(), &cancel).unwrap_err().code,
        ErrorCode::Cancelled
    );
}

#[test]
fn real_runtime_preview_adoption_reopen_and_pagination_keep_independent_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, bundle());
    let before = store.content_scope().unwrap();
    let mut next = 0;
    let mut seen = Vec::new();
    loop {
        let page = store
            .source_preview(
                input.envelope().attempt_id,
                result.envelope().result_id,
                next,
                100,
            )
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_CONTENT_PAGE_BYTES);
        seen.extend(page.rows.into_iter().map(|r| r.occurrence.key));
        match page.next_ordinal {
            Some(n) => next = n,
            None => break,
        }
    }
    assert_eq!(seen.len(), 532);
    assert_eq!(before, store.content_scope().unwrap());
    let action = prepare(&mut store, &input, &result);
    store.rename(1, "Renamed while previewing").unwrap();
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        receipt,
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap()
    );
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let page = store.source_content(snapshot, 0, 100).unwrap();
    let ids: std::collections::BTreeSet<_> = page.rows.iter().map(|r| r.unit_id).collect();
    assert_eq!(ids.len(), 100);
    store.close().unwrap();
    std::fs::rename(&path, tmp.path().join("moved")).unwrap();
    let store = ProjectStore::open(tmp.path().join("moved")).unwrap();
    assert_eq!(page, store.source_content(snapshot, 0, 100).unwrap());
    assert_eq!(
        store.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
}

#[test]
fn maximum_supported_source_result_fits_its_declared_byte_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let manifest = serde_json::to_vec(&json!({
        "UniqueID": "\"".repeat(256),
        "Name": "Example",
        "Version": "1.0.0",
        "EntryDll": "Example.dll"
    }))
    .unwrap();
    let entries: serde_json::Map<String, serde_json::Value> = (0..MAX_OCCURRENCES)
        .map(|index| (format!("key-{index:04}"), json!("")))
        .collect();
    let source = serde_json::to_vec(&entries).unwrap();
    let bundle = SourceBundle::capture(&manifest, &source, "en").unwrap();

    let (input, result) = generate(&mut store, bundle);
    let output = validate_output(&input, &result).unwrap();

    assert_eq!(output.occurrences.len(), MAX_OCCURRENCES);
    assert_eq!(
        input.envelope().limits.max_result_bytes as usize,
        MAX_SOURCE_RESULT_BYTES
    );
    assert!(result.bytes().len() > crate::execution::DEFAULT_RESULT_BYTES);
    assert!(result.bytes().len() <= input.envelope().limits.max_result_bytes as usize);
}

#[test]
fn malformed_output_cannot_become_valid_or_adopted() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let input = small(r#"{"a":"same","b":"same"}"#)
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    store.enqueue_execution(&input).unwrap();
    let request = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let mut output = extract(
        &SourceBundle::from_input(&input).unwrap(),
        &Cancellation::default(),
    )
    .unwrap();
    output.occurrences.remove(1);
    let result = FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: CAPABILITY.into(),
            capability_version: CAPABILITY_VERSION.into(),
            outcome: ExecutionState::Succeeded,
            output: Some(value(&output).unwrap()),
            diagnostic: None,
        },
        &input,
        request.dispatch_token,
    )
    .unwrap();
    store.save_execution_result(&result).unwrap();
    assert!(
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .is_err()
    );
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Invalid
    );
    assert!(
        store
            .source_preview(
                input.envelope().attempt_id,
                result.envelope().result_id,
                0,
                50
            )
            .is_err()
    );
    assert!(store.content_scope().unwrap().current_snapshot.is_none());
}

#[test]
fn competing_first_imports_cancel_and_changed_confirmation_preserve_results() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let (a, ar) = generate(&mut store, small(r#"{"a":"same","b":"same"}"#));
    let (b, br) = generate(&mut store, small(r#"{"a":"other"}"#));
    let cancelled = prepare(&mut store, &a, &ar);
    store
        .cancel_execution(a.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&cancelled, &SourceAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let fresh = prepare(&mut store, &a, &ar);
    let other = prepare(&mut store, &b, &br);
    let mut altered = fresh.clone();
    altered.parameters = json!({});
    assert!(
        store
            .adopt_execution(&altered, &SourceAdoptionHandler)
            .is_err()
    );
    store
        .adopt_execution(&fresh, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&other, &SourceAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert!(
        store
            .source_preview(b.envelope().attempt_id, br.envelope().result_id, 0, 50)
            .is_ok()
    );
    let scope = store.content_scope().unwrap();
    let content = store
        .source_content(scope.current_snapshot.unwrap(), 0, 50)
        .unwrap();
    assert_ne!(content.rows[0].unit_id, content.rows[1].unit_id);
}

#[test]
fn stored_bytes_and_content_relations_are_checked_on_reopen() {
    for sql in [
        "UPDATE source_files SET bytes=x'00' WHERE role='source'",
        "DELETE FROM source_identity",
        "UPDATE source_revisions SET text='changed'",
        "UPDATE content_scope SET revision=8",
        "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE source_snapshots SET snapshot_id='00000000-0000-4000-8000-000000000099'; UPDATE content_scope SET current_snapshot='00000000-0000-4000-8000-000000000099'; UPDATE source_occurrences SET snapshot_id='00000000-0000-4000-8000-000000000099'; COMMIT",
        "PRAGMA user_version=2",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("project");
        let mut store = create(&path);
        let (input, result) = generate(&mut store, small(r#"{"a":"value"}"#));
        let action = prepare(&mut store, &input, &result);
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        store.close().unwrap();
        let conn = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        conn.execute_batch(sql).unwrap();
        drop(conn);
        let before = std::fs::read(path.join("project.sqlite3")).unwrap();
        assert!(ProjectStore::open(&path).is_err());
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
    }
}

#[test]
fn simultaneous_first_adoptions_serialize_at_the_store_owner() {
    use std::sync::{Barrier, Mutex};
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let (a, ar) = generate(&mut store, small(r#"{"a":"first"}"#));
    let (b, br) = generate(&mut store, small(r#"{"a":"second"}"#));
    let first = prepare(&mut store, &a, &ar);
    let second = prepare(&mut store, &b, &br);
    let store = Arc::new(Mutex::new(store));
    let barrier = Arc::new(Barrier::new(3));
    let handles: Vec<_> = [first, second]
        .into_iter()
        .map(|action| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .lock()
                    .unwrap()
                    .adopt_execution(&action, &SourceAdoptionHandler)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r
                .as_ref()
                .is_err_and(|e| e.code == ErrorCode::DependencyConflict))
            .count(),
        1
    );
    let store = store.lock().unwrap();
    assert_eq!(store.content_scope().unwrap().revision.get(), 2);
}

#[test]
fn forged_coverage_locations_identity_and_required_fields_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let (input, saved) = generate(&mut store, small(r#"{"a":"same","b":"same"}"#));
    let original = saved.envelope().output.as_ref().unwrap();
    for kind in 0..7 {
        let mut output = original.clone();
        match kind {
            0 => {
                output["coverage"].as_array_mut().unwrap().pop();
            }
            1 => {
                output["occurrences"][0]["artifactId"] = json!(ExecutionId::new());
            }
            2 => {
                output["occurrences"][1]["ordinal"] = json!(0);
            }
            3 => {
                output["occurrences"][0]["valueByteRange"] = json!([0, 1]);
            }
            4 => {
                output["identityPolicy"] = json!("share-equal-text");
            }
            5 => {
                output["requiredExtension"] = json!("future/v1");
            }
            6 => {
                output["manifestDigest"] = json!("0".repeat(64));
            }
            _ => unreachable!(),
        }
        let mut envelope = saved.envelope().clone();
        envelope.output = Some(output);
        let forged =
            FixedResult::capture(envelope, &input, saved.envelope().dispatch_token).unwrap();
        assert!(validate_output(&input, &forged).is_err(), "case {kind}");
    }
    assert!(store.content_scope().unwrap().current_snapshot.is_none());
    assert!(
        store
            .source_preview(
                input.envelope().attempt_id,
                saved.envelope().result_id,
                0,
                50
            )
            .is_ok()
    );
}

#[test]
fn source_limits_unknown_fields_and_bundle_associations_fail_closed() {
    let manifest = small(r#"{"a":"b"}"#).files[0].utf8.clone();
    let mut padded_manifest = manifest.as_bytes().to_vec();
    padded_manifest.resize(MAX_MANIFEST_BYTES, b' ');
    assert!(SourceBundle::capture(&padded_manifest, b"{}", "en").is_ok());
    padded_manifest.push(b' ');
    assert_eq!(
        SourceBundle::capture(&padded_manifest, b"{}", "en")
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    for (length, valid) in [(1024, true), (1025, false)] {
        let text = serde_json::to_string(&json!({"k".repeat(length): "v"})).unwrap();
        assert_eq!(
            extract(&small(&text), &Cancellation::default()).is_ok(),
            valid
        );
    }
    for (length, valid) in [(256, true), (257, false)] {
        let mut value: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        value["UniqueID"] = json!("n".repeat(length));
        let bundle =
            SourceBundle::capture(&serde_json::to_vec(&value).unwrap(), br#"{"a":"v"}"#, "en")
                .unwrap();
        assert_eq!(extract(&bundle, &Cancellation::default()).is_ok(), valid);
    }
    for (arrays, valid) in [(15, true), (16, false)] {
        let mut value: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let nested = format!("{}0{}", "[".repeat(arrays), "]".repeat(arrays));
        value["Opaque"] = serde_json::from_str(&nested).unwrap();
        let bundle =
            SourceBundle::capture(&serde_json::to_vec(&value).unwrap(), br#"{"a":"v"}"#, "en")
                .unwrap();
        assert_eq!(extract(&bundle, &Cancellation::default()).is_ok(), valid);
    }
    let mut source = br#"{"a":"b"}"#.to_vec();
    source.resize(MAX_SOURCE_BYTES - manifest.len(), b' ');
    assert!(SourceBundle::capture(manifest.as_bytes(), &source, "en").is_ok());
    source.push(b' ');
    assert_eq!(
        SourceBundle::capture(manifest.as_bytes(), &source, "en")
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let exact = serde_json::to_string(&json!({"a":"a".repeat(MAX_TEXT_BYTES)})).unwrap();
    assert!(extract(&small(&exact), &Cancellation::default()).is_ok());
    let over = serde_json::to_string(&json!({"a":"a".repeat(MAX_TEXT_BYTES+1)})).unwrap();
    assert_eq!(
        extract(&small(&over), &Cancellation::default())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let entries: serde_json::Map<String, serde_json::Value> = (0..=MAX_OCCURRENCES)
        .map(|i| (format!("key{i}"), json!("")))
        .collect();
    assert_eq!(
        extract(
            &small(&serde_json::to_string(&entries).unwrap()),
            &Cancellation::default()
        )
        .unwrap_err()
        .code,
        ErrorCode::LimitExceeded
    );
    let mut bundle = small(r#"{"a":"b"}"#);
    let mut unknown = value(&bundle).unwrap();
    unknown["requiredExtension"] = json!("future/v1");
    assert!(from_value::<SourceBundle>(&unknown).is_err());
    bundle.files[1].logical_path = "../outside.json".into();
    assert!(bundle.validate().is_err());
    assert!(SourceBundle::capture(manifest.as_bytes(), &[0xff], "en").is_err());
}

#[test]
fn source_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_SOURCE_CHILD") else {
        return;
    };
    let mut store = create(std::path::Path::new(&path));
    let (input, result) = generate(&mut store, small(r#"{"a":"one","b":"two"}"#));
    let action = prepare(&mut store, &input, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
}

#[test]
fn source_update_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_SOURCE_UPDATE_CHILD") else {
        return;
    };
    let mut store = ProjectStore::open(path).unwrap();
    let (input, result) = generate(&mut store, small(r#"{"a":"Changed","c":"Added"}"#));
    let confirmation = store
        .source_comparison(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap()
        .confirmation;
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
}

#[test]
fn upstream_process_abort_keeps_current_scope_lineage_and_receipt_atomic() {
    for point in [
        "during-source-adoption",
        "before-adoption-commit",
        "after-adoption-commit",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("project");
        let mut store = create(&path);
        let (input, result) = generate(&mut store, small(r#"{"a":"Original","b":"Removed"}"#));
        let action = prepare(&mut store, &input, &result);
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        let s1 = store.content_scope().unwrap();
        let original = store
            .source_content(s1.current_snapshot.unwrap(), 0, 10)
            .unwrap()
            .rows;
        store.close().unwrap();
        let hook = directory.path().join("hook");
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "content::tests::source_update_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_SOURCE_UPDATE_CHILD", &path)
            .env("TSUMUGI_EXECUTION_HOOK", &hook)
            .env(
                if point == "during-source-adoption" {
                    "TSUMUGI_SOURCE_CRASH"
                } else {
                    "TSUMUGI_EXECUTION_CRASH"
                },
                point,
            )
            .output()
            .unwrap();
        assert!(!status.status.success());
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        let reopened = ProjectStore::open(&path).unwrap();
        let committed = point == "after-adoption-commit";
        assert_eq!(
            reopened.content_scope().unwrap().revision.get(),
            if committed { 3 } else { 2 }
        );
        assert_eq!(
            reopened.source_history(0, 10).unwrap().total,
            if committed { 2 } else { 1 }
        );
        assert_eq!(
            reopened
                .source_content(s1.current_snapshot.unwrap(), 0, 10)
                .unwrap()
                .rows,
            original
        );
        let database = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        assert_eq!(
            database
                .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r
                    .get::<_, u32>(0))
                .unwrap(),
            if committed { 2 } else { 1 }
        );
    }
}

#[test]
fn process_abort_preserves_capture_output_and_adoption_boundaries() {
    for point in [
        "before-enqueue-commit",
        "after-enqueue",
        "after-output",
        "during-source-adoption",
        "before-adoption-commit",
        "after-adoption-commit",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("project");
        let hook = tmp.path().join("hook");
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "content::tests::source_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_SOURCE_CHILD", &path)
            .env("TSUMUGI_EXECUTION_HOOK", &hook)
            .env(
                if point == "during-source-adoption" {
                    "TSUMUGI_SOURCE_CRASH"
                } else {
                    "TSUMUGI_EXECUTION_CRASH"
                },
                point,
            );
        assert!(!child.output().unwrap().status.success());
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        let store = ProjectStore::open(&path).unwrap();
        let scope = store.content_scope().unwrap();
        assert_eq!(
            scope.current_snapshot.is_some(),
            point == "after-adoption-commit"
        );
        let conn = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let sets: i64 = conn
            .query_row("SELECT COUNT(*) FROM source_sets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            sets,
            if point == "before-enqueue-commit" {
                0
            } else {
                1
            }
        );
        let receipts: i64 = conn
            .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            receipts,
            if point == "after-adoption-commit" {
                1
            } else {
                0
            }
        );
    }
}
