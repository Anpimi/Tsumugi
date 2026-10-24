//! Settings authority for derived QA, using the existing synthetic SDK source
//! proof fixture and a real installed-settings owner. No installed worker runs.
use super::*;
use crate::commands::plugins::InstalledFixture;
use std::sync::atomic::{AtomicUsize, Ordering};
use tsumugi_plugin_host::{RuntimeApproval, catalog::PackageOrigin};
use tsumugi_plugin_sdk as sdk;

#[allow(dead_code)]
#[path = "../../../../../../../../crates/core/tests/support/mod.rs"]
mod source_fixture;

struct Checker {
    binding: PluginExecutionBinding,
    calls: Arc<AtomicUsize>,
    text: bool,
    omit_result: bool,
}
impl Runner for Checker {
    fn capability_id(&self) -> &str {
        &self.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.binding.environment)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        assert!(!cancellation.is_requested());
        let permit = request.plugin_permit().unwrap();
        assert!(permit.matches(&request.input) && permit.is_authorized());
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.omit_result {
            return Ok(());
        }
        let selected = &self.binding.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: selected.plugin.clone(),
            component_id: selected.component_id.clone(),
            contribution_id: selected.contribution_id.clone(),
            package_digest: selected.package_digest.clone(),
            instance_id: ExecutionId::new().to_string(),
            activation_generation: 1,
        };
        let invocation =
            request
                .input
                .plugin_request(request.item_id, request.dispatch_token, &channel)?;
        let payload = request.input.item(request.item_id)?.payload.clone();
        let requirements = if self.text {
            serde_json::from_value::<sdk::TextReviewCheckInput>(payload)
                .unwrap()
                .requirements
        } else {
            serde_json::from_value::<sdk::ReviewCheckInput>(payload)
                .unwrap()
                .requirements
        };
        let results: Vec<_> = requirements
            .into_iter()
            .map(|r| sdk::CheckResult {
                key: r.key,
                input_digest: r.input_digest,
                scope_digest: r.scope_digest,
                covered_targets: r.targets,
                outcome: r
                    .not_applicable
                    .map_or(sdk::CheckOutcome::Completed { findings: vec![] }, |basis| {
                        sdk::CheckOutcome::NotApplicable { basis }
                    }),
            })
            .collect();
        let output = if self.text {
            serde_json::to_value(sdk::TextReviewCheckReport {
                results,
                diagnostics: vec![],
            })
            .unwrap()
        } else {
            serde_json::to_value(results).unwrap()
        };
        sender.send(FixedResult::capture_plugin(
            &request.input,
            request.item_id,
            request.dispatch_token,
            PluginResultEvidence {
                authorization_id: permit.grant_id(),
                channel: channel.clone(),
                result: sdk::InvocationResult {
                    context: invocation.context,
                    provider: channel,
                    capability: invocation.capability,
                    profile: invocation.profile,
                    result_id: ExecutionId::new().to_string(),
                    outcome: sdk::InvocationOutcome::Succeeded {
                        output: sdk::EncodedPayload::capture(
                            invocation.output_schema,
                            serde_json::to_string(&output).unwrap(),
                        )
                        .unwrap(),
                    },
                },
            },
        )?)
    }
}

