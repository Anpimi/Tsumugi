#![cfg(all(unix, feature = "core-adapter"))]

#[path = "../../tests/support/official.rs"]
mod official;
#[path = "../../tests/support/owned_temporary.rs"]
mod owned_temporary;

use owned_temporary::OwnedTemporary;
use serde_json::json;
use std::path::PathBuf;
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk as sdk;

fn installed(root: &std::path::Path, prefix: &str) -> (PackageImage, serde_json::Value) {
    let path = PathBuf::from(
        std::env::var_os(format!("{prefix}_PACKAGE"))
            .expect("explicit independently built Rust package required"),
    );
    let digest = std::env::var(format!("{prefix}_DIGEST"))
        .expect("independently inspected package digest required");
    let provenance =
        serde_json::from_slice(&std::fs::read(path.join("sdk/lock.json")).unwrap()).unwrap();
    (
        official::installed_from(root, &path, &digest, "flat-json"),
        provenance,
    )
}

#[tokio::test]
#[ignore = "requires reviewed real Process2 and Process3 Rust packages from separate SDK archives"]
async fn actual_sdk_archives_reject_legacy_worker_despite_matching_declarations() {
    let legacy_root = OwnedTemporary::new();
    let current_root = OwnedTemporary::new();
    let staging = OwnedTemporary::new();
    let (legacy, old_sdk) = installed(legacy_root.path(), "TSUMUGI_TEST_LEGACY_NATIVE");
    let (current, new_sdk) = installed(current_root.path(), "TSUMUGI_TEST_NATIVE");
    assert_eq!(old_sdk["package"], "tsumugi-plugin-sdk");
    assert_eq!(old_sdk["package"], new_sdk["package"]);
    assert_eq!(old_sdk["version"], new_sdk["version"]);
    for field in ["sourceCommit", "archive", "sha256"] {
        assert!(
            old_sdk[field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert!(
            new_sdk[field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
        assert_ne!(old_sdk[field], new_sdk[field]);
    }
    assert_ne!(legacy.package_digest(), current.package_digest());
    assert_eq!(
        serde_json::to_value(legacy.manifest().manifest()).unwrap(),
        serde_json::to_value(current.manifest().manifest()).unwrap(),
    );
    // Hold every declared domain Resource fixed, not only the manifest's IDs.
    for contribution in &current.manifest().manifest().contributions {
        if let sdk::ContributionKind::Resource { schema, .. } = &contribution.contribution {
            assert_eq!(
                legacy.resource_bytes(&contribution.id, schema).unwrap(),
                current.resource_bytes(&contribution.id, schema).unwrap(),
            );
        }
    }
    let binding = current.source_import("source-profile").unwrap();
    assert_eq!(
        legacy.source_import("source-profile").unwrap().declaration,
        binding.declaration
    );
    let descriptor = CapturedNativeRuntime::inspect_current().unwrap();
    assert_eq!(descriptor.process_protocol, 3);
    println!(
        "sdk_archive_pair={}",
        json!({"legacy":old_sdk,"current":new_sdk,
        "nativeHost":descriptor,"environmentDigest":descriptor.digest().unwrap()})
    );
    let runtime = CapturedNativeRuntime::capture(&descriptor).unwrap();
    let launcher = RuntimeLauncher::NativeCore { runtime };
    let options = LaunchOptions {
        scope: SessionScope::Bound(ScopeBinding {
            project_id: "synthetic-project".into(),
            scope_id: "synthetic-project".into(),
        }),
        allow_unsandboxed_execution: true,
        limits: HostLimits::default(),
    };
    let result = ProcessSession::launch(
        &legacy,
        "extract-source",
        staging.path(),
        &launcher,
        options.clone(),
        || true,
    )
    .await;
    let error = match result {
        Err(error) => error,
        Ok(mut session) => {
            official::close_and_reap(&mut session).await;
            panic!("legacy SDK Worker must not establish a current channel");
        }
    };
    // This historical Worker exits on the current activation. The public Host
    // reports the closed frame stream, not a fabricated version diagnosis.
    assert_eq!(error, HostError::Crashed);
    // Failed launch retains its owned directory unless the child is reaped.
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);

    let mut session = ProcessSession::launch(
        &current,
        "extract-source",
        staging.path(),
        &launcher,
        options,
        || true,
    )
    .await
    .unwrap();
    let text = "\u{feff}{\"hello\":\"世界 👩🏽‍💻 é {name}\"}\r\n";
    let input = sdk::SourceExtractionInput {
        profile: binding.declaration.profile.clone(),
        source_set_id: "synthetic-source".into(),
        source_language: "en-US".into(),
        artifacts: vec![sdk::CapturedTextArtifact {
            id: "original-json".into(),
            logical_path: "source.json".into(),
            role: "source".into(),
            sha256: sdk::payload_digest(text),
            utf8: text.into(),
        }],
    };
    let received = official::invoke_received(
        &mut session,
        &binding.extractor,
        "current-sdk-extraction",
        &json!(input),
    )
    .await;
    let output = official::success_payload(received.result().outcome.clone());
    let content: sdk::ContentExchange = serde_json::from_str(&output.utf8).unwrap();
    sdk::validate_source_extraction(&input, &content).unwrap();
    assert_eq!(content.artifacts, input.artifacts);
    assert_eq!(content.units.len(), 1);
    assert_eq!(content.units[0].text, "世界 👩🏽‍💻 é {name}");
    assert_eq!(content.units[0].occurrences.len(), 1);
    let range = content.units[0].occurrences[0].source.range;
    assert_eq!(range.encoding, sdk::TextEncoding::Utf8Byte);
    assert_eq!(
        &text[range.start as usize..range.end as usize],
        "\"世界 👩🏽‍💻 é {name}\""
    );
    session.heartbeat().await.unwrap();
    official::close_and_reap(&mut session).await;
    assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
}
