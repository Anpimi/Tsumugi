use super::*;
use crate::content::{
    LineageChoice, LineageDecision, SourceAdoptionHandler, SourceBundle, SourceChangeKind,
    SourceRunner,
};
use crate::execution::{ExecutionRuntime, ExecutionState};
use crate::persistence::review::tests::{adopt_source, fixture, translate};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn all() -> SegmentQuery {
    SegmentQuery {
        text: String::new(),
        selection: SegmentSelectionFilter::All,
        status: SegmentStatusFilter::All,
    }
}

fn initial(bytes: &[u8]) -> (tempfile::TempDir, ProjectStore, ExecutionId) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        crate::ProjectMetadata::create("Source comparison", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    adopt_source(&mut store, bytes);
    (directory, store, project)
}

fn update(store: &mut ProjectStore, bytes: &[u8], decisions: &[(&str, &str, LineageDecision)]) {
    let previous = store.content_scope().unwrap().current_snapshot.unwrap();
    let mut old = store.source_content(previous, 0, 100).unwrap();
    while let Some(after) = old.next_ordinal {
        let page = store.source_content(previous, after, 100).unwrap();
        old.rows.extend(page.rows);
        old.next_ordinal = page.next_ordinal;
    }
    let bundle = SourceBundle::capture(
        br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#,
        bytes,
        "en",
    )
    .unwrap();
    let input = bundle
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = loop {
        runtime.tick(store).unwrap();
        if store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap()
            .items[0]
            .execution
            == ExecutionState::Succeeded
        {
            break store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
        }
        assert!(Instant::now() < deadline, "source fixture did not finish");
        std::thread::sleep(Duration::from_millis(2));
    };
    let comparison = store
        .source_comparison(input.envelope().attempt_id, result, 0, 100)
        .unwrap();
    let output = crate::content::validate_output(
        &input,
        &store
            .execution_result(input.envelope().attempt_id, result)
            .unwrap(),
    )
    .unwrap();
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Synthetic reviewer".into());
    for (new_key, old_key, decision) in decisions {
        let new = output
            .occurrences
            .iter()
            .find(|row| row.key == *new_key)
            .unwrap();
        let old = old
            .rows
            .iter()
            .find(|row| row.occurrence.key == *old_key)
            .unwrap();
        confirmation.lineage.push(LineageChoice {
            new_ordinal: new.ordinal,
            old_occurrence_id: old.occurrence_id.unwrap(),
            decision: decision.clone(),
            reason: "Verified persisted unit relationship".into(),
        });
    }
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
}

#[test]
fn segment_source_comparison_first_snapshot_preserves_empty_and_unicode_without_writes() {
    let text = "Keep {{name}} — é 👩🏽‍💻\r\n日本語";
    let (_directory, mut store, project) = initial(
        &serde_json::to_vec(&serde_json::json!({"empty":"", "one":text,"two":text})).unwrap(),
    );
    let page = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    let units = page
        .rows
        .iter()
        .map(|row| row.content.unit_id)
        .collect::<Vec<_>>();
    let writes = store.connection().unwrap().total_changes();
    let comparison = store
        .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units)
        .unwrap();
    assert_eq!(comparison.current_snapshot_id, page.source_snapshot_id);
    assert_eq!(comparison.base_snapshot_id, None);
    assert_eq!(comparison.next_after, None);
    assert_eq!(
        comparison
            .rows
            .iter()
            .map(|row| row.unit_id)
            .collect::<Vec<_>>(),
        units
    );
    assert!(
        comparison
            .rows
            .iter()
            .all(|row| row.old.is_none() && row.change_kind == SourceChangeKind::Added)
    );
    assert_eq!(comparison.rows[0].current.text, "");
    assert_eq!(comparison.rows[1].current.text, text);
    assert_eq!(comparison.rows[2].current.text, text);
    assert_ne!(comparison.rows[1].unit_id, comparison.rows[2].unit_id);
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    translate(&mut store, project, units[1], "zh-CN", "Human text");
    assert_eq!(
        store
            .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units)
            .unwrap(),
        comparison,
        "fixed membership source reads survive local translation changes"
    );
}

