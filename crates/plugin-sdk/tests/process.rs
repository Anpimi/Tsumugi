use tsumugi_plugin_sdk::*;

fn activation() -> ProcessActivation {
    let original = parse_exchange(include_bytes!("fixtures/invocation.request.json")).unwrap();
    let ExchangeBody::Request(request) = original.document().body.clone() else {
        panic!("expected request fixture")
    };
    ProcessActivation {
        instance: request.provider.instance(),
        capabilities: vec![ProcessCapability {
            contribution_id: request.provider.contribution_id,
            capability: CapabilityDeclaration {
                contract: request.capability,
                input_schema: request.input.schema,
                output_schema: request.output_schema,
                error_schema: request.error_schema,
                profiles: vec![request.profile.unwrap()],
                effect: EffectKind::ReadOnly,
                permissions: vec![PermissionRequest::CapturedInput],
                limits: CapabilityLimits {
                    max_input_bytes: 131072,
                    max_output_bytes: 65536,
                    concurrency: 1,
                    timeout_ms: 1000,
                },
            },
        }],
        services: vec![],
    }
}

#[test]
fn component_roster_preserves_each_members_declaration_and_exact_call_binding() {
    let mut original = activation();
    let mut second = original.capabilities[0].clone();
    second.contribution_id = "other-capability".into();
    second.capability.contract.id = "example.other-capability".into();
    second.capability.profiles.clear();
    original.capabilities.push(second);
    original.validate().unwrap();
    for body in [
        ProcessBody::Activate(original.clone()),
        ProcessBody::Ready(original.clone()),
    ] {
        let frame = ProcessFrame::new(body.clone()).encode().unwrap();
        assert_eq!(parse_process_frame(&frame).unwrap().body, body);
        let wire: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert!(wire["body"]["data"].get("provider").is_none());
        assert!(
            wire["body"]["data"]["instance"]
                .get("contributionId")
                .is_none()
        );
    }
    for member in &original.capabilities {
        assert_eq!(original.capability(&member.contribution_id), Some(member));
        let provider = original.provider(&member.contribution_id).unwrap();
        assert_eq!(provider.contribution_id, member.contribution_id);
        assert_eq!(provider.instance(), original.instance);
        assert!(original.instance.matches_provider(&provider));
    }
    assert!(original.capability("absent-member").is_none());
    assert_eq!(
        original.provider("absent-member").unwrap_err().code,
        ContractErrorCode::IncompatibleContract
    );
    // Instance projection alone is deliberately not a membership check.
    original.instance.provider("absent-member").unwrap();
    assert!(original.instance.provider("invalid member").is_err());
    let provider = original.provider("other-capability").unwrap();
    for change in 0..7 {
        let mut wrong = provider.clone();
        match change {
            0 => wrong.plugin.publisher = "other".into(),
            1 => wrong.plugin.id = "other".into(),
            2 => wrong.plugin.version = "0.1.0-alpha.2".into(),
            3 => wrong.component_id = "other".into(),
            4 => wrong.package_digest = "f".repeat(64),
            5 => wrong.instance_id = "other".into(),
            _ => wrong.activation_generation += 1,
        }
        assert!(
            !original.instance.matches_provider(&wrong),
            "change {change}"
        );
    }
}

