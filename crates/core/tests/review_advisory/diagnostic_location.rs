use super::*;

fn checked(
    store: &mut ProjectStore,
    unit: ExecutionId,
    field: sdk::TextReviewField,
    range: sdk::TextRange,
) -> CheckRun {
    let choice = choice(store, unit, false);
    let prepared = prepare(store, unit, ExecutionId::new(), &[choice]);
    let mut runtime = joint_runtime(store, &prepared, Response::Diagnostic(field, range));
    let (_, origins) = execute_all(&mut runtime, store, &prepared);
    let computed = store
        .capture_review_check_execution(prepared, &origins)
        .unwrap()
        .compute(&Cancellation::default())
        .unwrap();
    store
        .commit_review_evidence(computed, &Cancellation::default())
        .unwrap()
}

fn diagnostic(run: &CheckRun) -> &sdk::TextReviewDiagnostic {
    &run.evidence.as_ref().unwrap().diagnostics[0]
}

fn unicode_source(mut exchange: sdk::ContentExchange) -> sdk::ContentExchange {
    for unit in &mut exchange.units {
        unit.text = "A👩🏽‍💻é中Z".into();
    }
    exchange
}

#[test]
fn current_diagnostic_coordinates_use_sdk_unicode_conversion_without_persisting_reads() {
    for field in [sdk::TextReviewField::Source, sdk::TextReviewField::Translation] {
        for (encoding, start, end) in [
            (sdk::TextEncoding::Utf8Byte, 1, 19),
            (sdk::TextEncoding::Utf16, 1, 10),
            (sdk::TextEncoding::Grapheme, 1, 3),
        ] {
            let (directory, mut store, rows) = support::source_fixture_with_transform(2, unicode_source);
            let unit = rows[0].unit_id.unwrap();
            save(&mut store, unit, "A👩🏽‍💻é中Z");
            let run = checked(&mut store, unit, field, sdk::TextRange {
                encoding, start, end,
            });
            let before = store.review_target(project(&store), unit, "zh-CN").unwrap();
            let observer = rusqlite::Connection::open(directory.path().join("project/project.sqlite3")).unwrap();
            let version: i64 = observer.query_row("PRAGMA data_version", [], |row| row.get(0)).unwrap();
            for _ in 0..2 {
                let location = store.review_diagnostic_location(
                    project(&store), unit, "zh-CN", run.run_id, diagnostic(&run),
                ).unwrap();
                assert_eq!(location.unit_id, unit);
                assert_eq!(location.locale, "zh-CN");
                assert_eq!(location.run_id, run.run_id);
                assert_eq!(location.basis, before.basis);
                assert_eq!(location.basis_evidence, before.basis_evidence);
                assert_eq!(location.location, sdk::TextReviewLocation {
                    field,
                    range: sdk::TextRange {
                        encoding: sdk::TextEncoding::Utf16, start: 1,
                        end: 10,
                    },
                });
            }
            assert_eq!(store.review_target(project(&store), unit, "zh-CN").unwrap(), before);
            let after: i64 = observer.query_row("PRAGMA data_version", [], |row| row.get(0)).unwrap();
            assert_eq!(after, version, "diagnostic reads must not commit business changes");
            assert_eq!(store.review_check_action(project(&store), run.action_id).unwrap(), Some(run));
        }
    }
}

#[test]
fn diagnostic_reads_require_the_complete_original_finding_and_current_qa_run() {
    let (_directory, mut store, rows) = support::source_fixture();
    let unit = rows[0].unit_id.unwrap();
    save(&mut store, unit, "😀same");
    let range = sdk::TextRange { encoding: sdk::TextEncoding::Utf16, start: 2, end: 6 };
    let run = checked(&mut store, unit, sdk::TextReviewField::Translation, range);
    let original = diagnostic(&run);
    for change in 0..8 {
        let mut forged = original.clone();
        match change {
            0 => forged.target = unit.to_string(),
            1 => forged.key.rule.behavior_version += 1,
            2 => forged.detail = Some("Different detail".into()),
            3 => forged.suggestion = Some("Different suggestion".into()),
            4 => forged.resource_entry.as_mut().unwrap().entry_id = "another-entry".into(),
            5 => forged.location.as_mut().unwrap().range.end = u32::MAX,
            6 => forged.location.as_mut().unwrap().field = sdk::TextReviewField::Source,
            _ => forged.location = None,
        }
        assert!(store.review_diagnostic_location(project(&store), unit, "zh-CN", run.run_id, &forged).is_err(), "mutation {change}");
    }
    assert!(store.review_diagnostic_location(project(&store), rows[1].unit_id.unwrap(), "zh-CN", run.run_id, original).is_err());
    assert!(store.review_diagnostic_location(project(&store), unit, "zh-CN", ExecutionId::new(), original).is_err());
    let newer = checked(&mut store, unit, sdk::TextReviewField::Translation, range);
    assert_eq!(newer.basis, run.basis, "a new QA run can retain the manual review basis");
    assert!(store.review_diagnostic_location(project(&store), unit, "zh-CN", run.run_id, original).is_err());
    assert!(store.review_diagnostic_location(project(&store), unit, "zh-CN", newer.run_id, diagnostic(&newer)).is_ok());
}

