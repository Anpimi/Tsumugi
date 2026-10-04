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

async fn invoke_received(
    session: &mut ProcessSession,
    binding: &CapabilityBinding,
    dispatch: &str,
    value: &Value,
) -> ReceivedResult {
    // Actual child identity comes from the Host, independently of request data.
    let channel = session.channel();
    assert_eq!(channel.provider.selection(), binding.provider);
    assert!(channel.child_pid > 0);
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
        provider: channel.provider.clone(),
        capability: binding.declaration.contract.clone(),
        profile: Some(contract("webvtt-captions")),
        input,
        output_schema: binding.declaration.output_schema.clone(),
        error_schema: binding.declaration.error_schema.clone(),
        max_result_bytes: MAX_EXCHANGE_BYTES as u32,
    };
    let received = session.invoke(&request, || false, || true).await.unwrap();
    assert_eq!(received.channel().provider, channel.provider);
    assert_eq!(received.channel().child_pid, channel.child_pid);
    assert_eq!(
        received.channel().scope.project_id,
        channel.scope.project_id
    );
    assert_eq!(received.channel().scope.scope_id, channel.scope.scope_id);
    assert_eq!(received.result().provider, channel.provider);
    assert_eq!(received.result().context, request.context);
    received
}

async fn invoke(
    session: &mut ProcessSession,
    binding: &CapabilityBinding,
    dispatch: &str,
    value: &Value,
) -> InvocationOutcome {
    invoke_received(session, binding, dispatch, value)
        .await
        .result()
        .outcome
        .clone()
}

fn success_payload(outcome: InvocationOutcome) -> EncodedPayload {
    let InvocationOutcome::Succeeded { output } = outcome else {
        panic!("expected real plugin success: {outcome:?}");
    };
    assert_eq!(output.sha256, payload_digest(&output.utf8));
    output
}

fn success(outcome: InvocationOutcome) -> Value {
    let output = success_payload(outcome);
    serde_json::from_str(&output.utf8).unwrap()
}

