use tsumugi_core::content::SourceBundle;
use tsumugi_plugin_sdk as sdk;

fn binding(binary: bool) -> sdk::SourceImportBinding {
    let manifest = sdk::parse_manifest(include_bytes!(
        "../../plugin-sdk/tests/fixtures/source-import.manifest.json"
    ))
    .unwrap();
    let mut declaration = sdk::parse_source_import_declaration(include_bytes!(
        "../../plugin-sdk/tests/fixtures/source-import.declaration.json"
    ))
    .unwrap();
    if binary {
        declaration.materials[0].encoding = sdk::SourceMaterialEncoding::Binary;
    }
    let review = sdk::parse_review_declaration(include_bytes!(
        "../../plugin-sdk/tests/fixtures/source-import.review.json"
    ))
    .unwrap();
    declaration
        .bind(&manifest, &"a".repeat(64), &review)
        .unwrap()
}

#[test]
fn declared_binary_capture_preserves_original_bytes_through_source_input_and_reopen() {
    let binding = binding(true);
    let mut originals = vec![
        vec![0, 255, 128, 10],
        b"uninterpreted companion\r\n".to_vec(),
    ];
    let bundle = SourceBundle::capture_declared(&binding, originals.clone(), "en-US").unwrap();
    originals[0][1] = 0;
    bundle.validate().unwrap();
    assert_eq!(bundle.files[0].bytes().unwrap().as_ref(), [0, 255, 128, 10]);
    assert_eq!(
        bundle.files[1].text().unwrap(),
        "uninterpreted companion\r\n"
    );
    let source = bundle.source_input();
    source.validate().unwrap();
    assert!(source.artifacts[0].as_text().is_none());
    assert_eq!(
        source.artifacts[0].validated_bytes().unwrap().as_ref(),
        [0, 255, 128, 10]
    );
    assert_eq!(
        source.artifacts[0].sha256(),
        sdk::artifact_bytes_digest(&[0, 255, 128, 10])
    );
    let reopened: SourceBundle =
        serde_json::from_slice(&serde_json::to_vec(&bundle).unwrap()).unwrap();
    reopened.validate().unwrap();
    assert_eq!(reopened, bundle);
    assert_eq!(reopened.source_input(), source);
    let mut corrupt = reopened;
    corrupt.files[0].data = sdk::CapturedArtifactData::Base64("AAAAAA==".into());
    assert!(corrupt.validate().is_err());
}

#[test]
fn a_declared_utf8_material_rejects_binary_instead_of_guessing_an_encoding() {
    assert!(
        SourceBundle::capture_declared(
            &binding(false),
            vec![vec![0xff], b"companion".to_vec()],
            "en-US"
        )
        .is_err()
    );
    let binding = binding(true);
    let bundle =
        SourceBundle::capture_declared(&binding, vec![vec![], b"companion".to_vec()], "en-US")
            .unwrap();
    assert!(bundle.files[0].bytes().unwrap().is_empty());
    bundle.validate().unwrap();
}

#[test]
fn selected_files_use_one_bundle_and_required_sets_cannot_be_ignored() {
    let mut binding = binding(true);
    binding.declaration.materials.clear();
    binding.declaration.file_sets = Some(vec![sdk::SourceFileSetDeclaration {
        id: "records".into(),
        display_name: "Record files".into(),
        role: "source".into(),
        encoding: sdk::SourceMaterialEncoding::Binary,
        extensions: vec!["esp".into(), "esm".into(), "esl".into()],
        min_files: 1,
        max_files: 2,
        max_bytes: 131072,
    }]);
    assert!(SourceBundle::capture_declared(&binding, vec![], "en-US").is_err());
    let selections = vec![sdk::SourceFileSetSelection {
        id: "records".into(),
        logical_paths: vec!["Chosen.esl".into(), "Companion.esm".into()],
    }];
    let mut originals = vec![vec![0, 255, 128, 10], vec![42, 0, 255]];
    let bundle =
        SourceBundle::capture_selected(&binding, &selections, originals.clone(), "en-US").unwrap();
    originals[0].fill(0);
    assert_eq!(
        bundle
            .files
            .iter()
            .map(|file| file.logical_path.as_str())
            .collect::<Vec<_>>(),
        ["Chosen.esl", "Companion.esm"]
    );
    assert_eq!(bundle.files[0].bytes().unwrap().as_ref(), [0, 255, 128, 10]);
    assert_eq!(bundle.files[1].bytes().unwrap().as_ref(), [42, 0, 255]);
    bundle.source_input().validate().unwrap();
    let reopened: SourceBundle =
        serde_json::from_slice(&serde_json::to_vec(&bundle).unwrap()).unwrap();
    assert_eq!(reopened, bundle);
    assert!(SourceBundle::capture_selected(&binding, &selections, vec![vec![0]], "en-US").is_err());
}
