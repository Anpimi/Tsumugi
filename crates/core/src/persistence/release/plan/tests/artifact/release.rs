//! Real SQLite adoption and delivery records; process outcomes are synthetic.
use super::*;
use crate::{DeliveryFile, DeliveryFileState, DeliveryState, ExportAdmission, ReleaseAdoptionHandler};

fn prove(
    store: &mut ProjectStore,
    generation: ExecutionId,
    input: &FixedInput,
    result: &FixedResult,
) -> (FixedInput, FixedResult, ExecutionId) {
    let capture = store
        .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    let checks = passing_results(&capture);
    let (checked, grant) = checker_result(store, generation, &capture, checks);
    store
        .commit_artifact_validation(capture.prepare(checked.clone()).unwrap())
        .unwrap();
    (check_input, checked, grant)
}
fn action(store: &mut ProjectStore, input: &FixedInput, results: &[FixedResult]) -> AdoptionAction {
    store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            results.iter().map(|r| r.envelope().result_id).collect(),
            serde_json::json!({}),
        )
        .unwrap()
}
fn release_id(receipt: &AdoptionReceipt) -> ExecutionId {
    assert_eq!(receipt.changes.len(), 1);
    assert_eq!(receipt.changes[0].kind, "release");
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}
fn replace(store: &mut ProjectStore, input: &FixedInput, result: &FixedResult) {
    let mut envelope = result.envelope().clone();
    envelope.result_id = ExecutionId::new();
    envelope.supersedes = Some(result.envelope().result_id);
    envelope.plugin.as_mut().unwrap().result.result_id = ExecutionId::new().to_string();
    let replaced = FixedResult::capture(envelope, input, result.envelope().dispatch_token).unwrap();
    store.save_execution_result(&replaced).unwrap();
}

fn rehash_source_evidence(store: &ProjectStore, input: &FixedInput, result: bool) {
    let plan = ReleasePlan::from_input(input).unwrap();
    let connection = store.connection().unwrap();
    let mut bytes: Vec<u8> = if result {
        connection
            .query_row(
                "SELECT bytes FROM execution_results WHERE result_id=?1",
                [plan.source_result_id.to_string()],
                |r| r.get(0),
            )
            .unwrap()
    } else {
        store
            .execution_input(plan.source_attempt_id)
            .unwrap()
            .bytes()
            .to_vec()
    };
    bytes.push(b' '); // Structurally equivalent JSON still changes the frozen raw digest.
    if result {
        connection
            .execute(
                "UPDATE execution_results SET bytes=?2,digest=?3 WHERE result_id=?1",
                rusqlite::params![
                    plan.source_result_id.to_string(),
                    &bytes,
                    codec::digest(&bytes)
                ],
            )
            .unwrap();
    } else {
        let changed = FixedInput::restore(&bytes, &codec::digest(&bytes)).unwrap();
        crate::persistence::ledger::replace_test_input(connection, &changed).unwrap();
    }
}

#[test]
fn corrected_release_and_source_context_keep_the_exact_frozen_mapping_after_later_correction() {
    use crate::content::{CorrectSourceLineage,SourceLineageCorrectionDecision};
    let (directory,mut store,project,old_units)=fixture();
    let initial=store.content_scope().unwrap().current_snapshot.unwrap();
    let old=store.source_content(initial,0,10).unwrap().rows[0].clone();
    let qualified=ready(&mut store,project,&old_units,"zh-CN");
    let build=environment(&store);
    let mut legacy=store.capture_plugin_release_plan(project,&choices(),&qualified,&build).unwrap();
    legacy.source_mapping_revision=None;
    let legacy_input=legacy.fixed_input(ExecutionId::new()).unwrap();
    let legacy_bytes=legacy_input.bytes().to_vec();
    assert!(legacy_input.envelope().settings.get("sourceMappingRevision").is_none());
    let restored=ReleasePlan::from_input(&FixedInput::restore(&legacy_bytes,legacy_input.digest()).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(&restored).unwrap(),legacy_input.envelope().settings);
    restored.validate_source_reference(store.connection().unwrap()).unwrap();
    adopt_source(&mut store,br#"{"hello":"Changed {{name}}","plain":"Plain"}"#);
    let snapshot=store.content_scope().unwrap().current_snapshot.unwrap();
    let raw_b=store.source_content(snapshot,0,10).unwrap().rows[0].clone();
    translate(&mut store,project,raw_b.unit_id.unwrap(),"zh-CN","B {{name}}");
    let request=CorrectSourceLineage{project_id:project,action_id:ExecutionId::new(),basis:store.source_lineage_correction_basis(project,snapshot,0).unwrap(),old_occurrence_id:old.occurrence_id.unwrap(),decision:SourceLineageCorrectionDecision::Continue,actor:"Maintainer".into(),reason:"Use the original identity".into()};
    store.correct_source_lineage(&request).unwrap();
    let units=store.review_page(project,"zh-CN",0,10).unwrap().rows.into_iter().map(|r|r.unit_id).collect::<Vec<_>>();
    let basis=ready(&mut store,project,&units,"zh-CN");
    let build=environment(&store);
    let input=store.prepare_plugin_build(project,ExecutionId::new(),&choices(),&basis,&build).unwrap();
    let plan=ReleasePlan::from_input(&input).unwrap();
    assert_eq!(plan.source_mapping_revision,Some(Revision::new(1).unwrap()));
    let scope=crate::SourceContextRequest{project_id:project,source_snapshot_id:snapshot,unit_id:plan.locales[0].targets[0].review.unit_id,source_revision_id:plan.locales[0].targets[0].review.source_revision_id,locale:"zh-CN".into()};
    let context=store.source_context(&scope).unwrap();
    assert_eq!(context.local_unit_id,plan.locales[0].targets[0].local_unit_id);
    let generation=ExecutionId::new();store.begin_plugin_epoch(generation).unwrap();authorize(&mut store,generation,&input);
    let result=builder_result(&mut store,&input,input.envelope().items[0].item_id);
    prove(&mut store,generation,&input,&result);
    let action=action(&mut store,&input,&[result]);
    let receipt=store.adopt_execution(&action,&ReleaseAdoptionHandler).unwrap();
    let release=release_id(&receipt);
    let view=store.release_view(release).unwrap();
    let artifact=store.release_artifact_by_path(release,"zh-CN",&choices()[0].output_paths[0]).unwrap();
    let saved=store.read_saved_plugin_build(project,input.envelope().attempt_id,false).unwrap();
    let reject=CorrectSourceLineage{project_id:project,action_id:ExecutionId::new(),basis:store.source_lineage_correction_basis(project,snapshot,0).unwrap(),old_occurrence_id:old.occurrence_id.unwrap(),decision:SourceLineageCorrectionDecision::Reject,actor:"Maintainer".into(),reason:"Later independent identity decision".into()};
    store.correct_source_lineage(&reject).unwrap();
    assert_eq!(store.source_content(snapshot,0,10).unwrap().rows[0].unit_id,raw_b.unit_id);
    assert!(store.source_context(&scope).is_err());
    let historical=crate::persistence::resources::SourceContextReader::historical_in(store.connection().unwrap(),&scope).unwrap();
    assert_eq!(historical.project(&scope).unwrap(),context);
    let row=historical.source_for_result_reference(context.source_attempt_id,context.source_result_id,scope.unit_id,scope.source_revision_id).unwrap();
    assert_eq!(row.occurrence.operation_unit_id,context.local_unit_id);
    let mut wrong=scope.clone();wrong.source_snapshot_id=initial;
    assert!(crate::persistence::resources::SourceContextReader::historical_in(store.connection().unwrap(),&wrong).is_err());
    wrong=scope.clone();wrong.unit_id=raw_b.unit_id.unwrap();
    assert!(crate::persistence::resources::SourceContextReader::historical_in(store.connection().unwrap(),&wrong).is_err());
    plan.validate_source_reference(store.connection().unwrap()).unwrap();
    let mut wrong=plan.clone();wrong.source_mapping_revision=Some(Revision::new(2).unwrap());
    assert_eq!(wrong.validate_source_reference(store.connection().unwrap()).unwrap_err().stage,"release-source-reference");
    restored.validate_source_reference(store.connection().unwrap()).unwrap();
    assert_eq!(legacy_input.bytes(),legacy_bytes);
    assert_eq!(store.read_saved_plugin_build(project,input.envelope().attempt_id,false).unwrap(),saved);
    assert_eq!(store.release_view(release).unwrap(),view);
    assert_eq!(store.release_artifact_by_path(release,"zh-CN",&choices()[0].output_paths[0]).unwrap(),artifact);
    drop(store);
    let reopened=ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.read_saved_plugin_build(project,input.envelope().attempt_id,false).unwrap(),saved);
    assert_eq!(reopened.release_view(release).unwrap(),view);
    assert_eq!(reopened.release_artifact_by_path(release,"zh-CN",&choices()[0].output_paths[0]).unwrap(),artifact);
}

