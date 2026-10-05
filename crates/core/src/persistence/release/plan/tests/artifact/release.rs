//! Real SQLite adoption and delivery records; process outcomes are synthetic.
use super::*;
use crate::{DeliveryFileState, DeliveryState, ReleaseAdoptionHandler};

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
    let (query, update, id) = if result {
        (
            "SELECT bytes FROM execution_results WHERE result_id=?1",
            "UPDATE execution_results SET bytes=?2,digest=?3 WHERE result_id=?1",
            plan.source_result_id,
        )
    } else {
        (
            "SELECT input FROM execution_attempts WHERE attempt_id=?1",
            "UPDATE execution_attempts SET input=?2,digest=?3 WHERE attempt_id=?1",
            plan.source_attempt_id,
        )
    };
    let mut bytes: Vec<u8> = connection
        .query_row(query, [id.to_string()], |r| r.get(0))
        .unwrap();
    bytes.push(b' '); // Structurally equivalent JSON still changes the frozen raw digest.
    connection
        .execute(
            update,
            rusqlite::params![id.to_string(), &bytes, codec::digest(&bytes)],
        )
        .unwrap();
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
    let receipt = store.commit_execution_adoption(prepared).unwrap();
    let release = release_id(&receipt);
    let view = store.release_view(release).unwrap();
    assert_eq!(view.artifacts.len(), 4);
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
        assert!(bytes.starts_with(&[0xef, 0xbb, 0xbf]) && bytes.ends_with(b"\r\n"));
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
    let pending = store
        .begin_delivery(delivery_action, release, "isolated-destination", false)
        .unwrap();
    assert_eq!(pending.files.len(), 4);
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
        4
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
    for damage in 0..12 {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
        prove(&mut store, generation, &input, &result);
        let action = action(&mut store, &input, &[result.clone()]);
        let receipt = store
            .adopt_execution(&action, &ReleaseAdoptionHandler)
            .unwrap();
        let release = release_id(&receipt);
        let path = store.directory().to_owned();
        let connection = store.connection().unwrap();
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
                4
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
                4
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
    let (_directory, mut store, generation, input) =
        fixture_build_limit(&["zh-CN"], sdk::MAX_EXCHANGE_BYTES as u32);
    let item = input.envelope().items[0].item_id;
    let request = store
        .dispatch_execution_item(input.envelope().attempt_id, item)
        .unwrap();
    let build: sdk::BuildInput =
        serde_json::from_value(input.item(item).unwrap().payload.clone()).unwrap();
    let large = "A".repeat(1024 * 1024 + 17);
    let output = sdk::ArtifactSet {
        profile: build.source.profile,
        source_set_id: build.source.source_set_id,
        target_language: build.target_language,
        artifacts: vec![
            sdk::CapturedTextArtifact {
                id: "empty".into(),
                logical_path: build.output_paths[0].clone(),
                role: "empty".into(),
                sha256: codec::digest(b""),
                utf8: String::new(),
            },
            sdk::CapturedTextArtifact {
                id: "large".into(),
                logical_path: build.output_paths[1].clone(),
                role: "locale".into(),
                sha256: codec::digest(large.as_bytes()),
                utf8: large.clone(),
            },
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
        large.as_bytes()
    );
    let path = store.directory().to_owned();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(reopened.release_view(id).unwrap().artifacts.len(), 2);
    assert_eq!(
        reopened
            .release_artifact_by_path(id, "zh-CN", "zh-CN/second.txt")
            .unwrap()
            .1,
        large.as_bytes()
    );
}
