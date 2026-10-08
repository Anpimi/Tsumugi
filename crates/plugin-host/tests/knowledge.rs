use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn image(executable: bool) -> PackageImage {
    let manifest = sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: "knowledge".into(),
            version: "0.1.0".into(),
        },
        permissions: vec![],
        components: vec![sdk::ComponentDeclaration {
            id: "reference".into(),
            scope: sdk::ComponentScope::Application,
            runtime: sdk::RuntimeKind::Data,
            entrypoint: None,
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 1000,
                cleanup_timeout_ms: 1000,
            },
        }],
        contributions: vec![
            sdk::ContributionDeclaration {
                id: "terms".into(),
                component_id: "reference".into(),
                contribution: sdk::ContributionKind::Resource {
                    schema: contract("example.terms"),
                    path: "terms.bin".into(),
                },
            },
            sdk::ContributionDeclaration {
                id: "guidance".into(),
                component_id: "reference".into(),
                contribution: sdk::ContributionKind::Skill {
                    path: "guidance.md".into(),
                },
            },
        ],
    };
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([
        (
            "terms.bin".into(),
            PackageFile {
                bytes: vec![0, 255, 1],
                executable,
            },
        ),
        (
            "guidance.md".into(),
            PackageFile {
                bytes: "Guidance grants no permission.\n".as_bytes().to_vec(),
                executable,
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

#[test]
fn generic_resource_and_skill_read_exact_captured_bytes_without_runtime() {
    let image = image(false);
    assert_eq!(
        image
            .resource_bytes("terms", &contract("example.terms"))
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        image.skill_bytes("guidance").unwrap(),
        b"Guidance grants no permission.\n"
    );
    let clone = image.clone();
    drop(image);
    assert_eq!(
        clone
            .resource_bytes("terms", &contract("example.terms"))
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        clone.manifest().manifest().components[0].runtime,
        sdk::RuntimeKind::Data
    );
}

#[test]
fn generic_read_refuses_wrong_kind_identity_behavior_and_executable_content() {
    let image = image(false);
    for (id, schema) in [
        ("missing", contract("example.terms")),
        ("guidance", contract("example.terms")),
        ("terms", contract("example.other")),
        (
            "terms",
            sdk::ContractRef {
                behavior_version: 2,
                ..contract("example.terms")
            },
        ),
        (
            "terms",
            sdk::ContractRef {
                schema_version: 2,
                ..contract("example.terms")
            },
        ),
    ] {
        assert_eq!(
            image.resource_bytes(id, &schema),
            Err(HostError::InvalidContract)
        );
    }
    assert_eq!(image.skill_bytes("terms"), Err(HostError::InvalidContract));
    assert_eq!(
        image.skill_bytes("missing"),
        Err(HostError::InvalidContract)
    );
    let executable = self::image(true);
    assert_eq!(
        executable.resource_bytes("terms", &contract("example.terms")),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        executable.skill_bytes("guidance"),
        Err(HostError::InvalidContract)
    );
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[path = "support/official.rs"]
mod official;

#[cfg(all(unix, feature = "javascript-conformance"))]
#[path = "support/runtime.rs"]
mod runtime_fixture;

#[cfg(all(unix, feature = "javascript-conformance"))]
struct OwnedTemporary(tempfile::TempDir);
#[cfg(all(unix, feature = "javascript-conformance"))]
impl OwnedTemporary {
    fn new() -> Self {
        Self(
            tempfile::Builder::new()
                .prefix("tsumugi-knowledge-")
                .tempdir()
                .unwrap(),
        )
    }
    fn path(&self) -> &std::path::Path {
        self.0.path()
    }
}
#[cfg(all(unix, feature = "javascript-conformance"))]
impl Drop for OwnedTemporary {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        // The installation store seals its owned objects. Restore directory
        // write permission only inside this synthetic fixture before TempDir
        // removes it; do not traverse a link or touch a selected package tree.
        fn writable(path: &std::path::Path) {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return;
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            for child in std::fs::read_dir(path).unwrap() {
                writable(&child.unwrap().path());
            }
        }
        writable(self.path());
    }
}

#[cfg(all(unix, feature = "javascript-conformance"))]
#[test]
fn actual_knowledge_package_reopens_resources_and_runs_original_query_and_check_workers() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let temporary = OwnedTemporary::new();
        let image = official::installed(temporary.path(), "philosophy");
        let resource = image.resource_bytes("terminology", &contract("org.tsumugi.examples.terminology-resource")).unwrap();
        let body: serde_json::Value = serde_json::from_slice(resource).unwrap();
        assert_eq!(body["authority"], "unadopted-editorial-suggestion");
        assert!(std::str::from_utf8(image.skill_bytes("concept-review").unwrap()).unwrap().contains("grants no tools"));
        let tool = image.capability_tool("agent-query-tool").unwrap();
        assert_eq!(tool.declaration.capability_id, "query");
        assert_eq!(tool.declaration.supporting_resources, vec!["terminology"]);
        assert_eq!(tool.declaration.skill.as_deref(), Some("concept-review"));
        let pin = serde_json::json!({"id":body["id"], "revision":body["revision"], "sha256":sdk::payload_digest(std::str::from_utf8(resource).unwrap())});
        let query = serde_json::json!({"resource":pin, "sourceLanguage":"en", "targetLanguage":"zh-CN",
            "queries":[{"id":"u-1", "text":"👩🏽‍💻 e\u{301} sound premises", "conceptIds":["soundness", "premise"]}]});
        let mut session = official::launch(&image, "query", temporary.path()).await;
        let binding = tool.capability;
        assert_eq!(binding, sdk::bind_capability(image.manifest(), "query", image.package_digest()).unwrap());
        let first_pid = session.channel().child_pid;
        let output = official::success_payload(official::invoke(&mut session, &binding, "query-1", &query).await);
        let output: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
        assert_eq!(output["basis"]["resource"], pin);
        assert_eq!(output["results"][0]["entries"][0]["preferredTarget"], "可靠性");
        assert_eq!(output["results"][0]["entries"][1]["preferredTarget"], "前提");
        let mut missing = query.clone(); missing["queries"][0]["text"] = "soundtrack".into();
        let empty = official::success_payload(official::invoke(&mut session, &binding, "query-empty", &missing).await);
        let empty: serde_json::Value = serde_json::from_str(&empty.utf8).unwrap();
        assert_eq!(empty["results"][0]["entries"], serde_json::json!([]));
        assert_ne!(empty["basis"]["querySha256"], output["basis"]["querySha256"]);
        let mut changed = query.clone(); changed["resource"]["revision"] = "other".into();
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut session, &binding, "query-replaced", &changed).await else { panic!("replaced resource accepted") };
        assert_eq!(serde_json::from_str::<serde_json::Value>(&error.utf8).unwrap(), serde_json::json!({"code":"resource-mismatch"}));
        let closed = session.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);

        let mut checker = official::launch(&image, "check", temporary.path()).await;
        assert_ne!(checker.channel().child_pid, first_pid);
        let review = image.text_review_declaration("text-review").unwrap();
        let binding = review.checker.clone();
        assert_eq!(binding.declaration.contract.schema_version, 2);
        assert_eq!(binding.declaration.contract.behavior_version, 2);
        assert_eq!(review.declaration.disposition, sdk::TextReviewDisposition::Advisory);
        let rule = review.declaration.rules.iter().find(|rule| rule.rule.id.ends_with(".soundness")).unwrap().rule.clone();
        let mut input = sdk::TextReviewCheckInput {
            profile: review.declaration.profile.clone(),
            source_language: "en".into(),
            target_language: "zh-CN".into(),
            resources: image.text_review_resource_pins("text-review").unwrap(),
            selections: vec![
                sdk::TextReviewSelection { unit_id: "u-1".into(), source_revision_id: "source-1".into(),
                    source_text: "sound premises".into(), translation_text: Some("👩🏽‍💻 e\u{301} 前提".into()) },
                sdk::TextReviewSelection { unit_id: "u-2".into(), source_revision_id: "source-2".into(),
                    source_text: "audio soundtrack".into(), translation_text: Some("原样文本".into()) },
            ],
            requirements: vec![sdk::CheckRequirement {
                key: sdk::CheckKey { rule, implementation: sdk::CheckImplementation::Plugin { provider: binding.provider.clone() } },
                input_digest: sdk::payload_digest("captured-text-review-input"),
                scope_digest: sdk::payload_digest("captured-text-review-scope"),
                targets: vec!["u-1".into(), "u-2".into()], mandatory: false, waivable: false, not_applicable: None,
            }],
        };
        image.validate_text_review_input("text-review", &input).unwrap();
        let received = official::invoke_received(&mut checker, &binding, "check-1", &serde_json::to_value(&input).unwrap()).await;
        assert_eq!(received.channel().provider.selection(), binding.provider);
        let output = official::success_payload(received.result().outcome.clone());
        assert_eq!(output.schema, sdk::text_review_report_contract());
        let report = sdk::parse_text_review_report(output.utf8.as_bytes()).unwrap();
        review.validate_report(&input, &report).unwrap();
        assert_eq!(report.results.len(), 1);
        assert_eq!(report.results[0].covered_targets, vec!["u-1", "u-2"]);
        let sdk::CheckOutcome::Completed { findings } = &report.results[0].outcome else { panic!("expected completed advisory check") };
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].target, "u-1");
        assert_eq!(findings[0].severity, sdk::FindingSeverity::Warning);
        assert_eq!(report.diagnostics.len(), 1);
        assert_eq!(report.diagnostics[0].suggestion.as_deref(), Some("可靠性"));
        assert_eq!(report.diagnostics[0].resource_entry.as_ref().unwrap().entry_id, "soundness");
        let location = report.diagnostics[0].location.as_ref().unwrap();
        assert_eq!(location.field, sdk::TextReviewField::Translation);
        assert_eq!(location.range, sdk::TextRange { encoding: sdk::TextEncoding::Utf16, start: 0,
            end: input.selections[0].translation_text.as_ref().unwrap().encode_utf16().count() as u32 });

        let mut forged = input.clone();
        let sdk::CheckImplementation::Plugin { provider } = &mut forged.requirements[0].key.implementation else { unreachable!() };
        provider.package_digest = "a".repeat(64);
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut checker, &binding, "check-forged-provider", &serde_json::to_value(&forged).unwrap()).await else { panic!("payload provider claim accepted") };
        assert_eq!(error.schema, sdk::review_check_error_contract());
        sdk::parse_review_check_error(error.utf8.as_bytes()).unwrap();
        let mut wrong_resource = input.clone();
        wrong_resource.resources[0].sha256 = "a".repeat(64);
        assert_eq!(image.validate_text_review_input("text-review", &wrong_resource), Err(HostError::InvalidContract));
        let sdk::InvocationOutcome::Failed { error } = official::invoke(&mut checker, &binding, "check-forged-resource", &serde_json::to_value(&wrong_resource).unwrap()).await else { panic!("payload resource claim accepted") };
        sdk::parse_review_check_error(error.utf8.as_bytes()).unwrap();

        input.selections.truncate(1);
        input.selections[0].translation_text = None;
        input.requirements[0].targets = vec!["u-1".into()];
        let output = official::success_payload(official::invoke(&mut checker, &binding, "check-missing", &serde_json::to_value(&input).unwrap()).await);
        let report = sdk::parse_text_review_report(output.utf8.as_bytes()).unwrap();
        review.validate_report(&input, &report).unwrap();
        assert_eq!(report.results[0].outcome, sdk::CheckOutcome::Unavailable);
        assert!(report.diagnostics.is_empty());
        input.requirements[0].not_applicable = Some(sdk::NotApplicableBasis {
            code: sdk::MISSING_REVIEW_TRANSLATION.into(), basis_digest: sdk::payload_digest("captured-missing-translation"),
        });
        let output = official::success_payload(official::invoke(&mut checker, &binding, "check-captured-na", &serde_json::to_value(&input).unwrap()).await);
        let report = sdk::parse_text_review_report(output.utf8.as_bytes()).unwrap();
        review.validate_report(&input, &report).unwrap();
        assert_eq!(report.results[0].outcome, sdk::CheckOutcome::NotApplicable { basis: input.requirements[0].not_applicable.clone().unwrap() });
        assert!(report.diagnostics.is_empty());
        let closed = checker.close().await;
        assert!(closed.cooperative_acknowledgement && closed.direct_child_reaped);
        assert_eq!(image.resource_bytes("terminology", &contract("org.tsumugi.examples.terminology-resource")).unwrap(), resource);
    });
}

