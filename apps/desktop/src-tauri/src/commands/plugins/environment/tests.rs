use super::test_support::Fixture;
use super::*;
use std::{collections::BTreeMap, fs, sync::Arc};
use tsumugi_plugin_host::{CapturedNativeRuntime, PackageFile, RuntimeApproval};

fn approval() -> RuntimeApproval {
    RuntimeApproval {
        environment: CapturedNativeRuntime::inspect_current().unwrap().into(),
        origin: runtimes::native_host_origin(),
    }
}
fn native(manifest: &mut sdk::PluginManifest, files: &mut BTreeMap<String, PackageFile>) {
    for component in &mut manifest.components {
        if component.runtime == sdk::RuntimeKind::JavaScript {
            component.runtime = sdk::RuntimeKind::NativeWorker;
            files
                .get_mut(component.entrypoint.as_ref().unwrap())
                .unwrap()
                .executable = true;
        }
    }
}

#[test]
fn domain_compositions_reject_application_components_without_rescoping() {
    for scope in [sdk::ComponentScope::Application] {
        let change = |manifest: &mut sdk::PluginManifest,
                      files: &mut BTreeMap<String, PackageFile>| {
            native(manifest, files);
            for component in &mut manifest.components {
                if component.runtime != sdk::RuntimeKind::Data {
                    component.scope = scope;
                }
            }
        };
        let source = Fixture::new(change);
        source.install();
        let approved = approval();
        source.decide(true, vec![approved.clone()]);
        let mut request = source.request();
        request.environment_digest = approved.environment.digest().unwrap();
        let error = match source.owner.capture_source(&request) {
            Ok(_) => panic!("unsupported source scope accepted"),
            Err(error) => error,
        };
        assert_eq!(error.reason.as_deref(), Some("plugin-binding-invalid"));
        let selected = source.image.source_import("source-profile").unwrap();
        let review = tsumugi_core::content::SourceReviewBinding::capture(
            &selected.review,
            &tsumugi_core::execution::PluginExecutionBinding {
                component_scope: sdk::ComponentScope::Project,
                application_scope: None,
                capability: (&selected.review).checker.clone(),
                profile: Some((&selected.review).declaration.profile.clone()),
                environment: (*(&approved.environment)).clone().into(),
            },
        )
        .unwrap();
        assert!(source.owner.capture_review(&review).is_err());

        let build = Fixture::with_resource(
            Arc::new(ApplicationPlugins::default()),
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/build.manifest.json"
            ),
            "build-profile.json",
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/build.declaration.json"
            ),
            change,
        );
        build.install();
        build.decide(true, vec![approved.clone()]);
        let error = match build.owner.capture_build(&PluginBuildRequest {
            package: build.request().package,
            resource_id: "build-profile".into(),
            environment_digest: approved.environment.digest().unwrap(),
        }) {
            Ok(_) => panic!("unsupported build scope accepted"),
            Err(error) => error,
        };
        assert_eq!(error.reason.as_deref(), Some("plugin-binding-invalid"));

        let translation = Fixture::with_resource(
            Arc::new(ApplicationPlugins::default()),
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.manifest.json"
            ),
            "translation-profile.json",
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.declaration.json"
            ),
            change,
        );
        translation.install();
        translation.decide(true, vec![approved.clone()]);
        assert!(
            translation
                .owner
                .capture_translation(&PluginTranslationRequest {
                    package: translation.request().package,
                    resource_id: "translation-profile".into(),
                    environment_digest: approved.environment.digest().unwrap()
                })
                .is_err()
        );
    }
}

#[test]
fn current_native_host_resolves_source_and_adopted_review_without_node_installation() {
    let fixture = Fixture::new(native);
    fixture.install();
    let approved = approval();
    fixture.decide(true, vec![approved.clone()]);
    let mut request = fixture.request();
    request.environment_digest = approved.environment.digest().unwrap();
    let before = fs::read(fixture.root().join("settings.json")).unwrap();
    let environment = fixture.owner.capture_source(&request).unwrap();
    assert_eq!(
        environment.view().unwrap().environment,
        approved.environment
    );
    assert!(matches!(environment.runtime, RunnerRuntime::Native(_)));
    let review = tsumugi_core::content::SourceReviewBinding::capture(
        &environment.binding.review,
        &tsumugi_core::execution::PluginExecutionBinding {
            component_scope: sdk::ComponentScope::Project,
            application_scope: None,
            capability: (&environment.binding.review).checker.clone(),
            profile: Some((&environment.binding.review).declaration.profile.clone()),
            environment: (*(&environment.runtime.environment())).clone().into(),
        },
    )
    .unwrap();
    assert_eq!(
        fixture
            .owner
            .capture_review(&review)
            .unwrap()
            .view()
            .unwrap()
            .environment,
        approved.environment
    );
    assert!(fixture.owner.inventory().unwrap().runtimes.is_empty());
    assert_eq!(
        fs::read(fixture.root().join("settings.json")).unwrap(),
        before
    );
}

