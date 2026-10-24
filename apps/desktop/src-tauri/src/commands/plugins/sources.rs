//! Fix a source recipe and its complete installed environment in one current
//! application settings snapshot. No worker, directory or Core grant is created.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginSourceRequest {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginSourceView {
    pub settings_revision: UnsignedDecimal,
    pub resource_id: String,
    pub declaration: sdk::SourceImportDeclaration,
    pub extractor: sdk::CapabilityBinding,
    pub checker: sdk::CapabilityBinding,
    pub review: sdk::ReviewBinding,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

/// Immutable inputs for a subsequent native capture and per-attempt review.
/// Neither the view nor this snapshot is a current dispatch/adoption permit.
pub(in crate::commands) type SourceEnvironment = DeclaredEnvironment<sdk::SourceImportBinding>;
impl SourceEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginSourceView, CommandError> {
        Ok(PluginSourceView {
            settings_revision: self.settings_revision,
            resource_id: self.resource_id.clone().ok_or_else(invalid)?,
            declaration: self.binding.declaration.clone(),
            extractor: self.binding.extractor.clone(),
            checker: self.binding.checker.clone(),
            review: self.binding.review.clone(),
            package_origin: self.package.origin().into(),
            environment: self.runtime.environment(),
            environment_digest: self.runtime.environment().digest().map_err(|_| invalid())?,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_source(
        &self,
        request: &PluginSourceRequest,
    ) -> Result<SourceEnvironment, CommandError> {
        self.capture_declared_environment(
            &request.package,
            &request.resource_id,
            &request.environment_digest,
            &[sdk::ComponentScope::Project, sdk::ComponentScope::Attempt],
            |image, resource| {
                let binding = image.source_import(resource)?;
                let providers = [
                    binding.extractor.clone(),
                    binding.checker.clone(),
                    binding.review.checker.clone(),
                ];
                Ok((binding, providers))
            },
        )
    }
}

#[tauri::command]
pub async fn read_plugin_source(
    state: State<'_, AppState>,
    request: PluginSourceRequest,
) -> Result<PluginSourceView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.capture_source(&request)?.view()
        })
        .await
}

#[cfg(test)]
mod tests;
