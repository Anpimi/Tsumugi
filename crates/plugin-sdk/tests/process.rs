use tsumugi_plugin_sdk::*;

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
    for bytes in [br#"{"protocolVersion":2,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#.as_slice(),br#"{"protocolVersion":1,"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#,br#"{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"nonce-a","unknown":true}}}"#,br#"{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":""}}}"#] {
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
