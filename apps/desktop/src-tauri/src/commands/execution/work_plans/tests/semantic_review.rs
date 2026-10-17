//! Real registered review commands, original task adoption, and a bounded local
//! HTTP peer exercise control and provenance, never model review quality.
use super::*;

fn selected(fixture: &Fixture) -> Value {
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":null,"text":"Synthetic selected translation"}),
        )
        .unwrap()
}
fn prepare(fixture: &Fixture, config: &AiConfig) -> Value {
    fixture
        .call(
            "prepare_ai_semantic_review",
            json!({"config":config,
        "targets":[{"unitId":fixture.unit,"locale":"zh-CN"}],"rules":["meaning","style"]}),
        )
        .unwrap()
}
fn lookup(fixture: &Fixture, attempt: &Value) -> Value {
    fixture
        .call("read_ai_semantic_review", json!({"attemptId":attempt}))
        .unwrap()
}
fn findings(fixture: &Fixture) -> Value {
    fixture
        .call(
            "read_review_findings",
            json!({"unitId":fixture.unit,"locale":"zh-CN","offset":0,"limit":50}),
        )
        .unwrap()
}

#[test]
fn registered_semantic_review_records_advisory_evidence_through_original_task_and_reopens() {
    let mut fixture = Fixture::create();
    let selection = selected(&fixture);
    let (config, wire) = local_provider_outputs_at_request(
        1,
        |_, item| {
            assert_eq!(item["translationText"], "Synthetic selected translation");
            assert_eq!(item["rules"], json!(["meaning", "style"]));
            Some(
                json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"rules":[
            {"rule":"meaning","findings":[{"code":"meaning-shift","detail":"Synthetic review concern",
                "severity":"warning","location":null,"suggestion":"Inspect the meaning"}]},
            {"rule":"style","findings":[]}]}),
            )
        },
        None,
        None,
        Duration::from_secs(5),
        Duration::from_secs(3),
    );
    let before = fixture.bytes();
    let count = fixture.attempt_count();
    let prepared = prepare(&fixture, &config);
    assert_eq!(fixture.bytes(), before, "preparation must remain read-only");
    assert_eq!(fixture.attempt_count(), count);
    assert!(lookup(&fixture, &prepared["attemptId"])["view"].is_null());
    for field in ["projectId", "sessionToken"] {
        let mut request = request(&fixture.context, json!({"attemptId":prepared["attemptId"]}));
        request[field] = json!(ExecutionId::new());
        assert!(call(&fixture.webview, "read_ai_semantic_review", request).is_err());
    }
    let start = json!({"attemptId":prepared["attemptId"],"digest":prepared["preview"]["digest"],"confirmed":true});
    let mut unconfirmed = start.clone();
    unconfirmed["confirmed"] = json!(false);
    assert!(
        fixture
            .call("start_ai_semantic_review", unconfirmed)
            .is_err()
    );
    fixture
        .call("start_ai_semantic_review", start.clone())
        .unwrap();
    assert_eq!(
        fixture
            .call("start_ai_semantic_review", start.clone())
            .unwrap(),
        prepared["attemptId"]
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    let view = loop {
        let lookup = lookup(&fixture, &prepared["attemptId"]);
        let view = lookup["view"].clone();
        if view["rows"][0]["output"].is_object() {
            break view;
        }
        assert!(Instant::now() < deadline, "{lookup}");
        std::thread::sleep(Duration::from_millis(10));
    };
    wire.join().unwrap();
    assert_eq!(
        view["rows"][0]["output"]["usage"],
        json!({"promptTokens":"1","completionTokens":"1"})
    );
    assert!(
        view["rows"][0]["run"].is_null(),
        "successful model output is not recorded automatically"
    );
    assert!(findings(&fixture)["semanticRunId"].is_null());
    let unit = &view["detail"]["recovery"]["units"][0];
    assert_eq!(unit["itemIds"], json!([view["rows"][0]["itemId"]]));
    let action = ExecutionId::new();
    let adoption = json!({"attemptId":prepared["attemptId"],"unitId":unit["unitId"],
        "resultIds":unit["resultIds"],"actionId":action});
    fixture
        .call("prepare_execution_adoption", adoption)
        .unwrap();
    let receipt = fixture
        .call("adopt_execution", json!({"actionId":action}))
        .unwrap();
    assert_eq!(receipt["actionId"], json!(action));
    let recorded = lookup(&fixture, &prepared["attemptId"]);
    let run = &recorded["view"]["rows"][0]["run"];
    assert_eq!(run["purpose"], "ai-semantic");
    assert_eq!(run["evidence"]["attemptId"], prepared["attemptId"]);
    assert_eq!(run["evidence"]["model"], json!(config.model));
    assert_eq!(run["evidence"]["endpoint"], json!(config.endpoint));
    let current = findings(&fixture);
    assert!(current["runId"].is_null(), "AI never supplies a QA run");
    assert_eq!(current["semanticRunId"], run["runId"]);
    let finding = &current["findings"][0];
    assert_eq!(finding["runId"], run["runId"]);
    assert_eq!(finding["purpose"], "ai-semantic");
    assert_eq!(finding["requirement"]["mandatory"], false);
    assert_eq!(finding["requirement"]["waivable"], false);
    let disposition = json!({"projectId":fixture.context["projectId"],"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","expectedBasis":current["basis"],"runId":finding["runId"],
        "issueId":finding["finding"]["issueId"],"expectedDecisionId":null,"disposition":"rejected",
        "actor":"Synthetic reviewer","reason":"Synthetic false positive"});
    let decision = fixture
        .call("write_review_finding", json!({"finding":disposition}))
        .unwrap();
    assert_eq!(decision["purpose"], "ai-semantic");
    assert_eq!(decision["aiOrigin"], run["evidence"]);
    let target = fixture
        .call(
            "read_review_target",
            json!({"unitId":fixture.unit,"locale":"zh-CN"}),
        )
        .unwrap();
    assert!(target["currentCheck"].is_null());
    assert_eq!(
        target["basisEvidence"]["selectionId"],
        selection["selection"]["eventId"]
    );
    fixture.reopen();
    assert_eq!(
        lookup(&fixture, &prepared["attemptId"])["view"]["rows"][0]["run"],
        *run
    );
    assert_eq!(findings(&fixture)["history"][0], decision);
    assert_eq!(
        fixture.call("start_ai_semantic_review", start).unwrap(),
        prepared["attemptId"]
    );
    assert_eq!(
        fixture.attempt_count(),
        count + 1,
        "replay must never dispatch a second task"
    );
}

#[test]
fn registered_semantic_review_refuses_selection_drift_before_first_dispatch() {
    let fixture = Fixture::create();
    let selection = selected(&fixture);
    let config = AiConfig {
        endpoint: "https://example.test/v1/chat/completions".into(),
        model: "Synthetic model".into(),
        credential_env: String::new(),
        ..Default::default()
    };
    let prepared = prepare(&fixture, &config);
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),
        "unitId":fixture.unit,"locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":selection["selection"]["eventId"],"text":"Newer human translation"}),
        )
        .unwrap();
    let count = fixture.attempt_count();
    assert!(
        fixture
            .call(
                "start_ai_semantic_review",
                json!({"attemptId":prepared["attemptId"],
        "digest":prepared["preview"]["digest"],"confirmed":true})
            )
            .is_err()
    );
    assert_eq!(fixture.attempt_count(), count);
    assert!(lookup(&fixture, &prepared["attemptId"])["view"].is_null());
}
