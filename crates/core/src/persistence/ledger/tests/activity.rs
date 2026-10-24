use super::*;

#[test]
fn task_activity_is_empty_bounded_and_read_only() {
    let parent = tempfile::tempdir().unwrap();
    let store = store(&parent.path().join("project"));
    let before: i64 = store
        .execution_connection()
        .unwrap()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    let page = store.execution_task_activity(12, &[]).unwrap();
    assert_eq!(page.total.get(), 0);
    assert!(page.rows.is_empty());
    for limit in [0, 21, u32::MAX] {
        assert_eq!(
            store.execution_task_activity(limit, &[]).unwrap_err().code,
            ErrorCode::LimitExceeded
        );
    }
    let after: i64 = store
        .execution_connection()
        .unwrap()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn task_activity_prioritizes_current_states_and_counts_beyond_the_visible_page() {
    let _schema = TestSchema::enable();
    let parent = tempfile::tempdir().unwrap();
    let mut store = store(&parent.path().join("project"));
    install_targets(&store);
    let mut inputs = Vec::new();
    for _ in 0..23 {
        let input = fixture_input(&store, false);
        store.enqueue_read_only_execution(&input).unwrap();
        inputs.push(input);
    }
    let connection = store.execution_connection().unwrap();
    // Synthetic status rows exercise only this compact ledger projection.
    // They are not a source/checker/adoption or reopen conformance fixture.
    connection
        .execute(
            "UPDATE execution_items SET execution='succeeded',validation='valid'",
            [],
        )
        .unwrap();
    for (index, execution, validation) in [
        (0, "dispatched", "absent"),
        (1, "unknown", "absent"),
        (2, "failed", "invalid"),
        (3, "cancelled-before-dispatch", "absent"),
        (4, "succeeded", "pending"),
    ] {
        connection
            .execute(
                "UPDATE execution_items SET execution=?1,validation=?2 WHERE attempt_id=?3",
                params![
                    execution,
                    validation,
                    inputs[index].envelope().attempt_id.to_string()
                ],
            )
            .unwrap();
    }
    let before: i64 = connection
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    let page = store
        .execution_task_activity(3, &[inputs[0].envelope().attempt_id])
        .unwrap();
    assert_eq!(
        (
            page.total.get(),
            page.active.get(),
            page.attention.get(),
            page.saved.get()
        ),
        (23, 1, 4, 18)
    );
    assert_eq!(page.rows.len(), 3);
    assert_eq!(page.rows[0].task_id, inputs[0].envelope().task_id);
    assert_eq!(page.rows[0].phase, TaskActivityPhase::Active);
    assert_eq!(page.rows[0].progress.running, 3);
    assert_eq!(page.rows[1].task_id, inputs[4].envelope().task_id);
    assert_eq!(page.rows[1].phase, TaskActivityPhase::Attention);
    let all = store
        .execution_task_activity(20, &[inputs[0].envelope().attempt_id])
        .unwrap();
    assert_eq!(all.rows.len(), 20);
    assert_eq!(all.rows[4].progress.unknown, 3);
    assert_eq!(all.rows[5].phase, TaskActivityPhase::Saved);
    assert_eq!(all.rows[5].progress.adopted, 0);
    let after: i64 = connection
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn task_activity_keeps_uncovered_old_work_and_supersedes_only_retried_items() {
    let _schema = TestSchema::enable();
    for unknown in [false, true] {
        let parent = tempfile::tempdir().unwrap();
        let mut store = store(&parent.path().join("project"));
        install_targets(&store);
        let original = fixture_input(&store, false);
        store.enqueue_read_only_execution(&original).unwrap();
        for item in original.envelope().items.iter().skip(1) {
            store
                .dispatch_execution_item(original.envelope().attempt_id, item.item_id)
                .unwrap();
            if unknown {
                store
                    .note_execution_unknown(
                        original.envelope().attempt_id,
                        item.item_id,
                        "controlled-unknown",
                    )
                    .unwrap();
            }
        }
        let action = crate::execution::test_continuation_action(
            &store,
            original.envelope().attempt_id,
            &[original.envelope().items[0].item_id],
        );
        let next = store
            .execution_retry_input(action.source_attempt_id, &action.item_ids)
            .unwrap();
        store
            .enqueue_continuation(&action, &next, RecoveryPolicy::ReadOnly)
            .unwrap();
        let result = produce(&mut store, &next, next.envelope().items[0].item_id);
        store.save_execution_result(&result).unwrap();
        store
            .validate_execution_result(next.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let page = store
            .execution_task_activity(12, &[original.envelope().attempt_id])
            .unwrap();
        assert_eq!(page.total.get(), 1);
        assert_eq!(page.active.get(), u64::from(!unknown));
        assert_eq!(page.attention.get(), u64::from(unknown));
        assert_eq!(page.saved.get(), 0);
        let task = &page.rows[0];
        assert_eq!(task.attempt_id, original.envelope().attempt_id);
        assert_eq!(task.progress.total, 3);
        assert_eq!(task.progress.succeeded, 1);
        assert_eq!(task.progress.queued, 0);
        assert_eq!(task.progress.unknown, if unknown { 2 } else { 0 });
        assert_eq!(task.progress.running, if unknown { 0 } else { 2 });
        let old = store
            .execution_attempt(original.envelope().attempt_id, true)
            .unwrap();
        assert_eq!(old.progress.unknown, if unknown { 2 } else { 0 });
        assert_eq!(old.progress.running, if unknown { 0 } else { 2 });
        let reopened = store.execution_task_activity(12, &[]).unwrap();
        assert_eq!(reopened.active.get(), 0);
        assert_eq!(reopened.attention.get(), 1);
        assert_eq!(reopened.rows[0].progress.unknown, 2);
    }
}
