//! Real settings withdrawal preserves joint WorkPlan history without renewing consent.
use super::*;

struct JointFixture {
    _installation: OwnedDirectory,
    fixture: Fixture,
    advisory: Value,
    tool_selection: Value,
    tool_binding: Value,
    knowledge_package: Value,
}

impl JointFixture {
    fn new() -> Self {
        let installation = OwnedDirectory(tempfile::tempdir().unwrap());
        let (format, format_approval) = selected_package(
            "TSUMUGI_TEST_PLUGIN_PACKAGE",
            "TSUMUGI_TEST_PLUGIN_DIGEST",
            "webvtt",
        );
        let (knowledge, knowledge_approval) = selected_package(
            "TSUMUGI_TEST_KNOWLEDGE_PACKAGE",
            "TSUMUGI_TEST_KNOWLEDGE_DIGEST",
            "philosophy",
        );
        let source_binding = format.source_import("source-profile").unwrap();
        let text_binding = knowledge.text_review_declaration("text-review").unwrap();
        let soundness = text_binding
            .declaration
            .rules
            .iter()
            .find(|rule| rule.rule.id.ends_with(".soundness"))
            .unwrap()
            .rule
            .clone();
        let tool_binding = knowledge.capability_tool("agent-query-tool").unwrap();
        let knowledge_package = json!({
            "plugin":knowledge_approval.plugin,
            "packageDigest":knowledge_approval.package_digest
        });
        let runtime = approved_runtime();
        let runtime_approval = RuntimeApproval {
            environment: runtime.descriptor().clone().into(),
            origin: crate::runtime_bundle::bundled_origin(),
        };
        let environment_digest = runtime_approval.environment.digest().unwrap();
        provision_packages(
            installation.0.path(),
            &[
                (format, format_approval.clone()),
                (knowledge, knowledge_approval),
            ],
            &runtime,
            &runtime_approval,
        );
        drop(runtime);
        let fixture = declared_fixture(
            &installation.0.path().join("application"),
            &format_approval,
            &environment_digest,
            &source_binding,
        );
        let advisory = json!({
            "package":knowledge_package, "resourceId":"text-review",
            "environmentDigest":environment_digest, "rules":[soundness]
        });
        let tool_selection = json!({"maxInvocations":1,"entries":[{
            "handle":ExecutionId::new(),
            "tool":{"package":knowledge_package,"resourceId":"agent-query-tool",
                "environmentDigest":environment_digest},
            "target":"zh-CN","selections":["soundness"]
        }]});
        Self {
            _installation: installation,
            fixture,
            advisory,
            tool_selection,
            tool_binding: json!(tool_binding),
            knowledge_package,
        }
    }

    fn authorize(&self, config: AiConfig) -> (Value, Value, Value, u64) {
        assert_eq!(config.timeout_seconds, 2);
        assert_eq!(config.max_requests, 1);
        let mut options = PlanOptions {
            selection_policy: SelectionPolicy::ReplaceCapturedSelection,
            ..Default::default()
        };
        options
            .stages
            .iter_mut()
            .find(|stage| stage.stage == WorkStage::Checks)
            .unwrap()
            .mode = StageMode::Assisted;
        let plan = self
            .fixture
            .call(
                "prepare_work_plan",
                json!({
                    "config":config,"locale":"zh-CN","unitIds":[self.fixture.unit],
                    "options":options,"advisoryChecks":[self.advisory],
                    "toolSelection":self.tool_selection
                }),
            )
            .unwrap();
        let keys = checker_keys(&plan);
        assert_eq!(keys.len(), 2);
        assert_eq!(plan["tools"]["entries"][0]["binding"], self.tool_binding);
        // The existing fresh-plan lifetime is fixed before the first human
        // capture. Settings restoration never refreshes this absolute value.
        let expires_at: u64 = expiry().parse().unwrap();
        let authorization = json!({
            "planId":plan["planId"],"digest":plan["digest"],
            "actionId":ExecutionId::new(),"confirmed":true,
            "checkerExecutions":keys,"toolExecution":true,"applicationToolExecutions":[],
            "effects":["save-candidate","run-checks","replace-captured-selection","query-tools"],
            "expiresAt":expires_at.to_string()
        });
        let grant = self
            .fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap();
        assert_eq!(grant["lease"]["planId"], plan["planId"]);
        assert_before_expiry(expires_at);
        (plan, grant, authorization, expires_at)
    }