#[cfg(all(unix, feature = "javascript-conformance"))]
mod version_compatibility {
    use super::{OwnedTemporary, contract, official, runtime_fixture};
    use std::{cell::Cell, path::PathBuf};
    use tsumugi_plugin_host::{CapturedRuntime, HostError, PackageImage, catalog::*};
    use tsumugi_plugin_sdk as sdk;

    fn upgrade(root: &std::path::Path, variant: &str, version: &str) -> PackageImage {
        let source = PathBuf::from(
            std::env::var_os(format!("TSUMUGI_TEST_{}_PACKAGE", variant.to_uppercase()))
                .expect("explicit controlled upgrade package required"),
        );
        let digest = std::env::var(format!("TSUMUGI_TEST_{}_DIGEST", variant.to_uppercase()))
            .expect("exact controlled upgrade digest required");
        let image = official::installed_from(root, &source, &digest, "philosophy");
        assert_eq!(image.manifest().manifest().plugin.version, version);
        image
    }

    fn catalog(images: &[&PackageImage]) -> PackageCatalog {
        let mut catalog = PackageCatalog::new();
        for image in images {
            let plugin = image.manifest().manifest().plugin.clone();
            catalog
                .register(
                    (*image).clone(),
                    PackageApproval {
                        plugin: plugin.clone(),
                        package_digest: image.package_digest().into(),
                        origin: PackageOrigin {
                            source_id: "explicit-official-test".into(),
                            publisher_id: "reviewed-public-source".into(),
                        },
                    },
                )
                .unwrap();
            catalog.set_enabled(&plugin, true).unwrap();
        }
        catalog
    }

