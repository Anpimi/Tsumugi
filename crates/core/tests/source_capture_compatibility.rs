use tsumugi_core::{content::SourceBundle, execution::FixedInput};

const BUNDLE: &[u8] = include_bytes!("fixtures/sdk-v1-capture/source-bundle.json");
const INPUT: &[u8] = include_bytes!("fixtures/sdk-v1-capture/fixed-input.json");
const PROVENANCE: &[u8] = include_bytes!("fixtures/sdk-v1-capture/provenance.json");

#[test]
fn supported_text_capture_keeps_its_original_serialization_and_manifest() {
    let bundle: SourceBundle = serde_json::from_slice(BUNDLE).unwrap();
    bundle.validate().unwrap();
    assert_eq!(serde_json::to_vec(&bundle).unwrap(), BUNDLE);
    assert_eq!(
        serde_json::to_vec(&bundle.source_input()).unwrap(),
        include_bytes!("fixtures/sdk-v1-capture/source-input.json")
    );
}

#[test]
fn frozen_sdk_v1_input_restores_without_rewriting_evidence_or_running_a_worker() {
    let provenance: serde_json::Value = serde_json::from_slice(PROVENANCE).unwrap();
    let fixed =
        FixedInput::restore(INPUT, provenance["fixedInputDigest"].as_str().unwrap()).unwrap();
    assert_eq!(fixed.bytes(), INPUT);
    let bundle = SourceBundle::from_input(&fixed).unwrap();
    assert_eq!(serde_json::to_vec(&bundle).unwrap(), BUNDLE);
    assert_eq!(fixed.digest(), provenance["fixedInputDigest"]);
}

#[test]
fn supported_bindings_and_context_keep_their_exact_baseline_meaning() {
    use tsumugi_plugin_sdk as sdk;
    let review_bytes = include_bytes!("fixtures/sdk-v1-capture/review-binding.json");
    let review: sdk::ReviewBinding = serde_json::from_slice(review_bytes).unwrap();
    review.validate().unwrap();
    assert_eq!(serde_json::to_vec(&review).unwrap(), review_bytes);
    let build_bytes = include_bytes!("fixtures/sdk-v1-capture/build-binding.json");
    let build: sdk::BuildBinding = serde_json::from_slice(build_bytes).unwrap();
    build.validate().unwrap();
    assert_eq!(serde_json::to_vec(&build).unwrap(), build_bytes);
    let value: serde_json::Value = serde_json::from_slice(include_bytes!(
        "fixtures/sdk-v1-capture/translation-binding.json"
    ))
    .unwrap();
    let translation = sdk::TranslationImportBinding {
        declaration: serde_json::from_value(value["declaration"].clone()).unwrap(),
        extractor: serde_json::from_value(value["extractor"].clone()).unwrap(),
        checker: serde_json::from_value(value["checker"].clone()).unwrap(),
    };
    translation.validate().unwrap();
    let context_bytes = include_bytes!("fixtures/sdk-v1-capture/context-content.json");
    let context = sdk::parse_content_exchange(context_bytes).unwrap();
    assert_eq!(serde_json::to_vec(&context).unwrap(), context_bytes);
    let block = context
        .domain_blocks
        .iter()
        .find(|block| block.schema.id == sdk::SOURCE_CONTEXT_FACTS_SCHEMA_ID)
        .unwrap();
    let facts = sdk::parse_source_context_block(block, &context.artifacts).unwrap();
    assert_eq!(facts.facts[0].text, "Fixture speaker");
    let environment: sdk::RuntimeEnvironmentDescriptor = serde_json::from_slice(include_bytes!(
        "fixtures/sdk-v1-capture/node-environment.json"
    ))
    .unwrap();
    assert_eq!(
        environment.digest().unwrap(),
        "fb82574603deea27d971fc878cf63fd8563e2c05d98b7ffc7ba29fe362759396"
    );
}

#[test]
fn saved_source_resource_v2_is_readable_but_cannot_claim_the_v3_profile() {
    use tsumugi_plugin_sdk as sdk;
    let bytes = include_bytes!("fixtures/sdk-v1-capture/source-import-declaration.json");
    let contract = sdk::ContractRef {
        schema_version: 2,
        ..sdk::source_import_declaration_contract()
    };
    let declaration = sdk::parse_source_import_declaration_for_contract(bytes, &contract).unwrap();
    assert!(declaration.is_legacy_text());
    assert_eq!(declaration.declaration_contract(), contract);
    assert_eq!(serde_json::to_vec(&declaration).unwrap(), bytes);
    // The same historical object is present in saved desktop drafts.
    let saved: sdk::SourceImportDeclaration = serde_json::from_slice(bytes).unwrap();
    saved.validate().unwrap();
    assert_eq!(serde_json::to_vec(&saved).unwrap(), bytes);
    assert!(sdk::parse_source_import_declaration(bytes).is_err());
    let unknown = sdk::ContractRef {
        schema_version: 4,
        ..contract
    };
    assert!(sdk::parse_source_import_declaration_for_contract(bytes, &unknown).is_err());
}

#[test]
fn text_only_frozen_binding_cannot_accept_a_binary_transport() {
    use tsumugi_plugin_sdk as sdk;
    let mut envelope: tsumugi_core::execution::InputEnvelope =
        serde_json::from_slice(INPUT).unwrap();
    let mut source: sdk::SourceExtractionInput =
        serde_json::from_value(envelope.items[0].payload.clone()).unwrap();
    let original = &source.artifacts[0];
    source.artifacts[0] = sdk::CapturedArtifact::from_bytes(
        original.id().into(),
        original.logical_path().into(),
        original.role().into(),
        &original.bytes().unwrap(),
    )
    .unwrap();
    envelope.items[0].payload = serde_json::to_value(source).unwrap();
    let fixed = FixedInput::capture(envelope).unwrap();
    assert!(SourceBundle::from_input(&fixed).is_err());
}
