#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::{
    cell::Cell,
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tsumugi_plugin_host::*;
use tsumugi_plugin_sdk::{ContractRef, PluginIdentity};

fn identity(id: &str) -> PluginIdentity {
    PluginIdentity {
        publisher: "example".into(),
        id: id.into(),
        version: "0.1.0".into(),
    }
}

fn manifest(id: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "protocolVersion": 1,
        "plugin": identity(id),
        "permissions": [],
        "components": [{
            "id": "data", "scope": "project", "runtime": "data",
            "entrypoint": null, "dependencies": [],
            "exit": {"stopTimeoutMs": 100, "cleanupTimeoutMs": 100}
        }],
        "contributions": [{
            "id": "data.resource", "componentId": "data",
            "contribution": {
                "kind": "resource",
                "schema": {"id": "example.data", "schemaVersion": 1, "behaviorVersion": 1},
                "path": "data/resource.bin"
            }
        }]
    }))
    .unwrap()
}

fn package(root: &Path, directory: &str, id: &str, payload: Vec<u8>) -> OfflinePackMember {
    let manifest = manifest(id);
    let files = BTreeMap::from([(
        "data/resource.bin".into(),
        PackageFile {
            bytes: payload,
            executable: false,
        },
    )]);
    let package_root = root.join(directory);
    fs::create_dir_all(package_root.join("data")).unwrap();
    fs::write(package_root.join("manifest.json"), &manifest).unwrap();
    for (name, file) in &files {
        let path = package_root.join(name);
        fs::write(&path, &file.bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    OfflinePackMember {
        directory: directory.into(),
        plugin: identity(id),
        package_digest: PackageImage::digest(&manifest, &files).unwrap(),
    }
}

fn descriptor(packages: Vec<OfflinePackMember>) -> OfflinePackDescriptor {
    OfflinePackDescriptor {
        format_version: 1,
        id: "example.offline".into(),
        display_name: "Example offline pack".into(),
        packages,
    }
}

fn write_descriptor(root: &Path, descriptor: &OfflinePackDescriptor) -> Vec<u8> {
    let raw = serde_json::to_vec(descriptor).unwrap();
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("pack.json"), &raw).unwrap();
    raw
}

fn single_pack(root: &Path) -> OfflinePackDescriptor {
    let descriptor = descriptor(vec![package(root, "alpha", "alpha", vec![0, 255, 13, 10])]);
    write_descriptor(root, &descriptor);
    descriptor
}

fn rejects(root: &Path, expected: HostError) {
    assert_eq!(
        CapturedOfflinePack::capture_directory(root, || true).err(),
        Some(expected)
    );
}

fn resource(image: &PackageImage) -> &[u8] {
    image
        .resource_bytes(
            "data.resource",
            &ContractRef {
                id: "example.data".into(),
                schema_version: 1,
                behavior_version: 1,
            },
        )
        .unwrap()
}

#[test]
fn captures_two_pinned_members_in_descriptor_order_without_changing_the_source() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    let alpha = package(&root, "alpha", "alpha", vec![0, 255, 13, 10]);
    let beta = package(&root, "beta", "beta", b"independent resource".to_vec());
    let expected = descriptor(vec![beta.clone(), alpha.clone()]);
    let raw = write_descriptor(&root, &expected);

    let captured = CapturedOfflinePack::capture_directory(&root, || true).unwrap();
    assert_eq!(captured.descriptor(), &expected);
    assert_eq!(
        captured.descriptor_digest(),
        format!("{:x}", Sha256::digest(&raw))
    );
    assert_eq!(captured.packages().len(), 2);
    assert_eq!(captured.packages()[0].package_digest(), beta.package_digest);
    assert_eq!(
        captured.packages()[1].package_digest(),
        alpha.package_digest
    );
    assert_eq!(fs::read(root.join("pack.json")).unwrap(), raw);
    assert_eq!(
        fs::read(root.join("alpha/data/resource.bin")).unwrap(),
        [0, 255, 13, 10]
    );
    assert_eq!(
        fs::read(root.join("beta/data/resource.bin")).unwrap(),
        b"independent resource"
    );

    // The descriptor and both resources remain usable after the whole source
    // disappears; no later inspection can silently reopen a member directory.
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(captured.descriptor(), &expected);
    assert_eq!(resource(&captured.packages()[0]), b"independent resource");
    assert_eq!(resource(&captured.packages()[1]), [0, 255, 13, 10]);
}

