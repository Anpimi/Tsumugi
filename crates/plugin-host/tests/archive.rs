use std::{
    collections::BTreeMap,
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use tsumugi_plugin_host::{HostError, PackageFile, PackageImage};

fn manifest() -> Vec<u8> {
    br#"{"protocolVersion":1,"plugin":{"publisher":"example","id":"archive-data","version":"0.1.0"},"permissions":[],"components":[{"id":"data","scope":"project","runtime":"data","entrypoint":null,"dependencies":[],"exit":{"stopTimeoutMs":100,"cleanupTimeoutMs":100}}],"contributions":[{"id":"data.resource","componentId":"data","contribution":{"kind":"resource","schema":{"id":"example.data","schemaVersion":1,"behaviorVersion":1},"path":"resource.bin"}}]}"#.to_vec()
}

fn fixture(executable: bool) -> (Vec<u8>, String) {
    let manifest = manifest();
    let files = BTreeMap::from([
        (
            "resource.bin".into(),
            PackageFile {
                bytes: vec![0, 255, 13, 10],
                executable: false,
            },
        ),
        (
            "tool.bin".into(),
            PackageFile {
                bytes: b"intentionally not executable program bytes".to_vec(),
                executable,
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    let mut archive = tar::Builder::new(Vec::new());
    for (path, file) in std::iter::once((
        "manifest.json".to_owned(),
        PackageFile {
            bytes: manifest,
            executable: false,
        },
    ))
    .chain(files)
    {
        let mut header = tar::Header::new_ustar();
        header.set_path(path).unwrap();
        header.set_size(file.bytes.len() as u64);
        header.set_mode(if file.executable { 0o755 } else { 0o644 });
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        archive.append(&header, file.bytes.as_slice()).unwrap();
    }
    (archive.into_inner().unwrap(), digest)
}

#[test]
fn archive_and_memory_images_share_the_original_package_digest() {
    let (bytes, digest) = fixture(true);
    let image = PackageImage::capture_archive(&bytes, &digest, || true).unwrap();
    let inspection = PackageImage::inspect_archive(&bytes, || true).unwrap();
    assert_eq!(image.package_digest(), digest);
    assert_eq!(inspection, image.inspection());
    assert_eq!(inspection.file_count, 3);
    assert_eq!(inspection.plugin.id, "archive-data");
    assert!(matches!(
        PackageImage::capture_archive(&bytes, &"0".repeat(64), || true),
        Err(HostError::PackageMismatch)
    ));
    let (changed, _) = fixture(false);
    assert!(matches!(
        PackageImage::capture_archive(&changed, &digest, || true),
        Err(HostError::PackageMismatch)
    ));
    assert!(matches!(
        PackageImage::capture_archive(&bytes, &digest, || false),
        Err(HostError::AuthorityRevoked)
    ));
}

#[test]
fn captured_image_stays_fixed_after_transport_bytes_are_replaced() {
    let (mut bytes, digest) = fixture(true);
    let image = PackageImage::capture_archive(&bytes, &digest, || true).unwrap();
    let inspection = image.inspection();
    bytes.fill(0);
    assert_eq!(image.inspection(), inspection);
    assert!(PackageImage::inspect_archive(&bytes, || true).is_err());
}

#[test]
fn deterministic_encoding_preserves_the_captured_image_and_approved_digest() {
    let (bytes, digest) = fixture(true);
    let image = PackageImage::capture_archive(&bytes, &digest, || true).unwrap();
    let encoded = image.encode_archive(|| true).unwrap();
    assert_eq!(encoded, image.encode_archive(|| true).unwrap());
    let recaptured = PackageImage::capture_archive(&encoded, &digest, || true).unwrap();
    assert_eq!(recaptured.inspection(), image.inspection());
    assert_eq!(
        image.encode_archive(|| false).err(),
        Some(HostError::AuthorityRevoked)
    );
}

#[test]
fn cli_reads_the_selected_archive_from_stdin_without_extracting() {
    let (bytes, digest) = fixture(true);
    let temporary = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tsumugi-plugin-package"))
        .arg("inspect-archive")
        .current_dir(temporary.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&bytes).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("archive inspection exceeded its bounded CLI test lifetime");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["packageDigest"], digest);
    assert_eq!(std::fs::read_dir(temporary.path()).unwrap().count(), 0);
}
