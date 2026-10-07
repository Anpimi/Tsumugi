use std::collections::BTreeMap;
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

fn manifest() -> sdk::PluginManifest {
    serde_json::from_slice(include_bytes!(
        "../../plugin-sdk/tests/fixtures/tool.manifest.json"
    ))
    .unwrap()
}
fn files() -> BTreeMap<String, PackageFile> {
    [
        ("component.mjs", b"export default {};".as_slice()),
        (
            "tool.json",
            include_bytes!("../../plugin-sdk/tests/fixtures/tool.declaration.json").as_slice(),
        ),
        ("terms.bin", &[0, 255, 1]),
        (
            "guidance.md",
            b"Untrusted guidance grants no tools.".as_slice(),
        ),
    ]
    .into_iter()
    .map(|(path, bytes)| {
        (
            path.into(),
            PackageFile {
                bytes: bytes.to_vec(),
                executable: false,
            },
        )
    })
    .collect()
}
fn capture(manifest: sdk::PluginManifest, files: BTreeMap<String, PackageFile>) -> PackageImage {
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}

#[test]
fn captured_tool_resolves_original_capability_and_opaque_support_without_activation() {
    let image = capture(manifest(), files());
    let binding = image.capability_tool("query-tool").unwrap();
    assert_eq!(
        binding.capability,
        sdk::bind_capability(image.manifest(), "query", image.package_digest()).unwrap()
    );
    assert_eq!(
        image
            .resource_bytes("terms", &binding.resources[0].schema)
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(
        image
            .skill_bytes(binding.declaration.skill.as_deref().unwrap())
            .unwrap(),
        b"Untrusted guidance grants no tools."
    );
    assert_eq!(
        binding.capability.provider.package_digest,
        image.package_digest()
    );
    assert_eq!(
        binding.declaration.profile,
        Some(binding.capability.declaration.profiles[0].clone())
    );
    assert_eq!(
        image.capability_tool("query"),
        Err(HostError::InvalidContract)
    );
    assert_eq!(
        image.capability_tool("missing"),
        Err(HostError::InvalidContract)
    );
}

#[test]
fn captured_tool_refuses_wrong_resource_versions_executable_support_and_malformed_metadata() {
    for change in 0..7 {
        let mut manifest = manifest();
        let mut files = files();
        match change {
            0 | 1 => {
                let sdk::ContributionKind::Resource { schema, .. } =
                    &mut manifest.contributions[3].contribution
                else {
                    unreachable!()
                };
                if change == 0 {
                    schema.schema_version += 1;
                } else {
                    schema.behavior_version += 1;
                }
            }
            2 => files.get_mut("tool.json").unwrap().executable = true,
            3 => files.get_mut("terms.bin").unwrap().executable = true,
            4 => files.get_mut("guidance.md").unwrap().executable = true,
            5 => files.get_mut("tool.json").unwrap().bytes = b"{\"grant\":true}".to_vec(),
            _ => {
                files.get_mut("tool.json").unwrap().bytes =
                    vec![b' '; sdk::MAX_TOOL_DECLARATION_BYTES + 1]
            }
        }
        let image = capture(manifest, files);
        assert_eq!(
            image.capability_tool("query-tool"),
            Err(HostError::InvalidContract),
            "case {change}"
        );
    }
}

#[test]
fn replacement_support_bytes_change_the_whole_package_binding_without_mutating_original_image() {
    let original = capture(manifest(), files());
    let a = original.capability_tool("query-tool").unwrap();
    let mut replacement = files();
    replacement.get_mut("terms.bin").unwrap().bytes = vec![4, 5, 6];
    let replacement = capture(manifest(), replacement);
    let b = replacement.capability_tool("query-tool").unwrap();
    assert_eq!(a.declaration, b.declaration);
    assert_eq!(a.capability.declaration, b.capability.declaration);
    assert_ne!(
        a.capability.provider.package_digest,
        b.capability.provider.package_digest
    );
    assert_eq!(
        original
            .resource_bytes("terms", &a.resources[0].schema)
            .unwrap(),
        &[0, 255, 1]
    );
    assert_eq!(original.capability_tool("query-tool").unwrap(), a);
}