#[test]
fn rejects_a_wrong_digest_or_any_different_member_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    let expected = single_pack(&root);
    let mut changed = expected.clone();
    changed.packages[0].package_digest = "0".repeat(64);
    write_descriptor(&root, &changed);
    rejects(&root, HostError::PackageMismatch);

    for field in ["publisher", "id", "version"] {
        let mut changed = expected.clone();
        match field {
            "publisher" => changed.packages[0].plugin.publisher = "another".into(),
            "id" => changed.packages[0].plugin.id = "another".into(),
            "version" => changed.packages[0].plugin.version = "0.2.0".into(),
            _ => unreachable!(),
        }
        write_descriptor(&root, &changed);
        rejects(&root, HostError::PackageMismatch);
    }
    write_descriptor(&root, &expected);
    fs::write(root.join("alpha/data/resource.bin"), b"substituted").unwrap();
    rejects(&root, HostError::PackageMismatch);
}

#[test]
fn accepts_sixteen_members_and_rejects_empty_or_larger_selections() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    let mut expected = descriptor(Vec::new());
    write_descriptor(&root, &expected);
    rejects(&root, HostError::PackageLimit);
    for index in 0..MAX_PACK_MEMBERS {
        let name = format!("member-{index}");
        expected
            .packages
            .push(package(&root, &name, &name, vec![index as u8]));
    }
    write_descriptor(&root, &expected);
    assert_eq!(
        CapturedOfflinePack::capture_directory(&root, || true)
            .unwrap()
            .packages()
            .len(),
        16
    );
    expected
        .packages
        .push(package(&root, "extra", "extra", vec![17]));
    write_descriptor(&root, &expected);
    rejects(&root, HostError::PackageLimit);
}

#[test]
fn rejects_duplicate_directories_and_logical_plugin_ids() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    let expected = descriptor(vec![
        package(&root, "alpha", "alpha", vec![1]),
        package(&root, "beta", "beta", vec![2]),
    ]);
    for alias in ["alpha", "ALPHA"] {
        let mut changed = expected.clone();
        changed.packages[1].directory = alias.into();
        write_descriptor(&root, &changed);
        rejects(&root, HostError::PackagePath);
    }
    let mut changed = expected;
    changed.packages[1].plugin = PluginIdentity {
        publisher: "another".into(),
        id: "alpha".into(),
        version: "0.2.0".into(),
    };
    write_descriptor(&root, &changed);
    rejects(&root, HostError::PackagePath);
}

#[test]
fn rejects_traversal_nested_paths_and_nonportable_member_names() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    let expected = single_pack(&root);
    for directory in [
        "../outside",
        "alpha/child",
        "alpha\\child",
        "PACK.JSON",
        "CON",
        "alpha.",
    ] {
        let mut changed = expected.clone();
        changed.packages[0].directory = directory.into();
        write_descriptor(&root, &changed);
        rejects(&root, HostError::PackagePath);
    }
    rejects(Path::new("relative-pack"), HostError::PackagePath);
}

