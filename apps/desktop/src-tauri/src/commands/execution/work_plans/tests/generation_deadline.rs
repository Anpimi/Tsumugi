//! Original WorkPlan expiry across actual model, installed QA and tool consent.
use super::*;

// Real installed-environment capture precedes authorization completion. Choose
// this lifetime once for each fresh plan; never replace a captured deadline.
const INITIAL_AUTHORIZATION_LIFETIME_SECONDS: u64 = 45;

struct JointFixture {
    _installation: OwnedDirectory,
    fixture: Fixture,
    advisory: Value,
    tool_selection: Value,
    tool_binding: Value,
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
        let advisory = json!({
            "package":knowledge_package,
            "resourceId":"text-review",
            "environmentDigest":null,
            "rules":[soundness]
        });
        let tool_selection = json!({
            "maxInvocations":1,
            "entries":[{
                "handle":ExecutionId::new(),
                "tool":{
                    "package":knowledge_package,
                    "resourceId":"agent-query-tool",
                    "environmentDigest":null
                },
                "target":"zh-CN",
                "selections":["soundness"]
            }]
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
        let mut advisory = advisory;
        advisory["environmentDigest"] = json!(environment_digest);
        let mut tool_selection = tool_selection;
        tool_selection["entries"][0]["tool"]["environmentDigest"] = json!(environment_digest);
        Self {
            _installation: installation,
            fixture,
            advisory,
            tool_selection,
            tool_binding: json!(tool_binding),
        }
    }

    fn authorize(&self, config: AiConfig, lifetime_seconds: u64) -> (Value, Value, Value, u64) {
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
        let plan = self.fixture.call("prepare_work_plan", json!({
            "config":config,
            "locale":"zh-CN",
            "unitIds":[self.fixture.unit],
            "options":options,
            "advisoryChecks":[self.advisory],
            "toolSelection":self.tool_selection
        })).unwrap();
        let keys = checker_keys(&plan);
        assert_eq!(keys.len(), 2, "both installed Node checkers must be captured");
        assert_eq!(plan["tools"]["entries"][0]["binding"], self.tool_binding);
        // Fix the human authorization deadline once, after read-only preview
        // and before any start or held request. Never refresh this value.
        let expires_at = now_seconds() + lifetime_seconds;
        deadline_checkpoint("fixed-expiry", expires_at);
        let authorization = json!({
            "planId":plan["planId"], "digest":plan["digest"],
            "actionId":ExecutionId::new(), "confirmed":true,
            "checkerExecutions":keys, "toolExecution":true,
            "effects":["save-candidate","run-checks","replace-captured-selection","query-tools"],
            "expiresAt":expires_at.to_string()
        });
        let grant = self.fixture.call("authorize_work_plan", authorization.clone()).unwrap();
        deadline_checkpoint("authorization-finished", expires_at);
        assert_eq!(grant["lease"]["planId"], plan["planId"]);
        (plan, grant, authorization, expires_at)
    }

    fn start(&self, plan: &Value, grant: &Value) {
        assert_eq!(self.fixture.call("start_work_plan", json!({
            "planId":plan["planId"], "actionId":grant["actionId"],
            "expectedGeneration":grant["lease"]["generation"]
        })).unwrap(), plan["attemptId"]);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Effects {
    attempts: i64,
    revisions: i64,
    checker_attempts: i64,
    tool_attempts: i64,
    checks: i64,
    selections: i64,
    decisions: i64,
    grants: Vec<(String, String, String, i64, i64)>,
}

fn effects(fixture: &Fixture) -> Effects {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let count = |table: &str| -> i64 {
        assert!(matches!(table, "execution_attempts" | "translation_revisions" | "review_checks" | "translation_selections" | "review_decisions"));
        connection.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0)).unwrap()
    };
    let operation_count = |operation: &str| -> i64 {
        connection.query_row("SELECT COUNT(*) FROM execution_tasks WHERE operation=?1", [operation], |row| row.get(0)).unwrap()
    };
    let mut statement = connection.prepare("SELECT grant_id,attempt_id,input_digest,expires_at_ms,revoked FROM plugin_execution_grants ORDER BY grant_id")
        .unwrap();
    let grants = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))
        .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    Effects {
        attempts: count("execution_attempts"),
        revisions: count("translation_revisions"),
        checker_attempts: operation_count(REVIEW_CHECK_OPERATION),
        tool_attempts: operation_count("plugin-tool-query"),
        checks: count("review_checks"),
        selections: count("translation_selections"),
        decisions: count("review_decisions"),
        grants,
    }
}

