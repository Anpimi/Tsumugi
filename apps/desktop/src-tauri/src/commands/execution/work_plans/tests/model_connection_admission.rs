//! Registered application/profile and project admission boundaries. Sources use
//! the existing conformance fixture; model execution uses bounded local HTTP.
use super::*;
use crate::commands::connections::{ConnectionReadView, configure};
use tsumugi_core::{
    ai::AiConnection,
    model_connections::{ModelConnectionChange, ModelConnectionEdit},
};

fn configured(fixture: &Fixture) {
    configure(
        &fixture.app.state::<AppState>(),
        &fixture.directory.path().join("application"),
    )
    .unwrap();
}
fn current(fixture: &Fixture) -> ConnectionReadView {
    serde_json::from_value(call(&fixture.webview, "read_model_connections", json!({})).unwrap())
        .unwrap()
}
fn change(fixture: &Fixture, edit: ModelConnectionEdit) {
    let request = ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: current(fixture).basis,
        edit,
    };
    call(
        &fixture.webview,
        "change_model_connections",
        serde_json::to_value(request).unwrap(),
    )
    .unwrap();
}
fn capture(fixture: &Fixture, name: &str, mut config: AiConfig) -> AiConfig {
    let id = ExecutionId::new();
    change(
        fixture,
        ModelConnectionEdit::Save {
            profile_id: id,
            name: name.into(),
            connection: AiConnection::from_config(&config),
        },
    );
    config.connection_profile = Some(
        current(fixture)
            .references
            .into_iter()
            .find(|reference| reference.profile_id == id)
            .unwrap(),
    );
    config
}
fn manual() -> AiConfig {
    AiConfig {
        endpoint: "https://example.test/v1/chat/completions".into(),
        model: "Synthetic model".into(),
        credential_env: String::new(),
        max_requests: 2,
        ..Default::default()
    }
}

#[test]
fn subscription_work_plan_preparation_preserves_saved_profile_without_dispatch() {
    let fixture = Fixture::create_with_source(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/core/tests/fixtures/quality-evaluation/smapi/s1/i18n/default.json"
    )));
    configured(&fixture);
    let config = capture(
        &fixture,
        "Subscription",
        AiConfig {
            endpoint: "https://api.openai.com/v1/responses".into(),
            model: "synthetic-subscription-model".into(),
            credential_env: String::new(),
            token_field: "chatgpt_subscription".into(),
            chatgpt_account: Some(ExecutionId::new()),
            max_items: 6,
            max_requests: 6,
            max_output_tokens: 0,
            max_retries: 0,
            timeout_seconds: 120,
            ..Default::default()
        },
    );
    let snapshot = fixture.snapshot;
    let units: Vec<_> = fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            store
                .source_content(snapshot, 0, 6)
                .unwrap()
                .rows
                .into_iter()
                .map(|row| row.unit_id.unwrap())
                .collect()
        });
    assert_eq!(units.len(), 6);
    let attempts = fixture.attempt_count();
    let plan = fixture
        .call(
            "prepare_work_plan",
            json!({
                "config": config, "locale": "zh-CN", "unitIds": units,
                "options": PlanOptions::default(), "advisoryChecks": [], "toolSelection": null
            }),
        )
        .unwrap();
    assert_eq!(
        plan["preview"]["config"],
        serde_json::to_value(&config).unwrap()
    );
    assert_eq!(plan["preview"]["items"].as_array().unwrap().len(), 6);
    assert_eq!(fixture.attempt_count(), attempts);
}
fn direct_preview(fixture: &Fixture, config: &AiConfig) -> Value {
    fixture
        .call(
            "preview_ai_translation",
            json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit]}),
        )
        .unwrap()
}
fn finish_direct(fixture: &Fixture, attempt: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let view = fixture
            .call("read_ai_translation", json!({"attemptId":attempt}))
            .unwrap();
        if view["detail"]["progress"]["queued"] == 0 && view["detail"]["progress"]["running"] == 0 {
            return view;
        }
        assert!(Instant::now() < deadline, "{view}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn direct_profile_preview_rejects_forged_defaults_and_first_start_rechecks_current_reference() {
    let fixture = Fixture::create();
    configured(&fixture);
    let config = capture(&fixture, "Saved", manual());
    let mut forged = config.clone();
    forged.model = "Unselected model".into();
    let rejected = fixture
        .call(
            "preview_ai_translation",
            json!({"config":forged,"locale":"zh-CN","unitIds":[fixture.unit]}),
        )
        .unwrap_err();
    assert_eq!(rejected["reason"], "ai-connection-profile");
    let preview = direct_preview(&fixture, &config);
    change(
        &fixture,
        ModelConnectionEdit::Archive {
            profile_id: config.connection_profile.unwrap().profile_id,
        },
    );
    let rejected = fixture.call("start_ai_translation", json!({"attemptId":preview["attemptId"],"digest":preview["preview"]["digest"],"confirmed":true})).unwrap_err();
    assert_eq!(rejected["reason"], "model-connection-unavailable");
    let attempt = serde_json::from_value::<ExecutionId>(preview["attemptId"].clone()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(store.execution_input(attempt).is_err());
        });
}

