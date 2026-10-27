use super::*;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_core::{
    AiAdoptionHandler, ArenaAdoptionHandler, SaveTranslationRevision,
    TeamTranslationAdoptionHandler, application::*,
};
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod source_fixture;

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":request})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize::<Value>().unwrap())
}
fn builtin() -> (tempfile::TempDir, ProjectStore, Vec<ExecutionId>) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        tsumugi_core::ProjectMetadata::create("Candidate effects", "en", ["zh-CN", "fr-FR"])
            .unwrap(),
    )
    .unwrap();
    let input = tsumugi_core::content::SourceBundle::capture(
        br#"{"UniqueID":"Effect.Example","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
        br#"{"hello":"Hello {{name}}","other":"Other"}"#,"en").unwrap().fixed_input(store.metadata().unwrap().project_id()).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register_read_only(Arc::new(tsumugi_core::content::SourceRunner))
        .unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while runtime.has_active_work(&store).unwrap() {
        runtime.tick(&mut store).unwrap();
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let preview = store
        .source_preview(input.envelope().attempt_id, result, 0, 100)
        .unwrap();
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let units = store
        .source_content(snapshot, 0, 100)
        .unwrap()
        .rows
        .into_iter()
        .map(|row| row.unit_id.unwrap())
        .collect();
    (directory, store, units)
}
struct Harness {
    _directory: tempfile::TempDir,
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
    project: ExecutionId,
    token: Value,
    units: Vec<ExecutionId>,
}
fn opened(sdk: bool) -> Harness {
    let (directory, store, units) = if sdk {
        let (directory, store, rows) = source_fixture::source_fixture();
        (
            directory,
            store,
            rows.into_iter().map(|row| row.unit_id.unwrap()).collect(),
        )
    } else {
        builtin()
    };
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    store.close().unwrap();
    let app = tauri::test::mock_builder()
        .manage(AppState::default())
        .invoke_handler(super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let view = call(
        &window,
        "open_project",
        json!({"locator":directory.path().join("project")}),
    )
    .unwrap();
    Harness {
        _directory: directory,
        app,
        window,
        project,
        token: view["sessionToken"].clone(),
        units,
    }
}
struct UndispatchedTeamRunner;
impl Runner for UndispatchedTeamRunner {
    fn capability_id(&self) -> &str {
        tsumugi_core::ai::team::CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        _: DispatchRequest,
        _: Cancellation,
        _: ResultSender,
    ) -> Result<(), ExecutionError> {
        panic!("the synthetic producer must never be dispatched")
    }
}
#[derive(Clone, Copy)]
enum Kind {
    Arena,
    Direct,
    Planned,
    Team,
}
struct Seed {
    input: FixedInput,
    result: FixedResult,
    revision: ExecutionId,
    selection: Option<AutomaticSelectionRequest>,
}
fn seed(store: &mut ProjectStore, unit: ExecutionId, kind: Kind, text: &str) -> Seed {
    let config = tsumugi_core::ai::AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-effect".into(),
        credential_env: String::new(),
        concurrency: 2,
        ..Default::default()
    };
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let team = matches!(kind, Kind::Team);
    let input = if matches!(kind, Kind::Arena) {
        let input = store
            .preview_arena(
                tsumugi_core::ai::arena::ArenaConfig {
                    variants: vec![config.clone(), config],
                    max_items: 1,
                    max_requests: 2,
                    concurrency: 1,
                    blind: true,
                    parent_attempt_id: None,
                },
                "zh-CN",
                &[unit],
            )
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        store.enqueue_execution(&input).unwrap();
        input
    } else if matches!(kind, Kind::Direct) {
        let input = store
            .preview_ai(config, "zh-CN", &[unit])
            .unwrap()
            .fixed_input(store.metadata().unwrap().project_id())
            .unwrap();
        store.enqueue_execution(&input).unwrap();
        input
    } else {
        let mut options = PlanOptions::default();
        if team {
            let member = TeamExecutionMember {
                member_id: ExecutionId::new(),
                role_version_id: ExecutionId::new(),
                display_name: "Synthetic translator".into(),
                role: "Translate the exact captured source.".into(),
                config: config.clone(),
                unit_ids: vec![unit],
                tool_handles: Vec::new(),
                kinds: vec![TeamWorkKind::Translation],
            };
            let other = TeamExecutionMember {
                member_id: ExecutionId::new(),
                role_version_id: ExecutionId::new(),
                display_name: "Synthetic peer".into(),
                ..member.clone()
            };
            options.team_discussions = Some(TeamDiscussionPolicy::CurrentPlanV2 {});
            options.team_execution = Some(TeamExecutionPolicy::BoundedTeamV1 {
                initial_member_id: member.member_id,
                initial_unit_id: unit,
                members: vec![member, other],
                limits: TeamExecutionLimits {
                    max_activations: 12,
                    max_concurrency: 2,
                    max_no_progress: 8,
                },
            });
        } else {
            options.selection_policy = SelectionPolicy::MissingOnly;
            options
                .stages
                .iter_mut()
                .find(|choice| choice.stage == WorkStage::Checks)
                .unwrap()
                .mode = StageMode::Assisted;
        }
        let plan = store
            .prepare_work_plan(Some(config), "zh-CN", &[unit], options)
            .unwrap();
        let action = ExecutionId::new();
        let grant = store
            .authorize_work_plan(
                &plan,
                &AuthorizeWorkPlan {
                    action_id: action,
                    plan_digest: plan.digest.clone(),
                    confirmed: true,
                    effects: plan.authorization_effects().unwrap(),
                    expires_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_secs()
                        + 600,
                },
            )
            .unwrap();
        if team {
            let prepared = store.prepare_team_root(grant.lease, action).unwrap();
            let mut runtime = ExecutionRuntime::new(store).unwrap();
            runtime.register(Arc::new(UndispatchedTeamRunner)).unwrap();
            runtime.submit_team_work(store, &prepared).unwrap();
            prepared.input().clone()
        } else {
            let input = FixedInput::capture(grant.input.unwrap()).unwrap();
            store.enqueue_execution(&input).unwrap();
            input
        }
    };
    let attempt = input.envelope().attempt_id;
    let item = input.envelope().items[0].item_id;
    let dispatch = store.dispatch_execution_item(attempt, item).unwrap();
    let output = if team {
        serde_json::to_value(TeamWorkOutput {
            outcome: TeamWorkOutcome::Translation {
                unit_id: unit,
                target_locale: "zh-CN".into(),
                text: text.into(),
            },
            usage: None,
            requests: 1,
            usage_incomplete: true,
        })
        .unwrap()
    } else {
        serde_json::to_value(tsumugi_core::ai::AiOutput {
            unit_id: unit,
            target_locale: "zh-CN".into(),
            text: text.into(),
            usage: None,
            requests: 1,
            usage_incomplete: true,
        })
        .unwrap()
    };
    let result = FixedResult::capture(
        ResultEnvelope {
            project_id: project,
            attempt_id: attempt,
            item_id: item,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: dispatch.dispatch_token,
            capability_id: input.envelope().capability_id.clone(),
            capability_version: input.envelope().capability_version.clone(),
            outcome: ExecutionState::Succeeded,
            output: Some(output),
            diagnostic: None,
            plugin: None,
        },
        &input,
        dispatch.dispatch_token,
    )
    .unwrap();
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(attempt, result.envelope().result_id)
        .unwrap();
    let action = store
        .prepare_adoption(
            attempt,
            input
                .envelope()
                .units
                .iter()
                .find(|unit| unit.item_ids.contains(&item))
                .unwrap()
                .unit_id,
            vec![result.envelope().result_id],
            Value::Null,
        )
        .unwrap();
    let receipt = if matches!(kind, Kind::Arena) {
        store
            .adopt_execution(&action, &ArenaAdoptionHandler)
            .unwrap()
    } else if team {
        store
            .adopt_execution(&action, &TeamTranslationAdoptionHandler)
            .unwrap()
    } else {
        store.adopt_execution(&action, &AiAdoptionHandler).unwrap()
    };
    let revision = ExecutionId::parse(
        &receipt
            .changes
            .iter()
            .find(|change| change.kind == "translation-revision")
            .unwrap()
            .id,
    )
    .unwrap();
    let selection = if matches!(kind, Kind::Planned) {
        Some(AutomaticSelectionRequest {
            project_id: project,
            action_id: ExecutionId::new(),
            lease: input.envelope().automation.unwrap(),
            unit_id: unit,
            locale: "zh-CN".into(),
            revision_id: revision,
        })
    } else {
        None
    };
    Seed {
        input,
        result,
        revision,
        selection,
    }
}
fn request(h: &Harness, unit: ExecutionId, revision: ExecutionId) -> Value {
    json!({"sessionToken":h.token,"projectId":h.project,"unitId":unit,"locale":"zh-CN","revisionId":revision})
}

#[test]
fn ai_candidate_effect_exact_ipc_keeps_original_receipt_after_pause_and_later_candidate_without_runtime()
 {
    let h = opened(false);
    let unit = h.units[0];
    let project = h.project;
    let (first, original, manual, clock) =
        h.app.state::<AppState>().sessions.with(move |sessions| {
            let active = sessions.active.as_mut().unwrap();
            assert!(active.execution.is_none());
            let store = &mut active.store;
            let first = seed(store, unit, Kind::Planned, "你好 {{name}} e\u{301} 👩🏽‍💻");
            let computed = store
                .prepare_automatic_selection(first.selection.as_ref().unwrap())
                .unwrap()
                .compute(&Cancellation::default())
                .unwrap();
            let receipt = store
                .commit_automatic_selection(computed, &Cancellation::default())
                .unwrap();
            assert!(receipt.selection.is_some());
            let target = store.review_target(project, unit, "zh-CN").unwrap();
            let manual = store
                .save_translation_revision(&SaveTranslationRevision {
                    project_id: project,
                    action_id: ExecutionId::new(),
                    unit_id: unit,
                    locale: "zh-CN".into(),
                    source_revision_id: target.source_revision_id,
                    expected_selection_id: target.selection_id,
                    text: String::new(),
                })
                .unwrap();
            let lease = first.input.envelope().automation.unwrap();
            store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: lease.plan_id,
                    expected_generation: lease.generation,
                    command: WorkPlanCommand::Pause,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
            let mut changed = first.result.envelope().clone();
            changed.result_id = ExecutionId::new();
            changed.supersedes = Some(first.result.envelope().result_id);
            let replacement = FixedResult::capture(
                changed,
                &first.input,
                first.result.envelope().dispatch_token,
            )
            .unwrap();
            assert_eq!(
                store.save_execution_result(&replacement).unwrap_err().stage,
                "result-replacement"
            );
            let later = seed(
                store,
                unit,
                Kind::Direct,
                "Later same-unit proposal {{name}}",
            );
            assert_ne!(
                later.input.envelope().attempt_id,
                first.input.envelope().attempt_id
            );
            let clock = store.changes_since(Revision::new(0).unwrap());
            (first, receipt, manual, clock)
        });
    let input = request(&h, unit, first.revision);
    let view = call(&h.window, "read_ai_candidate_effect", input.clone()).unwrap();
    assert_eq!(view["revisionId"], json!(first.revision));
    assert_eq!(view["attemptId"], json!(first.input.envelope().attempt_id));
    assert_eq!(view["itemId"], json!(first.result.envelope().item_id));
    assert_eq!(view["resultId"], json!(first.result.envelope().result_id));
    assert_eq!(view["taskId"], json!(first.input.envelope().task_id));
    assert_eq!(view["retained"], false);
    assert_eq!(view["currentResult"], true);
    assert_eq!(view["effect"]["phase"], "selected");
    assert_eq!(
        view["effect"]["receipt"],
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(view["effect"]["retryable"], false);
    h.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(
            active.execution.is_none(),
            "pure reads never initialize a runtime"
        );
        let after = active.store.changes_since(Revision::new(0).unwrap());
        assert_eq!(after.epoch, clock.epoch);
        assert_eq!(after.sequence, clock.sequence);
        let current = active.store.review_target(project, unit, "zh-CN").unwrap();
        assert_eq!(current.selection_id, Some(manual.event_id));
        assert_eq!(current.translation_text.as_deref(), Some(""));
        assert!(current.current_check.is_none());
    });
    for (key, value) in [
        ("sessionToken", json!("foreign")),
        ("projectId", json!(ExecutionId::new())),
        ("unitId", json!(h.units[1])),
        ("locale", json!("fr-FR")),
        ("locale", json!("ZH-cn")),
        ("revisionId", json!(ExecutionId::new())),
    ] {
        let mut wrong = input.clone();
        wrong[key] = value;
        assert!(
            call(&h.window, "read_ai_candidate_effect", wrong).is_err(),
            "{key}"
        );
    }
}

