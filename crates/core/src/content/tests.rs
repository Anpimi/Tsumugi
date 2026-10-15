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
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime
        .register_read_only(Arc::new(WebvttSourceRunner))
        .unwrap();
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
                (row.kind.as_str() == kind
                    || (kind == "unchanged" && row.kind == SourceChangeKind::Moved))
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
            .any(|row| row.kind == SourceChangeKind::Moved
                && row.new.as_ref().unwrap().key == "moved")
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
        assert_eq!(row.kind, SourceChangeKind::Ambiguous);
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
            .any(|row| row.kind == SourceChangeKind::RenameCandidate
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

fn assert_unsupported_source_snapshot_unchanged(path: &std::path::Path) {
    let database = path.join("project.sqlite3");
    let before = std::fs::read(&database).unwrap();
    let entries = || {
        std::fs::read_dir(path)
            .unwrap()
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<std::collections::BTreeSet<_>>>()
            .unwrap()
    };
    let before_entries = entries();
    let error = ProjectStore::open(path).unwrap_err();
    assert_eq!(error.code(), crate::PersistenceErrorCode::UnsupportedSchema);
    assert_eq!(error.found_schema_version(), Some(8));
    assert_eq!(std::fs::read(&database).unwrap(), before);
    assert_eq!(entries(), before_entries);
    let unchanged = rusqlite::Connection::open_with_flags(
        &database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        unchanged
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        8
    );
    assert_eq!(
        unchanged
            .query_row("SELECT COUNT(*) FROM source_snapshots", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        unchanged
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn source_schema_eight_refusal_child() {
    let Ok(path) = std::env::var("TSUMUGI_SOURCE_UNSUPPORTED_CHILD") else {
        return;
    };
    let proof = std::env::var("TSUMUGI_SOURCE_UNSUPPORTED_PROOF").unwrap();
    assert_unsupported_source_snapshot_unchanged(std::path::Path::new(&path));
    std::fs::write(proof, b"unsupported-schema:8").unwrap();
}

#[test]
fn schema_eight_process_reopen_preserves_source_without_backup_or_ddl() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, small(r#"{"key":"Original"}"#));
    let action = prepare(&mut store, &input, &result);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let original = store.content_scope().unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.content_scope().unwrap(), original);
    assert_eq!(reopened.source_history(0, 10).unwrap().total, 1);
    assert_eq!(
        reopened.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
    reopened.close().unwrap();
    let database = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    crate::persistence::prepare_unsupported_translation_fixture(&database).unwrap();
    database.execute_batch("DROP TABLE execution_continuations; DROP TABLE source_lineage_evidence; DROP TABLE source_lineage; PRAGMA user_version=8;").unwrap();
    drop(database);
    let before = std::fs::read(path.join("project.sqlite3")).unwrap();
    for replay in 0..2 {
        let proof = directory
            .path()
            .join(format!("source-refusal-{replay}.txt"));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "content::tests::source_schema_eight_refusal_child",
                "--nocapture",
            ])
            .env("TSUMUGI_SOURCE_UNSUPPORTED_CHILD", &path)
            .env("TSUMUGI_SOURCE_UNSUPPORTED_PROOF", &proof)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned source refusal child exceeded deadline");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        assert_eq!(std::fs::read(&proof).unwrap(), b"unsupported-schema:8");
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
        assert_unsupported_source_snapshot_unchanged(&path);
    }
}

#[test]
fn current_source_s1_reopens_and_schema_eight_is_refused_without_changes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, small(r#"{"greeting":"Hello"}"#));
    let action = prepare(&mut store, &input, &result);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.source_content(snapshot, 0, 50).unwrap().rows[0]
            .occurrence
            .key,
        "greeting"
    );
    assert_eq!(reopened.source_history(0, 10).unwrap().total, 1);
    assert_eq!(
        reopened.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
    reopened.close().unwrap();
    let database = path.join("project.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    crate::persistence::prepare_unsupported_translation_fixture(&connection).unwrap();
    connection.execute_batch("DROP TABLE execution_continuations; DROP TABLE source_lineage_evidence; DROP TABLE source_lineage; PRAGMA user_version=8;").unwrap();
    drop(connection);
    assert_unsupported_source_snapshot_unchanged(&path);
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
    // Newlines occupy two bytes in the captured JSON. Exceed the current
    // envelope ceiling independently of its configured size.
    let entries = (0..(MAX_INPUT_BYTES / (8192 * 2) + 1) as u32)
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
                source_template: None,
                locale: "zh-CN".into(),
                file_name: "i18n/zh.json".into(),
                entries,
            },
            BuildLocale {
                source_template: None,
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
fn source_template_warning_survives_preview_adoption_and_reopening() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("project");
    let mut store = create(&path);
    let captured = SourceBundle::capture(
        br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"%Version%","EntryDll":"Example.dll"}"#,
        br#"{"hello":"Hello"}"#,
        "en",
    ).unwrap();
    let (input, result) = generate(&mut store, captured);
    for diagnostic in [
        None,
        Some(Diagnostic {
            code: "forged-warning".into(),
            retry_safe: false,
        }),
    ] {
        let mut envelope = result.envelope().clone();
        envelope.result_id = ExecutionId::new();
        envelope.diagnostic = diagnostic;
        let forged =
            FixedResult::capture(envelope, &input, result.envelope().dispatch_token).unwrap();
        assert_eq!(
            validate_builtin_output(&input, &forged).unwrap_err().code,
            ErrorCode::OutputInvalid
        );
    }
    let preview = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            10,
        )
        .unwrap();
    assert_eq!(preview.diagnostics, ["source-template"]);
    let action = prepare(&mut store, &input, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_eq!(
        store.source_content(snapshot, 0, 10).unwrap().diagnostics,
        preview.diagnostics
    );
    drop(store);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened
            .source_content(snapshot, 0, 10)
            .unwrap()
            .diagnostics,
        ["source-template"]
    );
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
            (row.key_byte_range.unwrap(), &row.key),
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
fn unicode_source_fixture_keeps_original_utf8_ranges_in_both_profiles() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/source-unicode.contract.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let json_profile = case["profile"] == "smapi-json";
        let bundle = if json_profile {
            small(raw)
        } else {
            SourceBundle::capture_webvtt(raw.as_bytes(), "en").unwrap()
        };
        let source = bundle
            .files
            .iter()
            .find(|file| file.role == "source")
            .unwrap();
        let output = extract(&bundle, &Cancellation::default()).unwrap();
        let rows = case["rows"].as_array().unwrap();
        assert_eq!(output.occurrences.len(), rows.len());
        for (actual, expected) in output.occurrences.iter().zip(rows) {
            let occurrence = &expected["occurrence"];
            assert_eq!(
                actual.ordinal as u64,
                occurrence["ordinal"].as_u64().unwrap()
            );
            assert_eq!(actual.artifact_id, source.artifact_id);
            assert_eq!(actual.namespace, occurrence["namespace"].as_str().unwrap());
            assert_eq!(actual.key, occurrence["key"].as_str().unwrap());
            assert_eq!(actual.text, occurrence["text"].as_str().unwrap());
            assert_eq!(
                value(&actual.key_byte_range).unwrap(),
                occurrence["keyByteRange"]
            );
            assert_eq!(
                value(&actual.value_byte_range).unwrap(),
                occurrence["valueByteRange"]
            );
            let native = actual.native_identity.as_ref().unwrap();
            assert_eq!(native.display.value, actual.key);
            assert_eq!(native.value, actual.key.to_ascii_lowercase());
            if json_profile {
                assert_eq!(native.policy, contract_ref("smapi-native-key"));
            } else {
                assert_eq!(native.policy, contract_ref("webvtt-cue"));
                // The domain still owns the oracle's exact timing/layout basis.
                assert_eq!(
                    output.exchange.domain_blocks[0].payload_utf8,
                    occurrence["identityBasis"].as_str().unwrap()
                );
            }
            for (range, text, utf16) in [
                (
                    actual.key_byte_range.unwrap(),
                    &actual.key,
                    &expected["keyUtf16Range"],
                ),
                (
                    actual.value_byte_range,
                    &actual.text,
                    &expected["valueUtf16Range"],
                ),
            ] {
                let [start, end] = range.map(|offset| offset as usize);
                let token = raw
                    .get(start..end)
                    .expect("range must end at UTF-8 boundaries");
                let decoded = if json_profile {
                    serde_json::from_str::<String>(token).unwrap()
                } else {
                    token.replace("\r\n", "\n").replace('\r', "\n")
                };
                assert_eq!(&decoded, text);
                assert_eq!(
                    raw[..start].encode_utf16().count() as u64,
                    utf16[0].as_u64().unwrap()
                );
                assert_eq!(
                    raw[..end].encode_utf16().count() as u64,
                    utf16[1].as_u64().unwrap()
                );
            }
        }
    }
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
        "UniqueID": "N".repeat(256),
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
fn encoded_source_contract_limit_rejects_escaping_expansion_without_truncation() {
    let manifest = serde_json::to_vec(&json!({
        "UniqueID": "\"".repeat(256), "Name": "Example",
        "Version": "1.0.0", "EntryDll": "Example.dll",
    }))
    .unwrap();
    let entries: serde_json::Map<String, serde_json::Value> = (0..MAX_OCCURRENCES)
        .map(|index| (format!("key-{index:04}"), json!("")))
        .collect();
    let source = serde_json::to_vec(&entries).unwrap();
    let bundle = SourceBundle::capture(&manifest, &source, "en").unwrap();
    // Count limits do not override the independently documented encoded
    // ContentExchange ceiling. Return a typed limit, never partial coverage.
    assert_eq!(
        extract(&bundle, &Cancellation::default()).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
}

#[test]
fn malformed_output_cannot_become_valid_or_adopted() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let input = small(r#"{"a":"same","b":"same"}"#)
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    store.enqueue_read_only_execution(&input).unwrap();
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
    output.exchange.units.remove(1);
    output.exchange.order.remove(1);
    let result = FixedResult::capture(
        ResultEnvelope {
            plugin: None,
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: CAPABILITY.into(),
            capability_version: CAPABILITY_VERSION.into(),
            outcome: ExecutionState::Succeeded,
            output: Some(value(&output.exchange).unwrap()),
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
        "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE source_snapshots SET snapshot_id='00000000-0000-4000-8000-000000000099'; UPDATE content_scope SET current_snapshot='00000000-0000-4000-8000-000000000099'; UPDATE source_occurrences SET snapshot_id='00000000-0000-4000-8000-000000000099'; UPDATE source_unit_mappings SET snapshot_id='00000000-0000-4000-8000-000000000099'; COMMIT",
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
                output["artifacts"].as_array_mut().unwrap().pop();
            }
            1 => {
                output["units"][0]["occurrences"][0]["source"]["artifactId"] =
                    json!(ExecutionId::new());
            }
            2 => {
                output["order"][1] = output["order"][0].clone();
            }
            3 => {
                output["units"][0]["occurrences"][0]["source"]["range"]["end"] = json!(999999);
            }
            4 => {
                output["units"][0]["occurrences"][0]["nativeIdentity"]["policy"]["behaviorVersion"] =
                    json!(2);
            }
            5 => {
                output["requiredExtension"] = json!("future/v1");
            }
            6 => {
                output["artifacts"][0]["sha256"] = json!("0".repeat(64));
            }
            _ => unreachable!(),
        }
        let mut envelope = saved.envelope().clone();
        envelope.output = Some(output);
        let forged =
            FixedResult::capture(envelope, &input, saved.envelope().dispatch_token).unwrap();
        assert!(
            validate_builtin_output(&input, &forged).is_err(),
            "case {kind}"
        );
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

fn generic_source_binding(checker: bool) -> PluginExecutionBinding {
    PluginExecutionBinding {
        component_scope: tsumugi_plugin_sdk::ComponentScope::Project,
        capability: sdk::CapabilityBinding {
            provider: sdk::ProviderSelectionBinding {
                plugin: sdk::PluginIdentity {
                    publisher: "example".into(),
                    id: "example.source".into(),
                    version: "0.1.0".into(),
                },
                component_id: "source".into(),
                contribution_id: if checker { "check" } else { "extract" }.into(),
                package_digest: "a".repeat(64),
            },
            declaration: sdk::CapabilityDeclaration {
                contract: contract_ref(if checker {
                    "example.source-check"
                } else {
                    "example.source-extract"
                }),
                input_schema: if checker {
                    sdk::source_extraction_check_input_contract()
                } else {
                    sdk::source_extraction_input_contract()
                },
                output_schema: if checker {
                    sdk::check_results_contract()
                } else {
                    sdk::content_exchange_contract()
                },
                error_schema: sdk::source_extraction_error_contract(),
                profiles: vec![contract_ref("example.source-profile")],
                effect: sdk::EffectKind::ReadOnly,
                permissions: vec![sdk::PermissionRequest::CapturedInput],
                limits: sdk::CapabilityLimits {
                    max_input_bytes: MAX_INPUT_BYTES as u32,
                    max_output_bytes: MAX_INPUT_BYTES as u32,
                    concurrency: 1,
                    timeout_ms: 10_000,
                },
            },
        },
        profile: Some(contract_ref("example.source-profile")),
        environment: sdk::RuntimeEnvironmentDescriptor {
            protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
            platform: sdk::RuntimePlatform {
                operating_system: sdk::RuntimeOperatingSystem::Macos,
                architecture: sdk::RuntimeArchitecture::Aarch64,
            },
            sdk_version: "0.1.0-alpha.1".into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
            tool_version: "26.10.0".into(),
            tool: sdk::RuntimeArtifactBinding {
                tree_digest: "b".repeat(64),
                entrypoint: "bin/node".into(),
            },
            host: sdk::RuntimeArtifactBinding {
                tree_digest: "c".repeat(64),
                entrypoint: "dist/main.js".into(),
            },
        }
        .into(),
    }
}

fn generic_source_input(
    store: &ProjectStore,
    basis: u32,
    metadata: u32,
    canonical: &str,
    reject: bool,
) -> FixedInput {
    // Synthetic domain material. Core captures it without interpreting these fields.
    let bytes = serde_json::to_vec(&json!({ "basis": basis, "metadata": metadata,
        "canonical": canonical, "reject": reject }))
    .unwrap();
    let mut capture = SourceBundle::capture_webvtt(&bytes, "en").unwrap();
    capture.profile = contract_ref("example.source-profile");
    capture.format_id = capture.profile.id.clone();
    capture.manifest_digest = capture.calculate_digest().unwrap();
    capture
        .fixed_plugin_input(
            store.metadata().unwrap().project_id(),
            generic_source_binding(false),
            SourceSettings {
                revision_policy: sdk::SourceRevisionPolicy {
                    profile: capture.profile.clone(),
                    revision_basis: vec![contract_ref("example.semantic-basis")],
                },
                checker: Some(generic_source_binding(true)),
                semantic_rules: vec![contract_ref("example.source-semantics")],
                review: None,
            },
        )
        .unwrap()
}

#[test]
fn source_import_declared_capture_preserves_material_without_domain_interpretation() {
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../plugin-sdk/tests/fixtures/source-import.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_source_import_declaration(include_bytes!(
        "../../../plugin-sdk/tests/fixtures/source-import.declaration.json"
    ))
    .unwrap();
    let binding = declaration
        .bind(
            &manifest,
            &"a".repeat(64),
            &sdk::parse_review_declaration(include_bytes!(
                "../../../plugin-sdk/tests/fixtures/source-import.review.json"
            ))
            .unwrap(),
        )
        .unwrap();
    let raw = "\u{feff}uninterpreted 👩🏽‍💻 é\r\n";
    let materials = vec![raw.as_bytes().to_vec(), b"not a manifest".to_vec()];
    let bundle = SourceBundle::capture_declared(&binding, materials.clone(), "en-US").unwrap();
    assert_eq!(bundle.plugin_id, "plain-text");
    assert_eq!(bundle.profile.id, "example.plain-text");
    assert_eq!(bundle.files[0].logical_path, "materials/raw.txt");
    assert_eq!(bundle.files[0].utf8.as_bytes(), raw.as_bytes());
    assert_ne!(bundle.files[0].artifact_id, bundle.files[1].artifact_id);
    assert!(SourceBundle::capture_declared(&binding, vec![materials[0].clone()], "en-US").is_err());
    assert!(
        SourceBundle::capture_declared(
            &binding,
            vec![vec![b'x'; 131073], materials[1].clone()],
            "en-US"
        )
        .is_err()
    );
    assert!(
        SourceBundle::capture_declared(&binding, vec![vec![0xff], materials[1].clone()], "en-US")
            .is_err()
    );
    let environment = generic_source_binding(false).environment;
    let selected = |capability| PluginExecutionBinding {
        component_scope: tsumugi_plugin_sdk::ComponentScope::Project,
        capability,
        profile: Some(declaration.profile.clone()),
        environment: environment.clone(),
    };
    let input = bundle
        .fixed_plugin_input(
            crate::ProjectId::new_v4(),
            selected(binding.extractor.clone()),
            SourceSettings {
                revision_policy: declaration.revision_policy.clone(),
                checker: Some(selected(binding.checker)),
                semantic_rules: declaration.semantic_rules.clone(),
                review: Some(SourceReviewBinding::capture(&binding.review, &environment).unwrap()),
            },
        )
        .unwrap();
    assert_eq!(SourceBundle::from_input(&input).unwrap(), bundle);
    assert_eq!(
        SourceSettings::from_input(&input).unwrap().semantic_rules,
        declaration.semantic_rules
    );
}

fn generic_source_proposal(source: &sdk::SourceExtractionInput) -> sdk::ContentExchange {
    let config: serde_json::Value = serde_json::from_str(&source.artifacts[0].utf8).unwrap();
    let suffix = config["metadata"].as_u64().unwrap();
    let reference = sdk::SourceReference {
        artifact_id: source.artifacts[0].id.clone(),
        range: sdk::TextRange {
            encoding: sdk::TextEncoding::Utf8Byte,
            start: 0,
            end: source.artifacts[0].utf8.len() as u32,
        },
    };
    let occurrence = |name: &str, canonical: &str, display: &str| sdk::ContentOccurrence {
        id: format!("{name}-{suffix}"),
        source: reference.clone(),
        native_identity: Some(sdk::NativeIdentityEvidence {
            namespace: "Fixture.Source".into(),
            value: canonical.into(),
            policy: contract_ref("example.case-sensitive-key"),
            display: sdk::NativeIdentityDisplay {
                value: display.into(),
                source: None,
            },
        }),
    };
    let shared_id = format!("shared-{suffix}");
    let first = occurrence("first", "Shared.A", "Original A");
    let second = occurrence("second", "Shared.A", "Original B");
    let case = occurrence(
        "case",
        config["canonical"].as_str().unwrap(),
        "Original Case",
    );
    let order = vec![first.id.clone(), second.id.clone(), case.id.clone()];
    sdk::ContentExchange {
        profile: source.profile.clone(),
        source_set_id: source.source_set_id.clone(),
        source_language: source.source_language.clone(),
        artifacts: source.artifacts.clone(),
        units: vec![
            sdk::ContentUnit {
                id: shared_id.clone(),
                source_revision_id: format!("proposal-shared-{suffix}"),
                text: "Shared {{token}}".into(),
                occurrences: vec![first, second],
                protected_fragments: vec![sdk::ProtectedFragment {
                    kind: contract_ref("example.token"),
                    range: sdk::TextRange {
                        encoding: sdk::TextEncoding::Utf8Byte,
                        start: 7,
                        end: 16,
                    },
                }],
            },
            sdk::ContentUnit {
                id: format!("case-unit-{suffix}"),
                source_revision_id: format!("proposal-case-{suffix}"),
                text: "Case-sensitive".into(),
                occurrences: vec![case],
                protected_fragments: vec![],
            },
        ],
        relations: vec![sdk::ContentRelation {
            kind: contract_ref("example.shared-occurrences"),
            from_occurrence: order[0].clone(),
            to_occurrence: order[1].clone(),
        }],
        order,
        domain_blocks: vec![
            sdk::DomainBlock {
                target: sdk::ContentTarget::Unit { id: shared_id },
                schema: contract_ref("example.semantic-basis"),
                handling: sdk::ExtensionHandling::Required,
                payload_utf8: format!("{{\"basis\": {}}}", config["basis"]),
            },
            sdk::DomainBlock {
                target: sdk::ContentTarget::Snapshot,
                schema: contract_ref("example.opaque-metadata"),
                handling: sdk::ExtensionHandling::Required,
                payload_utf8: format!("{{\"metadata\": {suffix}, \"preserve\":\"\\u4e16\"}}"),
            },
        ],
    }
}

/// A bounded in-process domain fixture, using the same grant/result/semantic
/// check boundaries as an external adapter. This does not test a native Host.
struct GenericSourcePlugin(PluginExecutionBinding);
impl Runner for GenericSourcePlugin {
    fn capability_id(&self) -> &str {
        &self.0.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.0.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.0.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        if cancellation.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "fixture-cancelled"));
        }
        let permit = request.plugin_permit().unwrap();
        assert!(permit.matches(&request.input) && permit.is_authorized());
        let selection = &self.0.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: selection.plugin.clone(),
            component_id: selection.component_id.clone(),
            contribution_id: selection.contribution_id.clone(),
            package_digest: selection.package_digest.clone(),
            instance_id: ExecutionId::new().to_string(),
            activation_generation: 1,
        };
        let invocation =
            request
                .input
                .plugin_request(request.item_id, request.dispatch_token, &channel)?;
        let output = if request.input.envelope().operation == OPERATION {
            value(&generic_source_proposal(
                &SourceBundle::from_input(&request.input)?.source_input(),
            ))?
        } else {
            let check: sdk::SourceExtractionCheckInput =
                from_value(&request.input.item(request.item_id)?.payload)?;
            check.validate().unwrap();
            let config: serde_json::Value =
                serde_json::from_str(&check.source.artifacts[0].utf8).unwrap();
            let matches = check.proposal == generic_source_proposal(&check.source)
                && config["reject"] == false;
            let checked: Vec<_> = check
                .requirements
                .into_iter()
                .map(|required| sdk::CheckResult {
                    key: required.key,
                    input_digest: required.input_digest,
                    scope_digest: required.scope_digest,
                    covered_targets: required.targets.clone(),
                    outcome: sdk::CheckOutcome::Completed {
                        findings: if matches {
                            vec![]
                        } else {
                            vec![sdk::CheckFinding {
                                code: "fixture-source-invalid".into(),
                                target: required.targets[0].clone(),
                                severity: sdk::FindingSeverity::Error,
                            }]
                        },
                    },
                })
                .collect();
            value(&checked)?
        };
        let evidence = PluginResultEvidence {
            authorization_id: permit.grant_id(),
            channel: channel.clone(),
            result: sdk::InvocationResult {
                context: invocation.context,
                provider: channel,
                capability: invocation.capability,
                profile: invocation.profile,
                result_id: ExecutionId::new().to_string(),
                outcome: sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(
                        invocation.output_schema,
                        serde_json::to_string(&output).unwrap(),
                    )
                    .unwrap(),
                },
            },
        };
        results.send(FixedResult::capture_plugin(
            &request.input,
            request.item_id,
            request.dispatch_token,
            evidence,
        )?)
    }
}

