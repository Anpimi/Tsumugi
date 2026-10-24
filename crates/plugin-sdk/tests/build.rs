use serde_json::{Value, json};
use tsumugi_plugin_sdk::*;

fn declaration() -> BuildDeclaration {
    parse_build_declaration(include_bytes!("fixtures/build.declaration.json")).unwrap()
}
fn manifest() -> PluginManifest {
    serde_json::from_slice(include_bytes!("fixtures/build.manifest.json")).unwrap()
}
fn binding() -> BuildBinding {
    declaration()
        .bind(&manifest().validate().unwrap(), &"a".repeat(64))
        .unwrap()
}
fn input(kind: &str) -> BuildInput {
    let bytes = match kind {
        "caption" => include_bytes!("fixtures/webvtt.content.json").as_slice(),
        _ => include_bytes!("fixtures/smapi.content.json").as_slice(),
    };
    let value: Value = serde_json::from_slice(bytes).unwrap();
    let mut source: ContentExchange =
        serde_json::from_value(value["body"]["data"].clone()).unwrap();
    source.profile = declaration().profile;
    BuildInput {
        targets: source
            .units
            .iter()
            .map(|unit| BuildTarget {
                unit_id: unit.id.clone(),
                source_revision_id: unit.source_revision_id.clone(),
                text: "決定済み 👩🏽‍💻 é\n😀".into(),
            })
            .collect(),
        source,
        target_language: "ja-JP".into(),
        configuration: vec![],
        output_paths: vec!["locales/ja-JP.txt".into()],
        output_limits: declaration().output_limits,
    }
}
fn output(input: &BuildInput) -> ArtifactSet {
    let utf8 = "\u{feff}fixed output 👩🏽‍💻 é\r\n".to_string();
    ArtifactSet {
        profile: input.source.profile.clone(),
        source_set_id: input.source.source_set_id.clone(),
        target_language: input.target_language.clone(),
        artifacts: vec![CapturedTextArtifact {
            id: "output-1".into(),
            logical_path: "locales/ja-JP.txt".into(),
            role: "translation".into(),
            sha256: payload_digest(&utf8),
            utf8,
        }],
    }
}
fn check_input() -> ArtifactCheckInput {
    let input = input("caption");
    let output = output(&input);
    let binding = binding();
    ArtifactCheckInput {
        input,
        requirements: binding
            .declaration
            .artifact_rules
            .iter()
            .map(|rule| CheckRequirement {
                key: CheckKey {
                    rule: rule.clone(),
                    implementation: CheckImplementation::Plugin {
                        provider: binding.checker.provider.clone(),
                    },
                },
                input_digest: "b".repeat(64),
                scope_digest: "c".repeat(64),
                targets: output.artifacts.iter().map(|a| a.id.clone()).collect(),
                mandatory: true,
                waivable: false,
                not_applicable: None,
            })
            .collect(),
        output,
    }
}

