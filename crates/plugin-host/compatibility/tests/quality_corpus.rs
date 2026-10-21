#![cfg(all(unix, feature = "javascript-conformance"))]
//! Consume the fixed evaluation material with real, independently checked
//! package workers. This proves material compatibility, not translation quality.
use std::{collections::BTreeSet, path::Path};

use serde_json::Value;
use tsumugi_plugin_host::PackageImage;
use tsumugi_plugin_sdk::*;

#[path = "../../tests/support/official.rs"]
mod package_fixture;
use package_fixture::{close_and_reap, invoke_received, launch, success_payload};

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap()
}

fn assert_oracle(content: &ContentExchange, expected: &[Value]) {
    assert_eq!(content.units.len(), expected.len());
    assert_eq!(content.order.len(), expected.len());
    assert_eq!(
        content
            .units
            .iter()
            .map(|unit| unit.occurrences.len())
            .sum::<usize>(),
        expected.len()
    );
    let mut identities = BTreeSet::new();
    for (occurrence_id, expected) in content.order.iter().zip(expected) {
        let (unit, occurrence) = content
            .units
            .iter()
            .flat_map(|unit| {
                unit.occurrences
                    .iter()
                    .map(move |occurrence| (unit, occurrence))
            })
            .find(|(_, occurrence)| &occurrence.id == occurrence_id)
            .unwrap();
        assert_eq!(unit.text, text(expected, "text"));
        let native = occurrence.native_identity.as_ref().unwrap();
        assert_eq!(native.display.value, text(expected, "key"));
        assert_eq!(
            native.namespace,
            text(&expected["nativeIdentity"], "namespace")
        );
        assert_eq!(native.value, text(&expected["nativeIdentity"], "value"));
        assert_eq!(
            native.policy,
            serde_json::from_value::<ContractRef>(expected["nativeIdentity"]["policy"].clone())
                .unwrap()
        );
        assert!(identities.insert((&native.namespace, &native.value)));
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires explicitly selected independent domain packages and captured runtime"]
async fn fixed_quality_material_is_complete_and_independently_checked() {
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/tests/fixtures/quality-evaluation");
    let cases: Value =
        serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    assert_eq!(cases["edition"], 1);
    assert_eq!(cases["requestBudget"], 0);
    assert_eq!(cases["targetLanguage"], "zh-CN");
    let domains = cases["domains"].as_array().unwrap();
    assert_eq!(domains.len(), 2);
    assert_eq!(
        domains
            .iter()
            .map(|domain| text(domain, "id"))
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["stardew-smapi", "webvtt"])
    );

    for domain in domains {
        let (package_env, digest_env) = match text(domain, "id") {
            "stardew-smapi" => ("TSUMUGI_TEST_SMAPI_PACKAGE", "TSUMUGI_TEST_SMAPI_DIGEST"),
            "webvtt" => ("TSUMUGI_TEST_WEBVTT_PACKAGE", "TSUMUGI_TEST_WEBVTT_DIGEST"),
            other => panic!("unexpected evaluation domain {other}"),
        };
        let package = std::env::var_os(package_env).expect("explicit prebuilt package required");
        let digest = std::env::var(digest_env).expect("independent package identity required");
        let image = PackageImage::capture_directory(Path::new(&package), &digest, || true).unwrap();
        assert_eq!(image.manifest().manifest().plugin.id, text(domain, "id"));
        let source = image.source_import("source-profile").unwrap();
        assert_ne!(source.extractor.provider, source.checker.provider);
        let versions = domain["versions"].as_array().unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            versions
                .iter()
                .map(|version| text(version, "id"))
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["s1", "s2"])
        );

        for version in versions {
            let temporary = tempfile::tempdir().unwrap();
            let input = SourceExtractionInput {
                profile: source.declaration.profile.clone(),
                source_set_id: format!("quality-{}-{}", text(domain, "id"), text(version, "id")),
                source_language: text(&cases, "sourceLanguage").into(),
                artifacts: version["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .map(|(i, file)| {
                        let utf8 = std::fs::read_to_string(root.join(text(file, "path"))).unwrap();
                        CapturedTextArtifact {
                            id: format!("quality-material-{i}"),
                            logical_path: text(file, "logicalPath").into(),
                            role: text(file, "role").into(),
                            sha256: payload_digest(&utf8),
                            utf8,
                        }
                    })
                    .collect(),
            };
            input.validate().unwrap();
            let input_value = serde_json::to_value(&input).unwrap();
            let mut extractor =
                launch(&image, &source.declaration.extractor, temporary.path()).await;
            let extractor_instance = extractor.channel().instance.instance_id;
            let received = invoke_received(
                &mut extractor,
                &source.extractor,
                "quality-extract",
                &input_value,
            )
            .await;
            let extracted = success_payload(received.result().outcome.clone());
            assert_eq!(extracted.schema, content_exchange_contract());
            let content = parse_content_exchange(extracted.utf8.as_bytes()).unwrap();
            validate_source_extraction(&input, &content).unwrap();
            let expected = version["expected"].as_array().unwrap();
            assert_eq!(expected.len(), 6);
            assert_oracle(&content, expected);
            close_and_reap(&mut extractor).await;

            let requirements: Vec<_> = source
                .declaration
                .semantic_rules
                .iter()
                .map(|rule| CheckRequirement {
                    key: CheckKey {
                        rule: rule.clone(),
                        implementation: CheckImplementation::Plugin {
                            provider: source.checker.provider.clone(),
                        },
                    },
                    input_digest: payload_digest(&input_value.to_string()),
                    scope_digest: payload_digest(&extracted.utf8),
                    targets: vec![input.source_set_id.clone()],
                    mandatory: true,
                    waivable: false,
                    not_applicable: None,
                })
                .collect();
            assert!(!requirements.is_empty());
            let checked = SourceExtractionCheckInput {
                source: input,
                proposal: content,
                requirements,
            };
            checked.validate().unwrap();
            let mut checker = launch(&image, &source.declaration.checker, temporary.path()).await;
            assert_ne!(checker.channel().instance.instance_id, extractor_instance);
            for forged in [false, true] {
                let mut candidate = checked.clone();
                if forged {
                    candidate.proposal.units[0].text.push_str(" forged");
                    let changed = payload_digest(
                        &serde_json::to_value(&candidate.proposal)
                            .unwrap()
                            .to_string(),
                    );
                    for requirement in &mut candidate.requirements {
                        requirement.scope_digest = changed.clone();
                    }
                }
                candidate.validate().unwrap();
                let received = invoke_received(
                    &mut checker,
                    &source.checker,
                    if forged {
                        "quality-forged"
                    } else {
                        "quality-check"
                    },
                    &serde_json::to_value(&candidate).unwrap(),
                )
                .await;
                assert_eq!(
                    received.channel().provider.selection(),
                    source.checker.provider
                );
                let output = success_payload(received.result().outcome.clone());
                assert_eq!(output.schema, check_results_contract());
                let results = parse_check_results(output.utf8.as_bytes()).unwrap();
                assert_eq!(results.len(), candidate.requirements.len());
                for (result, requirement) in results.iter().zip(&candidate.requirements) {
                    assert_eq!(result.key, requirement.key);
                    assert_eq!(result.input_digest, requirement.input_digest);
                    assert_eq!(result.scope_digest, requirement.scope_digest);
                    assert_eq!(result.covered_targets, requirement.targets);
                    let CheckOutcome::Completed { findings } = &result.outcome else {
                        panic!("independent checker did not complete: {:?}", result.outcome)
                    };
                    assert_eq!(findings.is_empty(), !forged);
                    if forged {
                        assert!(
                            findings
                                .iter()
                                .any(|finding| finding.severity == FindingSeverity::Error)
                        );
                    }
                }
            }
            close_and_reap(&mut checker).await;
            assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 0);
        }
    }
}
