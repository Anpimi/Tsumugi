use super::tests::{adopt_source, fixture, translate};
use super::*;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};

thread_local! {
    static SQL: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}
fn traced(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(_, sql) = event {
        SQL.with(|statements| statements.borrow_mut().push(sql.to_owned()));
    }
}
fn measure<T>(store: &ProjectStore, read: impl FnOnce() -> T) -> (T, Vec<String>, Duration) {
    SQL.with(|statements| statements.borrow_mut().clear());
    store
        .connection()
        .unwrap()
        .trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(traced));
    let start = Instant::now();
    let value = read();
    let elapsed = start.elapsed();
    store
        .connection()
        .unwrap()
        .trace_v2(TraceEventCodes::empty(), None);
    let statements = SQL.with(|statements| std::mem::take(&mut *statements.borrow_mut()));
    (value, statements, elapsed)
}
fn large_fixture(count: usize) -> (tempfile::TempDir, ProjectStore, ExecutionId) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        crate::ProjectMetadata::create("Queries", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    let project = parse_id(store.metadata().unwrap().project_id().to_string()).unwrap();
    let source = (0..count)
        .map(|index| {
            (
                format!("entry-{index:04}"),
                format!(
                    "Source {index} 世界 日本語 e\u{301} literal % _ {}",
                    "x".repeat(400)
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    adopt_source(&mut store, &serde_json::to_vec(&source).unwrap());
    (directory, store, project)
}

#[test]
fn ai_and_arena_previews_share_one_checked_read_with_independent_resource_policies() {
    use crate::ai::{AiConfig, arena::ArenaConfig};

    let (directory, mut store, project) = large_fixture(120);
    let rows = store
        .source_content(
            store.content_scope().unwrap().current_snapshot.unwrap(),
            0,
            100,
        )
        .unwrap()
        .rows;
    let units = rows
        .iter()
        .map(|row| row.unit_id.unwrap())
        .collect::<Vec<_>>();
    let term = store
        .save_term(&crate::SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Source".into(),
            aliases: vec![],
            target: "来源".into(),
            protected: false,
            scope_unit_id: None,
            expected_revision_id: None,
            reason: "Synthetic shared term".into(),
        })
        .unwrap();
    let context = store
        .save_context(&crate::SaveContext {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: units[0],
            locale: "zh-CN".into(),
            source_revision_id: rows[0].source_revision_id.unwrap(),
            expected_revision_id: None,
            text: "Synthetic human note".into(),
            reason: "Synthetic context".into(),
        })
        .unwrap();
    let config = AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        max_items: 100,
        max_requests: 100,
        ..Default::default()
    };
    let (plain, statements, _) = measure(&store, || {
        store.preview_ai(config.clone(), "zh-CN", &units).unwrap()
    });
    let assert_one_read = |statements: &[String]| {
        assert_eq!(
            statements
                .iter()
                .filter(|sql| sql.starts_with("SELECT project_id,set_id,attempt_id,result_id,source_language,identity_policy FROM source_snapshots WHERE snapshot_id="))
                .count(),
            1
        );
        assert_eq!(
            statements
                .iter()
                .filter(|sql| sql.starts_with("BEGIN"))
                .count(),
            1
        );
        assert_eq!(
            statements
                .iter()
                .filter(|sql| sql.starts_with("COMMIT"))
                .count(),
            1
        );
        assert!(statements.iter().all(|sql| {
            !["INSERT", "UPDATE", "DELETE", "REPLACE"]
                .iter()
                .any(|verb| sql.starts_with(verb))
        }));
    };
    assert_one_read(&statements);
    assert!(
        !statements
            .iter()
            .any(|sql| sql.contains("FROM term_current") || sql.contains("FROM context_current"))
    );
    assert_eq!(plain.items.len(), 100);
    for (item, row) in plain.items.iter().zip(&rows) {
        assert_eq!(item.unit_id, row.unit_id.unwrap());
        assert_eq!(item.source_text, row.occurrence.text);
        assert_eq!(item.source_revision_id, row.source_revision_id.unwrap());
        assert!(item.terms.is_empty() && item.context.is_none());
    }
    let mut terms = config.clone();
    terms.share_terms = true;
    let mut manual = config;
    manual.share_context = true;
    let arena_config = ArenaConfig {
        variants: vec![terms, manual],
        max_items: 50,
        max_requests: 100,
        concurrency: 1,
        blind: true,
        parent_attempt_id: None,
    };
    let (arena, statements, _) = measure(&store, || {
        store
            .preview_arena(arena_config, "zh-CN", &units[..50])
            .unwrap()
    });
    assert_one_read(&statements);
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.contains("FROM term_current c JOIN term_revisions r"))
            .count(),
        1
    );
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.contains("FROM context_current c JOIN context_revisions r"))
            .count(),
        50
    );
    assert_eq!(arena.items.len(), 100);
    for pair in arena.items.chunks_exact(2) {
        assert_eq!(pair[0].item.unit_id, pair[1].item.unit_id);
        assert_eq!(
            pair[0].item.source_revision_id,
            pair[1].item.source_revision_id
        );
        assert_eq!(
            pair[0].item.resource_baseline,
            pair[1].item.resource_baseline
        );
        assert_eq!(pair[0].item.terms[0].revision_id, term.revision_id);
        assert!(pair[0].item.context.is_none());
        assert!(pair[1].item.terms.is_empty());
        assert_eq!(pair[0].item.omissions, ["context-not-shared"]);
        if pair[1].item.unit_id == units[0] {
            assert_eq!(pair[1].item.context.as_ref(), Some(&context));
            assert_eq!(pair[1].item.omissions, ["terms-not-shared"]);
        } else {
            assert!(pair[1].item.context.is_none());
            assert_eq!(
                pair[1].item.omissions,
                ["context-missing", "terms-not-shared"]
            );
        }
    }
    store.close().unwrap();
    let mut reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .preview_arena(arena.config.clone(), "zh-CN", &units[..50])
            .unwrap()
            .items,
        arena.items
    );
    for source in ["世界", "日本語"] {
        reopened
            .save_term(&crate::SaveTerm {
                project_id: project,
                action_id: ExecutionId::new(),
                term_id: None,
                locale: "zh-CN".into(),
                source: source.into(),
                aliases: vec![],
                target: "x".repeat(16 * 1024),
                protected: false,
                scope_unit_id: None,
                expected_revision_id: None,
                reason: "Synthetic prompt budget boundary".into(),
            })
            .unwrap();
    }
    let mut oversized = arena.config.variants[0].clone();
    oversized.share_context = true;
    let (failure, statements, _) = measure(&reopened, || {
        reopened.preview_ai(oversized, "zh-CN", &units).unwrap_err()
    });
    assert_eq!(failure.code, ErrorCode::LimitExceeded);
    // Two complete 16 KiB terms already consume the 32 KiB prompt allowance.
    // Refuse the first real item before reading the other 99 manual contexts.
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.contains("FROM context_current c JOIN context_revisions r"))
            .count(),
        1
    );
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.starts_with("ROLLBACK"))
            .count(),
        1
    );
    assert!(reopened.preview_ai(plain.config, "zh-CN", &units).is_ok());
}

