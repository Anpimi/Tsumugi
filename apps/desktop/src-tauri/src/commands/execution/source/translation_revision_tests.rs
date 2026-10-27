use super::*;
use serde_json::{Value, json};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

#[allow(dead_code)]
#[path = "../../../../../../../crates/core/tests/support/mod.rs"]
mod source_fixture;

fn call(
    window: &tauri::WebviewWindow<tauri::test::MockRuntime>,
    request: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        InvokeRequest {
            cmd: "read_translation_revision".into(),
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

#[test]
fn translation_revision_exact_ipc_preserves_full_history_metadata_and_rejects_foreign_tuples() {
    let (directory, mut core, rows) = source_fixture::source_fixture();
    let project = ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let unit = rows[0].unit_id.unwrap();
    let first_request = SaveTranslationRevision {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        source_revision_id: rows[0].source_revision_id.unwrap(),
        expected_selection_id: None,
        text: "First contributor e\u{301}".into(),
    };
    let first = core.save_translation_revision(&first_request).unwrap();
    let mut last = first.clone();
    for index in 1..52 {
        let request = SaveTranslationRevision {
            action_id: ExecutionId::new(),
            expected_selection_id: Some(last.event_id),
            text: if index == 51 {
                String::new()
            } else {
                format!("Human revision {index}")
            },
            ..first_request.clone()
        };
        last = core.save_translation_revision(&request).unwrap();
    }
    let page = core
        .translation_history(project, unit, "zh-CN", 0, 50)
        .unwrap();
    assert!(
        !page
            .rows
            .iter()
            .any(|row| row.revision_id == last.revision_id)
    );
    let empty = core
        .translation_revision(project, unit, "zh-CN", last.revision_id)
        .unwrap();
    assert_eq!(empty.text, "");
    assert_eq!(empty.ordinal, 52);
    let comparison = core
        .create_comparison(&tsumugi_core::ComparisonRequest {
            project_id: project,
            action_id: ExecutionId::new(),
            unit_id: unit,
            locale: "zh-CN".into(),
            revision_ids: vec![first.revision_id, last.revision_id],
            blind: false,
        })
        .unwrap();
    let merge = tsumugi_core::MergeBasis {
        contributors: vec![first.revision_id, last.revision_id],
        expected_basis: comparison.basis,
    };
    let request = SaveTranslationRevision {
        action_id: ExecutionId::new(),
        expected_selection_id: Some(last.event_id),
        text: "Merged {{name}}\r\ne\u{301} 👩🏽‍💻 日本語".into(),
        ..first_request
    };
    let saved = core.save_merged_translation(&request, &merge).unwrap();
    let expected = core
        .translation_history(project, unit, "zh-CN", 52, 1)
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(expected.revision_id, saved.revision_id);
    assert_eq!(expected.contributors, merge.contributors);
    assert_eq!(
        core.translation_revision(project, unit, "zh-CN", saved.revision_id)
            .unwrap(),
        expected
    );
    core.close().unwrap();
    let state = AppState::default();
    let app = tauri::test::mock_builder()
        .manage(state)
        .invoke_handler(super::super::super::handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let opened = tauri::test::get_ipc_response(
        &window,
        InvokeRequest {
            cmd: "open_project".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(json!({"request":{"locator":directory.path().join("project")}})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize::<Value>()
    .unwrap();
    let before = app.state::<AppState>().sessions.with(|sessions| {
        sessions
            .active
            .as_ref()
            .unwrap()
            .store
            .changes_since(Revision::new(0).unwrap())
            .sequence
    });
    let lookup = json!({"sessionToken":opened["sessionToken"],"projectId":project,"unitId":unit,"locale":"zh-CN","revisionId":saved.revision_id});
    assert_eq!(
        call(&window, lookup.clone()).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let mut empty_lookup = lookup.clone();
    empty_lookup["revisionId"] = json!(last.revision_id);
    assert_eq!(
        call(&window, empty_lookup).unwrap(),
        serde_json::to_value(&empty).unwrap()
    );
    for (field, value) in [
        ("sessionToken", json!("foreign-session")),
        ("projectId", json!(ExecutionId::new())),
        ("unitId", json!(rows[1].unit_id.unwrap())),
        ("locale", json!("ja")),
        ("revisionId", json!(ExecutionId::new())),
    ] {
        let mut wrong = lookup.clone();
        wrong[field] = value;
        assert!(call(&window, wrong).is_err(), "{field}");
    }
    let mut noncanonical = lookup.clone();
    noncanonical["locale"] = json!("zh-cn");
    assert!(call(&window, noncanonical).is_err());
    let current = app.state::<AppState>().sessions.with(move |sessions| {
        let active = sessions.active.as_ref().unwrap();
        assert!(
            active.execution.is_none(),
            "exact lookup cannot create a runtime"
        );
        let revision = active
            .store
            .translation_history(project, unit, "zh-CN", 52, 1)
            .unwrap()
            .rows
            .remove(0);
        (
            revision,
            active
                .store
                .changes_since(Revision::new(0).unwrap())
                .sequence,
        )
    });
    assert_eq!(current, (expected, before));
}