#[test]
fn segment_source_comparison_uses_adopted_units_and_immediate_previous_snapshot() {
    let old_text = "old é 👩🏽‍💻";
    let new_text = "new {{name}} 日本語";
    let (_directory, mut store, project) = initial(&serde_json::to_vec(&serde_json::json!({
        "change":old_text,"empty":"","keep":"same","remove":"gone","rename-old":"rename","replace":"old key"
    })).unwrap());
    let before = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    let old_ids = before
        .rows
        .iter()
        .map(|row| (row.content.native_key.clone(), row.content.unit_id))
        .collect::<BTreeMap<_, _>>();
    update(&mut store, &serde_json::to_vec(&serde_json::json!({
        "added":"same","change":new_text,"empty":"","keep":"same","rename-new":"rename","replace":"new key"
    })).unwrap(), &[("change","change",LineageDecision::Continue),("rename-new","rename-old",LineageDecision::Continue),
        ("replace","replace",LineageDecision::Reject)]);
    let page = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    let units = page
        .rows
        .iter()
        .map(|row| row.content.unit_id)
        .collect::<Vec<_>>();
    let comparison = store
        .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units)
        .unwrap();
    assert_eq!(comparison.base_snapshot_id, Some(before.source_snapshot_id));
    let by_key = page
        .rows
        .iter()
        .zip(&comparison.rows)
        .map(|(segment, row)| (segment.content.native_key.as_str(), row))
        .collect::<BTreeMap<_, _>>();
    let changed = by_key["change"];
    assert_eq!(changed.unit_id, old_ids["change"]);
    assert_eq!(changed.old.as_ref().unwrap().text, old_text);
    assert_eq!(changed.current.text, new_text);
    assert_eq!(changed.change_kind, SourceChangeKind::Changed);
    assert_ne!(
        changed.old.as_ref().unwrap().source_revision_id,
        changed.current.source_revision_id
    );
    assert_eq!(by_key["empty"].old.as_ref().unwrap().text, "");
    assert_eq!(by_key["empty"].current.text, "");
    assert_eq!(by_key["rename-new"].unit_id, old_ids["rename-old"]);
    assert_eq!(by_key["rename-new"].old.as_ref().unwrap().text, "rename");
    assert_eq!(by_key["rename-new"].change_kind, SourceChangeKind::Changed);
    assert!(by_key["added"].old.is_none(), "equal text is not identity");
    assert!(
        by_key["replace"].old.is_none(),
        "a rejected same-key candidate is a new unit"
    );
    assert_ne!(by_key["replace"].unit_id, old_ids["replace"]);
    assert!(!units.contains(&old_ids["remove"]));
    assert!(
        store
            .read_segment_source_comparison(project, "zh-CN", before.scope_id, &[old_ids["change"]])
            .is_err()
    );
    let second_snapshot = page.source_snapshot_id;
    update(&mut store, &serde_json::to_vec(&serde_json::json!({
        "added":"same","change":"third wording","empty":"","keep":"same","rename-new":"rename","replace":"new key"
    })).unwrap(), &[("change","change",LineageDecision::Continue)]);
    let third = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    let comparison = store
        .read_segment_source_comparison(project, "zh-CN", third.scope_id, &[old_ids["change"]])
        .unwrap();
    assert_eq!(comparison.base_snapshot_id, Some(second_snapshot));
    assert_eq!(comparison.rows[0].old.as_ref().unwrap().text, new_text);
}

#[test]
fn segment_source_comparison_rejects_foreign_members_limits_expired_scope_and_external_changes() {
    let (directory, store, project, units) = fixture();
    let page = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    for ids in [
        vec![],
        vec![units[0], units[0]],
        vec![ExecutionId::new()],
        (0..51).map(|_| ExecutionId::new()).collect(),
    ] {
        assert!(
            store
                .read_segment_source_comparison(project, "zh-CN", page.scope_id, &ids)
                .is_err()
        );
    }
    assert!(
        store
            .read_segment_source_comparison(ExecutionId::new(), "zh-CN", page.scope_id, &units)
            .is_err()
    );
    assert!(
        store
            .read_segment_source_comparison(project, "fr-FR", page.scope_id, &units)
            .is_err()
    );
    let filtered = store
        .read_segment_page(
            project,
            "zh-CN",
            &SegmentQuery {
                text: "Hello".into(),
                ..all()
            },
            None,
            None,
            1,
        )
        .unwrap();
    assert!(
        store
            .read_segment_source_comparison(project, "zh-CN", filtered.scope_id, &[units[1]])
            .is_err()
    );
    for _ in 0..8 {
        store
            .read_segment_page(project, "zh-CN", &all(), None, None, 1)
            .unwrap();
    }
    assert!(
        store
            .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units)
            .is_err()
    );
    let page = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    let external =
        rusqlite::Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
    external
        .execute(
            "UPDATE project_metadata SET display_name='External change' WHERE row_id=1",
            [],
        )
        .unwrap();
    assert!(
        store
            .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units)
            .is_err()
    );
}