#[test]
fn component_roster_is_nonempty_bounded_unique_and_validates_every_member() {
    assert_eq!(MAX_PROCESS_CAPABILITIES, 128);
    let original = activation();
    let mut maximum = original.clone();
    maximum.capabilities = (0..MAX_PROCESS_CAPABILITIES)
        .map(|i| ProcessCapability {
            contribution_id: format!("capability-{i}"),
            capability: original.capabilities[0].capability.clone(),
        })
        .collect();
    let bytes = ProcessFrame::new(ProcessBody::Activate(maximum.clone()))
        .encode()
        .unwrap();
    assert!(bytes.len() <= MAX_PROCESS_FRAME_BYTES);
    assert_eq!(
        parse_process_frame(&bytes).unwrap().body,
        ProcessBody::Activate(maximum.clone())
    );
    maximum.capabilities.push(ProcessCapability {
        contribution_id: "one-too-many".into(),
        capability: original.capabilities[0].capability.clone(),
    });
    let mut empty = original.clone();
    empty.capabilities.clear();
    for invalid in [empty, maximum] {
        assert_eq!(
            invalid.validate().unwrap_err().code,
            ContractErrorCode::LimitExceeded
        );
    }
    let mut duplicate = original.clone();
    let mut same_id = duplicate.capabilities[0].clone();
    same_id.capability.contract.behavior_version += 1;
    duplicate.capabilities.push(same_id);
    assert_eq!(
        duplicate.validate().unwrap_err().code,
        ContractErrorCode::DuplicateIdentity
    );
    // A requested member cannot conceal an invalid rest of the roster.
    assert!(
        duplicate
            .provider(&original.capabilities[0].contribution_id)
            .is_err()
    );
    let mut invalid_member = original.clone();
    let mut second = original.capabilities[0].clone();
    second.contribution_id = "other-capability".into();
    second.capability.input_schema.schema_version = 0;
    invalid_member.capabilities.push(second);
    assert!(invalid_member.validate().is_err());
    assert!(
        invalid_member
            .provider(&original.capabilities[0].contribution_id)
            .is_err()
    );
    for change in 0..4 {
        let mut invalid = original.clone();
        match change {
            0 => invalid.capabilities[0].contribution_id.clear(),
            1 => invalid.capabilities[0].capability.contract.behavior_version = 0,
            2 => invalid.instance.activation_generation = 0,
            _ => invalid.instance.package_digest = "A".repeat(64),
        }
        assert!(invalid.validate().is_err(), "change {change}");
    }
}