    fn start(&self, plan: &Value, grant: &Value) {
        assert_eq!(
            self.fixture
                .call(
                    "start_work_plan",
                    json!({
                        "planId":plan["planId"],"actionId":grant["actionId"],
                        "expectedGeneration":grant["lease"]["generation"]
                    })
                )
                .unwrap(),
            plan["attemptId"]
        );
    }

    fn prepare_tool(&self, grant: &Value) -> (Value, Value) {
        let before = effects(&self.fixture);
        let scope = self
            .fixture
            .call(
                "open_work_plan_agent_scope",
                json!({"lease":grant["lease"]}),
            )
            .unwrap();
        let tool = json!({"scopeId":scope["scopeId"],"tool":{
            "taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),
            "toolHandle":self.tool_selection["entries"][0]["handle"],
            "unitIds":[self.fixture.unit]
        }});
        let prepared = self
            .fixture
            .call("prepare_work_plan_agent_tool", tool.clone())
            .unwrap();
        assert_eq!(
            self.fixture
                .call("prepare_work_plan_agent_tool", tool.clone())
                .unwrap(),
            prepared
        );
        assert_eq!(prepared["taskId"], tool["tool"]["taskId"]);
        assert_eq!(prepared["attemptId"], tool["tool"]["attemptId"]);
        assert_eq!(prepared["toolHandle"], tool["tool"]["toolHandle"]);
        assert_eq!(
            effects(&self.fixture).tool_attempts,
            before.tool_attempts,
            "read-only tool preparation must not execute the installed worker"
        );
        let mut start = tool;
        start["inputDigest"] = prepared["inputDigest"].clone();
        (scope, start)
    }

    fn enable_knowledge(&self, enabled: bool, revision: UnsignedDecimal) -> UnsignedDecimal {
        let updated = call(
            &self.fixture.webview,
            "set_plugin_enabled",
            json!({
                "package":self.knowledge_package,"enabled":enabled,
                "expectedRevision":revision,"actionId":ExecutionId::new()
            }),
        )
        .unwrap();
        let actual = self
            .fixture
            .app
            .state::<AppState>()
            .plugins
            .environment_settings_revision()
            .unwrap();
        assert_eq!(updated["settingsRevision"], json!(actual));
        assert_eq!(actual.get(), revision.get() + 1);
        actual
    }
}

#[derive(Clone)]
struct OriginalConsent {
    checker: CheckerConsent,
    tool: Arc<WorkPlanToolConsent>,
    epoch: Cancellation,
}

fn original_consent(fixture: &Fixture, plan: &Value, expires_at: u64) -> OriginalConsent {
    let plan_id: ExecutionId = serde_json::from_value(plan["planId"].clone()).unwrap();
    let (checker, tool) = fixture
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
            (
                host.work_plans
                    .checker_consents
                    .get(&plan_id)
                    .unwrap()
                    .clone(),
                host.work_plans
                    .tool_consents
                    .get(&plan_id)
                    .unwrap()
                    .1
                    .clone(),
            )
        });
    assert_eq!(checker.bindings.len(), 2);
    assert_eq!(checker.expires_at_ms, expires_at * 1000);
    assert_eq!(
        json!(checker.settings_revision),
        plan["tools"]["entries"][0]["settingsRevision"]
    );
    assert!(tool.expires_at_ms() <= expires_at * 1000);
    let epoch = checker
        .plugins
        .with_environment_authority(checker.settings_revision, Ok)
        .unwrap();
    assert!(!epoch.is_requested());
    OriginalConsent {
        checker,
        tool,
        epoch,
    }
}