fn run_generic_source(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> FixedResult {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    runtime
        .authorize_plugin(
            store,
            ExecutionId::new(),
            input,
            now + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        runtime.tick(store).unwrap();
        let view = runtime.attempt(store, input.envelope().attempt_id).unwrap();
        if view.items[0].execution == ExecutionState::Succeeded {
            let result = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            return store
                .execution_result(input.envelope().attempt_id, result)
                .unwrap();
        }
        assert!(
            !matches!(
                view.items[0].execution,
                ExecutionState::Failed | ExecutionState::Unknown
            ),
            "{view:?}"
        );
        assert!(Instant::now() < deadline, "fixture did not complete");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn check_generic_source(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
    result: &FixedResult,
) {
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    assert!(
        runtime.submit(store, &check_input).is_err(),
        "checker needs its own consent"
    );
    let checked = run_generic_source(runtime, store, &check_input);
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
}

/// Reuse the synthetic in-process source/check fixture for downstream identity
/// mapping tests. It registers no Node process or installed domain component.
pub(crate) fn adopt_shared_source_fixture(store: &mut ProjectStore) {
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    for checker in [false, true] {
        runtime
            .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                checker,
            ))))
            .unwrap();
    }
    let input = generic_source_input(store, 1, 1, "CaseKey", false);
    let result = run_generic_source(&mut runtime, store, &input);
    check_generic_source(&mut runtime, store, &input, &result);
    let action = prepare(store, &input, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
}

