//! Application-owned immutable defaults use the same capture, decision and
//! installation boundary as independently selected packages. No worker starts.
use super::*;
use crate::plugin_bundle::{self, BundleMetadata};
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    CapturedRuntime, PackageImage, RuntimeApproval,
    catalog::{PackageApproval, PackageCatalog, RegisteredPackage},
};

include!(concat!(env!("OUT_DIR"), "/bundled-plugins.rs"));

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DefaultsAvailability {
    Available,
    ResourcesUnavailable,
    RuntimeUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginBundledPackageView {
    pub display_name: String,
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub file_count: u32,
    pub byte_count: UnsignedDecimal,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginDefaultsOfferView {
    pub id: String,
    pub selection_digest: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 128)))]
    pub packages: Vec<PluginBundledPackageView>,
    pub runtime_environment_digest: String,
    pub availability: DefaultsAvailability,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginDefaultsInstallRequest {
    pub id: String,
    pub selection_digest: String,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}
pub(super) struct Bundle {
    metadata: BundleMetadata,
    root: Option<PathBuf>,
}

fn unavailable(reason: &str) -> CommandError {
    let mut error = CommandError::simple(
        CommandErrorCode::DependencyConflict,
        CommandStage::PluginInstall,
    );
    error.reason = Some(reason.into());
    error
}
impl Bundle {
    pub(super) fn view(
        &self,
        manager: &PluginManager,
    ) -> Result<PluginDefaultsOfferView, CommandError> {
        let runtime = manager
            .bundle
            .as_ref()
            .ok_or_else(|| unavailable("plugin-defaults-unavailable"))?
            .view()?;
        let selection = serde_json::to_string(&(&self.metadata, &runtime.environment_digest))
            .map_err(|_| unavailable("plugin-defaults-unavailable"))?;
        let present = self.root.as_ref().is_some_and(|root| {
            self.metadata.packages.iter().all(|entry| {
                let directory = root.join(&entry.pin.id);
                std::fs::symlink_metadata(&directory).is_ok_and(|meta| meta.is_dir())
                    && std::fs::symlink_metadata(directory.join("manifest.json"))
                        .is_ok_and(|meta| meta.is_file())
            })
        });
        Ok(PluginDefaultsOfferView {
            id: plugin_bundle::BUNDLE_ID.into(),
            selection_digest: sdk::payload_digest(&selection),
            packages: self
                .metadata
                .packages
                .iter()
                .map(|entry| PluginBundledPackageView {
                    display_name: entry.pin.display_name.clone(),
                    plugin: entry.pin.plugin.clone(),
                    package_digest: entry.pin.package_digest.clone(),
                    file_count: entry.file_count,
                    byte_count: entry.byte_count.into(),
                })
                .collect(),
            runtime_environment_digest: runtime.environment_digest,
            availability: if !present {
                DefaultsAvailability::ResourcesUnavailable
            } else if runtime.availability != runtimes::RuntimeAvailability::Available {
                DefaultsAvailability::RuntimeUnavailable
            } else {
                DefaultsAvailability::Available
            },
        })
    }
}
impl ApplicationPlugins {
    pub(in crate::commands) fn configure_default_bundle(
        &self,
        resources: Option<PathBuf>,
    ) -> Result<(), CommandError> {
        let mut manager = self.try_manager()?;
        if manager.defaults.is_some() {
            return Err(map_store_error(InstallError::StoreChanged));
        }
        let Some(json) = BUILT_PLUGINS else {
            return Ok(());
        };
        let metadata: BundleMetadata =
            serde_json::from_str(json).map_err(|_| unavailable("plugin-defaults-unavailable"))?;
        metadata
            .validate()
            .map_err(|_| unavailable("plugin-defaults-unavailable"))?;
        let runtime = manager
            .bundle
            .as_ref()
            .ok_or_else(|| unavailable("plugin-defaults-unavailable"))?
            .view()?;
        if metadata.platform != runtime.environment.platform
            || metadata.runtime_profile != runtime.environment.profile
            || metadata.process_protocol != runtime.environment.process_protocol
        {
            return Err(unavailable("plugin-defaults-unavailable"));
        }
        let root = resources
            .filter(|path| {
                path.is_absolute()
                    && !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir))
            })
            .map(|root| root.join(plugin_bundle::RESOURCE_DIRECTORY));
        manager.defaults = Some(Bundle { metadata, root });
        Ok(())
    }
}

pub(super) fn capture_offer(
    manager: &PluginManager,
    request: &PluginDefaultsInstallRequest,
    allowed: impl Fn() -> bool,
) -> Result<(Vec<RegisteredPackage>, CapturedRuntime, RuntimeApproval), CommandError> {
    let bundle = manager
        .defaults
        .as_ref()
        .ok_or_else(|| unavailable("plugin-defaults-unavailable"))?;
    let offer = bundle.view(manager)?;
    if request.id != offer.id || request.selection_digest != offer.selection_digest {
        return Err(unavailable("plugin-defaults-changed"));
    }
    if offer.availability != DefaultsAvailability::Available {
        return Err(unavailable("plugin-defaults-unavailable"));
    }
    let root = bundle
        .root
        .as_ref()
        .ok_or_else(|| unavailable("plugin-defaults-unavailable"))?;
    let mut packages = Vec::new();
    for entry in &bundle.metadata.packages {
        let image = PackageImage::capture_directory(
            &root.join(&entry.pin.id),
            &entry.pin.package_digest,
            &allowed,
        )
        .map_err(|_| unavailable("plugin-defaults-changed"))?;
        if image.manifest().manifest().plugin != entry.pin.plugin {
            return Err(unavailable("plugin-defaults-changed"));
        }
        let approval = PackageApproval {
            plugin: entry.pin.plugin.clone(),
            package_digest: entry.pin.package_digest.clone(),
            origin: plugin_bundle::bundled_origin(),
        };
        let mut catalog = PackageCatalog::new();
        catalog
            .register(image, approval.clone())
            .map_err(packages::catalog_error)?;
        packages.push(
            catalog
                .registered(&approval.plugin)
                .map_err(packages::catalog_error)?
                .clone(),
        );
    }
    let (runtime, approval) = runtimes::capture_offer(
        manager,
        &PluginRuntimeInstallRequest {
            id: crate::runtime_bundle::BUNDLE_ID.into(),
            environment_digest: offer.runtime_environment_digest,
            expected_revision: request.expected_revision,
            action_id: request.action_id,
        },
        allowed,
    )?;
    Ok((packages, runtime, approval))
}

#[tauri::command]
pub async fn install_plugin_defaults(
    state: State<'_, AppState>,
    request: PluginDefaultsInstallRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.mutate(packages::MutationRequest::Defaults(request))
        })
        .await
}

#[cfg(test)]
mod tests;
