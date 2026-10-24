#![cfg(any(target_os = "macos", target_os = "linux"))]
use tsumugi_plugin_host::{CapturedNativeRuntime, HostError};
use tsumugi_plugin_sdk as sdk;

#[test]
fn current_native_capture_matches_the_actual_host_not_a_worker_claim() {
    let approved = CapturedNativeRuntime::inspect_current().unwrap();
    approved.validate().unwrap();
    assert_eq!(approved.host_version, env!("CARGO_PKG_VERSION"));
    #[cfg(target_os = "macos")]
    assert!(matches!(
        approved.executable,
        sdk::NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1(_)
    ));
    #[cfg(target_os = "linux")]
    assert!(matches!(
        approved.executable,
        sdk::NativeHostExecutableIdentity::LinuxExecutableSha256V1(_)
    ));
    let captured = CapturedNativeRuntime::capture(&approved).unwrap();
    assert_eq!(captured.descriptor(), &approved);
    assert_eq!(captured.environment_digest(), approved.digest().unwrap());
    assert_eq!(CapturedNativeRuntime::inspect_current().unwrap(), approved);
}

#[test]
fn native_capture_refuses_foreign_identity_application_version_and_platform() {
    let current = CapturedNativeRuntime::inspect_current().unwrap();
    let mut wrong = vec![current.clone(); 3];
    wrong[0].host_version = "9.0.0".into();
    wrong[1].platform.architecture = match current.platform.architecture {
        sdk::RuntimeArchitecture::Aarch64 => sdk::RuntimeArchitecture::X86_64,
        sdk::RuntimeArchitecture::X86_64 => sdk::RuntimeArchitecture::Aarch64,
    };
    let digest = match &mut wrong[2].executable {
        sdk::NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1(value)
        | sdk::NativeHostExecutableIdentity::LinuxExecutableSha256V1(value) => value,
    };
    digest.replace_range(..1, if digest.starts_with('a') { "b" } else { "a" });
    for value in wrong {
        value.validate().unwrap();
        assert!(matches!(
            CapturedNativeRuntime::capture(&value),
            Err(HostError::RuntimeMismatch)
        ));
    }
    let mut invalid = current;
    invalid.process_protocol += 1;
    assert!(matches!(
        CapturedNativeRuntime::capture(&invalid),
        Err(HostError::InvalidContract)
    ));
}