#[test]
fn maintenance_window_keeps_occurrence_display_and_canonical_plan_identity_separate() {
    use crate::application::{
        MaintenanceAction, MaintenanceChoice, MaintenancePlanBasis, PlanOptions,
    };

    let temp = tempfile::tempdir().unwrap();
    let mut store = create(&temp.path().join("project"));
    adopt_shared_source_fixture(&mut store);
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let content = store.source_content(snapshot, 0, 3).unwrap();
    let unit = content.rows[0].unit_id.unwrap();
    assert_eq!(content.rows[1].unit_id, Some(unit));
    assert_eq!(content.rows[0].occurrence.key, "Original A");
    assert_eq!(content.rows[1].occurrence.key, "Original B");

    let assessment = store
        .maintenance_assessment(project, snapshot, "zh-CN", 1, 1)
        .unwrap();
    assert_eq!(assessment.rows.len(), 1);
    assert_eq!(assessment.rows[0].unit_id, unit);
    assert_eq!(assessment.rows[0].native_key, "Original B");
    let basis = MaintenancePlanBasis {
        assessment,
        choices: vec![MaintenanceChoice {
            unit_id: unit,
            action: MaintenanceAction::Repair,
            excluded: false,
        }],
    };
    let config = crate::ai::AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-model".into(),
        credential_env: String::new(),
        ..crate::ai::AiConfig::default()
    };
    let ordinary = store
        .prepare_work_plan(
            Some(config.clone()),
            "zh-CN",
            &[unit],
            PlanOptions::default(),
        )
        .unwrap();
    assert_eq!(ordinary.selection_basis[0].native_key, "Original A");
    let plan = store
        .prepare_maintenance_work_plan(
            Some(config.clone()),
            "zh-CN",
            &[unit],
            PlanOptions::default(),
            None,
            basis.clone(),
        )
        .unwrap();
    assert_eq!(plan.selection_basis, ordinary.selection_basis);
    assert_eq!(plan.maintenance.as_ref(), Some(&basis));
    let input = plan.fixed_input().unwrap();
    assert_eq!(
        crate::ai::item_payload(&input, input.envelope().items[0].item_id)
            .unwrap()
            .native_key,
        "Original A"
    );
    store.verify_work_plan(&plan).unwrap();

    let mut manual_options = PlanOptions::default();
    for stage in &mut manual_options.stages {
        stage.mode = crate::application::StageMode::Manual;
    }
    let mut wrong_key = store
        .prepare_work_plan(None, "zh-CN", &[unit], manual_options)
        .unwrap();
    wrong_key.selection_basis[0].native_key = "Changed canonical key".into();
    let wrong_key = wrong_key.with_maintenance(basis.clone()).unwrap();
    assert_eq!(
        store.verify_work_plan(&wrong_key).unwrap_err().stage,
        "work-plan-selection"
    );

    for field in ["unit", "source-revision", "source-snapshot", "selection"] {
        let mut altered = basis.clone();
        let row = &mut altered.assessment.rows[0];
        match field {
            "unit" => {
                row.unit_id = ExecutionId::new();
                row.protection.unit_id = row.unit_id;
                altered.choices[0].unit_id = row.unit_id;
            }
            "source-revision" => row.source_revision_id = ExecutionId::new(),
            "source-snapshot" => altered.assessment.source_snapshot_id = ExecutionId::new(),
            "selection" => row.selection_id = Some(ExecutionId::new()),
            _ => unreachable!(),
        }
        // Keep the assessment internally well-formed: refusal must follow from
        // its mismatch with the fixed plan or current project, not a stale digest.
        altered.assessment.digest = altered.assessment.computed_digest().unwrap();
        assert_eq!(
            ordinary
                .clone()
                .with_maintenance(altered.clone())
                .unwrap_err()
                .stage,
            "maintenance-scope",
            "{field}"
        );
        assert_eq!(
            store
                .prepare_maintenance_work_plan(
                    Some(config.clone()),
                    "zh-CN",
                    &[unit],
                    PlanOptions::default(),
                    None,
                    altered,
                )
                .unwrap_err()
                .stage,
            if field == "source-snapshot" {
                "stale-preview"
            } else {
                "maintenance-current"
            },
            "{field}"
        );
    }
}

