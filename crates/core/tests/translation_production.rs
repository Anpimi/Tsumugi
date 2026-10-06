#![cfg(not(feature = "execution-test-host"))]
//! Production Core behavior, independently of the opt-in built-in importer.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tsumugi_core::{
    ProjectMetadata, ProjectStore, SaveTranslationRevision,
    content::{ContentRow, SourceAdoptionHandler, SourceBundle, SourceRunner},
    execution::*,
};

fn source_fixture() -> (tempfile::TempDir, ProjectStore, Vec<ContentRow>) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Production translation", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    // The existing source baseline establishes synthetic content only. No
    // translation importer, plugin process or independent checker is invoked.
    let source = SourceBundle::capture(
        br#"{"UniqueID":"Synthetic.Mod","Name":"Synthetic","Version":"1.0.0","EntryDll":"Synthetic.dll"}"#,
        br#"{"first":"same","second":"same"}"#,
        "en",
    ).unwrap();
    let input = source
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = loop {
        runtime.tick(&mut store).unwrap();
        let status = store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap();
        if status.items[0].execution == ExecutionState::Succeeded {
            break store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    };
    let preview = store
        .source_preview(input.envelope().attempt_id, result, 0, 10)
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let rows = store.source_content(snapshot, 0, 10).unwrap().rows;
    (directory, store, rows)
}

fn legacy_input(store: &ProjectStore) -> FixedInput {
    // Independent captured input for the former wire shape. It is complete and
    // accepted by the old importer; no removed Rust importer type is required.
    let bundle = ExecutionId::new();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let artifact = ExecutionId::new();
    let raw = "{\"first\":\"译文\"}";
    let file_digest = tsumugi_plugin_sdk::payload_digest(raw);
    let manifest = serde_json::to_string(&(
        1u32,
        "stardew-smapi",
        "0.1.0",
        bundle,
        snapshot,
        "zh-CN",
        "zh",
        "user-confirmed",
        "smapi-i18n-flat",
        1u32,
        artifact,
        "i18n/zh.json",
        "translation",
        raw.len() as u32,
        &file_digest,
    ))
    .unwrap();
    let item = InputItem::new(
        Scope {
            kind: "translation-entry".into(),
            id: format!("{bundle}:0"),
            locale: Some("zh-CN".into()),
        },
        serde_json::json!(0),
        vec![],
    );
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "translation-import",
        "stardew-smapi.translation-extract",
        "1",
        vec![item],
    )
    .unwrap();
    envelope.settings = serde_json::json!({
        "version":1,"pluginId":"stardew-smapi","pluginVersion":"0.1.0",
        "bundleId":bundle,"sourceSnapshotId":snapshot,"targetLocale":"zh-CN",
        "declaredLocale":"zh","languageEvidence":"user-confirmed",
        "formatId":"smapi-i18n-flat","formatVersion":1,
        "file":{"artifactId":artifact,"logicalPath":"i18n/zh.json","role":"translation",
            "byteLength":raw.len(),"sha256":file_digest,"utf8":raw},
        "manifestDigest":tsumugi_plugin_sdk::payload_digest(&manifest),
    });
    FixedInput::capture(envelope).unwrap()
}

#[test]
fn production_translation_rejects_complete_built_in_input_without_writes() {
    let (_directory, mut store, _) = source_fixture();
    let zero = Revision::new(0).unwrap();
    let before = serde_json::to_value(store.changes_since(zero)).unwrap();
    let input = legacy_input(&store);
    let error = store.enqueue_execution(&input).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.stage, "translation-projection-required");
    assert_eq!(
        serde_json::to_value(store.changes_since(zero)).unwrap(),
        before
    );
    assert_eq!(
        store
            .execution_input(input.envelope().attempt_id)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn production_translation_manual_history_and_original_receipts_survive_reopen() {
    let (directory, mut store, rows) = source_fixture();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let first = SaveTranslationRevision {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: rows[0].unit_id.unwrap(),
        locale: "zh-CN".into(),
        source_revision_id: rows[0].source_revision_id.unwrap(),
        expected_selection_id: None,
        text: "译文 👩🏽‍💻 e\u{301}\nline two".into(),
    };
    let original = store.save_translation_edit(&first).unwrap();
    let next = SaveTranslationRevision {
        action_id: ExecutionId::new(),
        expected_selection_id: Some(original.selection.event_id),
        text: "Later draft".into(),
        ..first.clone()
    };
    let latest = store.save_translation_edit(&next).unwrap();
    let empty = SaveTranslationRevision {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: rows[1].unit_id.unwrap(),
        locale: "zh-CN".into(),
        source_revision_id: rows[1].source_revision_id.unwrap(),
        expected_selection_id: None,
        text: String::new(),
    };
    let empty_receipt = store.save_translation_edit(&empty).unwrap();
    assert_eq!(store.save_translation_edit(&first).unwrap(), original);
    drop(store);
    let mut reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.save_translation_edit(&first).unwrap(), original);
    assert_eq!(
        reopened
            .translation_selection_by_action(project, first.unit_id, "zh-CN", first.action_id)
            .unwrap(),
        Some(original.selection)
    );
    let history = reopened
        .translation_history(project, first.unit_id, "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.rows.len(), 2);
    assert_eq!(history.rows[0].text, first.text);
    assert_eq!(history.rows[1].text, "Later draft");
    assert_eq!(history.current, Some(latest.selection));
    let history = reopened
        .translation_history(project, empty.unit_id, "zh-CN", 0, 10)
        .unwrap();
    assert_eq!(history.rows[0].text, "");
    assert_eq!(history.current, Some(empty_receipt.selection));
}
