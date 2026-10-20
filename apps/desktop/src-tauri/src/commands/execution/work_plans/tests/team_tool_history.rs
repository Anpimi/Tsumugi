//! An abnormally exited Pi member does not erase or replay its real tool work.
use super::*;

pub(super) fn work_reference(receipt: &Value) -> Value {
    json!({"taskId":receipt["taskId"],"attemptId":receipt["attemptId"],
        "inputDigest":receipt["inputDigest"]})
}

pub(super) fn tool_history(fixture: &Fixture, plan: &Value, work: &Value) -> Value {
    let page = fixture
        .call(
            "read_work_plan_team_work_tools",
            json!({
                "planId":plan["planId"],"work":work,"after":null,"limit":16,
            }),
        )
        .unwrap();
    assert_eq!(page["projectId"], fixture.context["projectId"]);
    assert_eq!(page["planId"], plan["planId"]);
    assert_eq!(page["work"], *work);
    assert!(page["nextAfter"].is_null());
    page
}

pub(super) fn query_events(fixture: &Fixture) -> Vec<Value> {
    match std::fs::read_to_string(fixture.directory.path().join("query-observer.jsonl")) {
        Ok(text) => text
            .rsplit_once('\n')
            .map_or("", |(complete, _)| complete)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("cannot read the owned query observer: {error}"),
    }
}

pub(super) fn query_entered(fixture: &Fixture) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let events = query_events(fixture);
        let entries: Vec<_> = events
            .iter()
            .filter(|event| event["stage"] == "entered")
            .collect();
        assert!(
            entries.len() <= 1,
            "one actual query invocation only: {events:?}"
        );
        if let Some(entry) = entries.first() {
            return entry["pid"].as_u64().unwrap().try_into().unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "the real query worker must enter"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub(super) fn attempt(fixture: &Fixture, reference: &Value) -> Value {
    fixture
        .call(
            "read_execution_attempt",
            json!({
                "attemptId":reference["attemptId"],"offset":0,"limit":100,
            }),
        )
        .unwrap()
}

fn host_exists(fixture: &Fixture) -> bool {
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(|sessions| sessions.active.as_ref().unwrap().execution.is_some())
}

fn owned_work(fixture: &Fixture, plan: ExecutionId, attempts: &[ExecutionId]) -> bool {
    let attempts = attempts.to_vec();
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
            host.plan_callbacks_active(plan)
                || attempts
                    .iter()
                    .any(|attempt| host.runtime.has_owned_attempt_work(*attempt))
        })
}

