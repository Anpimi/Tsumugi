use std::collections::BTreeMap;

use serde_json::json;
use tsumugi_plugin_sdk::*;

fn descriptor() -> RuntimeEnvironmentDescriptor {
    RuntimeEnvironmentDescriptor {
        protocol_version: RUNTIME_ENVIRONMENT_PROTOCOL,
        platform: RuntimePlatform {
            operating_system: RuntimeOperatingSystem::Macos,
            architecture: RuntimeArchitecture::Aarch64,
        },
        sdk_version: env!("CARGO_PKG_VERSION").into(),
        process_protocol: PROCESS_PROTOCOL,
        profile: RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
        tool_version: "26.10.0".into(),
        tool: RuntimeArtifactBinding {
            tree_digest: "a".repeat(64),
            entrypoint: "bin/node".into(),
        },
        host: RuntimeArtifactBinding {
            tree_digest: "b".repeat(64),
            entrypoint: "dist/main.js".into(),
        },
    }
}

fn artifact() -> BTreeMap<String, RuntimeArtifactFile> {
    BTreeMap::from([
        (
            "bin/node".into(),
            RuntimeArtifactFile {
                bytes: vec![1, 0, 255],
                executable: true,
            },
        ),
        (
            "LICENSE".into(),
            RuntimeArtifactFile {
                bytes: b"public license\n".to_vec(),
                executable: false,
            },
        ),
    ])
}

#[test]
fn descriptor_digest_matches_the_independent_profile_vector() {
    let original = descriptor();
    // Independently calculated from the documented domain tag, length and JSON
    // field order, rather than from this implementation's returned bytes.
    assert_eq!(
        original.digest().unwrap(),
        "0c1b4d9cb0087fe0c3d2bf05e5b8d64b7d3b775f4c37a6ff071174b25ea51ed7"
    );
    let mut fields: Vec<_> = serde_json::to_value(&original)
        .unwrap()
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    fields.reverse();
    let reordered = format!(
        "{{{}}}",
        fields
            .into_iter()
            .map(|(name, value)| format!("{}:{}", serde_json::to_string(&name).unwrap(), value))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert_ne!(reordered, serde_json::to_string(&original).unwrap());
    let decoded: RuntimeEnvironmentDescriptor = serde_json::from_str(&reordered).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(decoded.digest().unwrap(), original.digest().unwrap());
}

#[test]
fn node_execution_environment_keeps_its_exact_profile_bytes_and_digest() {
    let node = descriptor();
    let wrapped = ExecutionEnvironmentDescriptor::from(node.clone());
    assert_eq!(
        serde_json::to_vec(&wrapped).unwrap(),
        serde_json::to_vec(&node).unwrap()
    );
    assert_eq!(
        wrapped.digest().unwrap(),
        "0c1b4d9cb0087fe0c3d2bf05e5b8d64b7d3b775f4c37a6ff071174b25ea51ed7"
    );
    assert_eq!(
        serde_json::from_slice::<ExecutionEnvironmentDescriptor>(
            &serde_json::to_vec(&node).unwrap()
        )
        .unwrap(),
        wrapped
    );
}

#[test]
fn every_fixed_environment_choice_participates_in_the_digest() {
    let original = descriptor();
    let mut alternatives = vec![original.clone(); 7];
    alternatives[0].platform.operating_system = RuntimeOperatingSystem::Linux;
    alternatives[1].platform.architecture = RuntimeArchitecture::X86_64;
    alternatives[2].tool_version = "26.9.0".into();
    alternatives[3].tool.tree_digest = "c".repeat(64);
    alternatives[4].tool.entrypoint = "node".into();
    alternatives[5].host.tree_digest = "c".repeat(64);
    alternatives[6].host.entrypoint = "dist/other.js".into();
    let digest = original.digest().unwrap();
    for alternative in alternatives {
        assert_ne!(alternative.digest().unwrap(), digest);
    }
}

#[test]
fn unsupported_protocols_and_invalid_bindings_cannot_be_hashed() {
    let mut bad = vec![descriptor(); 8];
    bad[0].protocol_version += 1;
    bad[1].process_protocol += 1;
    bad[2].sdk_version = "0.1.0".into();
    bad[3].tool_version = "latest".into();
    bad[4].tool.tree_digest = "A".repeat(64);
    bad[5].host.tree_digest.clear();
    bad[6].tool.entrypoint = "/bin/node".into();
    bad[7].host.entrypoint = "../outside.js".into();
    for descriptor in bad {
        assert!(descriptor.validate().is_err());
        assert!(descriptor.digest().is_err());
    }
}

#[test]
fn descriptors_reject_missing_unknown_duplicate_and_unimplemented_fields() {
    let original = serde_json::to_value(descriptor()).unwrap();
    for key in ["profile", "platform", "tool", "host", "toolVersion"] {
        let mut bad = original.clone();
        bad.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<RuntimeEnvironmentDescriptor>(bad).is_err());
    }
    for (key, value) in [
        ("environmentDigest", json!("a".repeat(64))),
        ("authorization", json!(true)),
        ("profile", json!("arbitrary-homebrew")),
        (
            "platform",
            json!({"operatingSystem":"windows","architecture":"aarch64"}),
        ),
    ] {
        let mut bad = original.clone();
        bad[key] = value;
        assert!(serde_json::from_value::<RuntimeEnvironmentDescriptor>(bad).is_err());
    }
    let mut bad = original.clone();
    bad["tool"]["path"] = json!("/developer/tools/node");
    assert!(serde_json::from_value::<RuntimeEnvironmentDescriptor>(bad).is_err());
    let duplicate =
        serde_json::to_string(&descriptor())
            .unwrap()
            .replacen("{", "{\"protocolVersion\":1,", 1);
    assert!(serde_json::from_str::<RuntimeEnvironmentDescriptor>(&duplicate).is_err());
}

