//! Exact local package decisions. No worker is launched by these operations.
use super::*;
pub(in crate::commands) mod cleanup;
pub use cleanup::{PluginApprovalRemovalRequest, PluginUninstallRequest};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    ApprovedPackageSetting, PackageImage, PluginSettings, PluginSettingsUpdate,
    catalog::{
        CatalogError, PackageApproval, PackageCatalog, RegisteredPackage, ResolvedCapability,
    },
};

const CANDIDATE_LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginCandidateView {
    pub ticket: ExecutionId,
    pub manifest: sdk::PluginManifest,
    pub package_digest: String,
    pub manifest_sha256: String,
    pub file_count: u32,
    pub byte_count: UnsignedDecimal,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginInstallRequest {
    pub ticket: ExecutionId,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackageRequest {
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginEnableRequest {
    pub package: PluginPackageRequest,
    pub enabled: bool,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackageDetailsView {
    pub manifest: sdk::PluginManifest,
    pub package_digest: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginLookupRequest {
    pub provider: sdk::ProviderSelectionBinding,
}

pub(super) struct Candidate {
    directory: PathBuf,
    view: PluginCandidateView,
    expires: Instant,
}

struct PickerLease {
    id: ExecutionId,
    cancelled: std::sync::Arc<AtomicBool>,
}
impl Drop for PickerLease {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(in crate::commands) enum MutationRequest {
    Install(PluginInstallRequest),
    Enable(PluginEnableRequest),
    Runtime(PluginRuntimeInstallRequest),
    NativeHost(PluginNativeHostApprovalRequest),
    Defaults(PluginDefaultsInstallRequest),
    ApprovalRemoval(PluginApprovalRemovalRequest),
    Uninstall(PluginUninstallRequest),
}

impl MutationRequest {
    pub(in crate::commands) fn stage(&self) -> CommandStage {
        match self {
            Self::Install(_) | Self::Runtime(_) | Self::Defaults(_) | Self::Uninstall(_) => {
                CommandStage::PluginInstall
            }
            Self::Enable(_) | Self::NativeHost(_) | Self::ApprovalRemoval(_) => {
                CommandStage::PluginSettings
            }
        }
    }
    fn action_id(&self) -> ExecutionId {
        match self {
            Self::Install(r) => r.action_id,
            Self::Enable(r) => r.action_id,
            Self::Runtime(r) => r.action_id,
            Self::NativeHost(r) => r.action_id,
            Self::Defaults(r) => r.action_id,
            Self::ApprovalRemoval(r) => r.action_id,
            Self::Uninstall(r) => r.action_id,
        }
    }
    fn expected_revision(&self) -> u64 {
        match self {
            Self::Install(r) => r.expected_revision.get(),
            Self::Enable(r) => r.expected_revision.get(),
            Self::Runtime(r) => r.expected_revision.get(),
            Self::NativeHost(r) => r.expected_revision.get(),
            Self::Defaults(r) => r.expected_revision.get(),
            Self::ApprovalRemoval(r) => r.expected_revision.get(),
            Self::Uninstall(r) => r.expected_revision.get(),
        }
    }
}

pub(super) struct PendingMutation {
    request: MutationRequest,
    desired: PluginSettingsUpdate,
    packages: Vec<PendingPackage>,
    runtime: Option<PendingRuntime>,
    settings_confirmed: bool,
    complete: bool,
    unknown: bool,
    running: std::sync::Arc<AtomicBool>,
    handoff_complete: bool,
}
struct PendingPackage {
    package: RegisteredPackage,
    action: String,
    original: Option<String>,
}
struct PendingRuntime {
    runtime: tsumugi_plugin_host::CapturedRuntime,
    approval: tsumugi_plugin_host::RuntimeApproval,
    action: String,
    original: Option<String>,
}
impl PendingMutation {
    fn action(&self) -> String {
        self.request.action_id().to_string()
    }
    fn revision(&self) -> u64 {
        self.request.expected_revision()
    }
}

fn failure(code: CommandErrorCode, reason: &str, stage: CommandStage) -> CommandError {
    let mut error = CommandError::simple(code, stage);
    error.reason = Some(reason.into());
    error
}
fn at_stage(error: InstallError, stage: CommandStage) -> CommandError {
    let mut error = map_store_error(error);
    error.stage = stage;
    error
}
pub(super) fn catalog_error(error: CatalogError) -> CommandError {
    match error {
        CatalogError::DisabledPackage => failure(
            CommandErrorCode::PermissionDenied,
            "plugin-disabled",
            CommandStage::Read,
        ),
        _ => at_stage(InstallError::Catalog(error), CommandStage::Read),
    }
}

/// Each artifact keeps its own original durability action, including partial
/// defaults setup. One receipt cannot substitute another object's confirmation.
fn install_package_pending(
    store: &mut PackageStore,
    package: &RegisteredPackage,
    original: &mut Option<String>,
    action: &str,
    allowed: impl Fn() -> bool,
) -> Result<(), InstallError> {
    if let Some(original) = original {
        store.install(original, package, allowed)?;
        return Ok(());
    }
    let approval = PackageApproval {
        plugin: package.plugin().clone(),
        package_digest: package.package_digest().into(),
        origin: package.origin().clone(),
    };
    match store.load(&approval, &allowed) {
        Ok(_) => Ok(()),
        Err(InstallError::MissingPackage) => {
            *original = Some(action.into());
            store.install(action, package, allowed).map(|_| ())
        }
        Err(InstallError::RecoveryRequired) => {
            let inventory = store.inventory(&allowed)?;
            let record = inventory
                .packages
                .iter()
                .find(|record| {
                    record.state == InstalledObjectState::RecoveryRequired
                        && record.receipt.plugin() == &approval.plugin
                        && record.receipt.package_digest() == approval.package_digest
                        && record.receipt.origin() == &approval.origin
                })
                .ok_or(InstallError::ApprovalMismatch)?;
            let action = record.receipt.action_id().to_owned();
            *original = Some(action.clone());
            store.install(&action, package, allowed).map(|_| ())
        }
        Err(error) => Err(error),
    }
}

impl ApplicationPlugins {
    /// MockRuntime does not deliver the destruction event that releases Tauri's
    /// managed application owner. After the test has closed its project and
    /// joined its workers, dispose only this already closed owner's Store.
    /// This fixture bridge does not verify native application exit behavior.
    #[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
    pub(in crate::commands) fn dispose_closed_store_for_test(&self) -> Result<(), CommandError> {
        if self.open.load(Ordering::Acquire) {
            return Err(failure(
                CommandErrorCode::Busy,
                "plugin-owner-open",
                CommandStage::Read,
            ));
        }
        // try_manager intentionally rejects closed owners. This disposal stays
        // inside the same owning layer and never reopens execution authority.
        let mut manager = self.manager.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => map_store_error(InstallError::Busy),
            TryLockError::Poisoned(_) => map_store_error(InstallError::CorruptStore),
        })?;
        if manager.picker.is_some()
            || manager.pending.as_ref().is_some_and(|pending| {
                !pending.complete
                    || !pending.handoff_complete
                    || pending.unknown
                    || pending.running.load(Ordering::Acquire)
            })
        {
            return Err(failure(
                CommandErrorCode::Busy,
                "plugin-operation-pending",
                CommandStage::Read,
            ));
        }
        drop(manager.store.take());
        Ok(())
    }

    /// Supplies only a test-owned picker result to the original capture owner.
    /// The caller still needs the returned ticket, exact settings CAS and the
    /// registered installation command; this neither installs nor approves.
    #[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
    pub(in crate::commands) fn capture_candidate_for_test(
        &self,
        directory: PathBuf,
    ) -> Result<PluginCandidateView, CommandError> {
        let picker = self.begin_picker()?;
        self.finish_picker(picker.id, Some(directory))?
            .ok_or_else(|| {
                failure(
                    CommandErrorCode::Cancelled,
                    "plugin-selection-expired",
                    CommandStage::Read,
                )
            })
    }

    fn begin_picker(&self) -> Result<PickerLease, CommandError> {
        let mut manager = self.try_manager()?;
        if manager
            .picker
            .as_ref()
            .is_some_and(|(_, cancelled)| cancelled.load(Ordering::Acquire))
        {
            manager.picker = None;
        }
        if manager.picker.is_some()
            || manager.pending.as_ref().is_some_and(|pending| {
                !pending.complete
                    || !pending.handoff_complete
                    || pending.unknown
                    || pending.running.load(Ordering::Acquire)
            })
        {
            return Err(failure(
                CommandErrorCode::Busy,
                "plugin-operation-pending",
                CommandStage::Read,
            ));
        }
        let picker = ExecutionId::new();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        manager.picker = Some((picker, cancelled.clone()));
        Ok(PickerLease {
            id: picker,
            cancelled,
        })
    }

    fn finish_picker(
        &self,
        picker: ExecutionId,
        directory: Option<PathBuf>,
    ) -> Result<Option<PluginCandidateView>, CommandError> {
        let mut manager = self.try_manager()?;
        if manager
            .picker
            .as_ref()
            .is_none_or(|(id, cancelled)| *id != picker || cancelled.load(Ordering::Acquire))
        {
            return Err(failure(
                CommandErrorCode::Cancelled,
                "plugin-selection-expired",
                CommandStage::Read,
            ));
        }
        let (_, cancelled) = manager.picker.take().expect("current picker");
        let Some(directory) = directory else {
            return Ok(None);
        };
        let allowed = || self.open.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire);
        let inspection = PackageImage::inspect_directory(&directory, allowed)
            .map_err(|error| at_stage(error.into(), CommandStage::Read))?;
        // Reuse the Host capture owner to obtain the complete declaration for
        // review. This observed digest is not source authentication or approval.
        let image =
            PackageImage::capture_directory(&directory, &inspection.package_digest, allowed)
                .map_err(|error| at_stage(error.into(), CommandStage::Read))?;
        let view = PluginCandidateView {
            ticket: picker,
            manifest: image.manifest().manifest().clone(),
            package_digest: inspection.package_digest,
            manifest_sha256: inspection.manifest_sha256,
            file_count: inspection.file_count,
            byte_count: inspection.byte_count.into(),
        };
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        manager.candidate = Some(Candidate {
            directory,
            view: view.clone(),
            expires: Instant::now() + CANDIDATE_LIFETIME,
        });
        Ok(Some(view))
    }

    fn install_package(
        &self,
        request: PluginInstallRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        self.mutate(MutationRequest::Install(request))
    }
    fn enable_package(
        &self,
        request: PluginEnableRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        self.mutate(MutationRequest::Enable(request))
    }

    pub(super) fn mutate(
        &self,
        request: MutationRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        let stage = request.stage();
        if matches!(
            request,
            MutationRequest::ApprovalRemoval(_) | MutationRequest::Uninstall(_)
        ) {
            return Err(failure(
                CommandErrorCode::InvalidInput,
                "plugin-lifecycle-coordinator",
                stage,
            ));
        }
        let mut manager = self.try_manager().map_err(|mut error| {
            error.stage = stage;
            error
        })?;
        if manager
            .picker
            .as_ref()
            .is_some_and(|(_, cancelled)| cancelled.load(Ordering::Acquire))
        {
            manager.picker = None;
        }
        if manager.picker.is_some() {
            return Err(failure(
                CommandErrorCode::Busy,
                "plugin-operation-pending",
                stage,
            ));
        }
        self.provision(&mut manager).map_err(|mut error| {
            error.stage = stage;
            error
        })?;
        let allowed = || self.open.load(Ordering::Acquire);
        let same = manager
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request == request);
        if !same {
            if manager.pending.as_ref().is_some_and(|pending| {
                !pending.complete
                    || !pending.handoff_complete
                    || pending.unknown
                    || pending.running.load(Ordering::Acquire)
            }) {
                return Err(failure(
                    CommandErrorCode::Busy,
                    "plugin-operation-pending",
                    stage,
                ));
            }
            let store = manager.store.as_ref().expect("store provisioned");
            let settings = store
                .settings(allowed)
                .map_err(|error| at_stage(error, stage))?;
            let expected = request.expected_revision();
            if expected != settings.revision() {
                return Err(at_stage(InstallError::RevisionConflict, stage));
            }
            let mut desired = PluginSettingsUpdate {
                packages: settings.packages().to_vec(),
                runtimes: settings.runtimes().to_vec(),
            };
            let mut runtime = None;
            let mut bundled_packages = Vec::new();
            let package = match &request {
                MutationRequest::Install(request) => {
                    let candidate = manager
                        .candidate
                        .as_ref()
                        .filter(|candidate| {
                            candidate.view.ticket == request.ticket
                                && Instant::now() < candidate.expires
                        })
                        .ok_or_else(|| {
                            failure(
                                CommandErrorCode::DependencyConflict,
                                "plugin-selection-expired",
                                stage,
                            )
                        })?;
                    let image = PackageImage::capture_directory(
                        &candidate.directory,
                        &candidate.view.package_digest,
                        allowed,
                    )
                    .map_err(|error| at_stage(error.into(), stage))?;
                    // The application records explicit manual trust, never a
                    // publisher-authentication claim derived from the manifest.
                    let approval = PackageApproval {
                        plugin: candidate.view.manifest.plugin.clone(),
                        package_digest: candidate.view.package_digest.clone(),
                        origin: PackageOrigin {
                            source_id: "manual-local".into(),
                            publisher_id: "manual-approval".into(),
                        },
                    };
                    let mut catalog = PackageCatalog::new();
                    catalog
                        .register(image, approval.clone())
                        .map_err(|error| at_stage(error.into(), stage))?;
                    if let Some(prior) = desired
                        .packages
                        .iter()
                        .find(|entry| entry.approval.plugin == approval.plugin)
                    {
                        if prior.approval != approval {
                            return Err(at_stage(InstallError::ApprovalMismatch, stage));
                        }
                    } else {
                        desired.packages.push(ApprovedPackageSetting {
                            approval: approval.clone(),
                            enabled: false,
                        });
                    }
                    Some(
                        catalog
                            .registered(&approval.plugin)
                            .map_err(catalog_error)?
                            .clone(),
                    )
                }
                MutationRequest::Enable(request) => {
                    let decision = desired
                        .packages
                        .iter_mut()
                        .find(|entry| {
                            entry.approval.plugin == request.package.plugin
                                && entry.approval.package_digest == request.package.package_digest
                        })
                        .ok_or_else(|| at_stage(InstallError::ApprovalMismatch, stage))?;
                    // Disabling remains possible when bytes are missing/broken.
                    if request.enabled {
                        store
                            .load(&decision.approval, allowed)
                            .map_err(|error| at_stage(error, stage))?;
                    }
                    decision.enabled = request.enabled;
                    None
                }
                MutationRequest::Runtime(request) => {
                    let captured = runtimes::capture_offer(&manager, request, allowed).map_err(
                        |mut error| {
                            error.stage = stage;
                            error
                        },
                    )?;
                    if let Some(prior) = desired
                        .runtimes
                        .iter()
                        .find(|prior| prior.environment == captured.1.environment)
                    {
                        if prior != &captured.1 {
                            return Err(at_stage(InstallError::ApprovalMismatch, stage));
                        }
                    } else {
                        desired.runtimes.push(captured.1.clone());
                    }
                    runtime = Some(captured);
                    None
                }
                MutationRequest::NativeHost(request) => {
                    sdk::validate_package_digest(&request.environment_digest)
                        .map_err(|_| at_stage(InstallError::ApprovalMismatch, stage))?;
                    if request.approved {
                        let approval =
                            runtimes::capture_native_approval(&request.environment_digest, allowed)
                                .map_err(|mut error| {
                                    error.stage = stage;
                                    error
                                })?;
                        if let Some(prior) = desired.runtimes.iter().find(|prior| {
                            prior.environment.digest().ok().as_deref()
                                == Some(&request.environment_digest)
                        }) {
                            if prior != &approval {
                                return Err(at_stage(InstallError::ApprovalMismatch, stage));
                            }
                        } else {
                            desired.runtimes.push(approval);
                        }
                    } else {
                        // An obsolete application decision remains removable.
                        // A Native action cannot revoke an installed Node identity.
                        let index = desired
                            .runtimes
                            .iter()
                            .position(|prior| {
                                matches!(
                                    prior.environment,
                                    sdk::ExecutionEnvironmentDescriptor::Native(_)
                                ) && prior.environment.digest().ok().as_deref()
                                    == Some(&request.environment_digest)
                            })
                            .ok_or_else(|| at_stage(InstallError::ApprovalMismatch, stage))?;
                        desired.runtimes.remove(index);
                    }
                    None
                }
                MutationRequest::ApprovalRemoval(_) | MutationRequest::Uninstall(_) => {
                    return Err(failure(
                        CommandErrorCode::InvalidInput,
                        "plugin-lifecycle-coordinator",
                        stage,
                    ));
                }
                MutationRequest::Defaults(request) => {
                    let captured = defaults::capture_offer(&manager, request, allowed)?;
                    for package in &captured.0 {
                        let approval = PackageApproval {
                            plugin: package.plugin().clone(),
                            package_digest: package.package_digest().into(),
                            origin: package.origin().clone(),
                        };
                        if let Some(prior) = desired
                            .packages
                            .iter()
                            .find(|prior| prior.approval.plugin == approval.plugin)
                        {
                            if prior.approval != approval {
                                return Err(at_stage(InstallError::ApprovalMismatch, stage));
                            }
                            // Keep an existing explicit disable decision.
                        } else {
                            desired.packages.push(ApprovedPackageSetting {
                                approval,
                                enabled: true,
                            });
                        }
                    }
                    if let Some(prior) = desired
                        .runtimes
                        .iter()
                        .find(|prior| prior.environment == captured.2.environment)
                    {
                        if prior != &captured.2 {
                            return Err(at_stage(InstallError::ApprovalMismatch, stage));
                        }
                    } else {
                        desired.runtimes.push(captured.2.clone());
                    }
                    bundled_packages = captured.0;
                    runtime = Some((captured.1, captured.2));
                    None
                }
            };
            let is_defaults = matches!(&request, MutationRequest::Defaults(_));
            let action = request.action_id().to_string();
            let mut package_steps = Vec::new();
            if let Some(package) = package {
                package_steps.push(PendingPackage {
                    package,
                    action: action.clone(),
                    original: None,
                });
            }
            package_steps.extend(bundled_packages.into_iter().map(|package| PendingPackage {
                package,
                action: ExecutionId::new().to_string(),
                original: None,
            }));
            let runtime = runtime.map(|(runtime, approval)| PendingRuntime {
                runtime,
                approval,
                action: if is_defaults {
                    ExecutionId::new().to_string()
                } else {
                    action
                },
                original: None,
            });
            manager.pending = Some(PendingMutation {
                request,
                desired,
                packages: package_steps,
                runtime,
                settings_confirmed: false,
                complete: false,
                unknown: false,
                running: std::sync::Arc::new(AtomicBool::new(false)),
                handoff_complete: true,
            });
        }
        let PluginManager { store, pending, .. } = &mut *manager;
        let store = store.as_mut().expect("store provisioned");
        let pending = pending.as_mut().expect("intent captured");
        if !pending.complete {
            let result = (|| {
                if !pending.settings_confirmed {
                    store.update_settings(
                        pending.revision(),
                        &pending.action(),
                        &pending.desired,
                        allowed,
                    )?;
                    pending.settings_confirmed = true;
                }
                for step in &mut pending.packages {
                    install_package_pending(
                        store,
                        &step.package,
                        &mut step.original,
                        &step.action,
                        allowed,
                    )?;
                }
                if let Some(step) = &mut pending.runtime {
                    runtimes::install_pending(
                        store,
                        &step.runtime,
                        &step.approval,
                        &mut step.original,
                        &step.action,
                        allowed,
                    )?;
                }
                Ok::<_, InstallError>(())
            })();
            if let Err(error) = result {
                pending.unknown |= error == InstallError::UnknownCommit;
                if pending.unknown {
                    return Err(failure(
                        CommandErrorCode::OutcomeUnknown,
                        "plugin-result-unconfirmed",
                        stage,
                    ));
                }
                let failure = at_stage(error, stage);
                if pending.settings_confirmed {
                    // Installation follows the original confirmed approval.
                    // Keep that accepted partial result and its frozen request.
                    return Err(cleanup::original_required(failure));
                }
                // Store reports every uncertain settings promotion as Unknown.
                // A known rejection before confirmation has no active settings
                // or installation result owned by this proposed mutation.
                manager.pending = None;
                return Err(failure);
            }
            pending.complete = true;
            pending.unknown = false;
            // A confirmed install no longer needs its potentially large frozen
            // trees. A lost inventory ACK retains the original completed intent.
            pending.runtime = None;
        }
        // A lost projection/ACK must retain the accepted immutable intent; retry
        // confirms its exact original result rather than generating a new action.
        match self.inventory_locked(&mut manager) {
            Ok(view) => {
                manager.pending.as_mut().expect("intent retained").unknown = false;
                Ok(view)
            }
            Err(_) => {
                manager.pending.as_mut().expect("intent retained").unknown = true;
                Err(failure(
                    CommandErrorCode::OutcomeUnknown,
                    "plugin-result-unconfirmed",
                    stage,
                ))
            }
        }
    }

    fn package_details(
        &self,
        request: PluginPackageRequest,
    ) -> Result<PluginPackageDetailsView, CommandError> {
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let decision = settings
            .packages()
            .iter()
            .find(|entry| {
                entry.approval.plugin == request.plugin
                    && entry.approval.package_digest == request.package_digest
            })
            .ok_or_else(|| map_store_error(InstallError::ApprovalMismatch))?;
        let loaded = store
            .load(&decision.approval, allowed)
            .map_err(map_store_error)?;
        let view = PluginPackageDetailsView {
            manifest: loaded.image().manifest().manifest().clone(),
            package_digest: request.package_digest,
            enabled: decision.enabled,
        };
        if store.settings(allowed).map_err(map_store_error)? != settings {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        Ok(view)
    }

    pub(super) fn lookup(
        &self,
        provider: &sdk::ProviderSelectionBinding,
    ) -> Result<ResolvedCapability, CommandError> {
        provider.validate().map_err(|_| {
            failure(
                CommandErrorCode::InvalidInput,
                "plugin-binding-invalid",
                CommandStage::Read,
            )
        })?;
        let mut manager = self.try_manager()?;
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let catalog = load_enabled_catalog(
            store,
            &settings,
            &PluginPackageRequest {
                plugin: provider.plugin.clone(),
                package_digest: provider.package_digest.clone(),
            },
            allowed,
        )?;
        let resolved = catalog.lookup(provider).map_err(catalog_error)?;
        if store.settings(allowed).map_err(map_store_error)? != settings {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        Ok(resolved)
    }
}

/// Shared eligibility/capture owner for a fresh exact capability or a complete
/// source environment. Approval and enablement never grant execution rights.
pub(super) fn load_enabled_catalog(
    store: &PackageStore,
    settings: &PluginSettings,
    request: &PluginPackageRequest,
    allowed: impl Fn() -> bool,
) -> Result<PackageCatalog, CommandError> {
    let decision = settings
        .packages()
        .iter()
        .find(|entry| {
            entry.approval.plugin == request.plugin
                && entry.approval.package_digest == request.package_digest
        })
        .ok_or_else(|| map_store_error(InstallError::ApprovalMismatch))?;
    if !decision.enabled {
        return Err(catalog_error(CatalogError::DisabledPackage));
    }
    let loaded = store
        .load(&decision.approval, allowed)
        .map_err(map_store_error)?;
    let mut catalog = PackageCatalog::new();
    catalog
        .register(loaded.image().clone(), decision.approval.clone())
        .map_err(catalog_error)?;
    catalog
        .set_enabled(&request.plugin, true)
        .map_err(catalog_error)?;
    Ok(catalog)
}

#[tauri::command]
pub async fn select_plugin_package<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: PluginInventoryRequest,
) -> Result<Option<PluginCandidateView>, CommandError> {
    let PluginInventoryRequest {} = request;
    let plugins = state.plugins.clone();
    let picker = plugins.begin_picker()?;
    let selected = state
        .dialogs
        .run(CommandStage::Read, move || {
            Ok(app.dialog().file().blocking_pick_folder())
        })
        .await;
    state
        .io
        .run(CommandStage::Read, move || match selected {
            Ok(selected) => plugins.finish_picker(
                picker.id,
                selected
                    .map(|path| path.into_path())
                    .transpose()
                    .map_err(|_| map_store_error(InstallError::InvalidRoot))?,
            ),
            Err(error) => {
                plugins.finish_picker(picker.id, None)?;
                Err(error)
            }
        })
        .await
}

#[tauri::command]
pub async fn install_plugin_package(
    state: State<'_, AppState>,
    request: PluginInstallRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.install_package(request)
        })
        .await
}
#[tauri::command]
pub async fn set_plugin_enabled(
    state: State<'_, AppState>,
    request: PluginEnableRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginSettings, move || {
            plugins.enable_package(request)
        })
        .await
}
#[tauri::command]
pub async fn read_plugin_package(
    state: State<'_, AppState>,
    request: PluginPackageRequest,
) -> Result<PluginPackageDetailsView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || plugins.package_details(request))
        .await
}
#[tauri::command]
pub async fn lookup_plugin_capability(
    state: State<'_, AppState>,
    request: PluginLookupRequest,
) -> Result<sdk::CapabilityBinding, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins
                .lookup(&request.provider)
                .map(|resolved| resolved.binding().clone())
        })
        .await
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;