#[test]
fn all_artifacts_survive_frozen_edits_delivery_outcomes_and_current_format_move() {
    let (directory, mut store, generation, input) = fixture_build(&["zh-CN", "fr-FR"]);
    let results: Vec<_> = input
        .envelope()
        .items
        .iter()
        .map(|i| builder_result(&mut store, &input, i.item_id))
        .collect();
    let proofs: Vec<_> = results
        .iter()
        .map(|r| prove(&mut store, generation, &input, r))
        .collect();
    let action = action(&mut store, &input, &results);
    let prepared = store
        .capture_execution_adoption(&action)
        .unwrap()
        .prepare(&ReleaseAdoptionHandler)
        .unwrap();
    assert!(store.connection().unwrap().is_autocommit());
    let unit = store
        .review_page(input.envelope().project_id, "zh-CN", 0, 100)
        .unwrap()
        .rows[0]
        .unit_id;
    translate(
        &mut store,
        input.envelope().project_id,
        unit,
        "zh-CN",
        "Edited after freeze",
    );
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    thread_local! { static RELEASE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
    let trace = |store: &ProjectStore| store.connection().unwrap().trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(|event| {
        if let TraceEvent::Stmt(_, sql) = event
            && sql.starts_with("SELECT action_id,project_id,attempt_id,manifest,manifest_digest,created_at")
        {
            RELEASE_READS.with(|count| count.set(count.get() + 1));
        }
    }));
    let receipt = store.commit_execution_adoption(prepared).unwrap();
    let release = release_id(&receipt);
    trace(&store);
    let [view]: [ReleaseView; 1] = store.list_releases(input.envelope().project_id).unwrap().try_into().unwrap();
    assert_eq!(view.release_id, release);
    assert_eq!(RELEASE_READS.with(|count| count.replace(0)), 0, "the first history read must reuse the committed proof");
    store.connection().unwrap().trace_v2(TraceEventCodes::empty(), None);
    assert_eq!(view.artifacts.len(), 6);
    assert_eq!(
        view.eligibility_basis,
        ReleasePlan::from_input(&input).unwrap().eligibility_basis()
    );
    assert!(
        store.release_artifact(release, "zh-CN").is_err(),
        "a locale cannot silently select its first artifact"
    );
    let mut saved = Vec::new();
    for summary in &view.artifacts {
        let (metadata, bytes) = store
            .release_artifact_by_path(release, &summary.locale, &summary.file_name)
            .unwrap();
        assert_eq!(&metadata, summary);
        assert_eq!(
            metadata.entry_count, 2,
            "generic count is frozen source units, not three occurrences or parsed file records"
        );
        assert_eq!(codec::digest(&bytes), metadata.sha256);
        if ["tsumugi-release/locale-1-zh-CN.json", "tsumugi-release/locale-2-fr-FR.json"].contains(&summary.file_name.as_str()) {
            let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(report["format"], "tsumugi-release-report");
            assert_eq!(report["targetLanguage"], summary.locale);
            assert_eq!(report["files"].as_array().unwrap().len(), 2);
        } else {
            assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]) && bytes.ends_with(b"\r\n"));
        }
        assert!(
            !String::from_utf8(bytes.clone())
                .unwrap()
                .contains("Edited after freeze")
        );
        saved.push((metadata, bytes));
    }
    assert!(
        store
            .release_artifact_by_path(release, "fr-FR", "zh-CN/main.txt")
            .is_err()
    );
    assert!(
        store
            .release_artifact_by_path(release, "zh-CN", "../main.txt")
            .is_err()
    );
    for (_, _, grant) in proofs {
        store.revoke_plugin_grant(generation, grant).unwrap();
    }
    store
        .revoke_plugin_grant(
            generation,
            results[0]
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .authorization_id,
        )
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    assert_eq!(
        store.list_releases(input.envelope().project_id).unwrap(),
        [view.clone()]
    );

    // These calls record observed outcomes. They perform no target-directory IO.
    let delivery_action = ExecutionId::new();
    let mut expected: Vec<_> = view.artifacts.iter().map(|artifact| DeliveryFile {
        locale: artifact.locale.clone(),
        file_name: artifact.file_name.clone(),
        expected_sha256: artifact.sha256.clone(),
        actual_sha256: None,
        state: DeliveryFileState::Pending,
    }).collect();
    let correct_digest = std::mem::replace(&mut expected[0].expected_sha256, "0".repeat(64));
    let error = store.begin_delivery_for_export(delivery_action, release, "isolated-destination", false, &expected)
        .err().expect("a stale preview must be rejected");
    assert_eq!(error.code, ErrorCode::DependencyConflict);
    assert!(store.delivery_by_action(delivery_action).unwrap().is_none());
    expected[0].expected_sha256 = correct_digest;

    trace(&store);
    let admission = store.begin_delivery_for_export(delivery_action, release, "isolated-destination", false, &expected).unwrap();
    let replay = store.begin_delivery_for_export(delivery_action, release, "isolated-destination", false, &expected).unwrap();
    // list_releases verified the release after the last write. Admission can
    // read the bytes directly, and replay must continue to return only a receipt.
    assert_eq!(RELEASE_READS.with(|count| count.replace(0)), 0);
    let ExportAdmission::Started { release: captured, bytes } = admission else { panic!("new action must carry bytes"); };
    assert_eq!(captured, view);
    assert!(bytes.iter().eq(saved.iter().map(|(_, bytes)| bytes)));
    let pending = store.delivery_by_action(delivery_action).unwrap().unwrap();
    assert_eq!(pending.files, expected);
    let ExportAdmission::Existing(existing) = replay else { panic!("replay must carry only the receipt"); };
    assert_eq!(existing, pending);
    assert_eq!(
        store
            .begin_delivery(delivery_action, release, "isolated-destination", false)
            .unwrap(),
        pending
    );
    let mut files = pending.files.clone();
    for (i, file) in files.iter_mut().enumerate() {
        file.state = if i == 0 {
            DeliveryFileState::Succeeded
        } else {
            DeliveryFileState::Failed
        };
        file.actual_sha256 = (i == 0).then(|| file.expected_sha256.clone());
    }
    assert_eq!(
        store
            .finish_delivery(delivery_action, files.clone())
            .unwrap()
            .state,
        DeliveryState::Partial
    );
    let receipts = store.list_deliveries(release).unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].state, DeliveryState::Partial);
    assert_eq!(RELEASE_READS.with(|count| count.replace(0)), 0, "receipt writes must retain unchanged release proof");
    store.connection().unwrap().trace_v2(TraceEventCodes::empty(), None);
    assert_eq!(
        store
            .begin_delivery(delivery_action, release, "isolated-destination", false)
            .unwrap()
            .state,
        DeliveryState::Partial
    );
    assert_eq!(
        store
            .finish_delivery(delivery_action, files)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    let unknown_action = ExecutionId::new();
    let pending = store
        .begin_delivery(unknown_action, release, "isolated-destination", true)
        .unwrap();
    let mut files = pending.files.clone();
    for (i, file) in files.iter_mut().enumerate() {
        file.state = if i == 0 {
            DeliveryFileState::Unknown
        } else {
            DeliveryFileState::Succeeded
        };
        file.actual_sha256 = (i != 0).then(|| file.expected_sha256.clone());
    }
    assert_eq!(
        store
            .finish_delivery(unknown_action, files.clone())
            .unwrap()
            .state,
        DeliveryState::Unknown
    );
    assert_eq!(
        store
            .begin_delivery(ExecutionId::new(), release, "isolated-destination", true)
            .unwrap_err()
            .code,
        ErrorCode::OutcomeUnknown
    );
    let mut forged = files.clone();
    forged.swap(0, 1);
    assert!(store.reconcile_delivery(unknown_action, forged).is_err());
    files[0].state = DeliveryFileState::Succeeded;
    files[0].actual_sha256 = Some(files[0].expected_sha256.clone());
    assert_eq!(
        store
            .reconcile_delivery(unknown_action, files)
            .unwrap()
            .state,
        DeliveryState::Succeeded
    );
    assert_eq!(store.release_view(release).unwrap(), view);

    let path = store.directory().to_owned();
    drop(store);
    let backup = directory.path().join("backup");
    std::fs::create_dir(&backup).unwrap();
    std::fs::copy(path.join("project.sqlite3"), backup.join("project.sqlite3")).unwrap();
    std::fs::copy(path.join(".tsumugi.lock"), backup.join(".tsumugi.lock")).unwrap();
    let moved = directory.path().join("moved");
    std::fs::rename(&path, &moved).unwrap();
    for path in [moved, backup] {
        let mut reopened = ProjectStore::open(path).unwrap();
        assert!(reopened.check_plugin_input(&input).is_err());
        assert_eq!(reopened.release_view(release).unwrap(), view);
        assert_eq!(
            reopened
                .adopt_execution(&action, &ReleaseAdoptionHandler)
                .unwrap(),
            receipt
        );
        assert_eq!(reopened.list_deliveries(release).unwrap().len(), 2);
        for (summary, bytes) in &saved {
            assert_eq!(
                reopened
                    .release_artifact_by_path(release, &summary.locale, &summary.file_name)
                    .unwrap(),
                (summary.clone(), bytes.clone())
            );
        }
    }
}

