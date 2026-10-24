use tsumugi_plugin_sdk::*;

fn binding() -> ServiceBinding {
    serde_json::from_slice(include_bytes!("fixtures/service.binding.json")).unwrap()
}
fn invocation() -> InvocationRequest {
    let exchange = parse_exchange(include_bytes!("fixtures/invocation.request.json")).unwrap();
    let ExchangeBody::Request(request) = exchange.document().body.clone() else {
        panic!("request fixture")
    };
    request
}
fn request() -> ServiceRequest {
    let binding = binding();
    ServiceRequest {
        call_id: "service-call-a".into(),
        handle_id: binding.handle_id,
        context: invocation().context,
        input: EncodedPayload::capture(binding.input_schema, "{\"units\":[\"unit-a\"]}".into())
            .unwrap(),
    }
}
fn response(kind: usize) -> ServiceResponse {
    let binding = binding();
    let request = request();
    let payload = EncodedPayload::capture(
        if kind == 0 {
            binding.output_schema
        } else {
            binding.error_schema
        },
        "{\"receipt\":\"child-a\"}".into(),
    )
    .unwrap();
    ServiceResponse {
        call_id: request.call_id,
        handle_id: request.handle_id,
        context: request.context,
        outcome: match kind {
            0 => InvocationOutcome::Succeeded { output: payload },
            1 => InvocationOutcome::Failed { error: payload },
            _ => InvocationOutcome::Unknown { error: payload },
        },
    }
}
fn activation(services: Vec<ServiceBinding>) -> ProcessActivation {
    let invocation = invocation();
    ProcessActivation {
        instance: invocation.provider.instance(),
        capabilities: vec![ProcessCapability {
            contribution_id: invocation.provider.contribution_id,
            capability: CapabilityDeclaration {
                contract: invocation.capability,
                input_schema: invocation.input.schema,
                output_schema: invocation.output_schema,
                error_schema: invocation.error_schema,
                profiles: vec![invocation.profile.unwrap()],
                effect: EffectKind::Proposal,
                permissions: vec![PermissionRequest::ProjectService {
                    contract: binding().contract,
                }],
                limits: binding().limits,
            },
        }],
        services,
    }
}

#[test]
fn service_context_preserves_outer_digest_and_checks_independent_payload_bytes() {
    let binding = binding();
    let request = request();
    assert_ne!(request.context.input_digest, request.input.sha256);
    request
        .validate_against(&binding, &invocation().context)
        .unwrap();
    let frame = ProcessFrame::new(ProcessBody::ServiceRequest(request.clone()))
        .encode()
        .unwrap();
    assert_eq!(
        parse_process_frame(&frame).unwrap().body,
        ProcessBody::ServiceRequest(request.clone())
    );
    let mut wrong = request.clone();
    wrong.context.input_digest = wrong.input.sha256.clone();
    assert_eq!(
        wrong
            .validate_against(&binding, &invocation().context)
            .unwrap_err()
            .code,
        ContractErrorCode::ResultMismatch
    );
    let mut corrupt = request;
    corrupt.input.utf8.push(' ');
    assert_eq!(
        corrupt.validate().unwrap_err().code,
        ContractErrorCode::ResultMismatch
    );
}

#[test]
fn service_binding_rejects_invalid_id_generation_digest_and_limits() {
    binding().validate().unwrap();
    for change in 0..10 {
        let mut invalid = binding();
        match change {
            0 => invalid.handle_id.clear(),
            1 => invalid.provider_id = "example..provider".into(),
            2 => invalid.activation_generation = 0,
            3 => invalid.configuration_digest = "A".repeat(64),
            4 => invalid.contract.behavior_version = 0,
            5 => invalid.limits.max_input_bytes = 0,
            6 => invalid.limits.max_output_bytes = MAX_INVOCATION_PAYLOAD_BYTES as u32 + 1,
            7 => invalid.limits.concurrency = 2,
            8 => invalid.limits.timeout_ms = 0,
            _ => invalid.scope_id = "wrong scope".into(),
        }
        assert!(invalid.validate().is_err(), "change {change}");
    }
}

