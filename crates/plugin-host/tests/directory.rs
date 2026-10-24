#![cfg(any(target_os = "macos", target_os = "linux"))]
use std::{
    cell::Cell,
    collections::BTreeMap,
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::Path,
};
use tsumugi_plugin_host::*;

fn package(root: &Path) -> String {
    let manifest = br#"{"protocolVersion":1,"plugin":{"publisher":"example","id":"local-data","version":"0.1.0"},"permissions":[],"components":[{"id":"data","scope":"project","runtime":"data","entrypoint":null,"dependencies":[],"exit":{"stopTimeoutMs":100,"cleanupTimeoutMs":100}}],"contributions":[{"id":"data.resource","componentId":"data","contribution":{"kind":"resource","schema":{"id":"example.data","schemaVersion":1,"behaviorVersion":1},"path":"data/resource.bin"}}]}"#;
    let files = BTreeMap::from([
        (
            "data/resource.bin".into(),
            PackageFile {
                bytes: vec![0, 255, 13, 10, 42],
                executable: false,
            },
        ),
        (
            "bin/tool".into(),
            PackageFile {
                // Capturing an executable never runs its bytes.
                bytes: b"this is deliberately not a program".to_vec(),
                executable: true,
            },
        ),
    ]);
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("manifest.json"), manifest).unwrap();
    for (name, file) in &files {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &file.bytes).unwrap();
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
        )
        .unwrap();
    }
    PackageImage::digest(manifest, &files).unwrap()
}
fn rejects(root: &Path, digest: &str, error: HostError) {
    assert!(
        matches!(PackageImage::capture_directory(root, digest, || true), Err(actual) if actual == error)
    );
}

#[test]
fn captures_binary_bytes_executable_bits_and_independent_digest() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let digest = package(&root);
    let image = PackageImage::capture_directory(&root, &digest, || true).unwrap();
    assert_eq!(image.package_digest(), digest);
    assert_eq!(image.manifest().manifest().plugin.id, "local-data");
    rejects(&root, &"0".repeat(64), HostError::PackageMismatch);
    fs::set_permissions(root.join("bin/tool"), fs::Permissions::from_mode(0o600)).unwrap();
    rejects(&root, &digest, HostError::PackageMismatch);
    // The successful snapshot remains fixed after its source is changed.
    assert_eq!(image.package_digest(), digest);
}

#[test]
fn inspection_uses_the_capture_owner_and_returns_only_a_candidate_fingerprint() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("candidate");
    let expected = package(&root);
    let inspection = PackageImage::inspect_directory(&root, || true).unwrap();
    assert_eq!(inspection.package_digest, expected);
    assert_eq!(inspection.plugin.id, "local-data");
    assert_eq!(inspection.file_count, 3);
    assert_eq!(inspection.manifest_sha256.len(), 64);
    assert_eq!(
        inspection.byte_count,
        fs::metadata(root.join("manifest.json")).unwrap().len()
            + fs::metadata(root.join("data/resource.bin")).unwrap().len()
            + fs::metadata(root.join("bin/tool")).unwrap().len()
    );
    // Both entrypoints reject the same unsafe source and live read revocation.
    std::os::unix::fs::symlink(&root, temporary.path().join("link")).unwrap();
    assert_eq!(
        PackageImage::inspect_directory(&temporary.path().join("link"), || true).unwrap_err(),
        HostError::PackagePath
    );
    assert_eq!(
        PackageImage::inspect_directory(&root, || false).unwrap_err(),
        HostError::AuthorityRevoked
    );
    fs::write(root.join("data/resource.bin"), [42, 0]).unwrap();
    assert_ne!(
        PackageImage::inspect_directory(&root, || true)
            .unwrap()
            .package_digest,
        inspection.package_digest
    );
    assert_eq!(
        PackageImage::capture_directory(&root, &expected, || true).err(),
        Some(HostError::PackageMismatch)
    );
}