#[test]
fn recording_a_second_build_preserves_the_first_and_rechecks_a_changed_link() {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};

    let (_directory, mut store, generation, first) = fixture_build(&["zh-CN"]);
    let project = first.envelope().project_id;
    let result = builder_result(&mut store, &first, first.envelope().items[0].item_id);
    prove(&mut store, generation, &first, &result);
    let first_action = action(&mut store, &first, &[result.clone()]);
    let first_release = release_id(&store.adopt_execution(&first_action, &ReleaseAdoptionHandler).unwrap());

    thread_local! { static MANIFEST_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
    store.connection().unwrap().trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(|event| {
        if let TraceEvent::Stmt(_, sql) = event
            && sql.starts_with("SELECT action_id,project_id,attempt_id,manifest,manifest_digest,created_at")
        {
            MANIFEST_READS.with(|count| count.set(count.get() + 1));
        }
    }));

    let plan = ReleasePlan::from_input(&first).unwrap();
    let second = store.prepare_plugin_build(
        project, ExecutionId::new(), &plan.choices(), plan.eligibility_basis(), plan.build_environment(),
    ).unwrap();
    authorize(&mut store, generation, &second);
    let second_result = builder_result(&mut store, &second, second.envelope().items[0].item_id);
    prove(&mut store, generation, &second, &second_result);
    assert_eq!(store.list_releases(project).unwrap()[0].release_id, first_release);
    let second_action = action(&mut store, &second, &[second_result]);
    let second_release = release_id(&store.adopt_execution(&second_action, &ReleaseAdoptionHandler).unwrap());
    let history = store.list_releases(project).unwrap();
    assert_eq!(history.len(), 2);
    assert!(history.iter().any(|release| release.release_id == second_release));
    assert_eq!(MANIFEST_READS.with(|count| count.replace(0)), 0);

    store.connection().unwrap().execute(
        "UPDATE plugin_validation_links SET valid=0 WHERE producer_result_id=?1",
        [result.envelope().result_id.to_string()],
    ).unwrap();
    assert!(store.release_view(first_release).is_err());
    assert_eq!(store.release_view(second_release).unwrap().release_id, second_release);
    assert_eq!(MANIFEST_READS.with(|count| count.replace(0)), 1);
}