#[test]
fn generic_source_adoption_maps_shared_units_and_preserves_fixed_revision_evidence_on_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
    for checker in [false, true] {
        runtime
            .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                checker,
            ))))
            .unwrap();
    }
    let initial = generic_source_input(&store, 1, 1, "CaseKey", false);
    let result = run_generic_source(&mut runtime, &mut store, &initial);
    assert_eq!(
        store
            .execution_attempt(initial.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Pending
    );
    let proposal = validate_output(&initial, &result).unwrap();
    assert_eq!(
        proposal.exchange,
        generic_source_proposal(&SourceBundle::from_input(&initial).unwrap().source_input())
    );
    let mut identity = proposal.occurrences[0].clone();
    identity
        .native_identity
        .as_mut()
        .unwrap()
        .policy
        .behavior_version = 2;
    assert!(!identity.same_identity(&proposal.occurrences[0]));
    let mut fragment_change = proposal.exchange.clone();
    fragment_change.units[0].protected_fragments[0].range.end -= 1;
    let projected = project_source_output(
        &SourceBundle::from_input(&initial).unwrap(),
        fragment_change,
        proposal.revision_policy.clone(),
    )
    .unwrap();
    assert_ne!(
        projected.occurrences[0].identity_basis,
        proposal.occurrences[0].identity_basis
    );
    let mut text_change = proposal.exchange.clone();
    text_change.units[0].text = "Edited {{token}}".into();
    let projected = project_source_output(
        &SourceBundle::from_input(&initial).unwrap(),
        text_change,
        proposal.revision_policy.clone(),
    )
    .unwrap();
    assert_ne!(
        projected.occurrences[0].identity_basis,
        proposal.occurrences[0].identity_basis
    );
    let action = prepare(&mut store, &initial, &result);
    assert!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .is_err(),
        "structure cannot authorize adoption"
    );
    check_generic_source(&mut runtime, &mut store, &initial, &result);
    let action = prepare(&mut store, &initial, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let first = store
        .source_content(
            store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            50,
        )
        .unwrap();
    assert_eq!(first.rows.len(), 3);
    assert_eq!(first.rows[0].unit_id, first.rows[1].unit_id);
    assert_eq!(
        first.rows[0].source_revision_id,
        first.rows[1].source_revision_id
    );
    assert_ne!(first.rows[0].unit_id, first.rows[2].unit_id);
    assert_eq!(first.rows[0].occurrence.key, "Original A");
    assert_eq!(
        first.rows[0]
            .occurrence
            .native_identity
            .as_ref()
            .unwrap()
            .value,
        "Shared.A"
    );
    assert!(first.rows[0].occurrence.key_byte_range.is_none());
    let review = store.review_page(project, "zh-CN", 0, 50).unwrap();
    assert_eq!(review.total, 2);
    assert_eq!(review.rows.len(), 2);
    assert_eq!(
        store
            .review_page_filtered(project, "zh-CN", 0, 50, "Original B")
            .unwrap()
            .total,
        1
    );

    // Both domain metadata and operation-local target IDs change. Neither is
    // in the captured semantic revision basis.
    let next = generic_source_input(&store, 1, 2, "CaseKey", false);
    let next_result = run_generic_source(&mut runtime, &mut store, &next);
    check_generic_source(&mut runtime, &mut store, &next, &next_result);
    let action = prepare(&mut store, &next, &next_result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let second = store
        .source_content(
            store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            50,
        )
        .unwrap();
    for (old, new) in first.rows.iter().zip(&second.rows) {
        assert_eq!(old.unit_id, new.unit_id);
        assert_eq!(old.source_revision_id, new.source_revision_id);
        assert_ne!(
            old.occurrence.operation_unit_id,
            new.occurrence.operation_unit_id
        );
    }

    // A selected opaque basis changes the shared unit revision only after an
    // explicit lineage decision. Canonical case differences never auto-match.
    let next = generic_source_input(&store, 2, 3, "caseKey", false);
    let next_result = run_generic_source(&mut runtime, &mut store, &next);
    check_generic_source(&mut runtime, &mut store, &next, &next_result);
    let mut confirmation = store
        .source_preview(
            next.envelope().attempt_id,
            next_result.envelope().result_id,
            0,
            50,
        )
        .unwrap()
        .confirmation;
    confirmation.actor = Some("Fixture reviewer".into());
    confirmation.lineage.push(LineageChoice {
        new_ordinal: 0,
        old_occurrence_id: second.rows[0].occurrence_id.unwrap(),
        decision: LineageDecision::Continue,
        reason: "Same source unit with revised domain basis".into(),
    });
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            next.envelope().attempt_id,
            next.envelope().units[0].unit_id,
            vec![next_result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let third = store.source_content(snapshot, 0, 50).unwrap();
    assert_eq!(third.rows[0].unit_id, first.rows[0].unit_id);
    assert_eq!(third.rows[0].unit_id, third.rows[1].unit_id);
    assert_ne!(
        third.rows[0].source_revision_id,
        first.rows[0].source_revision_id
    );
    assert_eq!(
        third.rows[0].source_revision_id,
        third.rows[1].source_revision_id
    );
    assert_ne!(third.rows[2].unit_id, first.rows[2].unit_id);
    let saved = store
        .execution_result(next.envelope().attempt_id, next_result.envelope().result_id)
        .unwrap();
    let exchange = validate_output(&next, &saved).unwrap().exchange;
    assert_eq!(
        exchange.domain_blocks[1].payload_utf8,
        "{\"metadata\": 3, \"preserve\":\"\\u4e16\"}"
    );
    assert_eq!(exchange.relations.len(), 1);
    assert_eq!(exchange.units[0].protected_fragments.len(), 1);
    drop(runtime);
    drop(store);
    let store = ProjectStore::open(&path).unwrap();
    assert_eq!(store.source_content(snapshot, 0, 50).unwrap(), third);
    let input = store.execution_input(next.envelope().attempt_id).unwrap();
    let result = store
        .execution_result(next.envelope().attempt_id, next_result.envelope().result_id)
        .unwrap();
    assert_eq!(result.bytes(), saved.bytes());
    assert_eq!(validate_output(&input, &result).unwrap().exchange, exchange);
}

#[test]
fn plugin_source_adoption_rechecks_checker_authority_before_capture_and_commit() {
    for after_prepare in [false, true] {
        for cancel in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let mut store = create(&temp.path().join("project"));
            let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
            for checker in [false, true] {
                runtime
                    .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                        checker,
                    ))))
                    .unwrap();
            }
            let input = generic_source_input(&store, 1, 1, "CaseKey", false);
            let result = run_generic_source(&mut runtime, &mut store, &input);
            let capture = store
                .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
                .unwrap();
            let check_input = capture.check_input().clone();
            let checked = run_generic_source(&mut runtime, &mut store, &check_input);
            let grant = checked.envelope().plugin.as_ref().unwrap().authorization_id;
            store
                .commit_source_validation(capture.prepare(checked).unwrap())
                .unwrap();
            let action = prepare(&mut store, &input, &result);
            let prepared = after_prepare.then(|| {
                store
                    .capture_execution_adoption(&action)
                    .unwrap()
                    .prepare(&SourceAdoptionHandler)
                    .unwrap()
            });
            if cancel {
                store
                    .cancel_execution(check_input.envelope().task_id, ExecutionId::new())
                    .unwrap();
            } else {
                runtime.revoke_plugin(&mut store, grant).unwrap();
            }
            let error = if let Some(prepared) = prepared {
                store
                    .commit_execution_adoption(prepared)
                    .err()
                    .expect("checker authority loss must reject a prepared adoption")
            } else {
                store
                    .capture_execution_adoption(&action)
                    .err()
                    .expect("checker authority loss must reject adoption capture")
            };
            assert_eq!(
                error.code,
                if cancel {
                    ErrorCode::Cancelled
                } else {
                    ErrorCode::Unauthorized
                },
                "after_prepare={after_prepare}, cancel={cancel}"
            );
            assert!(store.content_scope().unwrap().current_snapshot.is_none());
            assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
            assert_eq!(
                store
                    .execution_attempt(input.envelope().attempt_id, false)
                    .unwrap()
                    .items[0]
                    .validation,
                ValidationState::Valid,
                "revocation does not erase the saved semantic evidence"
            );
            assert!(
                store
                    .source_preview(
                        input.envelope().attempt_id,
                        result.envelope().result_id,
                        0,
                        50,
                    )
                    .is_ok(),
                "reading a saved proposal does not require current execution authority"
            );
        }
    }
}