#[test]
fn artifact_digest_covers_all_bytes_paths_and_executable_flags() {
    let original = artifact();
    let digest = runtime_artifact_digest(&original).unwrap();
    assert_eq!(
        digest,
        "d97f64ef4a06cd9991e507add4ded20c70adebeb6a932dbec2ce47b2492ab643"
    );
    let mut changed = original.clone();
    changed.get_mut("LICENSE").unwrap().bytes.push(0);
    assert_ne!(runtime_artifact_digest(&changed).unwrap(), digest);
    changed = original.clone();
    changed.get_mut("bin/node").unwrap().executable = false;
    assert_ne!(runtime_artifact_digest(&changed).unwrap(), digest);
    changed = original;
    let entry = changed.remove("bin/node").unwrap();
    changed.insert("bin/another-node".into(), entry);
    assert_ne!(runtime_artifact_digest(&changed).unwrap(), digest);
}

#[test]
fn artifact_digest_rejects_unbounded_or_invalid_input() {
    assert!(runtime_artifact_digest(&BTreeMap::new()).is_err());
    let mut files = artifact();
    files.insert(
        "../outside".into(),
        RuntimeArtifactFile {
            bytes: vec![],
            executable: false,
        },
    );
    assert!(runtime_artifact_digest(&files).is_err());
    let too_many = (0..=MAX_RUNTIME_ARTIFACT_FILES)
        .map(|index| {
            (
                format!("f{index}"),
                RuntimeArtifactFile {
                    bytes: vec![],
                    executable: false,
                },
            )
        })
        .collect();
    assert!(runtime_artifact_digest(&too_many).is_err());
    let oversized = BTreeMap::from([(
        "oversized".into(),
        RuntimeArtifactFile {
            bytes: vec![0; MAX_RUNTIME_ARTIFACT_BYTES + 1],
            executable: false,
        },
    )]);
    assert!(runtime_artifact_digest(&oversized).is_err());
}