#[test]
fn build_data_keeps_unicode_original_bytes_and_opaque_domain_evidence() {
    for kind in ["caption", "json"] {
        let input = input(kind);
        binding().validate_input(&input).unwrap();
        let parsed = parse_build_input(&serde_json::to_vec(&input).unwrap()).unwrap();
        assert_eq!(parsed, input);
        let output = output(&input);
        binding().validate_artifacts(&input, &output).unwrap();
        assert_eq!(
            parse_artifact_set(&serde_json::to_vec(&output).unwrap()).unwrap(),
            output
        );
        assert!(output.artifacts[0].utf8.starts_with('\u{feff}'));
        // This generic association intentionally does not parse domain syntax.
        // Actual conformance must be established by the independent checker.
        assert!(!input.source.domain_blocks.is_empty());
    }
}
#[test]
fn build_requires_complete_exact_decided_unit_revision_coverage() {
    for change in 0..5 {
        let mut input = input("json");
        match change {
            0 => {
                input.targets.pop();
            }
            1 => input.targets.push(input.targets[0].clone()),
            2 => input.targets[0].unit_id = "unrelated-unit".into(),
            3 => input.targets[0].source_revision_id = "other-revision".into(),
            _ => input.targets[0].text = "😀".repeat(MAX_TEXT_BYTES / 4 + 1),
        }
        assert!(input.validate().is_err(), "case {change}");
    }
    let mut input = input("json");
    input.targets.reverse();
    input.validate().unwrap();
    input.output_limits.max_total_bytes += 1;
    assert!(binding().validate_input(&input).is_err());
    input.output_limits = declaration().output_limits;
    input.source.profile.behavior_version += 1;
    assert!(binding().validate_input(&input).is_err());
}
#[test]
fn artifact_association_checks_actual_bytes_profile_locale_and_fixed_limits() {
    let input = input("caption");
    for change in 0..5 {
        let mut output = output(&input);
        match change {
            0 => output.artifacts[0].utf8.push('X'),
            1 => output.profile.behavior_version += 1,
            2 => output.target_language = "zh-Hans".into(),
            3 => output.source_set_id = "other-source".into(),
            _ => {
                output.artifacts[0].utf8 =
                    "X".repeat(input.output_limits.max_total_bytes as usize + 1);
                output.artifacts[0].sha256 = payload_digest(&output.artifacts[0].utf8);
            }
        }
        assert!(
            validate_build_artifacts(&input, &output).is_err(),
            "case {change}"
        );
    }
    let mut output = output(&input);
    output.artifacts[0].utf8 = "different domain bytes".into();
    output.artifacts[0].sha256 = payload_digest(&output.artifacts[0].utf8);
    validate_build_artifacts(&input, &output).unwrap();
}
#[test]
fn build_output_scope_is_fixed_complete_and_uses_one_portable_path_policy() {
    let original = input("caption");
    for paths in [
        vec![],
        vec!["../outside.txt".into()],
        vec!["a.txt".into(), "A.txt".into()],
        vec!["a.txt".into(), "a.txt/child.txt".into()],
        vec!["a.txt".into(), "b.txt".into(), "c.txt".into()],
    ] {
        let mut captured = original.clone();
        captured.output_paths = paths;
        assert!(captured.validate().is_err());
    }
    let mut built = output(&original);
    built.artifacts[0].logical_path = "other-safe-path.txt".into();
    built.validate().unwrap();
    assert!(validate_build_artifacts(&original, &built).is_err());
    let mut captured = original.clone();
    captured.output_paths.push("second.txt".into());
    captured.validate().unwrap();
    assert!(validate_build_artifacts(&captured, &output(&original)).is_err());
    let mut built = output(&original);
    let mut second = built.artifacts[0].clone();
    second.id = "output-2".into();
    second.logical_path = "second.txt".into();
    built.artifacts.push(second);
    validate_build_artifacts(&captured, &built).unwrap();
    built.artifacts.reverse();
    validate_build_artifacts(&captured, &built).unwrap();
}
#[test]
fn artifacts_reject_unsafe_portable_aliases_and_parent_child_collisions() {
    let input = input("caption");
    for path in [
        "../a.txt",
        "/a.txt",
        "a\\b.txt",
        "a:b.txt",
        "locales/./a.txt",
        "CON.txt",
        "aux/a.txt",
        "lPt9.txt",
        "a. ",
        "a.",
        "日本語.txt",
    ] {
        let mut output = output(&input);
        output.artifacts[0].logical_path = path.into();
        assert!(output.validate().is_err(), "{path}");
    }
    for path in ["LOCALES/JA-jp.TXT", "locales", "locales/ja-JP.txt/child"] {
        let mut output = output(&input);
        let mut second = output.artifacts[0].clone();
        second.id = "output-2".into();
        second.logical_path = path.into();
        output.artifacts.push(second);
        assert!(output.validate().is_err(), "{path}");
    }
}
#[test]
fn independent_artifact_check_requires_exact_rules_provider_and_output_coverage() {
    binding().validate_check_input(&check_input()).unwrap();
    for change in 0..9 {
        let mut input = check_input();
        let r = &mut input.requirements[0];
        let duplicate = r.clone();
        match change {
            0 => r.mandatory = false,
            1 => r.waivable = true,
            2 => r.targets = vec!["source-artifact".into()],
            3 => r.targets.clear(),
            4 => {
                r.not_applicable = Some(NotApplicableBasis {
                    code: "skip".into(),
                    basis_digest: "d".repeat(64),
                })
            }
            5 => r.key.rule.behavior_version += 1,
            6 => {
                r.key.implementation = CheckImplementation::Plugin {
                    provider: binding().builder.provider,
                }
            }
            7 => {
                input.requirements.clear();
            }
            _ => input.requirements.push(duplicate),
        }
        assert!(
            binding().validate_check_input(&input).is_err(),
            "case {change}"
        );
    }
}
#[test]
fn build_resource_binds_both_exact_capabilities_and_refuses_expanded_effects() {
    let binding = binding();
    assert_eq!(binding.builder.provider.package_digest, "a".repeat(64));
    assert_eq!(
        binding.builder.provider.plugin,
        binding.checker.provider.plugin
    );
    for change in 0..6 {
        let mut manifest = manifest();
        let ContributionKind::Capability { declaration: d } =
            &mut manifest.contributions[2].contribution
        else {
            unreachable!()
        };
        match change {
            0 => d.input_schema.schema_version += 1,
            1 => d.output_schema = artifact_set_contract(),
            2 => d.profiles[0].behavior_version += 1,
            3 => {
                d.permissions.push(PermissionRequest::StagedOutput);
                manifest.permissions.push(PermissionRequest::StagedOutput);
            }
            4 => d.effect = EffectKind::Proposal,
            _ => d.error_schema = source_extraction_error_contract(),
        }
        assert!(
            declaration()
                .bind(&manifest.validate().unwrap(), &"a".repeat(64))
                .is_err(),
            "case {change}"
        );
    }
    let mut forged = binding;
    forged.checker.provider.package_digest = "b".repeat(64);
    assert!(forged.validate().is_err());
}
#[test]
fn build_receivers_are_strict_bounded_and_validate_configuration_digests() {
    let input = input("caption");
    let bytes = serde_json::to_vec(&input).unwrap();
    let mut value: Value = serde_json::from_slice(&bytes).unwrap();
    value["projectStore"] = json!(true);
    assert!(parse_build_input(&serde_json::to_vec(&value).unwrap()).is_err());
    let duplicate = String::from_utf8(bytes).unwrap().replace(
        "\"targetLanguage\":\"ja-JP\"",
        "\"targetLanguage\":\"ja-JP\",\"targetLanguage\":\"en-US\"",
    );
    assert!(parse_build_input(duplicate.as_bytes()).is_err());
    assert!(parse_build_input(&vec![b' '; MAX_INVOCATION_PAYLOAD_BYTES + 1]).is_err());
    let mut input = input;
    input.configuration.push(
        EncodedPayload::capture(build_input_contract(), "{ \"setting\": true }\r\n".into())
            .unwrap(),
    );
    input.validate().unwrap();
    input.configuration[0].utf8.push('X');
    assert!(input.validate().is_err());
    let mut d = declaration();
    d.artifact_rules.clear();
    assert!(d.validate().is_err());
    d = declaration();
    d.checker = d.builder.clone();
    assert!(d.validate().is_err());
}
#[cfg(feature = "schema")]
#[test]
fn build_generated_schemas_match_the_only_rust_owner() {
    for (bytes, schema) in [
        (
            include_bytes!("../schemas/build-input.schema.json").as_slice(),
            build_input_schema(),
        ),
        (
            include_bytes!("../schemas/artifact-set.schema.json").as_slice(),
            artifact_set_schema(),
        ),
        (
            include_bytes!("../schemas/artifact-check-input.schema.json").as_slice(),
            artifact_check_input_schema(),
        ),
        (
            include_bytes!("../schemas/build-declaration.schema.json").as_slice(),
            build_declaration_schema(),
        ),
        (
            include_bytes!("../schemas/build-error.schema.json").as_slice(),
            build_error_schema(),
        ),
        (
            include_bytes!("../schemas/build-types.schema.json").as_slice(),
            build_types_schema(),
        ),
    ] {
        assert_eq!(
            serde_json::from_slice::<Value>(bytes).unwrap(),
            serde_json::to_value(schema).unwrap()
        );
    }
}

