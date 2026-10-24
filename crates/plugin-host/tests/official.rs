#![cfg(all(unix, feature = "javascript-conformance"))]
//! Pairing checks consume an explicitly selected prebuilt official package.
//! Domain source stays in its independent repository; this Host test does not
//! link a parser or treat generic SDK validation as project adoption.
use serde_json::json;
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::*;
#[path = "support/official.rs"]
mod package_fixture;
use package_fixture::*;

#[test]
fn official_webvtt_package_extracts_builds_and_checks_through_the_captured_host() {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let image = installed(temporary.path(), "webvtt");
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
        assert_eq!(semantic_channel.provider("source-semantic-check").unwrap().selection(), semantic.provider);
        assert_ne!(semantic_channel.instance.instance_id, extraction_channel.instance.instance_id);
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
            assert_eq!(received.channel().provider, semantic_channel.provider("source-semantic-check").unwrap());
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

        let expected = "\u{feff}WEBVTT preserved\r\n\r\nNOTE before\r\nkept\r\n\r\nSTYLE\r\n::cue { color: lime; }\r\n\r\nREGION\r\nid:bottom\r\nwidth:80%\r\n\r\nCue-A\r\n00:01.000 --> 00:02.000 region:bottom align:center\r\n第一行 😀\r\n新しい二行 é\r\n\r\nNOTE between\r\nkept too\r\n\r\nCue-B\r\n00:01.500 --> 00:03.000\r\n译文\r\n";
        assert_build_and_check(&image, temporary.path(), exchange, &["第一行 😀\n新しい二行 é", "译文"], expected).await;
        let remaining: Vec<_> = std::fs::read_dir(temporary.path()).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("packages")]);
    });
}

/// A fixed public content oracle permits isolated build/check pairing without
/// executing source extraction or its separate semantic-check contribution.
#[test]
fn official_webvtt_generic_build_and_check_use_the_captured_package() {
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    executor.block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let image = installed(temporary.path(), "webvtt");
        let source = parse_content_exchange(include_bytes!("fixtures/webvtt-build-source.json")).unwrap();
        let expected = "\u{feff}WEBVTT\r\n\r\nKeep\r\n00:00.000 --> 00:01.000 align:center\r\n你好\r\n世界\r\n\r\nSecond\r\n00:01.000 --> 00:02.000\r\n等待\r\n";
        assert_build_and_check(&image, temporary.path(), source, &["你好\n世界", "等待"], expected).await;
        let remaining: Vec<_> = std::fs::read_dir(temporary.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("packages")]);
    });
}

