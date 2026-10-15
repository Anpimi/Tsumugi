//! Resolve a selected translation Resource and both exact providers from the
//! installed catalog. This observation grants no filesystem or execution access.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTranslationRequest {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTranslationView {
    pub settings_revision: UnsignedDecimal,
    pub resource_id: String,
    pub declaration: sdk::TranslationImportDeclaration,
    pub extractor: sdk::CapabilityBinding,
    pub checker: sdk::CapabilityBinding,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

pub(in crate::commands) type TranslationEnvironment =
    DeclaredEnvironment<sdk::TranslationImportBinding>;

impl TranslationEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginTranslationView, CommandError> {
        Ok(PluginTranslationView {
            settings_revision: self.settings_revision,
            resource_id: self.resource_id.clone().ok_or_else(invalid)?,
            declaration: self.binding.declaration.clone(),
            extractor: self.binding.extractor.clone(),
            checker: self.binding.checker.clone(),
            package_origin: self.package.origin().into(),
            environment: self.runtime.environment(),
            environment_digest: self.runtime.environment().digest().map_err(|_| invalid())?,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_translation(
        &self,
        request: &PluginTranslationRequest,
    ) -> Result<TranslationEnvironment, CommandError> {
        self.capture_declared_environment(
            &request.package,
            &request.resource_id,
            &request.environment_digest,
            &[sdk::ComponentScope::Project],
            |image, resource| {
                let binding = image.translation_import(resource)?;
                let providers = [binding.extractor.clone(), binding.checker.clone()];
                Ok((binding, providers))
            },
        )
    }
}

#[tauri::command]
pub async fn read_plugin_translation(
    state: State<'_, AppState>,
    request: PluginTranslationRequest,
) -> Result<PluginTranslationView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.capture_translation(&request)?.view()
        })
        .await
}

#[cfg(test)]
mod tests;
