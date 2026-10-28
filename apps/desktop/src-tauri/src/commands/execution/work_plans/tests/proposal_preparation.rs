use super::*;

#[test]
fn conversation_proposal_preparation_order_keeps_the_newer_shared_work_plan() {
    let fixture = Fixture::create();
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
                .preparation_probe = Some(generation::CaptureProbe::new(reached, held));
        });
    let config = AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "earlier-preview".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..Default::default()
    };
    let earlier = json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit],"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null,"maintenance":null});
    let window = fixture.webview.clone();
    let wire = request(&fixture.context, earlier.clone());
    let pending = std::thread::spawn(move || call(&window, "prepare_work_plan", wire));
    observing
        .recv_timeout(Duration::from_secs(5))
        .expect("earlier preview must enter its async preparation");
    let mut newer = earlier;
    newer["config"]["model"] = json!("newer-preview");
    let accepted = fixture.call("prepare_work_plan", newer).unwrap();
    release.send(()).unwrap();
    assert!(pending.join().unwrap().is_err());
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let prepared = sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap()
                .work_plans
                .prepared
                .as_ref()
                .unwrap();
            assert_eq!(
                serde_json::to_value(prepared.plan().plan_id).unwrap(),
                accepted["planId"]
            );
        });
}
