use super::*;

fn application_binding() -> PluginExecutionBinding {
    let mut binding = plugin_binding("b");
    binding.component_scope = sdk::ComponentScope::Application;
    binding.application_scope = Some(ApplicationScopeBasis {
        instance_id: ExecutionId::new(),
        activation_generation: 1,
    });
    binding
}
fn lease(binding: &PluginExecutionBinding) -> ApplicationExecutionLease {
    ApplicationExecutionLease::capture(
        binding.clone(),
        true,
        Cancellation::default(),
        Cancellation::default(),
    )
    .unwrap()
}
fn evidence(request: &DispatchRequest, binding: &PluginExecutionBinding) -> FixedResult {
    let provider = &binding.capability.provider;
    let basis = binding.application_scope.as_ref().unwrap();
    let channel = sdk::ProviderBinding {
        plugin: provider.plugin.clone(),
        component_id: provider.component_id.clone(),
        contribution_id: provider.contribution_id.clone(),
        package_digest: provider.package_digest.clone(),
        instance_id: basis.instance_id.to_string(),
        activation_generation: basis.activation_generation,
    };
    let wire = request
        .input
        .plugin_request(request.item_id, request.dispatch_token, &channel)
        .unwrap();
    let result = sdk::InvocationResult {
        context: wire.context.clone(),
        provider: channel.clone(),
        capability: wire.capability,
        profile: wire.profile,
        result_id: ExecutionId::new().to_string(),
        outcome: sdk::InvocationOutcome::Succeeded {
            output: sdk::EncodedPayload::capture(wire.output_schema, "\"answer\"".into()).unwrap(),
        },
    };
    FixedResult::capture_plugin(
        &request.input,
        request.item_id,
        request.dispatch_token,
        PluginResultEvidence {
            authorization_id: request.plugin_permit().unwrap().grant_id(),
            channel,
            result,
        },
    )
    .unwrap()
}
#[test]
fn application_basis_is_required_nullable_and_actual_channel_cannot_choose_it() {
    let project = plugin_binding("b");
    let mut encoded = serde_json::to_value(&project).unwrap();
    assert_eq!(encoded["applicationScope"], serde_json::Value::Null);
    assert_eq!(
        serde_json::from_value::<PluginExecutionBinding>(encoded.clone()).unwrap(),
        project
    );
    encoded.as_object_mut().unwrap().remove("applicationScope");
    assert!(serde_json::from_value::<PluginExecutionBinding>(encoded).is_err());
    let application = application_binding();
    let mut invalid = application.clone();
    invalid.application_scope = None;
    assert!(invalid.validate().is_err());
    invalid = application.clone();
    invalid.component_scope = sdk::ComponentScope::Attempt;
    assert!(invalid.validate().is_err());
    invalid = application.clone();
    invalid
        .application_scope
        .as_mut()
        .unwrap()
        .activation_generation = 0;
    assert!(invalid.validate().is_err());
    let (_temp, store, _runtime, _) = setup();
    let fixed = plugin_input(&store, application.clone());
    let provider = &application.capability.provider;
    let basis = application.application_scope.as_ref().unwrap();
    let mut channel = sdk::ProviderBinding {
        plugin: provider.plugin.clone(),
        component_id: provider.component_id.clone(),
        contribution_id: provider.contribution_id.clone(),
        package_digest: provider.package_digest.clone(),
        instance_id: basis.instance_id.to_string(),
        activation_generation: basis.activation_generation,
    };
    let request = fixed
        .plugin_request(
            fixed.envelope().items[0].item_id,
            ExecutionId::new(),
            &channel,
        )
        .unwrap();
    assert_eq!(request.context.scope_id, basis.instance_id.to_string());
    channel.instance_id = ExecutionId::new().to_string();
    assert_eq!(
        fixed
            .plugin_request(
                fixed.envelope().items[0].item_id,
                ExecutionId::new(),
                &channel
            )
            .unwrap_err()
            .stage,
        "plugin-application-instance"
    );
    channel.instance_id = basis.instance_id.to_string();
    channel.activation_generation += 1;
    assert!(
        fixed
            .plugin_request(
                fixed.envelope().items[0].item_id,
                ExecutionId::new(),
                &channel
            )
            .is_err()
    );
}

