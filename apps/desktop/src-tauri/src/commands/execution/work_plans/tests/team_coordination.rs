//! Synthetic providers choose the work graph through actual Pi tool calls.
use super::*;
#[path = "team_recovery.rs"]
mod recovery;
#[path = "team_concurrency.rs"]
mod concurrency;
#[path = "team_tool_history.rs"]
#[cfg(feature = "execution-test-host")]
mod tool_history;

struct TeamFixture(
    Option<Fixture>,
    Option<crate::commands::execution::test_fixtures::OwnedDirectory>,
);
impl TeamFixture {
    fn create() -> Self {
        let fixture = Fixture::create();
        let runtime = crate::commands::execution::test_fixtures::provision_member_runtime(
            &fixture.app.state::<AppState>().plugins,
            &fixture.directory.path().join("member-resources"),
        );
        Self(Some(fixture), Some(runtime))
    }
    #[cfg(feature = "execution-test-host")]
    fn query(pending: bool) -> (Self, Value) {
        let (fixture, installation, selection) =
            super::super::generation_tests::prepared_tool_services::team_query_fixture(pending);
        (Self(Some(fixture), Some(installation)), selection)
    }
}
impl std::ops::Deref for TeamFixture {
    type Target = Fixture;
    fn deref(&self) -> &Fixture {
        self.0.as_ref().unwrap()
    }
}
impl Drop for TeamFixture {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.app.state::<AppState>().sessions.with(|sessions| {
                    let Some(active) = sessions.active.as_mut() else {
                        return Ok(true);
                    };
                    let Some(host) = active.execution.as_mut() else {
                        return Ok(true);
                    };
                    if !host.quiescing {
                        host.begin_quiesce(&mut active.store)?;
                    }
                    host.tick(&mut active.store)?;
                    if host.quiescing {
                        return Ok::<_, CommandError>(false);
                    }
                    // Host completion has joined the original Runtime producers
                    // and candidate computations before its resources disappear.
                    active.execution.take();
                    Ok(true)
                })
            }));
            if matches!(result, Ok(Ok(true))) {
                return;
            }
            if result.is_err() || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let fixture = self.0.take().unwrap();
        let path = fixture.directory.keep();
        // Unconfirmed producers retain their original owners. Keeping the
        // synthetic project also prevents polling a deleted rollback journal.
        std::mem::forget(fixture.webview);
        std::mem::forget(fixture.app);
        std::mem::forget(self.1.take());
        eprintln!(
            "team test cleanup unconfirmed; retained synthetic project at {}",
            path.display()
        );
        if !std::thread::panicking() {
            panic!("team fixture did not confirm producer drain");
        }
    }
}

