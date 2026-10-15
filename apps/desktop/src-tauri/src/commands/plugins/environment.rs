//! Resolve a declared capability pair and its independently approved runtime
//! from one installed-settings snapshot. This capture grants no execution.
use super::*;
use tsumugi_plugin_host::{
    PackageImage, PluginSettings, catalog::RegisteredPackage, core::RunnerRuntime,
};

#[derive(Clone)]
pub(in crate::commands) struct DeclaredEnvironment<B> {
    pub package: RegisteredPackage,
    pub binding: B,
    pub runtime: RunnerRuntime,
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
    /// Inspect installed bytes and current decisions under the same settings
    /// guard used by complete environment capture. This grants no execution.
    pub(super) fn read_installed_snapshot<T>(
        &self,
        read: impl FnOnce(
            &PackageStore,
            &PluginSettings,
            &std::path::Path,
            &dyn Fn() -> bool,
        ) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let directory = manager.directory.as_ref().expect("directory configured");
        let staging_parent = directory.anchor.join(&directory.application);
        let value = read(store, &settings, &staging_parent, &allowed)?;
        if store.settings(allowed).map_err(map_store_error)? != settings {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        Ok(value)
    }
    /// Serialize the final settings check with application-owned settings
    /// mutations while admitting the bounded execution authorization/enqueue.
    pub(in crate::commands) fn with_environment_revision<T>(
        &self,
        expected: UnsignedDecimal,
        operation: impl FnOnce() -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        self.with_environment_authority(expected, |_| operation())
    }

    /// Capture a one-way settings token while admitting the same bounded owner
    /// operation. Consumers keep this token until their authorized effects end.
    /// A fresh token proves freshly read settings only; it restores no previous
    /// Core grant, consent, runtime generation or deadline.
    pub(in crate::commands) fn with_environment_authority<T>(
        &self,
        expected: UnsignedDecimal,
        operation: impl FnOnce(Cancellation) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        if manager
            .pending
            .as_ref()
            .is_some_and(packages::PendingMutation::settings_outcome_unknown)
        {
            self.revoke_environment_authority()?;
            let mut error = CommandError::unknown(CommandStage::ExecutionRecover);
            error.reason = Some("plugin-result-unconfirmed".into());
            return Err(error);
        }
        let settings = manager
            .store
            .as_ref()
            .expect("store provisioned")
            .settings(|| self.open.load(Ordering::Acquire))
            .map_err(|error| match self.revoke_environment_authority() {
                Ok(()) => map_store_error(error),
                Err(error) => error,
            })?;
        let cancellation =
            self.capture_environment_authority(expected, settings.revision().into())?;
        operation(cancellation)
    }

    pub(in crate::commands) fn environment_settings_revision(
        &self,
    ) -> Result<UnsignedDecimal, CommandError> {
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let settings = manager
            .store
            .as_ref()
            .expect("store provisioned")
            .settings(allowed)
            .map_err(map_store_error)?;
        Ok(settings.revision().into())
    }
    pub(super) fn capture_declared_environment<B, const N: usize>(
        &self,
        requested: &PluginPackageRequest,
        resource_id: &str,
        environment_digest: &str,
        supported_scopes: &[sdk::ComponentScope],
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
            supported_scopes,
            |image| resolve(image, resource_id),
        )
    }

    pub(super) fn capture_capability_environment<B, const N: usize>(
        &self,
        requested: &PluginPackageRequest,
        resource_id: Option<&str>,
        environment_digest: &str,
        supported_scopes: &[sdk::ComponentScope],
        resolve: impl FnOnce(&PackageImage) -> Result<(B, [sdk::CapabilityBinding; N]), HostError>,
    ) -> Result<DeclaredEnvironment<B>, CommandError> {
        requested.plugin.validate().map_err(|_| invalid())?;
        sdk::validate_package_digest(&requested.package_digest).map_err(|_| invalid())?;
        sdk::validate_package_digest(environment_digest).map_err(|_| invalid())?;
        self.read_installed_snapshot(|store, settings, staging_parent, allowed| {
            let catalog = packages::load_enabled_catalog(store, settings, requested, allowed)?;
            let package = catalog
                .registered(&requested.plugin)
                .map_err(packages::catalog_error)?;
            let (binding, capabilities) = resolve(package.image())
                .map_err(|error| map_store_error(InstallError::Host(error)))?;
            let mut runtime_kind = None;
            for capability in capabilities {
                let resolved = catalog
                    .lookup(&capability.provider)
                    .map_err(packages::catalog_error)?;
                if resolved.binding() != &capability {
                    return Err(invalid());
                }
                let component = package
                    .image()
                    .manifest()
                    .manifest()
                    .components
                    .iter()
                    .find(|component| component.id == capability.provider.component_id)
                    .ok_or_else(invalid)?;
                if !supported_scopes.contains(&component.scope) {
                    return Err(invalid());
                }
                if !matches!(
                    component.runtime,
                    sdk::RuntimeKind::JavaScript | sdk::RuntimeKind::NativeWorker
                ) || runtime_kind.is_some_and(|kind| kind != component.runtime)
                {
                    return Err(invalid());
                }
                runtime_kind = Some(component.runtime);
            }
            let (runtime, runtime_origin) =
                runtimes::load_approved_environment(store, settings, environment_digest, allowed)?;
            // All selected executable providers share one exact environment family.
            // A native component cannot borrow an installed Node approval or vice versa.
            if !matches!(
                (runtime_kind, &runtime),
                (
                    Some(sdk::RuntimeKind::JavaScript),
                    RunnerRuntime::JavaScript(_)
                ) | (
                    Some(sdk::RuntimeKind::NativeWorker),
                    RunnerRuntime::Native(_)
                )
            ) {
                return Err(invalid());
            }
            Ok(DeclaredEnvironment {
                package: package.clone(),
                binding,
                runtime,
                // Host owns private per-process children under the provisioned
                // application directory, never under project or Store internals.
                staging_parent: staging_parent.to_path_buf(),
                resource_id: resource_id.map(str::to_owned),
                settings_revision: settings.revision().into(),
                runtime_origin,
            })
        })
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(super) mod test_support;

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;
