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
        &environment.runtime.environment(),
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
