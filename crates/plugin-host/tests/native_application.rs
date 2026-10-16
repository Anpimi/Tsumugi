#![cfg(all(unix, feature = "core-adapter"))]
//! Real SDK client processes through the production Native/Core application
//! lifetime. Synthetic data is not domain, GUI or platform acceptance.
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{ProjectMetadata, ProjectStore, execution::*};
use tsumugi_plugin_host::{
    CapturedNativeRuntime, HostLimits, PackageImage,
    core::{ApplicationInstance, RunnerProxy},
};
use tsumugi_plugin_sdk as sdk;
#[path = "support/native.rs"]
mod native;

fn runtime() -> CapturedNativeRuntime {
    let actual = CapturedNativeRuntime::inspect_current().unwrap();
    CapturedNativeRuntime::capture(&actual).unwrap()
}
fn reserve(image: PackageImage, stage: &Path, limits: HostLimits) -> Arc<ApplicationInstance> {
    ApplicationInstance::reserve(
        image,
        "echo-tool",
        runtime().into(),
        stage.to_owned(),
        limits,
    )
    .unwrap()
}
fn store(root: &Path) -> ProjectStore {
    ProjectStore::create(
        root.join("project"),
        ProjectMetadata::create("Synthetic native application", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap()
}
fn input(store: &ProjectStore, proxy: &RunnerProxy, text: &str) -> FixedInput {
    let item = InputItem::new(
        Scope {
            kind: "synthetic".into(),
            id: "reference".into(),
            locale: None,
        },
        json!({"text":text,"results":[{"entries":[]}]}),
        vec![],
    );
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "native-application-query",
        proxy.capability_id(),
        proxy.capability_version(),
        vec![item],
    )
    .unwrap();
    envelope.plugin = Some(proxy.execution_binding(None).unwrap());
    FixedInput::capture(envelope).unwrap()
}
fn expiry() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000
}
fn authorize(
    runtime: &ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
    lease: &ApplicationExecutionLease,
    lifetime_consent: bool,
) -> ExecutionId {
    let grant = ExecutionId::new();
    runtime
        .authorize_application_plugin(
            store,
            grant,
            input,
            expiry(),
            PluginConsent {
                unsandboxed_execution: true,
                application_execution: lifetime_consent,
            },
            lease,
        )
        .unwrap();
    grant
}
fn finish(runtime: &mut ExecutionRuntime, store: &mut ProjectStore, input: &FixedInput) {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        runtime.tick(store).unwrap();
        let view = store
            .execution_attempt(
                input.envelope().attempt_id,
                runtime.is_active(input.envelope().attempt_id),
            )
            .unwrap();
        if !runtime.is_active(input.envelope().attempt_id)
            && view.items.iter().all(|item| {
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
            "native application call did not settle: {view:?}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}
fn execute(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> FixedResult {
    runtime.submit(store, input).unwrap();
    finish(runtime, store, input);
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .expect("actual SDK output");
    let result = store
        .execution_result(input.envelope().attempt_id, result)
        .unwrap();
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    result
}
fn observed(result: &FixedResult) -> (u32, u64) {
    let output = result.envelope().output.as_ref().unwrap();
    let pid: u32 = output["workerPid"].as_u64().unwrap().try_into().unwrap();
    assert!(pid > 0);
    (pid, output["invocationCount"].as_u64().unwrap())
}
fn assert_alive(pid: u32) {
    // Signal zero observes only this fixture-owned child; it sends no signal.
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
}
fn drain(instance: &ApplicationInstance, pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !instance.drained() {
        assert!(
            Instant::now() < deadline,
            "native application cleanup did not drain"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(instance.is_stopped());
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[test]
#[ignore = "requires the independently built Host native-application-worker fixture"]
fn native_application_reuses_one_process_across_projects_with_exact_grants_and_history() {
    let image = native::application_image();
    let stage = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let instance = reserve(image.clone(), stage.path(), HostLimits::default());
    assert!(!instance.is_authorized());
    assert!(
        instance
            .authorize(ExecutionId::new(), false, Cancellation::default())
            .is_err()
    );
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    let lease = instance
        .authorize(ExecutionId::new(), true, Cancellation::default())
        .unwrap();
    let runner = instance.runner("echo").unwrap();
    let mut first = store(a.path());
    let mut first_runtime = ExecutionRuntime::new(&first).unwrap();
    first_runtime.register(runner.clone()).unwrap();
    let first_input = input(&first, &runner, "\u{feff}中文\r\n👩🏽‍💻 e\u{301}");
    assert!(
        first_runtime
            .authorize_plugin(
                &mut first,
                ExecutionId::new(),
                &first_input,
                expiry(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                }
            )
            .is_err()
    );
    let first_grant = authorize(&first_runtime, &mut first, &first_input, &lease, true);
    let first_result = execute(&mut first_runtime, &mut first, &first_input);
    let (pid, count) = observed(&first_result);
    assert_eq!(count, 1);
    assert_alive(pid);
    let evidence_a = first_result.envelope().plugin.as_ref().unwrap();
    assert_eq!(evidence_a.authorization_id, first_grant);
    assert_eq!(
        evidence_a.channel.instance_id,
        instance.basis().instance_id.to_string()
    );
    assert_eq!(
        evidence_a.result.context.project_id,
        first_input.envelope().project_id.to_string()
    );
    assert_eq!(
        evidence_a.result.context.scope_id,
        instance.basis().instance_id.to_string()
    );
    assert_eq!(
        first_result.envelope().output.as_ref().unwrap()["text"],
        first_input.envelope().items[0].payload["text"]
    );
    let first_path = first.directory().to_owned();
    drop(first_runtime);
    drop(first);
    assert!(instance.is_authorized());
    assert_alive(pid);
    let mut second = store(b.path());
    let mut second_runtime = ExecutionRuntime::new(&second).unwrap();
    second_runtime.register(runner.clone()).unwrap();
    assert!(
        second_runtime
            .authorize_application_plugin(
                &mut second,
                ExecutionId::new(),
                &first_input,
                expiry(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                },
                &lease
            )
            .is_err()
    );
    let second_input = input(&second, &runner, "other project");
    let second_grant = authorize(&second_runtime, &mut second, &second_input, &lease, false);
    let second_result = execute(&mut second_runtime, &mut second, &second_input);
    assert_eq!(observed(&second_result), (pid, 2));
    let evidence_b = second_result.envelope().plugin.as_ref().unwrap();
    assert_ne!(first_grant, second_grant);
    assert_eq!(evidence_b.authorization_id, second_grant);
    assert_eq!(evidence_a.channel, evidence_b.channel);
    assert_ne!(
        evidence_a.result.context.project_id,
        evidence_b.result.context.project_id
    );
    let reopened = ProjectStore::open(first_path).unwrap();
    assert_eq!(
        reopened
            .execution_result(
                first_input.envelope().attempt_id,
                first_result.envelope().result_id
            )
            .unwrap()
            .bytes(),
        first_result.bytes()
    );
    assert_eq!(
        reopened
            .execution_dispatch(
                first_input.envelope().attempt_id,
                first_input.envelope().items[0].item_id
            )
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_alive(pid);
    // A real channel/result cannot turn a different project's grant into this
    // attempt's authority, even when the shared component identity matches.
    let forgery_input = input(&second, &runner, "forged grant");
    authorize(&second_runtime, &mut second, &forgery_input, &lease, false);
    second_runtime.submit(&mut second, &forgery_input).unwrap();
    let item = forgery_input.envelope().items[0].item_id;
    let dispatched = second
        .dispatch_execution_item(forgery_input.envelope().attempt_id, item)
        .unwrap();
    let invocation = forgery_input
        .plugin_request(item, dispatched.dispatch_token, &evidence_b.channel)
        .unwrap();
    let forged = FixedResult::capture_plugin(
        &forgery_input,
        item,
        dispatched.dispatch_token,
        PluginResultEvidence {
            authorization_id: first_grant,
            channel: evidence_b.channel.clone(),
            result: sdk::InvocationResult {
                context: invocation.context,
                provider: evidence_b.channel.clone(),
                capability: invocation.capability,
                profile: invocation.profile,
                result_id: ExecutionId::new().to_string(),
                outcome: sdk::InvocationOutcome::Succeeded {
                    output: sdk::EncodedPayload::capture(invocation.output_schema, "{}".into())
                        .unwrap(),
                },
            },
        },
    )
    .unwrap();
    assert_eq!(
        second.save_execution_result(&forged).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    instance.stop();
    drain(&instance, pid);
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    assert!(!lease.is_live());
}

#[test]
#[ignore = "requires the independently built Host native-application-worker fixture"]
fn native_application_retires_exact_instance_on_stop_withdrawal_and_cumulative_limit() {
    for mode in ["stop", "withdraw", "limit"] {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let image = native::application_image();
        let instance = reserve(
            image.clone(),
            stage.path(),
            HostLimits {
                max_invocations: 2,
                ..HostLimits::default()
            },
        );
        let settings = Cancellation::default();
        let lease = instance
            .authorize(ExecutionId::new(), true, settings.clone())
            .unwrap();
        let runner = instance.runner("echo").unwrap();
        let mut store = store(root.path());
        let mut runtime = ExecutionRuntime::new(&store).unwrap();
        runtime.register(runner.clone()).unwrap();
        let first = input(&store, &runner, mode);
        authorize(&runtime, &mut store, &first, &lease, true);
        let result = execute(&mut runtime, &mut store, &first);
        let (pid, _) = observed(&result);
        match mode {
            "stop" => instance.stop(),
            "withdraw" => settings.request(),
            _ => {
                let second = input(&store, &runner, "within limit");
                authorize(&runtime, &mut store, &second, &lease, false);
                assert_eq!(
                    observed(&execute(&mut runtime, &mut store, &second)),
                    (pid, 2)
                );
                let third = input(&store, &runner, "exhausted");
                authorize(&runtime, &mut store, &third, &lease, false);
                runtime.submit(&mut store, &third).unwrap();
                finish(&mut runtime, &mut store, &third);
                assert_ne!(
                    store
                        .execution_attempt(third.envelope().attempt_id, false)
                        .unwrap()
                        .items[0]
                        .execution,
                    ExecutionState::Succeeded
                );
            }
        }
        drain(&instance, pid);
        assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
        assert!(!lease.is_live());
        let late = input(&store, &runner, "old activation");
        assert!(
            runtime
                .authorize_application_plugin(
                    &mut store,
                    ExecutionId::new(),
                    &late,
                    expiry(),
                    PluginConsent {
                        unsandboxed_execution: true,
                        application_execution: false
                    },
                    &lease
                )
                .is_err()
        );
        let replacement = reserve(image, stage.path(), HostLimits::default());
        assert_ne!(instance.basis(), replacement.basis());
        let new_runner = replacement.runner("echo").unwrap();
        runtime.register(new_runner.clone()).unwrap();
        let new_lease = replacement
            .authorize(ExecutionId::new(), true, Cancellation::default())
            .unwrap();
        instance.stop();
        assert!(instance.drained());
        let next = input(&store, &new_runner, "new explicit activation");
        authorize(&runtime, &mut store, &next, &new_lease, true);
        let next = execute(&mut runtime, &mut store, &next);
        let (new_pid, new_count) = observed(&next);
        assert_eq!(new_count, 1);
        assert_eq!(
            next.envelope().plugin.as_ref().unwrap().channel.instance_id,
            replacement.basis().instance_id.to_string()
        );
        assert!(replacement.is_authorized());
        replacement.stop();
        drain(&replacement, new_pid);
    }
}

#[test]
#[ignore = "requires the independently built Host native-application-worker fixture"]
fn native_application_cancel_after_actual_invoke_retires_and_reaps_without_result() {
    let root = tempfile::tempdir().unwrap();
    let stage = tempfile::tempdir().unwrap();
    let observer = root.path().join("entered.json");
    let instance = reserve(
        native::application_image(),
        stage.path(),
        HostLimits::default(),
    );
    let lease = instance
        .authorize(ExecutionId::new(), true, Cancellation::default())
        .unwrap();
    let runner = instance.runner("echo").unwrap();
    let mut store = store(root.path());
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(runner.clone()).unwrap();
    let first = input(&store, &runner, "warm");
    authorize(&runtime, &mut store, &first, &lease, true);
    let first = execute(&mut runtime, &mut store, &first);
    let (pid, _) = observed(&first);
    let mut envelope = input(&store, &runner, "cancel inside the actual fixture")
        .envelope()
        .clone();
    envelope.items[0].payload["cancelObserver"] = json!(observer);
    let waiting = FixedInput::capture(envelope).unwrap();
    authorize(&runtime, &mut store, &waiting, &lease, false);
    runtime.submit(&mut store, &waiting).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        runtime.tick(&mut store).unwrap();
        if let Ok(bytes) = std::fs::read(&observer) {
            if let Ok(observed) = serde_json::from_slice::<Value>(&bytes) {
                assert_eq!(observed["phase"], "entered");
                assert_eq!(observed["workerPid"], pid);
                break;
            }
        }
        assert!(
            Instant::now() < deadline,
            "actual native invocation did not enter"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    runtime
        .cancel(&mut store, waiting.envelope().task_id, ExecutionId::new())
        .unwrap();
    finish(&mut runtime, &mut store, &waiting);
    drain(&instance, pid);
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    assert!(!lease.is_live());
    assert_eq!(
        store
            .execution_current_result(
                waiting.envelope().attempt_id,
                waiting.envelope().items[0].item_id
            )
            .unwrap(),
        None
    );
    assert_eq!(
        store
            .execution_result(first.envelope().attempt_id, first.envelope().result_id)
            .unwrap()
            .bytes(),
        first.bytes()
    );
}

#[test]
#[ignore = "requires the independently built Host native-application-worker fixture"]
fn native_application_qualification_refuses_siblings_services_and_claimed_binding_changes() {
    let stage = tempfile::tempdir().unwrap();
    let (bytes, files) = native::application_package();
    for mode in ["multiple", "effect", "required", "project-service"] {
        let mut manifest: sdk::PluginManifest = serde_json::from_slice(&bytes).unwrap();
        match mode {
            "multiple" => {
                let mut extra = manifest.contributions[0].clone();
                extra.id = "other".into();
                manifest.contributions.push(extra);
            }
            "effect" => {
                let sdk::ContributionKind::Capability { declaration } =
                    &mut manifest.contributions[0].contribution
                else {
                    unreachable!()
                };
                declaration.effect = sdk::EffectKind::Proposal;
            }
            "required" => manifest.components[0]
                .dependencies
                .push(sdk::CapabilityDependency {
                    contract: native::contract("example.required"),
                    required: true,
                    selection: sdk::ProviderSelection::Single,
                }),
            _ => {
                let permission = sdk::PermissionRequest::ProjectService {
                    contract: native::contract("example.service"),
                };
                manifest.permissions.push(permission.clone());
                let sdk::ContributionKind::Capability { declaration } =
                    &mut manifest.contributions[0].contribution
                else {
                    unreachable!()
                };
                declaration.permissions.push(permission);
            }
        }
        let encoded = serde_json::to_vec(&manifest).unwrap();
        let digest = PackageImage::digest(&encoded, &files).unwrap();
        let image = PackageImage::capture(encoded, files.clone(), &digest).unwrap();
        assert!(
            ApplicationInstance::validate_selection(&image, "echo-tool", &runtime().into())
                .is_err(),
            "{mode}"
        );
    }
    assert_eq!(std::fs::read_dir(stage.path()).unwrap().count(), 0);
    let instance = reserve(
        native::application_image(),
        stage.path(),
        HostLimits::default(),
    );
    let lease = instance
        .authorize(ExecutionId::new(), true, Cancellation::default())
        .unwrap();
    let runner = instance.runner("echo").unwrap();
    let root = tempfile::tempdir().unwrap();
    let mut store = store(root.path());
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(runner.clone()).unwrap();
    for mode in ["generation", "profile", "environment"] {
        let mut changed = input(&store, &runner, "claim").envelope().clone();
        let binding = changed.plugin.as_mut().unwrap();
        if mode == "generation" {
            binding
                .application_scope
                .as_mut()
                .unwrap()
                .activation_generation += 1;
        } else if mode == "profile" {
            let profile = native::contract("example.claimed-profile");
            binding
                .capability
                .declaration
                .profiles
                .push(profile.clone());
            binding.profile = Some(profile);
        } else {
            let sdk::ExecutionEnvironmentDescriptor::Native(environment) = &mut binding.environment
            else {
                unreachable!()
            };
            environment.host_version = "9.0.0".into();
        }
        let changed = FixedInput::capture(changed).unwrap();
        assert!(!lease.matches(&changed));
        assert!(
            runtime
                .authorize_application_plugin(
                    &mut store,
                    ExecutionId::new(),
                    &changed,
                    expiry(),
                    PluginConsent {
                        unsandboxed_execution: true,
                        application_execution: false
                    },
                    &lease
                )
                .is_err()
        );
    }
    instance.stop();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !instance.drained() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(2));
    }
}
