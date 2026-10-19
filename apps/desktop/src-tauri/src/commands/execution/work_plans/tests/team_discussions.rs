//! Actual Pi members publish and read through the registered Agent service and
//! original Core request ledger. The only provider is a synthetic loopback peer.
use super::*;
use std::{
    io::{Read, Write},
    net::TcpStream,
};
use tsumugi_core::application::TeamDiscussionPolicy;

struct Peer {
    listener: TcpListener,
    config: AiConfig,
}
struct Http {
    socket: TcpStream,
    raw: String,
    body: Value,
}
impl Peer {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let config = AiConfig {
            endpoint: format!(
                "http://{}/v1/chat/completions",
                listener.local_addr().unwrap()
            ),
            model: "synthetic-team-member".into(),
            credential_env: String::new(),
            max_requests: 8,
            concurrency: 2,
            timeout_seconds: 30,
            ..AiConfig::default()
        };
        Self { listener, config }
    }
    fn accept(&self) -> Http {
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut socket = loop {
            match self.listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "bounded member request did not arrive"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("loopback accept failed: {error}"),
            }
        };
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut part = [0; 4096];
        let end = loop {
            let count = socket.read(&mut part).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&part[..count]);
            assert!(bytes.len() <= 131072);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                break end + 4;
            }
        };
        let headers = std::str::from_utf8(&bytes[..end]).unwrap();
        assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(!headers.to_ascii_lowercase().contains("authorization:"));
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(|value| value.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        assert!(length <= 131072);
        while bytes.len() < end + length {
            let count = socket.read(&mut part).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&part[..count]);
        }
        let raw = String::from_utf8(bytes[end..end + length].to_vec()).unwrap();
        let body = serde_json::from_str(&raw).unwrap();
        Http { socket, raw, body }
    }
}
impl Http {
    fn respond(mut self, content_type: &str, body: String) {
        write!(self.socket,
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()).unwrap();
    }
    fn root(self, item: &Value) {
        assert_eq!(self.body["stream"], false);
        let output = candidate(item, "Root candidate");
        self.respond(
            "application/json",
            json!({"choices":[{"finish_reason":"stop",
            "message":{"role":"assistant","content":output}}],
            "usage":{"prompt_tokens":1,"completion_tokens":1}})
            .to_string(),
        );
    }
    fn tool(self, call_id: &str, name: &str, arguments: Value) {
        assert_eq!(self.body["stream"], true);
        assert!(
            self.body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["function"]["name"] == name)
        );
        let chunk = json!({"id":"synthetic-discussion-tool","object":"chat.completion.chunk",
            "created":1,"model":"synthetic-team-member","choices":[{"index":0,
            "delta":{"role":"assistant","tool_calls":[{"index":0,"id":call_id,
                "type":"function","function":{"name":name,"arguments":arguments.to_string()}}]},
            "finish_reason":null}]});
        let finish = json!({"id":"synthetic-discussion-tool","object":"chat.completion.chunk",
            "created":1,"model":"synthetic-team-member","choices":[{"index":0,"delta":{},
                "finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1}});
        self.respond(
            "text/event-stream",
            format!("data: {chunk}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
        );
    }
    fn finish(self, item: &Value, text: &str) {
        assert_eq!(self.body["stream"], true);
        let chunk = json!({"id":"synthetic-discussion-final","object":"chat.completion.chunk",
            "created":1,"model":"synthetic-team-member","choices":[{"index":0,
                "delta":{"role":"assistant","content":candidate(item,text)},"finish_reason":null}]});
        let finish = json!({"id":"synthetic-discussion-final","object":"chat.completion.chunk",
            "created":1,"model":"synthetic-team-member","choices":[{"index":0,"delta":{},
                "finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}});
        self.respond(
            "text/event-stream",
            format!("data: {chunk}\n\ndata: {finish}\n\ndata: [DONE]\n\n"),
        );
    }
}
fn candidate(item: &Value, text: &str) -> String {
    json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":text}).to_string()
}
fn history(fixture: &Fixture) -> Value {
    fixture
        .call(
            "read_translation_history",
            json!({"unitId":fixture.unit,"locale":"zh-CN",
        "afterOrdinal":"0","limit":100}),
        )
        .unwrap()
}
fn protection(fixture: &Fixture) -> Value {
    fixture
        .call(
            "read_work_protection",
            json!({"unitId":fixture.unit,"locale":"zh-CN"}),
        )
        .unwrap()
}
fn start_plan(
    fixture: &Fixture,
    peer: &Peer,
    discussions: Option<TeamDiscussionPolicy>,
) -> (Value, Value, Value) {
    let mut options = serde_json::to_value(PlanOptions::default()).unwrap();
    if let Some(policy) = discussions {
        options["teamDiscussions"] = serde_json::to_value(policy).unwrap();
    }
    let plan = fixture
        .call(
            "prepare_work_plan",
            json!({"config":peer.config,"locale":"zh-CN",
        "unitIds":[fixture.unit],"options":options,"advisoryChecks":[],"toolSelection":null}),
        )
        .unwrap();
    let effects = if discussions.is_some() {
        json!(["save-candidate", "publish-discussion"])
    } else {
        json!(["save-candidate"])
    };
    let grant = fixture.call("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],
        "actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":checker_keys(&plan),
        "toolExecution":false,"applicationToolExecutions":[],"effects":effects,"expiresAt":expiry()})).unwrap();
    fixture
        .call(
            "start_work_plan",
            json!({"planId":plan["planId"],"actionId":grant["actionId"],
        "expectedGeneration":grant["lease"]["generation"]}),
        )
        .unwrap();
    let root = peer.accept();
    let item: Value =
        serde_json::from_str(root.body["messages"][1]["content"].as_str().unwrap()).unwrap();
    root.root(&item);
    fixture.wait_saved_for(&plan["attemptId"], Duration::from_secs(30));
    let scope = fixture
        .call(
            "open_work_plan_agent_scope",
            json!({"lease":grant["lease"]}),
        )
        .unwrap();
    (plan, scope, item)
}
fn start_member(fixture: &Fixture, root: &Value) -> (Value, Value) {
    let scope = fixture.call("delegate_work_plan_agent_scope", json!({"scopeId":root["scopeId"],
        "delegation":{"delegationId":ExecutionId::new(),"unitIds":[fixture.unit],"toolHandles":[]}})).unwrap();
    let generation = json!({"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[fixture.unit]});
    let prepared = fixture
        .call(
            "prepare_work_plan_agent_generation",
            json!({"scopeId":scope["scopeId"],"generation":generation}),
        )
        .unwrap();
    fixture
        .call(
            "start_work_plan_agent_generation",
            json!({"scopeId":scope["scopeId"],
        "generation":generation,"inputDigest":prepared["inputDigest"]}),
        )
        .unwrap();
    (scope, generation)
}
fn shared_view(body: &Value) -> (String, Value) {
    let views = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| {
            if message["role"] != "user" {
                return None;
            }
            let text = message["content"].as_str()?;
            let value: Value = serde_json::from_str(text).ok()?;
            (value["kind"] == "untrusted-team-discussions").then(|| (text.to_owned(), value))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        views.len(),
        1,
        "exactly one temporary Core data projection required"
    );
    views.into_iter().next().unwrap()
}
fn own_users(body: &Value, view: &str) -> Vec<Value> {
    body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user" && message["content"] != view)
        .cloned()
        .collect()
}
fn tool_result(body: &Value, call: &str) -> Value {
    let messages = body["messages"].as_array().unwrap();
    let results = messages
        .iter()
        .filter(|message| message["role"] == "tool" && message["tool_call_id"] == call)
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 1);
    let result = results[0];
    let result_index = messages
        .iter()
        .position(|message| message == result)
        .unwrap();
    assert!(result_index > 0);
    assert_eq!(messages[result_index - 1]["role"], "assistant");
    assert!(
        messages[result_index - 1]["tool_calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["id"] == call)
    );
    serde_json::from_str(result["content"].as_str().unwrap()).unwrap()
}
fn captures(fixture: &Fixture, generation: &Value) -> Vec<Value> {
    let connection = rusqlite::Connection::open_with_flags(
        fixture.project_path.join("project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut query = connection
        .prepare(
            "SELECT capture FROM execution_provider_requests WHERE attempt_id=?1 ORDER BY rowid",
        )
        .unwrap();
    let captured = query
        .query_map([generation["attemptId"].as_str().unwrap()], |row| {
            row.get::<_, Vec<u8>>(0)
        })
        .unwrap()
        .map(|row| serde_json::from_slice(&row.unwrap()).unwrap())
        .collect();
    captured
}
fn assert_capture(
    fixture: &Fixture,
    generation: &Value,
    ordinal: usize,
    http: &Http,
    view: &Value,
) {
    let captured = captures(fixture, generation);
    assert_eq!(captured.len(), ordinal + 1);
    assert_eq!(captured[ordinal]["body"], http.raw);
    assert_eq!(captured[ordinal]["teamView"], *view);
    let typed: tsumugi_core::application::TeamDiscussionView =
        serde_json::from_value(view.clone()).unwrap();
    assert_eq!(
        serde_json::to_string(&typed).unwrap(),
        shared_view(&http.body).0
    );
}

#[test]
fn pi_members_publish_original_references_and_refresh_only_the_next_frozen_request() {
    // Keep the exact approved runtime alive until after the session and children.
    let _runtime;
    let fixture = Fixture::create();
    _runtime = crate::commands::execution::test_fixtures::provision_member_runtime(
        &fixture.app.state::<AppState>().plugins,
        &fixture.directory.path().join("member-resources"),
    );
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":null,"text":"Human selected translation"}),
        )
        .unwrap();
    let manual = history(&fixture);
    let manual_protection = protection(&fixture);
    assert_eq!(manual["rows"][0]["originKind"], "manual");
    assert_eq!(manual_protection["protected"], true);
    let reference_revision = manual["rows"][0]["revisionId"].clone();
    let peer = Peer::new();
    let (plan, scope, item) = start_plan(
        &fixture,
        &peer,
        Some(TeamDiscussionPolicy::CurrentPlanV1 {}),
    );
    let before_discussion = history(&fixture);
    let snapshot = fixture.snapshot;
    let source = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let store = &sessions.active.as_ref().unwrap().store;
            let page = store.source_content(snapshot, 0, 1).unwrap();
            json!({"kind":"source-result","snapshotId":page.snapshot_id.unwrap(),
            "attemptId":page.attempt_id,"resultId":page.result_id})
        });
    let references =
        json!([{"kind":"translation-revision","revisionId":reference_revision},source]);

    let (_, member_b) = start_member(&fixture, &scope);
    let b1 = peer.accept();
    assert_eq!(b1.body["tools"].as_array().unwrap().len(), 2);
    assert!(
        !b1.body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["function"]["name"] == "read_team_artifact")
    );
    let (_, initial_b) = shared_view(&b1.body);
    assert_eq!(initial_b["planId"], plan["planId"]);
    assert_eq!(initial_b["author"]["attemptId"], member_b["attemptId"]);
    assert_eq!(initial_b["posts"], json!([]));
    let target = initial_b["target"].clone();
    assert_eq!(
        target,
        json!({"unitId":fixture.unit,"locale":"zh-CN",
        "sourceSnapshotId":fixture.snapshot,"sourceRevisionId":fixture.source_revision})
    );
    let first_id = ExecutionId::new();
    let first_publication = json!({"postId":first_id,"target":target,"kind":"rejection",
        "body":"The selected wording loses the source distinction. Inspect the cited immutable evidence.",
        "references":references,"replyTo":null,"supersedes":null});
    b1.tool(
        "publish-first",
        "publish_team_discussion",
        first_publication.clone(),
    );
    let b2 = peer.accept();
    let (_, view_b) = shared_view(&b2.body);
    let first_post = tool_result(&b2.body, "publish-first");
    assert_eq!(first_post["publication"], first_publication);
    assert_eq!(first_post["author"]["kind"], "member");
    assert_eq!(first_post["author"]["author"], initial_b["author"]);
    assert_ne!(
        first_post["author"]["author"]["memberId"],
        initial_b["author"]["binding"]["callerId"]
    );
    assert_eq!(view_b["posts"], json!([first_post]));
    assert_capture(&fixture, &member_b, 1, &b2, &view_b);

    let (_, member_a) = start_member(&fixture, &scope);
    let a1 = peer.accept();
    let (frozen_utf8, view_a1) = shared_view(&a1.body);
    assert_eq!(view_a1["author"]["attemptId"], member_a["attemptId"]);
    assert_ne!(view_a1["author"]["memberId"], view_b["author"]["memberId"]);
    assert_ne!(view_a1["viewId"], view_b["viewId"]);
    assert_eq!(view_a1["posts"], view_b["posts"]);
    let own_input = own_users(&a1.body, &frozen_utf8);
    assert!(!own_input.is_empty());
    assert!(own_input.iter().any(|message| {
        message["content"]
            .as_str()
            .is_some_and(|text| text.contains("Hello"))
    }));
    assert_capture(&fixture, &member_a, 0, &a1, &view_a1);
    let original_capture = captures(&fixture, &member_a);

    let second_id = ExecutionId::new();
    let second_publication = json!({"postId":second_id,"target":target,"kind":"note",
        "body":"A later explicitly published clarification, while the other request is already in flight.",
        "references":references,"replyTo":first_id,"supersedes":null});
    b2.tool(
        "publish-later",
        "publish_team_discussion",
        second_publication.clone(),
    );
    let b3 = peer.accept();
    let (_, view_b3) = shared_view(&b3.body);
    let second_post = tool_result(&b3.body, "publish-later");
    assert_eq!(second_post["publication"], second_publication);
    assert_eq!(second_post["author"], first_post["author"]);
    assert_eq!(view_b3["posts"], json!([first_post, second_post]));
    assert_eq!(
        captures(&fixture, &member_a),
        original_capture,
        "a publication must not rewrite a request already reserved and physically sent"
    );
    assert!(!a1.raw.contains(second_id.to_string().as_str()));
    assert_eq!(history(&fixture), before_discussion);
    assert_eq!(protection(&fixture), manual_protection);

    a1.tool(
        "read-original",
        "read_team_discussion",
        json!({"postId":first_id}),
    );
    let a2 = peer.accept();
    let (next_utf8, view_a2) = shared_view(&a2.body);
    assert_ne!(view_a2["viewId"], view_a1["viewId"]);
    assert_eq!(view_a2["author"], view_a1["author"]);
    assert_eq!(view_a2["posts"], view_b3["posts"]);
    assert_eq!(tool_result(&a2.body, "read-original"), first_post);
    assert_eq!(own_users(&a2.body, &next_utf8), own_input);
    assert!(
        !a2.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["content"] == frozen_utf8)
    );
    assert_capture(&fixture, &member_a, 1, &a2, &view_a2);
    assert_capture(&fixture, &member_b, 2, &b3, &view_b3);
    assert_eq!(
        history(&fixture),
        before_discussion,
        "discussion tools must not create or select translation revisions"
    );
    a2.finish(&item, "Member A candidate");
    b3.finish(&item, "Member B candidate");
    fixture.wait_saved_for(&member_a["attemptId"], Duration::from_secs(30));
    fixture.wait_saved_for(&member_b["attemptId"], Duration::from_secs(30));
    let after = history(&fixture);
    assert_eq!(after["current"], manual["current"]);
    assert_eq!(after["currentText"], manual["currentText"]);
    assert_eq!(
        after["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["revisionId"] == reference_revision)
            .unwrap(),
        &manual["rows"][0]
    );
    assert_eq!(protection(&fixture), manual_protection);
}

#[test]
fn pi_member_without_discussion_policy_has_no_discussion_tools_or_shared_view() {
    let _runtime;
    let fixture = Fixture::create();
    _runtime = crate::commands::execution::test_fixtures::provision_member_runtime(
        &fixture.app.state::<AppState>().plugins,
        &fixture.directory.path().join("member-resources"),
    );
    let peer = Peer::new();
    let (_, scope, item) = start_plan(&fixture, &peer, None);
    let (_, generation) = start_member(&fixture, &scope);
    let member = peer.accept();
    assert_eq!(member.body["stream"], true);
    assert!(
        member
            .body
            .get("tools")
            .is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty))
    );
    for message in member.body["messages"].as_array().unwrap() {
        if message["role"] == "user" {
            assert!(
                !message["content"]
                    .as_str()
                    .unwrap()
                    .contains("untrusted-team-discussions")
            );
        }
    }
    let captured = captures(&fixture, &generation);
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0]["body"], member.raw);
    assert!(captured[0].get("teamView").is_none());
    member.finish(&item, "Member without shared discussions");
    fixture.wait_saved_for(&generation["attemptId"], Duration::from_secs(30));
}

#[test]
fn pi_member_reads_published_artifact_indices_without_expanding_shared_source_scope() {
    const ORIGINAL: &str = "Original cited wording: \"quoted\"\r\nA distinct version 🧵";
    const LATEST: &str = "Newer human selection, which is not the cited revision";
    const UNSHARED: &str = "OTHER_UNIT_SENTINEL_MUST_STAY_LOCAL";
    let _runtime;
    let fixture = Fixture::create_with_source(
        br#"{"first":"Authorized source wording","second":"OTHER_UNIT_SENTINEL_MUST_STAY_LOCAL"}"#,
    );
    _runtime = crate::commands::execution::test_fixtures::provision_member_runtime(
        &fixture.app.state::<AppState>().plugins,
        &fixture.directory.path().join("member-resources"),
    );
    let original = fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":null,"text":ORIGINAL}),
        )
        .unwrap();
    let original_revision = original["revision"]["revisionId"].clone();
    assert!(original_revision.is_string());
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":original["selection"]["eventId"],"text":LATEST}),
        )
        .unwrap();
    let selected = history(&fixture);
    let protected = protection(&fixture);
    assert_eq!(selected["currentText"], LATEST);
    assert_ne!(selected["current"]["revisionId"], original_revision);
    assert_eq!(protected["protected"], true);
    let snapshot = fixture.snapshot;
    let unit = fixture.unit;
    let (source_reference, source_artifact) =
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let page = store.source_content(snapshot, 0, 100).unwrap();
                assert_eq!(page.rows.len(), 2);
                assert!(
                    page.rows
                        .iter()
                        .any(|row| row.unit_id != Some(unit) && row.occurrence.text == UNSHARED)
                );
                let row = page
                    .rows
                    .iter()
                    .find(|row| row.unit_id == Some(unit))
                    .unwrap();
                assert_eq!(row.occurrence.text, "Authorized source wording");
                (
                    json!({"kind":"source-result","snapshotId":snapshot,
            "attemptId":page.attempt_id,"resultId":page.result_id}),
                    json!({"kind":"source-result","snapshotId":snapshot,
            "attemptId":page.attempt_id,"resultId":page.result_id,
            "occurrenceId":row.occurrence_id.unwrap(),"nativeKey":row.occurrence.key,
            "text":row.occurrence.text}),
                )
            });
    let peer = Peer::new();
    let (plan, scope, item) = start_plan(
        &fixture,
        &peer,
        Some(TeamDiscussionPolicy::CurrentPlanV2 {}),
    );
    assert_eq!(
        plan["options"]["teamDiscussions"]["profile"],
        "current-plan-2"
    );
    assert!(!peer.config.share_context);
    assert!(!peer.config.source_context.is_enabled());
    let (_, publisher) = start_member(&fixture, &scope);
    let publish = peer.accept();
    let (_, publisher_view) = shared_view(&publish.body);
    assert_eq!(publish.body["tools"].as_array().unwrap().len(), 3);
    let post_id = ExecutionId::new();
    let target = publisher_view["target"].clone();
    publish.tool("publish-evidence", "publish_team_discussion", json!({"postId":post_id,
        "target":target,"kind":"note","body":"Inspect the two cited original versions.",
        "references":[{"kind":"translation-revision","revisionId":original_revision},source_reference],
        "replyTo":null,"supersedes":null}));
    let published = peer.accept();
    let post = tool_result(&published.body, "publish-evidence");
    assert_eq!(post["publication"]["postId"], json!(post_id));
    assert_eq!(post["author"]["author"], publisher_view["author"]);
    assert!(!published.raw.contains(UNSHARED));
    published.finish(&item, "Publisher candidate");
    fixture.wait_saved_for(&publisher["attemptId"], Duration::from_secs(30));
    let before_reads = history(&fixture);

    let (_, reader) = start_member(&fixture, &scope);
    let first = peer.accept();
    let (first_utf8, reader_view) = shared_view(&first.body);
    let own_input = own_users(&first.body, &first_utf8);
    assert_eq!(reader_view["posts"], json!([post]));
    assert!(!first.raw.contains(UNSHARED));
    assert_capture(&fixture, &reader, 0, &first, &reader_view);
    first.tool(
        "read-cited-translation",
        "read_team_artifact",
        json!({"postId":post_id,"referenceIndex":0}),
    );
    let second = peer.accept();
    let (second_utf8, second_view) = shared_view(&second.body);
    let translation = tool_result(&second.body, "read-cited-translation");
    assert_eq!(
        translation,
        json!({"kind":"untrusted-team-artifact","postId":post_id,
        "referenceIndex":0,"target":target,
        "artifact":{"kind":"translation-revision","revisionId":original_revision,"text":ORIGINAL}})
    );
    assert_ne!(translation["artifact"]["text"], selected["currentText"]);
    assert_eq!(own_users(&second.body, &second_utf8), own_input);
    assert_capture(&fixture, &reader, 1, &second, &second_view);
    second.tool(
        "read-cited-source",
        "read_team_artifact",
        json!({"postId":post_id,"referenceIndex":1}),
    );
    let third = peer.accept();
    let (third_utf8, third_view) = shared_view(&third.body);
    assert_eq!(
        tool_result(&third.body, "read-cited-translation"),
        translation
    );
    assert_eq!(
        tool_result(&third.body, "read-cited-source"),
        json!({"kind":"untrusted-team-artifact","postId":post_id,
            "referenceIndex":1,"target":target,"artifact":source_artifact})
    );
    assert_eq!(own_users(&third.body, &third_utf8), own_input);
    assert_eq!(third_view["posts"], reader_view["posts"]);
    assert_capture(&fixture, &reader, 2, &third, &third_view);
    assert!(!third.raw.contains(UNSHARED));
    assert_eq!(history(&fixture), before_reads);
    assert_eq!(protection(&fixture), protected);
    third.finish(&item, "Reader candidate");
    fixture.wait_saved_for(&reader["attemptId"], Duration::from_secs(30));
    let after = history(&fixture);
    assert_eq!(after["current"], selected["current"]);
    assert_eq!(after["currentText"], LATEST);
    assert_eq!(
        after["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["revisionId"] == original_revision)
            .unwrap()["text"],
        ORIGINAL
    );
    assert_eq!(protection(&fixture), protected);
}
