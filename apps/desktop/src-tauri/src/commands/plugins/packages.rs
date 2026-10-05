//! Exact local package decisions. No worker is launched by these operations.
use super::*;
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
pub(super) enum MutationRequest {
    Install(PluginInstallRequest),
    Enable(PluginEnableRequest),
    Runtime(PluginRuntimeInstallRequest),
}

pub(super) struct PendingMutation {
    request: MutationRequest,
    desired: PluginSettingsUpdate,
    package: Option<RegisteredPackage>,
    runtime: Option<(
        tsumugi_plugin_host::CapturedRuntime,
        tsumugi_plugin_host::RuntimeApproval,
    )>,
    settings_confirmed: bool,
    install_action: Option<String>,
    complete: bool,
    unknown: bool,
}
impl PendingMutation {
    fn action(&self) -> String {
        match &self.request {
            MutationRequest::Install(request) => request.action_id.to_string(),
            MutationRequest::Enable(request) => request.action_id.to_string(),
            MutationRequest::Runtime(request) => request.action_id.to_string(),
        }
    }
    fn revision(&self) -> u64 {
        match &self.request {
            MutationRequest::Install(request) => request.expected_revision.get(),
            MutationRequest::Enable(request) => request.expected_revision.get(),
            MutationRequest::Runtime(request) => request.expected_revision.get(),
        }
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

impl ApplicationPlugins {
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
            || manager
                .pending
                .as_ref()
                .is_some_and(|pending| pending.unknown)
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
        let stage = match &request {
            MutationRequest::Install(_) => CommandStage::PluginInstall,
            MutationRequest::Runtime(_) => CommandStage::PluginInstall,
            MutationRequest::Enable(_) => CommandStage::PluginSettings,
        };
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
            if manager
                .pending
                .as_ref()
                .is_some_and(|pending| pending.unknown)
            {
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
            let expected = match &request {
                MutationRequest::Install(request) => request.expected_revision.get(),
                MutationRequest::Enable(request) => request.expected_revision.get(),
                MutationRequest::Runtime(request) => request.expected_revision.get(),
            };
            if expected != settings.revision() {
                return Err(at_stage(InstallError::RevisionConflict, stage));
            }
            let mut desired = PluginSettingsUpdate {
                packages: settings.packages().to_vec(),
                runtimes: settings.runtimes().to_vec(),
            };
            let mut runtime = None;
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
            };
            manager.pending = Some(PendingMutation {
                request,
                desired,
                package,
                runtime,
                settings_confirmed: false,
                install_action: None,
                complete: false,
                unknown: false,
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
                if let Some(package) = &pending.package {
                    let approval = PackageApproval {
                        plugin: package.plugin().clone(),
                        package_digest: package.package_digest().into(),
                        origin: package.origin().clone(),
                    };
                    if let Some(action) = &pending.install_action {
                        // Readability/visibility is insufficient after an unknown
                        // promotion. The original action confirms durability.
                        store.install(action, package, allowed)?;
                    } else {
                        match store.load(&approval, allowed) {
                            Ok(_) => {} // An independently approved sealed object needs no reinstallation.
                            Err(InstallError::MissingPackage) => {
                                let action = pending.action();
                                pending.install_action = Some(action.clone());
                                store.install(&action, package, allowed)?;
                            }
                            Err(InstallError::RecoveryRequired) => {
                                // Current human approval and recaptured bytes
                                // are already fixed independently. The receipt
                                // supplies only the original recovery action.
                                let inventory = store.inventory(allowed)?;
                                let record = inventory
                                    .packages
                                    .iter()
                                    .find(|record| {
                                        record.state == InstalledObjectState::RecoveryRequired
                                            && record.receipt.plugin() == &approval.plugin
                                            && record.receipt.package_digest()
                                                == approval.package_digest
                                            && record.receipt.origin() == &approval.origin
                                    })
                                    .ok_or(InstallError::ApprovalMismatch)?;
                                let action = record.receipt.action_id().to_owned();
                                pending.install_action = Some(action.clone());
                                store.install(&action, package, allowed)?;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
                if let Some((runtime, approval)) = &pending.runtime {
                    let action = pending.action();
                    runtimes::install_pending(
                        store,
                        runtime,
                        approval,
                        &mut pending.install_action,
                        &action,
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
                return Err(at_stage(error, stage));
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