#[test]
fn accepted_plugin_start_reconciles_exact_consent_without_restoring_authority() {
    let (temp, mut store, mut runtime, _) = setup();
    let binding = application_binding();
    let application = lease(&binding);
    let (calls, received) = mpsc::channel();
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding, calls)))
        .unwrap();
    let accepted = plugin_input(&store, binding.clone());
    let pending = plugin_input(&store, binding);
    let accepted_grant = ExecutionId::new();
    let pending_grant = ExecutionId::new();
    let expires = plugin_authority::plugin_now_ms().unwrap() + 60_000;
    let explicit = PluginConsent {
        unsandboxed_execution: true,
        application_execution: true,
    };
    let existing = PluginConsent {
        unsandboxed_execution: true,
        application_execution: false,
    };
    for (input, grant, consent) in [
        (&accepted, accepted_grant, explicit),
        (&pending, pending_grant, existing),
    ] {
        runtime
            .authorize_application_plugin(&mut store, grant, input, expires, consent, &application)
            .unwrap();
        assert!(
            store
                .reconcile_plugin_start(
                    grant,
                    input.envelope().attempt_id,
                    input.digest(),
                    expires,
                    consent,
                )
                .unwrap()
                .is_none(),
            "a grant without enqueue is not an accepted start"
        );
    }
    runtime.submit(&mut store, &accepted).unwrap();
    runtime
        .cancel(&mut store, accepted.envelope().task_id, ExecutionId::new())
        .unwrap();
    application.revocation().request();
    assert!(!runtime.has_active_work(&store).unwrap());
    assert!(store.plugin_permit(&accepted).is_err());
    assert!(
        store
            .reconcile_plugin_start(
                accepted_grant,
                accepted.envelope().attempt_id,
                accepted.digest(),
                expires,
                existing,
            )
            .is_err(),
        "the original lifetime flag is also part of pending and historical identity"
    );
    drop(runtime);
    store.close().unwrap();
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    let database = temp.path().join("project/project.sqlite3");
    let original_bytes = std::fs::read(&database).unwrap();
    let snapshot = || {
        rusqlite::Connection::open(&database)
            .unwrap()
            .query_row(
                "SELECT (SELECT count(*) FROM plugin_execution_grants), (SELECT count(*) FROM execution_attempts), (SELECT count(*) FROM execution_items WHERE dispatch_token IS NOT NULL)",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
            )
            .unwrap()
    };
    let original_counts = snapshot();
    for (grant, digest, expiry, consent) in [
        (
            ExecutionId::new(),
            accepted.digest().to_owned(),
            expires,
            explicit,
        ),
        (accepted_grant, "f".repeat(64), expires, explicit),
        (
            accepted_grant,
            accepted.digest().to_owned(),
            expires + 1,
            explicit,
        ),
        (
            accepted_grant,
            accepted.digest().to_owned(),
            expires,
            existing,
        ),
        (
            accepted_grant,
            accepted.digest().to_owned(),
            expires,
            PluginConsent {
                unsandboxed_execution: false,
                application_execution: true,
            },
        ),
    ] {
        assert!(
            reopened
                .reconcile_plugin_start(
                    grant,
                    accepted.envelope().attempt_id,
                    &digest,
                    expiry,
                    consent
                )
                .is_err()
        );
    }
    assert_eq!(
        reopened
            .reconcile_plugin_start(
                accepted_grant,
                accepted.envelope().attempt_id,
                accepted.digest(),
                expires,
                explicit,
            )
            .unwrap()
            .unwrap()
            .bytes(),
        accepted.bytes()
    );
    assert!(
        reopened
            .reconcile_plugin_start(
                pending_grant,
                pending.envelope().attempt_id,
                pending.digest(),
                expires,
                existing
            )
            .unwrap()
            .is_none()
    );
    assert!(
        reopened
            .reconcile_plugin_start(
                pending_grant,
                pending.envelope().attempt_id,
                pending.digest(),
                expires,
                explicit
            )
            .is_err()
    );
    assert!(reopened.plugin_permit(&accepted).is_err());
    assert!(
        reopened
            .execution_dispatch(
                accepted.envelope().attempt_id,
                accepted.envelope().items[0].item_id
            )
            .is_err()
    );
    assert!(!application.is_live());
    assert!(
        received.try_recv().is_err(),
        "data ACK never invokes a runner"
    );
    assert_eq!(
        snapshot(),
        original_counts,
        "data ACK creates no grant, attempt or dispatch"
    );
    assert_eq!(std::fs::read(&database).unwrap(), original_bytes);
}
#[cfg(feature = "wire-schema")]
#[test]
fn application_basis_schema_requires_explicit_null_for_other_scopes() {
    let schema = serde_json::to_value(schemars::schema_for!(PluginExecutionBinding)).unwrap();
    assert!(
        schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "applicationScope")
    );
    let property = &schema["properties"]["applicationScope"];
    assert!(serde_json::to_string(property).unwrap().contains("null"));
}
#[test]
fn application_lease_narrows_results_validation_and_reopen_without_restoring_authority() {
    let (temp, mut store, mut runtime, _) = setup();
    let binding = application_binding();
    let application = lease(&binding);
    let (calls, _) = mpsc::channel();
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding, calls)))
        .unwrap();
    let first = plugin_input(&store, binding.clone());
    let second = plugin_input(&store, binding.clone());
    let expires = plugin_authority::plugin_now_ms().unwrap() + 60_000;
    let consent = PluginConsent {
        unsandboxed_execution: true,
        application_execution: false,
    };
    assert!(
        runtime
            .authorize_plugin(&mut store, ExecutionId::new(), &first, expires, consent)
            .is_err()
    );
    assert!(
        ApplicationExecutionLease::capture(
            binding.clone(),
            false,
            Cancellation::default(),
            Cancellation::default()
        )
        .is_err()
    );
    let first_grant = ExecutionId::new();
    for (input, grant) in [(&first, first_grant), (&second, ExecutionId::new())] {
        runtime
            .authorize_application_plugin(&mut store, grant, input, expires, consent, &application)
            .unwrap();
        runtime.submit(&mut store, input).unwrap();
    }
    let dispatch = |store: &mut ProjectStore, input: &FixedInput| {
        store
            .dispatch_execution_item(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )
            .unwrap()
    };
    let first_request = dispatch(&mut store, &first);
    let second_request = dispatch(&mut store, &second);
    assert!(!first_request.plugin_permit().unwrap().matches(&second));
    let saved = evidence(&first_request, &binding);
    let late = evidence(&second_request, &binding);
    assert!(store.save_execution_result(&saved).unwrap());
    assert!(
        store
            .capture_result_validation(first.envelope().attempt_id, saved.envelope().result_id)
            .is_ok()
    );
    application.revocation().request();
    assert!(!first_request.plugin_permit().unwrap().is_authorized());
    assert!(!second_request.plugin_permit().unwrap().is_authorized());
    assert_eq!(
        store.save_execution_result(&late).unwrap_err().code,
        ErrorCode::Unauthorized
    );
    assert_eq!(
        store
            .capture_result_validation(first.envelope().attempt_id, saved.envelope().result_id)
            .err()
            .unwrap()
            .code,
        ErrorCode::Unauthorized
    );
    assert!(
        !store.save_execution_result(&saved).unwrap(),
        "historical identical delivery is a data-only ACK"
    );
    assert_eq!(
        store
            .execution_result(first.envelope().attempt_id, saved.envelope().result_id)
            .unwrap()
            .bytes(),
        saved.bytes()
    );
    drop(runtime);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .execution_input(first.envelope().attempt_id)
            .unwrap()
            .bytes(),
        first.bytes()
    );
    assert_eq!(
        reopened
            .execution_result(first.envelope().attempt_id, saved.envelope().result_id)
            .unwrap()
            .bytes(),
        saved.bytes()
    );
    assert!(reopened.plugin_permit(&first).is_err());
    assert!(
        reopened
            .execution_dispatch(first.envelope().attempt_id, first_request.item_id)
            .is_err()
    );
    let mut reopened_runtime = ExecutionRuntime::new(&reopened).unwrap();
    let (calls, _) = mpsc::channel();
    reopened_runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding, calls)))
        .unwrap();
    assert!(
        reopened_runtime
            .authorize_application_plugin(
                &mut reopened,
                first_grant,
                &first,
                expires,
                consent,
                &application
            )
            .is_err()
    );
    assert!(
        reopened
            .capture_result_validation(first.envelope().attempt_id, saved.envelope().result_id)
            .is_err()
    );
}
#[test]
fn application_settings_withdrawal_and_runner_retirement_are_exact_and_irreversible() {
    let (_temp, mut store, mut runtime, _) = setup();
    let old = application_binding();
    let mut current = old.clone();
    current.application_scope = Some(ApplicationScopeBasis {
        instance_id: ExecutionId::new(),
        activation_generation: 1,
    });
    let settings = Cancellation::default();
    let old_lease = ApplicationExecutionLease::capture(
        old.clone(),
        true,
        Cancellation::default(),
        settings.clone(),
    )
    .unwrap();
    let current_lease = lease(&current);
    let (calls, _) = mpsc::channel();
    for binding in [&old, &current] {
        runtime
            .register_read_only(Arc::new(SelectedPlugin::new(binding, calls.clone())))
            .unwrap();
    }
    assert_ne!(
        input_key(&plugin_input(&store, old.clone())).unwrap(),
        input_key(&plugin_input(&store, current.clone())).unwrap()
    );
    settings.request();
    assert!(!old_lease.is_live());
    assert!(current_lease.is_live());
    assert!(runtime.retire_application_runner(&store, &old).unwrap());
    let old_input = plugin_input(&store, old);
    let current_input = plugin_input(&store, current);
    let expires = plugin_authority::plugin_now_ms().unwrap() + 60_000;
    let consent = PluginConsent {
        unsandboxed_execution: true,
        application_execution: false,
    };
    assert!(
        runtime
            .authorize_application_plugin(
                &mut store,
                ExecutionId::new(),
                &old_input,
                expires,
                consent,
                &old_lease
            )
            .is_err()
    );
    runtime
        .authorize_application_plugin(
            &mut store,
            ExecutionId::new(),
            &current_input,
            expires,
            consent,
            &current_lease,
        )
        .unwrap();
    assert!(store.plugin_permit(&current_input).unwrap().is_authorized());
}