#[test]
fn selection_resource_and_source_changes_make_old_diagnostic_locations_unavailable() {
    for change in ["selection", "resources", "source", "qa-material"] {
        let (_directory, mut store, rows) = support::source_fixture();
        let p = project(&store);
        let unit = rows[0].unit_id.unwrap();
        save(&mut store, unit, "😀same");
        let run = checked(&mut store, unit, sdk::TextReviewField::Translation,
            sdk::TextRange { encoding: sdk::TextEncoding::Utf16, start: 2, end: 6 });
        match change {
            "selection" => save(&mut store, unit, "😀same"),
            "resources" => {
                store.save_context(&tsumugi_core::SaveContext {
                    project_id: p, action_id: ExecutionId::new(), unit_id: unit,
                    locale: "zh-CN".into(), source_revision_id: run.basis_evidence.source_revision_id,
                    expected_revision_id: None, text: "New interpretation".into(),
                    reason: "Synthetic currentness change".into(),
                }).unwrap();
            }
            _ => {
                let mut runtime = support::source_runtime(&store);
                let input = support::source_input_with_texts(&store, if change == "source" {
                    &["changed", "same"]
                } else {
                    &["same", "changed companion"]
                });
                let (_, result) = support::execute(&mut runtime, &mut store, &input);
                let capture = store.capture_source_validation(input.envelope().attempt_id, result.envelope().result_id).unwrap();
                let (_, proof) = support::execute(&mut runtime, &mut store, capture.check_input());
                store.commit_source_validation(capture.prepare(proof).unwrap()).unwrap();
                let comparison = store.source_comparison(input.envelope().attempt_id, result.envelope().result_id, 0, 10).unwrap();
                assert_eq!((comparison.changed, comparison.unchanged), (1, 1));
                assert_eq!(comparison.previous_snapshot_id, run.basis_evidence.source_snapshot_id);
                let target_change = comparison.rows.iter().find(|entry| {
                    entry.old.as_ref().is_some_and(|old| old.unit_id == Some(unit))
                }).unwrap();
                assert_eq!(target_change.kind, if change == "source" {
                    tsumugi_core::content::SourceChangeKind::Changed
                } else {
                    tsumugi_core::content::SourceChangeKind::Unchanged
                });
                let action = store.prepare_adoption_with_id(ExecutionId::new(), input.envelope().attempt_id,
                    input.envelope().units[0].unit_id, vec![result.envelope().result_id],
                    serde_json::to_value(comparison.confirmation).unwrap()).unwrap();
                store.adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler).unwrap();
            }
        }
        if change == "source" {
            // Changed text without an explicit continuation creates a new unit.
            // Historical QA remains readable but cannot locate a current editor.
            let error = store.review_target(p, unit, "zh-CN").unwrap_err();
            assert_eq!(error.code, ErrorCode::DependencyConflict);
            assert_eq!(error.stage, "review-unit");
            let current = store.source_content(store.content_scope().unwrap().current_snapshot.unwrap(), 0, 10).unwrap();
            assert!(current.rows.iter().all(|row| row.unit_id != Some(unit)));
            assert_eq!(current.rows[0].occurrence.text, "changed");
            assert_ne!(current.rows[0].unit_id, Some(unit));
        } else {
            let target = store.review_target(p, unit, "zh-CN").unwrap();
            if change == "qa-material" {
                assert_eq!(target.unit_id, unit);
                assert_eq!(target.source_revision_id, run.basis_evidence.source_revision_id);
                assert_eq!(target.selection_id, run.basis_evidence.selection_id);
                assert_eq!(target.revision_id, run.basis_evidence.revision_id);
                assert_eq!(target.source_text, "same");
                assert_eq!(target.translation_text.as_deref(), Some("😀same"));
                assert_eq!(target.basis, run.basis, "QA material can change independently of the manual review basis");
                assert_ne!(target.source_snapshot_id, run.basis_evidence.source_snapshot_id);
                let current = store.source_content(target.source_snapshot_id, 0, 10).unwrap();
                assert_eq!(current.rows[0].unit_id, Some(unit));
                assert_eq!(current.rows[0].source_revision_id, Some(run.basis_evidence.source_revision_id));
                assert_eq!(current.rows[1].occurrence.text, "changed companion");
                assert_ne!(current.rows[1].source_revision_id, rows[1].source_revision_id);
            } else {
                assert_ne!(target.basis, run.basis);
            }
            assert!(target.current_check.is_none());
        }
        let error = store.review_diagnostic_location(p, unit, "zh-CN", run.run_id, diagnostic(&run)).unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict, "{change}");
        assert_eq!(error.stage, if change == "source" { "review-unit" } else { "review-diagnostic-current" }, "{change}");
        assert_eq!(store.review_check_action(p, run.action_id).unwrap(), Some(run));
    }
}