#[test]
fn build_limits_errors_and_multirule_basis_remain_bounded() {
    for limits in [
        BuildOutputLimits {
            max_artifacts: 0,
            max_total_bytes: 1,
        },
        BuildOutputLimits {
            max_artifacts: MAX_BUILD_ARTIFACTS as u32 + 1,
            max_total_bytes: 1,
        },
        BuildOutputLimits {
            max_artifacts: 1,
            max_total_bytes: 0,
        },
        BuildOutputLimits {
            max_artifacts: 1,
            max_total_bytes: MAX_EXCHANGE_BYTES as u32 + 1,
        },
    ] {
        assert!(limits.validate().is_err());
    }
    let mut checks = check_input();
    let mut second = checks.requirements[0].clone();
    second.key.rule.id = "example.second-rule".into();
    checks.requirements.push(second);
    checks.validate().unwrap();
    checks.requirements[1].scope_digest = "d".repeat(64);
    assert!(checks.validate().is_err());
    let mut manifest = manifest();
    let ContributionKind::Capability { declaration: d } =
        &mut manifest.contributions[1].contribution
    else {
        unreachable!()
    };
    d.limits.max_input_bytes = 100;
    let selected = declaration()
        .bind(&manifest.validate().unwrap(), &"a".repeat(64))
        .unwrap();
    assert!(selected.validate_input(&input("caption")).is_err());
    let mut error = BuildError {
        code: BuildErrorCode::InvalidArtifact,
        artifact_id: Some("output-1".into()),
        detail: "Invalid captured artifact".into(),
    };
    assert_eq!(
        parse_build_error(&serde_json::to_vec(&error).unwrap()).unwrap(),
        error
    );
    error.detail = "X".repeat(4097);
    assert!(error.validate().is_err());
    let mut value = serde_json::to_value(error).unwrap();
    value["authorization"] = json!(true);
    assert!(parse_build_error(&serde_json::to_vec(&value).unwrap()).is_err());
}