#[test]
fn activation_services_are_required_bounded_and_unique_by_handle_and_provider_contract() {
    let original = activation(vec![binding()]);
    original.validate().unwrap();
    let frame = ProcessFrame::new(ProcessBody::Activate(original.clone()))
        .encode()
        .unwrap();
    assert_eq!(
        parse_process_frame(&frame).unwrap().body,
        ProcessBody::Activate(original)
    );
    assert_eq!(
        validate_service_bindings(&vec![binding(); MAX_SERVICE_BINDINGS + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
    let mut second = binding();
    second.provider_id = "example.other-provider".into();
    assert_eq!(
        validate_service_bindings(&[binding(), second])
            .unwrap_err()
            .code,
        ContractErrorCode::DuplicateIdentity
    );
    let mut second = binding();
    second.handle_id = "service-handle-b".into();
    assert_eq!(
        validate_service_bindings(&[binding(), second.clone()])
            .unwrap_err()
            .code,
        ContractErrorCode::DuplicateIdentity
    );
    second.contract.id = "example.other-service".into();
    validate_service_bindings(&[binding(), second]).unwrap();
    let mut missing =
        serde_json::to_value(ProcessFrame::new(ProcessBody::Activate(activation(vec![])))).unwrap();
    missing["body"]["data"]
        .as_object_mut()
        .unwrap()
        .remove("services");
    assert_eq!(
        parse_process_frame(&serde_json::to_vec(&missing).unwrap())
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );
    let mut old = ProcessFrame::new(ProcessBody::Activate(activation(vec![])));
    old.protocol_version = 2;
    assert_eq!(
        old.validate().unwrap_err().code,
        ContractErrorCode::UnsupportedProtocol
    );
}

#[test]
fn service_request_requires_exact_scope_context_schema_handle_and_byte_limit() {
    let binding = binding();
    for change in 0..6 {
        let mut invalid = request();
        match change {
            0 => invalid.handle_id = "other-handle".into(),
            1 => invalid.context.project_id = "other-project".into(),
            2 => invalid.context.scope_id = "other-scope".into(),
            3 => invalid.context.attempt_id = "other-attempt".into(),
            4 => invalid.input.schema.schema_version += 1,
            _ => {
                invalid.input = EncodedPayload::capture(
                    binding.input_schema.clone(),
                    "x".repeat(binding.limits.max_input_bytes as usize + 1),
                )
                .unwrap()
            }
        }
        assert!(
            invalid
                .validate_against(&binding, &invocation().context)
                .is_err(),
            "change {change}"
        );
    }
    let mut binding = binding;
    binding.project_id = "other-project".into();
    assert!(
        request()
            .validate_against(&binding, &request().context)
            .is_err()
    );
}

#[test]
fn service_response_preserves_all_outcomes_and_rejects_forged_correlation_schema_and_bytes() {
    for kind in 0..3 {
        let response = response(kind);
        response.validate_against(&request(), &binding()).unwrap();
        let frame = ProcessFrame::new(ProcessBody::ServiceResponse(response.clone()))
            .encode()
            .unwrap();
        assert_eq!(
            parse_process_frame(&frame).unwrap().body,
            ProcessBody::ServiceResponse(response)
        );
    }
    for change in 0..7 {
        let mut invalid = response(0);
        match change {
            0 => invalid.call_id = "other-call".into(),
            1 => invalid.handle_id = "other-handle".into(),
            2 => invalid.context.dispatch_id = "other-dispatch".into(),
            3 => invalid.context.environment_digest = "f".repeat(64),
            _ => {
                let InvocationOutcome::Succeeded { output } = &mut invalid.outcome else {
                    unreachable!()
                };
                match change {
                    4 => output.schema = binding().error_schema,
                    5 => output.utf8.push(' '),
                    _ => {
                        *output = EncodedPayload::capture(
                            binding().output_schema,
                            "x".repeat(binding().limits.max_output_bytes as usize + 1),
                        )
                        .unwrap()
                    }
                }
            }
        }
        assert!(
            invalid.validate_against(&request(), &binding()).is_err(),
            "change {change}"
        );
    }
    for kind in 1..3 {
        let mut wrong = response(kind);
        let payload = EncodedPayload::capture(binding().output_schema, "{}".into()).unwrap();
        wrong.outcome = if kind == 1 {
            InvocationOutcome::Failed { error: payload }
        } else {
            InvocationOutcome::Unknown { error: payload }
        };
        assert!(wrong.validate_against(&request(), &binding()).is_err());
    }
}

#[test]
fn service_frames_reject_duplicate_members_unknown_fields_and_unbounded_payloads() {
    let original = ProcessFrame::new(ProcessBody::ServiceRequest(request()))
        .encode()
        .unwrap();
    let text = String::from_utf8(original).unwrap();
    let duplicate = text.replace(
        "\"callId\":\"service-call-a\"",
        "\"callId\":\"service-call-a\",\"callId\":\"service-call-a\"",
    );
    assert!(parse_process_frame(duplicate.as_bytes()).is_err());
    let mut extra: serde_json::Value = serde_json::from_str(&text).unwrap();
    extra["body"]["data"]["providerId"] = "forged-provider".into();
    assert!(parse_process_frame(&serde_json::to_vec(&extra).unwrap()).is_err());
    assert_eq!(
        EncodedPayload::capture(
            binding().input_schema,
            "x".repeat(MAX_INVOCATION_PAYLOAD_BYTES + 1)
        )
        .unwrap_err()
        .code,
        ContractErrorCode::LimitExceeded
    );
}
