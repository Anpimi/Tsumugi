use super::*;
use crate::persistence::review::tests::{adopt_source, fixture, translate};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::cell::RefCell;

fn query(text: &str, selection: SegmentSelectionFilter) -> SegmentQuery {
    SegmentQuery {
        text: text.into(),
        selection,
    }
}

thread_local! {
    static STATEMENTS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn traced(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, statement) = event {
        STATEMENTS.with(|statements| statements.borrow_mut().push(statement.to_owned()));
    }
}

fn measured_window(
    store: &ProjectStore,
    project: ExecutionId,
    scope: ExecutionId,
    limit: u32,
) -> Vec<String> {
    STATEMENTS.with(|statements| statements.borrow_mut().clear());
    store
        .connection()
        .unwrap()
        .trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(traced));
    store
        .read_segment_queue_window(project, "zh-CN", scope, None, limit)
        .unwrap();
    store
        .connection()
        .unwrap()
        .trace_v2(TraceEventCodes::empty(), None);
    STATEMENTS.with(|statements| std::mem::take(&mut *statements.borrow_mut()))
}

#[test]
fn segment_queue_windows_keep_two_thousand_equal_text_members_in_order_with_batched_reads() {
    let (_directory, mut store, project, _) = fixture();
    let source = (0..2000)
        .map(|index| (format!("entry-{index:04}"), "same 世界"))
        .collect::<BTreeMap<_, _>>();
    adopt_source(&mut store, &serde_json::to_vec(&source).unwrap());
    let query = query("same", SegmentSelectionFilter::All);
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    let narrow = measured_window(&store, project, page.scope_id, 1);
    let wide = measured_window(&store, project, page.scope_id, 100);
    assert_eq!(
        narrow.len(),
        wide.len(),
        "row count must not add SQL statements"
    );
    assert!(
        wide.len() <= 32,
        "unexpected per-row queries: {}",
        wide.len()
    );
    assert_eq!(
        wide.iter().filter(|sql| sql.starts_with("BEGIN")).count(),
        1
    );
    assert_eq!(
        wide.iter().filter(|sql| sql.starts_with("COMMIT")).count(),
        1
    );
    let changes = store.changes_since(Revision::new(0).unwrap());
    let total_changes = store.connection().unwrap().total_changes();
    let mut anchor = None;
    let mut ids = Vec::new();
    let mut keys = Vec::new();
    loop {
        let window = store
            .read_segment_queue_window(project, "zh-CN", page.scope_id, anchor, 100)
            .unwrap();
        assert_eq!(window.first_position as usize, ids.len());
        assert_eq!(window.total, 2000);
        assert_eq!(window.previous_unit_id, ids.last().copied());
        assert_eq!(window.query, query);
        assert_eq!(window.query_fingerprint, page.query_fingerprint);
        assert_eq!(window.source_snapshot_id, page.source_snapshot_id);
        assert_eq!(window.epoch, changes.epoch);
        assert_eq!(window.sequence, changes.sequence);
        assert!(
            serde_json::to_vec(&window).unwrap().len() <= crate::content::MAX_CONTENT_PAGE_BYTES
        );
        ids.extend(window.rows.iter().map(|row| row.content.unit_id));
        keys.extend(window.rows.iter().map(|row| row.content.native_key.clone()));
        anchor = window.next_unit_id;
        if anchor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 2000);
    assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), 2000);
    assert_eq!(keys, source.into_keys().collect::<Vec<_>>());
    assert_eq!(store.connection().unwrap().total_changes(), total_changes);
    assert_eq!(
        store.changes_since(Revision::new(0).unwrap()).sequence,
        changes.sequence
    );
}