fn declared_options(store: &ProjectStore, unit: ExecutionId, advisory: bool) -> PlanOptions {
    let mut options = PlanOptions {
        selection_policy: tsumugi_core::application::SelectionPolicy::MissingOnly,
        ..Default::default()
    };
    options
        .stages
        .iter_mut()
        .find(|stage| stage.stage == WorkStage::Checks)
        .unwrap()
        .mode = StageMode::Assisted;
    if advisory {
        let project =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let format = store
            .capture_review_check_plan(project, unit, "zh-CN", &target.basis, &[])
            .unwrap();
        let manifest = sdk::parse_manifest(include_bytes!(
            "../../../../../../../../crates/plugin-sdk/tests/fixtures/text-review.manifest.json"
        ))
        .unwrap();
        let declaration = sdk::parse_text_review_declaration(include_bytes!(
            "../../../../../../../../crates/plugin-sdk/tests/fixtures/text-review.declaration.json"
        ))
        .unwrap();
        let binding = declaration.bind(&manifest, &"d".repeat(64)).unwrap();
        let pins = binding
            .resources
            .iter()
            .map(|r| sdk::TextReviewResourcePin {
                contribution_id: r.contribution_id.clone(),
                schema: r.schema.clone(),
                sha256: "e".repeat(64),
            })
            .collect();
        let rules = vec![binding.declaration.rules[0].rule.clone()];
        options.advisory_checks = vec![
            AdvisoryReviewCheck::capture(
                &binding,
                &tsumugi_core::execution::PluginExecutionBinding {
                    component_scope: sdk::ComponentScope::Project,
                    application_scope: None,
                    capability: binding.checker.clone(),
                    profile: Some(binding.declaration.profile.clone()),
                    environment: format.binding().checker.environment.clone(),
                },
                "text-review-profile",
                pins,
                rules,
            )
            .unwrap(),
        ];
    }
    options
}

fn declared_tool(
    revision: UnsignedDecimal,
    environment: sdk::ExecutionEnvironmentDescriptor,
) -> tsumugi_core::application::WorkPlanToolSpec {
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../../../../../../crates/plugin-sdk/tests/fixtures/tool.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_tool_declaration(include_bytes!(
        "../../../../../../../../crates/plugin-sdk/tests/fixtures/tool.query.json"
    ))
    .unwrap();
    let binding = declaration.bind(&manifest, &"a".repeat(64)).unwrap();
    tsumugi_core::application::WorkPlanToolSpec {
        handle: ExecutionId::new(),
        application_capabilities: vec![],
        binding: binding.clone(),
        resource_id: "query-tool".into(),
        settings_revision: revision,
        package_origin: json!({"sourceId":"synthetic-settings","publisherId":"synthetic-publisher"}),
        runtime_origin: json!({"sourceId":"synthetic-settings","publisherId":"synthetic-publisher"}),
        target: "zh-CN".into(),
        selections: vec!["term".into()],
        execution: PluginExecutionBinding {
            component_scope: sdk::ComponentScope::Project,
            application_scope: None,
            capability: binding.capability.clone(),
            profile: binding.declaration.profile.clone(),
            environment,
        },
    }
}

impl Fixture {
    fn declared() -> (Self, InstalledFixture, RuntimeApproval, Arc<AtomicUsize>) {
        let (directory, store, rows) = source_fixture::source_fixture();
        let row = &rows[0];
        let unit = row.unit_id.unwrap();
        let source_revision = row.source_revision_id.unwrap();
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        let project =
            ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let plan = store
            .capture_review_check_plan(project, unit, "zh-CN", &target.basis, &[])
            .unwrap();
        let runtime = RuntimeApproval {
            environment: plan.binding().checker.environment.clone(),
            origin: PackageOrigin {
                source_id: "synthetic-settings".into(),
                publisher_id: "synthetic-publisher".into(),
            },
        };
        drop(store);
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let installed =
            InstalledFixture::with_owner(app.state::<AppState>().plugins.clone(), |_, _| {});
        installed.install();
        installed.decide(true, vec![runtime.clone()]);
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let view = call(
            &webview,
            "open_project",
            json!({"locator":directory.path().join("project")}),
        )
        .unwrap();
        let context =
            json!({"sessionToken":view["sessionToken"],"projectId":view["metadata"]["projectId"]});
        (
            Self {
                project_path: directory.path().join("project"),
                directory,
                app,
                webview,
                context,
                unit,
                source_revision,
                snapshot,
            },
            installed,
            runtime,
            Arc::new(AtomicUsize::new(0)),
        )
    }

