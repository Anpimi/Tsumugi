//! Independent Pi requests preserve manual selections and admission-time messages.
use super::*;
use std::collections::BTreeSet;

pub(super) fn physical_requests(fixture: &Fixture, work: &Value) -> Vec<Value> {
    let project_path = fixture.project_path.clone();
    let attempt = work["attemptId"].as_str().unwrap().to_owned();
    fixture.app.state::<AppState>().sessions.with(move |_| {
        let connection = rusqlite::Connection::open_with_flags(
            project_path.join("project.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).unwrap();
        let mut query = connection.prepare(
            "SELECT request_id,state,capture FROM execution_provider_requests WHERE attempt_id=?1 ORDER BY rowid",
        ).unwrap();
        let rows = query.query_map([attempt], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Vec<u8>>(2)?,
        ))).unwrap().map(|row| {
            let (id, state, capture) = row.unwrap();
            json!({"requestId":id,"state":state,"capture":serde_json::from_slice::<Value>(&capture).unwrap()})
        }).collect();
        drop(query);
        drop(connection);
        rows
    })
}

fn assert_held(http: &Http) {
    http.socket.set_nonblocking(true).unwrap();
    let result = http.socket.peek(&mut [0; 1]);
    http.socket.set_nonblocking(false).unwrap();
    assert!(
        matches!(result, Err(error) if error.kind()==std::io::ErrorKind::WouldBlock),
        "the actual provider connection must still be waiting for its response"
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) fn owned_member_pids(fixture: &TeamFixture) -> Vec<u32> {
    let children = std::process::Command::new("/usr/bin/pgrep")
        .args(["-P", &std::process::id().to_string()])
        .output()
        .unwrap();
    assert!(
        children.status.success(),
        "owned test children must be inspectable: {}",
        String::from_utf8_lossy(&children.stderr)
    );
    let pids = String::from_utf8(children.stdout)
        .unwrap()
        .split_whitespace()
        .map(|pid| pid.parse::<u32>().unwrap().to_string())
        .collect::<Vec<_>>()
        .join(",");
    let processes = std::process::Command::new("/bin/ps")
        .args(["-ww", "-o", "pid=,args=", "-p", &pids])
        .output()
        .unwrap();
    assert!(
        processes.status.success(),
        "owned process inspection must succeed: {}",
        String::from_utf8_lossy(&processes.stderr)
    );
    let staging = fixture.1.as_ref().unwrap().0.path().join("application");
    let staging = staging.to_str().unwrap();
    String::from_utf8(processes.stdout)
        .unwrap()
        .lines()
        .filter(|line| line.contains(staging) && line.contains("worker.mjs"))
        .map(|line| {
            line.split_whitespace()
                .next()
                .unwrap()
                .parse::<u32>()
                .unwrap()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn assert_owned(fixture: &Fixture, attempts: &[ExecutionId; 3], expected: [bool; 3]) {
    let attempts = *attempts;
    let actual = fixture
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
    assert_eq!(actual, expected);
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn pi_team_concurrent_candidates_preserve_inflight_manual_choice_and_consume_late_messages_once() {
    let fixture = TeamFixture::create();
    let old_manual = fixture
        .call(
            "save_translation_revision",
            json!({
                "actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN",
                "sourceRevisionId":fixture.source_revision,"expectedSelectionId":null,
                "text":"Original human selection before the captured team plan",
            }),
        )
        .unwrap();
    let [a, b, c] = peers();
    let ids = std::array::from_fn(|_| ExecutionId::new());
    let (plan, grant) = team_plan_with_kinds(
        &fixture,
        &[&a, &b, &c],
        &ids,
        [&["translation"], &["translation"], &["translation"]],
    );
    assert_eq!(plan["options"]["selectionPolicy"], "candidates-only");
    let a0 = admitted(&fixture, &a, ids[0]);
    let target = work_view(&a0).1["discussion"]["target"].clone();
    let post = ExecutionId::new();
    let published = publication(
        post,
        &target,
        "note",
        "The original source distinction is retained in this post.",
        json!([]),
        Value::Null,
        Value::Null,
    );
    a0.tool(
        "original-post",
        "publish_team_discussion",
        published.clone(),
    );
    let a1 = admitted(&fixture, &a, ids[0]);
    let original_post = tool_result(&a1.body, "original-post");
    assert_eq!(original_post["publication"], published);
    let ib = ExecutionId::new();
    a1.tool(
        "request-b",
        "request_team_work",
        request(ib, ids[1], &target, "translation", &[post], Value::Null),
    );
    let a2 = admitted(&fixture, &a, ids[0]);
    let b_work = tool_result(&a2.body, "request-b");
    let ic = ExecutionId::new();
    a2.tool(
        "request-c",
        "request_team_work",
        request(ic, ids[2], &target, "translation", &[post], Value::Null),
    );
    let a3 = admitted(&fixture, &a, ids[0]);
    let c_work = tool_result(&a3.body, "request-c");
    a3.outcome(json!({"kind":"waiting","requestedIntentIds":[ib,ic]}));
    let a_done = wait_work(&fixture, &plan, &plan["attemptId"], false);
    assert_eq!(
        a_done["output"]["outcome"],
        json!({"kind":"waiting","requestedIntentIds":[ib,ic]})
    );
    assert!(a_done["candidateRevisionId"].is_null());

    let b0 = admitted(&fixture, &b, ids[1]);
    let c0 = admitted(&fixture, &c, ids[2]);
    assert_ne!(
        (b0.socket.local_addr().unwrap(), b0.socket.peer_addr().unwrap()),
        (c0.socket.local_addr().unwrap(), c0.socket.peer_addr().unwrap())
    );
    assert_held(&b0);
    assert_held(&c0);
    assert_eq!(work_view(&b0).1["work"], b_work);
    assert_eq!(work_view(&c0).1["work"], c_work);
    let attempts = [
        serde_json::from_value(plan["attemptId"].clone()).unwrap(),
        serde_json::from_value(b_work["attemptId"].clone()).unwrap(),
        serde_json::from_value(c_work["attemptId"].clone()).unwrap(),
    ];
    assert_ne!(attempts[1], attempts[2]);
    assert_owned(&fixture, &attempts, [false, true, true]);
    let pids = owned_member_pids(&fixture);
    assert_eq!(
        pids.len(),
        2,
        "both actual Pi workers must be live together"
    );
    let b_first = physical_requests(&fixture, &b_work);
    let c_first = physical_requests(&fixture, &c_work);
    assert_eq!(b_first.len(), 1);
    assert_eq!(c_first.len(), 1);
    assert_ne!(b_first[0]["requestId"], c_first[0]["requestId"]);
    assert_eq!(b_first[0]["state"], "unknown");
    assert_eq!(c_first[0]["state"], "unknown");
    assert_eq!(b_first[0]["capture"]["body"], b0.raw);
    assert_eq!(c_first[0]["capture"]["body"], c0.raw);
    assert_eq!(c_first[0]["capture"]["teamWorkView"]["messages"], json!([]));
    assert_eq!(execution(&fixture, &plan)["budget"]["dispatched"], 6);

    let human = fixture.call("save_translation_revision", json!({
        "actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN",
        "sourceRevisionId":fixture.source_revision,"expectedSelectionId":old_manual["selection"]["eventId"],
        "text":"Human changed the selected wording while both providers were in flight",
    })).unwrap();
    let human_history = history(&fixture);
    let human_protection = protection(&fixture);
    assert_eq!(
        human_history["current"]["eventId"],
        human["selection"]["eventId"]
    );
    assert_eq!(human_history["currentText"], human["revision"]["text"]);
    assert_eq!(human_protection["protected"], true);
    assert_held(&b0);
    assert_held(&c0);
    assert_owned(&fixture, &attempts, [false, true, true]);

    let late_id = ExecutionId::new();
    const LATE: &str = "Late evidence is visible only at the next admitted C request.";
    b0.tool(
        "late-c-message",
        "send_team_message",
        json!({
            "messageId":late_id,"recipientMemberId":ids[2],"target":target,"body":LATE,
            "postIds":[post],"causeMessageId":null,
        }),
    );
    let b1 = admitted(&fixture, &b, ids[1]);
    let late = tool_result(&b1.body, "late-c-message");
    assert_eq!(late["messageId"], json!(late_id));
    assert_eq!(late["body"], LATE);
    assert_eq!(late["target"], target);
    assert_eq!(late["postIds"], json!([post]));
    assert_eq!(late["sender"]["kind"], "member");
    assert_eq!(late["sender"]["author"]["memberId"], json!(ids[1]));
    assert_eq!(late["sender"]["author"]["roleVersionId"], b_work["roleVersionId"]);
    assert_eq!(late["sender"]["author"]["attemptId"], b_work["attemptId"]);
    assert_eq!(late["sender"]["author"]["binding"]["lease"], grant["lease"]);
    assert_eq!(late["recipientMemberId"], json!(ids[2]));
    assert_eq!(late["recipientRoleVersionId"], c_work["roleVersionId"]);
    let received = execution(&fixture, &plan);
    assert_eq!(received["messages"], json!([late.clone()]));
    assert_eq!(received["consumptions"], json!([]));
    assert_eq!(physical_requests(&fixture, &c_work), c_first);
    assert!(!c0.raw.contains(LATE));
    assert!(!c0.raw.contains(&late_id.to_string()));
    assert_held(&c0);
    b1.outcome(translation(&fixture, "Candidate B after the human edit"));
    let b_done = wait_work(&fixture, &plan, &b_work["attemptId"], true);

    c0.tool(
        "read-original-1",
        "read_team_discussion",
        json!({"postId":post}),
    );
    let c1 = admitted(&fixture, &c, ids[2]);
    assert_eq!(tool_result(&c1.body, "read-original-1"), original_post);
    let c1_view = work_view(&c1).1;
    assert_eq!(c1_view["messages"], json!([late.clone()]));
    let c_two = physical_requests(&fixture, &c_work);
    assert_eq!(c_two.len(), 2);
    assert_eq!(c_two[0]["capture"], c_first[0]["capture"]);
    assert_eq!(c_two[1]["capture"]["body"], c1.raw);
    assert_eq!(c_two[1]["state"], "unknown");
    let consumed = execution(&fixture, &plan)["consumptions"].clone();
    assert_eq!(consumed.as_array().unwrap().len(), 1);
    assert_eq!(consumed[0]["messageId"], json!(late_id));
    assert_eq!(consumed[0]["taskId"], c_work["taskId"]);
    assert_eq!(consumed[0]["providerRequestId"], c_two[1]["requestId"]);
    assert_ne!(consumed[0]["providerRequestId"], c_first[0]["requestId"]);
    c1.tool(
        "read-original-2",
        "read_team_discussion",
        json!({"postId":post}),
    );
    let c2 = admitted(&fixture, &c, ids[2]);
    assert_eq!(tool_result(&c2.body, "read-original-1"), original_post);
    assert_eq!(tool_result(&c2.body, "read-original-2"), original_post);
    assert_eq!(work_view(&c2).1["messages"], json!([]));
    assert!(!c2.raw.contains(LATE));
    assert!(!c2.raw.contains(&late_id.to_string()));
    assert_eq!(execution(&fixture, &plan)["consumptions"], consumed);
    c2.outcome(translation(
        &fixture,
        "Candidate C after one exact message consumption",
    ));
    let c_done = wait_work(&fixture, &plan, &c_work["attemptId"], true);
    assert_ne!(b_done["candidateRevisionId"], c_done["candidateRevisionId"]);

    let after = history(&fixture);
    assert_eq!(
        after["rows"].as_array().unwrap().len(),
        human_history["rows"].as_array().unwrap().len() + 2
    );
    assert_eq!(after["current"], human_history["current"]);
    assert_eq!(after["currentText"], human_history["currentText"]);
    assert_eq!(protection(&fixture), human_protection);
    for (work, text) in [
        (&b_done, "Candidate B after the human edit"),
        (&c_done, "Candidate C after one exact message consumption"),
    ] {
        let row = after["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["revisionId"] == work["candidateRevisionId"])
            .unwrap();
        assert_eq!(row["text"], text);
        assert_eq!(row["attemptId"], work["receipt"]["attemptId"]);
    }
    let rejected = fixture.call("select_translation_revision", json!({
        "actionId":ExecutionId::new(),"unitId":fixture.unit,"locale":"zh-CN",
        "sourceRevisionId":fixture.source_revision,"expectedSelectionId":old_manual["selection"]["eventId"],
        "revisionId":b_done["candidateRevisionId"],
    })).unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["reason"], "translation-selection");
    assert_eq!(rejected["conflict"]["kind"], "translation-selection");
    assert_eq!(
        rejected["conflict"]["expected"],
        old_manual["selection"]["eventId"]
    );
    assert_eq!(
        rejected["conflict"]["current"],
        human["selection"]["eventId"]
    );
    assert_eq!(history(&fixture), after);
    assert_eq!(protection(&fixture), human_protection);

    let final_view = execution(&fixture, &plan);
    assert_eq!(final_view["works"].as_array().unwrap().len(), 3);
    assert_eq!(final_view["budget"]["limit"], 40);
    assert_eq!(final_view["budget"]["dispatched"], 9);
    assert_eq!(final_view["budget"]["unresolved"], 0);
    assert_eq!(final_view["budget"]["usageUnknown"], 0);
    assert_eq!(final_view["consumptions"], consumed);
    for (work, count) in [(&a_done["receipt"], 4), (&b_work, 2), (&c_work, 3)] {
        let requests = physical_requests(&fixture, work);
        assert_eq!(requests.len(), count);
        assert!(
            requests
                .iter()
                .all(|request| request["state"] == "response")
        );
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
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
        if owned == [false; 3] {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "original producers must actually drain"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    for pid in pids {
        assert!(
            !std::process::Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .output()
                .unwrap()
                .status
                .success(),
            "the observed owned Pi worker must be reaped"
        );
    }
}
