//! Trusted human messages enter the next original request without waking a member.
use super::*;

fn directed(lease: &Value, member: ExecutionId, role: &Value, target: &Value, body: &str) -> Value {
    json!({"lease":lease,"message":{"messageId":ExecutionId::new(),
        "recipientMemberId":member,"expectedRecipientRoleVersionId":role,
        "target":target,"body":body}})
}

fn has_host(fixture: &Fixture) -> bool {
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(|sessions| sessions.active.as_ref().unwrap().execution.is_some())
}

fn sequence(fixture: &Fixture) -> Value {
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        json!(
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .execution_sequence()
                .unwrap()
        )
    })
}

fn assert_no_http(peers: &[Peer; 3]) {
    for peer in peers {
        assert!(matches!(peer.listener.accept(), Err(error)
            if error.kind()==std::io::ErrorKind::WouldBlock));
    }
}

fn assert_held(http: &Http) {
    http.socket.set_nonblocking(true).unwrap();
    let result = http.socket.peek(&mut [0; 1]);
    http.socket.set_nonblocking(false).unwrap();
    assert!(matches!(result, Err(error)
        if error.kind()==std::io::ErrorKind::WouldBlock));
}

fn control(fixture: &Fixture, plan: &Value, lease: &Value, command: &str) -> Value {
    fixture
        .call(
            "control_work_plan",
            json!({"actionId":ExecutionId::new(),
        "planId":plan["planId"],"expectedGeneration":lease["generation"],"command":command,
        "confirmed":false,"checkerExecutions":[],"toolExecution":false,
        "applicationToolExecutions":[],"expiresAt":null}),
        )
        .unwrap()
}

fn save_human(fixture: &Fixture) -> Value {
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":null,"text":"Protected human wording before directed guidance"}),
        )
        .unwrap()
}

fn assert_ack(recorded: &Value, request: &Value, plan: &Value, root_work: &Value) {
    assert_eq!(recorded["planId"], plan["planId"]);
    for field in ["messageId", "recipientMemberId", "target", "body"] {
        assert_eq!(recorded[field], request["message"][field], "{field}");
    }
    assert_eq!(
        recorded["recipientRoleVersionId"],
        request["message"]["expectedRecipientRoleVersionId"]
    );
    assert_eq!(recorded["sender"]["kind"], "human");
    assert_eq!(recorded["sender"]["actor"], "local-user");
    assert_eq!(recorded["sender"]["binding"]["lease"], request["lease"]);
    assert_eq!(
        recorded["sender"]["binding"]["rootTask"],
        root_work["taskId"]
    );
    assert!(recorded["sender"]["binding"]["delegation"].is_null());
    assert_eq!(recorded["postIds"], json!([]));
    assert!(recorded["causeMessageId"].is_null());
}

