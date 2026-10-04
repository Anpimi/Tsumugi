#![cfg(all(unix, feature = "javascript-conformance"))]
//! Pairing checks consume an explicitly selected prebuilt official package.
//! Domain source stays in its independent repository; this Host test does not
//! link a parser or treat generic SDK validation as project adoption.
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
use tsumugi_plugin_host::{catalog::*, *};
use tsumugi_plugin_sdk::*;
#[path = "support/runtime.rs"]
mod runtime_fixture;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

fn installed(temporary: &std::path::Path) -> PackageImage {
    let source = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_PLUGIN_PACKAGE")
            .expect("explicit prebuilt official package required"),
    );
    let expected = std::env::var("TSUMUGI_TEST_PLUGIN_DIGEST")
        .expect("independently approved official package digest required");
    let image = PackageImage::capture_directory(&source, &expected, || true).unwrap();
    let plugin = image.manifest().manifest().plugin.clone();
    assert_eq!(plugin.id, "webvtt");
    let approval = PackageApproval {
        plugin: plugin.clone(),
        package_digest: expected,
        origin: PackageOrigin {
            source_id: "explicit-official-test".into(),
            publisher_id: "reviewed-public-source".into(),
        },
    };
    let mut catalog = PackageCatalog::new();
    catalog.register(image, approval.clone()).unwrap();
    let root = temporary.join("packages");
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    {
        let mut store = PackageStore::open_existing(&root).unwrap();
        store
            .install(
                "00000000-0000-4000-8000-000000000031",
                catalog.registered(&plugin).unwrap(),
                || true,
            )
            .unwrap();
    }
    drop(catalog);
    let store = PackageStore::open_existing(&root).unwrap();
    let installed = store.load(&approval, || true).unwrap();
    assert_eq!(
        installed.receipt().package_digest(),
        approval.package_digest
    );
    installed.image().clone()
}

async fn launch(
    image: &PackageImage,
    contribution: &str,
    temporary: &std::path::Path,
) -> ProcessSession {
    ProcessSession::launch(
        image,
        contribution,
        temporary,
        &RuntimeLauncher::JavaScript {
            runtime: runtime_fixture::approved_runtime(),
        },
        LaunchOptions {
            scope: ScopeBinding {
                project_id: "synthetic-project".into(),
                scope_id: "synthetic-project".into(),
            },
            allow_unsandboxed_execution: true,
            limits: HostLimits::default(),
        },
        || true,
    )
    .await
    .unwrap()
}

async fn invoke(
    session: &mut ProcessSession,
    binding: &CapabilityBinding,
    dispatch: &str,
    value: &Value,
) -> InvocationOutcome {
    let input =
        EncodedPayload::capture(binding.declaration.input_schema.clone(), value.to_string())
            .unwrap();
    let request = InvocationRequest {
        context: InvocationContext {
            project_id: "synthetic-project".into(),
            scope_id: "synthetic-project".into(),
            operation_id: "synthetic-operation".into(),
            attempt_id: "synthetic-attempt".into(),
            item_id: "synthetic-item".into(),
            dispatch_id: dispatch.into(),
            input_digest: input.sha256.clone(),
            scope_digest: payload_digest("captured-scope"),
            environment_digest: session.environment_digest().unwrap().into(),
            configuration_digest: payload_digest("captured-configuration"),
        },
        provider: session.channel().provider.clone(),
        capability: binding.declaration.contract.clone(),
        profile: Some(contract("webvtt-captions")),
        input,
        output_schema: binding.declaration.output_schema.clone(),
        error_schema: binding.declaration.error_schema.clone(),
        max_result_bytes: MAX_EXCHANGE_BYTES as u32,
    };
    let received = session.invoke(&request, || false, || true).await.unwrap();
    assert_eq!(received.channel().provider, request.provider);
    assert_eq!(received.result().context, request.context);
    received.result().outcome.clone()
}

fn success(outcome: InvocationOutcome) -> Value {
    let InvocationOutcome::Succeeded { output } = outcome else {
        panic!("expected real plugin success: {outcome:?}");
    };
    serde_json::from_str(&output.utf8).unwrap()
}