pub(super) fn wait_drained(fixture: &Fixture, plan: ExecutionId, attempts: &[ExecutionId]) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while owned_work(fixture, plan, attempts) {
        assert!(
            Instant::now() < deadline,
            "original member and tool producers must drain"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn assert_reaped(pid: u32) {
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .output()
            .unwrap()
            .status
            .success(),
        "the exact observed owned worker {pid} must be reaped"
    );
}

fn assert_no_http(peers: &[Peer; 3]) {
    for peer in peers {
        assert!(
            matches!(peer.listener.accept(), Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock),
            "history must not cause another physical model request"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn abnormal_member_tool_history(pending: bool) {
    let (mut fixture, selection) = TeamFixture::query(pending);
    let manual = fixture
        .call(
            "save_translation_revision",
            json!({
                "actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN",
                "sourceRevisionId":fixture.source_revision,"expectedSelectionId":null,
                "text":"Human selection retained across an abnormal member exit",
            }),
        )
        .unwrap();
    let before_history = history(&fixture);
    let before_protection = protection(&fixture);
    let peers = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan_with_tools(
        &fixture,
        &[&peers[0], &peers[1], &peers[2]],
        &ids,
        [&["translation"], &["review"], &["evidence"]],
        Some(&selection),
    );
    let first = admitted(&fixture, &peers[0], ids[0]);
    let (_, view) = work_view(&first);
    let work = work_reference(&view["work"]);
    let parent: ExecutionId = serde_json::from_value(work["attemptId"].clone()).unwrap();
    let start = json!({"planId":plan["planId"],"actionId":grant["actionId"],
        "expectedGeneration":grant["lease"]["generation"]});
    let plan_id: ExecutionId = serde_json::from_value(plan["planId"].clone()).unwrap();
    let handle = &selection["entries"][0]["handle"];
    let name = format!("tool_{}", handle.as_str().unwrap().replace('-', "_"));
    assert!(
        first.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == name)
    );
    let members = concurrency::owned_member_pids(&fixture);
    assert_eq!(members.len(), 1, "one original Pi producer owns this work");
    let member_pid = members[0];
    assert_ne!(member_pid, std::process::id());

    let (reached, observation) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    if !pending {
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
                assert!(
                    host.work_plans
                        .tool_reply_probes
                        .insert(parent, member::ToolReplyProbe::new(reached, held))
                        .is_none()
                );
            });
    }
    first.tool(
        "original-reference-query",
        &name,
        json!({"unitId":fixture.unit}),
    );
    let query_pid = query_entered(&fixture);
    assert_ne!(
        query_pid, member_pid,
        "the tool is an independent real SDK worker"
    );
    assert_ne!(query_pid, std::process::id());

    let observed = if pending {
        None
    } else {
        Some(
            observation
                .recv_timeout(Duration::from_secs(30))
                .expect("persisted tool outcome must reach the delivery boundary"),
        )
    };
    let page = tool_history(&fixture, &plan, &work);
    assert_eq!(page["attempts"].as_array().unwrap().len(), 1);
    let row = &page["attempts"][0];
    let tool = row["reference"].clone();
    let tool_attempt: ExecutionId = serde_json::from_value(tool["attemptId"].clone()).unwrap();
    assert_eq!(row["toolHandle"], *handle);
    assert_eq!(
        row["name"],
        plan["tools"]["entries"][0]["binding"]["declaration"]["title"]
    );
    assert_eq!(row["unitIds"], json!([fixture.unit]));
    assert_ne!(tool["taskId"], work["taskId"]);
    assert_ne!(tool["attemptId"], work["attemptId"]);
    let before = attempt(&fixture, &tool);
    assert_eq!(before["taskId"], tool["taskId"]);
    assert_eq!(before["items"].as_array().unwrap().len(), 1);
    let result_id = before["items"][0]["resultId"].clone();
    let stored = if let Some(observed) = observed {
        assert_eq!(json!(observed.tool.task_id), tool["taskId"]);
        assert_eq!(json!(observed.tool.attempt_id), tool["attemptId"]);
        assert_eq!(json!(observed.tool.tool_handle), *handle);
        assert_eq!(json!(observed.tool.unit_ids), row["unitIds"]);
        assert_eq!(json!(observed.input_digest), tool["inputDigest"]);
        assert_eq!(
            json!(observed.item_id),
            before["items"][0]["status"]["itemId"]
        );
        assert_eq!(json!(observed.result_id), result_id);
        assert_eq!(row["storedResultItems"], 1);
        assert_eq!(before["items"][0]["status"]["execution"], "succeeded");
        assert!(
            !fixture
                .app
                .state::<AppState>()
                .sessions
                .with(move |sessions| {
                    sessions
                        .active
                        .as_ref()
                        .unwrap()
                        .execution
                        .as_ref()
                        .unwrap()
                        .runtime
                        .has_owned_attempt_work(tool_attempt)
                })
        );
        let output = fixture
            .call(
                "read_execution_output",
                json!({
                    "attemptId":tool["attemptId"],"resultId":result_id,
                }),
            )
            .unwrap();
        let returned: Value = serde_json::from_str(
            output["plugin"]["result"]["outcome"]["output"]["utf8"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(returned["results"][0]["entries"][0]["value"], "Hello");
        assert_eq!(returned["results"][0]["entries"][0]["note"], "zh-CN");
        Some(output)
    } else {
        assert_eq!(row["storedResultItems"], 0);
        assert!(result_id.is_null());
        assert_eq!(before["items"][0]["status"]["execution"], "dispatched");
        assert!(owned_work(&fixture, plan_id, &[tool_attempt]));
        None
    };
    let before_repeat = fixture.attempt_count();
    assert_eq!(
        fixture.call("start_work_plan", start.clone()).unwrap(),
        json!(parent)
    );
    let mut wrong_start = start.clone();
    wrong_start["expectedGeneration"] = json!("999");
    assert_eq!(
        fixture.call("start_work_plan", wrong_start).unwrap_err()["code"],
        "result-mismatch"
    );
    assert_eq!(fixture.attempt_count(), before_repeat);
    assert_eq!(tool_history(&fixture, &plan, &work), page);
    assert_eq!(
        query_events(&fixture)
            .iter()
            .filter(|event| event["stage"] == "entered")
            .count(),
        1
    );
    assert_eq!(captures(&fixture, &work).len(), 1);
    assert_no_http(&peers);
    // Reconfirm exact ownership immediately before abnormal termination. No
    // other member, query worker or process selected by name is terminated.
    assert_eq!(concurrency::owned_member_pids(&fixture), vec![member_pid]);
    assert!(
        std::process::Command::new("/bin/kill")
            .args(["-KILL", &member_pid.to_string()])
            .output()
            .unwrap()
            .status
            .success()
    );
    drop(release);
    wait_drained(&fixture, plan_id, &[parent, tool_attempt]);
    assert_reaped(member_pid);
    assert_reaped(query_pid);

    let final_page = tool_history(&fixture, &plan, &work);
    assert_eq!(final_page["attempts"][0]["reference"], tool);
    assert_eq!(final_page["attempts"][0]["sequence"], row["sequence"]);
    let final_detail = attempt(&fixture, &tool);
    if pending {
        // The real tool entered before cancellation and supplied no result.
        // Runtime's drained-without-result transition preserves Unknown.
        assert_eq!(
            final_detail["items"][0]["status"]["execution"], "unknown",
            "{final_detail}"
        );
        assert_eq!(final_page["attempts"][0]["storedResultItems"], 0);
        assert_eq!(final_page["attempts"][0]["progress"]["unknown"], 1);
        assert!(final_detail["items"][0]["resultId"].is_null());
        assert_eq!(final_detail["items"][0]["status"]["retrySafe"], false);
        assert!(
            final_detail["recovery"]["units"][0]["actions"]
                .as_array()
                .unwrap()
                .contains(&json!("query-outcome"))
        );
    } else {
        assert_eq!(final_page, page);
        assert_eq!(final_detail["items"][0]["resultId"], result_id);
        assert_eq!(final_detail["items"][0]["status"]["execution"], "succeeded");
    }
    assert_eq!(history(&fixture), before_history);
    assert_eq!(protection(&fixture), before_protection);
    assert_eq!(
        history(&fixture)["current"]["eventId"],
        manual["selection"]["eventId"]
    );
    let final_work = execution(&fixture, &plan);
    assert_eq!(final_work["works"].as_array().unwrap().len(), 1);
    assert_eq!(
        final_work["works"][0]["execution"], "unknown",
        "{final_work}"
    );
    assert!(final_work["works"][0]["candidateRevisionId"].is_null());
    assert_eq!(final_work["budget"]["dispatched"], 1);
    assert_eq!(captures(&fixture, &work).len(), 1);
    let attempts = fixture.attempt_count();
    let events = query_events(&fixture);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["stage"] == "entered")
            .count(),
        1
    );
    assert_no_http(&peers);

    fixture.0.as_mut().unwrap().reopen();
    assert!(!host_exists(&fixture));
    assert_eq!(tool_history(&fixture, &plan, &work), final_page);
    assert_eq!(
        fixture.call("start_work_plan", start).unwrap(),
        json!(parent)
    );
    assert!(
        !host_exists(&fixture),
        "exact historical start acknowledgement restores no Host"
    );
    let task = fixture
        .call("read_execution_task_view", json!({"taskId":tool["taskId"]}))
        .unwrap();
    assert_eq!(task["taskId"], tool["taskId"]);
    let task_attempts = fixture
        .call(
            "read_execution_task",
            json!({
                "taskId":tool["taskId"],"after":"0","limit":16,
            }),
        )
        .unwrap();
    assert_eq!(task_attempts.as_array().unwrap().len(), 1);
    assert_eq!(task_attempts[0]["attemptId"], tool["attemptId"]);
    if let Some(output) = stored {
        assert_eq!(
            fixture
                .call(
                    "read_execution_output",
                    json!({
                        "attemptId":tool["attemptId"],"resultId":result_id,
                    })
                )
                .unwrap(),
            output
        );
    }
    assert!(
        !host_exists(&fixture),
        "these historical reads create no Host"
    );
    assert_eq!(fixture.attempt_count(), attempts);
    assert_eq!(query_events(&fixture), events);
    assert_eq!(captures(&fixture, &work).len(), 1);
    assert_no_http(&peers);

    // The ordinary detail reader creates its existing observation Host. It
    // still has no original monotonic team anchor or execution permission.
    let reopened_detail = attempt(&fixture, &tool);
    assert_eq!(reopened_detail["items"], final_detail["items"]);
    assert!(host_exists(&fixture));
    let state = fixture
        .call(
            "read_work_plan_team_recovery_state",
            json!({"planId":plan["planId"]}),
        )
        .unwrap();
    assert_eq!(state["runtime"]["originalDeadlineAvailable"], false);
    assert_eq!(state["runtime"]["producersDrained"], true);
    assert_eq!(state["hostCallbacksDrained"], true);
    assert_eq!(tool_history(&fixture, &plan, &work), final_page);
    assert_eq!(fixture.attempt_count(), attempts);
    assert_eq!(query_events(&fixture), events);
    assert_eq!(captures(&fixture, &work).len(), 1);
    assert_no_http(&peers);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn pi_team_tool_history_reads_stored_result_after_member_dies_before_delivery() {
    abnormal_member_tool_history(false);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn pi_team_tool_history_keeps_dispatched_without_result_unknown_after_member_death() {
    abnormal_member_tool_history(true);
}