#[test]
fn rejects_malformed_unknown_and_invalid_descriptor_fields() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    let expected = single_pack(&root);
    let baseline = serde_json::to_value(&expected).unwrap();
    let mut invalid = Vec::<Value>::new();
    for (field, value) in [
        ("formatVersion", json!(2)),
        ("id", json!("bad/id")),
        ("displayName", json!(" \n ")),
        ("displayName", json!("name\u{0}suffix")),
        ("unexpected", json!(true)),
    ] {
        let mut changed = baseline.clone();
        changed[field] = value;
        invalid.push(changed);
    }
    let mut changed = baseline.clone();
    changed["packages"][0]["unexpected"] = json!(true);
    invalid.push(changed);
    let mut changed = baseline.clone();
    changed["packages"][0]["packageDigest"] = json!("not-a-digest");
    invalid.push(changed);
    let mut changed = baseline;
    changed["packages"][0]["plugin"]["version"] = json!("not-a-version");
    invalid.push(changed);
    for changed in invalid {
        fs::write(
            root.join("pack.json"),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        rejects(&root, HostError::InvalidContract);
    }
    fs::write(root.join("pack.json"), b"{").unwrap();
    rejects(&root, HostError::InvalidContract);
    fs::remove_file(root.join("pack.json")).unwrap();
    rejects(&root, HostError::MissingArtifact);
}

#[test]
fn rejects_linked_roots_members_descriptor_and_hardlinked_files() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    single_pack(&root);
    let alias = temporary.path().join("alias");
    symlink(&root, &alias).unwrap();
    rejects(&alias, HostError::PackagePath);
    rejects(&alias.join("alpha"), HostError::PackagePath);

    for target in ["alpha", "pack.json", "alpha/data/resource.bin"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("pack");
        single_pack(&root);
        let outside = temporary.path().join("outside");
        fs::rename(root.join(target), &outside).unwrap();
        symlink(&outside, root.join(target)).unwrap();
        rejects(&root, HostError::PackagePath);
    }
    for target in ["pack.json", "alpha/data/resource.bin"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("pack");
        single_pack(&root);
        fs::hard_link(root.join(target), temporary.path().join("outside")).unwrap();
        rejects(&root, HostError::PackagePath);
    }
}

#[test]
fn rejects_unlisted_files_and_executable_descriptor() {
    for name in ["extra.bin", "unlisted/data.bin"] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("pack");
        single_pack(&root);
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, []).unwrap();
        rejects(&root, HostError::PackagePath);
    }
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    single_pack(&root);
    fs::set_permissions(root.join("pack.json"), fs::Permissions::from_mode(0o700)).unwrap();
    rejects(&root, HostError::PackagePath);
}

#[test]
fn bounds_descriptor_and_aggregate_actual_bytes_at_the_exact_limits() {
    assert_eq!(MAX_PACK_BYTES, 64 * 1024 * 1024);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("descriptor-boundary");
    let expected = single_pack(&root);
    let mut raw = write_descriptor(&root, &expected);
    raw.resize(64 * 1024, b' ');
    fs::write(root.join("pack.json"), &raw).unwrap();
    assert!(CapturedOfflinePack::capture_directory(&root, || true).is_ok());
    raw.push(b' ');
    fs::write(root.join("pack.json"), &raw).unwrap();
    rejects(&root, HostError::PackageLimit);

    let root = temporary.path().join("aggregate-boundary");
    let mut expected = descriptor(vec![
        package(&root, "alpha", "alpha", Vec::new()),
        package(&root, "beta", "beta", Vec::new()),
    ]);
    let overhead =
        write_descriptor(&root, &expected).len() + manifest("alpha").len() + manifest("beta").len();
    let first_size = (MAX_PACK_BYTES - overhead) / 2;
    let second_size = MAX_PACK_BYTES - overhead - first_size;
    expected.packages[0] = package(&root, "alpha", "alpha", vec![0; first_size]);
    expected.packages[1] = package(&root, "beta", "beta", vec![0; second_size]);
    let raw = write_descriptor(&root, &expected);
    let captured = CapturedOfflinePack::capture_directory(&root, || true).unwrap();
    assert_eq!(
        captured
            .packages()
            .iter()
            .map(|image| image.inspection().byte_count)
            .sum::<u64>()
            + raw.len() as u64,
        MAX_PACK_BYTES as u64
    );
    drop(captured);
    // Each member remains below the package ceiling. Only the total tree,
    // including pack.json and both manifests, now exceeds the Pack ceiling.
    fs::OpenOptions::new()
        .write(true)
        .open(root.join("beta/data/resource.bin"))
        .unwrap()
        .set_len(second_size as u64 + 1)
        .unwrap();
    rejects(&root, HostError::PackageLimit);
}

