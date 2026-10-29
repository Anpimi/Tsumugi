use super::*;
use crate::content::{SourceAdoptionHandler, SourceRunner};
use crate::execution::ExecutionRuntime;
use crate::persistence::review::tests::{adopt_source, fixture};
use std::{sync::Arc, time::{Duration, Instant}};
use tsumugi_plugin_sdk as sdk;

const MANIFEST: &[u8] =
    br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#;

pub(in crate::persistence) fn extract(store: &mut ProjectStore, manifest: &[u8], bytes: &[u8]) -> (FixedInput, ExecutionId) {
    let bundle = SourceBundle::capture(manifest, bytes, "en").unwrap();
    let input = bundle.fixed_input(store.metadata().unwrap().project_id()).unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(store).unwrap();
        if store.execution_attempt(input.envelope().attempt_id, true).unwrap().items[0].execution
            == ExecutionState::Succeeded
        {
            let result = store.execution_current_result(input.envelope().attempt_id,
                input.envelope().items[0].item_id).unwrap().unwrap();
            return (input, result);
        }
        assert!(Instant::now() < deadline, "source extraction did not finish");
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn pending(store: &ProjectStore, project: ExecutionId, limit: usize) -> (Vec<PendingSourceMapping>, bool) {
    crate::persistence::review::read_snapshot(store.connection().unwrap(), |connection| {
        pending_in(store, connection, project, limit)
    }).unwrap()
}

#[test]
fn pending_rename_keeps_original_result_and_scope_without_allocating_endpoints() {
    let (_directory, mut store, project, _) = fixture();
    let (input, result) = extract(&mut store, MANIFEST,
        br#"{"renamed":"Hello {{name}}","plain":"Plain"}"#);
    let before_scope = store.content_scope().unwrap();
    let writes = store.connection().unwrap().total_changes();
    let (groups, complete) = pending(&store, project, 100);
    assert!(complete);
    assert_eq!(groups.len(), 1);
    let group = &groups[0];
    assert_eq!((group.attempt_id, group.item_id, group.result_id),
        (input.envelope().attempt_id, input.envelope().items[0].item_id, result));
    assert_eq!(group.task_id, input.envelope().task_id);
    assert_eq!(group.scope, before_scope);
    assert_eq!(Some(group.previous_snapshot_id), before_scope.current_snapshot);
    assert_eq!((group.ambiguous_count, group.rename_candidate_count), (0, 1));
    assert_eq!(group.result_digest,
        store.execution_result(input.envelope().attempt_id, result).unwrap().digest());
    assert!(!group.cancellation_requested);
    assert!(group.authorization_current);
    assert_eq!(pending(&store, project, 100), (groups, true));
    assert_eq!(store.connection().unwrap().total_changes(), writes);
    assert_eq!(store.content_scope().unwrap(), before_scope);
}

#[test]
fn multiple_equal_text_predecessors_remain_ambiguous_in_one_result_group() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(directory.path().join("project"),
        crate::ProjectMetadata::create("Ambiguous source", "en", ["zh-CN"]).unwrap()).unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    adopt_source(&mut store, br#"{"old-a":"Same","old-b":"Same"}"#);
    extract(&mut store, MANIFEST, br#"{"new-a":"Same","new-b":"Same"}"#);
    let (groups, complete) = pending(&store, project, 100);
    assert!(complete);
    assert_eq!(groups.len(), 1);
    assert_eq!((groups[0].ambiguous_count, groups[0].rename_candidate_count), (2, 0));
}

#[test]
fn first_import_has_no_mapping_questions_but_changed_native_keys_require_review() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(directory.path().join("project"),
        crate::ProjectMetadata::create("First source", "en", ["zh-CN"]).unwrap()).unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    extract(&mut store, MANIFEST, br#"{"first":"New"}"#);
    assert_eq!(pending(&store, project, 100), (Vec::new(), true));

    let (_directory, mut store, project, _) = fixture();
    extract(&mut store, MANIFEST, br#"{"hello":"Changed","added":"Different"}"#);
    // Valid evidence from a different namespace is incomparable, not corrupt.
    extract(&mut store,
        br#"{"UniqueID":"Other.Test","Name":"Other","Version":"1.0.0","EntryDll":"Other.dll"}"#,
        br#"{"renamed":"Hello {{name}}"}"#);
    let (groups, complete) = pending(&store, project, 100);
    assert!(complete);
    assert_eq!(groups.len(), 1);
    assert_eq!((groups[0].changed_count, groups[0].rename_candidate_count, groups[0].ambiguous_count), (1, 0, 0));
}

#[test]
fn cancellation_preserves_evidence_but_never_restores_the_old_action() {
    let (directory, mut store, project, _) = fixture();
    let (input, result) = extract(&mut store, MANIFEST,
        br#"{"renamed":"Hello {{name}}","plain":"Plain"}"#);
    let comparison = store.source_comparison(input.envelope().attempt_id, result, 0, 100).unwrap();
    let action = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result], serde_json::to_value(comparison.confirmation).unwrap()).unwrap();
    let cancellation = store.cancel_execution(input.envelope().task_id, ExecutionId::new()).unwrap();
    let (groups, complete) = pending(&store, project, 100);
    assert!(complete);
    assert!(groups[0].cancellation_requested);
    assert_eq!(groups[0].cancellation_revision, cancellation);
    assert_eq!(store.adopt_execution(&action, &SourceAdoptionHandler).unwrap_err().code, ErrorCode::Cancelled);
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(pending(&reopened, project, 100), (groups, true));
}

#[test]
fn adopted_receipt_removes_the_pending_result_and_reopen_preserves_that_fact() {
    let (directory, mut store, project, _) = fixture();
    let (input, result) = extract(&mut store, MANIFEST,
        br#"{"renamed":"Hello {{name}}","plain":"Plain"}"#);
    assert_eq!(pending(&store, project, 100).0.len(), 1);
    let comparison = store.source_comparison(input.envelope().attempt_id, result, 0, 100).unwrap();
    let action = store.prepare_adoption(input.envelope().attempt_id, input.envelope().units[0].unit_id,
        vec![result], serde_json::to_value(comparison.confirmation).unwrap()).unwrap();
    store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    assert_eq!(pending(&store, project, 100), (Vec::new(), true));
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(pending(&reopened, project, 100), (Vec::new(), true));
}

#[test]
fn rejected_results_and_superseded_attempts_are_not_pending() {
    let (_directory, mut store, project, _) = fixture();
    let (input, result) = extract(&mut store, MANIFEST,
        br#"{"renamed":"Hello {{name}}","plain":"Plain"}"#);
    store.connection().unwrap().execute("UPDATE execution_items SET adoption='rejected' WHERE attempt_id=?1",
        [input.envelope().attempt_id.to_string()]).unwrap();
    assert_eq!(pending(&store, project, 100), (Vec::new(), true));
    store.connection().unwrap().execute("UPDATE execution_items SET adoption='conflict' WHERE attempt_id=?1",
        [input.envelope().attempt_id.to_string()]).unwrap();
    let original = store.execution_result(input.envelope().attempt_id, result).unwrap();
    // A single-item source attempt cannot continue by reusing every result.
    // Begin a legal retry after a retry-safe failure, then preserve a late
    // corrected success from the original dispatch as evidence only.
    let mut failed = original.envelope().clone();
    failed.result_id = ExecutionId::new();
    failed.supersedes = Some(result);
    failed.outcome = ExecutionState::Failed;
    failed.output = None;
    failed.diagnostic = Some(Diagnostic { code: "temporary".into(), retry_safe: true });
    let failed = FixedResult::capture(failed, &input, original.envelope().dispatch_token).unwrap();
    store.save_execution_result(&failed).unwrap();
    let item = input.envelope().items[0].item_id;
    let next = store.execution_retry_input(input.envelope().attempt_id, &[item]).unwrap();
    store.enqueue_read_only_execution(&next).unwrap();
    let mut late = original.envelope().clone();
    late.result_id = ExecutionId::new();
    late.supersedes = Some(failed.envelope().result_id);
    let late = FixedResult::capture(late, &input, original.envelope().dispatch_token).unwrap();
    store.save_execution_result(&late).unwrap();
    store.validate_execution_result(input.envelope().attempt_id, late.envelope().result_id).unwrap();
    let previous = store.execution_attempt(input.envelope().attempt_id, false).unwrap();
    assert_eq!((previous.items[0].execution, previous.items[0].validation),
        (ExecutionState::Succeeded, ValidationState::Valid));
    assert_eq!(store.execution_current_result(input.envelope().attempt_id, item).unwrap(),
        Some(late.envelope().result_id));
    assert!(store.source_comparison(input.envelope().attempt_id, late.envelope().result_id,
        0, 100).unwrap().rows.iter().any(|row| row.kind == SourceChangeKind::RenameCandidate));
    assert_eq!(store.execution_attempt(next.envelope().attempt_id, false).unwrap().items[0].execution,
        ExecutionState::Queued);
    let (groups, complete) = pending(&store, project, 100);
    assert!(complete);
    assert!(groups.is_empty());
}

#[test]
fn scanning_is_bounded_even_when_the_prefix_has_no_mapping_questions() {
    let (_directory, mut store, project, _) = fixture();
    extract(&mut store, MANIFEST, br#"{"hello":"Hello {{name}}","plain":"Plain","new-a":"New"}"#);
    extract(&mut store, MANIFEST, br#"{"hello":"Hello {{name}}","plain":"Plain","new-b":"New"}"#);
    assert_eq!(pending(&store, project, 1), (Vec::new(), false));
    assert_eq!(pending(&store, project, 2), (Vec::new(), true));
    assert_eq!(pending(&store, project, 0), (Vec::new(), false));
}

#[test]
fn candidate_order_and_truncation_use_original_result_identities() {
    let (_directory, mut store, project, _) = fixture();
    for key in ["new-a", "new-b", "new-c"] {
        extract(&mut store, MANIFEST,
            &serde_json::to_vec(&serde_json::json!({key: "Hello {{name}}", "plain": "Plain"})).unwrap());
    }
    let (groups, complete) = pending(&store, project, 3);
    assert!(complete);
    assert_eq!(groups.len(), 3);
    let identities = groups.iter().map(|group| (group.attempt_id, group.item_id, group.result_id))
        .collect::<Vec<_>>();
    assert!(identities.windows(2).all(|window| window[0] < window[1]));
    assert_eq!(pending(&store, project, 1), (groups[..1].to_vec(), false));
}

#[test]
fn damaged_input_result_and_capture_are_errors_instead_of_empty_coverage() {
    for damage in ["input", "result", "capture"] {
        let (_directory, mut store, project, _) = fixture();
        let (input, result) = extract(&mut store, MANIFEST,
            br#"{"renamed":"Hello {{name}}","plain":"Plain"}"#);
        match damage {
            "input" => {
                store.connection().unwrap().execute(
                    "UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1",
                    params![input.envelope().attempt_id.to_string(), "0".repeat(64)]).unwrap();
            }
            "result" => {
                store.connection().unwrap().execute("UPDATE execution_results SET digest=?2 WHERE result_id=?1",
                    params![result.to_string(), "0".repeat(64)]).unwrap();
            }
            _ => {
                store.connection().unwrap().execute("UPDATE source_sets SET digest=?2 WHERE set_id=?1",
                    params![SourceBundle::from_input(&input).unwrap().set_id.to_string(), "0".repeat(64)]).unwrap();
            }
        }
        assert!(crate::persistence::review::read_snapshot(store.connection().unwrap(), |connection| {
            pending_in(&store, connection, project, 100)
        }).is_err(), "{damage} was silently treated as empty");
    }
}

pub(in crate::persistence) struct PluginFixture {
    pub directory: tempfile::TempDir,
    pub store: ProjectStore,
    pub project: ExecutionId,
    pub generation: ExecutionId,
    pub input: FixedInput,
    pub result: ExecutionId,
    pub check_input: FixedInput,
    pub producer_grant: ExecutionId,
    pub checker_grant: ExecutionId,
}

/// Receive a synthetic domain response through the actual grant, dispatch and
/// result ledger boundaries. This creates no worker or external process.
pub(in crate::persistence) fn save_plugin_result(
    store: &mut ProjectStore,
    generation: ExecutionId,
    input: &FixedInput,
    output: serde_json::Value,
) -> (ExecutionId, FixedResult) {
    let grant = ExecutionId::new();
    let expires = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap().as_millis() as u64 + 60_000;
    store.authorize_plugin_input(generation, grant, input, expires,
        PluginConsent { unsandboxed_execution: true, application_execution: false }, None).unwrap();
    store.enqueue_read_only_execution(input).unwrap();
    let item = input.envelope().items[0].item_id;
    let request = store.dispatch_execution_item(input.envelope().attempt_id, item).unwrap();
    let provider = &input.envelope().plugin.as_ref().unwrap().capability.provider;
    let channel = sdk::ProviderBinding {
        plugin: provider.plugin.clone(), component_id: provider.component_id.clone(),
        contribution_id: provider.contribution_id.clone(), package_digest: provider.package_digest.clone(),
        instance_id: ExecutionId::new().to_string(), activation_generation: 1,
    };
    let invocation = input.plugin_request(item, request.dispatch_token, &channel).unwrap();
    let result = FixedResult::capture_plugin(input, item, request.dispatch_token, PluginResultEvidence {
        authorization_id: grant, channel: channel.clone(),
        result: sdk::InvocationResult {
            context: invocation.context, provider: channel, capability: invocation.capability,
            profile: invocation.profile, result_id: ExecutionId::new().to_string(),
            outcome: sdk::InvocationOutcome::Succeeded {
                output: sdk::EncodedPayload::capture(invocation.output_schema,
                    serde_json::to_string(&output).unwrap()).unwrap(),
            },
        },
    }).unwrap();
    store.save_execution_result(&result).unwrap();
    (grant, result)
}

pub(in crate::persistence) fn plugin_fixture() -> PluginFixture {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(directory.path().join("project"),
        crate::ProjectMetadata::create("Plugin mapping", "en", ["zh-CN"]).unwrap()).unwrap();
    crate::content::tests::adopt_shared_source_fixture(&mut store);
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let (_, (original, _, output, _)) = snapshot_rows(store.connection().unwrap(), snapshot, true).unwrap();
    // A new extraction of the same frozen synthetic material has its own task
    // and result. Its independently checked proposal changes one native key.
    let mut envelope = original.envelope().clone();
    envelope.task_id = ExecutionId::new();
    envelope.attempt_id = ExecutionId::new();
    let input = FixedInput::capture(envelope).unwrap();
    let mut proposal = output.exchange;
    let renamed = proposal.units.iter_mut().find(|unit| unit.text == "Case-sensitive").unwrap();
    let native = renamed.occurrences[0].native_identity.as_mut().unwrap();
    native.value = "RenamedCase".into();
    native.display.value = "Renamed case".into();
    let generation = ExecutionId::new();
    store.begin_plugin_epoch(generation).unwrap();
    let (producer_grant, result) = save_plugin_result(&mut store, generation, &input,
        serde_json::to_value(proposal).unwrap());
    let capture = store.capture_source_validation(input.envelope().attempt_id,
        result.envelope().result_id).unwrap();
    let check_input = capture.check_input().clone();
    let check: sdk::SourceExtractionCheckInput =
        serde_json::from_value(check_input.envelope().items[0].payload.clone()).unwrap();
    check.validate().unwrap();
    let checks = check.requirements.into_iter().map(|required| sdk::CheckResult {
        key: required.key, input_digest: required.input_digest, scope_digest: required.scope_digest,
        covered_targets: required.targets, outcome: sdk::CheckOutcome::Completed { findings: vec![] },
    }).collect::<Vec<_>>();
    let (checker_grant, checked) = save_plugin_result(&mut store, generation, &check_input,
        serde_json::to_value(checks).unwrap());
    store.commit_source_validation(capture.prepare(checked).unwrap()).unwrap();
    PluginFixture { directory, store, project, generation, input,
        result: result.envelope().result_id, check_input, producer_grant, checker_grant }
}

pub(in crate::persistence) fn plugin_mapping_fixture() -> (tempfile::TempDir, ProjectStore, ExecutionId) {
    let fixture = plugin_fixture();
    (fixture.directory, fixture.store, fixture.project)
}

#[test]
fn either_original_plugin_grant_can_make_mapping_evidence_stale_without_hiding_it() {
    for checker in [false, true] {
        let mut fixture = plugin_fixture();
        let (before, complete) = pending(&fixture.store, fixture.project, 100);
        assert!(complete);
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].rename_candidate_count, 1);
        assert!(before[0].authorization_current);
        let grant = if checker { fixture.checker_grant } else { fixture.producer_grant };
        fixture.store.revoke_plugin_grants(fixture.generation, &[grant]).unwrap();
        let writes = fixture.store.connection().unwrap().total_changes();
        let (mut after, complete) = pending(&fixture.store, fixture.project, 100);
        assert!(complete);
        assert!(!after[0].authorization_current);
        after[0].authorization_current = true;
        assert_eq!(after, before);
        assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
        if checker {
            assert!(input_authorization_current(&fixture.store, fixture.store.connection().unwrap(),
                &fixture.input).unwrap(), "producer still has its independent original grant");
        }
    }
}

#[test]
fn producer_and_checker_cancellation_preserve_stale_plugin_comparison_evidence() {
    for checker in [false, true] {
        let mut fixture = plugin_fixture();
        let task = if checker { fixture.check_input.envelope().task_id } else { fixture.input.envelope().task_id };
        let revision = fixture.store.cancel_execution(task, ExecutionId::new()).unwrap();
        let (groups, complete) = pending(&fixture.store, fixture.project, 100);
        assert!(complete);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].result_id, fixture.result);
        assert!(!groups[0].authorization_current);
        assert_eq!(groups[0].cancellation_requested, !checker);
        if !checker { assert_eq!(groups[0].cancellation_revision, revision); }
        let writes = fixture.store.connection().unwrap().total_changes();
        assert_eq!(pending(&fixture.store, fixture.project, 100), (groups, true));
        assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
    }
}

#[test]
fn new_plugin_generation_does_not_restore_original_source_or_checker_authority() {
    let fixture = plugin_fixture();
    let (mut expected, complete) = pending(&fixture.store, fixture.project, 100);
    assert!(complete && expected[0].authorization_current);
    fixture.store.begin_plugin_epoch(ExecutionId::new()).unwrap();
    let writes = fixture.store.connection().unwrap().total_changes();
    expected[0].authorization_current = false;
    assert_eq!(pending(&fixture.store, fixture.project, 100), (expected, true));
    for input in [&fixture.input, &fixture.check_input] {
        assert_eq!(crate::persistence::plugin_execution::check_input_in(
            fixture.store.connection().unwrap(), input, &fixture.store.plugin_authority,
        ).unwrap_err().code, ErrorCode::Unauthorized);
    }
    assert_eq!(fixture.store.connection().unwrap().total_changes(), writes);
}

#[test]
fn reopening_keeps_plugin_mapping_identity_and_proof_without_reconstructing_live_grants() {
    let fixture = plugin_fixture();
    let (mut expected, complete) = pending(&fixture.store, fixture.project, 100);
    assert!(complete && expected[0].authorization_current);
    let path = fixture.directory.path().join("project");
    let project = fixture.project;
    drop(fixture.store);
    let reopened = ProjectStore::open(path).unwrap();
    let writes = reopened.connection().unwrap().total_changes();
    expected[0].authorization_current = false;
    assert_eq!(pending(&reopened, project, 100), (expected, true));
    assert_eq!(reopened.connection().unwrap().total_changes(), writes);
}
