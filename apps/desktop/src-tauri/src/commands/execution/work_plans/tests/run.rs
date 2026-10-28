use super::*;

fn files(path: &std::path::Path) -> std::collections::BTreeMap<std::ffi::OsString, Vec<u8>> {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.file_type().unwrap().is_file())
        .map(|entry| (entry.file_name(), std::fs::read(entry.path()).unwrap()))
        .collect()
}

#[test]
fn registered_run_view_reads_history_without_runtime_or_submission() {
    let mut fixture = Fixture::create();
    fixture.reopen();
    let unit = fixture.unit;
    let (plan, input, action) = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            assert!(active.execution.is_none());
            let config = AiConfig {
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-model".into(),
                credential_env: String::new(),
                ..Default::default()
            };
            let plan = active
                .store
                .prepare_work_plan(Some(config), "zh-CN", &[unit], PlanOptions::default())
                .unwrap();
            let authorization = AuthorizeWorkPlan {
                action_id: ExecutionId::new(),
                plan_digest: plan.digest.clone(),
                confirmed: true,
                effects: plan.authorization_effects().unwrap(),
                expires_at: SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    + 60,
            };
            let receipt = active
                .store
                .authorize_work_plan(&plan, &authorization)
                .unwrap();
            (
                plan,
                FixedInput::capture(receipt.input.unwrap()).unwrap(),
                authorization.action_id,
            )
        });
    let read = json!({"planId":plan.plan_id});
    let before = files(&fixture.project_path);
    let initial = fixture.call("read_work_plan_run", read.clone()).unwrap();
    assert!(initial["lastStart"].is_null() && initial["budget"].is_null());
    assert_eq!(initial["budgetRootTaskId"], json!(input.envelope().task_id));
    assert_eq!(files(&fixture.project_path), before);
    let enqueued = input.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            assert!(active.execution.is_none());
            active.store.enqueue_execution(&enqueued).unwrap();
        });
    let before = files(&fixture.project_path);
    let started = fixture.call("read_work_plan_run", read.clone()).unwrap();
    assert_eq!(started["planDigest"], plan.digest);
    assert_eq!(started["lastStart"]["actionId"], json!(action));
    assert_eq!(
        started["lastStart"]["attemptId"],
        json!(input.envelope().attempt_id)
    );
    assert_eq!(started["budget"]["dispatched"], 0);
    assert_eq!(files(&fixture.project_path), before);
    let mut wrong = request(&fixture.context, read.clone());
    wrong["projectId"] = json!(ExecutionId::new());
    assert!(call(&fixture.webview, "read_work_plan_run", wrong).is_err());
    let mut wrong = request(&fixture.context, read.clone());
    wrong["sessionToken"] = json!("wrong-session");
    assert!(call(&fixture.webview, "read_work_plan_run", wrong).is_err());
    fixture.app.state::<AppState>().sessions.with(|sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(active.execution.is_none());
    });
    fixture.reopen();
    let before = files(&fixture.project_path);
    let reopened = fixture.call("read_work_plan_run", read).unwrap();
    assert_eq!(reopened["lastStart"], started["lastStart"]);
    assert_eq!(reopened["budget"]["dispatched"], 0);
    let progress = fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":reopened["lastStart"]["attemptId"],"offset":0,"limit":1}),
        )
        .unwrap();
    assert_eq!(progress["attemptId"], reopened["lastStart"]["attemptId"]);
    assert_eq!(progress["taskId"], reopened["lastStart"]["taskId"]);
    assert_eq!(progress["items"].as_array().unwrap().len(), 1);
    let invalid = fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":reopened["lastStart"]["attemptId"],"offset":100,"limit":1}),
        )
        .unwrap_err();
    assert_eq!(invalid["code"], "invalid-input");
    assert_eq!(invalid["field"], "offset");
    assert_eq!(files(&fixture.project_path), before);
    let attempt = input.envelope().attempt_id;
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let active = sessions.active.as_ref().unwrap();
            assert!(active.execution.is_none());
            assert_eq!(
                active
                    .store
                    .execution_input(attempt)
                    .unwrap()
                    .envelope()
                    .attempt_id,
                attempt
            );
        });
}