    fn start_declared(
        &self,
        config: AiConfig,
        calls: Arc<AtomicUsize>,
        advisory: bool,
        unknown: bool,
    ) -> (Value, Value) {
        let plugins = self.app.state::<AppState>().plugins.clone();
        let revision = plugins.environment_settings_revision().unwrap();
        let consent_plugins = plugins.clone();
        let unit = self.unit;
        // This fixture starts after trusted environment capture. The ordinary
        // start command, runtime, settings guards and all derived QA are real.
        let (plan, receipt) = self.app.state::<AppState>().sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let options = declared_options(store, unit, advisory);
            let plan = store
                .prepare_work_plan(Some(config), "zh-CN", &[unit], options)
                .unwrap();
            let bindings = store.work_plan_review_checkers(&plan).unwrap();
            let expires_at = expiry().parse::<u64>().unwrap();
            let receipt = plugins
                .with_environment_revision(revision, || {
                    for checker in &bindings {
                        if host.plugin_registrations.contains(&checker.binding) {
                            continue;
                        }
                        host.runtime
                            .register_read_only(Arc::new(Checker {
                                binding: checker.binding.clone(),
                                calls: calls.clone(),
                                text: checker.kind == tsumugi_core::ReviewCheckerKind::AdvisoryText,
                                omit_result: unknown
                                    && checker.kind
                                        == tsumugi_core::ReviewCheckerKind::AdvisoryText,
                            }))
                            .unwrap();
                        host.plugin_registrations.push(checker.binding.clone());
                    }
                    let receipt = store
                        .authorize_work_plan(
                            &plan,
                            &AuthorizeWorkPlan {
                                action_id: ExecutionId::new(),
                                plan_digest: plan.digest.clone(),
                                confirmed: true,
                                effects: vec![
                                    AutomationEffect::SaveCandidate,
                                    AutomationEffect::RunChecks,
                                    AutomationEffect::SelectMissing,
                                ],
                                expires_at,
                            },
                        )
                        .unwrap();
                    host.work_plans.checker_consents.insert(
                        plan.plan_id,
                        CheckerConsent {
                            lease: receipt.lease,
                            bindings,
                            expires_at_ms: expires_at.saturating_mul(1000),
                            settings_revision: revision,
                            plugins: consent_plugins,
                        },
                    );
                    Ok(receipt)
                })
                .unwrap();
            (
                serde_json::to_value(WorkPlanView::try_from(&plan).unwrap()).unwrap(),
                serde_json::to_value(WorkPlanReceiptView::from(receipt)).unwrap(),
            )
        });
        let result = self.call("start_work_plan", json!({"planId":plan["planId"],"actionId":receipt["actionId"],"expectedGeneration":receipt["lease"]["generation"]})).unwrap();
        assert_eq!(result, plan["attemptId"]);
        let mut plan = plan;
        plan["attemptId"] = result;
        (plan, receipt)
    }

    fn count(&self, table: &str) -> i64 {
        assert!(matches!(table, "review_checks" | "translation_selections"));
        let connection = rusqlite::Connection::open_with_flags(
            self.directory.path().join("project/project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }
}

fn revoked_during_provider_wait(disable_package: bool) {
    let (fixture, installed, runtime, calls) = Fixture::declared();
    let (started, waiting) = mpsc::channel();
    let (release, hold) = mpsc::channel();
    let (config, provider) = local_provider_gate("你好", Some((started, hold)));
    let (plan, receipt) = fixture.start_declared(config, calls.clone(), false, false);
    waiting.recv_timeout(Duration::from_secs(3)).unwrap();
    installed.decide(
        !disable_package,
        if disable_package {
            vec![runtime.clone()]
        } else {
            vec![]
        },
    );
    release.send(()).unwrap();
    provider.join().unwrap();
    let failed = fixture.wait_effect(&plan);
    assert_eq!(
        failed["rows"][0]["automation"]["phase"], "failed",
        "{failed}"
    );
    assert_eq!(
        failed["rows"][0]["automation"]["error"]["reason"],
        "plugin-settings-changed"
    );
    assert_eq!(failed["rows"][0]["automation"]["retryable"], false);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.count("review_checks"), 0);
    assert_eq!(fixture.count("translation_selections"), 0);
    assert!(
        fixture
            .call(
                "retry_work_plan_effect",
                json!({"attemptId":plan["attemptId"],"itemId":failed["rows"][0]["itemId"]})
            )
            .is_err()
    );
    let historical = fixture
        .call(
            "read_work_plan_action",
            json!({"actionId":receipt["actionId"]}),
        )
        .unwrap();
    assert_eq!(historical, receipt);
    installed.decide(true, vec![runtime]);
    let stale = fixture.call("start_work_plan", json!({"planId":plan["planId"],"actionId":receipt["actionId"],"expectedGeneration":receipt["lease"]["generation"]})).unwrap_err();
    assert_eq!(stale["reason"], "plugin-settings-changed");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "a settings change never renews old consent"
    );
    let (config, provider) = local_provider("你好");
    let (fresh, _) = fixture.start_declared(config, calls.clone(), false, false);
    let selected = fixture.wait_effect(&fresh);
    provider.join().unwrap();
    assert_ne!(fresh["planId"], plan["planId"]);
    assert_eq!(
        selected["rows"][0]["automation"]["phase"], "selected",
        "{selected}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a fresh explicit authorization can execute"
    );
}

