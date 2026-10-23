#![cfg(all(unix, feature = "javascript-conformance"))]
//! One real package keeps deterministic knowledge usable without its AI service.
use serde_json::{Value, json};
use std::path::PathBuf;
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk as sdk;

#[path = "support/official.rs"]
mod official;
#[path = "support/runtime.rs"]
mod runtime_fixture;

#[test]
fn missing_generation_service_refuses_only_its_component_before_staging() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let selected = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_GENERATION_PACKAGE")
                    .expect("explicit new prebuilt generation package required"),
            );
            let digest = std::env::var("TSUMUGI_TEST_GENERATION_DIGEST")
                .expect("independently approved generation package digest required");
            let image = PackageImage::capture_directory(&selected, &digest, || true).unwrap();
            assert_eq!(image.manifest().manifest().plugin.id, "philosophy");
            let ui = image.reference_query_ui("reference-query").unwrap();
            assert_eq!(ui.component_id, "knowledge");
            assert_eq!(ui.ui_id, "reference-query");
            assert_eq!(ui.slot, "reference-query");
            assert_eq!(ui.resource_id, "agent-query-tool");
            assert_eq!(
                ui.binding.capability.provider.plugin,
                image.manifest().manifest().plugin
            );
            assert_eq!(ui.binding.capability.provider.package_digest, digest);
            assert_eq!(ui.binding.capability.provider.component_id, "knowledge");
            assert_eq!(ui.binding.capability.provider.contribution_id, "query");
            let generation = sdk::bind_capability(
                image.manifest(),
                "generation-delegate",
                image.package_digest(),
            )
            .unwrap();
            assert_eq!(generation.provider.plugin, ui.binding.capability.provider.plugin);
            assert_eq!(generation.provider.package_digest, ui.binding.capability.provider.package_digest);
            assert_eq!(generation.provider.component_id, "generation");
            assert_eq!(
                generation.declaration.contract,
                sdk::ContractRef {
                    id: "org.tsumugi.examples.philosophy-generation-delegate".into(),
                    schema_version: 2,
                    behavior_version: 2
                }
            );
            assert_eq!(
                generation.declaration.input_schema,
                sdk::generation_component_input_contract()
            );
            assert_eq!(
                generation.declaration.output_schema,
                sdk::generation_service_receipt_contract()
            );
            assert_eq!(
                generation.declaration.error_schema,
                sdk::generation_service_error_contract()
            );
            assert!(generation.declaration.profiles.is_empty());
            let component = image
                .manifest()
                .manifest()
                .components
                .iter()
                .find(|component| component.id == generation.provider.component_id)
                .unwrap();
            assert_eq!(component.scope, sdk::ComponentScope::Attempt);
            assert_eq!(
                component.dependencies,
                vec![
                    sdk::CapabilityDependency {
                        contract: sdk::generation_service_contract(),
                        required: true,
                        selection: sdk::ProviderSelection::Single,
                    },
                    sdk::CapabilityDependency {
                        contract: official::contract("org.tsumugi.examples.philosophy-query"),
                        required: true,
                        selection: sdk::ProviderSelection::Single,
                    }
                ]
            );
            let resource = image
                .resource_bytes(
                    "terminology",
                    &official::contract("org.tsumugi.examples.terminology-resource"),
                )
                .unwrap()
                .to_vec();
            let skill = image.skill_bytes("concept-review").unwrap().to_vec();
            let temporary = tempfile::tempdir().unwrap();
            let query_stages = temporary.path().join("query");
            let refused_stages = temporary.path().join("generation");
            let check_stages = temporary.path().join("check");
            for directory in [&query_stages, &refused_stages, &check_stages] {
                std::fs::create_dir(directory).unwrap();
            }
            let tool = image.capability_tool("agent-query-tool").unwrap();
            assert_eq!(ui.binding, tool);
            let query = tool
                .declaration
                .query
                .as_ref()
                .unwrap()
                .prepare_payload(
                    "👩🏽‍💻 e\u{301} sound premises",
                    "zh-CN",
                    &["soundness".into()],
                    tool.capability.declaration.limits.max_input_bytes,
                )
                .unwrap();
            let mut session = official::launch(&image, "query", &query_stages).await;
            let channel = session.channel();
            let before = official::success_payload(
                official::invoke(&mut session, &tool.capability, "query-before", &query).await,
            );
            let expected: Value = serde_json::from_str(&before.utf8).unwrap();
            assert_eq!(
                expected["results"][0]["entries"][0]["preferredTarget"],
                "可靠性"
            );

            let refused = ProcessSession::launch(
                &image,
                "generation-delegate",
                &refused_stages,
                &RuntimeLauncher::JavaScript {
                    runtime: runtime_fixture::approved_runtime(),
                },
                LaunchOptions {
                    scope: SessionScope::Bound(ScopeBinding {
                        project_id: "synthetic-project".into(),
                        scope_id: "synthetic-generation-attempt".into(),
                    }),
                    allow_unsandboxed_execution: true,
                    limits: HostLimits::default(),
                },
                || true,
            )
            .await;
            assert!(matches!(refused, Err(HostError::DependencyUnavailable)));
            assert_eq!(std::fs::read_dir(&refused_stages).unwrap().count(), 0);
            assert!(session.is_accepting());
            assert_eq!(session.channel().instance, channel.instance);
            assert_eq!(session.channel().child_pid, channel.child_pid);
            assert_eq!(session.channel().scope, channel.scope);
            let after = official::success_payload(
                official::invoke(&mut session, &tool.capability, "query-after", &query).await,
            );
            assert_eq!(
                serde_json::from_str::<Value>(&after.utf8).unwrap(),
                expected
            );

            let review = image.text_review_declaration("text-review").unwrap();
            let rule = review
                .declaration
                .rules
                .iter()
                .find(|rule| rule.rule.id.ends_with(".soundness"))
                .unwrap()
                .rule
                .clone();
            let check = sdk::TextReviewCheckInput {
                profile: review.declaration.profile.clone(),
                source_language: "en".into(),
                target_language: "zh-CN".into(),
                resources: image.text_review_resource_pins("text-review").unwrap(),
                selections: vec![sdk::TextReviewSelection {
                    unit_id: "u-1".into(),
                    source_revision_id: "source-1".into(),
                    source_text: "sound premises".into(),
                    translation_text: Some("前提".into()),
                }],
                requirements: vec![sdk::CheckRequirement {
                    key: sdk::CheckKey {
                        rule,
                        implementation: sdk::CheckImplementation::Plugin {
                            provider: review.checker.provider.clone(),
                        },
                    },
                    input_digest: sdk::payload_digest("captured-text-review-input"),
                    scope_digest: sdk::payload_digest("captured-text-review-scope"),
                    targets: vec!["u-1".into()],
                    mandatory: false,
                    waivable: false,
                    not_applicable: None,
                }],
            };
            image
                .validate_text_review_input("text-review", &check)
                .unwrap();
            let mut checker = official::launch(&image, "check", &check_stages).await;
            let checked = official::success_payload(
                official::invoke(
                    &mut checker,
                    &review.checker,
                    "check-after-unavailable-generation",
                    &json!(check),
                )
                .await,
            );
            let report = sdk::parse_text_review_report(checked.utf8.as_bytes()).unwrap();
            review.validate_report(&check, &report).unwrap();
            let sdk::CheckOutcome::Completed { findings } = &report.results[0].outcome else {
                panic!("deterministic check must remain usable: {report:?}");
            };
            assert_eq!(findings.len(), 1);
            assert_eq!(report.diagnostics[0].suggestion.as_deref(), Some("可靠性"));
            assert_eq!(
                image
                    .resource_bytes(
                        "terminology",
                        &official::contract("org.tsumugi.examples.terminology-resource")
                    )
                    .unwrap(),
                resource
            );
            assert_eq!(image.skill_bytes("concept-review").unwrap(), skill);
            assert_eq!(image.reference_query_ui("reference-query").unwrap(), ui);
            official::close_and_reap(&mut checker).await;
            official::close_and_reap(&mut session).await;
            for directory in [&query_stages, &refused_stages, &check_stages] {
                assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
            }
        });
}
