//! Registered human continuation uses actual Pi and the original execution owner.
use super::*;

fn state(fixture: &Fixture, plan: &Value) -> Value {
    fixture
        .call(
            "read_work_plan_team_recovery_state",
            json!({"planId":plan["planId"]}),
        )
        .unwrap()
}
fn pause(fixture: &Fixture, plan: &Value, generation: &Value) -> Value {
    fixture
        .call(
            "control_work_plan",
            json!({"actionId":ExecutionId::new(),"planId":plan["planId"],
        "expectedGeneration":generation,"command":"pause","confirmed":false,"checkerExecutions":[],
        "toolExecution":false,"applicationToolExecutions":[],"expiresAt":null}),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = state(fixture, plan);
        assert_eq!(view["state"]["state"], "paused");
        assert_eq!(view["runtime"]["originalDeadlineAvailable"], true);
        if view["runtime"]["producersDrained"] == true && view["hostCallbacksDrained"] == true {
            return view;
        }
        assert!(Instant::now() < deadline, "{view}");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn prepare_request(
    fixture: &Fixture,
    plan: &Value,
    state: &Value,
    members: Value,
    member: ExecutionId,
    target: &Value,
    posts: Value,
) -> Value {
    json!({"preparationId":ExecutionId::new(),"recovery":{"projectId":fixture.context["projectId"],
        "planId":plan["planId"],"expectedLease":state["state"]["lease"],
        "expectedEffectiveVersion":state["state"]["effectiveVersion"],"members":members,
        "work":{"workId":ExecutionId::new(),"memberId":member,"target":target,"kind":"translation",
            "instructions":"Human explicitly requests a fresh candidate from this captured member.","postIds":posts,
            "priorWork":state["state"]["unresolvedWork"]}}})
}
fn authorization(plan: &Value, prepared: &Value) -> Value {
    json!({"preparationId":prepared["preparationId"],"planId":plan["planId"],
        "recovery":{"actionId":ExecutionId::new(),"digest":prepared["preview"]["digest"],"confirmed":true,
            "effects":["save-candidate","publish-discussion","dispatch-team-work","send-team-message"]},
        "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]})
}

#[test]
fn pi_team_human_recovery_recaptures_members_and_starts_one_original_budget_child() {
    let mut fixture = TeamFixture::create();
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,
        "locale":"zh-CN","sourceRevisionId":fixture.source_revision,"expectedSelectionId":null,
        "text":"Protected human choice"}),
        )
        .unwrap();
    let manual = history(&fixture);
    let protected = protection(&fixture);
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan(&fixture, &[&a, &b, &c], &ids);
    let first = admitted(&fixture, &a, ids[0]);
    let target = work_view(&first).1["discussion"]["target"].clone();
    let post = ExecutionId::new();
    first.tool(
        "original-reason",
        "publish_team_discussion",
        publication(
            post,
            &target,
            "note",
            "Original author and reason must survive a new roster.",
            json!([]),
            Value::Null,
            Value::Null,
        ),
    );
    admitted(&fixture, &a, ids[0]).outcome(translation(&fixture, "Original team candidate"));
    let original = wait_work(&fixture, &plan, &plan["attemptId"], true);
    let paused = pause(&fixture, &plan, &grant["lease"]["generation"]);
    assert_eq!(paused["state"]["activations"], 1);
    assert_eq!(paused["state"]["unconfirmedCompletions"], 1);
    assert_eq!(paused["state"]["budget"]["dispatched"], 2);
    let original_deadline = paused["state"]["expiresAtMs"].clone();
    let mut d = Peer::new();
    d.config.model = "synthetic-new-approved-destination".into();
    d.config.share_context = false;
    let new_id = ExecutionId::new();
    let mut members = plan["options"]["teamExecution"]["members"].clone();
    members[0]["roleVersionId"] = json!(ExecutionId::new());
    members[0]["displayName"] = json!("Revised original member");
    members[0]["role"] = json!("A newly approved role version");
    members[1] = json!({"memberId":new_id,"roleVersionId":ExecutionId::new(),"displayName":"New member",
        "role":"Only the newly captured work", "config":d.config,"unitIds":[fixture.unit],"toolHandles":[],"kinds":["translation"]});
    let capture_request = prepare_request(
        &fixture,
        &plan,
        &paused,
        members.clone(),
        new_id,
        &target,
        json!([post]),
    );
    let capture = fixture
        .call("prepare_work_plan_team_recovery", capture_request.clone())
        .unwrap();
    assert_eq!(capture["preview"]["members"], members);
    assert_eq!(capture["preview"]["retiredMemberIds"], json!([ids[1]]));
    assert_eq!(capture["preview"]["expiresAtMs"], original_deadline);
    assert_eq!(
        capture["preview"]["memberPreviews"][1]["preview"]["config"],
        json!(d.config)
    );
    assert_eq!(
        capture["preview"]["memberPreviews"][1]["preview"]["items"][0]["sourceText"],
        "Hello"
    );
    let shared = capture["preview"]["discussionPreviews"].as_array().unwrap();
    let shared = shared
        .iter()
        .find(|view| view["memberId"] == json!(new_id))
        .unwrap();
    assert_eq!(shared["posts"][0]["publication"]["postId"], json!(post));
    assert_eq!(shared["posts"][0]["author"]["kind"], "member");
    let original_author = &shared["posts"][0]["author"]["author"];
    assert_eq!(original_author["memberId"], json!(ids[0]));
    assert_eq!(
        original_author["roleVersionId"],
        plan["options"]["teamExecution"]["members"][0]["roleVersionId"]
    );
    assert_eq!(original_author["attemptId"], plan["attemptId"]);
    assert_eq!(original_author["binding"]["lease"], grant["lease"]);
    assert_eq!(
        original_author["binding"]["rootTask"],
        original["receipt"]["taskId"]
    );
    let approve = authorization(&plan, &capture);
    let mut invalid = approve.clone();
    invalid["toolExecution"] = json!(true);
    assert!(
        fixture
            .call("authorize_work_plan_team_recovery", invalid)
            .is_err()
    );
    let receipt = fixture
        .call("authorize_work_plan_team_recovery", approve.clone())
        .unwrap();
    let action = fixture
        .call("read_work_plan_team_recovery_action", approve.clone())
        .unwrap();
    assert_eq!(action["receipt"], receipt);
    assert!(action["request"].get("preparationId").is_none());
    assert_eq!(
        fixture
            .call("authorize_work_plan_team_recovery", approve.clone())
            .unwrap(),
        receipt
    );
    assert!(
        matches!(d.listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
    let mut changed = approve.clone();
    changed["recovery"]["confirmed"] = json!(false);
    assert!(
        fixture
            .call("read_work_plan_team_recovery_action", changed)
            .is_err()
    );
    let mut changed = approve.clone();
    changed["toolExecution"] = json!(true);
    assert!(
        fixture
            .call("read_work_plan_team_recovery_action", changed)
            .is_err()
    );
    let start = json!({"planId":plan["planId"],"actionId":receipt["actionId"],
        "expectedGeneration":receipt["effectiveVersion"]["lease"]["generation"]});
    assert!(
        fixture
            .call("read_work_plan_start_action", start.clone())
            .unwrap()
            .is_null()
    );
    assert_eq!(
        fixture.call("start_work_plan", start.clone()).unwrap(),
        receipt["attemptId"]
    );
    let mut wrong = start.clone();
    wrong["expectedGeneration"] = json!("9999");
    assert!(fixture.call("start_work_plan", wrong).is_err());
    let mut wrong = start.clone();
    wrong["planId"] = json!(ExecutionId::new());
    assert!(fixture.call("start_work_plan", wrong).is_err());
    let resumed = admitted(&fixture, &d, new_id);
    // The physical request is held open while the original work owns its loop.
    // A repeated start acknowledges that exact enqueue without a new admission.
    assert_eq!(
        fixture.call("start_work_plan", start.clone()).unwrap(),
        receipt["attemptId"]
    );
    let inflight = execution(&fixture, &plan);
    assert_eq!(inflight["works"].as_array().unwrap().len(), 2);
    assert_eq!(inflight["budget"]["dispatched"], 3);
    assert_eq!(captures(&fixture, &work_view(&resumed).1["work"]).len(), 1);
    assert!(
        matches!(d.listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
    assert!(
        resumed
            .raw
            .contains("Human explicitly requests a fresh candidate")
    );
    assert_eq!(work_view(&resumed).1["messages"], json!([]));
    resumed.outcome(translation(&fixture, "New explicitly authorized candidate"));
    let completed = wait_work(&fixture, &plan, &receipt["attemptId"], true);
    assert_ne!(
        completed["candidateRevisionId"],
        original["candidateRevisionId"]
    );
    assert_eq!(completed["origin"]["kind"], "human-continuation");
    let started = fixture
        .call("read_work_plan_start_action", start.clone())
        .unwrap();
    assert_eq!(started["taskId"], receipt["taskId"]);
    assert_eq!(started["attemptId"], receipt["attemptId"]);
    let view = execution(&fixture, &plan);
    assert_eq!(view["works"].as_array().unwrap().len(), 2);
    assert_eq!(view["roster"], members);
    assert_eq!(view["retiredMemberIds"], json!([ids[1]]));
    assert_eq!(history(&fixture)["current"], manual["current"]);
    assert_eq!(history(&fixture)["currentText"], manual["currentText"]);
    assert_eq!(protection(&fixture), protected);
    let paused_again = pause(
        &fixture,
        &plan,
        &receipt["effectiveVersion"]["lease"]["generation"],
    );
    assert_eq!(paused_again["state"]["expiresAtMs"], original_deadline);
    assert_eq!(paused_again["state"]["activations"], 2);
    assert_eq!(paused_again["state"]["unconfirmedCompletions"], 2);
    assert_eq!(paused_again["state"]["budget"]["dispatched"], 3);
    fixture.0.as_mut().unwrap().reopen();
    assert!(state(&fixture, &plan)["runtime"].is_null());
    assert_eq!(
        fixture
            .call("read_work_plan_team_recovery_action", approve.clone())
            .unwrap()["receipt"],
        receipt
    );
    assert_eq!(
        fixture
            .call("authorize_work_plan_team_recovery", approve)
            .unwrap(),
        receipt
    );
    assert_eq!(
        fixture.call("start_work_plan", start).unwrap(),
        receipt["attemptId"]
    );
    assert!(
        state(&fixture, &plan)["runtime"].is_null(),
        "historical acknowledgements cannot recreate a Host"
    );
    let next = prepare_request(
        &fixture,
        &plan,
        &state(&fixture, &plan),
        members,
        new_id,
        &target,
        json!([post]),
    );
    assert!(
        fixture
            .call("prepare_work_plan_team_recovery", next)
            .is_err()
    );
}

#[test]
fn pi_team_recovery_rejects_a_terminal_parent_until_its_host_query_thread_is_joined() {
    let fixture = TeamFixture::create();
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan(&fixture, &[&a, &b, &c], &ids);
    let first = admitted(&fixture, &a, ids[0]);
    let target = work_view(&first).1["discussion"]["target"].clone();
    first.outcome(translation(
        &fixture,
        "A terminal parent still has an owned callback",
    ));
    wait_work(&fixture, &plan, &plan["attemptId"], true);
    let paused = pause(&fixture, &plan, &grant["lease"]["generation"]);
    let (release, held) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        held.recv_timeout(Duration::from_secs(30)).unwrap();
    });
    let plan_id: ExecutionId = serde_json::from_value(plan["planId"].clone()).unwrap();
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
            host.retired_queries
                .push(package_lifecycle::RetiredQuery::from_test_thread(
                    plan_id, worker,
                ));
        });
    let request = prepare_request(
        &fixture,
        &plan,
        &paused,
        plan["options"]["teamExecution"]["members"].clone(),
        ids[0],
        &target,
        json!([]),
    );
    let observing = state(&fixture, &plan);
    assert_eq!(
        observing["runtime"]["producersDrained"], true,
        "Core producers have actually drained"
    );
    assert_eq!(
        observing["hostCallbacksDrained"], false,
        "the original Host still owns its retired query thread"
    );
    let denied = fixture
        .call("prepare_work_plan_team_recovery", request.clone())
        .unwrap_err();
    assert_eq!(denied["code"], "busy");
    assert_eq!(denied["reason"], "team-recovery-host-draining");
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while state(&fixture, &plan)["hostCallbacksDrained"] != true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    let prepared = fixture
        .call("prepare_work_plan_team_recovery", request)
        .unwrap();
    assert_eq!(prepared["preview"]["activations"], 1);
    assert!(
        matches!(a.listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn pi_team_recovery_old_captures_reject_settings_changes_newer_preparations_and_source_changes() {
    let fixture = TeamFixture::create();
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan(&fixture, &[&a, &b, &c], &ids);
    let first = admitted(&fixture, &a, ids[0]);
    let target = work_view(&first).1["discussion"]["target"].clone();
    first.outcome(translation(&fixture, "Original fixed source"));
    wait_work(&fixture, &plan, &plan["attemptId"], true);
    let paused = pause(&fixture, &plan, &grant["lease"]["generation"]);
    let request = prepare_request(
        &fixture,
        &plan,
        &paused,
        plan["options"]["teamExecution"]["members"].clone(),
        ids[0],
        &target,
        json!([]),
    );
    let capture_a = fixture
        .call("prepare_work_plan_team_recovery", request.clone())
        .unwrap();
    let approve_a = authorization(&plan, &capture_a);
    let inventory = call(&fixture.webview, "read_plugin_inventory", json!({})).unwrap();
    let native = tsumugi_plugin_host::CapturedNativeRuntime::inspect_current().unwrap();
    call(&fixture.webview, "set_plugin_native_host_approval", json!({"environmentDigest":native.digest().unwrap(),
        "approved":true,"expectedRevision":inventory["settingsRevision"],"actionId":ExecutionId::new()})).unwrap();
    assert!(
        fixture
            .call("authorize_work_plan_team_recovery", approve_a.clone())
            .is_err()
    );
    assert!(
        fixture
            .call("read_work_plan_team_recovery_action", approve_a.clone())
            .unwrap()
            .is_null()
    );
    assert_eq!(
        fixture
            .call("end_work_plan_team_recovery", approve_a.clone())
            .unwrap()["kind"],
        "preparation-closed"
    );
    let mut request_b = request;
    request_b["preparationId"] = json!(ExecutionId::new());
    request_b["recovery"]["work"]["workId"] = json!(ExecutionId::new());
    request_b["recovery"]["work"]["instructions"] =
        json!("A newer human draft must retain its own captured identity.");
    let capture_b = fixture
        .call("prepare_work_plan_team_recovery", request_b)
        .unwrap();
    assert_ne!(
        capture_b["preview"]["digest"],
        capture_a["preview"]["digest"]
    );
    assert!(
        fixture
            .call("authorize_work_plan_team_recovery", approve_a)
            .is_err()
    );
    let approve_b = authorization(&plan, &capture_b);
    Fixture::capture_source(
        &fixture.app,
        br#"{"first":"A changed source after preview"}"#.to_vec(),
    );
    assert!(
        fixture
            .call("authorize_work_plan_team_recovery", approve_b.clone())
            .is_err()
    );
    assert!(
        fixture
            .call("read_work_plan_team_recovery_action", approve_b.clone())
            .unwrap()
            .is_null()
    );
    assert_eq!(
        fixture
            .call("end_work_plan_team_recovery", approve_b)
            .unwrap()["kind"],
        "preparation-closed"
    );
    let view = execution(&fixture, &plan);
    assert_eq!(view["works"].as_array().unwrap().len(), 1);
    assert_eq!(view["budget"]["dispatched"], 1);
    assert!(
        matches!(a.listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
}

#[test]
fn pi_team_recovery_end_revokes_late_authorization_and_preserves_a_newer_capture() {
    let fixture = TeamFixture::create();
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan(&fixture, &[&a, &b, &c], &ids);
    let first = admitted(&fixture, &a, ids[0]);
    let target = work_view(&first).1["discussion"]["target"].clone();
    first.outcome(translation(&fixture, "Original before a local close"));
    wait_work(&fixture, &plan, &plan["attemptId"], true);
    let paused = pause(&fixture, &plan, &grant["lease"]["generation"]);
    let capture_request = prepare_request(
        &fixture,
        &plan,
        &paused,
        plan["options"]["teamExecution"]["members"].clone(),
        ids[0],
        &target,
        json!([]),
    );
    let capture_a = fixture
        .call("prepare_work_plan_team_recovery", capture_request.clone())
        .unwrap();
    let approve_a = authorization(&plan, &capture_a);
    let (reached, observing) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution
                .as_mut()
                .unwrap()
                .work_plans
                .recovery_authorize_probe = Some(generation::CaptureProbe::new(reached, held));
        });
    let window = fixture.webview.clone();
    let mut wire = approve_a.clone();
    wire["sessionToken"] = fixture.context["sessionToken"].clone();
    wire["projectId"] = fixture.context["projectId"].clone();
    let late = std::thread::spawn(move || call(&window, "authorize_work_plan_team_recovery", wire));
    observing
        .recv_timeout(Duration::from_secs(5))
        .expect("original authorization IO must finish before closure");
    let closed = fixture
        .call("end_work_plan_team_recovery", approve_a.clone())
        .unwrap();
    assert_eq!(closed["kind"], "preparation-closed");
    assert_eq!(closed["preparationId"], approve_a["preparationId"]);
    assert_eq!(closed["request"]["recovery"], approve_a["recovery"]);
    release.send(()).unwrap();
    assert!(
        late.join().unwrap().is_err(),
        "the original stopped continuation cannot commit"
    );
    assert!(
        fixture
            .call("read_work_plan_team_recovery_action", approve_a.clone())
            .unwrap()
            .is_null()
    );
    assert_eq!(state(&fixture, &plan)["state"]["state"], "paused");
    let mut next = capture_request;
    // Reusing a local UI identity cannot make the old digest own the new slot.
    next["recovery"]["work"]["workId"] = json!(ExecutionId::new());
    next["recovery"]["work"]["instructions"] =
        json!("The newer human draft remains available after closing the old draft.");
    let capture_b = fixture
        .call("prepare_work_plan_team_recovery", next)
        .unwrap();
    assert_eq!(capture_b["preparationId"], capture_a["preparationId"]);
    assert_ne!(
        capture_b["preview"]["digest"],
        capture_a["preview"]["digest"]
    );
    assert_eq!(
        fixture
            .call("end_work_plan_team_recovery", approve_a)
            .unwrap()["kind"],
        "preparation-closed"
    );
    let approve_b = authorization(&plan, &capture_b);
    let receipt = fixture
        .call("authorize_work_plan_team_recovery", approve_b.clone())
        .unwrap();
    let mut other_action = approve_b.clone();
    other_action["recovery"]["actionId"] = json!(ExecutionId::new());
    assert_eq!(
        fixture
            .call("end_work_plan_team_recovery", other_action)
            .unwrap()["kind"],
        "preparation-closed"
    );
    let recorded = fixture
        .call("end_work_plan_team_recovery", approve_b.clone())
        .unwrap();
    assert_eq!(recorded["kind"], "authorization-recorded");
    assert_eq!(recorded["action"]["receipt"], receipt);
    assert!(
        matches!(a.listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
        "closing an accepted action does not start it"
    );
    let start = json!({"planId":plan["planId"],"actionId":receipt["actionId"],
        "expectedGeneration":receipt["effectiveVersion"]["lease"]["generation"]});
    assert_eq!(
        fixture.call("start_work_plan", start).unwrap(),
        receipt["attemptId"],
        "accepted closure must not clear the original local authority"
    );
    admitted(&fixture, &a, ids[0]).outcome(translation(
        &fixture,
        "Only the newer explicitly started candidate",
    ));
    wait_work(&fixture, &plan, &receipt["attemptId"], true);
    assert_eq!(
        execution(&fixture, &plan)["works"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
