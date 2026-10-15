use serde_json::json;
use tsumugi_plugin_sdk::*;

fn native() -> NativeHostEnvironmentDescriptor {
    NativeHostEnvironmentDescriptor {
        protocol_version: NATIVE_HOST_ENVIRONMENT_PROTOCOL,
        platform: RuntimePlatform {
            operating_system: RuntimeOperatingSystem::Macos,
            architecture: RuntimeArchitecture::Aarch64,
        },
        sdk_version: SDK_VERSION.into(),
        process_protocol: PROCESS_PROTOCOL,
        profile: NativeHostProfile::NativeApplicationHostV1,
        host_version: "0.2.0-alpha.1".into(),
        executable: NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("a".repeat(40)),
    }
}

#[test]
fn native_digest_matches_an_independently_calculated_vector() {
    // Python hashlib over the documented tag, u64 big-endian JSON length and
    // explicitly ordered JSON, independently of SDK serialization/hash code.
    let original = native();
    assert_eq!(
        original.digest().unwrap(),
        "2f95a020864dbac75089b03733c74bf6f2cbd897c6220bba116a6ff587e6fe01"
    );
    let execution = ExecutionEnvironmentDescriptor::from(original.clone());
    let bytes = serde_json::to_vec(&original).unwrap();
    assert_eq!(serde_json::to_vec(&execution).unwrap(), bytes);
    assert_eq!(execution.digest().unwrap(), original.digest().unwrap());
    assert_eq!(
        serde_json::from_slice::<ExecutionEnvironmentDescriptor>(&bytes).unwrap(),
        execution
    );
    // Object input order cannot manufacture a different environment key.
    let value = serde_json::to_value(original.clone()).unwrap();
    let reversed = format!(
        "{{{}}}",
        value
            .as_object()
            .unwrap()
            .iter()
            .rev()
            .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), v))
            .collect::<Vec<_>>()
            .join(",")
    );
    let decoded: NativeHostEnvironmentDescriptor = serde_json::from_str(&reversed).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(decoded.digest().unwrap(), execution.digest().unwrap());
}

#[test]
fn native_identity_platform_and_application_version_are_fixed_choices() {
    let original = native();
    let mut variants = vec![original.clone(); 4];
    variants[0].host_version = "0.2.0-alpha.2".into();
    variants[1].platform.architecture = RuntimeArchitecture::X86_64;
    variants[2].executable =
        NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("b".repeat(40));
    variants[3].platform.operating_system = RuntimeOperatingSystem::Linux;
    variants[3].executable = NativeHostExecutableIdentity::LinuxExecutableSha256V1("a".repeat(64));
    for value in variants {
        assert_ne!(value.digest().unwrap(), original.digest().unwrap());
    }
}

#[test]
fn native_protocol_versions_identity_algorithms_and_hashes_are_checked() {
    let mut bad = vec![native(); 10];
    bad[0].protocol_version += 1;
    bad[1].process_protocol += 1;
    bad[2].sdk_version = "0.1.0".into();
    bad[3].host_version = "latest".into();
    bad[4].executable = NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("A".repeat(40));
    bad[5].executable = NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("a".repeat(64));
    bad[6].executable = NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("0".repeat(40));
    bad[7].executable = NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("g".repeat(40));
    bad[8].executable = NativeHostExecutableIdentity::LinuxExecutableSha256V1("a".repeat(64));
    bad[9].platform.operating_system = RuntimeOperatingSystem::Linux;
    for value in bad {
        assert!(value.validate().is_err());
        assert!(
            ExecutionEnvironmentDescriptor::from(value)
                .digest()
                .is_err()
        );
    }
    let mut old = native();
    old.process_protocol = 2;
    assert_eq!(
        old.validate().unwrap_err().code,
        ContractErrorCode::UnsupportedProtocol
    );
    assert!(old.digest().is_err());
}

#[test]
fn native_decoding_refuses_missing_duplicate_extra_and_cross_profile_fields() {
    let original = serde_json::to_value(native()).unwrap();
    for field in [
        "protocolVersion",
        "platform",
        "sdkVersion",
        "processProtocol",
        "profile",
        "hostVersion",
        "executable",
    ] {
        let mut bad = original.clone();
        bad.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ExecutionEnvironmentDescriptor>(bad).is_err());
    }
    for (field, value) in [
        ("authorization", json!(true)),
        ("environmentDigest", json!("a".repeat(64))),
        ("toolVersion", json!("26.10.0")),
        ("profile", json!("node-system-libraries-v1")),
        (
            "executable",
            json!({"kind":"caller-path","value":"/bin/worker"}),
        ),
        (
            "executable",
            json!({"kind":"darwin-code-directory-hash-v1","value":"a".repeat(40),"path":"/bin/host"}),
        ),
    ] {
        let mut bad = original.clone();
        bad[field] = value;
        assert!(serde_json::from_value::<ExecutionEnvironmentDescriptor>(bad).is_err());
    }
    let duplicate =
        serde_json::to_string(&native())
            .unwrap()
            .replacen("{", "{\"protocolVersion\":1,", 1);
    assert!(serde_json::from_str::<ExecutionEnvironmentDescriptor>(&duplicate).is_err());
}

#[test]
fn linux_complete_executable_hash_uses_standard_sha256_and_refuses_empty_bytes() {
    assert_eq!(
        native_host_executable_sha256(b"abc").unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_ne!(
        native_host_executable_sha256(b"abc\0").unwrap(),
        native_host_executable_sha256(b"abc").unwrap()
    );
    assert!(native_host_executable_sha256(b"").is_err());
}