fn assert_original_consent(fixture: &Fixture, plan: &Value, original: &OriginalConsent) {
    let plan_id: ExecutionId = serde_json::from_value(plan["planId"].clone()).unwrap();
    let original = original.clone();
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
            let checker = host.work_plans.checker_consents.get(&plan_id).unwrap();
            assert_eq!(checker.lease, original.checker.lease);
            assert_eq!(checker.bindings, original.checker.bindings);
            assert_eq!(checker.expires_at_ms, original.checker.expires_at_ms);
            assert_eq!(
                checker.settings_revision,
                original.checker.settings_revision
            );
            assert!(Arc::ptr_eq(&checker.plugins, &original.checker.plugins));
            let tool = &host.work_plans.tool_consents.get(&plan_id).unwrap().1;
            assert!(Arc::ptr_eq(tool, &original.tool));
            assert_eq!(tool.expires_at_ms(), original.tool.expires_at_ms());
            assert!(host.work_plans.tool_starts.is_empty());
        });
}

fn assert_no_session_consent(fixture: &Fixture) {
    fixture.app.state::<AppState>().sessions.with(|sessions| {
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
        assert!(host.work_plans.tool_starts.is_empty());
    });
}

#[derive(Debug)]
struct Effects {
    attempts: i64,
    revisions: i64,
    checker_attempts: i64,
    tool_attempts: i64,
    checks: i64,
    selections: i64,
    decisions: i64,
    selection_actions: i64,
    grants: Vec<(String, String, String, i64, i64)>,
}