#[test]
fn segment_queue_windows_read_current_facts_after_local_edits_without_refiltering_or_thawing_batches()
 {
    let (_directory, mut store, project, _) = fixture();
    adopt_source(
        &mut store,
        br#"{"a":"Hello {{name}}","b":"Hello {{name}}","c":"Hello {{name}}"}"#,
    );
    let all = store
        .review_summary_page(project, "zh-CN", 0, 100, "", None)
        .unwrap();
    translate(
        &mut store,
        project,
        all.rows[2].unit_id,
        "zh-CN",
        "Already selected",
    );
    let query = query("Hello", SegmentSelectionFilter::Unselected);
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    let first = page.rows[0].content.unit_id;
    let initial = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
        .unwrap();
    let second = initial.next_unit_id.unwrap();
    assert_eq!(initial.total, 2);
    let target = store.review_target(project, first, "zh-CN").unwrap();
    let saved = store
        .save_translation_edit(&crate::SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: first,
            locale: "zh-CN".into(),
            source_revision_id: target.source_revision_id,
            expected_selection_id: None,
            text: "Term {{name}}".into(),
        })
        .unwrap();
    let selected = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 100)
        .unwrap();
    assert_eq!(selected.total, 2);
    assert_eq!(
        selected
            .rows
            .iter()
            .map(|row| row.content.unit_id)
            .collect::<Vec<_>>(),
        [first, second]
    );
    assert_eq!(
        selected.rows[0].content.revision_id,
        Some(saved.selection.revision_id)
    );
    assert_eq!(
        selected.rows[0].content.translation_preview.as_deref(),
        Some("Term {{name}}")
    );
    assert!(selected.rows[0].protection.protected);
    assert!(selected.rows[0].content.current_decision.is_none());
    assert!(!selected.rows[0].qa.current);
    assert!(selected.sequence > page.sequence);
    store
        .save_term(&crate::SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Hello".into(),
            aliases: vec![],
            target: "Term".into(),
            protected: true,
            scope_unit_id: None,
            expected_revision_id: None,
            reason: "Current terminology".into(),
        })
        .unwrap();
    let changed = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
        .unwrap();
    assert_eq!(changed.rows[0].terms.revision_count, 1);
    assert!(changed.rows[0].applicability.resource_review_required);
    assert_eq!(
        changed.rows[0].applicability.captured_basis_current,
        Some(false)
    );
    let target = store.review_target(project, first, "zh-CN").unwrap();
    store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: first,
            locale: "zh-CN".into(),
            expected_basis: target.basis.clone(),
            expected_decision_id: None,
            actor: "Reviewer".into(),
            kind: ReviewDecisionKind::Approve,
            reason: String::new(),
        })
        .unwrap();
    store
        .run_review_checks(project, first, "zh-CN", &target.basis, ExecutionId::new())
        .unwrap();
    let current = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
        .unwrap();
    assert!(current.rows[0].qa.current);
    assert_eq!(
        current.rows[0]
            .content
            .current_decision
            .as_ref()
            .unwrap()
            .kind,
        ReviewDecisionKind::Approve
    );
    assert!(!current.rows[0].applicability.resource_review_required);
    assert_eq!(current.next_unit_id, Some(second));
    let next = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, Some(second), 100)
        .unwrap();
    assert_eq!(next.first_position, 1);
    assert_eq!(next.total, 2);
    assert_eq!(next.rows.len(), 1);
    assert_eq!(next.rows[0].content.unit_id, second);
    assert_eq!(next.previous_unit_id, Some(first));
    assert_eq!(next.next_unit_id, None);
    assert_eq!(
        store
            .read_segment_page(
                project,
                "zh-CN",
                &query,
                Some(page.scope_id),
                page.next_cursor,
                1
            )
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(
        store
            .capture_segment_scope(
                project,
                "zh-CN",
                page.scope_id,
                &page.query_fingerprint,
                &page.read_version,
                &[]
            )
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert!(
        store
            .review_scope_capture(project, "zh-CN", page.scope_id, &[])
            .is_err()
    );
    assert!(
        store
            .review_neighbor(project, "zh-CN", page.scope_id, first, 1)
            .is_err()
    );
    let refreshed = store
        .read_segment_page(project, "zh-CN", &query, None, None, 100)
        .unwrap();
    assert_eq!(refreshed.total, 1);
    assert_eq!(refreshed.rows[0].content.unit_id, second);
}

#[test]
fn segment_queue_windows_reject_untrusted_membership_and_invalid_requests() {
    let (directory, mut store, project, _) = fixture();
    let query = query("", SegmentSelectionFilter::All);
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    for limit in [0, 101] {
        assert_eq!(
            store
                .read_segment_queue_window(project, "zh-CN", page.scope_id, None, limit)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    assert_eq!(
        store
            .read_segment_queue_window(ExecutionId::new(), "zh-CN", page.scope_id, None, 1)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .read_segment_queue_window(project, "fr-FR", page.scope_id, None, 1)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        store
            .read_segment_queue_window(project, "de-DE", page.scope_id, None, 1)
            .is_err()
    );
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", ExecutionId::new(), None, 1)
            .is_err()
    );
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", page.scope_id, Some(ExecutionId::new()), 1)
            .is_err()
    );
    let legacy = store
        .review_summary_page(project, "zh-CN", 0, 1, "", None)
        .unwrap();
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", legacy.scope_id, None, 1)
            .is_err()
    );
    adopt_source(&mut store, br#"{"new":"New source"}"#);
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
            .is_err()
    );
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    let external = Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    external
        .execute(
            "UPDATE project_metadata SET display_name='External queue test' WHERE row_id=1",
            [],
        )
        .unwrap();
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
            .is_err()
    );
    drop(external);
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    for _ in 0..8 {
        store
            .read_segment_page(project, "zh-CN", &query, None, None, 1)
            .unwrap();
    }
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
            .is_err()
    );
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    // Even a matching source snapshot on reopen does not restore session-local authority.
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert!(
        reopened
            .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 1)
            .is_err()
    );
}

