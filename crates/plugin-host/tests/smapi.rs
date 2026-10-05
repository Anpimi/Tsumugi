#![cfg(all(unix, feature = "javascript-conformance"))]
//! Real pairing consumes a selected independent package, never domain source.
use serde_json::Value;
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::*;
#[path = "support/official.rs"]
mod package_fixture;
use package_fixture::*;

fn requirement(
    rule: &str,
    binding: &CapabilityBinding,
    input: &str,
    scope: &str,
    target: &str,
) -> CheckRequirement {
    CheckRequirement {
        key: CheckKey {
            rule: contract(rule),
            implementation: CheckImplementation::Plugin {
                provider: binding.provider.clone(),
            },
        },
        input_digest: payload_digest(input),
        scope_digest: payload_digest(scope),
        targets: vec![target.into()],
        mandatory: true,
        waivable: false,
        not_applicable: None,
    }
}

fn assert_check(
    received: ReceivedResult,
    fixed: &CheckRequirement,
    expected_error: Option<&str>,
    core_validator: &str,
) {
    let CheckImplementation::Plugin { provider } = &fixed.key.implementation else {
        panic!("plugin selection required");
    };
    assert_eq!(received.channel().provider.selection(), *provider);
    let payload = success_payload(received.result().outcome.clone());
    assert_eq!(payload.schema, check_results_contract());
    let results = parse_check_results(payload.utf8.as_bytes()).unwrap();
    assert_eq!(results.len(), 1);
    let result = &results[0];
    assert_eq!(result.key, fixed.key);
    assert_eq!(result.input_digest, fixed.input_digest);
    assert_eq!(result.scope_digest, fixed.scope_digest);
    assert_eq!(result.covered_targets, fixed.targets);
    let CheckOutcome::Completed { findings } = &result.outcome else {
        panic!("independent checker must complete");
    };
    let expected = expected_error.map(|code| CheckFinding {
        code: code.into(),
        target: fixed.targets[0].clone(),
        severity: FindingSeverity::Error,
    });
    assert_eq!(findings, &expected.into_iter().collect::<Vec<_>>());
    // Callers execute the generic SDK association on each candidate before
    // dispatch. Its trusted result supplies no domain/adoption conclusion.
    let core = CheckRequirement {
        key: CheckKey {
            rule: contract(core_validator),
            implementation: CheckImplementation::Core {
                validator: contract(core_validator),
            },
        },
        input_digest: fixed.input_digest.clone(),
        scope_digest: fixed.scope_digest.clone(),
        targets: fixed.targets.clone(),
        mandatory: true,
        waivable: false,
        not_applicable: None,
    };
    let core_result = CheckResult {
        key: core.key.clone(),
        input_digest: core.input_digest.clone(),
        scope_digest: core.scope_digest.clone(),
        covered_targets: core.targets.clone(),
        outcome: CheckOutcome::Completed { findings: vec![] },
    };
    let checks = capture_required_checks(
        contract("official.smapi-check-policy"),
        vec![core],
        vec![fixed.clone()],
    )
    .unwrap();
    let coverage = checks
        .evaluate(&[vec![core_result], results].concat())
        .unwrap();
    assert!(coverage.complete);
    let blocking = coverage.entries.iter().any(|(_, state)| matches!(state,
        CoverageState::Completed { findings } if findings.iter().any(|finding| finding.severity == FindingSeverity::Error)));
    assert_eq!(blocking, expected_error.is_some());
}