impl Http {
    fn outcome(self, output: Value) {
        assert_eq!(self.body["stream"], true);
        let chunk = json!({"id":"synthetic-team-final","object":"chat.completion.chunk",
            "created":1,"model":self.body["model"],"choices":[{"index":0,
            "delta":{"role":"assistant","content":output.to_string()},"finish_reason":null}]});
        let finish = json!({"id":"synthetic-team-final","object":"chat.completion.chunk",
            "created":1,"model":self.body["model"],"choices":[{"index":0,"delta":{},
            "finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}});
        self.respond(
            "text/event-stream",
            format!("data: {chunk}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
        );
    }
}

fn work_view(http: &Http) -> (String, Value) {
    let views: Vec<_> = http.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| {
            if m["role"] != "user" {
                return None;
            }
            let text = m["content"].as_str()?;
            let value: Value = serde_json::from_str(text).ok()?;
            (value["kind"] == "untrusted-team-work").then(|| (text.to_owned(), value))
        })
        .collect();
    assert_eq!(views.len(), 1);
    views.into_iter().next().unwrap()
}

fn captures(fixture: &Fixture, work: &Value) -> Vec<Value> {
    let project_path = fixture.project_path.clone();
    let attempt = work["attemptId"].as_str().unwrap().to_owned();
    // The rollback-journal fixture read must not compete with this owner's
    // concurrent writes. Keep the same SQL and assertions on its command lane.
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |_sessions| super::capture_rows(&project_path, &attempt))
}

fn admitted(fixture: &Fixture, peer: &Peer, member: ExecutionId) -> Http {
    static NEXT_REQUEST: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    let ordinal = NEXT_REQUEST.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    eprintln!(
        "team test awaiting request={ordinal} member={member} model={}",
        peer.config.model
    );
    let http = peer.accept();
    eprintln!(
        "team test received request={ordinal} member={member} model={}",
        peer.config.model
    );
    assert_eq!(http.body["model"], peer.config.model);
    let (utf8, view) = work_view(&http);
    assert_eq!(view["work"]["memberId"], json!(member));
    assert_eq!(view["author"]["memberId"], json!(member));
    assert_eq!(view["recipients"].as_array().unwrap().len(), 3);
    let rows = captures(fixture, &view["work"]);
    let capture = rows.last().unwrap();
    assert_eq!(capture["body"], http.raw);
    assert_eq!(capture["teamWorkView"], view);
    assert!(capture["teamView"].is_null());
    let typed: tsumugi_core::application::TeamWorkRequestView =
        serde_json::from_value(view).unwrap();
    assert_eq!(serde_json::to_string(&typed).unwrap(), utf8);
    assert!(
        http.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == "request_team_work")
    );
    assert!(
        http.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == "send_team_message")
    );
    http
}

fn execution(fixture: &Fixture, plan: &Value) -> Value {
    fixture
        .call(
            "read_work_plan_team_execution",
            json!({"planId":plan["planId"],
        "afterWork":null,"afterMessage":null,"limit":16}),
        )
        .unwrap()
}

fn wait_work(fixture: &Fixture, plan: &Value, attempt: &Value, candidate: bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view = execution(fixture, plan);
        if let Some(work) = view["works"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["receipt"]["attemptId"] == *attempt)
        {
            assert_ne!(work["validation"], "invalid", "{view}");
            if work["execution"] == "succeeded"
                && work["validation"] == "valid"
                && (!candidate || work["candidateRevisionId"].is_string())
            {
                return work.clone();
            }
            assert!(Instant::now() < deadline, "{view}");
        } else {
            assert!(Instant::now() < deadline, "{view}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn team_plan(fixture: &Fixture, peers: &[&Peer; 3], ids: &[ExecutionId; 3]) -> (Value, Value) {
    team_plan_with_kinds(fixture, peers, ids, [&["translation"], &["review"], &["evidence"]])
}

fn team_plan_with_kinds(
    fixture: &Fixture,
    peers: &[&Peer; 3],
    ids: &[ExecutionId; 3],
    kinds: [&[&str]; 3],
) -> (Value, Value) {
    team_plan_with_tools(fixture, peers, ids, kinds, None)
}

fn team_plan_with_tools(
    fixture: &Fixture,
    peers: &[&Peer; 3],
    ids: &[ExecutionId; 3],
    kinds: [&[&str]; 3],
    tool_selection: Option<&Value>,
) -> (Value, Value) {
    let handles: Vec<_> = tool_selection.into_iter().flat_map(|selection| {
        selection["entries"].as_array().unwrap().iter().map(|entry| entry["handle"].clone())
    }).collect();
    let members: Vec<_> = peers.iter().enumerate().map(|(index, peer)| json!({
        "memberId":ids[index],"roleVersionId":ExecutionId::new(),
        "displayName":format!("Member {}", index + 1),"role":format!("Captured role {}", index + 1),
        "config":peer.config,"unitIds":[fixture.unit],"toolHandles":if index==0 { handles.clone() } else { Vec::new() },
        "kinds":kinds[index]
    })).collect();
    let mut options = serde_json::to_value(PlanOptions::default()).unwrap();
    options["teamDiscussions"] = json!({"profile":"current-plan-2"});
    options["teamExecution"] = json!({"profile":"bounded-team-1","initialMemberId":ids[0],
        "initialUnitId":fixture.unit,"members":members,
        "limits":{"maxActivations":12,"maxConcurrency":2,"maxNoProgress":8}});
    let mut root = peers[0].config.clone();
    root.max_requests = 40;
    let plan = fixture
        .call(
            "prepare_work_plan",
            json!({"config":root,"locale":"zh-CN",
        "unitIds":[fixture.unit],"options":options,"advisoryChecks":[],"toolSelection":tool_selection}),
        )
        .unwrap();
    let previews = plan["memberPreviews"].as_array().unwrap();
    assert_eq!(previews.len(), 3);
    for (index, preview) in previews.iter().enumerate() {
        assert_eq!(preview["memberId"], json!(ids[index]));
        assert_eq!(preview["preview"]["config"], json!(peers[index].config));
        assert_eq!(preview["preview"]["items"][0]["sourceText"], "Hello");
    }
    let mut effects = vec!["save-candidate", "publish-discussion", "dispatch-team-work", "send-team-message"];
    let mut application_executions: Vec<Value> = Vec::new();
    if tool_selection.is_some() {
        effects.push("query-tools");
        for tool in plan["tools"]["entries"].as_array().unwrap() {
            let basis = &tool["execution"]["applicationScope"];
            if !basis.is_null() && !application_executions.contains(basis) {
                application_executions.push(basis.clone());
            }
        }
    }
    let grant = fixture.call("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],
        "actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),
        "toolExecution":tool_selection.is_some(),"applicationToolExecutions":application_executions,
        "effects":effects,"expiresAt":expiry()})).unwrap();
    let start = json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]});
    assert_eq!(
        fixture.call("start_work_plan", start.clone()).unwrap(),
        plan["attemptId"]
    );
    assert_eq!(
        fixture
            .call("read_work_plan_start_action", start.clone())
            .unwrap()["attemptId"],
        plan["attemptId"]
    );
    assert_eq!(
        fixture.call("start_work_plan", start).unwrap(),
        plan["attemptId"]
    );
    (plan, grant)
}