#[test]
fn rejects_root_ancestor_and_file_links_hardlinks_and_special_files() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let digest = package(&root);
    std::os::unix::fs::symlink(&root, temporary.path().join("link")).unwrap();
    rejects(
        &temporary.path().join("link"),
        &digest,
        HostError::PackagePath,
    );
    rejects(
        &temporary.path().join("link/data"),
        &digest,
        HostError::PackagePath,
    );
    let resource = root.join("data/resource.bin");
    fs::rename(&resource, temporary.path().join("outside")).unwrap();
    std::os::unix::fs::symlink(temporary.path().join("outside"), &resource).unwrap();
    rejects(&root, &digest, HostError::PackagePath);
    fs::remove_file(&resource).unwrap();
    fs::hard_link(temporary.path().join("outside"), &resource).unwrap();
    rejects(&root, &digest, HostError::PackagePath);
    fs::remove_file(&resource).unwrap();
    let name = CString::new(resource.as_os_str().as_bytes()).unwrap();
    // A FIFO is rejected without waiting for a writer.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    rejects(&root, &digest, HostError::PackagePath);
    fs::remove_file(&resource).unwrap();
    fs::write(&resource, [0, 255, 13, 10, 42]).unwrap();
    let _socket = std::os::unix::net::UnixListener::bind(root.join("s")).unwrap();
    rejects(&root, &digest, HostError::PackagePath);
}

#[test]
fn rejects_portable_aliases_and_reserved_materialization_names() {
    for name in [
        "CON",
        "nul.txt",
        "COM1.bin",
        "Lpt9",
        "data.",
        "data ",
        "non-ascii-中",
        "MANIFEST.JSON",
    ] {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("package");
        let digest = package(&root);
        if name == "MANIFEST.JSON" {
            fs::rename(root.join("manifest.json"), root.join(name)).unwrap();
        } else {
            fs::write(root.join(name), b"extra").unwrap();
        }
        rejects(&root, &digest, HostError::PackagePath);
        let files = BTreeMap::from([(
            name.into(),
            PackageFile {
                bytes: vec![1],
                executable: false,
            },
        )]);
        assert_eq!(
            PackageImage::digest(b"{}", &files).unwrap_err(),
            HostError::PackagePath
        );
    }
}

#[test]
fn bounds_files_directories_depth_and_actual_bytes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let digest = package(&root);
    for i in 0..256 {
        fs::write(root.join(format!("extra-{i}")), []).unwrap();
    }
    rejects(&root, &digest, HostError::PackageLimit);
    let root = temporary.path().join("directories");
    let digest = package(&root);
    for i in 0..256 {
        fs::create_dir(root.join(format!("extra-{i}"))).unwrap();
    }
    rejects(&root, &digest, HostError::PackageLimit);
    let root = temporary.path().join("deep");
    let digest = package(&root);
    let mut path = root.clone();
    for _ in 0..17 {
        path.push("nested");
    }
    fs::create_dir_all(path).unwrap();
    rejects(&root, &digest, HostError::PackageLimit);
    let root = temporary.path().join("large");
    let digest = package(&root);
    // Sparse oversized data must be rejected before it is read or allocated.
    fs::File::create(root.join("data/resource.bin"))
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    rejects(&root, &digest, HostError::PackageLimit);
    fs::write(root.join("manifest.json"), vec![b' '; 256 * 1024 + 1]).unwrap();
    rejects(&root, &digest, HostError::PackageLimit);
}

#[test]
fn revocation_and_observed_root_or_content_replacement_return_no_image() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("package");
    let digest = package(&root);
    rejects(
        &Path::new("relative-package"),
        &digest,
        HostError::PackagePath,
    );
    assert!(matches!(
        PackageImage::capture_directory(&root, &digest, || false),
        Err(HostError::AuthorityRevoked)
    ));
    let checks = Cell::new(0);
    assert!(matches!(
        PackageImage::capture_directory(&root, &digest, || {
            checks.set(checks.get() + 1);
            checks.get() < 12
        }),
        Err(HostError::AuthorityRevoked)
    ));

    // A deterministic read-guard checkpoint changes the selected root while
    // its first scan is in progress. The held directory cannot conceal this.
    let checks = Cell::new(0);
    assert!(matches!(
        PackageImage::capture_directory(&root, &digest, || {
            checks.set(checks.get() + 1);
            if checks.get() == 12 {
                fs::rename(&root, temporary.path().join("previous")).unwrap();
                package(&root);
            }
            true
        }),
        Err(HostError::PackageChanged)
    ));
    let checks = Cell::new(0);
    assert!(matches!(
        PackageImage::capture_directory(&root, &digest, || {
            checks.set(checks.get() + 1);
            if checks.get() == 12 {
                fs::write(root.join("bin/tool"), b"equal-length malicious substitute!").unwrap();
            }
            true
        }),
        Err(HostError::PackageChanged | HostError::PackageMismatch)
    ));
}