#[test]
fn package_disable_while_provider_waits_prevents_derived_checks_and_selection() {
    revoked_during_provider_wait(true);
}

#[test]
fn runtime_approval_withdrawal_while_provider_waits_prevents_derived_checks_and_selection() {
    revoked_during_provider_wait(false);
}

#[test]
fn completed_selection_remains_readable_after_settings_revocation() {
    let (fixture, installed, runtime, calls) = Fixture::declared();
    let (config, provider) = local_provider("你好");
    let (plan, _) = fixture.start_declared(config, calls.clone(), false, false);
    let completed = fixture.wait_effect(&plan);
    provider.join().unwrap();
    assert_eq!(
        completed["rows"][0]["automation"]["phase"], "selected",
        "{completed}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    installed.decide(false, vec![runtime]);
    let historical = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        historical["rows"][0]["automation"]["receipt"],
        completed["rows"][0]["automation"]["receipt"]
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.count("review_checks"), 1);
    assert_eq!(fixture.count("translation_selections"), 1);
}

#[test]
fn pause_after_partial_checker_submission_revokes_every_grant_and_keeps_finished_result() {
    let (fixture, _installed, _runtime, calls) = Fixture::declared();
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("project/project.sqlite3"))
            .unwrap();
    connection.execute_batch(&format!(
        "CREATE TRIGGER reject_second_check BEFORE INSERT ON execution_tasks WHEN NEW.operation='{REVIEW_CHECK_OPERATION}' AND (SELECT COUNT(*) FROM execution_tasks WHERE operation='{REVIEW_CHECK_OPERATION}')=1 BEGIN SELECT RAISE(ABORT, 'synthetic second-slot enqueue failure'); END;"
    )).unwrap();
    let (config, provider) = local_provider("你好");
    let (plan, _) = fixture.start_declared(config, calls.clone(), true, false);
    let failed = fixture.wait_effect(&plan);
    provider.join().unwrap();
    assert_eq!(
        failed["rows"][0]["automation"]["phase"], "failed",
        "{failed}"
    );
    assert_eq!(failed["rows"][0]["automation"]["retryable"], true);
    let deadline = Instant::now() + Duration::from_secs(5);
    let (attempt, item, result) = loop {
        let found = connection.query_row(
            "SELECT a.attempt_id,i.item_id,i.current_result_id FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id JOIN execution_items i ON i.attempt_id=a.attempt_id WHERE t.operation=?1 AND i.current_result_id IS NOT NULL",
            [REVIEW_CHECK_OPERATION], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)),
        );
        match found {
            Ok(found) => break found,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("{error}"),
        }
    };
    fixture.call("control_work_plan", json!({"actionId":ExecutionId::new(),"planId":plan["planId"],"expectedGeneration":"1","command":"pause","confirmed":false,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"expiresAt":null})).unwrap();
    // Drive the same host boundary that drains cancellation before dispatch.
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.tick(store).unwrap();
            let attempt = ExecutionId::parse(&attempt).unwrap();
            let result = ExecutionId::parse(&result).unwrap();
            let history = store.execution_result(attempt, result).unwrap();
            assert_eq!(history.envelope().outcome, ExecutionState::Succeeded);
            let status = store.execution_attempt(attempt, false).unwrap();
            assert!(
                status
                    .items
                    .iter()
                    .find(|detail| detail.item_id.to_string() == item)
                    .unwrap()
                    .cancellation_requested
            );
        });
    let (total, revoked): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),SUM(revoked) FROM plugin_execution_grants",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        total, 4,
        "two source proof grants and two independent QA grants"
    );
    assert_eq!(revoked, total);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "only the first real slot completed"
    );
    assert_eq!(fixture.count("review_checks"), 0);
    assert_eq!(fixture.count("translation_selections"), 0);
    connection
        .execute_batch("DROP TRIGGER reject_second_check")
        .unwrap();
    assert!(
        fixture
            .call(
                "retry_work_plan_effect",
                json!({"attemptId":plan["attemptId"],"itemId":failed["rows"][0]["itemId"]})
            )
            .is_err()
    );
}

