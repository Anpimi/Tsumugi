//! Resolve a declared capability pair and its independently approved runtime
//! from one installed-settings snapshot. This capture grants no execution.
use super::*;
use tsumugi_plugin_host::{CapturedRuntime, PackageImage, catalog::RegisteredPackage};

#[derive(Clone)]
pub(in crate::commands) struct DeclaredEnvironment<B> {
    pub package: RegisteredPackage,
    pub binding: B,
    pub runtime: CapturedRuntime,
    pub staging_parent: PathBuf,
    pub resource_id: Option<String>,
    pub settings_revision: UnsignedDecimal,
    pub runtime_origin: PackageOrigin,
}

pub(super) fn invalid() -> CommandError {
    let mut error = CommandError::simple(CommandErrorCode::InvalidInput, CommandStage::Read);
    error.reason = Some("plugin-binding-invalid".into());
    error
}

impl ApplicationPlugins {
    pub(super) fn capture_declared_environment<B, const N: usize>(
        &self,
        requested: &PluginPackageRequest,
        resource_id: &str,
        environment_digest: &str,
        resolve: impl FnOnce(&PackageImage, &str) -> Result<(B, [sdk::CapabilityBinding; N]), HostError>,
    ) -> Result<DeclaredEnvironment<B>, CommandError> {
        requested.plugin.validate().map_err(|_| invalid())?;
        sdk::validate_package_digest(&requested.package_digest).map_err(|_| invalid())?;
        sdk::validate_package_digest(environment_digest).map_err(|_| invalid())?;
        if resource_id.is_empty() || resource_id.len() > 128 {
            return Err(invalid());
        }
        self.capture_capability_environment(
            requested,
            Some(resource_id),
            environment_digest,
            |image| resolve(image, resource_id),
        )
    }

    pub(super) fn capture_capability_environment<B, const N: usize>(
        &self,
        requested: &PluginPackageRequest,
        resource_id: Option<&str>,
        environment_digest: &str,
        resolve: impl FnOnce(&PackageImage) -> Result<(B, [sdk::CapabilityBinding; N]), HostError>,
    ) -> Result<DeclaredEnvironment<B>, CommandError> {
        requested.plugin.validate().map_err(|_| invalid())?;
        sdk::validate_package_digest(&requested.package_digest).map_err(|_| invalid())?;
        sdk::validate_package_digest(environment_digest).map_err(|_| invalid())?;
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let catalog = packages::load_enabled_catalog(store, &settings, requested, allowed)?;
        let package = catalog
            .registered(&requested.plugin)
            .map_err(packages::catalog_error)?;
        let (binding, capabilities) =
            resolve(package.image()).map_err(|error| map_store_error(InstallError::Host(error)))?;
        for capability in capabilities {
            let resolved = catalog
                .lookup(&capability.provider)
                .map_err(packages::catalog_error)?;
            if resolved.binding() != &capability {
                return Err(invalid());
            }
            // The approved environment currently runs JavaScript components.
            // A native worker cannot borrow that environment's approval.
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
        let (runtime, runtime_origin) =
            runtimes::load_approved_runtime(store, &settings, environment_digest, allowed)?;
        if store.settings(allowed).map_err(map_store_error)? != settings {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        Ok(DeclaredEnvironment {
            package: package.clone(),
            binding,
            runtime,
            // Host owns private per-process children under the provisioned
            // application directory, never under project or Store internals.
            staging_parent: {
                let directory = manager.directory.as_ref().expect("directory configured");
                directory.anchor.join(&directory.application)
            },
            resource_id: resource_id.map(str::to_owned),
            settings_revision: settings.revision().into(),
            runtime_origin,
        })
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(super) mod test_support;