#[test]
fn official_smapi_package_extracts_builds_and_checks_through_the_captured_host() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let image = installed(temporary.path(), "stardew-smapi");
        let source_binding = image.source_import("source-profile").unwrap();
        assert_eq!(source_binding.declaration.profile, contract("smapi-i18n-flat"));
        assert_eq!(source_binding.declaration.materials.iter().map(|entry| (entry.logical_path.as_str(), entry.max_bytes)).collect::<Vec<_>>(),
            vec![("manifest.json", 16384), ("i18n/default.json", 131072)]);
        assert_eq!(source_binding.declaration.semantic_rules, vec![contract("smapi.source-semantics")]);
        let manifest = "{\"UniqueID\":\"Example.Mod\",\"Name\":\"Test\",\"Version\":\"1.0.0\",\"EntryDll\":\"Test.dll\"}";
        let raw = "\u{feff}{\r\n // retained 中文 😀\r\n \"MiX\\u0041\": \"Hi {{name}} 👩🏽‍💻 é\",\r\n \"same-a\": \"same\",\r\n \"same-b\": \"same\",\r\n \"empty\": \"\",\r\n \"$schema\": \"schema.json\",\r\n}\r\n";
        let input = SourceExtractionInput { profile: source_binding.declaration.profile.clone(), source_set_id: "synthetic-set".into(), source_language: "en".into(), artifacts: vec![
            CapturedTextArtifact { id: "manifest".into(), logical_path: "manifest.json".into(), role: "companion".into(), sha256: payload_digest(manifest), utf8: manifest.into() },
            CapturedTextArtifact { id: "default".into(), logical_path: "i18n/default.json".into(), role: "source".into(), sha256: payload_digest(raw), utf8: raw.into() },
        ] };
        input.validate().unwrap();
        let mut extractor = launch(&image, "extract-source", temporary.path()).await;
        let extraction_channel = extractor.channel();
        let extracted = success_payload(invoke(&mut extractor, &source_binding.extractor, "extract-good", &serde_json::to_value(&input).unwrap()).await);
        assert_eq!(extracted.schema, content_exchange_contract());
        let exchange = parse_content_exchange(extracted.utf8.as_bytes()).unwrap();
        validate_source_extraction(&input, &exchange).unwrap();
        assert_eq!(exchange.artifacts, input.artifacts);
        assert_eq!(exchange.units.iter().map(|unit| unit.text.as_str()).collect::<Vec<_>>(), vec!["Hi {{name}} 👩🏽‍💻 é", "same", "same", ""]);
        assert!(exchange.relations.is_empty() && exchange.domain_blocks.is_empty());
        assert_ne!(exchange.units[1].id, exchange.units[2].id);
        for (index, unit) in exchange.units.iter().enumerate() {
            assert_eq!(unit.occurrences.len(), 1);
            let occurrence = &unit.occurrences[0];
            let identity = occurrence.native_identity.as_ref().unwrap();
            assert_eq!(identity.namespace, "Example.Mod");
            assert_eq!(identity.display.value, ["MiXA", "same-a", "same-b", "empty"][index]);
            assert_eq!(identity.value, ["mixa", "same-a", "same-b", "empty"][index]);
            assert_eq!(identity.policy, contract("smapi-native-key"));
            for (reference, expected) in [(&occurrence.source, unit.text.as_str()), (identity.display.source.as_ref().unwrap(), identity.display.value.as_str())] {
                assert_eq!(reference.artifact_id, "default");
                assert_eq!(reference.range.encoding, TextEncoding::Utf8Byte);
                let token = &raw.as_bytes()[reference.range.start as usize..reference.range.end as usize];
                assert_eq!(serde_json::from_slice::<String>(token).unwrap(), expected);
            }
        }
        let mut duplicate = input.clone(); duplicate.artifacts[1].utf8 = "{\"A\":\"first\",\"a\":\"second\"}".into(); duplicate.artifacts[1].sha256 = payload_digest(&duplicate.artifacts[1].utf8);
        let InvocationOutcome::Failed { error } = invoke(&mut extractor, &source_binding.extractor, "extract-case-conflict", &serde_json::to_value(duplicate).unwrap()).await else { panic!("duplicate native identity must fail"); };
        assert_eq!(error.schema, source_extraction_error_contract());
        assert_eq!(parse_source_extraction_error(error.utf8.as_bytes()).unwrap().code, SourceExtractionErrorCode::UnsupportedStructure);
        close_and_reap(&mut extractor).await;

        let fixed = requirement("smapi.source-semantics", &source_binding.checker, &serde_json::to_value(&input).unwrap().to_string(), &extracted.utf8, &input.source_set_id);
        let original_check = SourceExtractionCheckInput { source: input.clone(), proposal: exchange.clone(), requirements: vec![fixed.clone()] };
        let mut checker = launch(&image, "source-semantic-check", temporary.path()).await;
        assert_ne!(checker.channel().provider.instance_id, extraction_channel.provider.instance_id);
        for (dispatch, forged) in [("source-check-good", false), ("source-check-forged", true)] {
            let mut check = original_check.clone(); if forged { check.proposal.units[0].text = "Structurally valid forged text".into(); }
            validate_source_extraction(&check.source, &check.proposal).unwrap();
            let value = serde_json::to_value(check).unwrap();
            parse_source_extraction_check_input(value.to_string().as_bytes()).unwrap();
            let received = invoke_received(&mut checker, &source_binding.checker, dispatch, &value).await;
            assert_check(received, &fixed, forged.then_some("source-mismatch"), "core.sdk-source-association");
        }
        close_and_reap(&mut checker).await;

        let build_binding = image.build_declaration("build-profile").unwrap();
        assert_eq!(build_binding.declaration.profile, contract("smapi-i18n-flat"));
        assert_eq!(build_binding.declaration.output_limits, BuildOutputLimits { max_artifacts: 1, max_total_bytes: 1048576 });
        assert_eq!(build_binding.declaration.artifact_rules, vec![contract("smapi.artifact-conformance")]);
        let texts = ["你好 {{name}} 😀", "同じ", "同じ", ""];
        let build = BuildInput { targets: exchange.units.iter().zip(texts).map(|(unit, text)| BuildTarget {
            unit_id: unit.id.clone(), source_revision_id: unit.source_revision_id.clone(), text: text.into(),
        }).collect(), source: exchange, target_language: "zh-CN".into(), configuration: vec![], output_paths: vec!["i18n/zh.json".into()], output_limits: build_binding.declaration.output_limits.clone() };
        build_binding.validate_input(&build).unwrap();
        let mut builder = launch(&image, "build", temporary.path()).await;
        let built = success_payload(invoke(&mut builder, &build_binding.builder, "build-good", &serde_json::to_value(&build).unwrap()).await);
        assert_eq!(built.schema, artifact_set_contract());
        let artifacts = parse_artifact_set(built.utf8.as_bytes()).unwrap();
        build_binding.validate_artifacts(&build, &artifacts).unwrap();
        // Independent literal oracle: never derive expected bytes from builder.
        let expected = "{\n  \"MiXA\": \"你好 {{name}} 😀\",\n  \"same-a\": \"同じ\",\n  \"same-b\": \"同じ\",\n  \"empty\": \"\"\n}\n";
        assert_eq!(artifacts.artifacts[0].utf8, expected);
        assert_eq!(artifacts.artifacts[0].sha256, payload_digest(expected));
        assert_eq!(artifacts.artifacts[0].logical_path, "i18n/zh.json");
        let mut stale = build.clone(); stale.targets[0].source_revision_id = "stale".into();
        let InvocationOutcome::Failed { error } = invoke(&mut builder, &build_binding.builder, "build-stale", &serde_json::to_value(stale).unwrap()).await else { panic!("stale revision must fail"); };
        assert_eq!(error.schema, build_error_contract());
        assert_eq!(parse_build_error(error.utf8.as_bytes()).unwrap().code, BuildErrorCode::InvalidTarget);
        let mut unsafe_path = build.clone(); unsafe_path.output_paths = vec!["i18n/default.json".into()];
        let InvocationOutcome::Failed { error } = invoke(&mut builder, &build_binding.builder, "build-default", &serde_json::to_value(unsafe_path).unwrap()).await else { panic!("default output must fail"); };
        assert_eq!(parse_build_error(error.utf8.as_bytes()).unwrap().code, BuildErrorCode::InvalidInput);
        close_and_reap(&mut builder).await;

        let fixed = requirement("smapi.artifact-conformance", &build_binding.checker, &serde_json::to_value(&build).unwrap().to_string(), &built.utf8, "smapi-locale-output");
        let original = ArtifactCheckInput { input: build, output: artifacts, requirements: vec![fixed.clone()] };
        let mut checker = launch(&image, "validate-artifact", temporary.path()).await;
        assert_ne!(checker.channel().provider.instance_id, extraction_channel.provider.instance_id);
        for (dispatch, replace) in [("artifact-good", None), ("artifact-forged", Some(("你好", "wrong"))), ("artifact-format", Some(("  \"MiXA\"", " \"MiXA\"")))] {
            let mut check = original.clone();
            if let Some((from, to)) = replace { let artifact = &mut check.output.artifacts[0]; artifact.utf8 = artifact.utf8.replacen(from, to, 1); artifact.sha256 = payload_digest(&artifact.utf8); }
            build_binding.validate_check_input(&check).unwrap();
            let value: Value = serde_json::to_value(check).unwrap();
            let received = invoke_received(&mut checker, &build_binding.checker, dispatch, &value).await;
            assert_check(received, &fixed, replace.map(|_| "artifact-mismatch"), "core.sdk-artifact-association");
        }
        close_and_reap(&mut checker).await;
        let remaining: Vec<_> = std::fs::read_dir(temporary.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("packages")]);
    });
}

