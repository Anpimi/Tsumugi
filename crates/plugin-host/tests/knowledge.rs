use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn image(executable: bool) -> PackageImage {
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: "knowledge".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![],
        components: vec![sdk::ComponentDeclaration {
            id: "reference".into(),
            scope: sdk::ComponentScope::Application,
            runtime: sdk::RuntimeKind::Data,
            entrypoint: None,
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 1000,
                cleanup_timeout_ms: 1000,
            },
        }],
        contributions: vec![
            sdk::ContributionDeclaration {
                id: "terms".into(),
                component_id: "reference".into(),
                contribution: sdk::ContributionKind::Resource {
                    schema: contract("example.terms"),
                    path: "terms.bin".into(),
                },
            },
            sdk::ContributionDeclaration {
                id: "guidance".into(),
                component_id: "reference".into(),
                contribution: sdk::ContributionKind::Skill {
                    path: "guidance.md".into(),
                },
            },
        ],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([
        (
            "terms.bin".into(),
            PackageFile {
                bytes: vec![0, 255, 1],
                executable,
            },
        ),
        (
            "guidance.md".into(),
            PackageFile {
                bytes: "Guidance grants no permission.\n".as_bytes().to_vec(),
                executable,
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

#[test]
fn generic_resource_and_skill_read_exact_captured_bytes_without_runtime() {
    let image = image(false);
    assert_eq!(
        image
            .resource_bytes("terms", &contract("example.terms"))
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        image.skill_bytes("guidance").unwrap(),
        b"Guidance grants no permission.\n"
    );
    let clone = image.clone();
    drop(image);
    assert_eq!(
        clone
            .resource_bytes("terms", &contract("example.terms"))
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        clone.manifest().manifest().components[0].runtime,
        sdk::RuntimeKind::Data
    );
}

#[test]
fn generic_read_refuses_wrong_kind_identity_behavior_and_executable_content() {
    let image = image(false);
    for (id, schema) in [
        ("missing", contract("example.terms")),
        ("guidance", contract("example.terms")),
        ("terms", contract("example.other")),
        (
            "terms",
            sdk::ContractRef {
                behavior_version: 2,
                ..contract("example.terms")
            },
        ),
        (
            "terms",
            sdk::ContractRef {
                schema_version: 2,
                ..contract("example.terms")
            },
        ),
    ] {
        assert_eq!(
            image.resource_bytes(id, &schema),
            Err(HostError::InvalidContract)
        );
    }
    assert_eq!(image.skill_bytes("terms"), Err(HostError::InvalidContract));
    assert_eq!(
        image.skill_bytes("missing"),
        Err(HostError::InvalidContract)
    );
    let executable = self::image(true);
    assert_eq!(
        executable.resource_bytes("terms", &contract("example.terms")),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        executable.skill_bytes("guidance"),
        Err(HostError::InvalidContract)
    );
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[path = "support/official.rs"]
mod official;

#[cfg(all(unix, feature = "javascript-conformance", feature = "core-adapter"))]
#[path = "../../core/tests/support/mod.rs"]
#[allow(dead_code)]
mod captured_content;
#[cfg(all(unix, feature = "javascript-conformance", feature = "core-adapter"))]
#[path = "support/runtime.rs"]
mod tool_runtime;

#[cfg(all(unix, feature = "javascript-conformance"))]
struct OwnedTemporary(tempfile::TempDir);
#[cfg(all(unix, feature = "javascript-conformance"))]
impl OwnedTemporary {
    fn new() -> Self {
        Self(
            tempfile::Builder::new()
                .prefix("tsumugi-knowledge-")
                .tempdir()
                .unwrap(),
        )
    }
    fn path(&self) -> &std::path::Path {
        self.0.path()
    }
}
#[cfg(all(unix, feature = "javascript-conformance"))]
impl Drop for OwnedTemporary {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        // The installation store seals its owned objects. Restore directory
        // write permission only inside this synthetic fixture before TempDir
        // removes it; do not traverse a link or touch a selected package tree.
        fn writable(path: &std::path::Path) {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return;
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            for child in std::fs::read_dir(path).unwrap() {
                writable(&child.unwrap().path());
            }
        }
        writable(self.path());
    }
}

#[cfg(all(unix, feature = "javascript-conformance", feature = "core-adapter"))]
#[test]
fn actual_knowledge_worker_obeys_original_work_plan_grant_and_control() {
    use std::{
        sync::Arc,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use tsumugi_core::{ai::AiConfig, application::*, execution::*};
    use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};
    let temporary = OwnedTemporary::new();
    let image = official::installed(temporary.path(), "philosophy");
    let binding = image.capability_tool("agent-query-tool").unwrap();
    let captured_runtime = tool_runtime::approved_runtime();
    let environment = captured_runtime.descriptor().clone();
    let proxy = Arc::new(
        RunnerProxy::new(
            image,
            "query",
            captured_runtime,
            temporary.path(),
            HostLimits::default(),
        )
        .unwrap(),
    );
    let (_content, mut store, rows) = captured_content::source_fixture();
    let units = rows
        .iter()
        .map(|row| row.unit_id.unwrap())
        .collect::<Vec<_>>();
    let selected = binding
        .declaration
        .query
        .as_ref()
        .unwrap()
        .selections
        .options[0]
        .value
        .clone();
    let spec = WorkPlanToolSpec {
        handle: ExecutionId::new(),
        binding,
        environment: environment.into(),
        resource_id: "agent-query-tool".into(),
        settings_revision: 1u64.into(),
        package_origin: serde_json::json!({"sourceId":"explicit-test","publisherId":"reviewed-public-source"}),
        runtime_origin: serde_json::json!({"sourceId":"explicit-test","publisherId":"reviewed-public-source"}),
        target: "zh-CN".into(),
        selections: vec![selected],
    };
    let plan = store
        .prepare_work_plan_with_tools(
            Some(AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic".into(),
                ..AiConfig::default()
            }),
            "zh-CN",
            &units,
            PlanOptions::default(),
            Some(WorkPlanTools {
                max_invocations: 2,
                entries: vec![spec.clone()],
            }),
        )
        .unwrap();
    let now_ms = || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    };
    let receipt = store
        .authorize_work_plan(
            &plan,
            &AuthorizeWorkPlan {
                action_id: ExecutionId::new(),
                plan_digest: plan.digest.clone(),
                confirmed: true,
                effects: plan.authorization_effects().unwrap(),
                expires_at: now_ms() / 1000 + 600,
            },
        )
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(proxy.clone()).unwrap();
    let consent = runtime
        .authorize_work_plan_tools(
            &store,
            receipt.lease,
            now_ms() + 60_000,
            std::time::Instant::now() + std::time::Duration::from_secs(60),
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    store
        .enqueue_execution(&FixedInput::capture(receipt.input.unwrap()).unwrap())
        .unwrap();
    let scope = store.work_plan_agent_scope(receipt.lease).unwrap();
    let request = AgentToolRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        tool_handle: spec.handle,
        unit_ids: vec![units[0]],
    };
    let prepared = store
        .prepare_work_plan_agent_tool(&scope, &request)
        .unwrap();
    assert_eq!(
        prepared.input().envelope().items[0].payload["queries"][0]["text"],
        "same"
    );
    assert!(runtime.submit(&mut store, prepared.input()).is_err());
    let grant_id = ExecutionId::new();
    runtime
        .submit_work_plan_tool(&mut store, &prepared, &consent, grant_id)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let result_id = loop {
        runtime.tick(&mut store).unwrap();
        if !runtime.is_active(request.attempt_id) {
            if let Some(result) = store
                .execution_current_result(
                    request.attempt_id,
                    prepared.input().envelope().items[0].item_id,
                )
                .unwrap()
            {
                break result;
            }
        }
        assert!(
            Instant::now() < deadline,
            "delegated knowledge worker completion deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    let result = store
        .execution_result(request.attempt_id, result_id)
        .unwrap();
    assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
    let evidence = result.envelope().plugin.as_ref().unwrap();
    assert_eq!(evidence.authorization_id, grant_id);
    assert!(!evidence.channel.instance_id.is_empty());
    assert!(evidence.channel.activation_generation > 0);
    assert_eq!(
        evidence.channel.selection(),
        spec.binding.capability.provider
    );
    assert_eq!(
        store
            .execution_attempt(request.attempt_id, false)
            .unwrap()
            .items[0]
            .adoption,
        AdoptionState::Unapplied
    );
    assert!(store.provider_budget(request.task_id).unwrap().is_none());
    let queued_request = AgentToolRequest {
        task_id: ExecutionId::new(),
        attempt_id: ExecutionId::new(),
        unit_ids: vec![units[1]],
        ..request
    };
    let queued = store
        .prepare_work_plan_agent_tool(&scope, &queued_request)
        .unwrap();
    runtime
        .submit_work_plan_tool(&mut store, &queued, &consent, ExecutionId::new())
        .unwrap();
    let dispatch = store
        .dispatch_execution_item(
            queued_request.attempt_id,
            queued.input().envelope().items[0].item_id,
        )
        .unwrap();
    assert_eq!(
        dispatch.plugin_permit().unwrap().originating_caller_id(),
        Some(scope.caller_id())
    );
    store
        .control_work_plan(&ControlWorkPlan {
            action_id: ExecutionId::new(),
            plan_id: plan.plan_id,
            expected_generation: receipt.lease.generation,
            command: WorkPlanCommand::Pause,
            confirmed: false,
            expires_at: None,
        })
        .unwrap();
    let (sender, _) = result_channel();
    assert_eq!(
        proxy
            .run(dispatch, Cancellation::default(), sender)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    assert_eq!(store.work_plan_tool_invocations(plan.plan_id).unwrap(), 2);
    assert_eq!(
        store
            .execution_result(request.attempt_id, result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
    let path = store.directory().to_owned();
    drop(runtime);
    drop(store);
    let reopened = tsumugi_core::ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened.work_plan_tool_invocations(plan.plan_id).unwrap(),
        2
    );
    assert_eq!(
        reopened.work_plan_status(plan.plan_id).unwrap().state,
        WorkPlanState::Paused
    );
    assert!(reopened.work_plan_agent_scope(receipt.lease).is_err());
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[test]
fn actual_knowledge_package_reopens_resources_and_runs_original_query_and_check_workers() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let temporary = OwnedTemporary::new();
        let image = official::installed(temporary.path(), "philosophy");
        let resource = image.resource_bytes("terminology", &contract("org.tsumugi.examples.terminology-resource")).unwrap();
        let body: serde_json::Value = serde_json::from_slice(resource).unwrap();
        assert_eq!(body["authority"], "unadopted-editorial-suggestion");
        assert!(std::str::from_utf8(image.skill_bytes("concept-review").unwrap()).unwrap().contains("grants no tools"));
        let tool = image.capability_tool("agent-query-tool").unwrap();
        assert_eq!(tool.declaration.capability_id, "query");
        assert_eq!(tool.declaration.supporting_resources, vec!["terminology"]);
        assert_eq!(tool.declaration.skill.as_deref(), Some("concept-review"));
        let pin = serde_json::json!({"id":body["id"], "revision":body["revision"], "sha256":sdk::payload_digest(std::str::from_utf8(resource).unwrap())});
        let query = serde_json::json!({"resource":pin, "sourceLanguage":"en", "targetLanguage":"zh-CN",
            "queries":[{"id":"u-1", "text":"👩🏽‍💻 e\u{301} sound premises", "conceptIds":["soundness", "premise"]}]});
        let mut session = official::launch(&image, "query", temporary.path()).await;
        let binding = tool.capability;
        assert_eq!(binding, sdk::bind_capability(image.manifest(), "query", image.package_digest()).unwrap());
        let first_pid = session.channel().child_pid;
        let output = official::success_payload(official::invoke(&mut session, &binding, "query-1", &query).await);
        let output: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
        assert_eq!(output["basis"]["resource"], pin);
        assert_eq!(output["results"][0]["entries"][0]["preferredTarget"], "可靠性");
        assert_eq!(output["results"][0]["entries"][1]["preferredTarget"], "前提");
        let mut missing = query.clone(); missing["queries"][0]["text"] = "soundtrack".into();
        let empty = official::success_payload(official::invoke(&mut session, &binding, "query-empty", &missing).await);
        let empty: serde_json::Value = serde_json::from_str(&empty.utf8).unwrap();
        assert_eq!(empty["results"][0]["entries"], serde_json::json!([]));
        assert_ne!(empty["basis"]["querySha256"], output["basis"]["querySha256"]);
        let mut changed = query.clone(); changed["resource"]["revision"] = "other".into();
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut session, &binding, "query-replaced", &changed).await else { panic!("replaced resource accepted") };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&error.utf8).unwrap(), serde_json::json!({"code":"resource-mismatch"}));
        let closed = session.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);

        let mut checker = official::launch(&image, "check", temporary.path()).await;
        assert_ne!(checker.channel().child_pid, first_pid);
        let review = image.text_review_declaration("text-review").unwrap();
        let binding = review.checker.clone();
        assert_eq!(binding.declaration.contract.schema_version, 2);
        assert_eq!(binding.declaration.contract.behavior_version, 2);
        assert_eq!(review.declaration.disposition, sdk::TextReviewDisposition::Advisory);
        let rule = review.declaration.rules.iter().find(|rule| rule.rule.id.ends_with(".soundness")).unwrap().rule.clone();
        let mut input = sdk::TextReviewCheckInput {
            profile: review.declaration.profile.clone(),
            source_language: "en".into(),
            target_language: "zh-CN".into(),
            resources: image.text_review_resource_pins("text-review").unwrap(),
            selections: vec![
                sdk::TextReviewSelection { unit_id: "u-1".into(), source_revision_id: "source-1".into(),
                    source_text: "sound premises".into(), translation_text: Some("👩🏽‍💻 e\u{301} 前提".into()) },
                sdk::TextReviewSelection { unit_id: "u-2".into(), source_revision_id: "source-2".into(),
                    source_text: "audio soundtrack".into(), translation_text: Some("原样文本".into()) },
            ],
            requirements: vec![sdk::CheckRequirement {
                key: sdk::CheckKey { rule, implementation: sdk::CheckImplementation::Plugin { provider: binding.provider.clone() } },
                input_digest: sdk::payload_digest("captured-text-review-input"),
                scope_digest: sdk::payload_digest("captured-text-review-scope"),
                targets: vec!["u-1".into(), "u-2".into()], mandatory: false, waivable: false, not_applicable: None,
            }],
        };
        image.validate_text_review_input("text-review", &input).unwrap();
        let received = official::invoke_received(&mut checker, &binding, "check-1", &serde_json::to_value(&input).unwrap()).await;
        assert_eq!(received.channel().provider.selection(), binding.provider);
        let output = official::success_payload(received.result().outcome.clone());
        assert_eq!(output.schema, sdk::text_review_report_contract());
        let report = sdk::parse_text_review_report(output.utf8.as_bytes()).unwrap();
        review.validate_report(&input, &report).unwrap();
        assert_eq!(report.results.len(), 1);
        assert_eq!(report.results[0].covered_targets, vec!["u-1", "u-2"]);
        let sdk::CheckOutcome::Completed { findings } = &report.results[0].outcome else { panic!("expected completed advisory check") };
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].target, "u-1");
        assert_eq!(findings[0].severity, sdk::FindingSeverity::Warning);
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].suggestion.as_deref(), Some("可靠性"));
        assert_eq!(report.diagnostics[0].resource_entry.as_ref().unwrap().entry_id, "soundness");
        let location = report.diagnostics[0].location.as_ref().unwrap();
        assert_eq!(location.field, sdk::TextReviewField::Translation);
        assert_eq!(location.range, sdk::TextRange { encoding: sdk::TextEncoding::Utf16, start: 0,
            end: input.selections[0].translation_text.as_ref().unwrap().encode_utf16().count() as u32 });

        let mut forged = input.clone();
        let sdk::CheckImplementation::Plugin { provider } = &mut forged.requirements[0].key.implementation else { unreachable!() };
        provider.package_digest = "a".repeat(64);
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut checker, &binding, "check-forged-provider", &serde_json::to_value(&forged).unwrap()).await else { panic!("payload provider claim accepted") };
        assert_eq!(error.schema, sdk::review_check_error_contract());
        sdk::parse_review_check_error(error.utf8.as_bytes()).unwrap();
        let mut wrong_resource = input.clone();
        wrong_resource.resources[0].sha256 = "a".repeat(64);
        assert_eq!(image.validate_text_review_input("text-review", &wrong_resource), Err(HostError::InvalidContract));
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut checker, &binding, "check-forged-resource", &serde_json::to_value(&wrong_resource).unwrap()).await else { panic!("payload resource claim accepted") };
        sdk::parse_review_check_error(error.utf8.as_bytes()).unwrap();

        input.selections.truncate(1);
        input.selections[0].translation_text = None;
        input.requirements[0].targets = vec!["u-1".into()];
        let output = official::success_payload(official::invoke(&mut checker, &binding, "check-missing", &serde_json::to_value(&input).unwrap()).await);
        let report = sdk::parse_text_review_report(output.utf8.as_bytes()).unwrap();
        review.validate_report(&input, &report).unwrap();
        assert_eq!(report.results[0].outcome, sdk::CheckOutcome::Unavailable);
        assert!(report.diagnostics.is_empty());
        input.requirements[0].not_applicable = Some(sdk::NotApplicableBasis {
            code: sdk::MISSING_REVIEW_TRANSLATION.into(), basis_digest: sdk::payload_digest("captured-missing-translation"),
        });
        let output = official::success_payload(official::invoke(&mut checker, &binding, "check-captured-na", &serde_json::to_value(&input).unwrap()).await);
        let report = sdk::parse_text_review_report(output.utf8.as_bytes()).unwrap();
        review.validate_report(&input, &report).unwrap();
        assert_eq!(report.results[0].outcome, sdk::CheckOutcome::NotApplicable { basis: input.requirements[0].not_applicable.clone().unwrap() });
        assert!(report.diagnostics.is_empty());
        let closed = checker.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
        assert_eq!(image.resource_bytes("terminology", &contract("org.tsumugi.examples.terminology-resource")).unwrap(), resource);
    });
}