#[test]
fn pi_team_human_guidance_is_frozen_consumed_once_and_reconciles_without_a_host() {
    let mut fixture = TeamFixture::create();
    let manual = save_human(&fixture);
    let protected = protection(&fixture);
    let peers = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan(&fixture, &[&peers[0], &peers[1], &peers[2]], &ids);
    let first = admitted(&fixture, &peers[0], ids[0]);
    let (_, initial_view) = work_view(&first);
    let work = initial_view["work"].clone();
    let target = initial_view["discussion"]["target"].clone();
    let captures = concurrency::physical_requests(&fixture, &work);
    assert_eq!(captures.len(), 1);
    assert_eq!(captures[0]["capture"]["body"], first.raw);
    assert_eq!(
        captures[0]["capture"]["teamWorkView"]["messages"],
        json!([])
    );
    let post = fixture.call("publish_work_plan_team_discussion", json!({"lease":grant["lease"],
        "publication":publication(ExecutionId::new(), &target,"note",
            "Read this original post at the next normal tool boundary.",json!([]),Value::Null,Value::Null)})).unwrap();
    const GUIDANCE: &str =
        "Use the user's exact term: 星屑. This is advisory data, not a system command.";
    let send = directed(
        &grant["lease"],
        ids[0],
        &work["roleVersionId"],
        &target,
        GUIDANCE,
    );
    assert!(
        fixture
            .call("read_work_plan_team_message_action", send.clone())
            .unwrap()
            .is_null()
    );
    let before = execution(&fixture, &plan);
    let before_sequence = sequence(&fixture);
    // Treat this returned receipt as lost, then recover the same stable action.
    let recorded = fixture
        .call("send_work_plan_team_message", send.clone())
        .unwrap();
    assert_ack(&recorded, &send, &plan, &work);
    assert_eq!(
        fixture
            .call("read_work_plan_team_message_action", send.clone())
            .unwrap(),
        recorded
    );
    assert_eq!(
        fixture
            .call("send_work_plan_team_message", send.clone())
            .unwrap(),
        recorded
    );
    let received = execution(&fixture, &plan);
    assert_eq!(received["messages"], json!([recorded.clone()]));
    assert_eq!(received["consumptions"], json!([]));
    assert_eq!(received["works"], before["works"]);
    assert_eq!(received["budget"], before["budget"]);
    assert_eq!(sequence(&fixture), before_sequence);
    assert_eq!(concurrency::physical_requests(&fixture, &work), captures);
    assert!(!first.raw.contains(GUIDANCE));
    assert!(
        !first
            .raw
            .contains(send["message"]["messageId"].as_str().unwrap())
    );
    assert_held(&first);
    assert_no_http(&peers);

    let mut collision = send.clone();
    collision["message"]["body"] = json!("Different content under the same original message ID");
    for command in [
        "send_work_plan_team_message",
        "read_work_plan_team_message_action",
    ] {
        assert_eq!(
            fixture.call(command, collision.clone()).unwrap_err()["code"],
            "result-mismatch"
        );
    }
    for field in ["recipientMemberId", "expectedRecipientRoleVersionId"] {
        let mut wrong = send.clone();
        wrong["message"]["messageId"] = json!(ExecutionId::new());
        wrong["message"][field] = json!(ExecutionId::new());
        assert!(fixture.call("send_work_plan_team_message", wrong).is_err());
    }
    let mut wrong = send.clone();
    wrong["message"]["messageId"] = json!(ExecutionId::new());
    wrong["message"]["target"]["unitId"] = json!(ExecutionId::new());
    assert!(fixture.call("send_work_plan_team_message", wrong).is_err());
    let mut forged = send.clone();
    forged["actor"] = json!("another-user");
    assert!(fixture.call("send_work_plan_team_message", forged).is_err());
    let mut wrong = send.clone();
    wrong["projectId"] = json!(ExecutionId::new());
    assert!(fixture.call("send_work_plan_team_message", wrong).is_err());
    let mut wrong = send.clone();
    wrong["message"]["messageId"] = json!(ExecutionId::new());
    wrong["lease"]["generation"] = json!("999");
    assert!(fixture.call("send_work_plan_team_message", wrong).is_err());
    assert_eq!(
        execution(&fixture, &plan)["messages"],
        json!([recorded.clone()])
    );
    assert_no_http(&peers);

    first.tool(
        "read-human-reason-1",
        "read_team_discussion",
        json!({"postId":post["publication"]["postId"]}),
    );
    let second = admitted(&fixture, &peers[0], ids[0]);
    assert_eq!(tool_result(&second.body, "read-human-reason-1"), post);
    assert_eq!(work_view(&second).1["messages"], json!([recorded.clone()]));
    let two = concurrency::physical_requests(&fixture, &work);
    assert_eq!(two.len(), 2);
    assert_eq!(two[0]["requestId"], captures[0]["requestId"]);
    assert_eq!(two[0]["capture"], captures[0]["capture"]);
    assert_eq!(two[1]["capture"]["body"], second.raw);
    let consumed = execution(&fixture, &plan)["consumptions"].clone();
    assert_eq!(consumed.as_array().unwrap().len(), 1);
    assert_eq!(consumed[0]["messageId"], recorded["messageId"]);
    assert_eq!(consumed[0]["taskId"], work["taskId"]);
    assert_eq!(consumed[0]["providerRequestId"], two[1]["requestId"]);
    assert_ne!(consumed[0]["providerRequestId"], captures[0]["requestId"]);
    second.tool(
        "read-human-reason-2",
        "read_team_discussion",
        json!({"postId":post["publication"]["postId"]}),
    );
    let third = admitted(&fixture, &peers[0], ids[0]);
    assert_eq!(tool_result(&third.body, "read-human-reason-1"), post);
    assert_eq!(tool_result(&third.body, "read-human-reason-2"), post);
    assert_eq!(work_view(&third).1["messages"], json!([]));
    assert!(!third.raw.contains(GUIDANCE));
    assert!(
        !third
            .raw
            .contains(send["message"]["messageId"].as_str().unwrap())
    );
    assert_eq!(execution(&fixture, &plan)["consumptions"], consumed);
    third.outcome(translation(
        &fixture,
        "Candidate after one human message consumption",
    ));
    wait_work(&fixture, &plan, &work["attemptId"], true);
    assert_eq!(
        history(&fixture)["current"]["eventId"],
        manual["selection"]["eventId"]
    );
    assert_eq!(protection(&fixture), protected);
    assert_eq!(execution(&fixture, &plan)["budget"]["dispatched"], 3);
    control(&fixture, &plan, &grant["lease"], "stop");
    assert_eq!(
        fixture
            .call("send_work_plan_team_message", send.clone())
            .unwrap(),
        recorded
    );
    fixture.0.as_mut().unwrap().reopen();
    assert!(!has_host(&fixture));
    let before_sequence = sequence(&fixture);
    for command in [
        "read_work_plan_team_message_action",
        "send_work_plan_team_message",
    ] {
        assert_eq!(fixture.call(command, send.clone()).unwrap(), recorded);
        assert!(!has_host(&fixture));
    }
    let mut absent = send.clone();
    absent["message"]["messageId"] = json!(ExecutionId::new());
    assert!(
        fixture
            .call("read_work_plan_team_message_action", absent.clone())
            .unwrap()
            .is_null()
    );
    assert!(!has_host(&fixture));
    let closed = fixture
        .call("send_work_plan_team_message", absent.clone())
        .unwrap_err();
    assert_eq!(closed["code"], "cancelled");
    assert_eq!(closed["stage"], "execution-recover");
    assert_eq!(closed["outcome"], "rejected");
    assert_eq!(closed["reason"], "team-human-message-lease-closed");
    assert!(!has_host(&fixture));
    let mut future = absent;
    future["lease"]["generation"] = json!("999");
    let future = fixture
        .call("send_work_plan_team_message", future)
        .unwrap_err();
    assert_ne!(future["reason"], "team-human-message-lease-closed");
    assert!(!has_host(&fixture));
    assert_eq!(sequence(&fixture), before_sequence);
    assert_eq!(concurrency::physical_requests(&fixture, &work).len(), 3);
    assert_eq!(execution(&fixture, &plan)["consumptions"], consumed);
    assert!(!has_host(&fixture));
    assert_no_http(&peers);
}