#[test]
fn plugin_source_adoption_refuses_a_superseded_checker_after_saved_proof() {
    for after_prepare in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let mut store = create(&temp.path().join("project"));
        let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
        for checker in [false, true] {
            runtime
                .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                    checker,
                ))))
                .unwrap();
        }
        let input = generic_source_input(&store, 1, 1, "CaseKey", false);
        let result = run_generic_source(&mut runtime, &mut store, &input);
        let capture = store
            .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = capture.check_input().clone();
        let checked = run_generic_source(&mut runtime, &mut store, &check_input);
        store
            .commit_source_validation(capture.prepare(checked.clone()).unwrap())
            .unwrap();
        let action = prepare(&mut store, &input, &result);
        let prepared = after_prepare.then(|| {
            store
                .capture_execution_adoption(&action)
                .unwrap()
                .prepare(&SourceAdoptionHandler)
                .unwrap()
        });
        let mut envelope = checked.envelope().clone();
        envelope.result_id = ExecutionId::new();
        envelope.supersedes = Some(checked.envelope().result_id);
        envelope.plugin.as_mut().unwrap().result.result_id = ExecutionId::new().to_string();
        let replacement =
            FixedResult::capture(envelope, &check_input, checked.envelope().dispatch_token)
                .unwrap();
        store.save_execution_result(&replacement).unwrap();
        let error = if let Some(prepared) = prepared {
            store.commit_execution_adoption(prepared).unwrap_err()
        } else {
            store.capture_execution_adoption(&action).unwrap_err()
        };
        assert_eq!(error.code, ErrorCode::ResultMismatch);
        assert!(store.content_scope().unwrap().current_snapshot.is_none());
        assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
        assert!(
            store
                .source_preview(
                    input.envelope().attempt_id,
                    result.envelope().result_id,
                    0,
                    50
                )
                .is_ok()
        );
    }
}

