use super::*;
use serde_json::json;
use std::path::Path;

fn report_read<T: Serialize>(
    store: &ProjectStore,
    phase: &str,
    round: usize,
    operation: &str,
    read: impl FnOnce() -> T,
) -> T {
    let (value, statements, elapsed) = measure(store, read);
    println!(
        "{}",
        json!({"phase": phase, "round": round, "operation": operation,
        "elapsed_us": elapsed.as_micros(), "sql_statements": statements.len(),
        "sqlite_profile_us": SQL_TIME.with(|total| total.borrow().as_micros()),
        "payload_bytes": serde_json::to_vec(&value).unwrap().len()})
    );
    if std::env::var_os("TSUMUGI_PERFORMANCE_QUERY_PLAN").is_some() && round == 0 {
        for query in statements
            .iter()
            .filter(|query| query.contains("MIN(o.ordinal) OVER") || query.contains("JOIN wanted ON wanted.unit_id=o.unit_id GROUP BY"))
            .collect::<BTreeSet<_>>()
        {
            let mut plan = store
                .connection()
                .unwrap()
                .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
                .unwrap();
            let parameters = (0..plan.parameter_count()).map(|_| None::<String>);
            let details = plan
                .query_map(rusqlite::params_from_iter(parameters), |row| {
                    row.get::<_, String>(3)
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            println!(
                "{}",
                json!({"phase": phase, "operation": "query_plan", "read": operation, "details": details})
            );
        }
    }
    value
}

fn counts(store: &ProjectStore, phase: &str) {
    let mut counts = serde_json::Map::new();
    for table in [
        "source_snapshots",
        "source_occurrences",
        "translation_revisions",
        "translation_selections",
        "review_checks",
        "review_decisions",
    ] {
        let count: i64 = store
            .connection()
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        counts.insert(table.into(), json!(count));
    }
    println!(
        "{}",
        json!({"phase": phase, "operation": "stored_history", "counts": counts,
        "database_bytes": std::fs::metadata(store.directory().join("project.sqlite3")).unwrap().len()})
    );
}

fn reopen(path: &Path, phase: &str) -> ProjectStore {
    for round in 0..3 {
        let started = Instant::now();
        let store = ProjectStore::open(path).unwrap();
        println!(
            "{}",
            json!({"phase": phase, "round": round, "operation": "open",
            "elapsed_us": started.elapsed().as_micros(), "os_cache": "not-cleared"})
        );
        if round == 2 {
            return store;
        }
    }
    unreachable!()
}

fn sequence(
    store: &mut ProjectStore,
    project: ExecutionId,
    phase: &str,
    selected: usize,
    save: bool,
) {
    let query = SegmentQuery {
        text: String::new(),
        selection: SegmentSelectionFilter::All,
        status: SegmentStatusFilter::All,
    };
    for round in 0..3 {
        let first = report_read(store, phase, round, "first_page", || {
            store
                .read_segment_page(project, "zh-CN", &query, None, None, 50)
                .unwrap()
        });
        assert_eq!(first.total, 2000);
        assert_eq!(first.rows.len(), 50);
        let second = report_read(store, phase, round, "next_page", || {
            store
                .read_segment_page(
                    project,
                    "zh-CN",
                    &query,
                    Some(first.scope_id),
                    first.next_cursor,
                    50,
                )
                .unwrap()
        });
        assert_eq!(second.rows[0].content.native_key, "entry-0050");
        let found = report_read(store, phase, round, "search", || {
            store
                .read_segment_page(
                    project,
                    "zh-CN",
                    &SegmentQuery {
                        text: "needle".into(),
                        ..query.clone()
                    },
                    None,
                    None,
                    50,
                )
                .unwrap()
        });
        assert_eq!(found.total, 20);
        let untranslated = report_read(store, phase, round, "untranslated_filter", || {
            store
                .read_segment_page(
                    project,
                    "zh-CN",
                    &SegmentQuery {
                        status: SegmentStatusFilter::Untranslated,
                        ..query.clone()
                    },
                    None,
                    None,
                    50,
                )
                .unwrap()
        });
        assert_eq!(untranslated.total as usize, 2000 - selected);
        for (operation, status) in [
            ("needs_review_filter", SegmentStatusFilter::NeedsReview),
            ("issues_filter", SegmentStatusFilter::Issues),
            ("blocking_filter", SegmentStatusFilter::Blocking),
        ] {
            let page = report_read(store, phase, round, operation, || {
                store
                    .read_segment_page(
                        project,
                        "zh-CN",
                        &SegmentQuery {
                            status,
                            ..query.clone()
                        },
                        None,
                        None,
                        50,
                    )
                    .unwrap()
            });
            assert!(page.total <= 2000);
            if status == SegmentStatusFilter::NeedsReview {
                assert!(page.total as usize <= selected);
                assert!(page.rows.iter().all(|row| {
                    row.content.selection_id.is_some()
                        && !matches!(
                            row.content
                                .current_decision
                                .as_ref()
                                .map(|decision| decision.kind),
                            Some(ReviewDecisionKind::Approve)
                        )
                }));
            }
            if status == SegmentStatusFilter::Blocking {
                assert!(
                    page.rows
                        .iter()
                        .all(|row| row.qualification.blocker_count > 0)
                );
            }
        }
        let unit = first.rows[0].content.unit_id;
        let editor = report_read(store, phase, round, "editor_snapshot", || {
            store
                .review_editor_snapshot(project, unit, "zh-CN")
                .unwrap()
        });
        assert_eq!(editor.target.unit_id, unit);
        if !save {
            continue;
        }
        let text = format!("人工译文 {phase} {round} {{{{name}}}} 世界 e\u{301}");
        let request = crate::SaveTranslationRevision {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            source_revision_id: editor.target.source_revision_id,
            expected_selection_id: editor.target.selection_id,
            text: text.clone(),
            reuse_origin: None,
        };
        let started = Instant::now();
        store.save_translation_revision(&request).unwrap();
        println!(
            "{}",
            json!({"phase": phase, "round": round, "operation": "manual_save",
            "elapsed_us": started.elapsed().as_micros(), "text_bytes": text.len()})
        );
        let refreshed = report_read(store, phase, round, "saved_list_refresh", || {
            store
                .read_segment_page(project, "zh-CN", &query, None, None, 50)
                .unwrap()
        });
        assert_eq!(
            refreshed.rows[0].content.translation_preview.as_deref(),
            Some(text.as_str())
        );
    }
}

fn append_history(
    store: &mut ProjectStore,
    project: ExecutionId,
    units: &[ExecutionId],
    phase: &str,
    rounds: usize,
) {
    let started = Instant::now();
    for round in 0..rounds {
        for (index, unit) in units.iter().enumerate() {
            translate(
                store,
                project,
                *unit,
                "zh-CN",
                &format!("译文 {phase} {round} {index} {{{{name}}}}"),
            );
            if index % 10 == 0 {
                let target = store.review_target(project, *unit, "zh-CN").unwrap();
                store
                    .run_review_checks(project, *unit, "zh-CN", &target.basis, ExecutionId::new())
                    .unwrap();
                store
                    .write_review(&ReviewWrite {
                        project_id: project,
                        action_id: ExecutionId::new(),
                        unit_id: *unit,
                        locale: "zh-CN".into(),
                        expected_basis: target.basis,
                        expected_decision_id: target
                            .current_decision
                            .map(|decision| decision.decision_id),
                        actor: "Synthetic reviewer".into(),
                        kind: ReviewDecisionKind::Approve,
                        reason: String::new(),
                    })
                    .unwrap();
            }
        }
    }
    println!(
        "{}",
        json!({"phase": phase, "operation": "prepare_history", "rounds": rounds,
        "selected_units": units.len(), "elapsed_us": started.elapsed().as_micros()})
    );
}

/// Run explicitly with --ignored --nocapture. An optional output directory
/// retains the ordinary project and input files for native follow-up checks.
#[test]
#[ignore = "explicit local capacity and history measurements"]
fn measure_supported_source_and_history() {
    let output = std::env::var_os("TSUMUGI_PERFORMANCE_OUTPUT");
    let directory = match &output {
        Some(output) => tempfile::tempdir_in(output).unwrap(),
        None => tempfile::tempdir().unwrap(),
    };
    let path = directory.path().join("project");
    println!(
        "{}",
        json!({"operation": "fixture", "directory": directory.path(),
        "supported_occurrences": crate::content::MAX_OCCURRENCES, "source_capture_limit": crate::content::MAX_SOURCE_BYTES})
    );
    let values = (0..2000)
        .map(|index| {
            let text = format!(
                "Source {index} 世界 {{{{name}}}}{}{}",
                if index % 100 == 0 { " needle" } else { "" },
                if index % 250 == 0 {
                    format!(" {} e\u{301}", "long ".repeat(200))
                } else {
                    String::new()
                }
            );
            (format!("entry-{index:04}"), text)
        })
        .collect::<BTreeMap<_, _>>();
    let source = serde_json::to_vec(&values).unwrap();
    let manifest =
        br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#;
    assert!(source.len() + manifest.len() <= crate::content::MAX_SOURCE_BYTES);
    let input = directory.path().join("input");
    std::fs::create_dir_all(input.join("i18n")).unwrap();
    std::fs::write(input.join("manifest.json"), manifest).unwrap();
    std::fs::write(input.join("i18n/default.json"), &source).unwrap();
    let mut store = ProjectStore::create(
        &path,
        crate::ProjectMetadata::create("Capacity and history", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = parse_id(store.metadata().unwrap().project_id().to_string()).unwrap();
    let started = Instant::now();
    adopt_source(&mut store, &source);
    println!(
        "{}",
        json!({"operation": "source_capture_and_adoption", "entries": values.len(),
        "source_bytes": source.len(), "manifest_bytes": manifest.len(), "elapsed_us": started.elapsed().as_micros()})
    );
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let mut units = Vec::new();
    for offset in (0..2000).step_by(100) {
        units.extend(
            store
                .source_content(snapshot, offset, 100)
                .unwrap()
                .rows
                .into_iter()
                .map(|row| row.unit_id.unwrap()),
        );
    }
    assert_eq!(units.len(), 2000);
    let selected = units.into_iter().step_by(10).collect::<Vec<_>>();
    append_history(&mut store, project, &selected, "initial", 1);
    counts(&store, "initial");
    drop(store);
    let mut store = reopen(&path, "initial");
    sequence(&mut store, project, "initial", selected.len(), true);
    counts(&store, "initial_after_sequence");
    append_history(&mut store, project, &selected, "grown", 5);
    counts(&store, "grown");
    drop(store);
    let mut store = reopen(&path, "grown");
    sequence(&mut store, project, "grown", selected.len(), true);
    counts(&store, "grown_after_sequence");
    drop(store);
    if output.is_some() {
        println!(
            "{}",
            json!({"operation": "retained_project", "directory": directory.keep()})
        );
    }
}

#[test]
#[ignore = "explicit read-only measurements of a retained current-format synthetic fixture"]
fn measure_retained_supported_reads() {
    let path = std::path::PathBuf::from(
        std::env::var_os("TSUMUGI_PERFORMANCE_PROJECT")
            .expect("Select a retained synthetic project"),
    );
    let connection = Connection::open_with_flags(
        path.join("project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let schema: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(
        schema,
        crate::persistence::SCHEMA_VERSION,
        "This measurement must not migrate a project"
    );
    drop(connection);
    let mut store = reopen(&path, "retained");
    let project = parse_id(store.metadata().unwrap().project_id().to_string()).unwrap();
    let selected: i64 = store.connection().unwrap().query_row(
        "SELECT COUNT(DISTINCT unit_id) FROM translation_selections WHERE project_id=?1 AND locale='zh-CN'",
        [project.to_string()], |row| row.get(0)).unwrap();
    counts(&store, "before_reads");
    if std::env::var_os("TSUMUGI_PERFORMANCE_VALIDATE").is_some() {
        report_read(&store, "retained", 0, "validate_translation", || {
            queries::read_snapshot(store.connection().unwrap(), |connection| {
                crate::persistence::translation::validate(connection).unwrap();
                Ok(())
            })
            .unwrap()
        });
        report_read(&store, "retained", 0, "validate_content", || {
            queries::read_snapshot(store.connection().unwrap(), |connection| {
                crate::persistence::content::validate(connection).unwrap();
                Ok(())
            })
            .unwrap()
        });
        report_read(&store, "retained", 0, "validate_full_schema", || {
            queries::read_snapshot(store.connection().unwrap(), |connection| {
                crate::persistence::validate_schema_shape(connection).unwrap();
                Ok(())
            })
            .unwrap()
        });
    } else {
        sequence(
            &mut store,
            project,
            "retained",
            usize::try_from(selected).unwrap(),
            false,
        );
    }
    counts(&store, "after_reads");
}