fn assert_grants_not_renewed(before: &Effects, after: &Effects) {
    assert_eq!(after.grants.len(), before.grants.len());
    for (original, current) in before.grants.iter().zip(&after.grants) {
        assert_eq!((&current.0, &current.1, &current.2, current.3),
            (&original.0, &original.1, &original.2, original.3),
            "the original grant identity, input and absolute expiry must remain fixed");
        assert!(current.4 >= original.4, "revocation cannot be undone");
    }
}

fn now_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn deadline_checkpoint(checkpoint: &str, expires_at: u64) {
    let wall_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    eprintln!(
        "original-deadline checkpoint={checkpoint} wall_ms={wall_ms} expires_at_ms={}",
        expires_at.saturating_mul(1000)
    );
}

fn wait_dispatch_window(expires_at: u64, remaining_seconds: u64) {
    let dispatch_at = expires_at.checked_sub(remaining_seconds).unwrap();
    let limit = Instant::now() + Duration::from_secs(60);
    while now_seconds() < dispatch_at {
        assert!(
            Instant::now() < limit,
            "original dispatch window did not arrive within the fixture budget"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        now_seconds() < expires_at,
        "original authorization expired before dispatch could start"
    );
}

fn wait_original_expiry(expires_at: u64) {
    let limit = Instant::now() + Duration::from_secs(10);
    while now_seconds() < expires_at {
        assert!(Instant::now() < limit, "original authorization did not expire within the probe budget");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn original_deadline_after_full_model_post_prevents_new_joint_effects() {
    let joint = JointFixture::new();
    let fixture = &joint.fixture;
    let baseline = effects(fixture);
    let original_target = fixture.call("read_review_target", json!({
        "unitId":fixture.unit,"locale":"zh-CN"
    })).unwrap();
    assert!(original_target["selectionId"].is_null(), "selection must be available to replace");
    let (seen, full_post) = mpsc::channel();
    let (release, hold) = mpsc::channel();
    let (ready, setup) = mpsc::channel();
    let (config, provider) = local_provider_sequence_at_request(
        vec!["candidate after original deadline"], Some((0, (seen, hold))), Some(setup),
        Duration::from_secs(8), Duration::from_secs(3),
    );
    let (plan, grant, original_authorization, expires_at) =
        joint.authorize(config, INITIAL_AUTHORIZATION_LIFETIME_SECONDS);
    // Start the HTTP accept budget only when this original grant is ready to
    // dispatch. A short remaining window retains the model's two-second wait.
    wait_dispatch_window(expires_at, 1);
    deadline_checkpoint("start-requested", expires_at);
    ready.send(()).unwrap();
    joint.start(&plan, &grant);
    deadline_checkpoint("start-finished", expires_at);
    full_post.recv_timeout(Duration::from_secs(6)).expect("actual complete POST must arrive before original deadline");
    deadline_checkpoint("full-post", expires_at);
    assert!(now_seconds() < expires_at, "POST checkpoint arrived after original authorization expired");
    let status_before = fixture.call("read_work_plan_status", json!({"planId":plan["planId"]})).unwrap();
    let pending = fixture.call("read_ai_translation", json!({"attemptId":plan["attemptId"]})).unwrap();
    assert_eq!(pending["budget"]["dispatched"], 1, "original model dispatch consumes its budget");
    assert_eq!(pending["budget"]["unresolved"], 1);
    assert_eq!(pending["budget"]["usageUnknown"], 1);
    let original_item = pending["rows"][0]["itemId"].clone();
    wait_original_expiry(expires_at);
    release.send(()).unwrap();
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    let failed = wait_checked(fixture, &plan["attemptId"]);
    assert!(matches!(failed["rows"][0]["automation"]["phase"].as_str(), Some("failed" | "cancelled")), "{failed}");
    assert_eq!(failed["rows"][0]["itemId"], original_item);
    assert!(pending["rows"][0]["savedRevisionId"].is_null());
    assert!(failed["rows"][0]["savedRevisionId"].is_null(), "late POST cannot save a candidate: {failed}");
    assert_eq!(failed["budget"]["limit"], pending["budget"]["limit"]);
    assert_eq!(failed["budget"]["dispatched"], pending["budget"]["dispatched"],
        "the dispatched model budget cannot be refunded");
    assert_eq!(failed["budget"]["legacyHeld"], pending["budget"]["legacyHeld"]);
    // The same complete HTTP response reports one prompt/completion token.
    // Known usage may settle after expiry without refunding dispatch authority.
    assert_eq!(failed["budget"]["promptTokens"], "1");
    assert_eq!(failed["budget"]["completionTokens"], "1");
    assert_eq!(failed["budget"]["unresolved"], 0);
    assert_eq!(failed["budget"]["usageUnknown"], 0);
    assert_eq!(failed["rows"][0]["automation"]["error"]["reason"], "work-plan-control", "{failed}");
    let after = effects(fixture);
    assert_eq!(after.attempts, baseline.attempts + 1, "only the original model attempt may be created");
    assert_eq!(after.revisions, baseline.revisions, "late POST cannot create a translation revision");
    assert_eq!(after.checker_attempts, baseline.checker_attempts);
    assert_eq!(after.tool_attempts, baseline.tool_attempts);
    assert_eq!(after.checks, baseline.checks);
    assert_eq!(after.selections, baseline.selections);
    assert_eq!(after.decisions, baseline.decisions);
    assert_eq!(after.grants, baseline.grants, "no new checker/tool grant may be minted");
    assert_eq!(fixture.call("read_work_plan_status", json!({"planId":plan["planId"]})).unwrap()["toolInvocations"],
        status_before["toolInvocations"]);
    assert_eq!(fixture.call("read_review_target", json!({"unitId":fixture.unit,"locale":"zh-CN"})).unwrap(), original_target);
    assert!(fixture.call("open_work_plan_agent_scope", json!({"lease":grant["lease"]})).is_err());
    assert_eq!(fixture.call("authorize_work_plan", original_authorization).unwrap(), grant,
        "historical authorization ACK must retain the old grant without renewing authority");
    assert_eq!(effects(fixture), after);
}

#[test]
fn original_deadline_after_two_real_checker_results_prevents_automatic_selection() {
    let mut joint = JointFixture::new();
    let fixture = &joint.fixture;
    let baseline = effects(fixture);
    let prior_checkers: BTreeSet<_> = checker_rows(fixture).into_iter().map(|(attempt, _)| attempt).collect();
    let target_request = json!({"unitId":fixture.unit,"locale":"zh-CN"});
    let original_target = fixture.call("read_review_target", target_request.clone()).unwrap();
    assert!(original_target["selectionId"].is_null(), "an otherwise selectable basis is required");
    let (ready, setup) = mpsc::channel();
    let (config, provider) = local_provider_sequence_at_request(
        vec!["👩🏽‍💻 é 根可靠性"], None, Some(setup), Duration::from_secs(8), Duration::from_secs(1),
    );
    let (plan, grant, original_authorization, expires_at) =
        joint.authorize(config, INITIAL_AUTHORIZATION_LIFETIME_SECONDS);
    let status_before = fixture.call("read_work_plan_status", json!({"planId":plan["planId"]})).unwrap();
    let (reached, captured) = mpsc::channel();
    let (release, paused) = mpsc::channel();
    let attempt: ExecutionId = serde_json::from_value(plan["attemptId"].clone()).unwrap();
    fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
        host.ai.pause_check_computation(review::ComputeProbe { action: attempt, reached, release: paused });
    });
    // Scope/preflight require the original task's durable budget after start.
    // If both checkers reach this window, the unchanged ten-second ComputeProbe
    // can span the original expiry without renewing its authority.
    wait_dispatch_window(expires_at, 8);
    deadline_checkpoint("start-requested", expires_at);
    ready.send(()).unwrap();
    joint.start(&plan, &grant);
    deadline_checkpoint("start-finished", expires_at);
    let original_scope = fixture.call("open_work_plan_agent_scope", json!({"lease":grant["lease"]})).unwrap();
    assert!(now_seconds() < expires_at, "original scope must open before its fixed deadline");
    let tool = json!({"scopeId":original_scope["scopeId"],"tool":{
        "taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),
        "toolHandle":joint.tool_selection["entries"][0]["handle"],"unitIds":[fixture.unit]
    }});
    let tool_preflight = fixture.call("prepare_work_plan_agent_tool", tool.clone()).unwrap();
    deadline_checkpoint("tool-preflight", expires_at);
    assert!(now_seconds() < expires_at, "original tool digest must be prepared before its fixed deadline");
    let mut tool_start = tool;
    tool_start["inputDigest"] = tool_preflight["inputDigest"].clone();
    assert_eq!(effects(fixture).tool_attempts, baseline.tool_attempts,
        "read-only preparation must not execute the installed tool");
    assert_eq!(provider.join().unwrap()["unitId"], json!(fixture.unit));
    captured.recv_timeout(Duration::from_secs(8)).expect("both real checker results must reach computation before the original deadline");
    deadline_checkpoint("checker-results", expires_at);
    assert!(now_seconds() < expires_at, "checker checkpoint arrived after original authorization expired");
    let checking = fixture.call("read_ai_translation", json!({"attemptId":plan["attemptId"]})).unwrap();
    assert!(checking["rows"][0]["savedRevisionId"].is_string(), "original candidate must survive: {checking}");
    assert_eq!(checking["rows"][0]["automation"]["phase"], "checking");
    let checker_rows: Vec<_> = checker_rows(fixture).into_iter()
        .filter(|(attempt, _)| !prior_checkers.contains(attempt))
        .map(|(attempt, result)| (attempt, result.expect("a captured checker must have a real result")))
        .collect();
    assert_eq!(checker_rows.len(), 2, "both installed checkers must have real successful results");
    let keys = checker_keys(&plan);
    let mut seen_keys = BTreeSet::new();
    for (attempt, result) in &checker_rows {
        let output = fixture.call("read_execution_output", json!({"attemptId":attempt,"resultId":result})).unwrap();
        assert_eq!(output["outcome"], "succeeded");
        let input: ExecutionId = ExecutionId::parse(attempt).unwrap();
        let current = fixture.app.state::<AppState>().sessions.with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            store.execution_input(input).unwrap()
        });
        let key = current.envelope().settings["checkerKey"].clone();
        assert!(keys.contains(&key));
        assert!(seen_keys.insert(key.to_string()));
        let grant = checking_grant(fixture, attempt);
        assert_eq!(output["plugin"]["authorizationId"], grant.0);
        assert_eq!(current.digest(), grant.1);
        assert_eq!(grant.2, (expires_at as i64) * 1000,
            "each checker grant must retain the original absolute authorization deadline");
    }
    assert_eq!(seen_keys.len(), 2);
    let at_checkpoint = effects(fixture);
    assert_eq!(at_checkpoint.checker_attempts, baseline.checker_attempts + 2);
    assert_eq!(at_checkpoint.attempts, baseline.attempts + 3, "one model and two checker attempts only");
    assert_eq!(at_checkpoint.revisions, baseline.revisions + 1,
        "the original candidate must be saved before checker completion");
    assert_eq!(at_checkpoint.grants.len(), baseline.grants.len() + 2);
    assert_eq!(at_checkpoint.tool_attempts, baseline.tool_attempts);
    assert_eq!(at_checkpoint.checks, baseline.checks);
    assert_eq!(at_checkpoint.selections, baseline.selections);
    assert_eq!(at_checkpoint.decisions, baseline.decisions);
    wait_original_expiry(expires_at);
    release.send(()).unwrap();
    let failed = wait_checked(fixture, &plan["attemptId"]);
    assert!(matches!(failed["rows"][0]["automation"]["phase"].as_str(), Some("failed" | "cancelled")), "{failed}");
    assert_eq!(failed["rows"][0]["savedRevisionId"], checking["rows"][0]["savedRevisionId"]);
    assert_eq!(failed["budget"], checking["budget"]);
    assert_eq!(failed["rows"][0]["automation"]["error"]["reason"], "work-plan-control", "{failed}");
    let after = effects(fixture);
    assert_eq!(after.checker_attempts, baseline.checker_attempts + 2);
    assert_eq!(after.revisions, at_checkpoint.revisions,
        "late computation cannot create another translation revision");
    assert_eq!(after.tool_attempts, baseline.tool_attempts);
    assert_eq!(after.checks, baseline.checks, "late computation cannot record QA");
    assert_eq!(after.selections, baseline.selections, "late computation cannot replace selection");
    assert_eq!(after.decisions, baseline.decisions);
    assert_grants_not_renewed(&at_checkpoint, &after);
    let denied_tool = fixture.call("start_work_plan_agent_tool", tool_start).unwrap_err();
    assert_eq!(denied_tool["reason"], "work-plan-control", "{denied_tool}");
    let after_denied_tool = effects(fixture);
    assert_eq!(after_denied_tool.attempts, after.attempts);
    assert_eq!(after_denied_tool.revisions, after.revisions);
    assert_eq!(after_denied_tool.tool_attempts, after.tool_attempts);
    assert_grants_not_renewed(&after, &after_denied_tool);
    assert_eq!(fixture.call("read_work_plan_status", json!({"planId":plan["planId"]})).unwrap()["toolInvocations"],
        status_before["toolInvocations"]);
    assert_eq!(fixture.call("read_review_target", target_request.clone()).unwrap(), original_target);
    assert!(fixture.call("retry_work_plan_effect", json!({"attemptId":plan["attemptId"],"itemId":failed["rows"][0]["itemId"]})).is_err());
    assert_eq!(fixture.call("authorize_work_plan", original_authorization.clone()).unwrap(), grant);
    let after_replay = effects(fixture);
    assert_eq!(after_replay.attempts, after.attempts);
    assert_eq!(after_replay.revisions, after.revisions);
    assert_eq!(after_replay.checks, after.checks);
    assert_eq!(after_replay.selections, after.selections);
    assert_eq!(after_replay.decisions, after.decisions);
    assert_grants_not_renewed(&after, &after_replay);
    unavailable::settled(fixture);
    joint.fixture.reopen();
    let reopened = joint.fixture.call("read_ai_translation", json!({"attemptId":plan["attemptId"]})).unwrap();
    assert_eq!(reopened["rows"][0]["savedRevisionId"], checking["rows"][0]["savedRevisionId"]);
    assert_eq!(reopened["budget"], checking["budget"]);
    assert_eq!(joint.fixture.call("authorize_work_plan", original_authorization).unwrap(), grant);
    assert!(joint.fixture.call("open_work_plan_agent_scope", json!({"lease":grant["lease"]})).is_err());
    let after_reopen = effects(&joint.fixture);
    assert_eq!(after_reopen.attempts, after.attempts);
    assert_eq!(after_reopen.revisions, after.revisions);
    assert_eq!(after_reopen.checks, after.checks);
    assert_eq!(after_reopen.selections, after.selections);
    assert_eq!(after_reopen.decisions, after.decisions);
    assert_grants_not_renewed(&after, &after_reopen);
    assert_eq!(joint.fixture.call("read_review_target", target_request).unwrap(), original_target);
}

fn checker_rows(fixture: &Fixture) -> Vec<(String, Option<String>)> {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    let mut statement = connection.prepare("SELECT a.attempt_id,i.current_result_id FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id JOIN execution_items i ON i.attempt_id=a.attempt_id WHERE t.operation=?1 ORDER BY a.attempt_id")
        .unwrap();
    let rows = statement.query_map([REVIEW_CHECK_OPERATION], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
    rows
}

fn checking_grant(fixture: &Fixture, attempt: &str) -> (String, String, i64) {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.directory.path().join("project/project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).unwrap();
    connection.query_row("SELECT grant_id,input_digest,expires_at_ms FROM plugin_execution_grants WHERE attempt_id=?1", [attempt],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap()
}
