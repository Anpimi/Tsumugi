//! Read a build recipe and both exact installed providers without starting a
//! worker, capturing project data or changing execution permission.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginBuildRequest {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginBuildView {
    pub settings_revision: UnsignedDecimal,
    pub resource_id: String,
    pub declaration: sdk::BuildDeclaration,
    pub builder: sdk::CapabilityBinding,
    pub checker: sdk::CapabilityBinding,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

pub(in crate::commands) type BuildEnvironment = DeclaredEnvironment<sdk::BuildBinding>;

impl BuildEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginBuildView, CommandError> {
        Ok(PluginBuildView {
            settings_revision: self.settings_revision,
            resource_id: self.resource_id.clone().ok_or_else(invalid)?,
            declaration: self.binding.declaration.clone(),
            builder: self.binding.builder.clone(),
            checker: self.binding.checker.clone(),
            package_origin: self.package.origin().into(),
            environment: self.runtime.environment(),
            environment_digest: self.runtime.environment().digest().map_err(|_| invalid())?,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_build(
        &self,
        request: &PluginBuildRequest,
    ) -> Result<BuildEnvironment, CommandError> {
        self.capture_declared_environment(
            &request.package,
            &request.resource_id,
            &request.environment_digest,
            &[sdk::ComponentScope::Project, sdk::ComponentScope::Attempt],
            |image, resource| {
                let binding = image.build_declaration(resource)?;
                let providers = [binding.builder.clone(), binding.checker.clone()];
                Ok((binding, providers))
            },
        )
    }
}

#[tauri::command]
pub async fn read_plugin_build(
    state: State<'_, AppState>,
    request: PluginBuildRequest,
) -> Result<PluginBuildView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.capture_build(&request)?.view()
        })
        .await
}

#[cfg(test)]
mod tests;