#[test]
fn ai_candidate_effect_exact_ipc_supports_direct_and_team_and_only_matches_the_original_saved_producer()
 {
    let h = opened(true);
    let unit = h.units[0];
    let project = h.project;
    let (direct, team) = h.app.state::<AppState>().sessions.with(move |sessions| {
        let store = &mut sessions.active.as_mut().unwrap().store;
        (
            seed(store, unit, Kind::Direct, "Direct {{name}}"),
            seed(store, unit, Kind::Team, "Team {{name}} e\u{301} 👩🏽‍💻"),
        )
    });
    let plain = call(
        &h.window,
        "read_ai_candidate_effect",
        request(&h, unit, direct.revision),
    )
    .unwrap();
    assert_eq!(plain["planId"], Value::Null);
    assert_eq!(plain["effect"], Value::Null);
    assert_eq!(plain["retained"], false);
    let team_request = request(&h, unit, team.revision);
    let history = call(&h.window, "read_ai_candidate_effect", team_request.clone()).unwrap();
    assert_eq!(
        history["planId"],
        json!(team.input.envelope().automation.unwrap().plan_id)
    );
    assert_eq!(history["effect"], Value::Null);
    assert_eq!(history["retained"], false);
    h.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        let proof = active
            .store
            .saved_ai_candidate_effect(project, unit, "zh-CN", team.revision)
            .unwrap();
        let mut host = ExecutionHost::new(&active.store).unwrap();
        host.ai
            .automation
            .track(&active.store, &team.input, None)
            .unwrap();
        assert!(
            host.ai
                .automation
                .view_for_candidate(&proof)
                .unwrap()
                .is_none(),
            "an unsaved producer slot is not the saved revision"
        );
        // This controlled fixture tick can only observe the already-saved result;
        // checks are manual and no model runner is dispatched or ticked.
        host.ai
            .automation
            .tick(&mut active.store, &mut host.runtime);
        assert_eq!(
            host.ai
                .automation
                .view_for_candidate(&proof)
                .unwrap()
                .unwrap()
                .phase,
            EffectPhase::Saved
        );
        let mut wrong = proof.clone();
        wrong.current_result = false;
        assert!(
            host.ai
                .automation
                .view_for_candidate(&wrong)
                .unwrap()
                .is_none()
        );
        let mut wrong = proof.clone();
        wrong.revision_id = ExecutionId::new();
        assert!(
            host.ai
                .automation
                .view_for_candidate(&wrong)
                .unwrap()
                .is_none()
        );
        let mut wrong = proof.clone();
        let generation = wrong.lease.unwrap().generation;
        wrong.lease.as_mut().unwrap().generation = Revision::new(generation.get() + 1).unwrap();
        assert!(host.ai.automation.view_for_candidate(&wrong).is_err());
        active.execution = Some(host);
    });
    let live = call(&h.window, "read_ai_candidate_effect", team_request).unwrap();
    assert_eq!(live["retained"], true);
    assert_eq!(live["effect"]["phase"], "saved");
    assert_eq!(live["effect"]["receipt"], Value::Null);
    let still_direct = call(
        &h.window,
        "read_ai_candidate_effect",
        request(&h, unit, direct.revision),
    )
    .unwrap();
    assert_eq!(still_direct["effect"], Value::Null);
    assert_eq!(still_direct["retained"], false);
}

