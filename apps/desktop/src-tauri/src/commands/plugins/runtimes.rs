//! Application assembly supplies identity; explicit decisions supply approval.
//! Installation and exact selection do not start a worker or mint a Core grant.
use super::*;
use crate::runtime_bundle::{self, BundledRuntimeMetadata};
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    CapturedNativeRuntime, CapturedRuntime, PluginSettings, RuntimeApproval,
};

include!(concat!(env!("OUT_DIR"), "/bundled-runtime.rs"));

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum RuntimeAvailability {
    Available,
    UnsupportedPlatform,
    SystemTooOld,
    SystemVersionUnknown,
    ResourcesUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRuntimeOfferView {
    pub id: String,
    pub environment: sdk::RuntimeEnvironmentDescriptor,
    pub environment_digest: String,
    pub origin: PluginOriginView,
    pub minimum_system_version: String,
    pub file_count: u32,
    pub byte_count: UnsignedDecimal,
    pub availability: RuntimeAvailability,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRuntimeInstallRequest {
    pub id: String,
    pub environment_digest: String,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRuntimeLookupRequest {
    pub environment_digest: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum NativeHostUnavailableReason {
    UnsupportedPlatform,
    IdentityUnavailable,
}

/// Current application observation, independent of an installation or approval.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(tag = "availability", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum PluginNativeHostOfferView {
    Available {
        environment: sdk::NativeHostEnvironmentDescriptor,
        #[serde(rename = "environmentDigest")]
        environment_digest: String,
        origin: PluginOriginView,
    },
    Unavailable {
        reason: NativeHostUnavailableReason,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginNativeHostApprovalRequest {
    pub environment_digest: String,
    pub approved: bool,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

pub(super) fn native_host_origin() -> PackageOrigin {
    PackageOrigin {
        source_id: "application-host".into(),
        publisher_id: "tsumugi-application".into(),
    }
}

pub(super) fn native_host_offer() -> PluginNativeHostOfferView {
    match CapturedNativeRuntime::inspect_current().and_then(|environment| {
        let environment_digest = environment
            .digest()
            .map_err(|_| HostError::InvalidContract)?;
        Ok((environment, environment_digest))
    }) {
        Ok((environment, environment_digest)) => PluginNativeHostOfferView::Available {
            environment,
            environment_digest,
            origin: (&native_host_origin()).into(),
        },
        Err(error) => PluginNativeHostOfferView::Unavailable {
            reason: if error == HostError::UnsupportedPlatform {
                NativeHostUnavailableReason::UnsupportedPlatform
            } else {
                NativeHostUnavailableReason::IdentityUnavailable
            },
        },
    }
}

/// A caller supplies only a confirmed identity, never executable metadata or a
/// path. Re-observe this Host at the mutation boundary before saving a decision.
pub(super) fn capture_native_approval(
    digest: &str,
    allowed: impl Fn() -> bool,
) -> Result<RuntimeApproval, CommandError> {
    sdk::validate_package_digest(digest)
        .map_err(|_| map_store_error(InstallError::ApprovalMismatch))?;
    if !allowed() {
        return Err(map_store_error(InstallError::AuthorityRevoked));
    }
    let environment =
        CapturedNativeRuntime::inspect_current().map_err(|error| map_store_error(error.into()))?;
    if environment.digest().ok().as_deref() != Some(digest) {
        return Err(map_store_error(InstallError::ApprovalMismatch));
    }
    CapturedNativeRuntime::capture(&environment).map_err(|error| map_store_error(error.into()))?;
    if !allowed() {
        return Err(map_store_error(InstallError::AuthorityRevoked));
    }
    Ok(RuntimeApproval {
        environment: environment.into(),
        origin: native_host_origin(),
    })
}

pub(super) struct Bundle {
    metadata: BundledRuntimeMetadata,
    root: Option<PathBuf>,
}
impl Bundle {
    fn resources_present(&self) -> bool {
        let Some(root) = &self.root else {
            return false;
        };
        // Cheap availability feedback only. Approval and full nofollow capture
        // still belong to the Host at the actual mutation boundary.
        [root.clone(), root.join("tool"), root.join("host")]
            .iter()
            .all(|path| std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()))
            && [root.join("tool/bin/node"), root.join("host/dist/main.js")]
                .iter()
                .all(|path| {
                    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
                })
    }
    pub(super) fn view(&self) -> Result<PluginRuntimeOfferView, CommandError> {
        Ok(PluginRuntimeOfferView {
            id: self.metadata.id.clone(),
            environment: self.metadata.environment.clone(),
            environment_digest: self
                .metadata
                .environment
                .digest()
                .map_err(|_| unavailable())?,
            origin: (&self.metadata.origin).into(),
            minimum_system_version: self.metadata.minimum_system_version.clone(),
            file_count: self.metadata.file_count,
            byte_count: self.metadata.byte_count.into(),
            availability: if !self.resources_present() {
                RuntimeAvailability::ResourcesUnavailable
            } else {
                availability(
                    &self.metadata.environment,
                    &self.metadata.minimum_system_version,
                )
            },
        })
    }
}

fn unavailable() -> CommandError {
    let mut error = CommandError::simple(CommandErrorCode::DependencyConflict, CommandStage::Read);
    error.reason = Some("plugin-runtime-unavailable".into());
    error
}

fn availability(
    environment: &sdk::RuntimeEnvironmentDescriptor,
    minimum: &str,
) -> RuntimeAvailability {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64"))
        || environment.platform.operating_system != sdk::RuntimeOperatingSystem::Macos
        || environment.platform.architecture != sdk::RuntimeArchitecture::Aarch64
    {
        return RuntimeAvailability::UnsupportedPlatform;
    }
    let Some(current) = operating_system_version() else {
        return RuntimeAvailability::SystemVersionUnknown;
    };
    let Some(minimum) = runtime_bundle::system_version(minimum) else {
        return RuntimeAvailability::SystemVersionUnknown;
    };
    if current < minimum {
        RuntimeAvailability::SystemTooOld
    } else {
        RuntimeAvailability::Available
    }
}

#[cfg(target_os = "macos")]
fn operating_system_version() -> Option<(u16, u16, u16)> {
    // A bounded kernel query uses no PATH, subprocess or caller-supplied value.
    let mut bytes = [0u8; 32];
    let mut length = bytes.len();
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            bytes.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length == 0 || length > bytes.len() || bytes[length - 1] != 0 {
        return None;
    }
    runtime_bundle::system_version(std::str::from_utf8(&bytes[..length - 1]).ok()?)
}
#[cfg(not(target_os = "macos"))]
fn operating_system_version() -> Option<(u16, u16, u16)> {
    None
}

impl ApplicationPlugins {
    pub(in crate::commands) fn configure_bundle(
        &self,
        resources: Option<PathBuf>,
    ) -> Result<(), CommandError> {
        let mut manager = self.try_manager()?;
        if manager.bundle.is_some() {
            return Err(map_store_error(InstallError::StoreChanged));
        }
        let Some(json) = BUILT_RUNTIME else {
            return Ok(());
        };
        let metadata: BundledRuntimeMetadata =
            serde_json::from_str(json).map_err(|_| unavailable())?;
        metadata.validate().map_err(|_| unavailable())?;
        let root = resources
            .filter(|path| {
                path.is_absolute()
                    && !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir))
            })
            .map(|path| path.join(runtime_bundle::RESOURCE_DIRECTORY));
        manager.bundle = Some(Bundle { metadata, root });
        Ok(())
    }

    fn install_runtime(
        &self,
        request: PluginRuntimeInstallRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        self.mutate(packages::MutationRequest::Runtime(request))
    }

    fn set_native_host_approval(
        &self,
        request: PluginNativeHostApprovalRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        self.mutate(packages::MutationRequest::NativeHost(request))
    }

    pub(in crate::commands) fn lookup_runtime(
        &self,
        digest: &str,
    ) -> Result<CapturedRuntime, CommandError> {
        sdk::validate_package_digest(digest).map_err(|_| unavailable())?;
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let (runtime, _) = load_approved_runtime(store, &settings, digest, allowed)?;
        if store.settings(allowed).map_err(map_store_error)? != settings {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        Ok(runtime)
    }
}

/// Use the same current decision and platform policy for individual runtime
/// inspection and complete source resolution; no descriptor comes from a caller.
pub(super) fn load_approved_environment(
    store: &PackageStore,
    settings: &PluginSettings,
    digest: &str,
    allowed: impl Fn() -> bool,
) -> Result<(tsumugi_plugin_host::core::RunnerRuntime, PackageOrigin), CommandError> {
    if !allowed() {
        return Err(map_store_error(InstallError::AuthorityRevoked));
    }
    let approval = settings
        .runtimes()
        .iter()
        .find(|entry| entry.environment.digest().ok().as_deref() == Some(digest))
        .ok_or_else(|| map_store_error(InstallError::ApprovalMismatch))?;
    match &approval.environment {
        sdk::ExecutionEnvironmentDescriptor::Captured(_) => {
            let (runtime, origin) = load_approved_runtime(store, settings, digest, &allowed)?;
            Ok((runtime.into(), origin))
        }
        sdk::ExecutionEnvironmentDescriptor::Native(environment) => {
            if approval.origin != native_host_origin() {
                return Err(map_store_error(InstallError::ApprovalMismatch));
            }
            let runtime = CapturedNativeRuntime::capture(environment)
                .map_err(|error| map_store_error(error.into()))?;
            if !allowed() {
                return Err(map_store_error(InstallError::AuthorityRevoked));
            }
            Ok((runtime.into(), approval.origin.clone()))
        }
    }
}

pub(super) fn load_approved_runtime(
    store: &PackageStore,
    settings: &PluginSettings,
    digest: &str,
    allowed: impl Fn() -> bool,
) -> Result<(CapturedRuntime, PackageOrigin), CommandError> {
    let approval = settings
        .runtimes()
        .iter()
        .find(|entry| entry.environment.digest().ok().as_deref() == Some(digest))
        .ok_or_else(|| map_store_error(InstallError::ApprovalMismatch))?;
    let environment = approval.captured_environment().map_err(map_store_error)?;
    let pin = runtime_bundle::node_pin().map_err(|_| unavailable())?;
    // Deliberately selected older Host snapshots can coexist. Their complete
    // descriptor and current independent decision must still match exactly.
    if approval.origin != runtime_bundle::bundled_origin()
        || !runtime_bundle::supported_tool(environment, &pin)
        || availability(environment, &pin.minimum_system_version) != RuntimeAvailability::Available
    {
        return Err(unavailable());
    }
    let loaded = store
        .load_runtime(approval, allowed)
        .map_err(map_store_error)?;
    Ok((loaded.runtime().clone(), approval.origin.clone()))
}

pub(super) fn capture_offer(
    manager: &PluginManager,
    request: &PluginRuntimeInstallRequest,
    allowed: impl Fn() -> bool,
) -> Result<(CapturedRuntime, RuntimeApproval), CommandError> {
    let bundle = manager.bundle.as_ref().ok_or_else(unavailable)?;
    let offer = bundle.view()?;
    if offer.id != request.id || offer.environment_digest != request.environment_digest {
        return Err(map_store_error(InstallError::ApprovalMismatch));
    }
    if offer.availability != RuntimeAvailability::Available {
        return Err(unavailable());
    }
    let root = bundle.root.as_ref().ok_or_else(unavailable)?;
    let runtime = CapturedRuntime::capture_directories(
        &root.join("tool"),
        &root.join("host"),
        &bundle.metadata.environment,
        allowed,
    )
    .map_err(|error| match error {
        HostError::RuntimeMismatch => {
            let mut error = unavailable();
            error.reason = Some("plugin-runtime-changed".into());
            error
        }
        HostError::MissingArtifact => unavailable(),
        error => map_store_error(error.into()),
    })?;
    Ok((
        runtime,
        RuntimeApproval {
            environment: bundle.metadata.environment.clone().into(),
            origin: bundle.metadata.origin.clone(),
        },
    ))
}

pub(super) fn install_pending(
    store: &mut PackageStore,
    runtime: &CapturedRuntime,
    approval: &RuntimeApproval,
    original: &mut Option<String>,
    action: &str,
    allowed: impl Fn() -> bool,
) -> Result<(), InstallError> {
    if let Some(action) = original {
        store.install_runtime(action, runtime, approval, &allowed)?;
        return Ok(());
    }
    match store.load_runtime(approval, &allowed) {
        Ok(_) => Ok(()),
        Err(InstallError::MissingRuntime) => {
            *original = Some(action.into());
            store
                .install_runtime(action, runtime, approval, allowed)
                .map(|_| ())
        }
        Err(InstallError::RecoveryRequired) => {
            // Independent build metadata, fresh human approval and actual bytes
            // are already fixed. A receipt supplies only the original action.
            let inventory = store.inventory(&allowed)?;
            let record = inventory
                .runtimes
                .iter()
                .find(|record| {
                    record.state == InstalledObjectState::RecoveryRequired
                        && record.receipt.approval() == approval
                })
                .ok_or(InstallError::ApprovalMismatch)?;
            let action = record.receipt.action_id().to_owned();
            *original = Some(action.clone());
            store
                .install_runtime(&action, runtime, approval, allowed)
                .map(|_| ())
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn install_plugin_runtime(
    state: State<'_, AppState>,
    request: PluginRuntimeInstallRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.install_runtime(request)
        })
        .await
}
#[tauri::command]
pub async fn set_plugin_native_host_approval(
    state: State<'_, AppState>,
    request: PluginNativeHostApprovalRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginSettings, move || {
            plugins.set_native_host_approval(request)
        })
        .await
}

#[tauri::command]
pub async fn lookup_plugin_runtime(
    state: State<'_, AppState>,
    request: PluginRuntimeLookupRequest,
) -> Result<sdk::RuntimeEnvironmentDescriptor, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins
                .lookup_runtime(&request.environment_digest)
                .map(|runtime| runtime.descriptor().clone())
        })
        .await
}

#[cfg(test)]
mod tests;
