use super::*;

#[test]
fn registered_action_history_is_bounded_scoped_and_never_initializes_execution() {
    let mut fixture = Fixture::create();
    fixture.reopen();
    let unit = fixture.unit;
    let (plan, input) = fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        let config = AiConfig { endpoint: "http://127.0.0.1:9/v1/chat/completions".into(), model: "synthetic-model".into(), credential_env: String::new(), ..Default::default() };
        let plan = active.store.prepare_work_plan(Some(config), "zh-CN", &[unit], PlanOptions::default()).unwrap();
        let authorization = AuthorizeWorkPlan { action_id: ExecutionId::new(), plan_digest: plan.digest.clone(), confirmed: true,
            effects: plan.authorization_effects().unwrap(), expires_at: SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600 };
        let receipt = active.store.authorize_work_plan(&plan, &authorization).unwrap();
        (plan, FixedInput::capture(receipt.input.unwrap()).unwrap())
    });
    let request = json!({"planId":plan.plan_id,"after":"0","baseline":null,"limit":1});
    let before = fixture.bytes();
    let initial = fixture.call("read_work_plan_history", request.clone()).unwrap();
    assert_eq!(initial["rows"].as_array().unwrap().len(), 1);
    assert_eq!(initial["rows"][0]["action"]["kind"], "authorize");
    assert!(initial["rows"][0]["start"].is_null());
    assert_eq!(fixture.bytes(), before);
    let enqueued = input.clone();
    fixture.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        active.store.enqueue_execution(&enqueued).unwrap();
    });
    let mut stale = request.clone(); stale["baseline"] = initial["baseline"].clone();
    assert_eq!(fixture.call("read_work_plan_history", stale).unwrap_err()["code"], "dependency-conflict");
    let before = fixture.bytes();
    let started = fixture.call("read_work_plan_history", request.clone()).unwrap();
    assert_eq!(started["rows"][0]["start"]["attemptId"], json!(input.envelope().attempt_id));
    assert_eq!(started["rows"][0]["input"]["taskId"], json!(input.envelope().task_id));
    assert_eq!(fixture.bytes(), before);
    for limit in [0, 17] {
        let mut wrong = request.clone(); wrong["limit"] = json!(limit);
        assert!(fixture.call("read_work_plan_history", wrong).is_err());
    }
    for field in ["projectId", "sessionToken"] {
        let mut wrong = super::request(&fixture.context, request.clone()); wrong[field] = json!(ExecutionId::new());
        assert!(call(&fixture.webview, "read_work_plan_history", wrong).is_err());
    }
    fixture.app.state::<AppState>().sessions.with(|sessions| { assert!(sessions.active.as_ref().unwrap().execution.is_none()); });
    fixture.reopen();
    let reopened = fixture.call("read_work_plan_history", request.clone()).unwrap();
    assert_eq!(reopened["rows"], started["rows"]);
    assert_eq!(reopened["baseline"]["lastStart"], started["baseline"]["lastStart"]);
    // Closing an idle project durably pauses active automation. The original
    // row remains immutable while the history baseline includes that new fact.
    assert_eq!(reopened["baseline"]["lease"]["generation"], "2");
    let mut next = request;
    next["after"] = reopened["nextAfter"].clone();
    next["baseline"] = reopened["baseline"].clone();
    let paused = fixture.call("read_work_plan_history", next).unwrap();
    assert_eq!(paused["rows"].as_array().unwrap().len(), 1);
    assert_eq!(paused["rows"][0]["action"]["kind"], "control");
    assert_eq!(paused["rows"][0]["action"]["command"], "pause");
    assert_eq!(paused["rows"][0]["state"], "paused");
    assert_eq!(paused["rows"][0]["lease"], reopened["baseline"]["lease"]);
    fixture.app.state::<AppState>().sessions.with(|sessions| { assert!(sessions.active.as_ref().unwrap().execution.is_none()); });
}