#[test]
fn a_trigger_that_changes_committed_release_bytes_cannot_seed_a_verified_projection() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let prepared = store.capture_execution_adoption(&action).unwrap()
        .prepare(&ReleaseAdoptionHandler).unwrap();
    store.connection().unwrap().execute_batch(
        "CREATE TEMP TRIGGER substitute_release AFTER INSERT ON main.release_artifacts
         BEGIN UPDATE release_artifacts SET bytes=x'66' WHERE release_id=NEW.release_id; END;",
    ).unwrap();
    let receipt = store.commit_execution_adoption(prepared).unwrap();
    let error = store.release_view(release_id(&receipt)).unwrap_err();
    assert_eq!(error.code, ErrorCode::CorruptLedger);
}

#[test]
fn one_missing_locale_proof_or_incomplete_action_cannot_create_a_release() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN", "fr-FR"]);
    let results: Vec<_> = input
        .envelope()
        .items
        .iter()
        .map(|i| builder_result(&mut store, &input, i.item_id))
        .collect();
    prove(&mut store, generation, &input, &results[0]);
    assert!(
        store
            .prepare_adoption(
                input.envelope().attempt_id,
                input.envelope().units[0].unit_id,
                vec![results[0].envelope().result_id],
                serde_json::json!({})
            )
            .is_err()
    );
    let action = action(&mut store, &input, &results);
    assert_eq!(
        store.capture_execution_adoption(&action).unwrap_err().code,
        ErrorCode::ResultMismatch
    );
    assert!(
        store
            .list_releases(input.envelope().project_id)
            .unwrap()
            .is_empty()
    );
    assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
    prove(&mut store, generation, &input, &results[1]);
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .release_view(release_id(&receipt))
            .unwrap()
            .artifacts
            .len(),
        6
    );
}

#[test]
fn release_rechecks_both_grants_and_cancellation_at_capture_and_commit() {
    for after_prepare in [false, true] {
        for producer in [false, true] {
            for cancel in [false, true] {
                let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
                let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
                let (check_input, _, check_grant) = prove(&mut store, generation, &input, &result);
                let action = action(&mut store, &input, &[result.clone()]);
                let prepared = after_prepare.then(|| {
                    store
                        .capture_execution_adoption(&action)
                        .unwrap()
                        .prepare(&ReleaseAdoptionHandler)
                        .unwrap()
                });
                let (task, grant) = if producer {
                    (
                        input.envelope().task_id,
                        result.envelope().plugin.as_ref().unwrap().authorization_id,
                    )
                } else {
                    (check_input.envelope().task_id, check_grant)
                };
                if cancel {
                    store.cancel_execution(task, ExecutionId::new()).unwrap();
                } else {
                    store.revoke_plugin_grant(generation, grant).unwrap();
                }
                let error = if let Some(prepared) = prepared {
                    store.commit_execution_adoption(prepared).unwrap_err()
                } else {
                    store.capture_execution_adoption(&action).unwrap_err()
                };
                assert_eq!(
                    error.code,
                    if cancel {
                        ErrorCode::Cancelled
                    } else {
                        ErrorCode::Unauthorized
                    }
                );
                assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
                assert!(
                    store
                        .list_releases(input.envelope().project_id)
                        .unwrap()
                        .is_empty()
                );
                assert_eq!(
                    store
                        .execution_result(input.envelope().attempt_id, result.envelope().result_id)
                        .unwrap()
                        .bytes(),
                    result.bytes()
                );
            }
        }
    }
}

#[test]
fn saved_proof_with_superseded_builder_or_checker_refuses_new_release() {
    for after_prepare in [false, true] {
        for producer in [false, true] {
            let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
            let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
            let (check_input, checked, _) = prove(&mut store, generation, &input, &result);
            let action = action(&mut store, &input, &[result.clone()]);
            let prepared = after_prepare.then(|| {
                store
                    .capture_execution_adoption(&action)
                    .unwrap()
                    .prepare(&ReleaseAdoptionHandler)
                    .unwrap()
            });
            if producer {
                replace(&mut store, &input, &result);
            } else {
                replace(&mut store, &check_input, &checked);
            }
            let error = if let Some(prepared) = prepared {
                store.commit_execution_adoption(prepared).unwrap_err()
            } else {
                store.capture_execution_adoption(&action).unwrap_err()
            };
            assert_eq!(error.code, ErrorCode::ResultMismatch);
            assert_eq!(
                state(&store, &input, result.envelope().item_id),
                if producer {
                    ValidationState::Pending
                } else {
                    ValidationState::Valid
                }
            );
            assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
            assert!(
                store
                    .list_releases(input.envelope().project_id)
                    .unwrap()
                    .is_empty()
            );
        }
    }
}

#[test]
fn release_reads_and_reopen_refuse_rehashed_substitution_or_missing_links_without_writes() {
    for damage in 0..14 {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
        prove(&mut store, generation, &input, &result);
        let action = action(&mut store, &input, &[result.clone()]);
        let receipt = store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap();
        let release = release_id(&receipt);
        let path = store.directory().to_owned();
        let expected = store.release_view(release).unwrap();
        store.close().unwrap();
        let store = ProjectStore::open(&path).unwrap();
        assert_eq!(store.release_view(release).unwrap(), expected);
        let external = (damage == 0).then(|| Connection::open(path.join("project.sqlite3")).unwrap());
        let connection = external.as_ref().unwrap_or_else(|| store.connection().unwrap());
        let id = release.to_string();
        match damage {
            0 => {
                connection.execute("UPDATE release_artifacts SET bytes=?2,sha256=?3 WHERE release_id=?1 AND artifact_id='artifact-0'", rusqlite::params![id,b"Forged bytes",codec::digest(b"Forged bytes")]).unwrap();
            }
            1 => {
                connection
                    .execute(
                        "UPDATE release_artifacts SET role='other' WHERE release_id=?1",
                        [&id],
                    )
                    .unwrap();
            }
            2 => {
                connection.execute("UPDATE release_artifacts SET file_name='other.txt' WHERE release_id=?1 AND artifact_id='artifact-0'", [&id]).unwrap();
            }
            3 => {
                connection.execute("UPDATE release_artifacts SET artifact_id='other' WHERE release_id=?1 AND artifact_id='artifact-0'", [&id]).unwrap();
            }
            4 => {
                connection
                    .execute(
                        "UPDATE release_artifacts SET entry_count=3 WHERE release_id=?1",
                        [&id],
                    )
                    .unwrap();
            }
            5 => {
                connection.execute("UPDATE release_artifacts SET validator_version='other' WHERE release_id=?1", [&id]).unwrap();
            }
            6 => {
                connection.execute("DELETE FROM release_artifacts WHERE release_id=?1 AND artifact_id='artifact-0'", [&id]).unwrap();
            }
            7 => {
                let bytes: Vec<u8> = connection
                    .query_row(
                        "SELECT manifest FROM release_records WHERE release_id=?1",
                        [&id],
                        |r| r.get(0),
                    )
                    .unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                value["resultIds"][0] = serde_json::json!(ExecutionId::new());
                let bytes = serde_json::to_vec(&value).unwrap();
                connection.execute("UPDATE release_records SET manifest=?2,manifest_digest=?3 WHERE release_id=?1", rusqlite::params![id,&bytes,codec::digest(&bytes)]).unwrap();
            }
            8 => {
                connection
                    .execute(
                        "DELETE FROM plugin_validation_links WHERE producer_result_id=?1",
                        [result.envelope().result_id.to_string()],
                    )
                    .unwrap();
            }
            9 => {
                connection
                    .execute(
                        "DELETE FROM adoption_receipts WHERE action_id=?1",
                        [action.action_id.to_string()],
                    )
                    .unwrap();
            }
            10 => rehash_source_evidence(&store, &input, false),
            11 => rehash_source_evidence(&store, &input, true),
            12 => {
                connection.execute(
                    "UPDATE release_records SET attempt_id=(
                        SELECT r.attempt_id FROM plugin_validation_links l
                        JOIN execution_results r ON r.result_id=l.checker_result_id
                        WHERE l.producer_result_id=?2
                    ) WHERE release_id=?1",
                    rusqlite::params![id, result.envelope().result_id.to_string()],
                ).unwrap();
            }
            13 => {
                connection.execute(
                    "INSERT INTO release_artifacts
                     SELECT release_id,locale,'extra',role,'extra.txt',bytes,sha256,validator_version,entry_count
                     FROM release_artifacts WHERE release_id=?1 AND artifact_id='artifact-0'",
                    [&id],
                ).unwrap();
            }
            _ => unreachable!(),
        }
        let bytes = std::fs::read(path.join("project.sqlite3")).unwrap();
        assert!(store.release_view(release).is_err(), "damage={damage}");
        assert!(
            store
                .release_artifact_by_path(release, "zh-CN", "zh-CN/main.txt")
                .is_err()
        );
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), bytes);
        drop(store);
        assert!(ProjectStore::open(&path).is_err(), "damage={damage}");
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), bytes);
    }
}