#[test]
fn current_native_host_resolves_build_without_node_installation() {
    let fixture = Fixture::with_resource(
        Arc::new(ApplicationPlugins::default()),
        include_bytes!("../../../../../../../crates/plugin-sdk/tests/fixtures/build.manifest.json"),
        "build-profile.json",
        include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/build.declaration.json"
        ),
        native,
    );
    fixture.install();
    let approved = approval();
    fixture.decide(true, vec![approved.clone()]);
    let request = PluginBuildRequest {
        package: fixture.request().package,
        resource_id: "build-profile".into(),
        environment_digest: approved.environment.digest().unwrap(),
    };
    assert_eq!(
        fixture
            .owner
            .capture_build(&request)
            .unwrap()
            .view()
            .unwrap()
            .environment,
        approved.environment
    );
    assert!(fixture.owner.inventory().unwrap().runtimes.is_empty());
}

#[test]
fn current_native_host_resolves_translation_without_node_installation() {
    let fixture = Fixture::with_resource(
        Arc::new(ApplicationPlugins::default()),
        include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.manifest.json"
        ),
        "translation-profile.json",
        include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.declaration.json"
        ),
        native,
    );
    fixture.install();
    let approved = approval();
    fixture.decide(true, vec![approved.clone()]);
    let request = PluginTranslationRequest {
        package: fixture.request().package,
        resource_id: "translation-profile".into(),
        environment_digest: approved.environment.digest().unwrap(),
    };
    assert_eq!(
        fixture
            .owner
            .capture_translation(&request)
            .unwrap()
            .view()
            .unwrap()
            .environment,
        approved.environment
    );
    assert!(fixture.owner.inventory().unwrap().runtimes.is_empty());
}

#[test]
fn native_approval_cannot_authorize_node_or_another_host_or_origin() {
    for scenario in 0..4 {
        let fixture = Fixture::new(|manifest, files| {
            if scenario != 0 {
                native(manifest, files);
            }
        });
        fixture.install();
        let mut approved = approval();
        if scenario == 1 {
            let mut value = serde_json::to_value(&approved.environment).unwrap();
            value["hostVersion"] = serde_json::json!("0.0.0");
            approved.environment = serde_json::from_value(value).unwrap();
        }
        if scenario == 2 {
            approved.origin.publisher_id = "another-publisher".into();
        }
        fixture.decide(
            true,
            if scenario == 3 {
                vec![]
            } else {
                vec![approved.clone()]
            },
        );
        let mut request = fixture.request();
        request.environment_digest = approved.environment.digest().unwrap();
        let before = fs::read(fixture.root().join("settings.json")).unwrap();
        assert!(fixture.owner.capture_source(&request).is_err());
        assert_eq!(
            fs::read(fixture.root().join("settings.json")).unwrap(),
            before
        );
        assert!(fixture.owner.inventory().unwrap().runtimes.is_empty());
    }
}

#[test]
fn source_cannot_mix_native_and_node_providers_in_one_environment() {
    let fixture = Fixture::new(|manifest, files| {
        let worker = manifest
            .components
            .iter_mut()
            .find(|component| component.runtime == sdk::RuntimeKind::JavaScript)
            .unwrap();
        let mut checker = worker.clone();
        checker.id = "independent-native-checker".into();
        checker.runtime = sdk::RuntimeKind::NativeWorker;
        files
            .get_mut(checker.entrypoint.as_ref().unwrap())
            .unwrap()
            .executable = true;
        let contribution = manifest.contributions.iter_mut().find(|entry| matches!(&entry.contribution, sdk::ContributionKind::Capability { declaration } if declaration.input_schema.id == "tsumugi.source-extraction-check-input")).unwrap();
        contribution.component_id = checker.id.clone();
        manifest.components.push(checker);
    });
    fixture.install();
    let approved = approval();
    fixture.decide(true, vec![approved.clone()]);
    let mut request = fixture.request();
    request.environment_digest = approved.environment.digest().unwrap();
    assert_eq!(
        fixture
            .owner
            .capture_source(&request)
            .err()
            .unwrap()
            .reason
            .as_deref(),
        Some("plugin-binding-invalid")
    );
}

#[test]
fn same_settings_revision_shares_one_epoch_until_immediate_close() {
    let fixture = Fixture::new(|_, _| {});
    let revision = fixture.owner.environment_settings_revision().unwrap();
    let first = fixture
        .owner
        .with_environment_authority(revision, Ok)
        .unwrap();
    let second = fixture
        .owner
        .with_environment_authority(revision, Ok)
        .unwrap();
    fixture
        .owner
        .with_environment_revision(revision, || Ok(()))
        .unwrap();
    assert!(!first.is_requested());
    assert!(!second.is_requested());
    fixture.owner.close();
    assert!(first.is_requested());
    assert!(second.is_requested());
    assert!(
        fixture
            .owner
            .with_environment_authority(revision, Ok)
            .is_err()
    );
}