#[test]
fn segment_source_comparison_pages_complete_unicode_rows_with_constant_batch_query_count() {
    let old_text = format!("{}é👩🏽‍💻", "o".repeat(2530));
    let new_text = format!("{}日本語", "n".repeat(2530));
    let old = (0..50)
        .map(|index| (format!("key-{index:03}"), old_text.clone()))
        .collect::<BTreeMap<_, _>>();
    let new = (0..50)
        .map(|index| (format!("key-{index:03}"), new_text.clone()))
        .collect::<BTreeMap<_, _>>();
    let (_directory, mut store, project) = initial(&serde_json::to_vec(&old).unwrap());
    let decisions = old
        .keys()
        .map(|key| (key.as_str(), key.as_str(), LineageDecision::Continue))
        .collect::<Vec<_>>();
    update(&mut store, &serde_json::to_vec(&new).unwrap(), &decisions);
    let page = store
        .read_segment_page(project, "zh-CN", &all(), None, None, 50)
        .unwrap();
    let scope = store
        .read_segment_queue_window(project, "zh-CN", page.scope_id, None, 100)
        .unwrap();
    let mut units = scope
        .rows
        .iter()
        .map(|row| row.content.unit_id)
        .collect::<Vec<_>>();
    // Row summary byte limits may be tighter than source endpoint limits.
    if let Some(next) = scope.next_unit_id {
        units.extend(
            store
                .read_segment_queue_window(project, "zh-CN", page.scope_id, Some(next), 100)
                .unwrap()
                .rows
                .iter()
                .map(|row| row.content.unit_id),
        );
    }
    assert_eq!(units.len(), 50);
    let comparison = store
        .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units)
        .unwrap();
    assert!(comparison.next_after.is_some());
    assert!(
        serde_json::to_vec(&comparison).unwrap().len() <= crate::content::MAX_CONTENT_PAGE_BYTES
    );
    let rest = store
        .read_segment_source_comparison(
            project,
            "zh-CN",
            page.scope_id,
            &units[comparison.next_after.unwrap() as usize..],
        )
        .unwrap();
    assert_eq!(rest.next_after, None);
    let combined = comparison.rows.iter().chain(&rest.rows).collect::<Vec<_>>();
    assert_eq!(
        combined.iter().map(|row| row.unit_id).collect::<Vec<_>>(),
        units
    );
    assert!(
        combined
            .iter()
            .all(|row| row.old.as_ref().unwrap().text == old_text && row.current.text == new_text)
    );
    let mut counts = Vec::new();
    for length in [1, 50] {
        STATEMENTS.with(|statements| statements.borrow_mut().clear());
        store.connection().unwrap().trace_v2(
            rusqlite::trace::TraceEventCodes::SQLITE_TRACE_STMT,
            Some(traced),
        );
        store
            .read_segment_source_comparison(project, "zh-CN", page.scope_id, &units[..length])
            .unwrap();
        store
            .connection()
            .unwrap()
            .trace_v2(rusqlite::trace::TraceEventCodes::empty(), None);
        counts.push(STATEMENTS.with(|statements| statements.borrow().len()));
    }
    assert_eq!(
        counts[0], counts[1],
        "source reads cannot add per-unit SQL queries"
    );
}

thread_local! {
    static STATEMENTS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}
fn traced(event: rusqlite::trace::TraceEvent<'_>) {
    if let rusqlite::trace::TraceEvent::Stmt(_, statement) = event {
        STATEMENTS.with(|statements| statements.borrow_mut().push(statement.to_owned()));
    }
}
