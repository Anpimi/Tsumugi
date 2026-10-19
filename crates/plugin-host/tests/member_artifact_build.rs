#![cfg(any(target_os = "macos", target_os = "linux"))]
//! Exercise the actual desktop build owner without compiling or launching Tauri.
use std::{fs, path::Path};

#[allow(dead_code)]
#[path = "../../../apps/desktop/src-tauri/runtime_bundle.rs"]
mod build_owner;

fn copy_fixture(source: &Path, target: &Path) {
    let metadata = fs::symlink_metadata(source).unwrap();
    assert!(
        !metadata.file_type().is_symlink(),
        "explicit artifact fixture must be link-free"
    );
    if metadata.is_dir() {
        fs::create_dir(target).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            copy_fixture(&entry.path(), &target.join(entry.file_name()));
        }
    } else {
        assert!(metadata.is_file());
        fs::copy(source, target).unwrap();
    }
}

#[test]
fn member_build_capture_requires_the_complete_generated_protocol_artifact() {
    let source = std::path::PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_MEMBER_ARTIFACT")
            .expect("explicit built member artifact is required"),
    );
    assert!(
        source.is_absolute(),
        "member artifact fixture must be an absolute path"
    );
    let resources = tempfile::tempdir().unwrap();
    assert!(build_owner::capture_member_artifact(resources.path()).is_err());

    let root = resources.path().join("member-runtime");
    copy_fixture(&source, &root);
    let captured = build_owner::capture_member_artifact(resources.path()).unwrap();
    assert_eq!(captured.manifest().entrypoint, "worker.mjs");

    let mut changed = captured.manifest().clone();
    changed.protocol_version = changed.protocol_version.checked_add(1).unwrap();
    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    assert!(build_owner::capture_member_artifact(resources.path()).is_err());

    fs::write(
        root.join("manifest.json"),
        serde_json::to_vec(captured.manifest()).unwrap(),
    )
    .unwrap();
    fs::remove_file(root.join(&captured.manifest().entrypoint)).unwrap();
    assert!(build_owner::capture_member_artifact(resources.path()).is_err());
}