#[test]
fn close_revokes_settings_epoch_without_waiting_for_manager_operation() {
    use std::{sync::mpsc, thread, time::Duration};
    let fixture = Fixture::new(|_, _| {});
    let revision = fixture.owner.environment_settings_revision().unwrap();
    let owner = fixture.owner.clone();
    let (entered, observed) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let operation = thread::spawn(move || {
        owner
            .with_environment_authority(revision, |cancellation| {
                entered.send(cancellation.clone()).unwrap();
                wait.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .unwrap();
    });
    let original = observed.recv_timeout(Duration::from_secs(3)).unwrap();
    let owner = fixture.owner.clone();
    let (closed, completed) = mpsc::channel();
    let close = thread::spawn(move || {
        owner.close();
        closed.send(()).unwrap();
    });
    let result = completed.recv_timeout(Duration::from_secs(1));
    let revoked_before_manager_release = original.is_requested();
    // Release even on failure, so a regression cannot strand either thread.
    release.send(()).unwrap();
    operation.join().unwrap();
    close.join().unwrap();
    assert!(result.is_ok(), "close waited for the manager operation");
    assert!(revoked_before_manager_release);
    assert!(
        fixture
            .owner
            .with_environment_authority(revision, Ok)
            .is_err()
    );
}

#[test]
fn mixed_native_component_scopes_are_captured_per_source_checker_and_build_role() {
    for checks_attempt in [false, true] {
        let change = |manifest: &mut sdk::PluginManifest,
                      files: &mut BTreeMap<String, PackageFile>| {
            native(manifest, files);
            let components = manifest.components.clone();
            for contribution in &mut manifest.contributions {
                if matches!(
                    contribution.contribution,
                    sdk::ContributionKind::Capability { .. }
                ) {
                    let mut component = components
                        .iter()
                        .find(|component| component.id == contribution.component_id)
                        .unwrap()
                        .clone();
                    component.id = format!("scoped-{}", contribution.id);
                    component.scope = if contribution.id.contains("check") == checks_attempt {
                        sdk::ComponentScope::Attempt
                    } else {
                        sdk::ComponentScope::Project
                    };
                    contribution.component_id = component.id.clone();
                    manifest.components.push(component);
                }
            }
        };
        let source = Fixture::new(change);
        source.install();
        let approved = approval();
        source.decide(true, vec![approved.clone()]);
        let mut request = source.request();
        request.environment_digest = approved.environment.digest().unwrap();
        let captured = source.owner.capture_source(&request).unwrap();
        let producer = captured
            .execution_binding(
                &captured.binding.extractor,
                Some(captured.binding.declaration.profile.clone()),
            )
            .unwrap();
        let checker = captured
            .execution_binding(
                &captured.binding.checker,
                Some(captured.binding.declaration.profile.clone()),
            )
            .unwrap();
        assert_ne!(producer.component_scope, checker.component_scope);
        let review_checker = captured
            .execution_binding(
                &captured.binding.review.checker,
                Some(captured.binding.review.declaration.profile.clone()),
            )
            .unwrap();
        let review = tsumugi_core::content::SourceReviewBinding::capture(
            &captured.binding.review,
            &review_checker,
        )
        .unwrap();
        source.owner.capture_review(&review).unwrap();
        let mut changed = review.clone();
        changed.checker.component_scope =
            if review_checker.component_scope == sdk::ComponentScope::Attempt {
                sdk::ComponentScope::Project
            } else {
                sdk::ComponentScope::Attempt
            };
        assert!(source.owner.capture_review(&changed).is_err());
        let build = Fixture::with_resource(
            Arc::new(ApplicationPlugins::default()),
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/build.manifest.json"
            ),
            "build-profile.json",
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/build.declaration.json"
            ),
            change,
        );
        build.install();
        build.decide(true, vec![approved.clone()]);
        let captured = build
            .owner
            .capture_build(&PluginBuildRequest {
                package: build.request().package,
                resource_id: "build-profile".into(),
                environment_digest: approved.environment.digest().unwrap(),
            })
            .unwrap();
        let builder = captured
            .execution_binding(
                &captured.binding.builder,
                Some(captured.binding.declaration.profile.clone()),
            )
            .unwrap();
        let checker = captured
            .execution_binding(
                &captured.binding.checker,
                Some(captured.binding.declaration.profile.clone()),
            )
            .unwrap();
        assert_ne!(builder.component_scope, checker.component_scope);
        let environment = tsumugi_core::ReleaseBuildEnvironment::new(
            captured.binding.clone(),
            builder.clone(),
            checker.clone(),
        )
        .unwrap();
        assert_eq!(environment.checker(), &checker);
        assert!(
            tsumugi_core::ReleaseBuildEnvironment::new(captured.binding.clone(), checker, builder)
                .is_err()
        );
    }
}
