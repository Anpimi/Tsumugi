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
    assert_eq!(version, 34);
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
    for unsupported in [27, 28, 29, 30, 31, 32, 33, 35] {
        let connection = rusqlite::Connection::open(project.join("project.sqlite3")).unwrap();
        connection
            .pragma_update(None, "user_version", unsupported)
            .unwrap();
        drop(connection);
        let before = files();
        let error = ProjectStore::open(&project).unwrap_err();
        assert_eq!(error.code(), PersistenceErrorCode::UnsupportedSchema);
        assert_eq!(error.found_schema_version(), Some(unsupported));
        assert_eq!(files(), before);
    }
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

#[test]
fn reused_source_qualification_rechecks_every_frame_association_and_proof_link() {
    for change in [
        "producer-input",
        "producer-result",
        "checker-input",
        "checker-result",
        "checker-association",
        "checker-previous",
        "proof-validity",
        "proof-link",
    ] {
        let (directory, store, rows) = source_fixture();
        let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
        assert_eq!(store.source_content(snapshot, 0, 10).unwrap().rows, rows);
        assert_eq!(store.source_content(snapshot, 0, 10).unwrap().rows, rows);
        let path = directory.path().join("project");
        let db = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let (producer, result, checker, checked): (String, String, String, String) = db
            .query_row(
                "SELECT s.attempt_id,s.result_id,r.attempt_id,r.result_id
                 FROM source_snapshots s
                 JOIN plugin_validation_links l ON l.producer_result_id=s.result_id
                 JOIN execution_results r ON r.result_id=l.checker_result_id
                 WHERE s.snapshot_id=?1",
                [snapshot.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        match change {
            "producer-input" | "checker-input" => {
                let attempt = if change == "producer-input" {
                    &producer
                } else {
                    &checker
                };
                let mut bytes: Vec<u8> = db
                    .query_row(
                        "SELECT input FROM execution_attempts WHERE attempt_id=?1",
                        [attempt],
                        |r| r.get(0),
                    )
                    .unwrap();
                // Keep the old digest: identical identities cannot vouch for
                // changed bytes, even when the JSON remains syntactically valid.
                bytes.push(b' ');
                assert_eq!(
                    db.execute(
                        "UPDATE execution_attempts SET input=?1 WHERE attempt_id=?2",
                        rusqlite::params![bytes, attempt]
                    )
                    .unwrap(),
                    1
                );
            }
            "producer-result" | "checker-result" => {
                let result = if change == "producer-result" {
                    &result
                } else {
                    &checked
                };
                let mut bytes: Vec<u8> = db
                    .query_row(
                        "SELECT bytes FROM execution_results WHERE result_id=?1",
                        [result],
                        |r| r.get(0),
                    )
                    .unwrap();
                bytes.push(b' ');
                assert_eq!(
                    db.execute(
                        "UPDATE execution_results SET bytes=?1 WHERE result_id=?2",
                        rusqlite::params![bytes, result]
                    )
                    .unwrap(),
                    1
                );
            }
            "checker-association" => {
                assert_eq!(
                    db.execute(
                        "UPDATE execution_results SET
                         (attempt_id,item_id,dispatch_token)=
                         (SELECT attempt_id,item_id,dispatch_token FROM execution_results WHERE result_id=?1)
                         WHERE result_id=?2",
                        [&result, &checked]
                    )
                    .unwrap(),
                    1
                );
            }
            "checker-previous" => {
                assert_eq!(
                    db.execute(
                        "UPDATE execution_attempts SET previous_attempt_id=?1 WHERE attempt_id=?1",
                        [checker]
                    )
                    .unwrap(),
                    1
                );
            }
            "proof-validity" => {
                assert_eq!(
                    db.execute(
                        "UPDATE plugin_validation_links SET valid=0 WHERE producer_result_id=?1",
                        [result]
                    )
                    .unwrap(),
                    1
                );
            }
            "proof-link" => {
                assert_eq!(db.execute("UPDATE plugin_validation_links SET checker_result_id=?1 WHERE producer_result_id=?1", [result]).unwrap(), 1);
            }
            _ => unreachable!(),
        }
        drop(db);
        let before = std::fs::read(path.join("project.sqlite3")).unwrap();
        assert!(store.source_content(snapshot, 0, 10).is_err(), "{change}");
        assert_eq!(
            std::fs::read(path.join("project.sqlite3")).unwrap(),
            before,
            "{change}"
        );
        store.close().unwrap();
        assert_eq!(
            ProjectStore::open(&path).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{change}"
        );
        assert_eq!(
            std::fs::read(path.join("project.sqlite3")).unwrap(),
            before,
            "{change}"
        );
    }
}