#[test]
fn artifact_checker_detail_matches_the_ledger_and_rejects_changed_input() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    let (checker, _, _) = prove(&mut store, generation, &input, &result);
    let attempt = checker.envelope().attempt_id;
    let captured = store.artifact_checker_attempt_detail(&checker, false, 0, 100).unwrap();
    let ledger = store.execution_attempt_detail(attempt, false, 0, 100).unwrap();
    assert_eq!(serde_json::to_value(captured).unwrap(), serde_json::to_value(ledger).unwrap());
    let connection = store.connection().unwrap();
    let chunk: String = connection.query_row(
        "SELECT json_extract(CAST(input AS TEXT),'$.chunks[0]') FROM execution_attempts WHERE attempt_id=?1",
        [attempt.to_string()], |row| row.get(0),
    ).unwrap();
    connection.execute(
        "UPDATE execution_input_chunks SET bytes=zeroblob(length(bytes)) WHERE digest=?1",
        [chunk],
    ).unwrap();
    assert!(store.artifact_checker_attempt_detail(&checker, false, 0, 100).is_err());
}

#[test]
fn release_commit_reuses_unchanged_qualification_without_loading_result_frames() {
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    thread_local! { static FRAME_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let prepared = store.capture_execution_adoption(&action).unwrap()
        .prepare(&ReleaseAdoptionHandler).unwrap();
    store.connection().unwrap().trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(|event| {
        if let TraceEvent::Stmt(_, sql) = event
            && sql.contains("SELECT rowid,CASE WHEN typeof(bytes)='blob'")
            && sql.contains("FROM execution_results WHERE result_id=?1 AND attempt_id=?2")
        {
            FRAME_READS.with(|count| count.set(count.get() + 1));
        }
    }));
    let receipt = store.commit_execution_adoption(prepared).unwrap();
    assert_eq!(FRAME_READS.with(|count| count.replace(0)), 0);
    assert_eq!(store.adoption_receipt(action.action_id).unwrap(), Some(receipt));
}

#[test]
fn release_commit_rechecks_frozen_source_references_after_preparation() {
    for result_damage in [false, true] {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
        prove(&mut store, generation, &input, &result);
        let action = action(&mut store, &input, &[result]);
        let prepared = store
            .capture_execution_adoption(&action)
            .unwrap()
            .prepare(&ReleaseAdoptionHandler)
            .unwrap();
        rehash_source_evidence(&store, &input, result_damage);
        assert!(store.commit_execution_adoption(prepared).is_err());
        assert!(
            store
                .list_releases(input.envelope().project_id)
                .unwrap()
                .is_empty()
        );
        assert!(store.adoption_receipt(action.action_id).unwrap().is_none());
    }
}

#[test]
fn partial_locale_continuation_reuses_original_proof_and_rechecks_original_authority() {
    for loss in 0..4 {
        // This trusted synthetic fixture only computes data. A real Host must
        // independently verify replay safety; a manifest cannot claim it here.
        let (_directory, mut store, generation, input) =
            fixture_build_policy(&["zh-CN", "fr-FR"], 131072, RecoveryPolicy::ReadOnly);
        let first = input.envelope().items[0].item_id;
        let second = input.envelope().items[1].item_id;
        let result = builder_result(&mut store, &input, first);
        let (_, _, checker_grant) = prove(&mut store, generation, &input, &result);
        let scope = input.item(first).unwrap().scope.locale.as_deref().unwrap();
        let unit = store
            .review_page(input.envelope().project_id, scope, 0, 100)
            .unwrap()
            .rows[0]
            .unit_id;
        translate(
            &mut store,
            input.envelope().project_id,
            unit,
            scope,
            "Future edit does not replace frozen input",
        );
        let retry = store
            .execution_retry_input(input.envelope().attempt_id, &[second])
            .unwrap();
        assert_eq!(
            retry.envelope().reused_results[0].result_id,
            result.envelope().result_id
        );
        assert_eq!(
            ReleasePlan::from_input(&retry).unwrap(),
            ReleasePlan::from_input(&input).unwrap()
        );
        authorize_policy(&mut store, generation, &retry, RecoveryPolicy::ReadOnly);
        let second_result = builder_result(&mut store, &retry, second);
        prove(&mut store, generation, &retry, &second_result);
        let action = action(&mut store, &retry, &[result.clone(), second_result]);
        match loss {
            0 => {}
            1 => store
                .revoke_plugin_grant(
                    generation,
                    result.envelope().plugin.as_ref().unwrap().authorization_id,
                )
                .unwrap(),
            2 => store
                .revoke_plugin_grant(generation, checker_grant)
                .unwrap(),
            3 => replace(&mut store, &input, &result),
            _ => unreachable!(),
        }
        if loss == 0 {
            let receipt = store
                .adopt_execution(&action, &ReleaseAdoptionHandler)
                .unwrap();
            assert_eq!(
                store
                    .release_view(release_id(&receipt))
                    .unwrap()
                    .artifacts
                    .len(),
                6
            );
            let path = store.directory().to_owned();
            drop(store);
            assert_eq!(
                ProjectStore::open(path)
                    .unwrap()
                    .release_view(release_id(&receipt))
                    .unwrap()
                    .artifacts
                    .len(),
                6
            );
        } else {
            assert_eq!(
                store.capture_execution_adoption(&action).unwrap_err().code,
                if loss == 3 {
                    ErrorCode::ResultMismatch
                } else {
                    ErrorCode::Unauthorized
                }
            );
            assert!(
                store
                    .list_releases(input.envelope().project_id)
                    .unwrap()
                    .is_empty()
            );
        }
    }
}

