use super::*;
use crate::{SavedArtifactCheckProof, SavedBuildLocale};

fn references(results: &[FixedResult]) -> Vec<ArtifactCheckBuildResultRef> {
    results
        .iter()
        .map(|r| ArtifactCheckBuildResultRef {
            item_id: r.envelope().item_id,
            result_id: r.envelope().result_id,
        })
        .collect()
}

#[test]
fn artifact_workflow_captures_complete_actual_results_without_writes_and_requires_live_producers() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN", "fr-FR"]);
    let results: Vec<_> = input
        .envelope()
        .items
        .iter()
        .map(|i| builder_result(&mut store, &input, i.item_id))
        .collect();
    let project = input.envelope().project_id;
    let attempt = input.envelope().attempt_id;
    let refs = references(&results);
    let changes = store.connection().unwrap().total_changes();
    let sequence = store.execution_sequence().unwrap();
    let captures = store
        .capture_artifact_check_workflow(project, attempt, input.digest(), &refs)
        .unwrap();
    assert_eq!(captures.len(), 2);
    for (capture, result) in captures.iter().zip(&results) {
        assert_eq!(capture.input().bytes(), input.bytes());
        assert_eq!(capture.result().bytes(), result.bytes());
    }
    for bad in [
        vec![],
        refs[..1].to_vec(),
        vec![refs[0].clone(), refs[0].clone()],
    ] {
        assert!(
            store
                .capture_artifact_check_workflow(project, attempt, input.digest(), &bad)
                .is_err()
        );
    }
    assert!(
        store
            .capture_artifact_check_workflow(ExecutionId::new(), attempt, input.digest(), &refs)
            .is_err()
    );
    assert!(
        store
            .capture_artifact_check_workflow(project, attempt, &"a".repeat(64), &refs)
            .is_err()
    );
    let mut wrong = refs.clone();
    wrong[0].result_id = refs[1].result_id;
    assert!(
        store
            .capture_artifact_check_workflow(project, attempt, input.digest(), &wrong)
            .is_err()
    );
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    assert_eq!(store.connection().unwrap().total_changes(), changes);
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
            .capture_artifact_check_workflow(project, attempt, input.digest(), &refs)
            .err()
            .expect("revoked producer")
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .read_saved_plugin_build(project, attempt, false)
            .unwrap()
            .locales
            .len(),
        2
    );
}

#[test]
fn artifact_workflow_reuse_captures_original_producer_and_keeps_exact_historical_proof() {
    let (_directory, mut store, generation, input) =
        fixture_build_policy(&["zh-CN", "fr-FR"], 131072, RecoveryPolicy::ReadOnly);
    let first = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    let original = store
        .capture_artifact_validation(input.envelope().attempt_id, first.envelope().result_id)
        .unwrap();
    let (checked, _) = checker_result(
        &mut store,
        generation,
        &original,
        passing_results(&original),
    );
    store
        .commit_artifact_validation(original.prepare(checked).unwrap())
        .unwrap();
    let retry = store
        .execution_retry_input(
            input.envelope().attempt_id,
            &[input.envelope().items[1].item_id],
        )
        .unwrap();
    authorize_policy(&mut store, generation, &retry, RecoveryPolicy::ReadOnly);
    let second = builder_result(&mut store, &retry, input.envelope().items[1].item_id);
    let refs = references(&[first.clone(), second]);
    let project = input.envelope().project_id;
    let captures = store
        .capture_artifact_check_workflow(
            project,
            retry.envelope().attempt_id,
            retry.digest(),
            &refs,
        )
        .unwrap();
    assert_eq!(
        captures[0].input().envelope().attempt_id,
        input.envelope().attempt_id
    );
    assert_eq!(captures[0].input().digest(), input.digest());
    let next = captures[0]
        .clone()
        .prepare_artifact_check(ExecutionId::new())
        .unwrap();
    assert_eq!(
        store
            .verify_artifact_check_association(
                project,
                retry.envelope().attempt_id,
                retry.digest(),
                &refs[0],
                next.check_input()
            )
            .unwrap(),
        (input.envelope().attempt_id, input.digest().into())
    );
    assert!(
        store
            .verify_artifact_check_association(
                project,
                retry.envelope().attempt_id,
                retry.digest(),
                &refs[1],
                next.check_input()
            )
            .is_err()
    );
    let proof = store
        .read_artifact_check_proof(
            project,
            retry.envelope().attempt_id,
            first.envelope().result_id,
        )
        .unwrap()
        .unwrap();
    assert!(proof.valid);
    assert!(proof.checks.as_ref().is_some_and(|c| !c.is_empty()));
    store
        .revoke_plugin_grant(
            generation,
            first.envelope().plugin.as_ref().unwrap().authorization_id,
        )
        .unwrap();
    assert!(
        store
            .capture_artifact_check_workflow(
                project,
                retry.envelope().attempt_id,
                retry.digest(),
                &refs
            )
            .is_err()
    );
    let directory = store.directory().to_owned();
    drop(store);
    let reopened = ProjectStore::open(directory).unwrap();
    let changes = reopened.connection().unwrap().total_changes();
    assert_eq!(
        reopened
            .read_artifact_check_proof(
                project,
                retry.envelope().attempt_id,
                first.envelope().result_id
            )
            .unwrap(),
        Some(proof)
    );
    assert!(
        reopened
            .capture_artifact_check_workflow(
                project,
                retry.envelope().attempt_id,
                retry.digest(),
                &refs
            )
            .is_err()
    );
    assert_eq!(reopened.connection().unwrap().total_changes(), changes);
}

