//! One installed owner for independently captured package/runtime test inputs.
use crate::commands::plugins::ApplicationPlugins;
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

/// Explicit assembly for fixtures that otherwise have no installed runtime.
/// Keep the returned Store alive for every worker started by this fixture.
pub(super) fn provision_member_runtime(
    plugins: &ApplicationPlugins,
    resources: &Path,
) -> OwnedDirectory {
    let runtime = approved_runtime();
    let approval = RuntimeApproval {
        environment: runtime.descriptor().clone().into(),
        origin: crate::runtime_bundle::bundled_origin(),
    };
    let installation = OwnedDirectory(tempfile::tempdir().unwrap());
    provision_packages(installation.0.path(), &[], &runtime, &approval);
    plugins
        .configure(installation.0.path().join("application"))
        .unwrap();
    configure_member_resources(plugins, resources);
    installation
}

/// Resource configuration is independent of installed approval. Existing
/// package fixtures must provision their own Store before calling this helper.
pub(super) fn configure_member_resources(plugins: &ApplicationPlugins, resources: &Path) {
    configure_member_artifact(plugins, resources);
    plugins
        .configure_member_default_runtime_for_test(member_runtime_metadata())
        .unwrap();
}

pub(super) fn member_runtime_metadata() -> crate::runtime_bundle::BundledRuntimeMetadata {
    static METADATA: std::sync::OnceLock<crate::runtime_bundle::BundledRuntimeMetadata> =
        std::sync::OnceLock::new();
    METADATA
        .get_or_init(|| {
            let runtime = approved_runtime();
            let expected = runtime.descriptor();
            let tool = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL").expect("explicit tool required"),
            );
            let host = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST").expect("explicit Host required"),
            );
            let observed = CapturedRuntime::inspect_directories(
                &tool,
                &host,
                &tsumugi_plugin_host::RuntimeInspectionRequest {
                    profile: expected.profile,
                    tool_version: expected.tool_version.clone(),
                    tool_entrypoint: expected.tool.entrypoint.clone(),
                    host_entrypoint: expected.host.entrypoint.clone(),
                },
                || true,
            )
            .unwrap();
            assert_eq!(&observed.environment, expected);
            let metadata = crate::runtime_bundle::BundledRuntimeMetadata {
                format_version: 1,
                id: crate::runtime_bundle::BUNDLE_ID.into(),
                environment: observed.environment,
                origin: crate::runtime_bundle::bundled_origin(),
                minimum_system_version: crate::runtime_bundle::node_pin()
                    .unwrap()
                    .minimum_system_version,
                file_count: observed.file_count,
                byte_count: observed.byte_count,
            };
            metadata.validate().unwrap();
            metadata
        })
        .clone()
}

pub(super) fn configure_member_artifact(plugins: &ApplicationPlugins, resources: &Path) {
    let source = PathBuf::from(
        std::env::var_os("TSUMUGI_TEST_MEMBER_ARTIFACT")
            .expect("explicit built member artifact required"),
    );
    fn copy(source: &Path, target: &Path) {
        let metadata = fs::symlink_metadata(source).unwrap();
        assert!(
            !metadata.file_type().is_symlink(),
            "artifact fixture must be link-free"
        );
        if metadata.is_dir() {
            fs::create_dir_all(target).unwrap();
            for entry in fs::read_dir(source).unwrap() {
                let entry = entry.unwrap();
                copy(&entry.path(), &target.join(entry.file_name()));
            }
        } else {
            assert!(metadata.is_file());
            fs::copy(source, target).unwrap();
        }
    }
    copy(&source, &resources.join("member-runtime"));
    plugins
        .configure_member_bundle(Some(resources.to_owned()))
        .unwrap();
}

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