#[test]
fn adopted_plugin_source_remains_readable_after_checker_revocation_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
    for checker in [false, true] {
        runtime
            .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                checker,
            ))))
            .unwrap();
    }
    let input = generic_source_input(&store, 1, 1, "CaseKey", false);
    let result = run_generic_source(&mut runtime, &mut store, &input);
    let capture = store
        .capture_source_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    let checked = run_generic_source(&mut runtime, &mut store, &check_input);
    let checker_grant = checked.envelope().plugin.as_ref().unwrap().authorization_id;
    store
        .commit_source_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let action = prepare(&mut store, &input, &result);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let content = store.source_content(snapshot, 0, 50).unwrap();
    runtime.revoke_plugin(&mut store, checker_grant).unwrap();
    assert_eq!(store.source_content(snapshot, 0, 50).unwrap(), content);
    assert_eq!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap(),
        receipt,
        "replaying a committed receipt does not perform a new adoption"
    );
    drop(runtime);
    drop(store);
    let mut store = ProjectStore::open(&path).unwrap();
    assert_eq!(store.source_content(snapshot, 0, 50).unwrap(), content);
    assert_eq!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
    assert_eq!(
        store
            .execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
}

#[test]
fn adopted_plugin_source_requires_its_saved_semantic_proof_for_reads_and_reopening() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
    for checker in [false, true] {
        runtime
            .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                checker,
            ))))
            .unwrap();
    }
    let input = generic_source_input(&store, 1, 1, "CaseKey", false);
    let result = run_generic_source(&mut runtime, &mut store, &input);
    check_generic_source(&mut runtime, &mut store, &input, &result);
    let action = prepare(&mut store, &input, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    assert_eq!(store.source_content(snapshot, 0, 50).unwrap().rows.len(), 3);
    drop(runtime);
    // Synthetic external damage satisfies the individual CHECK/FK constraints,
    // but must not downgrade the mandatory proof of an adopted source snapshot.
    let connection = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE execution_items SET validation='pending' WHERE attempt_id=?1",
            [input.envelope().attempt_id.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "DELETE FROM plugin_validation_links WHERE producer_result_id=?1",
            [result.envelope().result_id.to_string()],
        )
        .unwrap();
    drop(connection);
    let bytes = std::fs::read(path.join("project.sqlite3")).unwrap();
    assert!(store.source_content(snapshot, 0, 50).is_err());
    assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), bytes);
    drop(store);
    assert!(ProjectStore::open(&path).is_err());
    assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), bytes);
}

