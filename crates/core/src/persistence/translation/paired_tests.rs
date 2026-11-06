use tsumugi_plugin_sdk as sdk;

fn paired_translation_input(store: &ProjectStore) -> FixedInput {
    let context = store.translation_source_context("zh-CN").unwrap();
    let source = store
        .translation_pair_source("zh-CN", context.source_snapshot_id)
        .unwrap();
    let mut declaration = sdk::parse_translation_import_declaration(include_bytes!(
        "../../../../plugin-sdk/tests/fixtures/translation-import.declaration.json",
    ))
    .unwrap();
    declaration.profile = context.profile.clone();
    declaration.material = None;
    declaration.max_total_bytes = Some(sdk::MAX_EXCHANGE_BYTES as u32);
    declaration.file_sets = Some(vec![sdk::SourceFileSetDeclaration {
        id: "translations".into(),
        display_name: "Translated files".into(),
        role: "translation".into(),
        encoding: sdk::SourceMaterialEncoding::Binary,
        extensions: vec!["json".into()],
        min_files: 1,
        max_files: 2,
        max_bytes: sdk::MAX_EXCHANGE_BYTES as u32,
    }]);
    let mut manifest: sdk::PluginManifest = serde_json::from_slice(include_bytes!(
        "../../../../plugin-sdk/tests/fixtures/translation-import.manifest.json",
    ))
    .unwrap();
    for contribution in &mut manifest.contributions {
        if let sdk::ContributionKind::Capability { declaration } = &mut contribution.contribution {
            declaration.input_schema.schema_version = 3;
            declaration.profiles = vec![context.profile.clone()];
            declaration.limits.max_input_bytes = sdk::MAX_INVOCATION_PAYLOAD_BYTES as u32;
            declaration.limits.max_output_bytes = sdk::MAX_PAIRED_TRANSLATION_RESULT_BYTES as u32;
            if contribution.id == "extract" {
                declaration.output_schema.schema_version = 3;
            }
        }
    }
    let binding = declaration
        .bind(&manifest.validate().unwrap(), &"a".repeat(64))
        .unwrap();
    let selected = |capability| crate::execution::PluginExecutionBinding {
        capability,
        component_scope: sdk::ComponentScope::Project,
        application_scope: None,
        profile: Some(context.profile.clone()),
        environment: sdk::RuntimeEnvironmentDescriptor {
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
        .into(),
    };
    let settings = crate::content::PluginTranslationSettings {
        declaration,
        checker: selected(binding.checker),
    };
    settings
        .fixed_input(
            store.metadata().unwrap().project_id(),
            sdk::TranslationExtractionInput {
                profile: context.profile.clone(),
                import_id: ExecutionId::new().to_string(),
                source_set_id: context.source_set_id.to_string(),
                source_snapshot_id: context.source_snapshot_id.to_string(),
                target_language: "zh-CN".into(),
                language_evidence: sdk::TranslationLanguageEvidence::UserConfirmed,
                native_scope: context.native_scopes[0].clone(),
                artifacts: vec![
                    sdk::CapturedArtifact::from_bytes(
                        ExecutionId::new().to_string(),
                        "i18n/zh.json".into(),
                        "translation".into(),
                        &[0, 255, 1],
                    )
                    .unwrap(),
                ],
                paired_source: Some(source),
            },
            selected(binding.extractor),
        )
        .unwrap()
}

#[test]
fn paired_translation_registration_rejects_rehashed_or_stale_originals_and_preserves_work() {
    let (temp, mut store, _) = project_with_source();
    let generation = ExecutionId::new();
    store.begin_plugin_epoch(generation).unwrap();
    let authorize = |store: &mut ProjectStore, input: &FixedInput, generation: ExecutionId| {
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        store
            .authorize_plugin_input(
                generation,
                ExecutionId::new(),
                input,
                expires,
                crate::execution::PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
                None,
            )
            .unwrap();
    };
    let scope = store.content_scope().unwrap();
    let counts = translation_counts(&store);
    let original = paired_translation_input(&store);
    let (captured, _) = crate::content::plugin_translation_input(&original).unwrap();
    for mutation in 0..8 {
        let mut envelope = original.envelope().clone();
        envelope.attempt_id = ExecutionId::new();
        envelope.task_id = ExecutionId::new();
        let mut input = captured.clone();
        input.import_id = ExecutionId::new().to_string();
        let pair = input.paired_source.as_mut().unwrap();
        match mutation {
            0 => pair.source_language = "ja".into(),
            1 => pair.artifacts.swap(0, 1),
            2 | 5 | 6 => {
                let artifact = &pair.artifacts[0];
                pair.artifacts[0] = artifact.data().into_artifact(
                    if mutation == 2 {
                        "replacement-id".into()
                    } else {
                        artifact.id().into()
                    },
                    if mutation == 5 {
                        "other.json".into()
                    } else {
                        artifact.logical_path().into()
                    },
                    if mutation == 6 {
                        "different-role".into()
                    } else {
                        artifact.role().into()
                    },
                    artifact.sha256().into(),
                );
            }
            3 => {
                let artifact = pair.artifacts[0].as_text_mut().unwrap();
                artifact.utf8.push(' ');
                artifact.sha256 = sdk::payload_digest(&artifact.utf8);
            }
            4 => {
                let artifact = &pair.artifacts[0];
                pair.artifacts[0] = sdk::CapturedArtifact::from_bytes(
                    artifact.id().into(),
                    artifact.logical_path().into(),
                    artifact.role().into(),
                    &artifact.bytes().unwrap(),
                )
                .unwrap();
            }
            _ => input.source_snapshot_id = ExecutionId::new().to_string(),
        }
        input.validate().unwrap();
        envelope.items[0].scope.id = input.import_id.clone();
        envelope.items[0].payload = serde_json::to_value(input).unwrap();
        let changed = FixedInput::capture(envelope).unwrap();
        authorize(&mut store, &changed, generation);
        let failure = store.enqueue_execution(&changed).unwrap_err();
        assert_eq!(
            failure.code,
            ErrorCode::DependencyConflict,
            "mutation {mutation}"
        );
        assert_eq!(
            failure.stage,
            if mutation == 7 {
                "translation-source"
            } else {
                "translation-paired-source"
            }
        );
        assert!(
            store
                .execution_input(changed.envelope().attempt_id)
                .is_err()
        );
    }
    authorize(&mut store, &original, generation);
    store.enqueue_execution(&original).unwrap();
    assert_eq!(
        store
            .execution_input(original.envelope().attempt_id)
            .unwrap()
            .bytes(),
        original.bytes()
    );
    assert_eq!(translation_counts(&store), counts);
    assert_eq!(store.content_scope().unwrap(), scope);
    let old = paired_translation_input(&store);
    adopt_source(&mut store, br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"2.0.0","EntryDll":"Example.dll"}"#, br#"{"first":"changed","second":"same"}"#);
    let next_generation = ExecutionId::new();
    store.begin_plugin_epoch(next_generation).unwrap();
    authorize(&mut store, &old, next_generation);
    assert_eq!(
        store.enqueue_execution(&old).unwrap_err().stage,
        "translation-source"
    );
    assert!(
        store
            .translation_pair_source("zh-CN", scope.current_snapshot.unwrap())
            .is_err()
    );
    assert!(
        store
            .translation_pair_source(
                "fr",
                store.content_scope().unwrap().current_snapshot.unwrap()
            )
            .is_err()
    );
    drop(store);
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .execution_input(original.envelope().attempt_id)
            .unwrap()
            .bytes(),
        original.bytes()
    );
    assert_eq!(translation_counts(&reopened), counts);
}