#[test]
fn ai_previews_keep_missing_source_and_locale_recovery_stages() {
    use crate::ai::{AiConfig, arena::ArenaConfig};
    let directory = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        directory.path().join("project"),
        crate::ProjectMetadata::create("Empty preview", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let config = AiConfig {
        endpoint: "http://127.0.0.1:65534/v1/chat/completions".into(),
        model: "synthetic".into(),
        credential_env: String::new(),
        ..Default::default()
    };
    let arena = ArenaConfig {
        variants: vec![config.clone(), config.clone()],
        max_items: 20,
        max_requests: 40,
        concurrency: 1,
        blind: true,
        parent_attempt_id: None,
    };
    for (locale, stage) in [
        ("zh-CN", "ai-source"),
        ("ja", "ai-locale"),
        ("zh-cn", "ai-locale"),
    ] {
        let units = [ExecutionId::new()];
        for failure in [
            store
                .preview_ai(config.clone(), locale, &units)
                .unwrap_err(),
            store
                .preview_arena(arena.clone(), locale, &units)
                .unwrap_err(),
        ] {
            assert_eq!(failure.code, ErrorCode::DependencyConflict);
            assert_eq!(failure.stage, stage);
        }
    }
}

#[test]
fn summary_pages_batch_current_evidence_and_bound_payloads() {
    let (_directory, mut store, project) = large_fixture(120);
    let first = store
        .review_page(project, "zh-CN", 0, 1)
        .unwrap()
        .rows
        .remove(0);
    translate(
        &mut store,
        project,
        first.unit_id,
        "zh-CN",
        "世界 日本語 % _",
    );
    let target = store
        .review_target(project, first.unit_id, "zh-CN")
        .unwrap();
    store
        .write_review(&ReviewWrite {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: first.unit_id,
            locale: "zh-CN".into(),
            expected_basis: target.basis.clone(),
            expected_decision_id: None,
            actor: "Tester".into(),
            kind: ReviewDecisionKind::Approve,
            reason: String::new(),
        })
        .unwrap();
    store
        .run_review_checks(
            project,
            first.unit_id,
            "zh-CN",
            &target.basis,
            ExecutionId::new(),
        )
        .unwrap();
    let mut counts = Vec::new();
    for limit in [50, 100] {
        let (summary, statements, elapsed) = measure(&store, || {
            store
                .review_summary_page(project, "zh-CN", 0, limit, "", None)
                .unwrap()
        });
        let expected = summary
            .rows
            .iter()
            .map(|row| {
                ReviewSummary::from(
                    target_in(store.connection().unwrap(), project, row.unit_id, "zh-CN").unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(summary.rows, expected);
        assert!(
            summary
                .rows
                .iter()
                .all(|row| row.source_preview.chars().count() <= 256)
        );
        let payload = serde_json::to_vec(&summary).unwrap();
        let sql_bytes: usize = statements.iter().map(String::len).sum();
        println!(
            "summary limit={limit} statements={} sql_bytes={sql_bytes} payload_bytes={} elapsed_us={}",
            statements.len(),
            payload.len(),
            elapsed.as_micros()
        );
        assert!(
            statements.len() < 20,
            "per-unit reads returned: {}",
            statements.len()
        );
        assert!(payload.len() < limit as usize * 1600);
        assert!(
            !String::from_utf8(payload)
                .unwrap()
                .contains("basisEvidence")
        );
        counts.push(statements.len());
        if limit == 50 {
            for (index, query) in statements.iter().enumerate().filter(|(_, query)| {
                query.contains("ROW_NUMBER()") || query.contains("FROM json_each(?2)")
            }) {
                let mut plan = store
                    .connection()
                    .unwrap()
                    .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
                    .unwrap();
                let arguments = (0..plan.parameter_count()).map(|_| None::<String>);
                let details = plan
                    .query_map(rusqlite::params_from_iter(arguments), |row| {
                        row.get::<_, String>(3)
                    })
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap();
                println!("query_plan statement={index} {details:?}");
            }
        }
    }
    assert_eq!(counts[0], counts[1], "query count must not grow per row");
    let (legacy, statements, elapsed) = measure(&store, || {
        let connection = store.connection().unwrap();
        let units = all_units(connection, project).unwrap().1;
        units
            .into_iter()
            .take(50)
            .map(|unit| target_in(connection, project, unit, "zh-CN").unwrap())
            .collect::<Vec<_>>()
    });
    println!(
        "original 50 statements={} payload_bytes={} elapsed_us={}",
        statements.len(),
        serde_json::to_vec(&legacy).unwrap().len(),
        elapsed.as_micros()
    );
    assert!(statements.len() > counts[0] * 10);
}

#[test]
fn short_unicode_and_literal_wildcard_search_matches_existing_semantics() {
    let (_directory, store, project) = large_fixture(120);
    for query in [
        "世",
        "世界",
        "日本",
        "日本語",
        "ENTRY-0119",
        "e\u{301}",
        "é",
        "%",
        "_",
    ] {
        let expected = store
            .review_page_filtered(project, "zh-CN", 0, 100, query)
            .unwrap();
        let actual = store
            .review_summary_page(project, "zh-CN", 0, 100, query, None)
            .unwrap();
        assert_eq!(actual.total, expected.total, "{query}");
        assert_eq!(
            actual
                .rows
                .iter()
                .map(|row| row.unit_id)
                .collect::<Vec<_>>(),
            expected
                .rows
                .iter()
                .map(|row| row.unit_id)
                .collect::<Vec<_>>(),
            "{query}"
        );
    }
    assert_eq!(
        store
            .review_summary_page(project, "zh-CN", 0, 1, "é", None)
            .unwrap()
            .total,
        0
    );
    assert!(
        store
            .review_summary_page(project, "zh-CN", 0, 1, &"界".repeat(86), None)
            .is_err()
    );
}

#[test]
fn fixed_membership_survives_saves_and_crosses_page_boundaries() {
    let (_directory, mut store, project) = large_fixture(120);
    let first = store
        .review_summary_page(project, "zh-CN", 0, 50, "", None)
        .unwrap();
    let last = &first.rows[49];
    translate(&mut store, project, last.unit_id, "zh-CN", "Saved fiftieth");
    let next = store
        .review_neighbor(project, "zh-CN", first.scope_id, last.unit_id, 1)
        .unwrap();
    let second = store
        .review_summary_page(
            project,
            "zh-CN",
            next.after_ordinal.unwrap(),
            50,
            "",
            Some(first.scope_id),
        )
        .unwrap();
    assert_eq!(second.rows[0].unit_id, next.unit_id.unwrap());
    assert_eq!(second.rows[0].native_key, "entry-0050");
    let snapshot = store
        .review_editor_snapshot(project, last.unit_id, "zh-CN")
        .unwrap();
    assert_eq!(
        snapshot.target.translation_text.as_deref(),
        Some("Saved fiftieth")
    );
    assert_eq!(
        snapshot.translations.current_text,
        snapshot.target.translation_text
    );
    assert_eq!(
        snapshot.terms.source_revision_id,
        snapshot.target.source_revision_id
    );
    let capture = store
        .review_scope_capture(project, "zh-CN", first.scope_id, &[last.unit_id])
        .unwrap();
    assert_eq!(capture.units.len(), 119);
    assert!(
        !capture
            .units
            .iter()
            .any(|unit| unit.unit_id == last.unit_id)
    );
    let end = store
        .review_neighbor(
            project,
            "zh-CN",
            first.scope_id,
            capture.units.last().unwrap().unit_id,
            1,
        )
        .unwrap();
    assert!(end.unit_id.is_none());
    assert!(end.after_ordinal.is_none());
    assert!(
        store
            .review_summary_page(project, "zh-CN", 0, 50, "different", Some(first.scope_id))
            .is_err()
    );
    assert_eq!(
        store
            .review_scope_capture(project, "zh-CN", first.scope_id, &[])
            .unwrap()
            .units
            .len(),
        120
    );
    adopt_source(&mut store, br#"{"new":"Changed source"}"#);
    assert_eq!(
        store
            .review_neighbor(project, "zh-CN", first.scope_id, last.unit_id, 1)
            .unwrap_err()
            .stage,
        "review-scope-source-changed"
    );
}

#[test]
fn filtered_membership_does_not_expand_or_disappear_after_translation_edits() {
    let (_directory, mut store, project, units) = fixture();
    translate(&mut store, project, units[0], "zh-CN", "needle");
    let filtered = store
        .review_summary_page(project, "zh-CN", 0, 50, "needle", None)
        .unwrap();
    assert_eq!(filtered.total, 1);
    translate(&mut store, project, units[0], "zh-CN", "no longer matches");
    translate(&mut store, project, units[1], "zh-CN", "new needle");
    let retained = store
        .review_summary_page(project, "zh-CN", 0, 50, "needle", Some(filtered.scope_id))
        .unwrap();
    assert_eq!(retained.rows[0].unit_id, units[0]);
    assert_eq!(retained.total, 1);
    let fresh = store
        .review_summary_page(project, "zh-CN", 0, 50, "needle", None)
        .unwrap();
    assert_eq!(fresh.rows[0].unit_id, units[1]);
    assert!(
        store
            .review_scope_capture(project, "zh-CN", filtered.scope_id, &[units[1]])
            .is_err()
    );
    assert!(
        store
            .review_scope_capture(project, "fr-FR", filtered.scope_id, &[])
            .is_err()
    );
}

#[test]
fn source_impact_reads_one_work_set_for_two_thousand_units() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        crate::ProjectMetadata::create("Impact queries", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let source = (1..=2000)
        .map(|index| {
            (
                format!("entry{index:04}"),
                format!("Synthetic source text {index}"),
            )
        })
        .collect::<BTreeMap<_, _>>();
    adopt_source(&mut store, &serde_json::to_vec(&source).unwrap());
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    for round in ["first", "repeat"] {
        let (impact, statements, elapsed) = measure(&store, || {
            store.source_impact(snapshot, "zh-CN", 0, 50).unwrap()
        });
        assert_eq!(impact.summary.total, 2000);
        assert_eq!(impact.summary.unresolved, 2000);
        assert_eq!(impact.rows.len(), 50);
        assert_eq!(impact.summary.preserved, 0);
        assert_eq!(impact.summary.reassess, 0);
        assert!(
            statements.len() < 500,
            "whole-scope/page reads multiplied: {}",
            statements.len()
        );
        println!(
            "source_impact data=2000 page=50 round={round} statements={} payload_bytes={} elapsed_us={}",
            statements.len(),
            serde_json::to_vec(&impact).unwrap().len(),
            elapsed.as_micros()
        );
    }
}

#[test]
fn maintenance_reads_only_window_targets_while_preserving_original_impact_reasons() {
    let (_directory, mut store, project) = large_fixture(120);
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let first = store.source_content(snapshot, 0, 1).unwrap().rows.remove(0);
    let saved = store
        .save_translation_edit(&crate::SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: first.unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: first.source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "Synthetic translation".into(),
        })
        .unwrap();
    store
        .save_term(&crate::SaveTerm {
            project_id: project,
            action_id: ExecutionId::new(),
            term_id: None,
            locale: "zh-CN".into(),
            source: "Source".into(),
            aliases: vec![],
            target: "Terminology".into(),
            protected: false,
            scope_unit_id: None,
            expected_revision_id: None,
            reason: "Synthetic literal impact".into(),
        })
        .unwrap();
    let protection = store
        .work_protection(first.unit_id.unwrap(), "zh-CN")
        .unwrap();
    store
        .set_work_protection(&crate::application::SetWorkProtection {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: first.unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: first.source_revision_id.unwrap(),
            selection_id: Some(saved.selection.event_id),
            expected_revision: protection.revision,
            protected: true,
            confirmed_release: false,
        })
        .unwrap();
    let original = store.source_impact(snapshot, "zh-CN", 0, 100).unwrap();
    let (assessment, statements, _) = measure(&store, || {
        store
            .maintenance_assessment(project, snapshot, "zh-CN", 0, 100)
            .unwrap()
    });
    assert_eq!(assessment.rows.len(), 100);
    assert_eq!(assessment.next_ordinal, Some(100));
    assert!(assessment.rows[0].protection.protected);
    assert!(
        assessment.rows[0]
            .reasons
            .iter()
            .any(|r| r.starts_with("resource-change:"))
    );
    for row in &assessment.rows {
        let old = original
            .rows
            .iter()
            .find(|r| r.current.unit_id == Some(row.unit_id))
            .unwrap();
        assert_eq!(row.reasons, old.reasons);
        assert_eq!(row.review_basis, old.review_basis);
    }
    assert!(
        !statements
            .iter()
            .any(|sql| sql.contains("GROUP BY o.unit_id ORDER BY MIN(o.ordinal) LIMIT 10001")),
        "maintenance must not build the complete project unit set"
    );
    let selection = statements
        .iter()
        .find(|sql| sql.contains("COALESCE(b.last_change_rowid,0)"))
        .unwrap();
    assert!(
        selection.contains("o.unit_id IN (SELECT value FROM json_each(?3))"),
        "resource selection must use the same wanted window"
    );
}

#[test]
fn multi_statement_reads_hold_a_snapshot_until_the_external_writer_can_commit() {
    let (_directory, mut store, project, units) = fixture();
    translate(&mut store, project, units[0], "zh-CN", "Before");
    let before = store.review_target(project, units[0], "zh-CN").unwrap();
    let database = store.directory().join(super::super::DATABASE_FILENAME);
    let revision = before.revision_id.unwrap().to_string();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (committed_tx, committed_rx) = std::sync::mpsc::channel();
    let mut writer_handle = None;
    queries::read_snapshot(store.connection().unwrap(), |connection| {
        let initial = target_in(connection, project, units[0], "zh-CN")?;
        writer_handle = Some(std::thread::spawn(move || {
            let mut external = Connection::open(database).unwrap();
            external.busy_timeout(Duration::from_secs(5)).unwrap();
            let transaction = external.transaction().unwrap();
            transaction
                .execute(
                    "UPDATE translation_revisions SET text='After' WHERE revision_id=?1",
                    [revision],
                )
                .unwrap();
            started_tx.send(()).unwrap();
            transaction.commit().unwrap();
            committed_tx.send(()).unwrap();
        }));
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            committed_rx
                .recv_timeout(Duration::from_millis(50))
                .is_err()
        );
        let later = queries::targets_in(connection, project, &[units[0]], "zh-CN")?.remove(0);
        assert_eq!(later, initial);
        Ok(())
    })
    .unwrap();
    committed_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    writer_handle.unwrap().join().unwrap();
    assert_eq!(
        store
            .review_target(project, units[0], "zh-CN")
            .unwrap()
            .translation_text
            .as_deref(),
        Some("After")
    );
}
