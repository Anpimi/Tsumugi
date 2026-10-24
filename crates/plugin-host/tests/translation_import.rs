use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk::*;

#[test]
fn captured_translation_resource_binds_metadata_without_loading_domain_code() {
    let manifest =
        include_bytes!("../../plugin-sdk/tests/fixtures/translation-import.manifest.json").to_vec();
    let resource =
        include_bytes!("../../plugin-sdk/tests/fixtures/translation-import.declaration.json")
            .to_vec();
    let image = |bytes: Vec<u8>| {
        let files = BTreeMap::from([
            (
                "component.mjs".into(),
                PackageFile {
                    bytes: b"// metadata-only; not executed".to_vec(),
                    executable: false,
                },
            ),
            (
                "translation-profile.json".into(),
                PackageFile {
                    bytes,
                    executable: false,
                },
            ),
        ]);
        let digest = PackageImage::digest(&manifest, &files).unwrap();
        PackageImage::capture(manifest.clone(), files, &digest).unwrap()
    };
    let package = image(resource);
    let bound = package.translation_import("translation-profile").unwrap();
    assert_eq!(
        bound.extractor.provider.package_digest,
        package.package_digest()
    );
    assert_eq!(
        bound.checker.provider.package_digest,
        package.package_digest()
    );
    let input = parse_translation_extraction_input(include_bytes!(
        "../../plugin-sdk/tests/fixtures/translation-extraction.input.json"
    ))
    .unwrap();
    bound.validate_input(&input).unwrap();
    assert!(matches!(
        package.translation_import("extract"),
        Err(HostError::InvalidContract)
    ));
    assert!(matches!(
        package.source_import("translation-profile"),
        Err(HostError::InvalidContract)
    ));
    assert!(matches!(
        image(b"{\"grant\":true}".to_vec()).translation_import("translation-profile"),
        Err(HostError::InvalidContract)
    ));
}
