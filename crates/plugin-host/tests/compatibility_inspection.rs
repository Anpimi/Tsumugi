#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{cell::Cell, collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path};
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};
use tsumugi_plugin_sdk::{
    CapabilityCompatibilityRequest, CapabilityCompatibilityStatus, ContractRef,
};

fn reference(id: &str, schema_version: u32, behavior_version: u32) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version,
        behavior_version,
    }
}

fn request() -> CapabilityCompatibilityRequest {
    CapabilityCompatibilityRequest {
        contribution_id: "query".into(),
        contract: reference("example.query", 2, 3),
        profile: Some(reference("example.text", 5, 7)),
    }
}

fn package(root: &Path, marker: &Path) -> (Vec<u8>, BTreeMap<String, PackageFile>) {
    let manifest = serde_json::to_vec(&serde_json::json!({
        "protocolVersion": 1,
        "plugin": {"publisher": "org.example", "id": "diagnostic", "version": "0.1.0"},
        "permissions": [{"kind": "captured-input"}],
        "components": [{
            "id": "worker", "scope": "project", "runtime": "native-worker",
            "entrypoint": "worker", "dependencies": [],
            "exit": {"stopTimeoutMs": 100, "cleanupTimeoutMs": 100}
        }],
        "contributions": [{
            "id": "query", "componentId": "worker", "contribution": {
                "kind": "capability", "declaration": {
                    "contract": reference("example.query", 2, 3),
                    "inputSchema": reference("example.input", 1, 1),
                    "outputSchema": reference("example.output", 1, 1),
                    "errorSchema": reference("example.error", 1, 1),
                    "profiles": [reference("example.text", 5, 7)],
                    "effect": "read-only", "permissions": [{"kind": "captured-input"}],
                    "limits": {"maxInputBytes": 1024, "maxOutputBytes": 1024,
                        "concurrency": 1, "timeoutMs": 1000}
                }
            }
        }, {
            "id": "reference", "componentId": "worker", "contribution": {
                "kind": "resource", "schema": reference("example.reference", 1, 1),
                "path": "reference.txt"
            }
        }]
    }))
    .unwrap();
    // Were the native entrypoint executed, it would create a test-owned marker.
    let marker = marker.to_str().unwrap().replace('\'', "'\\''");
    let files = BTreeMap::from([
        (
            "worker".into(),
            PackageFile {
                bytes: format!("#!/bin/sh\n: > '{marker}'\n").into_bytes(),
                executable: true,
            },
        ),
        (
            "reference.txt".into(),
            PackageFile {
                bytes: b"captured reference\n".to_vec(),
                executable: false,
            },
        ),
    ]);
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("manifest.json"), &manifest).unwrap();
    for (name, file) in &files {
        let path = root.join(name);
        fs::write(&path, &file.bytes).unwrap();
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
    }
    (manifest, files)
}

#[test]
fn diagnosis_binds_complete_package_pins_without_running_the_entrypoint() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let marker = temporary.path().join("executed");
    let (manifest, files) = package(&root, &marker);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let image = PackageImage::capture_directory(&root, &digest, || true).unwrap();
    let selection = request();
    let observed =
        PackageImage::inspect_directory_compatibility(&root, &selection, || true).unwrap();
    assert_eq!(observed.package, image.inspection());
    assert_eq!(observed.package.file_count, 3);
    assert_eq!(observed.package.package_digest, digest);
    assert_eq!(observed.compatibility.request, selection);
    assert!(observed.compatibility.is_compatible());
    assert_eq!(
        observed.compatibility.component_id.as_deref(),
        Some("worker")
    );
    assert_eq!(
        observed.compatibility.declared_contract,
        Some(reference("example.query", 2, 3))
    );
    assert_eq!(
        observed.compatibility.declared_profiles,
        vec![reference("example.text", 5, 7)]
    );
    assert!(!marker.exists());
    assert_eq!(fs::read_dir(temporary.path()).unwrap().count(), 1);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 3);
}

