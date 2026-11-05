use tsumugi_plugin_sdk::*;

fn process() -> PermissionRequest {
    PermissionRequest::Process {
        program: "bin/format-codec".into(),
    }
}
fn source() -> SourceImportBinding {
    let manifest = parse_manifest(include_bytes!("fixtures/source-import.manifest.json")).unwrap();
    let declaration =
        parse_source_import_declaration(include_bytes!("fixtures/source-import.declaration.json"))
            .unwrap();
    let review =
        parse_review_declaration(include_bytes!("fixtures/source-import.review.json")).unwrap();
    declaration
        .bind(&manifest, &"a".repeat(64), &review)
        .unwrap()
}
fn build() -> BuildBinding {
    let manifest = parse_manifest(include_bytes!("fixtures/build.manifest.json")).unwrap();
    parse_build_declaration(include_bytes!("fixtures/build.declaration.json"))
        .unwrap()
        .bind(&manifest, &"a".repeat(64))
        .unwrap()
}
fn review() -> ReviewBinding {
    let manifest = parse_manifest(include_bytes!("fixtures/review.manifest.json")).unwrap();
    parse_review_declaration(include_bytes!("fixtures/review.declaration.json"))
        .unwrap()
        .bind(&manifest, &"a".repeat(64))
        .unwrap()
}

#[test]
fn artifact_capable_domain_bindings_retain_declared_format_process_permissions() {
    let mut source = source();
    source.extractor.declaration.permissions.push(process());
    source.checker.declaration.permissions.push(process());
    source
        .review
        .checker
        .declaration
        .permissions
        .push(process());
    source.validate().unwrap();
    let roundtrip: CapabilityBinding =
        serde_json::from_slice(&serde_json::to_vec(&source.extractor).unwrap()).unwrap();
    assert_eq!(roundtrip, source.extractor);
    let mut build = build();
    build.builder.declaration.permissions.push(process());
    build.checker.declaration.permissions.push(process());
    build.validate().unwrap();
    let mut review = review();
    review.checker.declaration.permissions.push(process());
    review.validate().unwrap();
    assert_eq!(
        review.checker.declaration.permissions,
        [PermissionRequest::CapturedInput, process()]
    );
}

#[test]
fn domain_process_support_does_not_admit_network_services_or_staged_output() {
    for permission in [
        PermissionRequest::StagedOutput,
        PermissionRequest::Network {
            destination: "https://example.invalid".into(),
        },
        PermissionRequest::ProjectService {
            contract: ContractRef {
                id: "example.service".into(),
                schema_version: 1,
                behavior_version: 1,
            },
        },
    ] {
        let mut source = source();
        source
            .extractor
            .declaration
            .permissions
            .push(permission.clone());
        assert!(source.validate().is_err());
        let mut build = build();
        build
            .builder
            .declaration
            .permissions
            .push(permission.clone());
        assert!(build.validate().is_err());
        let mut review = review();
        review.checker.declaration.permissions.push(permission);
        assert!(review.validate().is_err());
    }
}

#[test]
fn process_programs_keep_the_existing_safe_relative_path_boundary() {
    for program in ["../codec", "/bin/codec", "bin/../codec", "bin\\codec"] {
        let mut review = review();
        review
            .checker
            .declaration
            .permissions
            .push(PermissionRequest::Process {
                program: program.into(),
            });
        assert!(review.validate().is_err());
    }
}

#[test]
fn historical_text_bindings_keep_their_capture_only_permission_boundary() {
    let mut source = source();
    source.declaration.file_sets = None;
    for material in &mut source.declaration.materials {
        material.encoding = SourceMaterialEncoding::LegacyUtf8;
    }
    source.extractor.declaration.input_schema.schema_version = 1;
    source.extractor.declaration.output_schema.schema_version = 2;
    source.checker.declaration.input_schema.schema_version = 1;
    source
        .review
        .checker
        .declaration
        .input_schema
        .schema_version = 1;
    source.validate().unwrap();
    source.extractor.declaration.permissions.push(process());
    assert!(source.validate().is_err());
    let mut build = build();
    build.builder.declaration.input_schema.schema_version = 1;
    build.builder.declaration.output_schema.schema_version = 1;
    build.checker.declaration.input_schema.schema_version = 1;
    build.validate().unwrap();
    build.builder.declaration.permissions.push(process());
    assert!(build.validate().is_err());
    let mut review = review();
    review.checker.declaration.input_schema.schema_version = 1;
    review.validate().unwrap();
    review.checker.declaration.permissions.push(process());
    assert!(review.validate().is_err());
}
