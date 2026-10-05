//! Fix a source recipe and its complete installed environment in one current
//! application settings snapshot. No worker, directory or Core grant is created.
use super::*;
use tsumugi_plugin_host::{CapturedRuntime, catalog::RegisteredPackage};

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
    pub package_origin: PluginOriginView,
    pub environment: sdk::RuntimeEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

/// Immutable inputs for a subsequent native capture and per-attempt review.
/// Neither the view nor this snapshot is a current dispatch/adoption permit.
pub(in crate::commands) struct SourceEnvironment {
    pub package: RegisteredPackage,
    pub binding: sdk::SourceImportBinding,
    pub runtime: CapturedRuntime,
    resource_id: String,
    settings_revision: UnsignedDecimal,
    runtime_origin: PackageOrigin,
}
impl SourceEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginSourceView, CommandError> {
        Ok(PluginSourceView {
            settings_revision: self.settings_revision,
            resource_id: self.resource_id.clone(),
            declaration: self.binding.declaration.clone(),
            extractor: self.binding.extractor.clone(),
            checker: self.binding.checker.clone(),
            package_origin: self.package.origin().into(),
            environment: self.runtime.descriptor().clone(),
            environment_digest: self.runtime.descriptor().digest().map_err(|_| invalid())?,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

fn invalid() -> CommandError {
    let mut error = CommandError::simple(CommandErrorCode::InvalidInput, CommandStage::Read);
    error.reason = Some("plugin-binding-invalid".into());
    error
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_source(
        &self,
        request: &PluginSourceRequest,
    ) -> Result<SourceEnvironment, CommandError> {
        request.package.plugin.validate().map_err(|_| invalid())?;
        sdk::validate_package_digest(&request.package.package_digest).map_err(|_| invalid())?;
        sdk::validate_package_digest(&request.environment_digest).map_err(|_| invalid())?;
        if request.resource_id.is_empty() || request.resource_id.len() > 128 {
            return Err(invalid());
        }
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let catalog = packages::load_enabled_catalog(store, &settings, &request.package, allowed)?;
        let package = catalog
            .registered(&request.package.plugin)
            .map_err(packages::catalog_error)?;
        let binding = package
            .image()
            .source_import(&request.resource_id)
            .map_err(|error| map_store_error(InstallError::Host(error)))?;
        for capability in [&binding.extractor, &binding.checker] {
            let resolved = catalog
                .lookup(&capability.provider)
                .map_err(packages::catalog_error)?;
            if resolved.binding() != capability {
                return Err(invalid());
            }
            // Only JavaScript components use this approved Node environment.
            let component = package
                .image()
                .manifest()
                .manifest()
                .components
                .iter()
                .find(|component| component.id == capability.provider.component_id)
                .ok_or_else(invalid)?;
            if component.runtime != sdk::RuntimeKind::JavaScript {
                return Err(invalid());
            }
        }
        let (runtime, runtime_origin) = runtimes::load_approved_runtime(
            store,
            &settings,
            &request.environment_digest,
            allowed,
        )?;
        if store.settings(allowed).map_err(map_store_error)? != settings {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        Ok(SourceEnvironment {
            package: package.clone(),
            binding,
            runtime,
            resource_id: request.resource_id.clone(),
            settings_revision: settings.revision().into(),
            runtime_origin,
        })
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