#[test]
fn default_unknown_effect_policy_keeps_partial_build_replay_blocked() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN", "fr-FR"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let recovery = store
        .execution_recovery(input.envelope().attempt_id, false)
        .unwrap();
    assert_eq!(
        recovery.units[0].blocked_reason.as_deref(),
        Some("external-new-consent")
    );
    assert_eq!(
        store
            .execution_retry_input(
                input.envelope().attempt_id,
                &[input.envelope().items[1].item_id]
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        store
            .list_releases(input.envelope().project_id)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn valid_empty_and_more_than_one_mebibyte_artifacts_are_stored_without_narrowing_sdk_limits() {
    assert_large_artifact_storage(false);
}

#[test]
fn binary_artifacts_are_stored_as_original_bytes_and_reopen_without_loss() {
    assert_large_artifact_storage(true);
}

fn assert_large_artifact_storage(binary: bool) {
    let (_directory, mut store, generation, input) =
        fixture_build_limit(&["zh-CN"], sdk::MAX_EXCHANGE_BYTES as u32);
    let item = input.envelope().items[0].item_id;
    let request = store
        .dispatch_execution_item(input.envelope().attempt_id, item)
        .unwrap();
    let build = ReleasePlan::from_input(&input).unwrap()
        .plugin_input(input.item(item).unwrap().scope.locale.as_deref().unwrap()).unwrap();
    let large = vec![if binary { 0xff } else { b'A' }; 1024 * 1024 + 17];
    let artifact = |id: &str, path: &str, role: &str, bytes: &[u8]| -> sdk::CapturedArtifact {
        if binary {
            sdk::CapturedArtifact::from_bytes(id.into(), path.into(), role.into(), bytes).unwrap()
        } else {
            sdk::CapturedTextArtifact { id: id.into(), logical_path: path.into(), role: role.into(),
                sha256: codec::digest(bytes), utf8: String::from_utf8(bytes.to_vec()).unwrap() }.into()
        }
    };
    let output = sdk::ArtifactSet {
        profile: build.source.profile,
        source_set_id: build.source.source_set_id,
        target_language: build.target_language,
        artifacts: vec![
            artifact("empty", &build.output_paths[0], "empty", b""),
            artifact("large", &build.output_paths[1], "locale", &large),
        ],
    };
    let result = sdk_result(&request, serde_json::to_value(output).unwrap());
    store.save_execution_result(&result).unwrap();
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    let id = release_id(&receipt);
    assert!(
        store
            .release_artifact_by_path(id, "zh-CN", "zh-CN/main.txt")
            .unwrap()
            .1
            .is_empty()
    );
    assert_eq!(
        store
            .release_artifact_by_path(id, "zh-CN", "zh-CN/second.txt")
            .unwrap()
            .1,
        large
    );
    let path = store.directory().to_owned();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(reopened.release_view(id).unwrap().artifacts.len(), 3);
    assert_eq!(
        reopened
            .release_artifact_by_path(id, "zh-CN", "zh-CN/second.txt")
            .unwrap()
            .1,
        large
    );
}

#[test]
fn staged_release_reference_reopens_and_refuses_rehashed_source_or_manifest_substitution() {
    for tamper in ["manifest", "source-input", "source-result"] {
        let (_directory, mut store, generation, ordinary) = fixture_build(&["zh-CN"]);
        let plan = ReleasePlan::from_input(&ordinary).unwrap();
        let project = ordinary.envelope().project_id;
        let selected = plan.locales[0].targets[0].review.unit_id;
        let scopes = BTreeMap::from([("zh-CN".into(), vec![selected])]);
        let eligibility = store.review_eligibility_for_build(project, &["zh-CN".into()], &scopes, &Cancellation::default()).unwrap();
        let mut choices = plan.choices(); choices[0].translation_units = Some(vec![selected]);
        let input = store.prepare_plugin_build(project, ExecutionId::new(), &choices, &eligibility.basis, plan.build_environment()).unwrap();
        authorize(&mut store, generation, &input);
        let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
        prove(&mut store, generation, &input, &result);
        let action = action(&mut store, &input, &[result]);
        let receipt = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
        let release = release_id(&receipt);
        let expected = store.release_view(release).unwrap();
        let bytes: Vec<u8> = store.connection().unwrap().query_row("SELECT manifest FROM release_records WHERE release_id=?1", [release.to_string()], |row| row.get(0)).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(manifest["version"], 3);
        assert_eq!(manifest["plan"], serde_json::json!({"kind":"plugin-input"}));
        let path = store.directory().to_owned(); store.close().unwrap();
        let mut store = ProjectStore::open(&path).unwrap();
        assert_eq!(store.release_view(release).unwrap(), expected);
        if tamper == "manifest" {
            let mut changed = manifest;
            changed["plan"] = serde_json::json!({"kind":"plugin", "data":ReleasePlan::from_input(&input).unwrap()});
            let bytes = serde_json::to_vec(&changed).unwrap();
            store.connection().unwrap().execute("UPDATE release_records SET manifest=?2,manifest_digest=?3 WHERE release_id=?1", rusqlite::params![release.to_string(), &bytes, codec::digest(&bytes)]).unwrap();
        } else {
            rehash_source_evidence(&store, &input, tamper == "source-result");
        }
        let before = store.connection().unwrap().total_changes();
        assert!(store.release_view(release).is_err());
        assert_eq!(store.connection().unwrap().total_changes(), before);
    }
}

#[test]
fn original_unversioned_full_release_manifest_remains_readable_without_rewriting() {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OriginalManifest {
        input_digest: String,
        result_ids: Vec<ExecutionId>,
        plan: OriginalPlan,
    }
    #[derive(serde::Serialize)]
    #[serde(tag = "kind", content = "data", rename_all = "kebab-case")]
    enum OriginalPlan { Plugin(ReleasePlan) }
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let receipt = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
    let release = release_id(&receipt);
    let current = store.release_view(release).unwrap();
    let bytes = codec::encode(&OriginalManifest { input_digest: input.digest().into(), result_ids: action.result_ids.clone(), plan: OriginalPlan::Plugin(ReleasePlan::from_input(&input).unwrap()) }, MAX_INPUT_BYTES).unwrap();
    store.connection().unwrap().execute("UPDATE release_records SET manifest=?2,manifest_digest=?3 WHERE release_id=?1", rusqlite::params![release.to_string(), &bytes, codec::digest(&bytes)]).unwrap();
    store.connection().unwrap().execute("DELETE FROM release_artifacts WHERE release_id=?1 AND file_name='tsumugi-release/locale-1-zh-CN.json'", [release.to_string()]).unwrap();
    let before = store.connection().unwrap().total_changes();
    let historical = store.release_view(release).unwrap();
    assert_eq!(historical.artifacts, current.artifacts.into_iter().filter(|file| file.file_name != "tsumugi-release/locale-1-zh-CN.json").collect::<Vec<_>>());
    assert_eq!(historical.policy_version, current.policy_version);
    assert_eq!(store.connection().unwrap().total_changes(), before);
    let path = store.directory().to_owned(); store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    assert_eq!(reopened.release_view(release).unwrap(), historical);
    assert_eq!(reopened.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap(), receipt);
    let preserved: Vec<u8> = reopened.connection().unwrap().query_row("SELECT manifest FROM release_records WHERE release_id=?1", [release.to_string()], |row| row.get(0)).unwrap();
    assert_eq!(preserved, bytes);
}

#[test]
fn release_report_preserves_exact_staged_scope_settings_and_bytes_after_current_edits() {
    let (_directory, mut store, generation, ordinary) = fixture_build(&["zh-CN"]);
    let original = ReleasePlan::from_input(&ordinary).unwrap();
    let project = ordinary.envelope().project_id;
    let target = &original.locales[0].targets[0];
    let selected = target.review.unit_id;
    // An approved translation equal to source must still be reported as selected.
    translate(
        &mut store,
        project,
        selected,
        "zh-CN",
        &target.review.source_text,
    );
    check(&mut store, project, selected, "zh-CN");
    approve(&mut store, project, selected, "zh-CN");
    let scopes = BTreeMap::from([("zh-CN".into(), vec![selected])]);
    let eligibility = store
        .review_eligibility_for_build(
            project,
            &["zh-CN".into()],
            &scopes,
            &Cancellation::default(),
        )
        .unwrap();
    let setting = sdk::BuildConfigurationDeclaration {
        schema: sdk::ContractRef {
            id: "example.output-settings".into(),
            schema_version: 1,
            behavior_version: 1,
        },
        display_name: "Game language files".into(),
        options: vec![sdk::BuildOptionDeclaration {
            id: "loading-language".into(),
            display_name: "Loading language".into(),
            choices: vec![sdk::BuildOptionChoice {
                id: "english".into(),
                display_name: "English".into(),
            }],
        }],
    };
    let mut environment = original.build_environment().clone();
    environment.binding.declaration.configuration = Some(vec![setting.clone()]);
    let mut choices = original.choices();
    choices[0].translation_units = Some(vec![selected]);
    choices[0].output_paths.truncate(1);
    choices[0].configuration = vec![
        setting
            .capture(&[sdk::BuildOptionSelection {
                id: "loading-language".into(),
                value: "english".into(),
            }])
            .unwrap(),
    ];
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices,
            &eligibility.basis,
            &environment,
        )
        .unwrap();
    authorize(&mut store, generation, &input);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let prepared = store
        .capture_execution_adoption(&action)
        .unwrap()
        .prepare(&ReleaseAdoptionHandler)
        .unwrap();
    let retained = original.locales[0].targets[1].review.unit_id;
    translate(
        &mut store,
        project,
        retained,
        "zh-CN",
        "Private newer unapproved translation",
    );
    let receipt = store.commit_execution_adoption(prepared).unwrap();
    let release = release_id(&receipt);
    let native = store
        .release_artifact_by_path(release, "zh-CN", &choices[0].output_paths[0])
        .unwrap();
    assert_eq!(store.release_artifact(release, "zh-CN").unwrap(), native);
    let (metadata, bytes) = store
        .release_artifact_by_path(release, "zh-CN", "tsumugi-release/locale-1-zh-CN.json")
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(report["formatVersion"], 1);
    assert_eq!(report["inputSha256"], input.digest());
    assert_eq!(report["sourceLanguage"], "en");
    assert_eq!(report["targetLanguage"], "zh-CN");
    assert_eq!(report["coverage"]["units"], 2);
    assert_eq!(report["coverage"]["translations"], 1);
    assert_eq!(report["coverage"]["sourceRetained"], 1);
    assert_eq!(report["coverage"]["sourceFallbacks"], 0);
    assert_eq!(
        report["coverage"]["entries"][0]["disposition"],
        "translation"
    );
    assert_eq!(
        report["coverage"]["entries"][1]["disposition"],
        "source-retained"
    );
    assert_eq!(report["settings"][0]["option"], "Loading language");
    assert_eq!(report["settings"][0]["value"], "English");
    assert_eq!(report["settings"][0]["valueId"], "english");
    assert_eq!(report["files"].as_array().unwrap().len(), 1);
    assert_eq!(report["files"][0]["sha256"], native.0.sha256);
    assert_eq!(report["files"][0]["bytes"], native.1.len());
    assert_eq!(metadata.sha256, codec::digest(&bytes));
    assert!(
        !String::from_utf8(bytes.clone())
            .unwrap()
            .contains("Private newer unapproved translation")
    );
    let path = store.directory().to_owned();
    store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .release_artifact_by_path(release, "zh-CN", &metadata.file_name)
            .unwrap()
            .1,
        bytes
    );
    assert_eq!(
        reopened
            .review_target(project, retained, "zh-CN")
            .unwrap()
            .translation_text
            .as_deref(),
        Some("Private newer unapproved translation")
    );
}

