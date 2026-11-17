// Structural fixture transport through the real Core runtime and Store. This is
// not a domain checker, an installed Host worker, or a native UI acceptance test.
struct PairedProjectionFixture {
    binding: crate::execution::PluginExecutionBinding,
    expected: sdk::TranslationExchange,
}
impl crate::execution::Runner for PairedProjectionFixture {
    fn capability_id(&self) -> &str {
        &self.binding.capability.declaration.contract.id
    }
    fn capability_version(&self) -> &str {
        "1:1"
    }
    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.binding.capability.provider)
    }
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.binding.environment)
    }
    fn run(
        &self,
        request: crate::execution::DispatchRequest,
        _: crate::execution::Cancellation,
        sender: crate::execution::ResultSender,
    ) -> Result<(), ExecutionError> {
        use crate::execution::*;
        let permit = request.plugin_permit().unwrap();
        assert!(permit.matches(&request.input) && permit.is_authorized());
        let selected = &self.binding.capability.provider;
        let channel = sdk::ProviderBinding {
            plugin: selected.plugin.clone(),
            component_id: selected.component_id.clone(),
            contribution_id: selected.contribution_id.clone(),
            package_digest: selected.package_digest.clone(),
            instance_id: ExecutionId::new().to_string(),
            activation_generation: 1,
        };
        let invocation =
            request
                .input
                .plugin_request(request.item_id, request.dispatch_token, &channel)?;
        let output = if request.input.envelope().operation
            == crate::content::TRANSLATION_EXTRACTION_OPERATION
        {
            serde_json::to_value(&self.expected).unwrap()
        } else {
            let check = translation_check_payload(&request.input)?;
            assert_eq!(check.proposal, self.expected);
            assert_eq!(check.input.artifacts, self.expected.artifacts);
            assert!(check.input.paired_source.is_some());
            serde_json::to_value(
                check
                    .requirements
                    .into_iter()
                    .map(|required| sdk::CheckResult {
                        key: required.key,
                        input_digest: required.input_digest,
                        scope_digest: required.scope_digest,
                        covered_targets: required.targets,
                        outcome: sdk::CheckOutcome::Completed { findings: vec![] },
                    })
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        };
        sender.send(FixedResult::capture_plugin(
            &request.input,
            request.item_id,
            request.dispatch_token,
            PluginResultEvidence {
                authorization_id: permit.grant_id(),
                channel: channel.clone(),
                result: sdk::InvocationResult {
                    context: invocation.context,
                    provider: channel,
                    capability: invocation.capability,
                    profile: invocation.profile,
                    result_id: ExecutionId::new().to_string(),
                    outcome: sdk::InvocationOutcome::Succeeded {
                        output: sdk::EncodedPayload::capture(
                            invocation.output_schema,
                            serde_json::to_string(&output).unwrap(),
                        )
                        .unwrap(),
                    },
                },
            },
        )?)
    }
}
fn run_paired_projection(
    runtime: &mut ExecutionRuntime,
    store: &mut ProjectStore,
    input: &FixedInput,
) -> Vec<FixedResult> {
    if input.envelope().plugin.is_some() {
        runtime
            .authorize_plugin(
                store,
                ExecutionId::new(),
                input,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 180_000,
                crate::execution::PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false,
                },
            )
            .unwrap();
    }
    runtime.submit(store, input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        runtime.tick(store).unwrap();
        if !runtime.is_active(input.envelope().attempt_id) {
            return input
                .envelope()
                .items
                .iter()
                .map(|item| {
                    let id = store
                        .execution_current_result(input.envelope().attempt_id, item.item_id)
                        .unwrap()
                        .unwrap();
                    let result = store
                        .execution_result(input.envelope().attempt_id, id)
                        .unwrap();
                    assert_eq!(
                        result.envelope().outcome,
                        ExecutionState::Succeeded,
                        "{:?}",
                        result.envelope().diagnostic
                    );
                    result
                })
                .collect();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn paired_projection_action(
    store: &mut ProjectStore,
    input: &FixedInput,
    row: &TranslationPreviewRow,
    decision: TranslationSelectionDecision,
) -> AdoptionAction {
    let unit = input
        .envelope()
        .units
        .iter()
        .find(|unit| unit.item_ids == [row.item_id])
        .unwrap();
    store
        .prepare_adoption(
            input.envelope().attempt_id,
            unit.unit_id,
            vec![row.result_id],
            serde_json::to_value(TranslationAdoptionConfirmation {
                result_digest: row.result_digest.clone(),
                source_snapshot_id: ExecutionId::parse(input.envelope().settings["sourceSnapshotId"].as_str().unwrap()).unwrap(),
                occurrence_id: row.occurrence_id.unwrap(),
                source_revision_id: row.source_revision_id.unwrap(),
                target_unit_id: row.unit_id.unwrap(),
                expected_selection_id: row
                    .current_selection
                    .as_ref()
                    .map(|selection| selection.event_id),
                decision,
            })
            .unwrap(),
        )
        .unwrap()
}
#[test]
fn paired_projection_store_preserves_file_provenance_proof_and_manual_selection() {
    let (temp, mut store, _) = project_with_source();
    let input = paired_translation_input(&store);
    let (mut material, settings) = crate::content::plugin_translation_input(&input).unwrap();
    material.artifacts = vec![
        sdk::CapturedArtifact::from_bytes(
            "keys".into(),
            "i18n/keys.json".into(),
            "translation".into(),
            b"first second",
        )
        .unwrap(),
        sdk::CapturedArtifact::from_bytes(
            "values".into(),
            "i18n/values.json".into(),
            "translation".into(),
            "一二".as_bytes(),
        )
        .unwrap(),
    ];
    let input = settings
        .fixed_input(
            store.metadata().unwrap().project_id(),
            material.clone(),
            input.envelope().plugin.clone().unwrap(),
        )
        .unwrap();
    let source = |artifact: &str, start, end| sdk::SourceReference {
        artifact_id: artifact.into(),
        range: sdk::SourceRange {
            encoding: sdk::SourceEncoding::RawByte,
            start,
            end,
        },
    };
    let entries = [
        ("first", "一", source("keys", 0, 5), source("values", 0, 3)),
        (
            "second",
            "二",
            source("keys", 6, 12),
            source("values", 3, 6),
        ),
    ]
    .into_iter()
    .enumerate()
    .map(
        |(i, (key, text, display, value))| sdk::ImportedTranslation {
            id: format!("entry-{i}"),
            text: text.into(),
            source: value,
            native_identity: sdk::NativeIdentityEvidence {
                namespace: material.native_scope.namespace.clone(),
                policy: material.native_scope.policy.clone(),
                value: key.into(),
                display: sdk::NativeIdentityDisplay {
                    value: key.into(),
                    source: Some(display),
                },
            },
        },
    )
    .collect::<Vec<_>>();
    let expected = sdk::TranslationExchange {
        profile: material.profile.clone(),
        import_id: material.import_id.clone(),
        source_set_id: material.source_set_id.clone(),
        source_snapshot_id: material.source_snapshot_id.clone(),
        target_language: material.target_language.clone(),
        declared_language: "zh-CN".into(),
        language_evidence: material.language_evidence,
        native_scope: material.native_scope.clone(),
        artifacts: material.artifacts.clone(),
        order: entries.iter().map(|entry| entry.id.clone()).collect(),
        entries,
    };
    let mut runtime = ExecutionRuntime::new(&mut store).unwrap();
    for binding in [input.envelope().plugin.clone().unwrap(), settings.checker] {
        runtime
            .register_read_only(Arc::new(PairedProjectionFixture {
                binding,
                expected: expected.clone(),
            }))
            .unwrap();
    }
    runtime
        .register_read_only(Arc::new(crate::content::TranslationProjectionRunner))
        .unwrap();
    let result = run_paired_projection(&mut runtime, &mut store, &input).remove(0);
    assert!(
        store
            .capture_translation_projection(
                input.envelope().attempt_id,
                result.envelope().result_id
            )
            .is_err()
    );
    let capture = store
        .capture_translation_validation(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let check_input = capture.check_input().clone();
    let checked = run_paired_projection(&mut runtime, &mut store, &check_input).remove(0);
    store
        .commit_translation_validation(capture.prepare(checked).unwrap())
        .unwrap();
    let projected = store
        .capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    assert_eq!(projected.envelope().settings["version"], 2);
    assert!(projected.envelope().settings.get("file").is_none());
    for field in ["files", "entryFiles", "entries"] {
        let mut forged = projected.envelope().clone();
        forged.attempt_id = ExecutionId::new();
        match field {
            "files" => forged.settings[field][1]["logicalPath"] = "i18n/forged.json".into(),
            "entryFiles" => forged.settings[field][0][0] = 0.into(),
            _ => forged.settings[field][0][2] = "forged".into(),
        }
        let forged = FixedInput::capture(forged).unwrap();
        assert!(store.enqueue_execution(&forged).is_err(), "forged {field}");
    }
    run_paired_projection(&mut runtime, &mut store, &projected);
    let preview = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!((preview.total, preview.unique), (2, 2));
    let files = preview.files.as_ref().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(preview.rows[0].entry.artifact_id, files[1].artifact_id);
    assert_eq!(
        preview.rows[0].entry.key_artifact_id,
        Some(files[0].artifact_id)
    );
    let stale = paired_projection_action(
        &mut store,
        &projected,
        &preview.rows[1],
        TranslationSelectionDecision::SelectIfEmpty,
    );
    let row = &preview.rows[1];
    let manual = store
        .save_translation_revision(&SaveTranslationRevision {
            reuse_origin: None,
            project_id: projected.envelope().project_id,
            action_id: ExecutionId::new(),
            unit_id: row.unit_id.unwrap(),
            locale: "zh-CN".into(),
            source_revision_id: row.source_revision_id.unwrap(),
            expected_selection_id: None,
            text: "人工保留".into(),
        })
        .unwrap();
    assert!(
        store
            .adopt_execution(&stale, &TranslationAdoptionHandler)
            .is_err()
    );
    let action = paired_projection_action(
        &mut store,
        &projected,
        &preview.rows[0],
        TranslationSelectionDecision::CandidateOnly,
    );
    let receipt = store
        .adopt_execution(&action, &TranslationAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &TranslationAdoptionHandler)
            .unwrap(),
        receipt
    );
    let history = store
        .translation_history(projected.envelope().project_id, preview.rows[0].unit_id.unwrap(), "zh-CN", 0, 100)
        .unwrap();
    assert!(history.current.is_none());
    assert_eq!(
        history.rows[0].logical_path.as_deref(),
        Some("i18n/values.json")
    );
    assert_eq!(
        history.rows[0].file_digest.as_deref(),
        Some(files[1].sha256.as_str())
    );
    assert_eq!(history.rows[0].artifact_id, Some(files[1].artifact_id));
    let preview = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(preview.rows[1].current_text.as_deref(), Some("人工保留"));
    assert_eq!(preview.rows[1].current_selection.as_ref(), Some(&manual));
    let pending = store
        .capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    runtime.submit(&mut store, &pending).unwrap();
    runtime.revoke_plugin(&mut store, result.envelope().plugin.as_ref().unwrap().authorization_id).unwrap();
    runtime.tick(&mut store).unwrap();
    let pending = store.execution_attempt(pending.envelope().attempt_id, false).unwrap();
    assert_eq!(pending.progress.cancelled, 2);
    assert_eq!(pending.progress.succeeded, 0);
    assert!(store.capture_translation_projection(input.envelope().attempt_id, result.envelope().result_id).is_err());
    // Saved historical preview is still readable; revocation cannot renew execution.
    assert_eq!(store.translation_preview(projected.envelope().attempt_id, 0, 100, None).unwrap(), preview);
    drop(runtime);
    drop(store);
    let mut store = ProjectStore::open(temp.path().join("project")).unwrap();
    let reopened = store
        .translation_preview(projected.envelope().attempt_id, 0, 100, None)
        .unwrap();
    assert_eq!(reopened, preview);
    assert_eq!(
        store
            .execution_input(projected.envelope().attempt_id)
            .unwrap()
            .bytes(),
        projected.bytes()
    );
    assert_eq!(
        store
            .execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap()
            .bytes(),
        result.bytes()
    );
    let counts = translation_counts(&store);
    adopt_source(&mut store, br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"2.0.0","EntryDll":"Example.dll"}"#, br#"{"first":"changed","second":"same"}"#);
    let changed = store.translation_preview(projected.envelope().attempt_id, 0, 100, None).unwrap();
    assert_ne!(changed.current_source_snapshot_id, changed.fixed_source_snapshot_id);
    assert_eq!(changed.source_changed, 2);
    assert_eq!(translation_counts(&store), counts);
}
