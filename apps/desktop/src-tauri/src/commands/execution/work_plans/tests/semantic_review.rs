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
                "severity":"warning","location":{"field":"translation","range":{"encoding":"utf8-byte","start":0,"end":9}},"suggestion":"Inspect the meaning"}]},
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
    let diagnostic = run["diagnostics"][0].clone();
    let location_request = json!({"unitId":fixture.unit,"locale":"zh-CN","runId":run["runId"],"diagnostic":diagnostic});
    let before_location = fixture.bytes();
    let location = fixture
        .call("read_review_diagnostic_location", location_request.clone())
        .unwrap();
    assert_eq!(location["runId"], run["runId"]);
    assert_eq!(location["basis"], run["basis"]);
    assert_eq!(
        location["basisEvidence"]["selectionId"],
        selection["selection"]["eventId"]
    );
    assert_eq!(
        location["location"],
        json!({"field":"translation","range":{"encoding":"utf16","start":0,"end":9}})
    );
    assert_eq!(
        fixture.bytes(),
        before_location,
        "locating advice must remain read-only"
    );
    let mut substituted = location_request.clone();
    substituted["diagnostic"]["detail"] = json!("Substituted model explanation");
    assert!(
        fixture
            .call("read_review_diagnostic_location", substituted)
            .is_err()
    );
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
    fixture
        .call(
            "save_translation_revision",
            json!({"actionId":ExecutionId::new(),"unitId":fixture.unit,
        "locale":"zh-CN","sourceRevisionId":fixture.source_revision,
        "expectedSelectionId":selection["selection"]["eventId"],"text":"A newer human revision"}),
        )
        .unwrap();
    assert!(
        fixture
            .call("read_review_diagnostic_location", location_request)
            .is_err()
    );
    let historical = lookup(&fixture, &prepared["attemptId"]);
    assert_eq!(historical["view"]["rows"][0]["run"], *run);
    assert_eq!(historical["view"]["rows"][0]["current"], false);
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


#[test]
fn registered_semantic_start_proof_reads_original_enqueue_without_initializing_or_submitting() {
    let isolated=ProjectFixture::create("en-US");
    let absent=json!({"attemptId":ExecutionId::new(),"digest":"0".repeat(64),"confirmed":false});
    assert_eq!(call(&isolated.webview,"read_ai_semantic_review_start_action",request(&isolated.context,absent)).unwrap(),Value::Null);
    isolated.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    let mut fixture=Fixture::create();selected(&fixture);let unit=fixture.unit;
    let (attempt,preview,task,input_digest)=fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let store=&mut sessions.active.as_mut().unwrap().store;
        let prepared=store.prepare_ai_semantic_review(AiConfig {endpoint:"https://model.example/v1/chat/completions".into(),model:"synthetic-review".into(),credential_env:String::new(),..Default::default()},
            &[tsumugi_core::ai::semantic_review::AiSemanticReviewTarget {unit_id:unit,locale:"zh-CN".into()}],
            &[tsumugi_core::ai::semantic_review::AiSemanticReviewRule::Meaning]).unwrap();
        let attempt=prepared.input().envelope().attempt_id;let task=prepared.input().envelope().task_id;
        store.enqueue_execution(prepared.input()).unwrap();
        (attempt,prepared.preview().clone(),task,prepared.input().digest().to_owned())
    });
    let business=json!({"attemptId":attempt,"digest":preview.digest,"confirmed":true});
    let admitted=fixture.attempt_count();
    let saved=fixture.call("read_ai_semantic_review_start_action",business.clone()).unwrap();
    assert_eq!(saved["projectId"],fixture.context["projectId"]);assert_eq!(saved["attemptId"],json!(attempt));
    assert_eq!(saved["taskId"],json!(task));assert_eq!(saved["inputDigest"],json!(input_digest));
    assert_eq!(saved["preview"],serde_json::to_value(crate::commands::execution::review::semantic::AiSemanticReviewPreviewView::from(preview)).unwrap());
    let mut without_consent=business.clone();without_consent["confirmed"]=json!(false);
    assert_eq!(fixture.call("read_ai_semantic_review_start_action",without_consent).unwrap(),saved,"read never attests to or renews temporary consent");
    for field in ["projectId","sessionToken","digest"] {
        let mut wrong=business.clone();wrong[field]=if field=="projectId" {json!(ExecutionId::new())} else {json!("wrong")};
        assert!(fixture.call("read_ai_semantic_review_start_action",wrong).is_err());
    }
    let mut extra=business.clone();extra["grant"]=json!(true);assert!(fixture.call("read_ai_semantic_review_start_action",extra).is_err());
    assert_eq!(fixture.attempt_count(),admitted);
    Fixture::capture_source(&fixture.app,br#"{"replacement":"Changed source"}"#.to_vec());
    let retained_count=fixture.attempt_count();
    let sequence=fixture.app.state::<AppState>().sessions.with(|sessions| {
        let active=sessions.active.as_mut().unwrap();let revision=active.store.metadata().unwrap().metadata_revision();active.store.set_target_locales(revision,&["ja".into()]).unwrap();
        active.execution.as_mut().unwrap().quiescing=true;active.store.execution_sequence().unwrap()
    });
    assert_eq!(fixture.call("read_ai_semantic_review_start_action",business.clone()).unwrap(),saved);
    fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let active=sessions.active.as_mut().unwrap();assert_eq!(active.store.execution_sequence().unwrap(),sequence);active.execution.as_mut().unwrap().quiescing=false;
    });
    fixture.reopen();
    assert_eq!(fixture.call("read_ai_semantic_review_start_action",business).unwrap(),saved);
    fixture.app.state::<AppState>().sessions.with(|sessions|assert!(sessions.active.as_ref().unwrap().execution.is_none()));
    assert_eq!(fixture.attempt_count(),retained_count);
    // Reading cannot admit another task; the existing fixture may own other source checks.
    assert_eq!(fixture.call("read_ai_semantic_review_start_action",json!({"attemptId":attempt,"digest":saved["preview"]["digest"],"confirmed":false})).unwrap(),saved);
}