#[test]
fn translation_and_review_compositions_refuse_valid_application_bindings() {
    use crate::content::{PluginTranslationSettings, SourceReviewBinding};
    fn selected(
        capability: sdk::CapabilityBinding,
        profile: sdk::ContractRef,
    ) -> PluginExecutionBinding {
        let mut execution = plugin_binding("b");
        execution.capability = capability;
        execution.profile = Some(profile);
        execution
    }
    fn application(mut execution: PluginExecutionBinding) -> PluginExecutionBinding {
        execution.component_scope = sdk::ComponentScope::Application;
        execution.application_scope = Some(ApplicationScopeBasis {
            instance_id: ExecutionId::new(),
            activation_generation: 1,
        });
        execution.validate().unwrap();
        execution
    }
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/translation-import.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_translation_import_declaration(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/translation-import.declaration.json"
    ))
    .unwrap();
    let binding = declaration.bind(&manifest, &"a".repeat(64)).unwrap();
    let material: sdk::TranslationExtractionInput = serde_json::from_slice(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/translation-extraction.input.json"
    ))
    .unwrap();
    let producer = selected(binding.extractor.clone(), declaration.profile.clone());
    let checker = selected(binding.checker.clone(), declaration.profile.clone());
    for producer_is_application in [true, false] {
        let settings = PluginTranslationSettings {
            declaration: declaration.clone(),
            checker: if producer_is_application {
                checker.clone()
            } else {
                application(checker.clone())
            },
        };
        let result = settings.fixed_input(
            crate::ProjectId::new_v4(),
            material.clone(),
            if producer_is_application {
                application(producer.clone())
            } else {
                producer.clone()
            },
        );
        assert_eq!(result.unwrap_err().stage, "plugin-composition-scope");
    }
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/review.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_review_declaration(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/review.declaration.json"
    ))
    .unwrap();
    let review = declaration.bind(&manifest, &"a".repeat(64)).unwrap();
    let checker = application(selected(
        review.checker.clone(),
        declaration.profile.clone(),
    ));
    assert_eq!(
        SourceReviewBinding::capture(&review, &checker)
            .unwrap_err()
            .stage,
        "plugin-composition-scope"
    );
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/text-review.manifest.json"
    ))
    .unwrap();
    let declaration = sdk::parse_text_review_declaration(include_bytes!(
        "../../../../../plugin-sdk/tests/fixtures/text-review.declaration.json"
    ))
    .unwrap();
    let review = declaration.bind(&manifest, &"a".repeat(64)).unwrap();
    let checker = application(selected(
        review.checker.clone(),
        declaration.profile.clone(),
    ));
    assert_eq!(
        crate::AdvisoryReviewCheck::capture(&review, &checker, "text-review", vec![], vec![])
            .unwrap_err()
            .stage,
        "plugin-composition-scope"
    );
}