fn effects(fixture: &Fixture) -> Effects {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let count = |table| {
        connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap()
    };
    let operation_count = |operation| {
        connection
            .query_row(
                "SELECT COUNT(*) FROM execution_tasks WHERE operation=?1",
                [operation],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    let mut statement = connection.prepare(
        "SELECT grant_id,attempt_id,input_digest,expires_at_ms,revoked FROM plugin_execution_grants ORDER BY grant_id"
    ).unwrap();
    let grants = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    Effects {
        attempts: count("execution_attempts"),
        revisions: count("translation_revisions"),
        checker_attempts: operation_count(REVIEW_CHECK_OPERATION),
        tool_attempts: operation_count("plugin-tool-query"),
        checks: count("review_checks"),
        selections: count("translation_selections"),
        decisions: count("review_decisions"),
        selection_actions: count("application_selection_actions"),
        grants,
    }
}

fn assert_effects_preserved(before: &Effects, after: &Effects) {
    assert_eq!(
        (
            after.attempts,
            after.revisions,
            after.checker_attempts,
            after.tool_attempts,
            after.checks,
            after.selections,
            after.decisions,
            after.selection_actions
        ),
        (
            before.attempts,
            before.revisions,
            before.checker_attempts,
            before.tool_attempts,
            before.checks,
            before.selections,
            before.decisions,
            before.selection_actions
        )
    );
    assert_eq!(after.grants.len(), before.grants.len());
    for (old, current) in before.grants.iter().zip(&after.grants) {
        assert_eq!(
            (&current.0, &current.1, &current.2, current.3),
            (&old.0, &old.1, &old.2, old.3),
            "original grant and deadline must not be renewed"
        );
        assert!(
            current.4 >= old.4,
            "withdrawal cannot undo an original revocation"
        );
    }
}

#[derive(Clone)]
struct CheckerFrame {
    attempt: ExecutionId,
    result: ExecutionId,
    input: Vec<u8>,
    input_digest: String,
    output: Vec<u8>,
}

fn checker_attempts(fixture: &Fixture) -> BTreeSet<ExecutionId> {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut statement = connection.prepare(
        "SELECT a.attempt_id FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id WHERE t.operation=?1 ORDER BY a.attempt_id"
    ).unwrap();
    let attempts = statement
        .query_map([REVIEW_CHECK_OPERATION], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|value| ExecutionId::parse(&value.unwrap()).unwrap())
        .collect();
    attempts
}

fn completed_checker_frames(
    fixture: &Fixture,
    prior: &BTreeSet<ExecutionId>,
    original: &OriginalConsent,
) -> Vec<CheckerFrame> {
    let attempts: Vec<_> = checker_attempts(fixture)
        .difference(prior)
        .copied()
        .collect();
    assert_eq!(
        attempts.len(),
        2,
        "both real installed checkers must complete"
    );
    let checker = original.checker.clone();
    let frames = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let mut keys = BTreeSet::new();
            attempts
                .into_iter()
                .map(|attempt| {
                    let status = store.execution_attempt(attempt, false).unwrap();
                    assert_eq!(status.items.len(), 1);
                    assert_eq!(status.items[0].execution, ExecutionState::Succeeded);
                    let result = store
                        .execution_current_result(attempt, status.items[0].item_id)
                        .unwrap()
                        .unwrap();
                    let input = store.execution_input(attempt).unwrap();
                    assert_eq!(input.envelope().operation, REVIEW_CHECK_OPERATION);
                    let binding = checker
                        .bindings
                        .iter()
                        .find(|binding| {
                            json!(binding.key) == input.envelope().settings["checkerKey"]
                        })
                        .unwrap();
                    assert!(keys.insert(json!(binding.key).to_string()));
                    assert_eq!(input.envelope().plugin.as_ref(), Some(&binding.binding));
                    let output = store.execution_result(attempt, result).unwrap();
                    CheckerFrame {
                        attempt,
                        result,
                        input: input.bytes().to_vec(),
                        input_digest: input.digest().to_owned(),
                        output: output.bytes().to_vec(),
                    }
                })
                .collect::<Vec<_>>()
        });
    let captured = effects(fixture);
    let mut grants = BTreeSet::new();
    let mut instances = BTreeSet::new();
    for frame in &frames {
        let output = fixture
            .call(
                "read_execution_output",
                json!({"attemptId":frame.attempt,"resultId":frame.result}),
            )
            .unwrap();
        assert_eq!(output["outcome"], "succeeded");
        let grant = captured
            .grants
            .iter()
            .find(|grant| grant.1 == frame.attempt.to_string())
            .unwrap();
        assert_eq!(output["plugin"]["authorizationId"], grant.0);
        assert_eq!(grant.2, frame.input_digest);
        assert_eq!(grant.3, original.checker.expires_at_ms as i64);
        assert!(grants.insert(grant.0.clone()));
        assert!(
            instances.insert(
                output["plugin"]["channel"]["instanceId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            )
        );
    }
    frames
}

fn assert_checker_history(fixture: &Fixture, frames: &[CheckerFrame]) {
    let frames = frames.to_vec();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            for frame in frames {
                assert_eq!(
                    store.execution_input(frame.attempt).unwrap().bytes(),
                    frame.input
                );
                assert_eq!(
                    store
                        .execution_result(frame.attempt, frame.result)
                        .unwrap()
                        .bytes(),
                    frame.output
                );
            }
        });
}

fn assert_before_expiry(expires_at: u64) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    assert!(
        now < expires_at,
        "settings withdrawal must precede the original fixed expiry: now={now}, expires_at={expires_at}"
    );
}

fn assert_tool_denied(fixture: &Fixture, start: &Value, code: &str, reason: &str) {
    let before = effects(fixture);
    let error = fixture
        .call("start_work_plan_agent_tool", start.clone())
        .unwrap_err();
    assert_eq!(error["code"], code, "{error}");
    assert_eq!(error["reason"], reason, "{error}");
    assert_effects_preserved(&before, &effects(fixture));
}

fn assert_status(fixture: &Fixture, plan: &Value, grant: &Value, expires_at: u64) {
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    assert_eq!(status["lease"], grant["lease"]);
    assert_eq!(status["state"], "active");
    assert_eq!(status["expiresAt"], expires_at.to_string());
    assert_eq!(status["toolInvocations"], json!({"reserved":0,"limit":1}));
}