#[test]
fn settings_revocation_after_checker_result_prevents_pending_selection_commit() {
    let (fixture, installed, runtime, calls) = Fixture::declared();
    let (started, waiting) = mpsc::channel();
    let (release, hold) = mpsc::channel();
    let (config, provider) = local_provider_gate("你好", Some((started, hold)));
    let (plan, _) = fixture.start_declared(config, calls.clone(), false, false);
    waiting.recv_timeout(Duration::from_secs(3)).unwrap();
    let (reached, computed) = mpsc::channel();
    let (resume, paused) = mpsc::channel();
    let attempt = ExecutionId::parse(plan["attemptId"].as_str().unwrap()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.ai.pause_check_computation(review::ComputeProbe {
                action: attempt,
                reached,
                release: paused,
            });
        });
    release.send(()).unwrap();
    provider.join().unwrap();
    computed.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    installed.decide(false, vec![runtime]);
    resume.send(()).unwrap();
    let failed = fixture.wait_effect(&plan);
    assert_eq!(
        failed["rows"][0]["automation"]["phase"], "failed",
        "{failed}"
    );
    assert_eq!(
        failed["rows"][0]["automation"]["error"]["reason"],
        "plugin-settings-changed"
    );
    assert_eq!(fixture.count("review_checks"), 0);
    assert_eq!(fixture.count("translation_selections"), 0);
    let connection =
        rusqlite::Connection::open(fixture.directory.path().join("project/project.sqlite3"))
            .unwrap();
    let (attempt, result): (String,String) = connection.query_row(
        "SELECT a.attempt_id,i.current_result_id FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id JOIN execution_items i ON i.attempt_id=a.attempt_id WHERE t.operation=?1",
        [REVIEW_CHECK_OPERATION], |row| Ok((row.get(0)?,row.get(1)?)),
    ).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            assert_eq!(
                store
                    .execution_result(
                        ExecutionId::parse(&attempt).unwrap(),
                        ExecutionId::parse(&result).unwrap()
                    )
                    .unwrap()
                    .envelope()
                    .outcome,
                ExecutionState::Succeeded
            );
        });
}

#[test]
fn unknown_checker_retry_retains_all_original_grants_deadlines_and_finished_slot() {
    let (fixture, _installed, _runtime, calls) = Fixture::declared();
    let (config, provider) = local_provider("你好");
    let (plan, _) = fixture.start_declared(config, calls.clone(), true, true);
    let failed = fixture.wait_effect(&plan);
    provider.join().unwrap();
    assert_eq!(
        failed["rows"][0]["automation"]["error"]["code"], "outcome-unknown",
        "{failed}"
    );
    assert_eq!(failed["rows"][0]["automation"]["retryable"], true);
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let grants = || {
        let mut statement = connection.prepare("SELECT grant_id,attempt_id,input_digest,expires_at_ms,revoked FROM plugin_execution_grants ORDER BY grant_id").unwrap();
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let original = grants();
    assert_eq!(original.len(), 4);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    fixture
        .call(
            "retry_work_plan_effect",
            json!({"attemptId":plan["attemptId"],"itemId":failed["rows"][0]["itemId"]}),
        )
        .unwrap();
    let retried = fixture.wait_effect(&plan);
    assert_eq!(
        retried["rows"][0]["automation"]["error"]["code"], "outcome-unknown",
        "{retried}"
    );
    assert_eq!(grants(), original);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "neither completed nor unknown slots are redispatched"
    );
    assert_eq!(
        fixture.count("review_checks"),
        0,
        "no result cannot become passed QA evidence"
    );
    assert_eq!(fixture.count("translation_selections"), 0);
}

