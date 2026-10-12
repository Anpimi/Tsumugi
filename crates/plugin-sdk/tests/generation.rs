use serde_json::json;
use tsumugi_plugin_sdk::*;

fn input() -> GenerationServiceInput {
    parse_generation_service_input(include_bytes!("fixtures/generation.input.json")).unwrap()
}
fn binding() -> ServiceBinding {
    let mut binding: ServiceBinding =
        serde_json::from_slice(include_bytes!("fixtures/service.binding.json")).unwrap();
    binding.contract = generation_service_contract();
    binding.input_schema = generation_service_input_contract();
    binding.output_schema = generation_service_receipt_contract();
    binding.error_schema = generation_service_error_contract();
    binding.effect = EffectKind::External;
    binding
}

#[test]
fn generation_data_round_trips_and_receipts_match_only_original_child_identities() {
    let input = input();
    assert_eq!(
        parse_generation_service_input(&serde_json::to_vec(&input).unwrap()).unwrap(),
        input
    );
    let receipt = GenerationServiceReceipt {
        task_id: input.task_id.clone(),
        attempt_id: input.attempt_id.clone(),
        input_digest: "a".repeat(64),
    };
    receipt.validate_against(&input).unwrap();
    let bytes = serde_json::to_vec(&receipt).unwrap();
    assert_eq!(parse_generation_service_receipt(&bytes).unwrap(), receipt);
    let fields = serde_json::to_value(&receipt).unwrap();
    assert_eq!(fields.as_object().unwrap().len(), 3);
    for field in ["taskId", "attemptId", "inputDigest"] {
        let mut invalid = fields.clone();
        invalid[field] = json!(if field == "inputDigest" {
            "A".repeat(64)
        } else {
            "another-child".into()
        });
        let result = parse_generation_service_receipt(&serde_json::to_vec(&invalid).unwrap())
            .and_then(|receipt| receipt.validate_against(&input));
        assert!(result.is_err(), "{field}");
    }
}

#[test]
fn generation_request_rejects_authority_overrides_and_bounds_actual_wire_bytes() {
    let original = serde_json::to_value(input()).unwrap();
    for field in [
        "config",
        "payload",
        "model",
        "destination",
        "sharing",
        "effects",
        "lease",
        "parentTask",
        "confirmed",
        "budget",
    ] {
        let mut forged = original.clone();
        forged[field] = json!(true);
        assert_eq!(
            parse_generation_service_input(&serde_json::to_vec(&forged).unwrap())
                .unwrap_err()
                .code,
            ContractErrorCode::InvalidSchema,
            "{field}"
        );
    }
    let mut too_large = serde_json::to_vec(&input()).unwrap();
    too_large.resize(MAX_GENERATION_SERVICE_INPUT_BYTES + 1, b' ');
    assert_eq!(
        parse_generation_service_input(&too_large).unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    for change in 0..5 {
        let mut invalid = input();
        match change {
            0 => invalid.unit_ids.clear(),
            1 => invalid.unit_ids.push(invalid.unit_ids[0].clone()),
            2 => {
                invalid.unit_ids = (0..=MAX_GENERATION_SERVICE_UNITS)
                    .map(|i| format!("unit-{i}"))
                    .collect()
            }
            3 => invalid.task_id = "x".repeat(129),
            _ => invalid.unit_ids[0] = "not an identity".into(),
        }
        assert!(
            parse_generation_service_input(&serde_json::to_vec(&invalid).unwrap()).is_err(),
            "case {change}"
        );
    }
    let mut maximum = input();
    maximum.unit_ids = (0..MAX_GENERATION_SERVICE_UNITS)
        .map(|i| format!("{i:0128}"))
        .collect();
    maximum.validate().unwrap();
    parse_generation_service_input(&serde_json::to_vec(&maximum).unwrap()).unwrap();
}

#[test]
fn generation_requires_exact_service_versions_schemas_and_external_effect() {
    validate_generation_service_binding(&binding()).unwrap();
    for change in 0..7 {
        let mut invalid = binding();
        match change {
            0 => invalid.contract.behavior_version += 1,
            1 => invalid.input_schema.schema_version += 1,
            2 => invalid.output_schema.id = "example.other-receipt".into(),
            3 => invalid.error_schema.behavior_version += 1,
            4 => invalid.effect = EffectKind::Proposal,
            5 => invalid.effect = EffectKind::ReadOnly,
            _ => invalid.contract.id = "example.other-service".into(),
        }
        assert_eq!(
            validate_generation_service_binding(&invalid)
                .unwrap_err()
                .code,
            ContractErrorCode::IncompatibleContract,
            "case {change}"
        );
    }
}

#[test]
fn generation_errors_are_finite_data_without_authority_or_arbitrary_diagnostics() {
    for code in [
        GenerationServiceErrorCode::InvalidInput,
        GenerationServiceErrorCode::Unavailable,
        GenerationServiceErrorCode::PermissionDenied,
        GenerationServiceErrorCode::Cancelled,
        GenerationServiceErrorCode::LimitExceeded,
        GenerationServiceErrorCode::Conflict,
        GenerationServiceErrorCode::Busy,
        GenerationServiceErrorCode::StorageFailed,
        GenerationServiceErrorCode::OutcomeUnknown,
    ] {
        let error = GenerationServiceError { code };
        assert_eq!(
            parse_generation_service_error(&serde_json::to_vec(&error).unwrap()).unwrap(),
            error
        );
    }
    for invalid in [
        json!({"code":"success"}),
        json!({"code":"outcome-unknown","retry":true}),
        json!({"code":"permission-denied","reason":"untrusted body"}),
    ] {
        assert!(parse_generation_service_error(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
}
