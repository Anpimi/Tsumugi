use super::*;
use crate::{ProjectMetadata, ProjectStore};
use serde_json::json;
use std::{
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

fn bundle() -> SourceBundle {
    SourceBundle::capture(
        include_bytes!("../../tests/fixtures/stardew-lookup/manifest.json"),
        include_bytes!("../../tests/fixtures/stardew-lookup/i18n/default.json"),
        "en",
    )
    .unwrap()
}
fn small(source: &str) -> SourceBundle {
    SourceBundle::capture(br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,source.as_bytes(),"en").unwrap()
}
fn create(path: &std::path::Path) -> ProjectStore {
    ProjectStore::create(
        path,
        ProjectMetadata::create("Source fixture", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap()
}
fn generate(store: &mut ProjectStore, bundle: SourceBundle) -> (FixedInput, FixedResult) {
    let input = bundle
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register(Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        runtime.tick(store).unwrap();
        let status = store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap();
        if status.items[0].execution == ExecutionState::Succeeded {
            assert_eq!(status.items[0].validation, ValidationState::Valid);
            let id = store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
            let result = store
                .execution_result(input.envelope().attempt_id, id)
                .unwrap();
            return (input, result);
        }
        assert!(
            !matches!(
                status.items[0].execution,
                ExecutionState::Failed | ExecutionState::Unknown
            ),
            "{status:?}"
        );
        assert!(Instant::now() < deadline, "runner did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn prepare(store: &mut ProjectStore, input: &FixedInput, result: &FixedResult) -> AdoptionAction {
    let page = store
        .source_preview(
            input.envelope().attempt_id,
            result.envelope().result_id,
            0,
            50,
        )
        .unwrap();
    store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result.envelope().result_id],
            value(&page.confirmation).unwrap(),
        )
        .unwrap()
}

#[test]
fn oversized_multi_locale_build_is_rejected_before_execution() {
    let directory = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Build failure", "en", ["zh-CN", "fr-FR"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let entries = (0..70)
        .map(|ordinal| BuildEntry {
            ordinal,
            unit_id: ExecutionId::new(),
            source_revision_id: ExecutionId::new(),
            native_key: format!("key-{ordinal}"),
            source_text: "Source".into(),
            value: "Small".into(),
            selection_id: Some(ExecutionId::new()),
            revision_id: Some(ExecutionId::new()),
            fallback_id: None,
            decision_id: Some(ExecutionId::new()),
            check_id: ExecutionId::new(),
            waiver_ids: vec![],
        })
        .collect::<Vec<_>>();
    let mut oversized = entries.clone();
    for entry in &mut oversized {
        entry.value = "\n".repeat(8192);
    }
    let manifest = BuildManifest {
        version: 1,
        project_id: project,
        source_snapshot_id: ExecutionId::new(),
        policy_version: "balanced-1".into(),
        eligibility_basis: "0".repeat(64),
        plugin_id: PLUGIN_ID.into(),
        plugin_version: PLUGIN_VERSION.into(),
        builder_version: BUILDER_VERSION.into(),
        validator_version: VALIDATOR_VERSION.into(),
        source_files: vec![
            BuildSourceFile {
                logical_path: MANIFEST_PATH.into(),
                sha256: "0".repeat(64),
            },
            BuildSourceFile {
                logical_path: SOURCE_PATH.into(),
                sha256: "0".repeat(64),
            },
        ],
        locales: vec![
            BuildLocale {
                locale: "zh-CN".into(),
                file_name: "i18n/zh.json".into(),
                entries,
            },
            BuildLocale {
                locale: "fr-FR".into(),
                file_name: "i18n/fr.json".into(),
                entries: oversized,
            },
        ],
    };
    assert_eq!(
        manifest.fixed_input(ExecutionId::new()).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert!(store.list_releases(project).unwrap().is_empty());
    drop(store);
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert!(reopened.list_releases(project).unwrap().is_empty());
}

#[test]
fn real_source_matches_independent_oracle_and_keeps_byte_locations() {
    let bundle = bundle();
    let output = extract(&bundle, &Cancellation::default()).unwrap();
    let oracle: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../tests/fixtures/stardew-lookup/oracle.json"
    ))
    .unwrap();
    assert_eq!(output.occurrences.len(), 532);
    for (row, expected) in output
        .occurrences
        .iter()
        .zip(oracle["occurrences"].as_array().unwrap())
    {
        assert_eq!(row.ordinal, expected["ordinal"].as_u64().unwrap() as u32);
        assert_eq!(row.key, expected["key"].as_str().unwrap());
        assert_eq!(row.text, expected["text"].as_str().unwrap());
        for (range, expected) in [
            (row.key_byte_range, &row.key),
            (row.value_byte_range, &row.text),
        ] {
            let decoded: String =
                serde_json::from_str(&bundle.files[1].utf8[range[0] as usize..range[1] as usize])
                    .unwrap();
            assert_eq!(&decoded, expected);
        }
    }
    assert_eq!(output.diagnostics, vec!["source-template"]);
    assert_eq!(
        bundle.files[1].sha256,
        "29c4c299dee077481a98c1de612a678a6a16e55988ba88a73fa8f1cd92deb609"
    );
}

#[test]
fn non_string_source_values_have_an_actionable_diagnostic() {
    for value in ["42", "true", "null", "[]", "{}"] {
        let error = extract(
            &small(&format!(r#"{{"key":{value}}}"#)),
            &Cancellation::default(),
        )
        .unwrap_err();
        assert_eq!(error.stage, "source-value-not-string");
    }
    assert!(
        extract(
            &small(r#"{"number":"42","empty":""}"#),
            &Cancellation::default(),
        )
        .is_ok()
    );
}

#[test]
fn profile_rejects_ambiguous_structure_and_preserves_unicode_and_empty_values() {
    for source in [
        r#"{"A":"x","a":"y"}"#,
        r#"{"a":"x","a":"x"}"#,
        r#"{"a":null}"#,
        r#"{"a":{}}"#,
        "{'a':'x'}",
        r#"{a:"x"}"#,
        r#"{"a":"x" "b":"y"}"#,
        r#"{"é":"x"}"#,
        "{}",
    ] {
        assert!(
            extract(&small(source), &Cancellation::default()).is_err(),
            "accepted {source}"
        );
    }
    let output = extract(
        &small("\u{feff}{/*context*/\"a\":\"中文😀\\n{{x}}\",\"b\":\"\",}"),
        &Cancellation::default(),
    )
    .unwrap();
    assert_eq!(output.occurrences[0].text, "中文😀\n{{x}}");
    assert_eq!(output.occurrences[1].text, "");
    let deep = format!("{}0{}", "[".repeat(17), "]".repeat(17));
    assert_eq!(
        extract(&small(&deep), &Cancellation::default())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let cancel = Cancellation::default();
    cancel.request();
    assert_eq!(
        extract(&bundle(), &cancel).unwrap_err().code,
        ErrorCode::Cancelled
    );
}

#[test]
fn real_runtime_preview_adoption_reopen_and_pagination_keep_independent_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, bundle());
    let before = store.content_scope().unwrap();
    let mut next = 0;
    let mut seen = Vec::new();
    loop {
        let page = store
            .source_preview(
                input.envelope().attempt_id,
                result.envelope().result_id,
                next,
                100,
            )
            .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_CONTENT_PAGE_BYTES);
        seen.extend(page.rows.into_iter().map(|r| r.occurrence.key));
        match page.next_ordinal {
            Some(n) => next = n,
            None => break,
        }
    }
    assert_eq!(seen.len(), 532);
    assert_eq!(before, store.content_scope().unwrap());
    let action = prepare(&mut store, &input, &result);
    store.rename(1, "Renamed while previewing").unwrap();
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        receipt,
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap()
    );
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let page = store.source_content(snapshot, 0, 100).unwrap();
    let ids: std::collections::BTreeSet<_> = page.rows.iter().map(|r| r.unit_id).collect();
    assert_eq!(ids.len(), 100);
    store.close().unwrap();
    std::fs::rename(&path, tmp.path().join("moved")).unwrap();
    let store = ProjectStore::open(tmp.path().join("moved")).unwrap();
    assert_eq!(page, store.source_content(snapshot, 0, 100).unwrap());
    assert_eq!(
        store.adoption_receipt(action.action_id).unwrap(),
        Some(receipt)
    );
}

#[test]
fn maximum_supported_source_result_fits_its_declared_byte_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let manifest = serde_json::to_vec(&json!({
        "UniqueID": "\"".repeat(256),
        "Name": "Example",
        "Version": "1.0.0",
        "EntryDll": "Example.dll"
    }))
    .unwrap();
    let entries: serde_json::Map<String, serde_json::Value> = (0..MAX_OCCURRENCES)
        .map(|index| (format!("key-{index:04}"), json!("")))
        .collect();
    let source = serde_json::to_vec(&entries).unwrap();
    let bundle = SourceBundle::capture(&manifest, &source, "en").unwrap();

    let (input, result) = generate(&mut store, bundle);
    let output = validate_output(&input, &result).unwrap();

    assert_eq!(output.occurrences.len(), MAX_OCCURRENCES);
    assert_eq!(
        input.envelope().limits.max_result_bytes as usize,
        MAX_SOURCE_RESULT_BYTES
    );
    assert!(result.bytes().len() > crate::execution::DEFAULT_RESULT_BYTES);
    assert!(result.bytes().len() <= input.envelope().limits.max_result_bytes as usize);
}

#[test]
fn malformed_output_cannot_become_valid_or_adopted() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let input = small(r#"{"a":"same","b":"same"}"#)
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    store.enqueue_execution(&input).unwrap();
    let request = store
        .dispatch_execution_item(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap();
    let mut output = extract(
        &SourceBundle::from_input(&input).unwrap(),
        &Cancellation::default(),
    )
    .unwrap();
    output.occurrences.remove(1);
    let result = FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: CAPABILITY.into(),
            capability_version: CAPABILITY_VERSION.into(),
            outcome: ExecutionState::Succeeded,
            output: Some(value(&output).unwrap()),
            diagnostic: None,
        },
        &input,
        request.dispatch_token,
    )
    .unwrap();
    store.save_execution_result(&result).unwrap();
    assert!(
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .is_err()
    );
    assert_eq!(
        store
            .execution_attempt(input.envelope().attempt_id, false)
            .unwrap()
            .items[0]
            .validation,
        ValidationState::Invalid
    );
    assert!(
        store
            .source_preview(
                input.envelope().attempt_id,
                result.envelope().result_id,
                0,
                50
            )
            .is_err()
    );
    assert!(store.content_scope().unwrap().current_snapshot.is_none());
}