#[cfg(all(
    feature = "execution-test-host",
    any(target_os = "macos", target_os = "linux")
))]
fn grant_revoked(fixture: &Fixture, attempt: ExecutionId) -> bool {
    let path = fixture.project_path.clone();
    fixture.app.state::<AppState>().sessions.with(move |_| {
        let connection = rusqlite::Connection::open_with_flags(
            path.join("project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection
            .query_row(
                "SELECT revoked FROM plugin_execution_grants WHERE attempt_id=?1",
                [attempt.to_string()],
                |row| row.get(0),
            )
            .unwrap()
    })
}

#[cfg(all(
    feature = "execution-test-host",
    any(target_os = "macos", target_os = "linux")
))]
fn late_translation(mut http: Http, fixture: &Fixture) -> bool {
    let chunk = json!({"id":"synthetic-late-team-final","object":"chat.completion.chunk",
        "created":1,"model":http.body["model"],"choices":[{"index":0,"delta":{"role":"assistant",
        "content":translation(fixture,"Late valid translation after the original grant was revoked").to_string()},
        "finish_reason":null}]});
    let finish = json!({"id":"synthetic-late-team-final","object":"chat.completion.chunk",
        "created":1,"model":http.body["model"],"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
        "usage":{"prompt_tokens":1,"completion_tokens":1}});
    let body = format!("data: {chunk}\n\ndata: {finish}\n\ndata: [DONE]\n\n");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    match http.socket.write_all(response.as_bytes()) {
        Ok(()) => true,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ) =>
        {
            false
        }
        Err(error) => panic!("late original provider response failed unexpectedly: {error}"),
    }
}