#[test]
fn official_webvtt_package_extracts_builds_and_checks_through_the_captured_host() {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let image = installed(temporary.path());
        let source = "\u{feff}WEBVTT preserved\r\n\r\nNOTE before\r\nkept\r\n\r\nSTYLE\r\n::cue { color: lime; }\r\n\r\nREGION\r\nid:bottom\r\nwidth:80%\r\n\r\nCue-A\r\n00:01.000 --> 00:02.000 region:bottom align:center\r\n中文 👩🏽‍💻 é\r\nsecond line\r\n\r\nNOTE between\r\nkept too\r\n\r\nCue-B\r\n00:01.500 --> 00:03.000\r\nLast 😀\r\n";
        let input = SourceExtractionInput {
            profile: contract("webvtt-captions"), source_set_id: "synthetic-source-set".into(),
            source_language: "en-US".into(), artifacts: vec![CapturedTextArtifact {
                id: "synthetic-source-artifact".into(), logical_path: "source.vtt".into(), role: "source".into(),
                sha256: payload_digest(source), utf8: source.into(),
            }],
        };
        input.validate().unwrap();
        let extraction = bind_capability(image.manifest(), "extract-source", image.package_digest()).unwrap();
        assert_eq!(extraction.declaration.input_schema, source_extraction_input_contract());
        assert_eq!(extraction.declaration.output_schema, content_exchange_contract());
        let mut session = launch(&image, "extract-source", temporary.path()).await;
        let value = success(invoke(&mut session, &extraction, "extract-good", &serde_json::to_value(&input).unwrap()).await);
        let exchange: ContentExchange = serde_json::from_value(value).unwrap();
        validate_source_extraction(&input, &exchange).unwrap();
        assert_eq!(exchange.units.len(), 2);
        assert_eq!(exchange.units[0].text, "中文 👩🏽‍💻 é\nsecond line");
        assert_eq!(exchange.units[1].text, "Last 😀");
        assert_eq!(exchange.units[0].occurrences[0].native_identity.as_ref().unwrap().value, "cue-a");
        let range = exchange.units[0].occurrences[0].source.range;
        assert_eq!(range.encoding, TextEncoding::Utf8Byte);
        assert_eq!(&source[range.start as usize..range.end as usize], "中文 👩🏽‍💻 é\r\nsecond line");
        let mut invalid = input.clone();
        invalid.artifacts[0].utf8 = "WEBVTT\n\n00:01.000 --> 00:02.000\nAnonymous\n".into();
        invalid.artifacts[0].sha256 = payload_digest(&invalid.artifacts[0].utf8);
        let failed = invoke(&mut session, &extraction, "extract-anonymous", &serde_json::to_value(invalid).unwrap()).await;
        let InvocationOutcome::Failed { error } = failed else { panic!("anonymous cue must fail"); };
        assert_eq!(error.schema, source_extraction_error_contract());
        parse_source_extraction_error(error.utf8.as_bytes()).unwrap();
        assert!(session.close().await.direct_child_reaped);
        assert_eq!(image.package_digest(), extraction.provider.package_digest);
        let targets = ["第一行 😀\n新しい二行 é", "译文"];
        let cues: Vec<_> = exchange.units.iter().enumerate().map(|(ordinal, unit)| {
            let occurrence = &unit.occurrences[0];
            let basis = exchange.domain_blocks.iter().find(|block|
                block.target == ContentTarget::Occurrence { id: occurrence.id.clone() }
                    && block.schema == contract("webvtt.cue-basis")).unwrap();
            assert_eq!(basis.handling, ExtensionHandling::Required);
            let basis: Value = serde_json::from_str(&basis.payload_utf8).unwrap();
            assert_eq!(basis["nativeId"], ["Cue-A", "Cue-B"][ordinal]);
            json!({"ordinal":ordinal,"nativeId":basis["nativeId"],
                "canonicalId":occurrence.native_identity.as_ref().unwrap().value,
                "sourceText":unit.text,"targetText":targets[ordinal],"basis":basis})
        }).collect();
        let build_input = json!({"version":1,"template":{"utf8":source,"sha256":payload_digest(source)},
            "locale":"zh-CN","logicalPath":"zh-CN.vtt","cues":cues});
        let builder = bind_capability(image.manifest(), "build", image.package_digest()).unwrap();
        let mut session = launch(&image, "build", temporary.path()).await;
        let artifact = success(invoke(&mut session, &builder, "build-good", &build_input).await);
        // Literal oracle authored independently of the plugin parser/builder.
        let expected = "\u{feff}WEBVTT preserved\r\n\r\nNOTE before\r\nkept\r\n\r\nSTYLE\r\n::cue { color: lime; }\r\n\r\nREGION\r\nid:bottom\r\nwidth:80%\r\n\r\nCue-A\r\n00:01.000 --> 00:02.000 region:bottom align:center\r\n第一行 😀\r\n新しい二行 é\r\n\r\nNOTE between\r\nkept too\r\n\r\nCue-B\r\n00:01.500 --> 00:03.000\r\n译文\r\n";
        assert_eq!(artifact["utf8"], expected);
        assert_eq!(artifact["sha256"], payload_digest(expected));
        assert_eq!(artifact["logicalPath"], "zh-CN.vtt");
        assert_eq!(artifact["cueCount"], 2);
        let mut unsafe_target = build_input.clone();
        unsafe_target["cues"][0]["targetText"] = json!("<b>markup</b>");
        assert!(matches!(invoke(&mut session, &builder, "build-markup", &unsafe_target).await,
            InvocationOutcome::Failed { .. }));
        assert!(session.close().await.direct_child_reaped);

        let checker = bind_capability(image.manifest(), "validate-artifact", image.package_digest()).unwrap();
        let mut session = launch(&image, "validate-artifact", temporary.path()).await;
        let checked = success(invoke(&mut session, &checker, "check-good",
            &json!({"version":1,"input":build_input,"output":artifact})).await);
        assert_eq!(checked["sha256"], payload_digest(expected));
        assert_eq!(checked["checkerVersion"], "webvtt-locale-artifact-1");
        for (dispatch, from, to) in [
            ("check-timing", "00:02.000", "00:04.000"),
            ("check-note", "NOTE before", "NOTE edited"),
        ] {
            let changed = expected.replacen(from, to, 1);
            let mut altered = artifact.clone();
            altered["utf8"] = json!(changed);
            altered["sha256"] = json!(payload_digest(&changed));
            assert!(matches!(invoke(&mut session, &checker, dispatch,
                &json!({"version":1,"input":build_input,"output":altered})).await,
                InvocationOutcome::Failed { .. }));
        }
        assert!(session.close().await.direct_child_reaped);
        let remaining: Vec<_> = std::fs::read_dir(temporary.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("packages")]);
    });
}