#[test]
fn release_report_rejects_rehashed_substitution_and_reserves_safe_output_paths() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let plan = ReleasePlan::from_input(&input).unwrap();
    for path in ["TSUMUGI-RELEASE/LOCALE-1-ZH-CN.JSON", "tsumugi-release"] {
        let mut choices = plan.choices();
        choices[0].output_paths = vec![path.into()];
        assert_eq!(
            store
                .prepare_plugin_build(
                    input.envelope().project_id,
                    ExecutionId::new(),
                    &choices,
                    plan.eligibility_basis(),
                    plan.build_environment()
                )
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let release = release_id(
        &store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
    );
    let (_, bytes) = store
        .release_artifact_by_path(release, "zh-CN", "tsumugi-release/locale-1-zh-CN.json")
        .unwrap();
    let mut report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    report["coverage"]["translations"] = serde_json::json!(999);
    let changed = serde_json::to_vec(&report).unwrap();
    store.connection().unwrap().execute("UPDATE release_artifacts SET bytes=?2,sha256=?3 WHERE release_id=?1 AND file_name='tsumugi-release/locale-1-zh-CN.json'", rusqlite::params![release.to_string(), &changed, codec::digest(&changed)]).unwrap();
    let before = store.connection().unwrap().total_changes();
    assert_eq!(
        store.release_view(release).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(store.connection().unwrap().total_changes(), before);
}

#[test]
fn version_two_reference_release_remains_readable_without_adding_report_files() {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OriginalManifest {
        version: u32,
        input_digest: String,
        result_ids: Vec<ExecutionId>,
        plan: OriginalPlan,
    }
    #[derive(serde::Serialize)]
    #[serde(tag = "kind", content = "data", rename_all = "kebab-case")]
    enum OriginalPlan {
        PluginInput,
    }
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let receipt = store
        .adopt_execution(&action, &ReleaseAdoptionHandler)
        .unwrap();
    let release = release_id(&receipt);
    let bytes = codec::encode(
        &OriginalManifest {
            version: 2,
            input_digest: input.digest().into(),
            result_ids: action.result_ids.clone(),
            plan: OriginalPlan::PluginInput,
        },
        MAX_INPUT_BYTES,
    )
    .unwrap();
    store.connection().unwrap().execute("DELETE FROM release_artifacts WHERE release_id=?1 AND file_name='tsumugi-release/locale-1-zh-CN.json'", [release.to_string()]).unwrap();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE release_records SET manifest=?2,manifest_digest=?3 WHERE release_id=?1",
            rusqlite::params![release.to_string(), &bytes, codec::digest(&bytes)],
        )
        .unwrap();
    let before = store.connection().unwrap().total_changes();
    let view = store.release_view(release).unwrap();
    assert_eq!(view.artifacts.len(), 2);
    assert_eq!(store.connection().unwrap().total_changes(), before);
    let path = store.directory().to_owned();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    assert_eq!(reopened.release_view(release).unwrap(), view);
    assert_eq!(
        reopened
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
        receipt
    );
    let preserved: Vec<u8> = reopened
        .connection()
        .unwrap()
        .query_row(
            "SELECT manifest FROM release_records WHERE release_id=?1",
            [release.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preserved, bytes);
}

#[test]
fn release_report_omits_opaque_settings_and_cannot_steal_component_artifact_identity() {
    let (_directory, mut store, generation, ordinary) = fixture_build(&["zh-CN"]);
    let original = ReleasePlan::from_input(&ordinary).unwrap();
    let mut choices = original.choices();
    choices[0].configuration = vec![
        sdk::EncodedPayload::capture(
            sdk::ContractRef {
                id: "example.private-settings".into(),
                schema_version: 1,
                behavior_version: 1,
            },
            "{\"token\":\"synthetic-private-token\"}".into(),
        )
        .unwrap(),
    ];
    let mut environment = original.build_environment().clone();
    environment.binding.declaration.configuration = None;
    let input = store
        .prepare_plugin_build(
            ordinary.envelope().project_id,
            ExecutionId::new(),
            &choices,
            original.eligibility_basis(),
            &environment,
        )
        .unwrap();
    authorize(&mut store, generation, &input);
    let item = &input.envelope().items[0];
    let request = store
        .dispatch_execution_item(input.envelope().attempt_id, item.item_id)
        .unwrap();
    let build = ReleasePlan::from_input(&input).unwrap()
        .plugin_input(item.scope.locale.as_deref().unwrap()).unwrap();
    let output = sdk::ArtifactSet {
        profile: build.source.profile,
        source_set_id: build.source.source_set_id,
        target_language: build.target_language,
        artifacts: build
            .output_paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                sdk::CapturedArtifact::from_bytes(
                    format!("tsumugi-report-{index}"),
                    path.clone(),
                    "tsumugi-release-report".into(),
                    b"Synthetic domain bytes",
                )
                .unwrap()
            })
            .collect(),
    };
    let result = sdk_result(&request, serde_json::to_value(output).unwrap());
    store.save_execution_result(&result).unwrap();
    prove(&mut store, generation, &input, &result);
    let action = action(&mut store, &input, &[result]);
    let release = release_id(
        &store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap(),
    );
    assert_eq!(store.release_view(release).unwrap().artifacts.len(), 3);
    assert!(
        store.release_artifact(release, "zh-CN").is_err(),
        "component artifacts with a report-like role must remain real domain artifacts"
    );
    for path in &choices[0].output_paths {
        assert_eq!(
            store
                .release_artifact_by_path(release, "zh-CN", path)
                .unwrap()
                .1,
            b"Synthetic domain bytes"
        );
    }
    let (_, bytes) = store
        .release_artifact_by_path(release, "zh-CN", "tsumugi-release/locale-1-zh-CN.json")
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(report["opaqueSettingsOmitted"], true);
    assert_eq!(report["settings"], serde_json::json!([]));
    assert!(report["sourceCapture"].is_null());
    assert!(
        !String::from_utf8(bytes)
            .unwrap()
            .contains("synthetic-private-token")
    );
}