#[test]
fn bounds_the_whole_tree_file_directory_counts_and_depth() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("files");
    single_pack(&root);
    for index in 0..1024 {
        fs::write(root.join(format!("extra-{index}")), []).unwrap();
    }
    rejects(&root, HostError::PackageLimit);

    let root = temporary.path().join("directories");
    single_pack(&root);
    for index in 0..1024 {
        fs::create_dir(root.join(format!("extra-{index}"))).unwrap();
    }
    rejects(&root, HostError::PackageLimit);

    let root = temporary.path().join("depth");
    single_pack(&root);
    let mut nested = root.clone();
    for _ in 0..18 {
        nested.push("nested");
    }
    fs::create_dir_all(nested).unwrap();
    rejects(&root, HostError::PackageLimit);
}

#[test]
fn returns_no_snapshot_when_authority_is_revoked_during_or_after_capture() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pack");
    single_pack(&root);
    let checks = Cell::new(0);
    CapturedOfflinePack::capture_directory(&root, || {
        checks.set(checks.get() + 1);
        true
    })
    .unwrap();
    let complete = checks.get();
    assert!(complete > 2);
    // Calibrate the checkpoints from a successful read of this same tree so
    // the final case reaches the Pack's last authorization check, after all
    // descriptor and member validation, without depending on a magic count.
    for revoked_at in [1, complete / 2, complete] {
        checks.set(0);
        assert_eq!(
            CapturedOfflinePack::capture_directory(&root, || {
                checks.set(checks.get() + 1);
                checks.get() < revoked_at
            })
            .err(),
            Some(HostError::AuthorityRevoked)
        );
        assert_eq!(checks.get(), revoked_at);
    }
}

#[test]
fn enforces_the_original_per_member_directory_limit_at_the_exact_boundary() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("directories-at-limit");
    let expected = descriptor(vec![package(&root, "alpha", "alpha", vec![1])]);
    let member_root = root.join("alpha");
    // `data` plus 254 empty directories gives 255 child directories; the
    // member root is the 256th directory counted by the package limit.
    for index in 0..254 {
        fs::create_dir(member_root.join(format!("empty-{index}"))).unwrap();
    }
    write_descriptor(&root, &expected);
    assert!(CapturedOfflinePack::capture_directory(&root, || true).is_ok());

    // One more empty child exceeds the per-member limit while the whole Pack
    // remains far below its 1024-directory scan limit.
    fs::create_dir(member_root.join("empty-254")).unwrap();
    rejects(&root, HostError::PackageLimit);

    let root = temporary.path().join("payload-directories-over-limit");
    let plugin_id = "many-files";
    let package_root = root.join(plugin_id);
    let manifest_bytes = manifest(plugin_id);
    let mut files = BTreeMap::new();
    files.insert(
        "data/resource.bin".into(),
        PackageFile {
            bytes: vec![0],
            executable: false,
        },
    );
    for index in 0..255 {
        files.insert(
            format!("payload-{index:03}/file.bin"),
            PackageFile {
                bytes: vec![index as u8],
                executable: false,
            },
        );
    }
    assert_eq!(files.len(), 256);
    let package_digest = PackageImage::digest(&manifest_bytes, &files).unwrap();

    fs::create_dir_all(&package_root).unwrap();
    fs::write(package_root.join("manifest.json"), &manifest_bytes).unwrap();
    for (name, file) in &files {
        let path = package_root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &file.bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let expected = descriptor(vec![OfflinePackMember {
        directory: plugin_id.into(),
        plugin: identity(plugin_id),
        package_digest,
    }]);
    write_descriptor(&root, &expected);

    // All 256 valid payload files occupy separate first-level directories.
    // Pack preview must reject the member's 257 total directories instead of
    // returning a snapshot that installation will later reject.
    rejects(&root, HostError::PackageLimit);
}