fn assert_reopened_status(fixture: &Fixture, plan: &Value, grant: &Value, expires_at: u64) {
    let status = fixture
        .call("read_work_plan_status", json!({"planId":plan["planId"]}))
        .unwrap();
    let historical_generation: u64 = grant["lease"]["generation"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    // Close pauses the active plan once. Open observes that paused generation;
    // the original authorization acknowledgement remains an unchanged receipt.
    assert_eq!(
        status["lease"],
        json!({
            "planId":grant["lease"]["planId"],
            "generation":historical_generation.checked_add(1).unwrap().to_string()
        })
    );
    assert_eq!(status["lease"]["planId"], plan["planId"]);
    assert_eq!(status["state"], "paused");
    assert_eq!(status["expiresAt"], expires_at.to_string());
    assert_eq!(status["toolInvocations"], json!({"reserved":0,"limit":1}));
}

#[test]
fn prepared_joint_tool_rejects_real_settings_withdrawal_without_renewing_original_consent() {
    let mut joint = JointFixture::new();
    let baseline = effects(&joint.fixture);
    let prior = checker_attempts(&joint.fixture);
    let (setup, waiting) = mpsc::channel();
    let (config, provider) = local_provider_sequence_at_request(
        vec!["👩🏽‍💻 é 根可靠性"],
        None,
        Some(waiting),
        Duration::from_secs(90),
        Duration::from_secs(1),
    );
    let (plan, grant, authorization, expires_at) = joint.authorize(config);
    let original = original_consent(&joint.fixture, &plan, expires_at);
    setup.send(()).unwrap();
    joint.start(&plan, &grant);
    assert_eq!(
        provider.join().unwrap()["unitId"],
        json!(joint.fixture.unit)
    );
    let saved = wait_checked(&joint.fixture, &plan["attemptId"]);
    assert_eq!(
        saved["rows"][0]["automation"]["phase"], "selected",
        "{saved}"
    );
    let frames = completed_checker_frames(&joint.fixture, &prior, &original);
    let target_request = json!({"unitId":joint.fixture.unit,"locale":"zh-CN"});
    let target = joint
        .fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    assert!(target["selectionId"].is_string());
    assert!(target["currentCheck"].is_object());
    let before_prepare = joint.fixture.bytes();
    let (_, tool_start) = joint.prepare_tool(&grant);
    assert_eq!(joint.fixture.bytes(), before_prepare);
    let captured = effects(&joint.fixture);
    assert_eq!(captured.attempts, baseline.attempts + 3);
    assert_eq!(captured.checker_attempts, baseline.checker_attempts + 2);
    assert_eq!(captured.tool_attempts, baseline.tool_attempts);
    assert_status(&joint.fixture, &plan, &grant, expires_at);
    let disabled = joint.enable_knowledge(false, original.checker.settings_revision);
    assert!(original.epoch.is_requested());
    assert_before_expiry(expires_at);
    assert_tool_denied(
        &joint.fixture,
        &tool_start,
        "permission-denied",
        "plugin-disabled",
    );
    assert_eq!(
        joint
            .fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    assert_original_consent(&joint.fixture, &plan, &original);
    let restored = joint.enable_knowledge(true, disabled);
    assert_eq!(restored.get(), original.checker.settings_revision.get() + 2);
    assert!(original.epoch.is_requested());
    assert_before_expiry(expires_at);
    assert_tool_denied(
        &joint.fixture,
        &tool_start,
        "dependency-conflict",
        "work-plan-tool-preview",
    );
    assert_eq!(
        joint
            .fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    assert_original_consent(&joint.fixture, &plan, &original);
    assert_eq!(
        joint
            .fixture
            .call(
                "read_ai_translation",
                json!({"attemptId":plan["attemptId"]})
            )
            .unwrap(),
        saved
    );
    assert_eq!(
        joint
            .fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        target
    );
    assert_status(&joint.fixture, &plan, &grant, expires_at);
    assert_checker_history(&joint.fixture, &frames);
    assert_effects_preserved(&captured, &effects(&joint.fixture));
    unavailable::settled(&joint.fixture);
    joint.fixture.reopen();
    let reopened = joint
        .fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        reopened["rows"][0]["automation"]["receipt"],
        saved["rows"][0]["automation"]["receipt"]
    );
    assert_eq!(reopened["budget"], saved["budget"]);
    assert_eq!(
        joint
            .fixture
            .call("authorize_work_plan", authorization)
            .unwrap(),
        grant
    );
    assert_no_session_consent(&joint.fixture);
    assert!(
        joint
            .fixture
            .call("start_work_plan_agent_tool", tool_start)
            .is_err()
    );
    assert_eq!(
        joint
            .fixture
            .call("read_review_target", target_request)
            .unwrap(),
        target
    );
    assert_reopened_status(&joint.fixture, &plan, &grant, expires_at);
    assert_checker_history(&joint.fixture, &frames);
    assert_effects_preserved(&captured, &effects(&joint.fixture));
}

#[test]
fn two_real_joint_checker_results_cannot_record_qa_or_select_after_settings_withdrawal() {
    let mut joint = JointFixture::new();
    let baseline = effects(&joint.fixture);
    let prior = checker_attempts(&joint.fixture);
    let target_request = json!({"unitId":joint.fixture.unit,"locale":"zh-CN"});
    let target = joint
        .fixture
        .call("read_review_target", target_request.clone())
        .unwrap();
    assert!(
        target["selectionId"].is_null(),
        "the unchanged candidate must otherwise be selectable"
    );
    let (setup, waiting) = mpsc::channel();
    let (config, provider) = local_provider_sequence_at_request(
        vec!["👩🏽‍💻 é 根可靠性"],
        None,
        Some(waiting),
        Duration::from_secs(90),
        Duration::from_secs(1),
    );
    let (plan, grant, authorization, expires_at) = joint.authorize(config);
    let original = original_consent(&joint.fixture, &plan, expires_at);
    let (reached, captured) = mpsc::channel();
    let (release, paused) = mpsc::channel();
    let attempt: ExecutionId = serde_json::from_value(plan["attemptId"].clone()).unwrap();
    joint
        .fixture
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
    setup.send(()).unwrap();
    joint.start(&plan, &grant);
    let (_, tool_start) = joint.prepare_tool(&grant);
    assert_eq!(
        provider.join().unwrap()["unitId"],
        json!(joint.fixture.unit)
    );
    captured
        .recv_timeout(Duration::from_secs(45))
        .expect("both real checker results must reach computation");
    assert_before_expiry(expires_at);
    let checking = joint
        .fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(checking["rows"][0]["automation"]["phase"], "checking");
    assert!(checking["rows"][0]["savedRevisionId"].is_string());
    let frames = completed_checker_frames(&joint.fixture, &prior, &original);
    let at_checkpoint = effects(&joint.fixture);
    assert_eq!(at_checkpoint.attempts, baseline.attempts + 3);
    assert_eq!(
        at_checkpoint.checker_attempts,
        baseline.checker_attempts + 2
    );
    assert_eq!(at_checkpoint.grants.len(), baseline.grants.len() + 2);
    assert_eq!(at_checkpoint.revisions, baseline.revisions + 1);
    assert_eq!(
        (
            at_checkpoint.tool_attempts,
            at_checkpoint.checks,
            at_checkpoint.selections,
            at_checkpoint.decisions,
            at_checkpoint.selection_actions
        ),
        (
            baseline.tool_attempts,
            baseline.checks,
            baseline.selections,
            baseline.decisions,
            baseline.selection_actions
        )
    );
    let disabled = joint.enable_knowledge(false, original.checker.settings_revision);
    assert!(original.epoch.is_requested());
    assert_before_expiry(expires_at);
    // Release the existing ten-second computation gate after the real settings
    // mutation. No test clock, original grant or Worker deadline is changed.
    release.send(()).unwrap();
    let failed = wait_checked(&joint.fixture, &plan["attemptId"]);
    assert_eq!(
        failed["rows"][0]["automation"]["phase"], "failed",
        "{failed}"
    );
    assert_eq!(
        failed["rows"][0]["automation"]["error"]["code"], "dependency-conflict",
        "{failed}"
    );
    assert_eq!(
        failed["rows"][0]["automation"]["error"]["reason"], "plugin-settings-changed",
        "{failed}"
    );
    assert_eq!(failed["rows"][0]["automation"]["retryable"], false);
    assert_eq!(
        failed["rows"][0]["savedRevisionId"],
        checking["rows"][0]["savedRevisionId"]
    );
    assert_eq!(failed["budget"], checking["budget"]);
    assert_tool_denied(
        &joint.fixture,
        &tool_start,
        "permission-denied",
        "plugin-disabled",
    );
    assert!(
        joint
            .fixture
            .call(
                "retry_work_plan_effect",
                json!({
                    "attemptId":plan["attemptId"],"itemId":failed["rows"][0]["itemId"]
                })
            )
            .is_err()
    );
    assert_eq!(
        joint
            .fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    assert_original_consent(&joint.fixture, &plan, &original);
    let restored = joint.enable_knowledge(true, disabled);
    assert_eq!(restored.get(), original.checker.settings_revision.get() + 2);
    assert!(original.epoch.is_requested());
    assert_before_expiry(expires_at);
    assert_tool_denied(
        &joint.fixture,
        &tool_start,
        "dependency-conflict",
        "work-plan-tool-preview",
    );
    assert_eq!(
        joint
            .fixture
            .call("authorize_work_plan", authorization.clone())
            .unwrap(),
        grant
    );
    assert_original_consent(&joint.fixture, &plan, &original);
    let after_restore = joint
        .fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        after_restore["rows"][0]["savedRevisionId"],
        checking["rows"][0]["savedRevisionId"]
    );
    assert_eq!(after_restore["budget"], checking["budget"]);
    assert!(after_restore["rows"][0]["automation"]["receipt"].is_null());
    assert_eq!(after_restore["rows"][0]["automation"]["phase"], "failed");
    assert_eq!(
        after_restore["rows"][0]["automation"]["error"]["code"],
        "dependency-conflict"
    );
    assert_eq!(
        after_restore["rows"][0]["automation"]["error"]["reason"],
        "plugin-settings-changed"
    );
    assert_eq!(after_restore["rows"][0]["automation"]["retryable"], false);
    assert!(
        joint
            .fixture
            .call(
                "retry_work_plan_effect",
                json!({
                    "attemptId":plan["attemptId"],"itemId":failed["rows"][0]["itemId"]
                })
            )
            .is_err()
    );
    assert_eq!(
        joint
            .fixture
            .call("read_review_target", target_request.clone())
            .unwrap(),
        target
    );
    assert_status(&joint.fixture, &plan, &grant, expires_at);
    assert_checker_history(&joint.fixture, &frames);
    assert_effects_preserved(&at_checkpoint, &effects(&joint.fixture));
    unavailable::settled(&joint.fixture);
    joint.fixture.reopen();
    let reopened = joint
        .fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":plan["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        reopened["rows"][0]["savedRevisionId"],
        checking["rows"][0]["savedRevisionId"]
    );
    assert_eq!(reopened["budget"], checking["budget"]);
    assert!(reopened["rows"][0]["automation"]["receipt"].is_null());
    assert_eq!(
        joint
            .fixture
            .call("authorize_work_plan", authorization)
            .unwrap(),
        grant
    );
    assert_no_session_consent(&joint.fixture);
    assert!(
        joint
            .fixture
            .call("start_work_plan_agent_tool", tool_start)
            .is_err()
    );
    assert_eq!(
        joint
            .fixture
            .call("read_review_target", target_request)
            .unwrap(),
        target
    );
    assert_reopened_status(&joint.fixture, &plan, &grant, expires_at);
    assert_checker_history(&joint.fixture, &frames);
    assert_effects_preserved(&at_checkpoint, &effects(&joint.fixture));
}