fn peers() -> [Peer; 3] {
    std::array::from_fn(|index| {
        let mut peer = Peer::new();
        peer.config.model = format!("synthetic-captured-model-{}", index + 1);
        peer.config.max_requests = 8;
        peer.config.share_context = index == 0;
        peer
    })
}

fn publication(
    id: ExecutionId,
    target: &Value,
    kind: &str,
    body: &str,
    references: Value,
    reply: Value,
    supersedes: Value,
) -> Value {
    json!({"postId":id,"target":target,"kind":kind,"body":body,"references":references,
        "replyTo":reply,"supersedes":supersedes})
}
fn request(
    id: ExecutionId,
    recipient: ExecutionId,
    target: &Value,
    kind: &str,
    posts: &[ExecutionId],
    cause: Value,
) -> Value {
    json!({"intentId":id,"recipientMemberId":recipient,"target":target,"kind":kind,
        "instructions":"Read the original cited reasons and perform the captured work.","postIds":posts,"causeMessageId":cause})
}
fn message(
    id: ExecutionId,
    recipient: ExecutionId,
    target: &Value,
    posts: &[ExecutionId],
) -> Value {
    json!({"messageId":id,"recipientMemberId":recipient,"target":target,
        "body":"The original cited reason needs another work activation.","postIds":posts,"causeMessageId":null})
}
fn source_reference(fixture: &Fixture) -> Value {
    let snapshot = fixture.snapshot;
    fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let page = sessions.active.as_ref().unwrap().store.source_content(snapshot, 0, 1).unwrap();
        json!({"kind":"source-result","snapshotId":snapshot,"attemptId":page.attempt_id,"resultId":page.result_id})
    })
}
fn translation(fixture: &Fixture, text: &str) -> Value {
    json!({"kind":"translation","unitId":fixture.unit,"targetLocale":"zh-CN","text":text})
}

