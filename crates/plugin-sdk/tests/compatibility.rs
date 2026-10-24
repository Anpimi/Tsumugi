use serde_json::json;
use tsumugi_plugin_sdk::*;

const COMBINED: &[u8] = include_bytes!("fixtures/combined.manifest.json");
const REQUEST: &[u8] = br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1,"behaviorVersion":1},"profile":null}"#;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn request() -> CapabilityCompatibilityRequest {
    CapabilityCompatibilityRequest {
        contribution_id: "analyze".into(),
        contract: contract("example.analyze"),
        profile: None,
    }
}
fn manifest(profiles: Vec<ContractRef>) -> ValidatedManifest {
    let mut manifest = parse_manifest(COMBINED).unwrap().manifest().clone();
    let contribution = manifest
        .contributions
        .iter_mut()
        .find(|value| value.id == "analyze")
        .unwrap();
    let ContributionKind::Capability { declaration } = &mut contribution.contribution else {
        panic!("fixture capability");
    };
    declaration.profiles = profiles;
    manifest.validate().unwrap()
}
fn assert_legacy_error(
    manifest: &ValidatedManifest,
    request: &CapabilityCompatibilityRequest,
    field: &str,
) {
    assert_eq!(
        manifest
            .capability(
                &request.contribution_id,
                &request.contract,
                request.profile.as_ref(),
            )
            .unwrap_err(),
        ContractError {
            code: ContractErrorCode::IncompatibleContract,
            field: field.into(),
        }
    );
}

#[test]
fn same_shaped_behavior_upgrade_is_distinct_from_package_semver() {
    let original = manifest(vec![]);
    let selected = request();
    let original_declaration = original
        .capability("analyze", &selected.contract, None)
        .unwrap();
    let mut changed = original.manifest().clone();
    changed.plugin.version = "99.0.0".into();
    let package_upgrade = changed.clone().validate().unwrap();
    assert!(
        package_upgrade
            .diagnose_capability(&selected)
            .unwrap()
            .is_compatible()
    );
    let contribution = changed
        .contributions
        .iter_mut()
        .find(|value| value.id == "analyze")
        .unwrap();
    let ContributionKind::Capability { declaration } = &mut contribution.contribution else {
        panic!("fixture capability");
    };
    declaration.contract.behavior_version = 2;
    assert_eq!(declaration.input_schema, original_declaration.input_schema);
    assert_eq!(
        declaration.output_schema,
        original_declaration.output_schema
    );
    assert_eq!(declaration.error_schema, original_declaration.error_schema);
    let changed = changed.validate().unwrap();
    let report = changed.diagnose_capability(&selected).unwrap();
    assert_eq!(
        report.status,
        CapabilityCompatibilityStatus::ContractBehaviorMismatch
    );
    assert!(!report.is_compatible());
    assert_eq!(report.request, selected);
    assert_eq!(
        report.declared_contract.as_ref().unwrap().behavior_version,
        2
    );
    assert_eq!(report.component_id.as_deref(), Some("ai-helper"));
    assert_legacy_error(&changed, &selected, "contributions.contract");
}

#[test]
fn contract_and_profile_mismatches_preserve_legacy_error_fields() {
    use CapabilityCompatibilityStatus::*;
    let profile = contract("example.profile");
    let manifest = manifest(vec![profile.clone()]);
    let selected = CapabilityCompatibilityRequest {
        profile: Some(profile.clone()),
        ..request()
    };
    let mut cases = Vec::new();
    let mut changed = selected.clone();
    changed.contract.id = "example.other".into();
    cases.push((changed, ContractIdMismatch, "contributions.contract"));
    let mut changed = selected.clone();
    changed.contract.schema_version = 2;
    cases.push((changed, ContractSchemaMismatch, "contributions.contract"));
    let mut changed = selected.clone();
    changed.contract.behavior_version = 2;
    cases.push((changed, ContractBehaviorMismatch, "contributions.contract"));
    cases.push((request(), ProfileRequired, "contributions.profiles"));
    for changed_profile in [
        contract("example.other-profile"),
        ContractRef {
            schema_version: 2,
            ..profile.clone()
        },
        ContractRef {
            behavior_version: 2,
            ..profile.clone()
        },
    ] {
        cases.push((
            CapabilityCompatibilityRequest {
                profile: Some(changed_profile),
                ..request()
            },
            ProfileUnsupported,
            "contributions.contract",
        ));
    }
    // A missing profile must not replace the original contract mismatch field.
    cases.push((
        CapabilityCompatibilityRequest {
            contract: ContractRef {
                behavior_version: 2,
                ..selected.contract.clone()
            },
            ..request()
        },
        ContractBehaviorMismatch,
        "contributions.contract",
    ));
    for (query, status, field) in cases {
        let report = manifest.diagnose_capability(&query).unwrap();
        assert_eq!(report.status, status, "{query:?}");
        assert_eq!(report.request, query);
        assert_eq!(report.declared_contract, Some(selected.contract.clone()));
        assert_eq!(report.declared_profiles, vec![profile.clone()]);
        assert_legacy_error(&manifest, &query, field);
    }
    assert!(
        manifest
            .diagnose_capability(&selected)
            .unwrap()
            .is_compatible()
    );
    assert!(
        manifest
            .capability("analyze", &selected.contract, selected.profile.as_ref())
            .is_ok()
    );
}