#[test]
fn joint_settings_guard_and_replay_require_original_tools_and_complete_checker_consent() {
    let (mut fixture, installed, runtime, _calls) = Fixture::declared();
    let plugins = fixture.app.state::<AppState>().plugins.clone();
    let revision = plugins.environment_settings_revision().unwrap();
    let unit = fixture.unit;
    let context = fixture.context.clone();
    let guarded_plugins = plugins.clone();
    let environment = runtime.environment.clone();
    let (plan_id, request, receipt, consent, checker_consent) =
        fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let plan = store.prepare_work_plan_with_tools(
                Some(AiConfig {
                    endpoint: "http://127.0.0.1:9".into(),
                    model: "synthetic".into(),
                    credential_env: String::new(),
                    ..AiConfig::default()
                }),
                "zh-CN", &[unit], declared_options(store, unit, true),
                Some(WorkPlanTools {
                    max_invocations: 2,
                    entries: vec![declared_tool(revision, environment)],
                }),
            ).unwrap();
            let bindings = store.work_plan_review_checkers(&plan).unwrap();
            assert_eq!(bindings.len(), 2, "mandatory and advisory checker identities");
            let request: WorkPlanAuthorizeRequest = serde_json::from_value(json!({
                "sessionToken":context["sessionToken"], "projectId":context["projectId"],
                "planId":plan.plan_id, "digest":plan.digest, "actionId":ExecutionId::new(),
                "confirmed":true, "toolExecution":true,"applicationToolExecutions":[],
                "checkerExecutions":bindings.iter().map(|checker| checker.key.clone()).collect::<Vec<_>>(),
                "effects":["save-candidate","run-checks","select-missing","query-tools"],
                "expiresAt":expiry(),
            })).unwrap();
            broker::capture_human_intent(host, &plan, request.action_id, request.expires_at.get(), &request,
                &request.application_tool_executions, request.confirmed, &guarded_plugins).unwrap();
            let receipt = with_plan_environment_revision(&guarded_plugins, &plan, Some(revision), || {
                let receipt = store.authorize_work_plan(&plan, &AuthorizeWorkPlan {
                    action_id: request.action_id, plan_digest: request.digest.clone(),
                    confirmed: request.confirmed, effects: request.effects.clone(),
                    expires_at: request.expires_at.get(),
                }).map_err(map_recover)?;
                broker::save_consent(host, store, &plan, &receipt)?;
                host.work_plans.checker_consents.insert(plan.plan_id, CheckerConsent {
                    lease: receipt.lease, bindings: bindings.clone(),
                    expires_at_ms: request.expires_at.get().checked_mul(1000).unwrap(),
                    settings_revision: revision, plugins: guarded_plugins.clone(),
                });
                Ok(receipt)
            }).unwrap();
            // Both real consent clocks retain the original human authorization.
            let consent = host.work_plans.tool_consents[&plan.plan_id].1.clone();
            current_checker_consent(host, store, &plan, receipt.lease).unwrap().unwrap();
            host.work_plans.checker_consents.get_mut(&plan.plan_id).unwrap().bindings.pop();
            assert_eq!(current_checker_consent(host, store, &plan, receipt.lease).err().unwrap().reason.as_deref(), Some("plugin-consent-required"));
            host.work_plans.checker_consents.get_mut(&plan.plan_id).unwrap().bindings = bindings;
            let mut mismatched = plan.clone();
            mismatched.tools.as_mut().unwrap().entries[0].settings_revision = (revision.get() + 1).into();
            let mut admitted = false;
            assert!(with_plan_environment_revision(&guarded_plugins, &mismatched, Some(revision), || {
                admitted = true;
                Ok(())
            }).is_err());
            assert!(!admitted);
            host.work_plans.tool_consents.remove(&plan.plan_id);
            let checker_consent = host.work_plans.checker_consents.remove(&plan.plan_id).unwrap();
            (plan.plan_id, serde_json::to_value(request).unwrap(),
                serde_json::to_value(WorkPlanReceiptView::from(receipt)).unwrap(), consent, checker_consent)
        });
    // Losing a checker acknowledgement never restores tools from the same live
    // human intent. The exact durable receipt remains readable.
    assert_eq!(
        fixture
            .call("authorize_work_plan", request.clone())
            .unwrap(),
        receipt
    );
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let host = sessions
                .active
                .as_mut()
                .unwrap()
                .execution
                .as_mut()
                .unwrap();
            assert!(!host.work_plans.tool_consents.contains_key(&plan_id));
            assert!(host.work_plans.tool_intents.contains_key(
                &serde_json::from_value::<ExecutionId>(receipt["actionId"].clone()).unwrap()
            ));
            host.work_plans
                .checker_consents
                .insert(plan_id, checker_consent);
        });
    let mut altered = request.clone();
    altered["toolExecution"] = json!(false);
    assert!(fixture.call("authorize_work_plan", altered).is_err());
    installed.decide(false, vec![runtime]);
    let request_replay = request.clone();
    let plugins_for_check = plugins.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            let plan = store.work_plan(plan_id).unwrap();
            let mut admitted = false;
            let error =
                with_plan_environment_revision(&plugins_for_check, &plan, Some(revision), || {
                    admitted = true;
                    Ok(())
                })
                .unwrap_err();
            assert_eq!(error.reason.as_deref(), Some("plugin-settings-changed"));
            assert!(!admitted);
            let receipt = store
                .work_plan_receipt(
                    serde_json::from_value(request_replay["actionId"].clone()).unwrap(),
                )
                .unwrap()
                .unwrap();
            broker::restore_consent(
                host,
                store,
                &plan,
                &receipt,
                &serde_json::from_value::<WorkPlanAuthorizeRequest>(request_replay).unwrap(),
                &plugins_for_check,
            )
            .unwrap();
            assert!(!host.work_plans.tool_consents.contains_key(&plan_id));
        });
    let original_expiry = consent.expires_at_ms();
    fixture.reopen();
    assert_eq!(
        fixture
            .call("authorize_work_plan", request.clone())
            .unwrap_err()["code"],
        "session-invalid"
    );
    let mut historical_request = request.clone();
    historical_request["sessionToken"] = fixture.context["sessionToken"].clone();
    assert_eq!(
        fixture
            .call("authorize_work_plan", historical_request)
            .unwrap()["actionId"],
        request["actionId"]
    );
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let host = sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap();
            assert!(host.work_plans.checker_consents.is_empty());
            assert!(host.work_plans.tool_consents.is_empty());
            assert!(host.work_plans.tool_intents.is_empty());
        });
    assert_eq!(consent.expires_at_ms(), original_expiry);
}

#[test]
fn agent_generation_start_rechecks_installed_settings_before_child_enqueue() {
    let (fixture, installed, runtime, calls) = Fixture::declared();
    let (config, provider) = local_provider("原始候选");
    let (plan, receipt) = fixture.start_declared(config, calls, false, false);
    assert_eq!(
        fixture.wait_effect(&plan)["rows"][0]["automation"]["phase"],
        "selected"
    );
    provider.join().unwrap();
    let agent = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":receipt["lease"]}),
        )
        .unwrap();
    let child_task = ExecutionId::new();
    let child_attempt = ExecutionId::new();
    let mut request = json!({
        "scopeId":agent["scopeId"],
        "generation":{"taskId":child_task,"attemptId":child_attempt,"unitIds":[fixture.unit]}
    });
    let prepared = fixture
        .call("prepare_work_plan_agent_generation", request.clone())
        .unwrap();
    request["inputDigest"] = prepared["inputDigest"].clone();
    installed.decide(false, vec![runtime]);
    let error = fixture
        .call("start_work_plan_agent_generation", request)
        .unwrap_err();
    assert_eq!(error["reason"], "plugin-settings-changed", "{error}");
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            assert!(store.execution_attempt_ids(child_task).unwrap().is_empty());
        });
}