#[cfg(all(
    feature = "execution-test-host",
    any(target_os = "macos", target_os = "linux")
))]
fn control_owned_team(command: &str) {
    let (fixture, selection) = TeamFixture::query(true);
    let manual = save_human(&fixture);
    let before_history = history(&fixture);
    let before_protection = protection(&fixture);
    let peers = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan_with_tools(
        &fixture,
        &[&peers[0], &peers[1], &peers[2]],
        &ids,
        [&["translation"], &["translation"], &["evidence"]],
        Some(&selection),
    );
    let first = admitted(&fixture, &peers[0], ids[0]);
    let initial = work_view(&first).1;
    let work_a = initial["work"].clone();
    let target = initial["discussion"]["target"].clone();
    first.tool(
        "start-translation-peer",
        "request_team_work",
        request(
            ExecutionId::new(),
            ids[1],
            &target,
            "translation",
            &[],
            Value::Null,
        ),
    );
    let next_a = admitted(&fixture, &peers[0], ids[0]);
    let b = admitted(&fixture, &peers[1], ids[1]);
    let work_b = tool_result(&next_a.body, "start-translation-peer");
    assert_eq!(work_view(&b).1["work"], work_b);
    assert_eq!(work_view(&b).1["author"]["memberId"], json!(ids[1]));
    let name = format!(
        "tool_{}",
        selection["entries"][0]["handle"]
            .as_str()
            .unwrap()
            .replace('-', "_")
    );
    next_a.tool("owned-query", &name, json!({"unitId":fixture.unit}));
    let query_pid = tool_history::query_entered(&fixture);
    let tools = tool_history::tool_history(&fixture, &plan, &tool_history::work_reference(&work_a));
    assert_eq!(tools["attempts"].as_array().unwrap().len(), 1);
    let tool = tools["attempts"][0]["reference"].clone();
    assert_eq!(tools["attempts"][0]["storedResultItems"], 0);
    let attempts: [ExecutionId; 3] = [&work_a, &work_b, &tool]
        .map(|work| serde_json::from_value(work["attemptId"].clone()).unwrap());
    let owned = fixture
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
            attempts.map(|attempt| host.runtime.has_owned_attempt_work(attempt))
        });
    assert_eq!(owned, [true, true, true]);
    let members = concurrency::owned_member_pids(&fixture);
    assert_eq!(members.len(), 2);
    assert!(!members.contains(&query_pid));
    assert!(!grant_revoked(&fixture, attempts[2]));
    let captures_a = concurrency::physical_requests(&fixture, &work_a);
    let captures_b = concurrency::physical_requests(&fixture, &work_b);
    assert_eq!(captures_a.len(), 2);
    assert_eq!(captures_b.len(), 1);
    assert_eq!(captures_b[0]["capture"]["body"], b.raw);
    assert_eq!(captures_b[0]["state"], "unknown");
    assert_held(&b);
    let before = execution(&fixture, &plan);
    assert_eq!(before["budget"]["dispatched"], 3);
    assert_eq!(before["works"].as_array().unwrap().len(), 2);
    assert_eq!(before["consumptions"], json!([]));
    let original_sequence = sequence(&fixture);
    let send = directed(
        &grant["lease"],
        ids[0],
        &work_a["roleVersionId"],
        &target,
        "Retain this human reason through control of the original producers.",
    );
    let recorded = fixture
        .call("send_work_plan_team_message", send.clone())
        .unwrap();
    assert_ack(&recorded, &send, &plan, &work_a);
    assert_eq!(
        concurrency::physical_requests(&fixture, &work_a),
        captures_a
    );
    assert_no_http(&peers);

    let io = fixture.app.state::<AppState>().io.clone();
    let mut held = SaturatedIo::hold(&io);
    assert!(!grant_revoked(&fixture, attempts[2]));
    let receipt = held
        .call_once(
            &fixture,
            "control_work_plan",
            json!({
                "actionId":ExecutionId::new(),"planId":plan["planId"],
                "expectedGeneration":grant["lease"]["generation"],"command":command,
                "confirmed":false,"checkerExecutions":[],"toolExecution":false,
                "applicationToolExecutions":[],"expiresAt":null
            }),
        )
        .unwrap();
    let expected_state = if command == "stop" {
        "stopped"
    } else {
        "taken-over"
    };
    assert_eq!(receipt["state"], expected_state);
    assert_ne!(receipt["lease"], grant["lease"]);
    assert!(grant_revoked(&fixture, attempts[2]));
    held.assert_full(&io);
    let mut late = send.clone();
    late["message"]["messageId"] = json!(ExecutionId::new());
    let closed = fixture
        .call("send_work_plan_team_message", late.clone())
        .unwrap_err();
    assert_eq!(closed["code"], "cancelled");
    assert_eq!(closed["reason"], "team-human-message-lease-closed");
    assert!(
        fixture
            .call("read_work_plan_team_message_action", late)
            .unwrap()
            .is_null()
    );
    assert_eq!(
        fixture
            .call("read_work_plan_team_message_action", send.clone())
            .unwrap(),
        recorded
    );
    assert_eq!(
        fixture
            .call("send_work_plan_team_message", send.clone())
            .unwrap(),
        recorded
    );
    // A successful socket write is not proof the cancelled Core transport read it.
    let sent = late_translation(b, &fixture);
    eprintln!("team control={command} late_original_response_write_completed={sent}");
    held.assert_full(&io);
    // The control receipt proves revocation; producer drain is checked separately.
    drop(held);
    let plan_id = serde_json::from_value(plan["planId"].clone()).unwrap();
    tool_history::wait_drained(&fixture, plan_id, &attempts);
    for pid in members.into_iter().chain([query_pid]) {
        tool_history::assert_reaped(pid);
    }
    let state = fixture
        .call(
            "read_work_plan_team_recovery_state",
            json!({"planId":plan["planId"]}),
        )
        .unwrap();
    assert_eq!(state["state"]["state"], expected_state);
    assert_eq!(state["hostCallbacksDrained"], true);
    assert_eq!(state["runtime"]["producersDrained"], true);
    assert_eq!(state["state"]["activations"], 2);
    let after = execution(&fixture, &plan);
    assert_eq!(after["works"].as_array().unwrap().len(), 2);
    assert!(
        after["works"]
            .as_array()
            .unwrap()
            .iter()
            .all(|work| work["candidateRevisionId"].is_null())
    );
    assert_eq!(after["messages"], json!([recorded.clone()]));
    assert_eq!(after["consumptions"], json!([]));
    assert_eq!(after["budget"]["dispatched"], 3);
    assert_eq!(
        concurrency::physical_requests(&fixture, &work_a),
        captures_a
    );
    let final_b = concurrency::physical_requests(&fixture, &work_b);
    assert_eq!(final_b.len(), 1);
    assert_eq!(final_b[0]["requestId"], captures_b[0]["requestId"]);
    assert_eq!(final_b[0]["capture"], captures_b[0]["capture"]);
    assert_eq!(sequence(&fixture), original_sequence);
    assert_eq!(history(&fixture), before_history);
    assert_eq!(
        history(&fixture)["current"]["eventId"],
        manual["selection"]["eventId"]
    );
    assert_eq!(protection(&fixture), before_protection);
    let final_tools =
        tool_history::tool_history(&fixture, &plan, &tool_history::work_reference(&work_a));
    assert_eq!(final_tools["attempts"].as_array().unwrap().len(), 1);
    assert_eq!(final_tools["attempts"][0]["reference"], tool);
    assert_eq!(final_tools["attempts"][0]["storedResultItems"], 0);
    assert_eq!(
        tool_history::query_events(&fixture)
            .iter()
            .filter(|event| event["stage"] == "entered")
            .count(),
        1
    );
    assert_no_http(&peers);
}

#[cfg(all(
    feature = "execution-test-host",
    any(target_os = "macos", target_os = "linux")
))]
#[test]
fn pi_team_stop_revokes_guidance_and_drains_both_members_and_the_real_sdk_tool() {
    control_owned_team("stop");
}

#[cfg(all(
    feature = "execution-test-host",
    any(target_os = "macos", target_os = "linux")
))]
#[test]
fn pi_team_take_over_revokes_guidance_and_drains_both_members_and_the_real_sdk_tool() {
    control_owned_team("take-over");
}