#[test]
fn missing_and_non_callable_contributions_have_distinct_metadata() {
    let manifest = manifest(vec![]);
    for (id, status, component, field) in [
        (
            "missing",
            CapabilityCompatibilityStatus::ContributionMissing,
            None,
            "contributions.id",
        ),
        (
            "terms",
            CapabilityCompatibilityStatus::NotCallable,
            Some("knowledge-data"),
            "contributions.kind",
        ),
        (
            "guide",
            CapabilityCompatibilityStatus::NotCallable,
            Some("knowledge-data"),
            "contributions.kind",
        ),
        (
            "reference-panel",
            CapabilityCompatibilityStatus::NotCallable,
            Some("panel"),
            "contributions.kind",
        ),
    ] {
        let query = CapabilityCompatibilityRequest {
            contribution_id: id.into(),
            ..request()
        };
        let report = manifest.diagnose_capability(&query).unwrap();
        assert_eq!(report.status, status);
        assert_eq!(report.component_id.as_deref(), component);
        assert_eq!(report.declared_contract, None);
        assert!(report.declared_profiles.is_empty());
        assert_legacy_error(&manifest, &query, field);
    }
}

#[test]
fn profiles_are_exact_explicit_selections_with_no_implicit_first_version() {
    let selected = request();
    let no_profiles = manifest(vec![]);
    assert!(
        no_profiles
            .diagnose_capability(&selected)
            .unwrap()
            .is_compatible()
    );
    let first = contract("example.profile");
    let second = ContractRef {
        behavior_version: 3,
        ..first.clone()
    };
    let profiles = vec![first.clone(), second.clone()];
    let with_profiles = manifest(profiles.clone());
    let explicit = CapabilityCompatibilityRequest {
        profile: Some(second),
        ..selected.clone()
    };
    let report = with_profiles.diagnose_capability(&explicit).unwrap();
    assert!(report.is_compatible());
    assert_eq!(report.declared_profiles, profiles);
    assert_eq!(
        with_profiles.diagnose_capability(&selected).unwrap().status,
        CapabilityCompatibilityStatus::ProfileRequired
    );
    let absent = CapabilityCompatibilityRequest {
        profile: Some(first),
        ..selected
    };
    assert_eq!(
        no_profiles.diagnose_capability(&absent).unwrap().status,
        CapabilityCompatibilityStatus::ProfileUnsupported
    );
    assert_legacy_error(&no_profiles, &absent, "contributions.contract");
}

#[test]
fn declaration_resolution_keeps_exact_matching_choice_and_collection() {
    let a = manifest(vec![]);
    let mut other = a.manifest().clone();
    other.plugin.id = "another-knowledge".into();
    let b = other.validate().unwrap();
    let query = request();
    let chosen = ProviderKey {
        plugin: b.manifest().plugin.clone(),
        contribution_id: "analyze".into(),
    };
    let mut collected = None;
    for catalog in [vec![a.clone(), b.clone()], vec![b.clone(), a.clone()]] {
        for item in &catalog {
            assert!(item.diagnose_capability(&query).unwrap().is_compatible());
        }
        let error = resolve_declarations(
            &catalog,
            &query.contract,
            None,
            ProviderSelection::Single,
            &[],
        )
        .unwrap_err();
        assert_eq!(error.code, ContractErrorCode::AmbiguousProvider);
        assert_eq!(error.field, "chosen");
        let found = resolve_declarations(
            &catalog,
            &query.contract,
            None,
            ProviderSelection::Single,
            std::slice::from_ref(&chosen),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].key, chosen);
        let keys = resolve_declarations(
            &catalog,
            &query.contract,
            None,
            ProviderSelection::CollectIndependent,
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|provider| provider.key)
        .collect::<Vec<_>>();
        assert_eq!(keys.len(), 2);
        if let Some(previous) = &collected {
            assert_eq!(&keys, previous);
        }
        collected = Some(keys);
        let changed = ContractRef {
            behavior_version: 2,
            ..query.contract.clone()
        };
        let error = resolve_declarations(&catalog, &changed, None, ProviderSelection::Single, &[])
            .unwrap_err();
        assert_eq!(error.code, ContractErrorCode::IncompatibleContract);
        assert_eq!(error.field, "contract");
        let error = resolve_declarations(
            &catalog,
            &changed,
            None,
            ProviderSelection::Single,
            std::slice::from_ref(&chosen),
        )
        .unwrap_err();
        assert_eq!(error.code, ContractErrorCode::IncompatibleContract);
        assert_eq!(error.field, "chosen");
    }
}

