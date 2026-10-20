//! Resolve a public read-only tool against the existing installed package and
//! runtime authorities. Discovery neither starts a worker nor grants execution.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginToolRequest {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginToolView {
    pub settings_revision: UnsignedDecimal,
    pub resource_id: String,
    pub binding: sdk::CapabilityToolBinding,
    pub component_scope: sdk::ComponentScope,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

pub(in crate::commands) type ToolEnvironment = DeclaredEnvironment<sdk::CapabilityToolBinding>;

impl ToolEnvironment {
    pub(in crate::commands) fn component_scope(&self) -> Result<sdk::ComponentScope, CommandError> {
        self.package
            .image()
            .manifest()
            .manifest()
            .components
            .iter()
            .find(|component| component.id == self.binding.capability.provider.component_id)
            .map(|component| component.scope)
            .ok_or_else(invalid)
    }
    pub(in crate::commands) fn view(&self) -> Result<PluginToolView, CommandError> {
        let environment = self.runtime.environment();
        Ok(PluginToolView {
            settings_revision: self.settings_revision,
            resource_id: self.resource_id.clone().ok_or_else(invalid)?,
            binding: self.binding.clone(),
            component_scope: self.component_scope()?,
            package_origin: self.package.origin().into(),
            environment_digest: environment.digest().map_err(|_| invalid())?,
            environment,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

impl ApplicationPlugins {
    /// Rebind static guidance to the original approved package. Runtime capture,
    /// activation and execution consent are intentionally absent from this read.
    pub(in crate::commands) fn read_tool_guidance<T>(
        &self,
        expected: &tsumugi_core::application::WorkPlanToolSpec,
        read: impl FnOnce(&tsumugi_plugin_host::PackageImage) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let image = self.read_installed_snapshot(|store, settings, _, allowed| {
            if UnsignedDecimal::from(settings.revision()) != expected.settings_revision {
                return Err(map_store_error(InstallError::RevisionConflict));
            }
            let provider = &expected.binding.capability.provider;
            let decision = settings
                .packages()
                .iter()
                .find(|entry| {
                    entry.enabled
                        && entry.approval.plugin == provider.plugin
                        && entry.approval.package_digest == provider.package_digest
                })
                .ok_or_else(|| map_store_error(InstallError::ApprovalMismatch))?;
            let package = store
                .load(&decision.approval, allowed)
                .map_err(map_store_error)?;
            let origin = serde_json::to_value(PluginOriginView::from(package.receipt().origin()))
                .map_err(|_| invalid())?;
            let image = package.image();
            let binding = image
                .capability_tool(&expected.resource_id)
                .map_err(|_| invalid())?;
            let component = image
                .manifest()
                .manifest()
                .components
                .iter()
                .find(|component| component.id == provider.component_id)
                .ok_or_else(invalid)?;
            if binding != expected.binding
                || origin != expected.package_origin
                || component.scope != expected.execution.component_scope
            {
                return Err(invalid());
            }
            Ok(image.clone())
        })?;
        // The Store retains its single-owner lock while capturing an immutable
        // image. Text consumers must not extend that lock or block revocation.
        let value = read(&image)?;
        self.with_environment_revision(expected.settings_revision, || Ok(value))
    }

    pub(in crate::commands) fn capture_tool(
        &self,
        request: &PluginToolRequest,
    ) -> Result<ToolEnvironment, CommandError> {
        let environment = self.capture_declared_environment(
            &request.package,
            &request.resource_id,
            &request.environment_digest,
            &[
                sdk::ComponentScope::Project,
                sdk::ComponentScope::Attempt,
                sdk::ComponentScope::Application,
            ],
            |image, resource| {
                let binding = image.capability_tool(resource)?;
                let providers = [binding.capability.clone()];
                Ok((binding, providers))
            },
        )?;
        if environment.component_scope()? == sdk::ComponentScope::Application {
            tsumugi_plugin_host::core::ApplicationInstance::validate_selection(
                environment.package.image(),
                &request.resource_id,
                &environment.runtime,
            )
            .map_err(|_| invalid())?;
        }
        Ok(environment)
    }
}

#[tauri::command]
pub async fn read_plugin_tool(
    state: State<'_, AppState>,
    request: PluginToolRequest,
) -> Result<PluginToolView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.capture_tool(&request)?.view()
        })
        .await
}