#[test]
fn pi_team_dynamically_reviews_requests_evidence_and_revises_real_candidates() {
    let fixture = TeamFixture::create();
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,
        "locale":"zh-CN","sourceRevisionId":fixture.source_revision,"expectedSelectionId":null,
        "text":"Human selected wording"}),
        )
        .unwrap();
    let manual = history(&fixture);
    let protected = protection(&fixture);
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan(&fixture, &[&a, &b, &c], &ids);
    let source = source_reference(&fixture);
    let a0 = admitted(&fixture, &a, ids[0]);
    let (_, a0view) = work_view(&a0);
    let target = a0view["discussion"]["target"].clone();
    let a0attempt = a0view["work"]["attemptId"].clone();
    assert_eq!(a0attempt, plan["attemptId"]);
    assert_eq!(a0view["messages"], json!([]));
    let p0 = ExecutionId::new();
    let iab = ExecutionId::new();
    a0.tool(
        "a-proposal",
        "publish_team_discussion",
        publication(
            p0,
            &target,
            "note",
            "Initial wording to be challenged.",
            json!([]),
            Value::Null,
            Value::Null,
        ),
    );
    let a1 = admitted(&fixture, &a, ids[0]);
    assert_eq!(
        tool_result(&a1.body, "a-proposal")["publication"]["postId"],
        json!(p0)
    );
    a1.tool(
        "a-review",
        "request_team_work",
        request(iab, ids[1], &target, "review", &[p0], Value::Null),
    );
    let a2 = admitted(&fixture, &a, ids[0]);
    let breceipt = tool_result(&a2.body, "a-review");
    assert_eq!(breceipt["memberId"], json!(ids[1]));
    a2.outcome(translation(&fixture, "First team candidate"));
    let original = wait_work(&fixture, &plan, &a0attempt, true);
    let first_revision = original["candidateRevisionId"].clone();
    let b0 = admitted(&fixture, &b, ids[1]);
    assert_eq!(work_view(&b0).1["work"], breceipt);
    b0.tool(
        "b-read-proposal",
        "read_team_discussion",
        json!({"postId":p0}),
    );
    let b1 = admitted(&fixture, &b, ids[1]);
    assert_eq!(
        tool_result(&b1.body, "b-read-proposal")["publication"]["body"],
        "Initial wording to be challenged."
    );
    let p1 = ExecutionId::new();
    let challenge = publication(
        p1,
        &target,
        "rejection",
        "The initial wording omits the precise source distinction.",
        json!([{"kind":"translation-revision","revisionId":first_revision},source]),
        json!(p0),
        Value::Null,
    );
    b1.tool("b-challenge", "publish_team_discussion", challenge.clone());
    let b2 = admitted(&fixture, &b, ids[1]);
    assert_eq!(
        tool_result(&b2.body, "b-challenge")["publication"],
        challenge
    );
    let m1 = ExecutionId::new();
    b2.tool(
        "b-message",
        "send_team_message",
        message(m1, ids[0], &target, &[p1]),
    );
    let b3 = admitted(&fixture, &b, ids[1]);
    assert_eq!(
        tool_result(&b3.body, "b-message")["sender"]["memberId"],
        json!(ids[1])
    );
    let iba = ExecutionId::new();
    b3.tool(
        "b-rework",
        "request_team_work",
        request(iba, ids[0], &target, "translation", &[p1], Value::Null),
    );
    let b4 = admitted(&fixture, &b, ids[1]);
    let areceipt = tool_result(&b4.body, "b-rework");
    b4.outcome(json!({"kind":"review","reviewed":{"kind":"post","postId":p0},"postIds":[p1],"verdict":"revise"}));
    let a3 = admitted(&fixture, &a, ids[0]);
    let (_, a3view) = work_view(&a3);
    assert_eq!(a3view["work"], areceipt);
    assert_eq!(a3view["messages"][0]["messageId"], json!(m1));
    let iac = ExecutionId::new();
    a3.tool(
        "a-evidence",
        "request_team_work",
        request(iac, ids[2], &target, "evidence", &[p1], json!(m1)),
    );
    let a4 = admitted(&fixture, &a, ids[0]);
    let creceipt = tool_result(&a4.body, "a-evidence");
    assert_eq!(
        work_view(&a4).1["messages"],
        json!([]),
        "a consumed message is not presented twice"
    );
    a4.outcome(json!({"kind":"waiting","requestedIntentIds":[iac]}));
    let c0 = admitted(&fixture, &c, ids[2]);
    assert_eq!(work_view(&c0).1["work"], creceipt);
    c0.tool(
        "c-read-reason",
        "read_team_discussion",
        json!({"postId":p1}),
    );
    let c1 = admitted(&fixture, &c, ids[2]);
    let original_reason = tool_result(&c1.body, "c-read-reason");
    assert_eq!(original_reason["publication"], challenge);
    assert_eq!(
        original_reason["author"]["author"]["memberId"],
        json!(ids[1])
    );
    c1.tool(
        "c-read-source",
        "read_team_artifact",
        json!({"postId":p1,"referenceIndex":1}),
    );
    let c2 = admitted(&fixture, &c, ids[2]);
    assert_eq!(
        tool_result(&c2.body, "c-read-source")["artifact"]["text"],
        "Hello"
    );
    let p2 = ExecutionId::new();
    c2.tool(
        "c-evidence",
        "publish_team_discussion",
        publication(
            p2,
            &target,
            "note",
            "The exact adopted source supports the review reason.",
            json!([source]),
            json!(p1),
            Value::Null,
        ),
    );
    let c3 = admitted(&fixture, &c, ids[2]);
    assert_eq!(
        tool_result(&c3.body, "c-evidence")["publication"]["postId"],
        json!(p2)
    );
    let m2 = ExecutionId::new();
    c3.tool(
        "c-message",
        "send_team_message",
        message(m2, ids[0], &target, &[p1, p2]),
    );
    let c4 = admitted(&fixture, &c, ids[2]);
    assert_eq!(
        tool_result(&c4.body, "c-message")["recipientMemberId"],
        json!(ids[0])
    );
    let ica = ExecutionId::new();
    c4.tool(
        "c-rework",
        "request_team_work",
        request(ica, ids[0], &target, "translation", &[p1, p2], Value::Null),
    );
    let c5 = admitted(&fixture, &c, ids[2]);
    let revised_receipt = tool_result(&c5.body, "c-rework");
    c5.outcome(json!({"kind":"evidence","postIds":[p2]}));
    let a5 = admitted(&fixture, &a, ids[0]);
    assert_eq!(work_view(&a5).1["work"], revised_receipt);
    assert_eq!(work_view(&a5).1["messages"][0]["messageId"], json!(m2));
    a5.tool(
        "a-read-old",
        "read_team_artifact",
        json!({"postId":p1,"referenceIndex":0}),
    );
    let a6 = admitted(&fixture, &a, ids[0]);
    assert_eq!(
        tool_result(&a6.body, "a-read-old")["artifact"]["revisionId"],
        first_revision
    );
    assert_eq!(
        tool_result(&a6.body, "a-read-old")["artifact"]["text"],
        "First team candidate"
    );
    let p3 = ExecutionId::new();
    a6.tool(
        "a-revision",
        "publish_team_discussion",
        publication(
            p3,
            &target,
            "resolution",
            "Revised wording retains the distinction in the cited evidence.",
            json!([{"kind":"translation-revision","revisionId":first_revision},source]),
            json!(p1),
            json!(p0),
        ),
    );
    let a7 = admitted(&fixture, &a, ids[0]);
    assert_eq!(
        tool_result(&a7.body, "a-revision")["publication"]["supersedes"],
        json!(p0)
    );
    let iab2 = ExecutionId::new();
    a7.tool(
        "a-rereview",
        "request_team_work",
        request(iab2, ids[1], &target, "review", &[p1, p2, p3], Value::Null),
    );
    let a8 = admitted(&fixture, &a, ids[0]);
    let rereview_receipt = tool_result(&a8.body, "a-rereview");
    a8.outcome(translation(&fixture, "Revised team candidate"));
    let revised = wait_work(&fixture, &plan, &revised_receipt["attemptId"], true);
    let second_revision = revised["candidateRevisionId"].clone();
    assert_ne!(first_revision, second_revision);
    let b5 = admitted(&fixture, &b, ids[1]);
    assert_eq!(work_view(&b5).1["work"], rereview_receipt);
    b5.tool(
        "b-read-revision",
        "read_team_discussion",
        json!({"postId":p3}),
    );
    let b6 = admitted(&fixture, &b, ids[1]);
    assert_eq!(
        tool_result(&b6.body, "b-read-revision")["publication"]["supersedes"],
        json!(p0)
    );
    let p4 = ExecutionId::new();
    b6.tool(
        "b-resolution",
        "publish_team_discussion",
        publication(
            p4,
            &target,
            "resolution",
            "The revision resolves the original reason.",
            json!([{"kind":"translation-revision","revisionId":second_revision}]),
            json!(p3),
            json!(p1),
        ),
    );
    let b7 = admitted(&fixture, &b, ids[1]);
    assert_eq!(
        tool_result(&b7.body, "b-resolution")["publication"]["supersedes"],
        json!(p1)
    );
    b7.outcome(json!({"kind":"review","reviewed":{"kind":"post","postId":p3},"postIds":[p4],"verdict":"accept"}));
    wait_work(&fixture, &plan, &rereview_receipt["attemptId"], false);
    let view = execution(&fixture, &plan);
    assert_eq!(view["works"].as_array().unwrap().len(), 6);
    assert_eq!(view["messages"].as_array().unwrap().len(), 2);
    assert_eq!(view["consumptions"].as_array().unwrap().len(), 2);
    assert_eq!(view["budget"]["limit"], 40);
    assert_eq!(view["budget"]["dispatched"], 23);
    assert_eq!(view["budget"]["unresolved"], 0);
    for work in view["works"].as_array().unwrap() {
        assert_eq!(work["execution"], "succeeded");
        assert_eq!(work["validation"], "valid");
        if work["output"]["outcome"]["kind"] != "translation" {
            assert!(work["candidateRevisionId"].is_null());
        }
    }
    for consumption in view["consumptions"].as_array().unwrap() {
        let work = view["works"]
            .as_array()
            .unwrap()
            .iter()
            .find(|work| work["receipt"]["taskId"] == consumption["taskId"])
            .unwrap();
        let connection = rusqlite::Connection::open_with_flags(
            fixture.project_path.join("project.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let captured: Vec<u8> = connection.query_row(
            "SELECT capture FROM execution_provider_requests WHERE request_id=?1 AND attempt_id=?2",
            [consumption["providerRequestId"].as_str().unwrap(), work["receipt"]["attemptId"].as_str().unwrap()],
            |row| row.get(0)).unwrap();
        let admitted: Value = serde_json::from_slice(&captured).unwrap();
        assert!(
            admitted["teamWorkView"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["messageId"] == consumption["messageId"])
        );
    }
    let after = history(&fixture);
    assert_eq!(
        after["rows"].as_array().unwrap().len(),
        manual["rows"].as_array().unwrap().len() + 2
    );
    assert_eq!(after["current"], manual["current"]);
    assert_eq!(after["currentText"], manual["currentText"]);
    assert_eq!(protection(&fixture), protected);
    for (revision, text) in [
        (first_revision, "First team candidate"),
        (second_revision, "Revised team candidate"),
    ] {
        assert_eq!(
            after["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["revisionId"] == revision)
                .unwrap()["text"],
            text
        );
    }
    let first_attempt: ExecutionId = serde_json::from_value(a0attempt).unwrap();
    let revised_attempt: ExecutionId =
        serde_json::from_value(revised_receipt["attemptId"].clone()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            for attempt in [first_attempt, revised_attempt] {
                let input = store.execution_input(attempt).unwrap();
                assert!(
                    store
                        .saved_ai_candidate(attempt, input.envelope().items[0].item_id)
                        .unwrap()
                        .is_some()
                );
            }
        });
    assert!(
        fixture
            .call(
                "control_work_plan",
                json!({"planId":plan["planId"],"actionId":ExecutionId::new(),
        "expectedGeneration":grant["lease"]["generation"],"command":"continue","confirmed":true,
        "checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[]})
            )
            .is_err()
    );
}

#[test]
fn pi_team_can_choose_evidence_before_review_without_a_fixed_pipeline() {
    let fixture = TeamFixture::create();
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, _) = team_plan(&fixture, &[&a, &b, &c], &ids);
    let a0 = admitted(&fixture, &a, ids[0]);
    let target = work_view(&a0).1["discussion"]["target"].clone();
    let intent = ExecutionId::new();
    a0.tool(
        "evidence-first",
        "request_team_work",
        request(intent, ids[2], &target, "evidence", &[], Value::Null),
    );
    let a1 = admitted(&fixture, &a, ids[0]);
    let receipt = tool_result(&a1.body, "evidence-first");
    assert_eq!(receipt["memberId"], json!(ids[2]));
    a1.outcome(translation(&fixture, "Direct evidence route"));
    let c0 = admitted(&fixture, &c, ids[2]);
    let post = ExecutionId::new();
    c0.tool(
        "direct-evidence",
        "publish_team_discussion",
        publication(
            post,
            &target,
            "note",
            "Evidence was requested before any review.",
            json!([source_reference(&fixture)]),
            Value::Null,
            Value::Null,
        ),
    );
    let c1 = admitted(&fixture, &c, ids[2]);
    assert_eq!(
        tool_result(&c1.body, "direct-evidence")["publication"]["postId"],
        json!(post)
    );
    c1.outcome(json!({"kind":"evidence","postIds":[post]}));
    wait_work(&fixture, &plan, &receipt["attemptId"], false);
    wait_work(&fixture, &plan, &plan["attemptId"], true);
    let view = execution(&fixture, &plan);
    assert_eq!(
        view["works"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["receipt"]["memberId"].clone())
            .collect::<Vec<_>>(),
        vec![json!(ids[0]), json!(ids[2])]
    );
    assert_eq!(view["budget"]["dispatched"], 4);
    assert!(
        matches!(b.listener.accept(), Err(error) if error.kind()==std::io::ErrorKind::WouldBlock)
    );
}