    fn choice(image: &PackageImage) -> sdk::ProviderKey {
        sdk::ProviderKey {
            plugin: image.manifest().manifest().plugin.clone(),
            contribution_id: "query".into(),
        }
    }

    async fn query(
        image: &PackageImage,
        staging: &std::path::Path,
        text: &str,
    ) -> serde_json::Value {
        let tool = image.capability_tool("agent-query-tool").unwrap();
        let mut input = tool
            .declaration
            .query
            .as_ref()
            .unwrap()
            .input_template
            .clone();
        input["queries"][0]["text"] = text.into();
        input["queries"][0]["conceptIds"] = serde_json::json!(["soundness"]);
        let mut session = official::launch(image, "query", staging).await;
        // Valid JSON and positive version numbers still cannot cross the actual
        // captured channel's independent capability/profile/data identities.
        for axis in ["contract", "profile", "input", "output"] {
            let mut wrong = official::request_for(&session, &tool.capability, axis, &input);
            match axis {
                "contract" => wrong.capability.behavior_version += 1,
                "profile" => wrong.profile.as_mut().unwrap().behavior_version += 1,
                "input" => wrong.input.schema.schema_version += 1,
                "output" => wrong.output_schema.schema_version += 1,
                _ => unreachable!(),
            }
            wrong.validate().unwrap();
            assert_eq!(
                session.invoke(&wrong, || false, || true).await.unwrap_err(),
                HostError::RequestMismatch
            );
            assert!(session.is_accepting());
        }
        let output = official::success_payload(
            official::invoke(
                &mut session,
                &tool.capability,
                "exact-compatible-query",
                &input,
            )
            .await,
        );
        assert_eq!(output.schema, tool.capability.declaration.output_schema);
        let output: serde_json::Value = serde_json::from_str(&output.utf8).unwrap();
        assert_eq!(output["basis"]["resource"], input["resource"]);
        assert_eq!(
            output["basis"]["querySha256"],
            sdk::payload_digest(&input.to_string())
        );
        assert!(output["basis"]["coverage"].is_string());
        assert_eq!(output["results"][0]["id"], input["queries"][0]["id"]);
        assert!(output["results"][0]["entries"].is_array());
        for entry in output["results"][0]["entries"].as_array().unwrap() {
            assert!(entry["conceptId"].is_string());
            assert!(entry["preferredTarget"].is_string());
            assert!(entry["note"].is_string());
        }
        official::close_and_reap(&mut session).await;
        output
    }