async fn close_and_reap(session: &mut ProcessSession) {
    let closed = session.close().await;
    assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
    assert_eq!(session.termination_receipt(), Some(&closed));
    assert!(!session.is_accepting());
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
        assert_eq!(extraction.declaration.output_schema.schema_version, 2);
        assert_eq!(extraction.declaration.output_schema.behavior_version, 1);
        let mut session = launch(&image, "extract-source", temporary.path()).await;
        let extraction_channel = session.channel();
        let extraction_payload = success_payload(invoke(&mut session, &extraction, "extract-good", &serde_json::to_value(&input).unwrap()).await);
        assert_eq!(extraction_payload.schema, content_exchange_contract());
        // Parse the original payload bytes, retaining strict SDK unknown-field
        // and duplicate-field rejection instead of first normalizing to Value.
        let exchange = parse_content_exchange(extraction_payload.utf8.as_bytes()).unwrap();
        validate_source_extraction(&input, &exchange).unwrap();
        assert_eq!(exchange.units.len(), 2);
        assert_eq!(exchange.units[0].text, "中文 👩🏽‍💻 é\nsecond line");
        assert_eq!(exchange.units[1].text, "Last 😀");
        assert_eq!(exchange.units[0].occurrences[0].native_identity.as_ref().unwrap().value, "cue-a");
        for (ordinal, unit) in exchange.units.iter().enumerate() {
            let identity = unit.occurrences[0].native_identity.as_ref().unwrap();
            assert_eq!(identity.display.value, ["Cue-A", "Cue-B"][ordinal]);
            let display = identity.display.source.as_ref().unwrap();
            assert_eq!(display.artifact_id, input.artifacts[0].id);
            assert_eq!(display.range.encoding, TextEncoding::Utf8Byte);
            assert_eq!(&source[display.range.start as usize..display.range.end as usize], identity.display.value);
        }
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
        close_and_reap(&mut session).await;
        assert_eq!(image.package_digest(), extraction.provider.package_digest);

        let semantic = bind_capability(image.manifest(), "source-semantic-check", image.package_digest()).unwrap();
        assert_eq!(semantic.declaration.contract, contract("webvtt.source-check"));
        assert_eq!(semantic.declaration.input_schema, source_extraction_check_input_contract());
        assert_eq!(semantic.declaration.output_schema, check_results_contract());
        assert_eq!(semantic.declaration.error_schema, source_extraction_error_contract());
        // Fix source and original proposal bases before dispatching any check.
        // The package selection is independent of the active process identity.
        let source_digest = payload_digest(&serde_json::to_value(&input).unwrap().to_string());
        let proposal_digest = payload_digest(&extraction_payload.utf8);
        let domain_requirement = CheckRequirement {
            key: CheckKey {
                rule: contract("webvtt.source-semantics"),
                implementation: CheckImplementation::Plugin { provider: semantic.provider.clone() },
            },
            input_digest: source_digest.clone(), scope_digest: proposal_digest.clone(),
            targets: vec![input.source_set_id.clone()], mandatory: true, waivable: false,
            not_applicable: None,
        };
        let core_requirement = CheckRequirement {
            key: CheckKey {
                rule: contract("core.sdk-source-association"),
                implementation: CheckImplementation::Core { validator: contract("core.sdk-source-association") },
            },
            input_digest: source_digest, scope_digest: proposal_digest,
            targets: vec![input.source_set_id.clone()], mandatory: true, waivable: false,
            not_applicable: None,
        };
        let fixed = capture_required_checks(contract("official.source-check-policy"),
            vec![core_requirement.clone()], vec![domain_requirement.clone()]).unwrap();
        let semantic_input = SourceExtractionCheckInput {
            source: input.clone(), proposal: exchange.clone(), requirements: vec![domain_requirement.clone()],
        };
        let mut session = launch(&image, "source-semantic-check", temporary.path()).await;
        let semantic_channel = session.channel();
        assert_eq!(semantic_channel.provider.selection(), semantic.provider);
        assert_ne!(semantic_channel.provider.instance_id, extraction_channel.provider.instance_id);
        for (dispatch, mutation) in [("source-check-good", 0), ("source-check-text", 1), ("source-check-basis", 2)] {
            let mut captured = semantic_input.clone();
            match mutation {
                1 => captured.proposal.units[0].text = "Structurally valid forged source text".into(),
                2 => {
                    let block = &mut captured.proposal.domain_blocks[0];
                    let changed = block.payload_utf8.replacen("00:02.000", "00:02.100", 1);
                    assert_ne!(changed, block.payload_utf8);
                    block.payload_utf8 = changed;
                }
                _ => {}
            }
            assert_eq!(captured.source, input);
            assert_eq!(captured.requirements, semantic_input.requirements);
            let value = serde_json::to_value(&captured).unwrap();
            let raw_input = value.to_string();
            assert_eq!(parse_source_extraction_check_input(raw_input.as_bytes()).unwrap(), captured);
            // This trusted generic association actually executes on each
            // candidate. It supplies no domain conclusion or adoption proof.
            validate_source_extraction(&captured.source, &captured.proposal).unwrap();
            let core_result = CheckResult {
                key: core_requirement.key.clone(), input_digest: core_requirement.input_digest.clone(),
                scope_digest: core_requirement.scope_digest.clone(), covered_targets: core_requirement.targets.clone(),
                outcome: CheckOutcome::Completed { findings: vec![] },
            };
            let received = invoke_received(&mut session, &semantic, dispatch, &value).await;
            assert_eq!(received.channel().provider, semantic_channel.provider);
            assert_eq!(received.channel().child_pid, semantic_channel.child_pid);
            let output = success_payload(received.result().outcome.clone());
            assert_eq!(output.schema, check_results_contract());
            let results = parse_check_results(output.utf8.as_bytes()).unwrap();
            assert_eq!(results.len(), 1);
            let result = &results[0];
            // A plugin key is a claim until compared to the independent actual
            // Host channel, as well as the fixed policy's package selection.
            let CheckImplementation::Plugin { provider } = &result.key.implementation else { panic!("plugin checker required"); };
            assert_eq!(provider, &semantic.provider);
            assert_eq!(*provider, received.channel().provider.selection());
            assert_eq!(result.key, domain_requirement.key);
            assert_eq!(result.input_digest, domain_requirement.input_digest);
            assert_eq!(result.scope_digest, domain_requirement.scope_digest);
            assert_eq!(result.covered_targets, domain_requirement.targets);
            let CheckOutcome::Completed { findings } = &result.outcome else { panic!("semantic coverage must complete"); };
            if mutation == 0 {
                assert!(findings.is_empty());
            } else {
                assert_eq!(findings, &vec![CheckFinding {
                    code: "source-mismatch".into(), target: input.source_set_id.clone(), severity: FindingSeverity::Error,
                }]);
            }
            let coverage = fixed.evaluate(&[vec![core_result], results].concat()).unwrap();
            assert!(coverage.complete);
            let blocking = coverage.entries.iter().any(|(_, state)| matches!(state,
                CoverageState::Completed { findings } if findings.iter().any(|finding| finding.severity == FindingSeverity::Error)));
            assert_eq!(blocking, mutation != 0);
        }
        close_and_reap(&mut session).await;
        assert_eq!(exchange, semantic_input.proposal);

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
        close_and_reap(&mut session).await;

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
        close_and_reap(&mut session).await;
        let remaining: Vec<_> = std::fs::read_dir(temporary.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("packages")]);
    });
}