#[test]
fn segment_queue_windows_define_empty_results_without_inventing_an_anchor() {
    let (_directory, store, project, _) = fixture();
    let query = query("no matching source", SegmentSelectionFilter::All);
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 100)
        .unwrap();
    let window = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 100)
        .unwrap();
    assert!(window.rows.is_empty());
    assert_eq!((window.first_position, window.total), (0, 0));
    assert_eq!((window.previous_unit_id, window.next_unit_id), (None, None));
    assert!(
        store
            .read_segment_queue_window(project, "zh-CN", page.scope_id, Some(ExecutionId::new()), 1)
            .is_err()
    );
}

#[test]
fn segment_queue_windows_continue_at_first_unreturned_identity_after_unicode_byte_trimming() {
    let (_directory, mut store, project, _) = fixture();
    let text = "😀".repeat(257);
    let preview = "😀".repeat(256);
    let source = (0..100)
        .map(|index| {
            (
                format!("entry-{index:03}-{}", "k".repeat(244)),
                text.clone(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    adopt_source(&mut store, &serde_json::to_vec(&source).unwrap());
    let query = query("", SegmentSelectionFilter::All);
    let page = store
        .read_segment_page(project, "zh-CN", &query, None, None, 1)
        .unwrap();
    let all = store
        .review_summary_page(project, "zh-CN", 0, 100, "", None)
        .unwrap();
    for row in &all.rows {
        translate(&mut store, project, row.unit_id, "zh-CN", &text);
    }
    let first = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 100)
        .unwrap();
    assert!(first.rows.len() < 100, "fixture must hit the byte limit");
    assert_eq!(first.next_unit_id, Some(all.rows[first.rows.len()].unit_id));
    let second = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, first.next_unit_id, 100)
        .unwrap();
    assert_eq!(second.first_position as usize, first.rows.len());
    assert_eq!(
        second.previous_unit_id,
        first.rows.last().map(|row| row.content.unit_id)
    );
    assert_eq!(second.next_unit_id, None);
    for window in [&first, &second] {
        assert!(
            serde_json::to_vec(window).unwrap().len() <= crate::content::MAX_CONTENT_PAGE_BYTES
        );
        for row in &window.rows {
            assert_eq!(row.content.source_preview, preview);
            assert_eq!(
                row.content.translation_preview.as_deref(),
                Some(preview.as_str())
            );
            assert_eq!(row.content.source_preview.chars().count(), 256);
            assert!(row.source_truncated);
            assert!(row.translation_truncated);
        }
    }
    assert_eq!(
        first
            .rows
            .iter()
            .chain(&second.rows)
            .map(|row| row.content.unit_id)
            .collect::<Vec<_>>(),
        all.rows.iter().map(|row| row.unit_id).collect::<Vec<_>>()
    );
}
