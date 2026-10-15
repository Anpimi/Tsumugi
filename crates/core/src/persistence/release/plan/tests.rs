use super::*;
use crate::persistence::review::tests::{adopt_source, approve, check, fixture, translate};
use crate::{FallbackWrite, ProjectMetadata, execution::PluginConsent};

mod artifact;

#[test]
fn generic_shared_source_units_project_one_decided_target_for_all_occurrences() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Shared source", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    crate::content::tests::adopt_shared_source_fixture(&mut store);
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let rows = store.review_page(project, "zh-CN", 0, 100).unwrap().rows;
    assert_eq!(rows.len(), 2);
    let units: Vec<_> = rows.iter().map(|t| t.unit_id).collect();
    let basis = ready(&mut store, project, &units, "zh-CN");
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices(),
            &basis,
            &environment(&store),
        )
        .unwrap();
    let plan = ReleasePlan::from_input(&input).unwrap();
    let build = plan.plugin_input("zh-CN").unwrap();
    assert_eq!(build.targets.len(), 2);
    assert_eq!(
        build
            .source
            .units
            .iter()
            .map(|u| u.occurrences.len())
            .sum::<usize>(),
        3
    );
    assert!(build.source.units.iter().any(|u| u.occurrences.len() == 2));
    assert!(!build.source.domain_blocks.is_empty());
    validate_capture(&store, &input).unwrap();
    enqueue_fixture(&mut store, &input);
}

#[test]
fn registration_guard_refuses_local_and_external_changes_after_read_preparation() {
    let (_directory, mut store, project, units) = fixture();
    let basis = ready(&mut store, project, &units, "zh-CN");
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices(),
            &basis,
            &environment(&store),
        )
        .unwrap();
    let prepared = prepare_input(&store, &input).unwrap().unwrap();
    {
        let transaction = store.execution_write().unwrap();
        verify_prepared_input(&transaction, &input, Some(&prepared))
            .unwrap()
            .unwrap();
    }
    translate(
        &mut store,
        project,
        units[0],
        "zh-CN",
        "Later input retained",
    );
    {
        let transaction = store.execution_write().unwrap();
        assert_eq!(
            verify_prepared_input(&transaction, &input, Some(&prepared))
                .err()
                .unwrap()
                .stage,
            "build-capture-changed"
        );
    }
    let basis = ready(&mut store, project, &units, "zh-CN");
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices(),
            &basis,
            &environment(&store),
        )
        .unwrap();
    let prepared = prepare_input(&store, &input).unwrap().unwrap();
    let local_changes = store.connection().unwrap().total_changes();
    let external = Connection::open(store.directory().join("project.sqlite3")).unwrap();
    external.execute("UPDATE project_metadata SET display_name='External update',metadata_revision=metadata_revision+1 WHERE row_id=1", []).unwrap();
    assert_eq!(store.connection().unwrap().total_changes(), local_changes);
    let transaction = store.execution_write().unwrap();
    assert_eq!(
        verify_prepared_input(&transaction, &input, Some(&prepared))
            .err()
            .unwrap()
            .stage,
        "build-capture-changed"
    );
}