#[test]
fn generic_source_requires_fixed_checker_rules_and_a_nonblocking_semantic_result() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = create(&temp.path().join("project"));
    let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
    for checker in [false, true] {
        runtime
            .register_read_only(Arc::new(GenericSourcePlugin(generic_source_binding(
                checker,
            ))))
            .unwrap();
    }
    let input = generic_source_input(&store, 1, 1, "CaseKey", true);
    for kind in 0..4 {
        let mut envelope = input.envelope().clone();
        match kind {
            0 => {
                envelope.settings["semanticRules"] = json!([]);
            }
            1 => {
                envelope.settings["semanticRules"] = json!([
                    contract_ref("example.source-semantics"),
                    contract_ref("example.source-semantics")
                ]);
            }
            2 => {
                envelope.settings["checker"] = serde_json::Value::Null;
            }
            3 => {
                envelope.settings["checker"]["capability"]["declaration"]["inputSchema"] =
                    json!(contract_ref("example.wrong-input"));
            }
            _ => unreachable!(),
        }
        let forged = FixedInput::capture(envelope).unwrap();
        assert!(
            SourceBundle::from_input(&forged).is_err(),
            "settings {kind}"
        );
    }
    let result = run_generic_source(&mut runtime, &mut store, &input);
    check_generic_source(&mut runtime, &mut store, &input, &result);
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
fn generic_captured_source_rejects_its_serialized_store_budget_before_enqueue() {
    let temp = tempfile::tempdir().unwrap();
    let store = create(&temp.path().join("project"));
    let input = generic_source_input(&store, 1, 1, "CaseKey", false);
    let mut capture = SourceBundle::from_input(&input).unwrap();
    let file = &mut capture.files[0];
    // The raw material is within the SDK budget; JSON quoting pushes the
    // immutable Core capture over its separate one MiB storage boundary.
    file.utf8 = "\"".repeat(600_000);
    file.byte_length = file.utf8.len() as u32;
    file.sha256 = codec::digest(file.utf8.as_bytes());
    capture.manifest_digest = capture.calculate_digest().unwrap();
    capture.source_input().validate().unwrap();
    assert_eq!(
        capture.validate().unwrap_err().code,
        ErrorCode::LimitExceeded
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

#[path = "webvtt_tests.rs"]
mod webvtt_tests;

#[test]
fn current_layout_tagged_schema_eight_process_reopen_is_refused_without_backup_or_ddl() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, small(r#"{"key":"Original"}"#));
    let action = prepare(&mut store, &input, &result);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let original = store.content_scope().unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.content_scope().unwrap(), original);
    assert_eq!(reopened.source_history(0, 10).unwrap().total, 1);
    assert_eq!(
        reopened.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
    reopened.close().unwrap();
    let database = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    database.pragma_update(None, "user_version", 8).unwrap();
    drop(database);
    let before = std::fs::read(path.join("project.sqlite3")).unwrap();
    for replay in 0..2 {
        let proof = directory
            .path()
            .join(format!("source-refusal-{replay}.txt"));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "content::tests::source_schema_eight_refusal_child",
                "--nocapture",
            ])
            .env("TSUMUGI_SOURCE_UNSUPPORTED_CHILD", &path)
            .env("TSUMUGI_SOURCE_UNSUPPORTED_PROOF", &proof)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("owned source refusal child exceeded deadline");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        assert_eq!(std::fs::read(&proof).unwrap(), b"unsupported-schema:8");
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
        assert_unsupported_source_snapshot_unchanged(&path);
    }
}

#[test]
fn current_source_s1_reopens_and_current_layout_tagged_schema_eight_is_refused_without_changes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, small(r#"{"greeting":"Hello"}"#));
    let action = prepare(&mut store, &input, &result);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.source_content(snapshot, 0, 50).unwrap().rows[0]
            .occurrence
            .key,
        "greeting"
    );
    assert_eq!(reopened.source_history(0, 10).unwrap().total, 1);
    assert_eq!(
        reopened.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
    reopened.close().unwrap();
    let database = path.join("project.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    connection.pragma_update(None, "user_version", 8).unwrap();
    drop(connection);
    assert_unsupported_source_snapshot_unchanged(&path);
}