#[test]
fn competing_first_imports_cancel_and_changed_confirmation_preserve_results() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let (a, ar) = generate(&mut store, small(r#"{"a":"same","b":"same"}"#));
    let (b, br) = generate(&mut store, small(r#"{"a":"other"}"#));
    let cancelled = prepare(&mut store, &a, &ar);
    store
        .cancel_execution(a.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&cancelled, &SourceAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
    let fresh = prepare(&mut store, &a, &ar);
    let other = prepare(&mut store, &b, &br);
    let mut altered = fresh.clone();
    altered.parameters = json!({});
    assert!(
        store
            .adopt_execution(&altered, &SourceAdoptionHandler)
            .is_err()
    );
    store
        .adopt_execution(&fresh, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&other, &SourceAdoptionHandler)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert!(
        store
            .source_preview(b.envelope().attempt_id, br.envelope().result_id, 0, 50)
            .is_ok()
    );
    let scope = store.content_scope().unwrap();
    let content = store
        .source_content(scope.current_snapshot.unwrap(), 0, 50)
        .unwrap();
    assert_ne!(content.rows[0].unit_id, content.rows[1].unit_id);
}

#[test]
fn stored_bytes_and_content_relations_are_checked_on_reopen() {
    for sql in [
        "UPDATE source_files SET bytes=x'00' WHERE role='source'",
        "DELETE FROM source_identity",
        "UPDATE source_revisions SET text='changed'",
        "UPDATE content_scope SET revision=8",
        "BEGIN; PRAGMA defer_foreign_keys=ON; UPDATE source_snapshots SET snapshot_id='00000000-0000-4000-8000-000000000099'; UPDATE content_scope SET current_snapshot='00000000-0000-4000-8000-000000000099'; UPDATE source_occurrences SET snapshot_id='00000000-0000-4000-8000-000000000099'; COMMIT",
        "PRAGMA user_version=2",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("project");
        let mut store = create(&path);
        let (input, result) = generate(&mut store, small(r#"{"a":"value"}"#));
        let action = prepare(&mut store, &input, &result);
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap();
        store.close().unwrap();
        let conn = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        conn.execute_batch(sql).unwrap();
        drop(conn);
        let before = std::fs::read(path.join("project.sqlite3")).unwrap();
        assert!(ProjectStore::open(&path).is_err());
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
    }
}

#[test]
fn simultaneous_first_adoptions_serialize_at_the_store_owner() {
    use std::sync::{Barrier, Mutex};
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let (a, ar) = generate(&mut store, small(r#"{"a":"first"}"#));
    let (b, br) = generate(&mut store, small(r#"{"a":"second"}"#));
    let first = prepare(&mut store, &a, &ar);
    let second = prepare(&mut store, &b, &br);
    let store = Arc::new(Mutex::new(store));
    let barrier = Arc::new(Barrier::new(3));
    let handles: Vec<_> = [first, second]
        .into_iter()
        .map(|action| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .lock()
                    .unwrap()
                    .adopt_execution(&action, &SourceAdoptionHandler)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| r
                .as_ref()
                .is_err_and(|e| e.code == ErrorCode::DependencyConflict))
            .count(),
        1
    );
    let store = store.lock().unwrap();
    assert_eq!(store.content_scope().unwrap().revision.get(), 2);
}

#[test]
fn forged_coverage_locations_identity_and_required_fields_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = create(&tmp.path().join("project"));
    let (input, saved) = generate(&mut store, small(r#"{"a":"same","b":"same"}"#));
    let original = saved.envelope().output.as_ref().unwrap();
    for kind in 0..7 {
        let mut output = original.clone();
        match kind {
            0 => {
                output["coverage"].as_array_mut().unwrap().pop();
            }
            1 => {
                output["occurrences"][0]["artifactId"] = json!(ExecutionId::new());
            }
            2 => {
                output["occurrences"][1]["ordinal"] = json!(0);
            }
            3 => {
                output["occurrences"][0]["valueByteRange"] = json!([0, 1]);
            }
            4 => {
                output["identityPolicy"] = json!("share-equal-text");
            }
            5 => {
                output["requiredExtension"] = json!("future/v1");
            }
            6 => {
                output["manifestDigest"] = json!("0".repeat(64));
            }
            _ => unreachable!(),
        }
        let mut envelope = saved.envelope().clone();
        envelope.output = Some(output);
        let forged =
            FixedResult::capture(envelope, &input, saved.envelope().dispatch_token).unwrap();
        assert!(validate_output(&input, &forged).is_err(), "case {kind}");
    }
    assert!(store.content_scope().unwrap().current_snapshot.is_none());
    assert!(
        store
            .source_preview(
                input.envelope().attempt_id,
                saved.envelope().result_id,
                0,
                50
            )
            .is_ok()
    );
}

#[test]
fn source_limits_unknown_fields_and_bundle_associations_fail_closed() {
    let manifest = small(r#"{"a":"b"}"#).files[0].utf8.clone();
    let mut padded_manifest = manifest.as_bytes().to_vec();
    padded_manifest.resize(MAX_MANIFEST_BYTES, b' ');
    assert!(SourceBundle::capture(&padded_manifest, b"{}", "en").is_ok());
    padded_manifest.push(b' ');
    assert_eq!(
        SourceBundle::capture(&padded_manifest, b"{}", "en")
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    for (length, valid) in [(1024, true), (1025, false)] {
        let text = serde_json::to_string(&json!({"k".repeat(length): "v"})).unwrap();
        assert_eq!(
            extract(&small(&text), &Cancellation::default()).is_ok(),
            valid
        );
    }
    for (length, valid) in [(256, true), (257, false)] {
        let mut value: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        value["UniqueID"] = json!("n".repeat(length));
        let bundle =
            SourceBundle::capture(&serde_json::to_vec(&value).unwrap(), br#"{"a":"v"}"#, "en")
                .unwrap();
        assert_eq!(extract(&bundle, &Cancellation::default()).is_ok(), valid);
    }
    for (arrays, valid) in [(15, true), (16, false)] {
        let mut value: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let nested = format!("{}0{}", "[".repeat(arrays), "]".repeat(arrays));
        value["Opaque"] = serde_json::from_str(&nested).unwrap();
        let bundle =
            SourceBundle::capture(&serde_json::to_vec(&value).unwrap(), br#"{"a":"v"}"#, "en")
                .unwrap();
        assert_eq!(extract(&bundle, &Cancellation::default()).is_ok(), valid);
    }
    let mut source = br#"{"a":"b"}"#.to_vec();
    source.resize(MAX_SOURCE_BYTES - manifest.len(), b' ');
    assert!(SourceBundle::capture(manifest.as_bytes(), &source, "en").is_ok());
    source.push(b' ');
    assert_eq!(
        SourceBundle::capture(manifest.as_bytes(), &source, "en")
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let exact = serde_json::to_string(&json!({"a":"a".repeat(MAX_TEXT_BYTES)})).unwrap();
    assert!(extract(&small(&exact), &Cancellation::default()).is_ok());
    let over = serde_json::to_string(&json!({"a":"a".repeat(MAX_TEXT_BYTES+1)})).unwrap();
    assert_eq!(
        extract(&small(&over), &Cancellation::default())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let entries: serde_json::Map<String, serde_json::Value> = (0..=MAX_OCCURRENCES)
        .map(|i| (format!("key{i}"), json!("")))
        .collect();
    assert_eq!(
        extract(
            &small(&serde_json::to_string(&entries).unwrap()),
            &Cancellation::default()
        )
        .unwrap_err()
        .code,
        ErrorCode::LimitExceeded
    );
    let mut bundle = small(r#"{"a":"b"}"#);
    let mut unknown = value(&bundle).unwrap();
    unknown["requiredExtension"] = json!("future/v1");
    assert!(from_value::<SourceBundle>(&unknown).is_err());
    bundle.files[1].logical_path = "../outside.json".into();
    assert!(bundle.validate().is_err());
    assert!(SourceBundle::capture(manifest.as_bytes(), &[0xff], "en").is_err());
}

#[test]
fn source_crash_child() {
    let Ok(path) = std::env::var("TSUMUGI_SOURCE_CHILD") else {
        return;
    };
    let mut store = create(std::path::Path::new(&path));
    let (input, result) = generate(&mut store, small(r#"{"a":"one","b":"two"}"#));
    let action = prepare(&mut store, &input, &result);
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
}

#[test]
fn process_abort_preserves_capture_output_and_adoption_boundaries() {
    for point in [
        "before-enqueue-commit",
        "after-enqueue",
        "after-output",
        "during-source-adoption",
        "before-adoption-commit",
        "after-adoption-commit",
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("project");
        let hook = tmp.path().join("hook");
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "content::tests::source_crash_child",
                "--nocapture",
            ])
            .env("TSUMUGI_SOURCE_CHILD", &path)
            .env("TSUMUGI_EXECUTION_HOOK", &hook)
            .env(
                if point == "during-source-adoption" {
                    "TSUMUGI_SOURCE_CRASH"
                } else {
                    "TSUMUGI_EXECUTION_CRASH"
                },
                point,
            );
        assert!(!child.output().unwrap().status.success());
        assert_eq!(std::fs::read_to_string(hook).unwrap(), point);
        let store = ProjectStore::open(&path).unwrap();
        let scope = store.content_scope().unwrap();
        assert_eq!(
            scope.current_snapshot.is_some(),
            point == "after-adoption-commit"
        );
        let conn = rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
        let sets: i64 = conn
            .query_row("SELECT COUNT(*) FROM source_sets", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            sets,
            if point == "before-enqueue-commit" {
                0
            } else {
                1
            }
        );
        let receipts: i64 = conn
            .query_row("SELECT COUNT(*) FROM adoption_receipts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            receipts,
            if point == "after-adoption-commit" {
                1
            } else {
                0
            }
        );
    }
}