#[test]
fn release_report_preserves_captured_dependencies_counts_and_relative_source_identity() {
    let (_directory, mut store, _generation, input) = fixture_build(&["zh-CN"]);
    let mut plan = ReleasePlan::from_input(&input).unwrap();
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    let output = plan.artifact_set(&result).unwrap();
    let source = plan.source.units[0].occurrences[0].source.clone();
    let original = plan
        .source
        .artifacts
        .iter()
        .find(|artifact| artifact.id() == source.artifact_id)
        .unwrap();
    let expected_path = original.logical_path().to_owned();
    let counts = sdk::SourceCaptureCounts {
        items: 3,
        items_with_fields: 2,
        declared_fields: 4,
        non_empty_fields: 2,
    };
    let summary = sdk::SourceCaptureSummary {
        materials: vec![sdk::SourceCaptureMaterial {
            source: source.clone(),
            counts: counts.clone(),
            properties: vec![
                sdk::SourceCaptureProperty {
                    label: "Dependencies".into(),
                    values: vec!["Base.dat".into()],
                },
                sdk::SourceCaptureProperty {
                    label: "Optional dependencies".into(),
                    values: vec![],
                },
            ],
            groups: vec![sdk::SourceCaptureGroup {
                label: "Captured records".into(),
                counts: counts.clone(),
            }],
        }],
    };
    plan.source.domain_blocks.push(sdk::DomainBlock {
        target: sdk::ContentTarget::Snapshot,
        schema: sdk::source_capture_summary_contract(),
        handling: sdk::ExtensionHandling::Preserve,
        payload_utf8: serde_json::to_string(&summary).unwrap(),
    });
    let (_, bytes) = plan.delivery_report(input.digest(), &output).unwrap();
    let report: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(report["sourceCapture"][0]["input"], expected_path);
    assert_eq!(
        report["sourceCapture"][0]["inputRange"],
        serde_json::to_value(source.range).unwrap()
    );
    assert_eq!(
        report["sourceCapture"][0]["counts"],
        serde_json::to_value(counts).unwrap()
    );
    assert_eq!(
        report["sourceCapture"][0]["properties"],
        serde_json::to_value(&summary.materials[0].properties).unwrap()
    );
    assert_eq!(
        report["sourceCapture"][0]["groups"],
        serde_json::to_value(&summary.materials[0].groups).unwrap()
    );
    assert_eq!(report["coverage"]["units"], 2);
}
