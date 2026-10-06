//! Owned installed-store fixtures shared by source and build capture tests.
use super::super::*;
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc};
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    ApprovedPackageSetting, PackageFile, PackageImage, PluginSettingsUpdate, RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog},
};

pub(in crate::commands) struct Fixture {
    pub(in crate::commands) directory: tempfile::TempDir,
    pub(in crate::commands) owner: Arc<ApplicationPlugins>,
    pub(in crate::commands) image: PackageImage,
    pub(in crate::commands) approval: PackageApproval,
}
impl Fixture {
    pub(in crate::commands) fn new(
        change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
    ) -> Self {
        Self::with_owner(Arc::new(ApplicationPlugins::default()), change)
    }
    pub(in crate::commands) fn with_owner(
        owner: Arc<ApplicationPlugins>,
        change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
    ) -> Self {
        Self::with_resource(
            owner,
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.manifest.json"
            ),
            "source-profile.json",
            include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.declaration.json"
            ),
            change,
        )
    }
    pub(in crate::commands) fn with_resource(
        owner: Arc<ApplicationPlugins>,
        manifest: &[u8],
        resource_path: &str,
        resource: &[u8],
        change: impl FnOnce(&mut sdk::PluginManifest, &mut BTreeMap<String, PackageFile>),
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        owner
            .configure(directory.path().join("application"))
            .unwrap();
        let mut manifest: sdk::PluginManifest = serde_json::from_slice(manifest).unwrap();
        let mut files = BTreeMap::from([
            (
                "component.mjs".into(),
                PackageFile {
                    bytes: b"throw new Error('metadata inspection must not execute');".to_vec(),
                    executable: false,
                },
            ),
            (
                resource_path.into(),
                PackageFile {
                    bytes: resource.to_vec(),
                    executable: false,
                },
            ),
        ]);
        change(&mut manifest, &mut files);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let digest = PackageImage::digest(&bytes, &files).unwrap();
        let image = PackageImage::capture(bytes, files, &digest).unwrap();
        let approval = PackageApproval {
            plugin: manifest.plugin,
            package_digest: digest,
            origin: PackageOrigin {
                source_id: "manual-local".into(),
                publisher_id: "user-approved".into(),
            },
        };
        Self {
            directory,
            owner,
            image,
            approval,
        }
    }
    pub(in crate::commands) fn root(&self) -> PathBuf {
        self.directory.path().join("application/plugins")
    }
    pub(in crate::commands) fn request(&self) -> PluginSourceRequest {
        PluginSourceRequest {
            package: PluginPackageRequest {
                plugin: self.approval.plugin.clone(),
                package_digest: self.approval.package_digest.clone(),
            },
            resource_id: "source-profile".into(),
            environment_digest: serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../../../test/fixtures/pluginSource.contract.json"
            ))
            .unwrap()["request"]["environmentDigest"]
                .as_str()
                .unwrap()
                .into(),
        }
    }
    pub(in crate::commands) fn install(&self) {
        let mut catalog = PackageCatalog::new();
        catalog
            .register(self.image.clone(), self.approval.clone())
            .unwrap();
        let mut manager = self.owner.try_manager().unwrap();
        self.owner.provision(&mut manager).unwrap();
        manager
            .store
            .as_mut()
            .unwrap()
            .install(
                &ExecutionId::new().to_string(),
                catalog.registered(&self.approval.plugin).unwrap(),
                || true,
            )
            .unwrap();
    }
    pub(in crate::commands) fn decide(&self, enabled: bool, runtimes: Vec<RuntimeApproval>) {
        let mut manager = self.owner.try_manager().unwrap();
        self.owner.provision(&mut manager).unwrap();
        let store = manager.store.as_mut().unwrap();
        let revision = store.settings(|| true).unwrap().revision();
        store
            .update_settings(
                revision,
                &ExecutionId::new().to_string(),
                &PluginSettingsUpdate {
                    packages: vec![ApprovedPackageSetting {
                        approval: self.approval.clone(),
                        enabled,
                    }],
                    runtimes,
                },
                || true,
            )
            .unwrap();
    }

    pub(in crate::commands) fn install_runtime(
        &self,
        runtime: &tsumugi_plugin_host::CapturedRuntime,
        approval: &RuntimeApproval,
    ) {
        let mut manager = self.owner.try_manager().unwrap();
        self.owner.provision(&mut manager).unwrap();
        manager
            .store
            .as_mut()
            .unwrap()
            .install_runtime(&ExecutionId::new().to_string(), runtime, approval, || true)
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.owner.close();
        self.owner.manager.lock().unwrap().store = None;
        fn removable(path: &Path) {
            if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                for child in fs::read_dir(path).unwrap() {
                    removable(&child.unwrap().path());
                }
            }
        }
        removable(self.directory.path());
    }
}