    #[test]
    fn actual_query_behavior_upgrade_keeps_types_but_requires_its_own_contract() {
        let original_root = OwnedTemporary::new();
        let upgrade_root = OwnedTemporary::new();
        let staging = OwnedTemporary::new();
        let original = official::installed(original_root.path(), "philosophy");
        let upgraded = upgrade(upgrade_root.path(), "behavior", "0.1.0-alpha.2");
        let old = original.capability_tool("agent-query-tool").unwrap();
        let new = upgraded.capability_tool("agent-query-tool").unwrap();
        assert_eq!(old.capability.declaration.contract.behavior_version, 1);
        assert_eq!(new.capability.declaration.contract.behavior_version, 2);
        assert_eq!(old.capability.declaration.contract.schema_version, 1);
        assert_eq!(new.capability.declaration.contract.schema_version, 1);
        assert_eq!(
            old.capability.declaration.input_schema,
            new.capability.declaration.input_schema
        );
        assert_eq!(
            old.capability.declaration.output_schema,
            new.capability.declaration.output_schema
        );
        assert_eq!(old.declaration.profile, new.declaration.profile);
        assert_eq!(old.declaration.query, new.declaration.query);
        for images in [[&original, &upgraded], [&upgraded, &original]] {
            let catalog = catalog(&images);
            for (current, other, binding) in
                [(&original, &upgraded, &old), (&upgraded, &original, &new)]
            {
                let selected = catalog
                    .resolve(
                        &binding.capability.declaration.contract,
                        binding.declaration.profile.as_ref(),
                        sdk::ProviderSelection::Single,
                        &[],
                    )
                    .unwrap();
                assert_eq!(selected.len(), 1);
                assert_eq!(
                    selected[0].binding().provider.plugin,
                    choice(current).plugin
                );
                assert_eq!(
                    catalog
                        .resolve(
                            &binding.capability.declaration.contract,
                            binding.declaration.profile.as_ref(),
                            sdk::ProviderSelection::Single,
                            &[choice(other)]
                        )
                        .unwrap_err(),
                    CatalogError::NoCompatibleProvider
                );
            }
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                // Independent literal oracle: v1 uses Unicode word boundaries;
                // the controlled v2 intentionally uses case-sensitive substrings.
                let before = query(&original, staging.path(), "👩🏽‍💻 é soundtrack").await;
                let after = query(&upgraded, staging.path(), "👩🏽‍💻 é soundtrack").await;
                assert_eq!(before["results"][0]["entries"], serde_json::json!([]));
                assert_eq!(after["results"][0]["entries"].as_array().unwrap().len(), 1);
                assert_eq!(after["results"][0]["entries"][0]["conceptId"], "soundness");
                assert_eq!(
                    after["results"][0]["entries"][0]["preferredTarget"],
                    "可靠性"
                );
                assert_ne!(before["basis"]["coverage"], after["basis"]["coverage"]);
            });
    }

    #[test]
    fn actual_profile_and_data_schema_upgrades_do_not_follow_package_semver() {
        let original_root = OwnedTemporary::new();
        let profile_root = OwnedTemporary::new();
        let schema_root = OwnedTemporary::new();
        let staging = OwnedTemporary::new();
        let original = official::installed(original_root.path(), "philosophy");
        let profile = upgrade(profile_root.path(), "profile", "0.1.0-alpha.3");
        let schema = upgrade(schema_root.path(), "schema", "0.1.0-alpha.4");
        let original_tool = original.capability_tool("agent-query-tool").unwrap();
        let profile_tool = profile.capability_tool("agent-query-tool").unwrap();
        let schema_tool = schema.capability_tool("agent-query-tool").unwrap();
        assert_eq!(
            profile_tool.capability.declaration.contract,
            original_tool.capability.declaration.contract
        );
        assert_eq!(
            profile_tool.capability.declaration.input_schema,
            original_tool.capability.declaration.input_schema
        );
        assert_eq!(
            profile_tool
                .declaration
                .profile
                .as_ref()
                .unwrap()
                .behavior_version,
            2
        );
        assert_eq!(
            schema_tool.declaration.profile,
            original_tool.declaration.profile
        );
        assert_eq!(
            schema_tool.capability.declaration.contract.behavior_version,
            1
        );
        assert_eq!(
            schema_tool.capability.declaration.contract.schema_version,
            2
        );
        assert_eq!(
            schema_tool
                .capability
                .declaration
                .input_schema
                .schema_version,
            2
        );
        assert_eq!(
            schema_tool
                .capability
                .declaration
                .output_schema
                .schema_version,
            2
        );
        let resource = contract("org.tsumugi.examples.terminology-resource");
        assert_eq!(
            original.resource_bytes("terminology", &resource).unwrap(),
            profile.resource_bytes("terminology", &resource).unwrap()
        );
        assert_eq!(
            schema.resource_bytes("terminology", &resource),
            Err(HostError::InvalidContract)
        );
        assert_eq!(
            original.resource_bytes("terminology", &resource).unwrap(),
            schema
                .resource_bytes(
                    "terminology",
                    &sdk::ContractRef {
                        schema_version: 2,
                        ..resource
                    }
                )
                .unwrap()
        );
        for images in [
            [&original, &profile, &schema],
            [&schema, &profile, &original],
        ] {
            let catalog = catalog(&images);
            for (image, binding) in [
                (&original, &original_tool),
                (&profile, &profile_tool),
                (&schema, &schema_tool),
            ] {
                let selected = catalog
                    .resolve(
                        &binding.capability.declaration.contract,
                        binding.declaration.profile.as_ref(),
                        sdk::ProviderSelection::Single,
                        &[],
                    )
                    .unwrap();
                assert_eq!(selected.len(), 1);
                assert_eq!(selected[0].binding().provider.plugin, choice(image).plugin);
            }
            for image in [&profile, &schema] {
                assert_eq!(
                    catalog
                        .resolve(
                            &original_tool.capability.declaration.contract,
                            original_tool.declaration.profile.as_ref(),
                            sdk::ProviderSelection::Single,
                            &[choice(image)]
                        )
                        .unwrap_err(),
                    CatalogError::NoCompatibleProvider
                );
            }
        }
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                for image in [&original, &profile, &schema] {
                    let output = query(image, staging.path(), "👩🏽‍💻 é sound premises").await;
                    assert_eq!(output["results"][0]["entries"].as_array().unwrap().len(), 1);
                    assert_eq!(
                        output["results"][0]["entries"][0]["preferredTarget"],
                        "可靠性"
                    );
                }
            });
    }

    #[test]
    fn captured_runtime_diagnoses_sdk_and_process_versions_independently_of_payload_types() {
        let runtime = runtime_fixture::approved_runtime();
        let descriptor = runtime.descriptor();
        assert_eq!(descriptor.sdk_version, sdk::SDK_VERSION);
        assert_eq!(descriptor.process_protocol, sdk::PROCESS_PROTOCOL);
        let tool = PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").unwrap());
        let host = PathBuf::from(std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").unwrap());
        for axis in ["sdk", "process"] {
            let mut unsupported = descriptor.clone();
            match axis {
                "sdk" => unsupported.sdk_version = "0.1.0-alpha.2".into(),
                "process" => unsupported.process_protocol = 1,
                _ => unreachable!(),
            }
            // A structurally valid description is not a compatible runtime.
            let decoded: sdk::RuntimeEnvironmentDescriptor =
                serde_json::from_slice(&serde_json::to_vec(&unsupported).unwrap()).unwrap();
            let error = decoded.validate().unwrap_err();
            assert_eq!(error.code, sdk::ContractErrorCode::UnsupportedProtocol);
            assert_eq!(error.field, "environment.protocol");
            let read_guard_called = Cell::new(false);
            assert_eq!(
                CapturedRuntime::capture_directories(&tool, &host, &decoded, || {
                    read_guard_called.set(true);
                    true
                })
                .unwrap_err(),
                HostError::InvalidContract
            );
            assert!(!read_guard_called.get());
        }
        assert_eq!(descriptor.sdk_version, sdk::SDK_VERSION);
        assert_eq!(descriptor.process_protocol, 2);
    }
}