#[test]
fn request_parser_accepts_the_byte_limit_and_rejects_extra_or_non_json_bytes() {
    assert_eq!(
        parse_capability_compatibility_request(REQUEST).unwrap(),
        request()
    );
    let mut boundary = REQUEST.to_vec();
    boundary.resize(MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES, b' ');
    assert_eq!(
        parse_capability_compatibility_request(&boundary).unwrap(),
        request()
    );
    boundary.push(b' ');
    let error = parse_capability_compatibility_request(&boundary).unwrap_err();
    assert_eq!(error.code, ContractErrorCode::LimitExceeded);
    assert_eq!(error.field, "compatibility.request");
    for bytes in [&[][..], &[0xff][..], &b"null"[..], &b"{}"[..], &b"[]"[..]] {
        assert_eq!(
            parse_capability_compatibility_request(bytes)
                .unwrap_err()
                .code,
            ContractErrorCode::InvalidSchema
        );
    }
    let mut trailing = REQUEST.to_vec();
    trailing.extend_from_slice(b"false");
    assert_eq!(
        parse_capability_compatibility_request(&trailing)
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );
}

#[test]
fn request_parser_rejects_duplicate_unknown_and_mistyped_fields() {
    for bytes in [
        br#"{"contributionId":"analyze","contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1,"behaviorVersion":1}}"#.as_slice(),
        br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1,"schemaVersion":1,"behaviorVersion":1}}"#.as_slice(),
        br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1,"behaviorVersion":1},"profile":null,"profile":null}"#.as_slice(),
        br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1,"behaviorVersion":1},"extra":true}"#.as_slice(),
        br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1,"behaviorVersion":1,"extra":true}}"#.as_slice(),
        br#"{"contributionId":1,"contract":{"id":"example.analyze","schemaVersion":1,"behaviorVersion":1}}"#.as_slice(),
        br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":4294967296,"behaviorVersion":1}}"#.as_slice(),
        br#"{"contributionId":"analyze","contract":{"id":"example.analyze","schemaVersion":1.5,"behaviorVersion":1}}"#.as_slice(),
    ] {
        let error = parse_capability_compatibility_request(bytes).unwrap_err();
        assert_eq!(error.code, ContractErrorCode::InvalidSchema);
        assert_eq!(error.field, "compatibility.request");
    }
}

#[test]
fn semantic_request_validation_also_applies_to_manually_constructed_requests() {
    let manifest = manifest(vec![]);
    let mut cases = Vec::new();
    for id in [
        String::new(),
        "Analyze".into(),
        "../analyze".into(),
        "a".repeat(129),
    ] {
        cases.push(CapabilityCompatibilityRequest {
            contribution_id: id,
            ..request()
        });
    }
    for invalid in [
        ContractRef {
            id: "Example.analyze".into(),
            ..request().contract
        },
        ContractRef {
            schema_version: 0,
            ..request().contract
        },
        ContractRef {
            behavior_version: 0,
            ..request().contract
        },
    ] {
        cases.push(CapabilityCompatibilityRequest {
            contract: invalid.clone(),
            ..request()
        });
        cases.push(CapabilityCompatibilityRequest {
            profile: Some(invalid),
            ..request()
        });
    }
    for query in cases {
        let error = query.validate().unwrap_err();
        assert_eq!(error.code, ContractErrorCode::InvalidDeclaration);
        assert_eq!(manifest.diagnose_capability(&query).unwrap_err(), error);
        assert_eq!(
            parse_capability_compatibility_request(&serde_json::to_vec(&query).unwrap())
                .unwrap_err(),
            error
        );
    }
}

#[test]
fn diagnostic_reports_roundtrip_strictly_and_keep_null_metadata_explicit() {
    let manifest = manifest(vec![]);
    let report = manifest.diagnose_capability(&request()).unwrap();
    let value = serde_json::to_value(&report).unwrap();
    assert_eq!(value["status"], "compatible");
    assert_eq!(value["componentId"], "ai-helper");
    assert_eq!(
        serde_json::from_value::<CapabilityCompatibilityReport>(value.clone()).unwrap(),
        report
    );
    let mut unknown = value.clone();
    unknown["extra"] = json!(true);
    assert!(serde_json::from_value::<CapabilityCompatibilityReport>(unknown).is_err());
    let mut unknown = value.clone();
    unknown["request"]["extra"] = json!(true);
    assert!(serde_json::from_value::<CapabilityCompatibilityReport>(unknown).is_err());
    let mut unknown = value;
    unknown["status"] = json!("runtime-compatible");
    assert!(serde_json::from_value::<CapabilityCompatibilityReport>(unknown).is_err());
    let missing = manifest
        .diagnose_capability(&CapabilityCompatibilityRequest {
            contribution_id: "missing".into(),
            ..request()
        })
        .unwrap();
    let value = serde_json::to_value(&missing).unwrap();
    assert_eq!(value["status"], "contribution-missing");
    assert!(value.get("componentId").unwrap().is_null());
    assert!(value.get("declaredContract").unwrap().is_null());
    assert_eq!(value["declaredProfiles"], json!([]));
    assert_eq!(
        serde_json::from_value::<CapabilityCompatibilityReport>(value).unwrap(),
        missing
    );
}
