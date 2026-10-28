use super::*;
use serde_json::{Value, json};
use tauri::{ipc::{CallbackFn, InvokeBody}, webview::InvokeRequest};
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/automatic.rs"]
mod automatic;

fn call(window: &tauri::WebviewWindow<tauri::test::MockRuntime>, command: &str, request: Value) -> Result<Value, Value> {
    tauri::test::get_ipc_response(window, InvokeRequest { cmd: command.into(), callback: CallbackFn(0), error: CallbackFn(1),
        url: crate::ipc_test_url().parse().unwrap(), body: InvokeBody::Json(json!({"request": request})),
        headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into() })
        .map(|response| response.deserialize::<Value>().unwrap())
}

#[test]
fn decision_wire_fixture_preserves_missing_source_counts_and_typed_targets() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../../test/fixtures/decisionCommands.contract.json")).unwrap();
    let request: DecisionPageRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
    let response: DecisionPage = serde_json::from_value(fixture["response"].clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), fixture["request"]);
    assert_eq!(serde_json::to_value(response).unwrap(), fixture["response"]);
}

#[test]
fn registered_decision_inbox_pages_original_facts_and_rechecks_after_owner_decisions() {
    let (directory, mut core, rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let candidate = automatic::candidate_request(&mut core, unit, "A candidate", tsumugi_core::application::SelectionPolicy::CandidatesOnly);
    core.save_translation_revision(&tsumugi_core::SaveTranslationRevision { reuse_origin: None, project_id: project, action_id: ExecutionId::new(),
        unit_id: unit, locale: "zh-CN".into(), source_revision_id: rows[0].source_revision_id.unwrap(),
        expected_selection_id: None, text: "Saved translation".into() }).unwrap();
    core.close().unwrap();
    let app = tauri::test::mock_builder().manage(AppState::default()).invoke_handler(super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let request = json!({"sessionToken": opened["sessionToken"], "projectId": project,
        "query": {"locale": null, "sources": []}, "cursor": null, "limit": 1});
    let first = call(&window, "read_decision_page", request.clone()).unwrap();
    let repeated = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(first, repeated, "reading does not advance a source or resolve a request");
    assert_eq!(first["total"], Value::Null, "unconnected sources are not global zero");
    assert_eq!(first["coverage"].as_array().unwrap().len(), 10);
    assert_eq!(first["coverage"].as_array().unwrap().iter().filter(|source| source["state"] == "unavailable").count(), 2);
    let mut ids = Vec::new();
    let mut page = first.clone();
    loop {
        let decoded: DecisionPage = serde_json::from_value(page.clone()).unwrap();
        assert_eq!(decoded.project_id, project);
        ids.extend(decoded.items.into_iter().map(|item| item.decision_id));
        if page["next"].is_null() { break; }
        let mut next = request.clone(); next["cursor"] = page["next"].clone();
        page = call(&window, "read_decision_page", next).unwrap();
    }
    assert_eq!(ids.len(), first["knownCount"].as_u64().unwrap() as usize);
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(ids.iter().any(|id| id.contains(&candidate.revision_id.to_string())));
    let mut focused = request.clone(); focused["query"] = json!({"locale": "zh-CN", "sources": ["translation-candidate"]});
    let candidates = call(&window, "read_decision_page", focused.clone()).unwrap();
    assert_eq!(candidates["total"], 1);
    let target = call(&window, "read_review_target", json!({"sessionToken": opened["sessionToken"], "projectId": project,
        "unitId": unit, "locale": "zh-CN"})).unwrap();
    call(&window, "decide_translation_candidate", json!({"sessionToken": opened["sessionToken"], "projectId": project,
        "decision": {"projectId": project, "actionId": ExecutionId::new(), "unitId": unit, "locale": "zh-CN",
            "revisionId": candidate.revision_id, "sourceRevisionId": target["sourceRevisionId"],
            "expectedSelectionId": target["selectionId"], "expectedDecisionId": null, "disposition": "rejected",
            "actor": "Synthetic reviewer", "reason": "Use the saved translation"}})).unwrap();
    let mut stale = request.clone(); stale["cursor"] = first["next"].clone();
    assert!(call(&window, "read_decision_page", stale).is_err());
    let resolved = call(&window, "read_decision_page", focused).unwrap();
    assert_eq!(resolved["total"], 0);
    assert_eq!(resolved["items"], json!([]));
    for (field, value) in [("projectId", json!(ExecutionId::new())), ("sessionToken", json!("stale")),
        ("query", json!({"locale": "ZH-cn", "sources": []})), ("limit", json!(0))] {
        let mut wrong = request.clone(); wrong[field] = value;
        assert!(call(&window, "read_decision_page", wrong).is_err(), "{field}");
    }
    call(&window, "close_project", json!({"sessionToken": opened["sessionToken"], "projectId": project})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator": directory.path().join("project")})).unwrap();
    let mut after_reopen = request;
    after_reopen["sessionToken"] = reopened["sessionToken"].clone();
    after_reopen["query"] = json!({"locale": "zh-CN", "sources": ["translation-candidate"]});
    assert_eq!(call(&window, "read_decision_page", after_reopen).unwrap()["total"], 0);
}

#[test]
fn registered_local_inbox_checks_receipts_and_lifecycle_without_resolving_original_input() {
    use crate::commands::drafts::{ConversationDraftWrite, DraftStore, DraftWrite};
    let (directory, mut core, rows) = fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let action = ExecutionId::new();
    let original = tsumugi_core::SaveTranslationRevision { reuse_origin: None, project_id: project, action_id: action, unit_id: unit,
        locale: "zh-CN".into(), source_revision_id: rows[0].source_revision_id.unwrap(), expected_selection_id: None, text: "Submitted A".into() };
    core.close().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let journal = DraftStore::at(profile.path().join("drafts")).unwrap();
    let writer = ExecutionId::new();
    let write: DraftWrite = serde_json::from_value(json!({"key":{"projectId":project,"unitId":unit,"locale":"zh-CN"},
        "expectedRevision":"0","writerId":writer,"value":{"basis":{"sourceRevisionId":original.source_revision_id,"selectionId":null,"revisionId":null,"text":null},
            "text":"Newer B","editSeq":"2","pending":{"kind":"save","request":original,"submittedSeq":"1"}}})).unwrap();
    let before = journal.write(&write).unwrap();
    let thread = ExecutionId::new();
    let create_action = ExecutionId::new();
    let conversation: ConversationDraftWrite = serde_json::from_value(json!({"key":{"projectId":project,"conversationId":thread},
        "expectedRevision":"0","writerId":writer,"value":{"text":"New message input","editSeq":"1","pending":{"kind":"create","submittedSeq":"1",
            "request":{"projectId":project,"actionId":create_action,"conversationId":thread,"title":"Synthetic thread"}}}})).unwrap();
    journal.write_conversation(&conversation).unwrap();
    let state = AppState::default(); state.local_drafts.set(journal.clone()).ok().unwrap();
    let app = tauri::test::mock_builder().manage(state).invoke_handler(super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator":directory.path().join("project")})).unwrap();
    let mut request = json!({"sessionToken":opened["sessionToken"],"projectId":project,
        "query":{"locale":null,"sources":["local-action-recovery"]},"cursor":null,"limit":100,"activity":null});
    let unobserved = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(unobserved["knownCount"], 0);
    assert_eq!(unobserved["total"], Value::Null);
    assert_eq!(unobserved["coverage"][0]["reason"], "lifecycle-unavailable");
    assert_eq!(unobserved["localActions"]["observations"].as_array().unwrap().len(), 2);
    request["activity"] = json!([{"ownerId":writer,"revision":"1","actions":[{"key":{"kind":"translation","unitId":unit,"locale":"zh-CN"},
        "slot":"primary","actionId":action,"submittedSeq":"1"}]}]);
    let running = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(running["total"], 1, "the live save is progress; the unowned conversation needs a check");
    assert_eq!(running["items"][0]["targets"][0]["kind"], "conversation");
    assert!(running["localActions"]["observations"].as_array().unwrap().iter().any(|row| row["outcome"] == "in-flight"));
    request["activity"] = json!([]);
    let unknown = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(unknown["total"], 2);
    let mut save = serde_json::to_value(&original).unwrap(); save["sessionToken"] = opened["sessionToken"].clone();
    call(&window, "save_translation_revision", save).unwrap();
    let recorded = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(recorded["total"], 1);
    assert!(recorded["localActions"]["observations"].as_array().unwrap().iter().any(|row| row["outcome"] == "recorded"));
    let after = journal.read(&write.key).unwrap();
    assert_eq!(after, before, "inbox reads leave B and the exact original pending request intact");
    let mut malformed = request.clone();
    malformed["activity"] = json!([{"ownerId":writer,"revision":"1","actions":[]},{"ownerId":writer,"revision":"2","actions":[]}]);
    assert!(call(&window, "read_decision_page", malformed).is_err());
}

/// Use the same source, qualification and build owners as the release receipt
/// fixture. No release or delivery row is inserted directly into SQLite.
fn release_for_decision_inbox(store: &mut ProjectStore) -> ExecutionId {
    use std::{sync::Arc, time::{Duration, Instant}};
    use tsumugi_core::{BuildLocaleChoice, ReleaseAdoptionHandler, ReviewDecisionKind, ReviewWrite,
        SaveTranslationRevision, content::{BuildRunner, SourceAdoptionHandler, SourceBundle, SourceRunner},
        execution::{ExecutionRuntime, FixedInput}};
    fn run(store: &mut ProjectStore, runtime: &mut ExecutionRuntime, input: &FixedInput) -> ExecutionId {
        runtime.submit(store, input).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            runtime.tick(store).unwrap();
            if let Some(result) = store.execution_current_result(input.envelope().attempt_id,
                input.envelope().items[0].item_id).unwrap() {
                if !runtime.has_active_work(store).unwrap() { return result; }
            }
            assert!(Instant::now() < deadline, "synthetic release did not complete");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let metadata = store.metadata().unwrap();
    let project = ExecutionId::parse(&metadata.project_id().to_string()).unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.register_read_only(Arc::new(BuildRunner)).unwrap();
    let source = SourceBundle::capture(
        br#"{"UniqueID":"Delivery.Inbox","Name":"Delivery","Version":"1.0.0","EntryDll":"Delivery.dll"}"#,
        br#"{"hello":"Hello"}"#, "en").unwrap().fixed_input(metadata.project_id()).unwrap();
    let result = run(store, &mut runtime, &source);
    let preview = store.source_preview(source.envelope().attempt_id, result, 0, 10).unwrap();
    let source_action = store.prepare_adoption(source.envelope().attempt_id,
        source.envelope().units[0].unit_id, vec![result], serde_json::to_value(preview.confirmation).unwrap()).unwrap();
    store.adopt_execution(&source_action, &SourceAdoptionHandler).unwrap();
    let target = store.review_page(project, "zh-CN", 0, 10).unwrap().rows.remove(0);
    store.save_translation_revision(&SaveTranslationRevision { reuse_origin: None, project_id: project, action_id: ExecutionId::new(),
        unit_id: target.unit_id, locale: "zh-CN".into(), source_revision_id: target.source_revision_id,
        expected_selection_id: None, text: "Synthetic translation".into() }).unwrap();
    let target = store.review_target(project, target.unit_id, "zh-CN").unwrap();
    store.run_review_checks(project, target.unit_id, "zh-CN", &target.basis, ExecutionId::new()).unwrap();
    let target = store.review_target(project, target.unit_id, "zh-CN").unwrap();
    store.write_review(&ReviewWrite { project_id: project, action_id: ExecutionId::new(), unit_id: target.unit_id,
        locale: "zh-CN".into(), expected_basis: target.basis, expected_decision_id: None,
        actor: "Synthetic reviewer".into(), kind: ReviewDecisionKind::Approve, reason: String::new() }).unwrap();
    let eligibility = store.review_eligibility(project, &["zh-CN".into()]).unwrap();
    assert!(eligibility.ready);
    let build = store.prepare_locale_build(project, ExecutionId::new(),
        &[BuildLocaleChoice { locale: "zh-CN".into(), file_name: "i18n/zh.json".into() }], &eligibility.basis).unwrap();
    let result = run(store, &mut runtime, &build);
    store.validate_execution_result(build.envelope().attempt_id, result).unwrap();
    let action = store.prepare_adoption(build.envelope().attempt_id, build.envelope().units[0].unit_id,
        vec![result], Value::Null).unwrap();
    let receipt = store.adopt_execution(&action, &ReleaseAdoptionHandler).unwrap();
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

#[test]
fn registered_delivery_unknown_inbox_reads_original_receipts_without_destination_authority() {
    use tauri::Manager;
    use tsumugi_core::{DecisionAction, DecisionEvidence, DecisionState, DecisionTarget,
        DeliveryFileState, DeliveryState, ProjectMetadata};
    let directory = tempfile::tempdir().unwrap();
    let project_path = directory.path().join("project");
    let mut core = ProjectStore::create(&project_path,
        ProjectMetadata::create("Delivery inbox", "en", ["zh-CN"]).unwrap()).unwrap();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let release = release_for_decision_inbox(&mut core);
    let pending = core.begin_delivery(ExecutionId::new(), release,
        &directory.path().join("pending-destination").to_string_lossy(), false).unwrap();
    let original = core.begin_delivery(ExecutionId::new(), release,
        &directory.path().join("unknown-destination").to_string_lossy(), false).unwrap();
    let unknown = core.finish_delivery(original.action_id, original.files.into_iter().map(|mut file| {
        file.state = DeliveryFileState::Unknown; file
    }).collect()).unwrap();
    assert_eq!(unknown.state, DeliveryState::Unknown);
    core.set_target_locales(core.metadata().unwrap().metadata_revision(), &["fr-FR".into()]).unwrap();
    core.close().unwrap();

    let app = tauri::test::mock_builder().manage(AppState::default()).invoke_handler(super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    let observer = rusqlite::Connection::open(project_path.join("project.sqlite3")).unwrap();
    let data_version = || observer.pragma_query_value::<i64, _>(None, "data_version", |row| row.get(0)).unwrap();
    let before = data_version();
    let mut request = json!({"sessionToken":opened["sessionToken"],"projectId":project,
        "query":{"locale":null,"sources":["delivery-unknown"]},"cursor":null,"limit":100});
    let read = call(&window, "read_decision_page", request.clone()).unwrap();
    assert_eq!(call(&window, "read_decision_page", request.clone()).unwrap(), read);
    let page: DecisionPage = serde_json::from_value(read.clone()).unwrap();
    assert_eq!(page.total, Some(2));
    assert!(page.delivery_activity.is_empty());
    for delivery in [&pending, &unknown] {
        let item = page.items.iter().find(|item| item.source_action_id == Some(delivery.action_id)).unwrap();
        assert_eq!(item.state, DecisionState::AwaitingRecheck);
        assert_eq!(item.locale.as_deref(), Some("zh-CN"), "locale comes from immutable delivered files");
        assert_eq!(item.targets, vec![DecisionTarget::Delivery { release_id: release, delivery_id: delivery.delivery_id }]);
        assert_eq!(item.action, DecisionAction::InspectDeliveryOutcome { release_id: release,
            delivery_id: delivery.delivery_id, action_id: delivery.action_id });
        match item.evidence.as_ref().unwrap() {
            DecisionEvidence::DeliveryOutcome { state, locales, file_count, unknown_file_count } => {
                assert_eq!(*state, delivery.state);
                assert_eq!(locales, &["zh-CN".to_owned()]);
                assert_eq!(*file_count, 1);
                assert_eq!(*unknown_file_count, u32::from(delivery.state == DeliveryState::Unknown));
            }
            evidence => panic!("unexpected delivery evidence: {evidence:?}"),
        }
    }
    let wire = serde_json::to_string(&page.items).unwrap();
    assert!(!wire.contains("directory") && !wire.contains("pending-destination") && !wire.contains("unknown-destination"));
    assert_eq!(data_version(), before, "registered inbox reads cannot write the project database");
    let original_pending = pending.clone();
    let original_unknown = unknown.clone();
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(active.execution.is_none());
        assert!(!active.store.is_reconciling());
        assert_eq!(active.store.delivery_by_action(original_pending.action_id).unwrap().as_ref(), Some(&original_pending));
        assert_eq!(active.store.delivery_by_action(original_unknown.action_id).unwrap().as_ref(), Some(&original_unknown));
    });
    let mut old_locale = request.clone(); old_locale["query"]["locale"] = json!("zh-CN");
    assert_eq!(call(&window, "read_decision_page", old_locale).unwrap()["total"], 2);
    let lookup = json!({"sessionToken":opened["sessionToken"],"projectId":project,
        "selectionId":ExecutionId::new(),"actionId":unknown.action_id});
    assert_eq!(call(&window, "read_delivery_action", lookup.clone()).unwrap_err()["code"], "session-invalid");
    call(&window, "close_project", json!({"sessionToken":opened["sessionToken"]})).unwrap();
    let reopened = call(&window, "open_project", json!({"locator":project_path})).unwrap();
    request["sessionToken"] = reopened["sessionToken"].clone();
    let reopened_page: DecisionPage = serde_json::from_value(call(&window, "read_decision_page", request.clone()).unwrap()).unwrap();
    assert_eq!(reopened_page.items, page.items);
    let mut reopened_lookup = lookup; reopened_lookup["sessionToken"] = reopened["sessionToken"].clone();
    assert_eq!(call(&window, "read_delivery_action", reopened_lookup).unwrap_err()["code"], "session-invalid");
    app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_mut().unwrap();
        assert!(active.execution.is_none(), "reopen and history reads restore no native selection or runtime");
        // Explicit original-owner settlement over synthetic file observations.
        // This is not native destination IO or an inbox-triggered mutation.
        let observed = unknown.files.iter().cloned().map(|mut file| {
            file.state = DeliveryFileState::Succeeded; file.actual_sha256 = Some(file.expected_sha256.clone()); file
        }).collect();
        active.store.reconcile_delivery(unknown.action_id, observed).unwrap();
    });
    let resolved = call(&window, "read_decision_page", request).unwrap();
    assert_eq!(resolved["total"], 1);
    assert_eq!(resolved["items"][0]["sourceActionId"], json!(pending.action_id));
    assert!(!directory.path().join("pending-destination").exists());
    assert!(!directory.path().join("unknown-destination").exists());
}
