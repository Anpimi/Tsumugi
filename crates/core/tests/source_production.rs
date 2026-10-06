#![cfg(not(feature = "execution-test-host"))]
//! Production source capture requires an explicitly selected plugin and checker.
mod support;
use support::source_fixture;
use tsumugi_core::{PersistenceErrorCode, ProjectMetadata, ProjectStore, execution::*};

#[test]
fn production_source_rejects_complete_built_in_input_without_writes() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Production source", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let set = ExecutionId::new();
    let material = |path: &str, role: &str, text: &str| {
        serde_json::json!({
            "id":ExecutionId::new(), "logicalPath":path, "role":role,
            "sha256":tsumugi_plugin_sdk::payload_digest(text), "utf8":text,
        })
    };
    let profile = serde_json::json!({"id":"smapi-i18n-flat","schemaVersion":1,"behaviorVersion":1});
    let item = InputItem::new(
        Scope {
            kind: "source".into(),
            id: set.to_string(),
            locale: None,
        },
        serde_json::json!({"profile":profile,"sourceSetId":set,"sourceLanguage":"en",
            "artifacts":[material("manifest.json","companion",r#"{"UniqueID":"Synthetic.Mod","Name":"Synthetic","Version":"1.0.0","EntryDll":"Synthetic.dll"}"#),
                material("i18n/default.json","source",r#"{"first":"same","second":"same"}"#)]}),
        vec![],
    );
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "source-import",
        "stardew-smapi.extract",
        "1",
        vec![item],
    )
    .unwrap();
    envelope.settings = serde_json::json!({"revisionPolicy":{"profile":profile,"revisionBasis":[]},"checker":null,"semanticRules":[]});
    let input = FixedInput::capture(envelope).unwrap();
    let zero = Revision::new(0).unwrap();
    let before = serde_json::to_value(store.changes_since(zero)).unwrap();
    let error = store.enqueue_execution(&input).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.stage, "source-plugin-required");
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
fn production_source_schema_refuses_previous_format_without_changing_files() {
    let (directory, store, _) = source_fixture();
    store.close().unwrap();
    let project = directory.path().join("project");
    let connection = rusqlite::Connection::open(project.join("project.sqlite3")).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 23);
    connection.pragma_update(None, "user_version", 22).unwrap();
    drop(connection);
    let files = || {
        std::fs::read_dir(&project)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                (e.file_name(), std::fs::read(e.path()).unwrap())
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let before = files();
    let error = ProjectStore::open(&project).unwrap_err();
    assert_eq!(error.code(), PersistenceErrorCode::UnsupportedSchema);
    assert_eq!(error.found_schema_version(), Some(22));
    assert_eq!(files(), before);
}

#[test]
fn production_source_requires_an_independent_checker_without_writes() {
    let (_directory, mut store, _) = source_fixture();
    let mut envelope = support::source_input(&store).envelope().clone();
    envelope.settings["checker"] = serde_json::Value::Null;
    envelope.settings["semanticRules"] = serde_json::json!([]);
    let input = FixedInput::capture(envelope).unwrap();
    let runtime = support::source_runtime(&store);
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    runtime
        .authorize_plugin(
            &mut store,
            ExecutionId::new(),
            &input,
            expires,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    let zero = Revision::new(0).unwrap();
    let before = serde_json::to_value(store.changes_since(zero)).unwrap();
    let error = store.enqueue_execution(&input).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.stage, "source-checker-required");
    assert_eq!(
        serde_json::to_value(store.changes_since(zero)).unwrap(),
        before
    );
    assert!(store.execution_input(input.envelope().attempt_id).is_err());
}

#[test]
fn production_source_keeps_original_bytes_ids_proof_and_receipt_after_reopen() {
    let (directory, store, rows, action, receipt) = support::source_fixture_with_receipt();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let bundle = store.source_bundle(snapshot).unwrap();
    assert_eq!(bundle.files[0].utf8.as_bytes(), b"same\nsame");
    assert_eq!(bundle.files[1].utf8.as_bytes(), b"opaque companion");
    assert_eq!(
        bundle.files[0].sha256,
        tsumugi_plugin_sdk::payload_digest("same\nsame")
    );
    assert_ne!(rows[0].unit_id, rows[1].unit_id);
    assert_eq!(rows[0].occurrence.text, rows[1].occurrence.text);
    let before = serde_json::to_value(&rows).unwrap();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(reopened.source_bundle(snapshot).unwrap(), bundle);
    assert_eq!(
        serde_json::to_value(reopened.source_content(snapshot, 0, 10).unwrap().rows).unwrap(),
        before
    );
    assert_eq!(
        reopened
            .adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
}