async fn assert_build_and_check(
    image: &PackageImage,
    temporary: &std::path::Path,
    source: ContentExchange,
    texts: &[&str],
    expected: &str,
) {
    let binding = image.build_declaration("build-profile").unwrap();
    assert_eq!(binding.declaration.profile, contract("webvtt-captions"));
    assert_eq!(
        binding.declaration.output_limits,
        BuildOutputLimits {
            max_artifacts: 1,
            max_total_bytes: 131072
        }
    );
    assert_eq!(
        binding.declaration.artifact_rules,
        vec![contract("webvtt.artifact-conformance")]
    );
    assert_eq!(texts.len(), source.units.len());
    let input = BuildInput {
        targets: source
            .units
            .iter()
            .zip(texts)
            .map(|(unit, text)| BuildTarget {
                unit_id: unit.id.clone(),
                source_revision_id: unit.source_revision_id.clone(),
                text: (*text).into(),
            })
            .collect(),
        source,
        target_language: "zh-CN".into(),
        configuration: vec![],
        output_paths: vec!["zh-CN.vtt".into()],
        output_limits: binding.declaration.output_limits.clone(),
    };
    binding.validate_input(&input).unwrap();
    let mut builder = launch(image, "build", temporary).await;
    let payload = success_payload(
        invoke(
            &mut builder,
            &binding.builder,
            "build-good",
            &serde_json::to_value(&input).unwrap(),
        )
        .await,
    );
    assert_eq!(payload.schema, artifact_set_contract());
    let artifacts = parse_artifact_set(payload.utf8.as_bytes()).unwrap();
    binding.validate_artifacts(&input, &artifacts).unwrap();
    assert_eq!(artifacts.artifacts.len(), 1);
    assert_eq!(artifacts.artifacts[0].utf8.as_bytes(), expected.as_bytes());
    assert_eq!(artifacts.artifacts[0].sha256, payload_digest(expected));
    assert_eq!(artifacts.artifacts[0].logical_path, "zh-CN.vtt");
    let mut unsafe_target = input.clone();
    unsafe_target.targets[0].text = "<b>markup</b>".into();
    let InvocationOutcome::Failed { error } = invoke(
        &mut builder,
        &binding.builder,
        "build-markup",
        &serde_json::to_value(unsafe_target).unwrap(),
    )
    .await
    else {
        panic!("markup target must fail");
    };
    assert_eq!(error.schema, build_error_contract());
    assert_eq!(
        parse_build_error(error.utf8.as_bytes()).unwrap().code,
        BuildErrorCode::InvalidTarget
    );
    let mut stale = input.clone();
    stale.targets[0].source_revision_id = "different-revision".into();
    let InvocationOutcome::Failed { error } = invoke(
        &mut builder,
        &binding.builder,
        "build-stale",
        &serde_json::to_value(stale).unwrap(),
    )
    .await
    else {
        panic!("stale target must fail");
    };
    assert_eq!(
        parse_build_error(error.utf8.as_bytes()).unwrap().code,
        BuildErrorCode::InvalidInput
    );
    let InvocationOutcome::Failed { error } = invoke(
        &mut builder,
        &binding.builder,
        "build-legacy-wire",
        &json!({"version":1,"template":{}}),
    )
    .await
    else {
        panic!("earlier dedicated wire shape must fail");
    };
    assert_eq!(
        parse_build_error(error.utf8.as_bytes()).unwrap().code,
        BuildErrorCode::InvalidInput
    );
    close_and_reap(&mut builder).await;

    let requirement = CheckRequirement {
        key: CheckKey {
            rule: binding.declaration.artifact_rules[0].clone(),
            implementation: CheckImplementation::Plugin {
                provider: binding.checker.provider.clone(),
            },
        },
        input_digest: payload_digest(&serde_json::to_value(&input).unwrap().to_string()),
        scope_digest: payload_digest(&payload.utf8),
        targets: vec![artifacts.artifacts[0].id.clone()],
        mandatory: true,
        waivable: false,
        not_applicable: None,
    };
    let original = ArtifactCheckInput {
        input,
        output: artifacts,
        requirements: vec![requirement.clone()],
    };
    binding.validate_check_input(&original).unwrap();
    let mut checker = launch(image, "validate-artifact", temporary).await;
    for (dispatch, from, to) in [
        ("check-good", "", ""),
        ("check-timing", "00:01.000", "00:01.100"),
        (
            "check-text",
            texts[0].split('\n').next().unwrap(),
            "wrong decided text",
        ),
        ("check-non-payload", "WEBVTT", "WEBVTT altered"),
    ] {
        let mut captured = original.clone();
        if !from.is_empty() {
            let output = &mut captured.output.artifacts[0];
            output.utf8 = output.utf8.replacen(from, to, 1);
            assert_ne!(output.utf8, expected);
            output.sha256 = payload_digest(&output.utf8);
        }
        binding.validate_check_input(&captured).unwrap();
        let received = invoke_received(
            &mut checker,
            &binding.checker,
            dispatch,
            &serde_json::to_value(captured).unwrap(),
        )
        .await;
        let payload = success_payload(received.result().outcome.clone());
        assert_eq!(payload.schema, check_results_contract());
        let results = parse_check_results(payload.utf8.as_bytes()).unwrap();
        assert_eq!(results.len(), 1);
        let result = &results[0];
        assert_eq!(result.key, requirement.key);
        assert_eq!(
            received.channel().provider.selection(),
            binding.checker.provider
        );
        assert_eq!(result.input_digest, requirement.input_digest);
        assert_eq!(result.scope_digest, requirement.scope_digest);
        assert_eq!(result.covered_targets, requirement.targets);
        let CheckOutcome::Completed { findings } = &result.outcome else {
            panic!("artifact conformance must complete");
        };
        if from.is_empty() {
            assert!(findings.is_empty());
        } else {
            assert_eq!(
                findings,
                &vec![CheckFinding {
                    code: "artifact-mismatch".into(),
                    target: requirement.targets[0].clone(),
                    severity: FindingSeverity::Error
                }]
            );
        }
    }
    let mut incomplete = original;
    incomplete.requirements[0].targets.clear();
    let InvocationOutcome::Failed { error } = invoke(
        &mut checker,
        &binding.checker,
        "check-incomplete",
        &serde_json::to_value(incomplete).unwrap(),
    )
    .await
    else {
        panic!("incomplete rule coverage must fail");
    };
    assert_eq!(
        parse_build_error(error.utf8.as_bytes()).unwrap().code,
        BuildErrorCode::InvalidInput
    );
    close_and_reap(&mut checker).await;
}