#[test]
fn ai_candidate_effect_exact_ipc_reads_arena_provenance_and_empty_text_without_an_effect_or_runtime()
 {
    let h = opened(true);
    let unit = h.units[0];
    let project = h.project;
    let (arena, saved, clock) = h.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none());
        let arena = seed(&mut active.store, unit, Kind::Arena, "");
        let saved = active
            .store
            .translation_revision(project, unit, "zh-CN", arena.revision)
            .unwrap();
        assert_eq!(saved.text, "");
        let clock = active.store.changes_since(Revision::new(0).unwrap());
        (arena, saved, clock)
    });
    let view = call(
        &h.window,
        "read_ai_candidate_effect",
        request(&h, unit, arena.revision),
    )
    .unwrap();
    for (field, identity) in [
        ("projectId", project),
        ("unitId", unit),
        ("revisionId", arena.revision),
        ("sourceSnapshotId", saved.source_snapshot_id),
        ("sourceRevisionId", saved.source_revision_id),
        ("attemptId", arena.input.envelope().attempt_id),
        ("taskId", arena.input.envelope().task_id),
        ("itemId", arena.result.envelope().item_id),
        ("resultId", arena.result.envelope().result_id),
    ] {
        assert_eq!(view[field], json!(identity), "{field}");
    }
    assert_eq!(view["planId"], Value::Null);
    assert_eq!(view["planGeneration"], Value::Null);
    assert_eq!(view["effect"], Value::Null);
    assert_eq!(view["retained"], false);
    assert_eq!(view["currentResult"], true);
    h.app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(active.execution.is_none());
        let after = active.store.changes_since(Revision::new(0).unwrap());
        assert_eq!(after.epoch, clock.epoch);
        assert_eq!(after.sequence, clock.sequence);
    });
}

#[test]
fn ai_candidate_effect_wire_fixture_matches_the_exact_read_contract() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../test/fixtures/aiCommands.contract.json"
    ))
    .unwrap();
    let request: AiCandidateEffectRequest =
        serde_json::from_value(fixture["requests"]["candidateEffect"].clone()).unwrap();
    let response: AiCandidateEffectView =
        serde_json::from_value(fixture["responses"]["candidateEffect"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        fixture["requests"]["candidateEffect"]
    );
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        fixture["responses"]["candidateEffect"]
    );
}