#[test]
fn process_three_requires_instance_and_roster_without_a_singleton_wire_fallback() {
    assert_eq!(PROCESS_PROTOCOL, 3);
    assert_eq!(MANIFEST_PROTOCOL, 1);
    assert_eq!(EXCHANGE_PROTOCOL, 1);
    let original = activation();
    let frame = ProcessFrame::new(ProcessBody::Activate(original.clone()));
    let wire = serde_json::to_value(&frame).unwrap();
    for field in ["instance", "capabilities", "services"] {
        let mut missing = wire.clone();
        missing["body"]["data"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(parse_process_frame(&serde_json::to_vec(&missing).unwrap()).is_err());
    }
    let mut legacy = wire.clone();
    legacy["body"]["data"] = serde_json::json!({
        "provider": original.provider(&original.capabilities[0].contribution_id).unwrap(),
        "capability": original.capabilities[0].capability,
        "services": []
    });
    assert!(parse_process_frame(&serde_json::to_vec(&legacy).unwrap()).is_err());
    let mut extra = wire;
    extra["body"]["data"]["instance"]["contributionId"] = "not-an-instance-field".into();
    assert!(parse_process_frame(&serde_json::to_vec(&extra).unwrap()).is_err());
    for body in [
        ProcessBody::Close {
            instance: original.instance.clone(),
        },
        ProcessBody::Closed {
            instance: original.instance.clone(),
        },
    ] {
        let frame = ProcessFrame::new(body.clone());
        assert_eq!(
            parse_process_frame(&frame.encode().unwrap()).unwrap().body,
            body
        );
        let mut old = frame;
        old.protocol_version = 2;
        assert_eq!(
            old.validate().unwrap_err().code,
            ContractErrorCode::UnsupportedProtocol
        );
    }
}

#[test]
fn maximum_opaque_payload_and_bounded_metadata_fit_the_separate_frame_budget() {
    let original = parse_exchange(include_bytes!("fixtures/invocation.request.json")).unwrap();
    let ExchangeBody::Request(mut request) = original.document().body.clone() else {
        panic!("expected request fixture")
    };
    for identity in [
        &mut request.context.project_id,
        &mut request.context.scope_id,
        &mut request.context.operation_id,
        &mut request.context.attempt_id,
        &mut request.context.item_id,
        &mut request.context.dispatch_id,
        &mut request.provider.instance_id,
    ] {
        *identity = "x".repeat(128);
    }
    for name in [
        &mut request.provider.plugin.publisher,
        &mut request.provider.plugin.id,
        &mut request.provider.component_id,
        &mut request.provider.contribution_id,
    ] {
        *name = "x".repeat(128);
    }
    request.provider.plugin.version = format!("0.1.0-{}", "x".repeat(58));
    request.provider.activation_generation = u32::MAX;
    for schema in [
        &mut request.capability,
        &mut request.output_schema,
        &mut request.error_schema,
    ] {
        schema.id = "x".repeat(128);
        schema.schema_version = u32::MAX;
        schema.behavior_version = u32::MAX;
    }
    request.profile = Some(request.capability.clone());
    // Opaque payload schemas may permit control characters. Every byte here
    // uses the longest JSON escape; the SDK does not interpret that schema.
    request.input = EncodedPayload::capture(
        request.capability.clone(),
        "\u{1}".repeat(MAX_INVOCATION_PAYLOAD_BYTES),
    )
    .unwrap();
    request.context.input_digest = request.input.sha256.clone();
    request.max_result_bytes = MAX_PROCESS_FRAME_BYTES as u32;
    let invoke = ProcessFrame::new(ProcessBody::Invoke(request.clone()))
        .encode()
        .unwrap();
    assert!(invoke.len() > 6 * MAX_INVOCATION_PAYLOAD_BYTES);
    assert!(invoke.len() <= MAX_PROCESS_FRAME_BYTES);
    parse_process_frame(&invoke).unwrap();
    drop(invoke);
    for kind in 0..3 {
        let payload = EncodedPayload::capture(
            if kind == 0 {
                request.output_schema.clone()
            } else {
                request.error_schema.clone()
            },
            "\u{1}".repeat(MAX_INVOCATION_PAYLOAD_BYTES),
        )
        .unwrap();
        let outcome = match kind {
            0 => InvocationOutcome::Succeeded { output: payload },
            1 => InvocationOutcome::Failed { error: payload },
            _ => InvocationOutcome::Unknown { error: payload },
        };
        let result = InvocationResult {
            context: request.context.clone(),
            provider: request.provider.clone(),
            capability: request.capability.clone(),
            profile: request.profile.clone(),
            result_id: "x".repeat(128),
            outcome,
        };
        let frame = ProcessFrame::new(ProcessBody::Result(result.clone()))
            .encode()
            .unwrap();
        assert!(frame.len() > 6 * MAX_INVOCATION_PAYLOAD_BYTES);
        assert!(frame.len() <= MAX_PROCESS_FRAME_BYTES);
        parse_process_frame(&frame).unwrap();
        let document = serde_json::to_vec(&ExchangeDocument {
            protocol_version: EXCHANGE_PROTOCOL,
            body: ExchangeBody::Result(result),
        })
        .unwrap();
        receive_invocation_result(&document, &request, &request.provider).unwrap();
        let mut smaller = request.clone();
        smaller.max_result_bytes = document.len() as u32 - 1;
        assert_eq!(
            receive_invocation_result(&document, &smaller, &request.provider)
                .unwrap_err()
                .code,
            ContractErrorCode::LimitExceeded
        );
    }
    assert_eq!(
        EncodedPayload::capture(
            request.output_schema,
            "x".repeat(MAX_INVOCATION_PAYLOAD_BYTES + 1)
        )
        .unwrap_err()
        .code,
        ContractErrorCode::LimitExceeded
    );
}
#[test]
fn framed_protocol_validates_exact_version_direction_data_and_duplicate_fields() {
    let cancellation = ProcessFrame::new(ProcessBody::Cancel {
        dispatch_id: "dispatch-a".into(),
    })
    .encode()
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&cancellation).unwrap()["body"]["data"],
        serde_json::json!({"dispatchId":"dispatch-a"})
    );
    let bytes = ProcessFrame::new(ProcessBody::Ping {
        nonce: "nonce-a".into(),
    })
    .encode()
    .unwrap();
    assert_eq!(
        parse_process_frame(&bytes).unwrap().body,
        ProcessBody::Ping {
            nonce: "nonce-a".into()
        }
    );
    for bytes in [
        br#"{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#.as_slice(),
        br#"{"protocolVersion":2,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#,
        br#"{"protocolVersion":3,"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#,
        br#"{"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":"nonce-a","unknown":true}}}"#,
        br#"{"protocolVersion":3,"body":{"kind":"ping","data":{"nonce":""}}}"#,
    ] {
        assert!(parse_process_frame(bytes).is_err());
    }
    assert!(parse_process_frame(&vec![b'x'; MAX_PROCESS_FRAME_BYTES + 1]).is_err());
}
#[test]
fn logical_package_paths_reject_traversal_and_nonportable_separators() {
    validate_package_path("packages/query/worker.mjs").unwrap();
    for path in [
        "../outside",
        "/outside",
        "a/../b",
        "a\\b",
        "C:outside",
        "a//b",
    ] {
        assert!(validate_package_path(path).is_err());
    }
}