#[test]
fn official_smapi_translation_proposals_and_independent_checks_use_the_captured_host() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let temporary = tempfile::tempdir().unwrap();
        let image = installed(temporary.path(), "stardew-smapi");
        let binding = image.translation_import("translation-profile").unwrap();
        assert_eq!(binding.declaration.profile, contract("smapi-i18n-flat"));
        assert_eq!(binding.declaration.material.logical_directory, "i18n");
        assert_eq!(binding.declaration.material.extension, "json");
        assert_eq!(binding.declaration.material.max_bytes, 131072);
        assert_eq!(binding.declaration.semantic_rules, vec![contract("smapi.translation-semantics")]);
        let raw = "\u{feff}{\r\n // 原始 中文 😀\r\n \"MiX\\u0041\": \"译文 👩🏽‍💻 é\",\r\n \"same-a\": \"同文\",\r\n \"same-b\": \"同文\",\r\n \"empty\": \"\",\r\n \"$schema\": \"schema.json\",\r\n}\r\n";
        let input = TranslationExtractionInput {
            profile: binding.declaration.profile.clone(), import_id: "synthetic-translation-import".into(),
            source_set_id: "synthetic-source-set".into(), source_snapshot_id: "synthetic-source-snapshot".into(),
            target_language: "zh-CN".into(), language_evidence: TranslationLanguageEvidence::UserConfirmed,
            native_scope: TranslationNativeScope { namespace: "Example.Mod".into(), policy: contract("smapi-native-key") },
            artifacts: vec![CapturedTextArtifact { id: "translated-file".into(), logical_path: "i18n/zh.json".into(),
                role: "translation".into(), sha256: payload_digest(raw), utf8: raw.into() }],
        };
        binding.validate_input(&input).unwrap();
        let mut extractor = launch(&image, "import-translations", temporary.path()).await;
        let extraction_channel = extractor.channel();
        let extracted = success_payload(invoke(&mut extractor, &binding.extractor, "translation-good", &serde_json::to_value(&input).unwrap()).await);
        assert_eq!(extracted.schema, translation_exchange_contract());
        let proposal = parse_translation_exchange(extracted.utf8.as_bytes()).unwrap();
        validate_translation_extraction(&input, &proposal).unwrap();
        assert_eq!(proposal.source_snapshot_id, input.source_snapshot_id);
        assert_eq!(proposal.target_language, "zh-CN");
        assert_eq!(proposal.declared_language, "zh");
        assert_eq!(proposal.artifacts, input.artifacts);
        assert_eq!(proposal.entries.iter().map(|entry| entry.text.as_str()).collect::<Vec<_>>(), vec!["译文 👩🏽‍💻 é", "同文", "同文", ""]);
        assert_eq!(proposal.order, proposal.entries.iter().map(|entry| entry.id.clone()).collect::<Vec<_>>());
        for (index, entry) in proposal.entries.iter().enumerate() {
            assert_eq!(entry.native_identity.namespace, "Example.Mod");
            assert_eq!(entry.native_identity.policy, contract("smapi-native-key"));
            assert_eq!(entry.native_identity.value, ["mixa", "same-a", "same-b", "empty"][index]);
            assert_eq!(entry.native_identity.display.value, ["MiXA", "same-a", "same-b", "empty"][index]);
            for (source, expected) in [(&entry.source, entry.text.as_str()), (entry.native_identity.display.source.as_ref().unwrap(), entry.native_identity.display.value.as_str())] {
                assert_eq!(source.artifact_id, "translated-file");
                assert_eq!(source.range.encoding, TextEncoding::Utf8Byte);
                assert_eq!(serde_json::from_slice::<String>(&raw.as_bytes()[source.range.start as usize..source.range.end as usize]).unwrap(), expected);
            }
        }
        for (dispatch, path, text, expected) in [
            ("translation-default", "i18n/default.json", raw, SourceExtractionErrorCode::InvalidInput),
            ("translation-case-conflict", "i18n/zh.json", "{\"A\":\"first\",\"a\":\"second\"}", SourceExtractionErrorCode::UnsupportedStructure),
        ] {
            let mut invalid = input.clone(); invalid.artifacts[0].logical_path = path.into();
            invalid.artifacts[0].utf8 = text.into(); invalid.artifacts[0].sha256 = payload_digest(text);
            let InvocationOutcome::Failed { error } = invoke(&mut extractor, &binding.extractor, dispatch, &serde_json::to_value(invalid).unwrap()).await else { panic!("unsupported complete translation input must fail"); };
            assert_eq!(error.schema, source_extraction_error_contract());
            let error = parse_source_extraction_error(error.utf8.as_bytes()).unwrap();
            assert_eq!(error.code, expected); assert_eq!(error.artifact_id.as_deref(), Some("translated-file"));
        }
        let mut empty = input.clone(); empty.artifacts[0].utf8 = "\u{feff}{}\r\n".into(); empty.artifacts[0].sha256 = payload_digest(&empty.artifacts[0].utf8);
        let empty_result = success_payload(invoke(&mut extractor, &binding.extractor, "translation-empty", &serde_json::to_value(&empty).unwrap()).await);
        let empty_proposal = parse_translation_exchange(empty_result.utf8.as_bytes()).unwrap();
        validate_translation_extraction(&empty, &empty_proposal).unwrap();
        assert!(empty_proposal.entries.is_empty() && empty_proposal.order.is_empty());
        assert_eq!(empty_proposal.artifacts, empty.artifacts);
        close_and_reap(&mut extractor).await;

        let fixed = requirement("smapi.translation-semantics", &binding.checker, &serde_json::to_value(&input).unwrap().to_string(), &extracted.utf8, &input.import_id);
        let original = TranslationExtractionCheckInput { input: input.clone(), proposal: proposal.clone(), requirements: vec![fixed.clone()] };
        let mut checker = launch(&image, "translation-semantic-check", temporary.path()).await;
        assert_ne!(checker.channel().provider.instance_id, extraction_channel.provider.instance_id);
        for (dispatch, mutation) in [("translation-check-good", 0), ("translation-check-forged", 1), ("translation-check-missing", 2), ("translation-check-order", 3), ("translation-check-native", 4)] {
            let mut request = original.clone();
            match mutation {
                1 => request.proposal.entries[0].text = "Structurally valid forged translation".into(),
                2 => { request.proposal.entries.pop(); request.proposal.order.pop(); },
                3 => request.proposal.order.reverse(),
                4 => request.proposal.entries[0].native_identity.value = "other".into(),
                _ => (),
            }
            validate_translation_extraction(&request.input, &request.proposal).unwrap();
            let value = serde_json::to_value(request).unwrap();
            parse_translation_extraction_check_input(value.to_string().as_bytes()).unwrap();
            let received = invoke_received(&mut checker, &binding.checker, dispatch, &value).await;
            assert_check(received, &fixed, (mutation != 0).then_some("translation-mismatch"), "core.sdk-translation-association");
        }
        let empty_fixed = requirement("smapi.translation-semantics", &binding.checker, &serde_json::to_value(&empty).unwrap().to_string(), &empty_result.utf8, &empty.import_id);
        let request = TranslationExtractionCheckInput { input: empty, proposal: empty_proposal, requirements: vec![empty_fixed.clone()] };
        let received = invoke_received(&mut checker, &binding.checker, "translation-check-empty", &serde_json::to_value(request).unwrap()).await;
        assert_check(received, &empty_fixed, None, "core.sdk-translation-association");
        close_and_reap(&mut checker).await;
        let remaining: Vec<_> = std::fs::read_dir(temporary.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(remaining, vec![std::ffi::OsString::from("packages")]);
    });
}