#[test]
fn report_preserves_exact_behavior_and_profile_mismatches() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    package(&root, &temporary.path().join("executed"));
    let mut behavior = request();
    behavior.contract.behavior_version += 1;
    let mut profile = request();
    profile.profile.as_mut().unwrap().behavior_version += 1;
    let mut missing_profile = request();
    missing_profile.profile = None;
    for (selection, status) in [
        (
            behavior,
            CapabilityCompatibilityStatus::ContractBehaviorMismatch,
        ),
        (profile, CapabilityCompatibilityStatus::ProfileUnsupported),
        (
            missing_profile,
            CapabilityCompatibilityStatus::ProfileRequired,
        ),
    ] {
        let observed =
            PackageImage::inspect_directory_compatibility(&root, &selection, || true).unwrap();
        assert_eq!(observed.compatibility.status, status);
        assert_eq!(observed.compatibility.request, selection);
        assert!(!observed.compatibility.is_compatible());
        assert_eq!(
            observed.compatibility.declared_contract,
            Some(reference("example.query", 2, 3))
        );
        assert_eq!(
            observed.compatibility.declared_profiles,
            vec![reference("example.text", 5, 7)]
        );
    }
}

#[test]
fn invalid_typed_request_is_refused_before_directory_access() {
    let temporary = tempfile::tempdir().unwrap();
    let checks = Cell::new(0);
    let mut invalid = request();
    invalid.contract.schema_version = 0;
    let result = PackageImage::inspect_directory_compatibility(
        &temporary.path().join("missing"),
        &invalid,
        || {
            checks.set(checks.get() + 1);
            true
        },
    );
    assert_eq!(result.unwrap_err(), HostError::InvalidContract);
    assert_eq!(checks.get(), 0);
}

#[test]
fn diagnosis_and_fingerprint_use_the_same_completed_capture() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let (manifest, _) = package(&root, &temporary.path().join("executed"));
    let checks = Cell::new(0);
    let original = PackageImage::inspect_directory(&root, || {
        checks.set(checks.get() + 1);
        true
    })
    .unwrap();
    let capture_checks = checks.get();
    let mut replacement: serde_json::Value = serde_json::from_slice(&manifest).unwrap();
    replacement["contributions"][0]["contribution"]["declaration"]["contract"]["behaviorVersion"] =
        4.into();
    let replacement = serde_json::to_vec(&replacement).unwrap();
    checks.set(0);
    let observed = PackageImage::inspect_directory_compatibility(&root, &request(), || {
        checks.set(checks.get() + 1);
        // The capture's final read guard runs after both scans and manifest
        // validation. A later pathname must not replace its declaration/pins.
        if checks.get() == capture_checks {
            fs::write(root.join("manifest.json"), &replacement).unwrap();
        }
        true
    })
    .unwrap();
    assert_eq!(checks.get(), capture_checks);
    assert_eq!(observed.package, original);
    assert!(observed.compatibility.is_compatible());
    assert_eq!(
        observed.compatibility.declared_contract,
        Some(reference("example.query", 2, 3))
    );
    let later = PackageImage::inspect_directory_compatibility(&root, &request(), || true).unwrap();
    assert_ne!(later.package.package_digest, original.package_digest);
    assert_eq!(
        later.compatibility.status,
        CapabilityCompatibilityStatus::ContractBehaviorMismatch
    );
}

#[test]
fn captured_image_diagnosis_remains_usable_after_the_source_is_removed() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let (manifest, files) = package(&root, &temporary.path().join("executed"));
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let image = PackageImage::capture_directory(&root, &digest, || true).unwrap();
    let original = image.inspection();
    fs::remove_dir_all(&root).unwrap();
    let observed = image.compatibility_inspection(&request()).unwrap();
    assert_eq!(observed.package, original);
    assert!(observed.compatibility.is_compatible());
}

#[test]
fn revoked_read_guard_and_observed_source_replacement_return_no_report() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let marker = temporary.path().join("executed");
    package(&root, &marker);
    assert_eq!(
        PackageImage::inspect_directory_compatibility(&root, &request(), || false).unwrap_err(),
        HostError::AuthorityRevoked
    );
    let checks = Cell::new(0);
    let observed = PackageImage::inspect_directory_compatibility(&root, &request(), || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            // The original root is already held when its first walk begins.
            fs::rename(&root, temporary.path().join("previous")).unwrap();
            package(&root, &marker);
        }
        true
    });
    assert_eq!(observed.unwrap_err(), HostError::PackageChanged);
    assert!(!marker.exists());
}
