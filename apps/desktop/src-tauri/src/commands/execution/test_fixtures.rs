//! One installed owner for independently captured package/runtime test inputs.
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    ApprovedPackageSetting, CapturedRuntime, PackageImage, PackageStore, PluginSettingsUpdate,
    RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin},
};

mod runtime_fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../crates/plugin-host/tests/support/runtime.rs"
    ));
}
pub(super) use runtime_fixture::approved_runtime;

pub(super) struct OwnedDirectory(pub(super) tempfile::TempDir);
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        fn removable(path: &Path) {
            let Ok(metadata) = fs::symlink_metadata(path) else {
                return;
            };
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                for child in fs::read_dir(path).unwrap() {
                    removable(&child.unwrap().path());
                }
            }
        }
        // Only this test's sealed Store directories are made removable. Never
        // follow a link into the independently selected package/runtime inputs.
        removable(self.0.path());
    }
}

pub(super) fn selected_package(
    path_variable: &str,
    digest_variable: &str,
    expected_id: &str,
) -> (PackageImage, PackageApproval) {
    let path = PathBuf::from(
        std::env::var_os(path_variable).expect("explicit independently built package required"),
    );
    let digest =
        std::env::var(digest_variable).expect("independently approved package digest required");
    let image = PackageImage::capture_directory(&path, &digest, || true).unwrap();
    let plugin = image.manifest().manifest().plugin.clone();
    assert_eq!(plugin.id, expected_id);
    let approval = PackageApproval {
        plugin,
        package_digest: digest,
        origin: PackageOrigin {
            source_id: "explicit-joint-review-test".into(),
            publisher_id: "reviewed-public-source".into(),
        },
    };
    (image, approval)
}

pub(super) fn provision_packages(
    root: &Path,
    packages: &[(PackageImage, PackageApproval)],
    runtime: &CapturedRuntime,
    runtime_approval: &RuntimeApproval,
) {
    let mut catalog = PackageCatalog::new();
    for (image, approval) in packages {
        catalog.register(image.clone(), approval.clone()).unwrap();
    }
    let mut installation =
        PackageStore::provision(root, &["application", "plugins"], || true).unwrap();
    for (_, approval) in packages {
        installation
            .install(
                &ExecutionId::new().to_string(),
                catalog.registered(&approval.plugin).unwrap(),
                || true,
            )
            .unwrap();
    }
    installation
        .install_runtime(
            &ExecutionId::new().to_string(),
            runtime,
            runtime_approval,
            || true,
        )
        .unwrap();
    installation
        .update_settings(
            0,
            &ExecutionId::new().to_string(),
            &PluginSettingsUpdate {
                packages: packages
                    .iter()
                    .map(|(_, approval)| ApprovedPackageSetting {
                        approval: approval.clone(),
                        enabled: true,
                    })
                    .collect(),
                runtimes: vec![runtime_approval.clone()],
            },
            || true,
        )
        .unwrap();
}
