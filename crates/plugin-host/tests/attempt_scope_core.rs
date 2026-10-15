#![cfg(all(unix, feature = "core-adapter", feature = "conformance-worker"))]
//! Real process results, durable scope binding and original Core authority.
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{ProjectMetadata, ProjectStore, execution::*};
use tsumugi_plugin_host::{core::RunnerProxy, *};
use tsumugi_plugin_sdk as sdk;

fn proxy(stage: &Path) -> Arc<RunnerProxy> {
    let contract = |id: &str| json!({"id":id,"schemaVersion":1,"behaviorVersion":1});
    let manifest = serde_json::to_vec(&json!({
        "protocolVersion":sdk::MANIFEST_PROTOCOL,
        "plugin":{"publisher":"example","id":"example.attempt","version":"0.1.0"},
        "permissions":[{"kind":"captured-input"}],
        "components":[{"id":"worker","scope":"attempt","runtime":"native-worker","entrypoint":"bin/worker","dependencies":[],"exit":{"stopTimeoutMs":300,"cleanupTimeoutMs":1000}}],
        "contributions":[{"id":"echo","componentId":"worker","contribution":{"kind":"capability","declaration":{
            "contract":contract("example.echo"),"inputSchema":contract("example.input"),"outputSchema":contract("example.output"),"errorSchema":contract("example.error"),
            "profiles":[],"effect":"read-only","permissions":[{"kind":"captured-input"}],
            "limits":{"maxInputBytes":65536,"maxOutputBytes":65536,"concurrency":1,"timeoutMs":2000}
        }}}]
    })).unwrap();
    let files = BTreeMap::from([
        (
            "bin/worker".into(),
            PackageFile {
                bytes: std::fs::read(env!("CARGO_BIN_EXE_tsumugi-process-conformance-worker"))
                    .unwrap(),
                executable: true,
            },
        ),
        (
            "behavior.txt".into(),
            PackageFile {
                bytes: b"core-echo".to_vec(),
                executable: false,
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let image = PackageImage::capture(manifest, files, &digest).unwrap();
    let runtime =
        CapturedNativeRuntime::capture(&CapturedNativeRuntime::inspect_current().unwrap()).unwrap();
    Arc::new(RunnerProxy::new(image, "echo", runtime, stage, HostLimits::default()).unwrap())
}
fn store(root: &Path) -> ProjectStore {
    ProjectStore::create(
        root.join("project"),
        ProjectMetadata::create("Synthetic attempts", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap()
}
fn input(store: &ProjectStore, runner: &RunnerProxy) -> FixedInput {
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "attempt-echo",
        runner.capability_id(),
        runner.capability_version(),
        vec![InputItem::new(
            Scope {
                kind: "synthetic".into(),
                id: "echo".into(),
                locale: None,
            },
            json!({"text":"👩🏽‍💻 é\r\n"}),
            vec![],
        )],
    )
    .unwrap();
    envelope.plugin = Some(runner.execution_binding(None).unwrap());
    FixedInput::capture(envelope).unwrap()
}
fn authorize(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> ExecutionId {
    let grant = ExecutionId::new();
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    runtime
        .authorize_plugin(
            store,
            grant,
            input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: false,
            },
        )
        .unwrap();
    grant
}
fn finish(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        runtime.tick(store).unwrap();
        let state = store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap();
        if !runtime.is_active(input.envelope().attempt_id)
            && state.items.iter().all(|item| {
                !matches!(
                    item.execution,
                    ExecutionState::Queued | ExecutionState::Dispatched
                )
            })
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "attempt process completion deadline: {state:?}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn attempts_share_a_proxy_without_sharing_scope_or_restoring_authority_on_reopen() {
    let a_root = tempfile::tempdir().unwrap();
    let b_root = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let runner = proxy(stage.path());
    let mut a = store(a_root.path());
    let mut b = store(b_root.path());
    let mut a_runtime = ExecutionRuntime::new(&a).unwrap();
    let mut b_runtime = ExecutionRuntime::new(&b).unwrap();
    a_runtime.register(runner.clone()).unwrap();
    b_runtime.register(runner.clone()).unwrap();
    let a_inputs = [input(&a, &runner), input(&a, &runner)];
    let b_input = input(&b, &runner);
    let mut instances = std::collections::BTreeSet::new();
    let mut saved = Vec::new();
    for fixed in &a_inputs {
        let grant = authorize(&a_runtime, &mut a, fixed);
        a_runtime.submit(&mut a, fixed).unwrap();
        finish(&mut a_runtime, &mut a, fixed);
        let id = a
            .execution_current_result(
                fixed.envelope().attempt_id,
                fixed.envelope().items[0].item_id,
            )
            .unwrap()
            .unwrap();
        let result = a.execution_result(fixed.envelope().attempt_id, id).unwrap();
        assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
        let evidence = result.envelope().plugin.as_ref().unwrap();
        assert_eq!(
            evidence.result.context.scope_id,
            fixed.envelope().attempt_id.to_string()
        );
        assert_eq!(
            evidence.result.context.project_id,
            fixed.envelope().project_id.to_string()
        );
        assert_eq!(evidence.authorization_id, grant);
        assert!(instances.insert(evidence.channel.instance_id.clone()));
        let mut wrong_scope = evidence.clone();
        wrong_scope.result.context.scope_id = fixed.envelope().project_id.to_string();
        assert!(
            FixedResult::capture_plugin(
                fixed,
                fixed.envelope().items[0].item_id,
                result.envelope().dispatch_token,
                wrong_scope
            )
            .is_err()
        );
        let mut missing = serde_json::to_value(fixed.envelope().plugin.as_ref().unwrap()).unwrap();
        missing.as_object_mut().unwrap().remove("componentScope");
        assert!(serde_json::from_value::<PluginExecutionBinding>(missing).is_err());
        saved.push((id, result.bytes().to_vec()));
        a_runtime.revoke_plugin(&mut a, grant).unwrap();
    }
    authorize(&b_runtime, &mut b, &b_input);
    b_runtime.submit(&mut b, &b_input).unwrap();
    finish(&mut b_runtime, &mut b, &b_input);
    let id = b
        .execution_current_result(
            b_input.envelope().attempt_id,
            b_input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let result = b
        .execution_result(b_input.envelope().attempt_id, id)
        .unwrap();
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    assert!(
        instances.insert(
            result
                .envelope()
                .plugin
                .as_ref()
                .unwrap()
                .channel
                .instance_id
                .clone()
        )
    );
    assert_eq!(
        result
            .envelope()
            .plugin
            .as_ref()
            .unwrap()
            .result
            .context
            .scope_id,
        b_input.envelope().attempt_id.to_string()
    );
    assert!(
        a.execution_result(b_input.envelope().attempt_id, id)
            .is_err()
    );
    drop(a_runtime);
    a.close().unwrap();
    let mut reopened = ProjectStore::open(a_root.path().join("project")).unwrap();
    let mut fresh = ExecutionRuntime::new(&reopened).unwrap();
    fresh.register(runner).unwrap();
    for (fixed, (id, bytes)) in a_inputs.iter().zip(&saved) {
        assert_eq!(
            reopened
                .execution_result(fixed.envelope().attempt_id, *id)
                .unwrap()
                .bytes(),
            bytes.as_slice()
        );
        assert_eq!(
            fresh.submit(&mut reopened, fixed).unwrap_err().code,
            ErrorCode::Unauthorized
        );
    }
    drop(fresh);
    reopened.close().unwrap();
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
}

#[test]
fn attempt_scope_is_in_the_original_grant_and_cancelled_inputs_do_not_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let runner = proxy(stage.path());
    let mut store = store(directory.path());
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(runner.clone()).unwrap();
    let fixed = input(&store, &runner);
    authorize(&runtime, &mut store, &fixed);
    let mut changed = fixed.envelope().clone();
    changed.plugin.as_mut().unwrap().component_scope = sdk::ComponentScope::Project;
    assert_eq!(
        runtime
            .submit(&mut store, &FixedInput::capture(changed).unwrap())
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    runtime.submit(&mut store, &fixed).unwrap();
    store
        .cancel_execution(fixed.envelope().task_id, ExecutionId::new())
        .unwrap();
    finish(&mut runtime, &mut store, &fixed);
    assert!(
        store
            .execution_current_result(
                fixed.envelope().attempt_id,
                fixed.envelope().items[0].item_id
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let mut fresh = ExecutionRuntime::new(&reopened).unwrap();
    fresh.register(runner).unwrap();
    assert!(fresh.submit(&mut reopened, &fixed).is_err());
}