#[test]
fn artifact_workflow_negative_reports_remain_readable_but_wrong_associations_are_rejected() {
    for variant in 0..3 {
        let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
        let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
        let capture = store
            .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let check_input = capture.check_input();
        authorize(&mut store, generation, check_input);
        let request = store
            .dispatch_execution_item(
                check_input.envelope().attempt_id,
                check_input.envelope().items[0].item_id,
            )
            .unwrap();
        let checked = sdk_result_with_outcome(&request, |invocation| {
            if variant == 2 {
                sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(
                        invocation.output_schema.clone(),
                        "{}".into(),
                    )
                    .unwrap(),
                }
            } else {
                let error =
                    sdk::EncodedPayload::capture(invocation.error_schema.clone(), "{}".into())
                        .unwrap();
                if variant == 0 {
                    sdk::InvocationOutcome::Failed { error }
                } else {
                    sdk::InvocationOutcome::Unknown { error }
                }
            }
        });
        store.save_execution_result(&checked).unwrap();
        let prepared = capture.prepare(checked).unwrap();
        assert!(!prepared.valid());
        store.commit_artifact_validation(prepared).unwrap();
        let project = input.envelope().project_id;
        let attempt = input.envelope().attempt_id;
        let proof = store
            .read_artifact_check_proof(project, attempt, result.envelope().result_id)
            .unwrap()
            .unwrap();
        assert!(!proof.valid);
        assert!(proof.checks.is_none());
        let json = serde_json::to_value(&proof).unwrap();
        assert_eq!(json.get("checks"), Some(&serde_json::Value::Null));
        let mut missing = json;
        missing.as_object_mut().unwrap().remove("checks");
        assert!(serde_json::from_value::<SavedArtifactCheckProof>(missing).is_err());
        let saved = store
            .read_saved_plugin_build(project, attempt, false)
            .unwrap();
        assert_eq!(saved.locales[0].artifact_check.as_ref(), Some(&proof));
        let mut missing = serde_json::to_value(&saved.locales[0]).unwrap();
        missing.as_object_mut().unwrap().remove("artifactCheck");
        assert!(serde_json::from_value::<SavedBuildLocale>(missing).is_err());
        let directory = store.directory().to_owned();
        drop(store);
        let reopened = ProjectStore::open(directory).unwrap();
        assert_eq!(
            reopened
                .read_artifact_check_proof(project, attempt, result.envelope().result_id)
                .unwrap(),
            Some(proof)
        );
        reopened
            .connection()
            .unwrap()
            .execute(
                "UPDATE plugin_validation_links SET valid=1 WHERE producer_result_id=?1",
                [result.envelope().result_id.to_string()],
            )
            .unwrap();
        assert!(
            reopened
                .read_artifact_check_proof(project, attempt, result.envelope().result_id)
                .is_err()
        );
    }
}

#[test]
fn artifact_workflow_first_monotonic_deadline_caps_wall_clock_duration_and_replay() {
    let (_directory, mut store, generation, input) = fixture_build(&["zh-CN"]);
    let result = builder_result(&mut store, &input, input.envelope().items[0].item_id);
    let capture = store
        .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check = capture.check_input();
    let grant = ExecutionId::new();
    let expiry = crate::execution::plugin_authority::plugin_now_ms().unwrap() + 600_000;
    let ceiling = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let consent = PluginConsent {
        unsandboxed_execution: true,
        application_execution: false,
    };
    store
        .authorize_plugin_input_before(
            generation,
            grant,
            check,
            expiry,
            consent,
            None,
            Some(ceiling),
        )
        .unwrap();
    assert_eq!(
        store.plugin_permit(check).unwrap().original_deadline(),
        ceiling
    );
    // A later wall-clock duration (including a rollback) and repeated Start
    // cannot extend the first accepted monotonic ceiling.
    store
        .authorize_plugin_input_before(
            generation,
            grant,
            check,
            expiry,
            consent,
            None,
            Some(ceiling + std::time::Duration::from_secs(300)),
        )
        .unwrap();
    assert_eq!(
        store.plugin_permit(check).unwrap().original_deadline(),
        ceiling
    );
    store.revoke_plugin_grant(generation, grant).unwrap();
    assert!(
        store
            .authorize_plugin_input_before(
                generation,
                grant,
                check,
                expiry,
                consent,
                None,
                Some(ceiling)
            )
            .is_err()
    );
    let other = store
        .capture_artifact_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let before = store.connection().unwrap().total_changes();
    assert!(
        store
            .authorize_plugin_input_before(
                generation,
                ExecutionId::new(),
                other.check_input(),
                expiry,
                consent,
                None,
                Some(std::time::Instant::now() - std::time::Duration::from_secs(1))
            )
            .is_err()
    );
    assert_eq!(store.connection().unwrap().total_changes(), before);
}