#[test]
fn cancelling_a_project_call_does_not_grant_another_call_or_extend_its_deadline() {
    let (_temp, mut store, mut runtime, _) = setup();
    let binding = application_binding();
    let application = lease(&binding);
    let (calls, _) = mpsc::channel();
    runtime
        .register_read_only(Arc::new(SelectedPlugin::new(&binding, calls)))
        .unwrap();
    let first = plugin_input(&store, binding.clone());
    let second = plugin_input(&store, binding.clone());
    let expires = plugin_authority::plugin_now_ms().unwrap() + 60_000;
    let consent = PluginConsent {
        unsandboxed_execution: true,
        application_execution: false,
    };
    let grant = ExecutionId::new();
    runtime
        .authorize_application_plugin(&mut store, grant, &first, expires, consent, &application)
        .unwrap();
    runtime.submit(&mut store, &first).unwrap();
    let dispatch = store
        .dispatch_execution_item(
            first.envelope().attempt_id,
            first.envelope().items[0].item_id,
        )
        .unwrap();
    let result = evidence(&dispatch, &binding);
    runtime
        .cancel(&mut store, first.envelope().task_id, ExecutionId::new())
        .unwrap();
    assert!(store.save_execution_result(&result).is_err());
    assert!(
        store
            .execution_dispatch(first.envelope().attempt_id, dispatch.item_id)
            .is_err()
    );
    assert!(
        application.is_live(),
        "cancelling one query cannot manufacture or replace the independent instance lease"
    );
    assert!(
        store.plugin_permit(&second).is_err(),
        "a live instance grants no second project invocation"
    );
    assert!(
        runtime
            .authorize_application_plugin(
                &mut store,
                grant,
                &first,
                expires + 1,
                consent,
                &application
            )
            .is_err()
    );
    runtime
        .authorize_application_plugin(
            &mut store,
            ExecutionId::new(),
            &second,
            expires,
            consent,
            &application,
        )
        .unwrap();
    assert!(store.plugin_permit(&second).unwrap().is_authorized());
}
