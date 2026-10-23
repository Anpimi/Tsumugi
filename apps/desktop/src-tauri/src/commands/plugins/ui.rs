//! Read one explicitly declared host-rendered UI from the original installed
//! package. Inspection captures no runtime, process, project input or grant.
use super::environment::invalid;
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginUiRequest {
    pub package: PluginPackageRequest,
    pub ui_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginUiView {
    pub settings_revision: UnsignedDecimal,
    pub package: PluginPackageRequest,
    pub component_id: String,
    pub ui_id: String,
    pub slot: String,
    pub resource_id: String,
    pub binding: sdk::CapabilityToolBinding,
}

impl ApplicationPlugins {
    pub(in crate::commands) fn read_ui(
        &self,
        request: &PluginUiRequest,
    ) -> Result<PluginUiView, CommandError> {
        request.package.plugin.validate().map_err(|_| invalid())?;
        sdk::validate_package_digest(&request.package.package_digest).map_err(|_| invalid())?;
        sdk::validate_contribution_id(&request.ui_id).map_err(|_| invalid())?;
        let (image, revision) = self.read_installed_snapshot(|store, settings, _, allowed| {
            let catalog =
                packages::load_enabled_catalog(store, settings, &request.package, allowed)?;
            let package = catalog
                .registered(&request.package.plugin)
                .map_err(packages::catalog_error)?;
            Ok((
                package.image().clone(),
                UnsignedDecimal::from(settings.revision()),
            ))
        })?;
        // Do not hold the Store while interpreting the immutable public payload.
        // Its captured package identity and final settings epoch remain exact.
        let ui = image
            .reference_query_ui(&request.ui_id)
            .map_err(|error| map_store_error(InstallError::Host(error)))?;
        let view = PluginUiView {
            settings_revision: revision,
            package: PluginPackageRequest {
                plugin: image.manifest().manifest().plugin.clone(),
                package_digest: image.package_digest().into(),
            },
            component_id: ui.component_id,
            ui_id: ui.ui_id,
            slot: ui.slot,
            resource_id: ui.resource_id,
            binding: ui.binding,
        };
        self.with_environment_revision(revision, || Ok(view))
    }
}

#[tauri::command]
pub async fn read_plugin_ui(
    state: State<'_, AppState>,
    request: PluginUiRequest,
) -> Result<PluginUiView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || plugins.read_ui(&request))
        .await
}

#[cfg(test)]
mod tests;