#[test]
fn accepted_direct_start_replays_original_input_after_profile_changes_without_a_second_call() {
    let fixture = Fixture::create();
    configured(&fixture);
    let (config, wire) = local_provider("Synthetic candidate");
    let config = capture(&fixture, "Saved", config);
    let preview = direct_preview(&fixture, &config);
    let start = json!({"attemptId":preview["attemptId"],"digest":preview["preview"]["digest"],"confirmed":true});
    assert_eq!(
        fixture.call("start_ai_translation", start.clone()).unwrap(),
        preview["attemptId"]
    );
    change(
        &fixture,
        ModelConnectionEdit::Archive {
            profile_id: config.connection_profile.as_ref().unwrap().profile_id,
        },
    );
    assert_eq!(
        fixture.call("start_ai_translation", start).unwrap(),
        preview["attemptId"]
    );
    let view = finish_direct(&fixture, &preview["attemptId"]);
    assert_eq!(view["config"], serde_json::to_value(&config).unwrap());
    assert_eq!(view["rows"][0]["output"]["text"], "Synthetic candidate");
    wire.join().unwrap();
    let attempt = serde_json::from_value::<ExecutionId>(preview["attemptId"].clone()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert_eq!(
                tsumugi_core::ai::settings(&store.execution_input(attempt).unwrap())
                    .unwrap()
                    .config,
                config
            );
        });
}

#[test]
fn arena_first_start_checks_every_captured_profile_and_refuses_one_changed_variant() {
    let fixture = Fixture::create();
    configured(&fixture);
    let a = capture(&fixture, "A", manual());
    let mut b = manual();
    b.model = "Other synthetic model".into();
    let b = capture(&fixture, "B", b);
    let config = tsumugi_core::ai::arena::ArenaConfig {
        variants: vec![a, b.clone()],
        max_items: 1,
        max_requests: 2,
        concurrency: 1,
        blind: true,
        parent_attempt_id: None,
    };
    let preview = fixture
        .call(
            "preview_arena_translation",
            json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit]}),
        )
        .unwrap();
    change(
        &fixture,
        ModelConnectionEdit::Save {
            profile_id: b.connection_profile.unwrap().profile_id,
            name: "B changed".into(),
            connection: AiConnection::from_config(&manual()),
        },
    );
    let rejected = fixture.call("start_arena_translation", json!({"attemptId":preview["attemptId"],"digest":preview["preview"]["digest"],"confirmed":true})).unwrap_err();
    assert_eq!(rejected["reason"], "model-connection-changed");
    let attempt = serde_json::from_value::<ExecutionId>(preview["attemptId"].clone()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(store.execution_input(attempt).is_err());
        });
}

#[test]
fn fresh_work_plan_authorization_refuses_profile_drift_without_creating_a_lease() {
    let fixture = Fixture::create();
    configured(&fixture);
    let config = capture(&fixture, "Saved", manual());
    let plan = fixture.call("prepare_work_plan", json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit],"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null})).unwrap();
    change(
        &fixture,
        ModelConnectionEdit::Archive {
            profile_id: config.connection_profile.unwrap().profile_id,
        },
    );
    let action = ExecutionId::new();
    let rejected = fixture.call("authorize_work_plan", json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":action,"confirmed":true,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"effects":["save-candidate"],"expiresAt":expiry()})).unwrap_err();
    assert_eq!(rejected["reason"], "model-connection-unavailable");
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (_, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            assert!(store.work_plan_receipt(action).unwrap().is_none());
        });
}

#[test]
fn original_work_plan_receipt_survives_profile_archival_and_reopen_without_reviving_authority() {
    let mut fixture = Fixture::create();
    configured(&fixture);
    let (config, wire) = local_provider("Plan candidate");
    let config = capture(&fixture, "Saved", config);
    let plan = fixture.call("prepare_work_plan", json!({"config":config,"locale":"zh-CN","unitIds":[fixture.unit],"options":PlanOptions::default(),"advisoryChecks":[],"toolSelection":null})).unwrap();
    let authorize = json!({"planId":plan["planId"],"digest":plan["digest"],"actionId":ExecutionId::new(),"confirmed":true,"checkerExecutions":[],"toolExecution":false,"applicationToolExecutions":[],"effects":["save-candidate"],"expiresAt":expiry()});
    let grant = fixture
        .call("authorize_work_plan", authorize.clone())
        .unwrap();
    change(
        &fixture,
        ModelConnectionEdit::Archive {
            profile_id: config.connection_profile.as_ref().unwrap().profile_id,
        },
    );
    assert_eq!(
        fixture
            .call("authorize_work_plan", authorize.clone())
            .unwrap(),
        grant
    );
    assert_eq!(fixture.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap(), plan["attemptId"]);
    let view = fixture.wait_saved(&plan["attemptId"]);
    assert_eq!(view["config"], serde_json::to_value(config).unwrap());
    assert_eq!(view["rows"][0]["output"]["text"], "Plan candidate");
    wire.join().unwrap();
    fixture.reopen();
    assert_eq!(
        fixture.call("authorize_work_plan", authorize).unwrap(),
        grant
    );
    let rejected = fixture.call("start_work_plan", json!({"planId":plan["planId"],"actionId":grant["actionId"],"expectedGeneration":grant["lease"]["generation"]})).unwrap_err();
    assert_eq!(rejected["reason"], "work-plan-generation");
}

#[test]
fn manual_preparation_does_not_require_or_initialize_application_connection_storage() {
    let fixture = Fixture::create();
    let prepared = direct_preview(&fixture, &manual());
    assert!(
        prepared["preview"]["config"]
            .get("connectionProfile")
            .is_none()
    );
    assert!(
        fixture
            .app
            .state::<AppState>()
            .model_connections
            .get()
            .is_none()
    );
    assert!(!fixture.directory.path().join("application").exists());
}