fn environment(store: &ProjectStore) -> ReleaseBuildEnvironment {
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let profile = store.source_bundle(snapshot).unwrap().profile;
    let mut declaration: sdk::BuildDeclaration = serde_json::from_slice(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/build.declaration.json"
    ))
    .unwrap();
    declaration.profile = profile.clone();
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/build.manifest.json"
    ))
    .unwrap();
    for contribution in &mut manifest.contributions {
        if let sdk::ContributionKind::Capability { declaration } = &mut contribution.contribution {
            declaration.profiles = vec![profile.clone()];
        }
    }
    let binding = declaration
        .bind(&manifest.validate().unwrap(), &"a".repeat(64))
        .unwrap();
    let environment: sdk::ExecutionEnvironmentDescriptor = sdk::RuntimeEnvironmentDescriptor {
        protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
        platform: sdk::RuntimePlatform {
            operating_system: sdk::RuntimeOperatingSystem::Macos,
            architecture: sdk::RuntimeArchitecture::Aarch64,
        },
        sdk_version: sdk::SDK_VERSION.into(),
        process_protocol: sdk::PROCESS_PROTOCOL,
        profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
        tool_version: "26.10.0".into(),
        tool: sdk::RuntimeArtifactBinding {
            tree_digest: "b".repeat(64),
            entrypoint: "bin/node".into(),
        },
        host: sdk::RuntimeArtifactBinding {
            tree_digest: "c".repeat(64),
            entrypoint: "dist/main.js".into(),
        },
    }
    .into();
    let selected = |capability| PluginExecutionBinding {
        component_scope: sdk::ComponentScope::Project,
        capability,
        profile: Some(binding.declaration.profile.clone()),
        environment: environment.clone(),
    };
    ReleaseBuildEnvironment::new(
        binding.clone(),
        selected(binding.builder.clone()),
        selected(binding.checker.clone()),
    )
    .unwrap()
}
fn choices() -> Vec<PluginBuildLocaleChoice> {
    vec![PluginBuildLocaleChoice {
        locale: "zh-CN".into(),
        output_paths: vec!["locales/zh-CN.txt".into()],
        configuration: vec![],
    }]
}
fn ready(
    store: &mut ProjectStore,
    project: ExecutionId,
    units: &[ExecutionId],
    locale: &str,
) -> String {
    for unit in units {
        let text = format!(
            "決定済み 👩🏽‍💻 {}",
            store
                .review_target(project, *unit, locale)
                .unwrap()
                .source_text
        );
        translate(store, project, *unit, locale, &text);
        check(store, project, *unit, locale);
        approve(store, project, *unit, locale);
    }
    let eligibility = store.review_eligibility(project, &[locale.into()]).unwrap();
    assert!(eligibility.ready);
    eligibility.basis
}
// Only exercise Core grant/ledger state with synthetic metadata. No runner,
// Node process or domain checker is registered or invoked by this helper.
fn enqueue_fixture(store: &mut ProjectStore, input: &FixedInput) {
    let generation = ExecutionId::new();
    let _epoch = store.begin_plugin_epoch(generation).unwrap();
    store
        .authorize_plugin_input(
            generation,
            ExecutionId::new(),
            input,
            crate::execution::plugin_authority::plugin_now_ms().unwrap() + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    store.enqueue_execution(input).unwrap();
}

#[test]
fn captures_core_qualification_and_sends_only_fixed_build_data() {
    let (_directory, mut store, project, units) = fixture();
    let basis = ready(&mut store, project, &units, "zh-CN");
    let build = environment(&store);
    let changes = store.connection().unwrap().total_changes();
    let scope = store.content_scope().unwrap();
    let input = store
        .prepare_plugin_build(project, ExecutionId::new(), &choices(), &basis, &build)
        .unwrap();
    assert_eq!(store.connection().unwrap().total_changes(), changes);
    assert_eq!(store.content_scope().unwrap(), scope);
    let plan = ReleasePlan::from_input(&input).unwrap();
    assert_eq!(plan.locales[0].targets.len(), units.len());
    assert!(
        plan.locales[0]
            .targets
            .iter()
            .all(|t| t.review.current_check.is_some() && t.review.current_decision.is_some())
    );
    assert_eq!(
        plan.policy_version,
        super::super::super::review::POLICY_VERSION
    );
    let minimal = plan.plugin_input("zh-CN").unwrap();
    assert_eq!(minimal.source, plan.source);
    assert_eq!(minimal.output_paths, choices()[0].output_paths);
    let selection = &build.binding.builder.provider;
    let channel = sdk::ProviderBinding {
        plugin: selection.plugin.clone(),
        component_id: selection.component_id.clone(),
        contribution_id: selection.contribution_id.clone(),
        package_digest: selection.package_digest.clone(),
        instance_id: "synthetic-build-instance".into(),
        activation_generation: 1,
    };
    let request = input
        .plugin_request(
            input.envelope().items[0].item_id,
            ExecutionId::new(),
            &channel,
        )
        .unwrap();
    assert_eq!(
        sdk::parse_build_input(request.input.utf8.as_bytes()).unwrap(),
        minimal
    );
    assert_eq!(request.output_schema, sdk::artifact_set_contract());
    assert!(request.max_result_bytes > build.binding.builder.declaration.limits.max_output_bytes);
    let mut substituted = channel;
    substituted.package_digest = "d".repeat(64);
    assert_eq!(
        input
            .plugin_request(
                input.envelope().items[0].item_id,
                ExecutionId::new(),
                &substituted
            )
            .unwrap_err()
            .stage,
        "plugin-provider"
    );
    let object = serde_json::to_value(minimal).unwrap();
    assert!(object.get("eligibilityBasis").is_none() && object.get("review").is_none());
    assert!(
        object["targets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t.as_object().unwrap().len() == 3)
    );
    assert_eq!(input.envelope().units.len(), 1);
    assert_eq!(input.envelope().units[0].item_ids.len(), 1);
    validate_capture(&store, &input).unwrap();
    // Valid generic bytes do not assert a domain-format result or produce Release.
    assert!(store.list_releases(project).unwrap().is_empty());
}

#[test]
fn refuses_missing_approval_qa_and_implicit_source_fallback() {
    let (_directory, mut store, project, units) = fixture();
    let build = environment(&store);
    let basis = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap()
        .basis;
    assert_eq!(
        store
            .prepare_plugin_build(project, ExecutionId::new(), &choices(), &basis, &build)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    for unit in &units {
        translate(&mut store, project, *unit, "zh-CN", "Hello {{name}}");
    }
    let basis = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap()
        .basis;
    assert!(
        store
            .prepare_plugin_build(project, ExecutionId::new(), &choices(), &basis, &build)
            .is_err()
    );
    for unit in &units {
        check(&mut store, project, *unit, "zh-CN");
    }
    let basis = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap()
        .basis;
    assert!(
        store
            .prepare_plugin_build(project, ExecutionId::new(), &choices(), &basis, &build)
            .is_err()
    );
    let (_directory, mut store, project, units) = fixture();
    for unit in units {
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        store
            .allow_source_fallback(&FallbackWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                allow: true,
                expected_fallback_id: None,
                actor: "Reviewer".into(),
                reason: "Keep source explicitly".into(),
            })
            .unwrap();
        check(&mut store, project, unit, "zh-CN");
    }
    let eligibility = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap();
    assert!(eligibility.ready);
    let build = environment(&store);
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices(),
            &eligibility.basis,
            &build,
        )
        .unwrap();
    let plan = ReleasePlan::from_input(&input).unwrap();
    for target in plan.plugin_input("zh-CN").unwrap().targets {
        let source = plan
            .source
            .units
            .iter()
            .find(|u| u.id == target.unit_id)
            .unwrap();
        assert_eq!(target.text, source.text);
    }
}

#[test]
fn original_attempt_reconciles_after_edit_and_reopen_without_new_authority() {
    let (_directory, mut store, project, units) = fixture();
    let basis = ready(&mut store, project, &units, "zh-CN");
    let build = environment(&store);
    let attempt = ExecutionId::new();
    let input = store
        .prepare_plugin_build(project, attempt, &choices(), &basis, &build)
        .unwrap();
    assert_eq!(
        store.enqueue_execution(&input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    enqueue_fixture(&mut store, &input);
    translate(&mut store, project, units[0], "zh-CN", "New edit retained");
    assert!(validate_capture(&store, &input).is_err());
    assert_eq!(
        store
            .prepare_plugin_build(project, attempt, &choices(), &basis, &build)
            .unwrap()
            .bytes(),
        input.bytes()
    );
    assert!(
        store
            .prepare_plugin_build(project, ExecutionId::new(), &choices(), &basis, &build)
            .is_err()
    );
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let mut reopened = ProjectStore::open(path).unwrap();
    let saved = reopened
        .find_plugin_build(project, attempt, &choices(), &basis, &build)
        .unwrap()
        .unwrap();
    assert_eq!(saved.bytes(), input.bytes());
    assert_eq!(
        reopened.enqueue_execution(&input).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        reopened
            .review_target(project, units[0], "zh-CN")
            .unwrap()
            .translation_text
            .as_deref(),
        Some("New edit retained")
    );
}

#[test]
fn ledger_rechecks_qualified_plan_even_when_forged_payload_matches_it() {
    let (_directory, mut store, project, units) = fixture();
    let basis = ready(&mut store, project, &units, "zh-CN");
    let build = environment(&store);
    let input = store
        .prepare_plugin_build(project, ExecutionId::new(), &choices(), &basis, &build)
        .unwrap();
    let mut forged = ReleasePlan::from_input(&input).unwrap();
    forged.locales[0].targets[0].review.translation_text = Some("Forged decided text".into());
    let forged = forged.fixed_input(ExecutionId::new()).unwrap();
    assert!(ReleasePlan::from_input(&forged).is_ok());
    assert_eq!(
        validate_capture(&store, &forged).unwrap_err().stage,
        "build-plan-capture"
    );
    let generation = ExecutionId::new();
    let _epoch = store.begin_plugin_epoch(generation).unwrap();
    store
        .authorize_plugin_input(
            generation,
            ExecutionId::new(),
            &forged,
            crate::execution::plugin_authority::plugin_now_ms().unwrap() + 60_000,
            PluginConsent {
                unsandboxed_execution: true,
            },
        )
        .unwrap();
    assert_eq!(
        store.enqueue_execution(&forged).unwrap_err().stage,
        "build-plan-capture"
    );
    let count: i64 = store
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM execution_attempts WHERE attempt_id=?1",
            [forged.envelope().attempt_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let mut envelope = input.envelope().clone();
    envelope.items[0].payload["targets"][0]["text"] = serde_json::json!("Mismatch");
    assert!(ReleasePlan::from_input(&FixedInput::capture(envelope).unwrap()).is_err());
}

#[test]
fn multi_locale_capture_is_atomic_and_rejects_output_aliases_and_substitution() {
    let (_directory, mut store, project, units) = fixture();
    ready(&mut store, project, &units, "zh-CN");
    ready(&mut store, project, &units, "fr-FR");
    let build = environment(&store);
    let mut choices = choices();
    choices.push(PluginBuildLocaleChoice {
        locale: "fr-FR".into(),
        output_paths: vec!["locales/fr-FR.txt".into()],
        configuration: vec![],
    });
    let basis = store
        .review_eligibility(project, &["zh-CN".into(), "fr-FR".into()])
        .unwrap()
        .basis;
    let input = store
        .prepare_plugin_build(project, ExecutionId::new(), &choices, &basis, &build)
        .unwrap();
    assert_eq!(input.envelope().items.len(), 2);
    assert_eq!(input.envelope().units[0].item_ids.len(), 2);
    enqueue_fixture(&mut store, &input);
    let mut changed = build.clone();
    let sdk::ExecutionEnvironmentDescriptor::Captured(value) =
        &mut changed.builder_execution.environment
    else {
        panic!("Node fixture");
    };
    value.tool.tree_digest = "d".repeat(64);
    assert!(
        store
            .find_plugin_build(
                project,
                input.envelope().attempt_id,
                &choices,
                &basis,
                &changed
            )
            .is_err()
    );
    let mut changed = choices.clone();
    changed[0].output_paths = vec!["different.txt".into()];
    assert!(
        store
            .find_plugin_build(
                project,
                input.envelope().attempt_id,
                &changed,
                &basis,
                &build
            )
            .is_err()
    );
    for bad in [
        "../outside.txt",
        "LOCALes/zh-CN.txt",
        "locales/zh-CN.txt/child.txt",
    ] {
        choices[1].output_paths = vec![bad.into()];
        assert!(
            store
                .prepare_plugin_build(project, ExecutionId::new(), &choices, &basis, &build)
                .is_err(),
            "{bad}"
        );
    }
    assert!(
        store
            .prepare_plugin_build(
                ExecutionId::new(),
                ExecutionId::new(),
                &choices,
                &basis,
                &build
            )
            .is_err()
    );
}

#[test]
fn captures_every_review_page_and_preserves_original_source_result() {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Paged", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let project = ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    let data: BTreeMap<_, _> = (0..101)
        .map(|i| (format!("key-{i}"), format!("Source {i}")))
        .collect();
    adopt_source(&mut store, &serde_json::to_vec(&data).unwrap());
    let first = store.review_page(project, "zh-CN", 0, 100).unwrap();
    let mut units: Vec<_> = first.rows.iter().map(|t| t.unit_id).collect();
    units.extend(
        store
            .review_page(project, "zh-CN", first.next_ordinal.unwrap(), 100)
            .unwrap()
            .rows
            .iter()
            .map(|t| t.unit_id),
    );
    let basis = ready(&mut store, project, &units, "zh-CN");
    let input = store
        .prepare_plugin_build(
            project,
            ExecutionId::new(),
            &choices(),
            &basis,
            &environment(&store),
        )
        .unwrap();
    let plan = ReleasePlan::from_input(&input).unwrap();
    assert_eq!(plan.plugin_input("zh-CN").unwrap().targets.len(), 101);
    assert_eq!(
        plan.source,
        crate::content::validate_output(
            &store.execution_input(plan.source_attempt_id).unwrap(),
            &store
                .execution_result(plan.source_attempt_id, plan.source_result_id)
                .unwrap()
        )
        .unwrap()
        .exchange
    );
}

#[test]
fn build_environment_requires_complete_independent_role_bindings() {
    let (_directory, store, _project, _units) = fixture();
    let mut build = environment(&store);
    build.builder_execution.component_scope = sdk::ComponentScope::Attempt;
    build.checker_execution.component_scope = sdk::ComponentScope::Project;
    build.validate().unwrap();
    assert_ne!(
        build.builder().component_scope,
        build.checker().component_scope
    );
    let bytes = serde_json::to_value(&build).unwrap();
    for field in ["builderExecution", "checkerExecution"] {
        let mut missing = bytes.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ReleaseBuildEnvironment>(missing).is_err());
    }
    let mut changed = build.clone();
    changed.checker_execution.capability = changed.builder_execution.capability.clone();
    assert!(changed.validate().is_err());
    changed = build.clone();
    changed.checker_execution.component_scope = sdk::ComponentScope::Application;
    assert!(changed.validate().is_err());
}
