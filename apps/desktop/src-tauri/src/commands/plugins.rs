//! Application-owned installation metadata and independent trusted decisions.
//! Reading this projection does not load artifacts or grant execution rights.
use super::{AppState, CommandError, CommandErrorCode, CommandStage};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        Mutex, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::State;
use tsumugi_core::execution::{Cancellation, UnsignedDecimal};
use tsumugi_plugin_host::{
    HostError, InstallError, InstalledObjectState, PackageStore, catalog::PackageOrigin,
};
use tsumugi_plugin_sdk as sdk;
pub(super) mod builds;
pub(super) mod defaults;
mod environment;
pub(super) mod generation;
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(in crate::commands) use environment::test_support::Fixture as InstalledFixture;
pub(in crate::commands) mod packages;
pub(super) mod reviews;
pub(super) mod runtimes;
pub(super) mod sources;
pub(super) mod tools;
pub(super) mod translations;
pub use builds::{PluginBuildRequest, PluginBuildView};
pub use defaults::{PluginDefaultsInstallRequest, PluginDefaultsOfferView};
#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(in crate::commands) use environment::test_support::Fixture as InstalledPluginFixture;
pub use generation::{PluginGenerationComponentRequest, PluginGenerationComponentView};
pub use packages::{
    PluginApprovalRemovalRequest, PluginCandidateView, PluginEnableRequest, PluginInstallRequest,
    PluginLookupRequest, PluginPackageDetailsView, PluginPackageRequest, PluginUninstallRequest,
};
pub use reviews::{
    PluginTextReviewAvailability, PluginTextReviewListEntry, PluginTextReviewListView,
    PluginTextReviewRequest, PluginTextReviewSelection, PluginTextReviewView,
};
pub use runtimes::{
    PluginNativeHostApprovalRequest, PluginNativeHostOfferView, PluginRuntimeInstallRequest,
    PluginRuntimeLookupRequest, PluginRuntimeOfferView,
};
pub use sources::{PluginSourceRequest, PluginSourceView};
pub use tools::{PluginToolRequest, PluginToolView};
pub use translations::{PluginTranslationRequest, PluginTranslationView};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginInventoryRequest {}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginOriginView {
    pub source_id: String,
    pub publisher_id: String,
}
impl From<&PackageOrigin> for PluginOriginView {
    fn from(origin: &PackageOrigin) -> Self {
        Self {
            source_id: origin.source_id.clone(),
            publisher_id: origin.publisher_id.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum PluginObjectState {
    Sealed,
    RecoveryRequired,
}
impl From<InstalledObjectState> for PluginObjectState {
    fn from(state: InstalledObjectState) -> Self {
        match state {
            InstalledObjectState::Sealed => Self::Sealed,
            InstalledObjectState::RecoveryRequired => Self::RecoveryRequired,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackageView {
    pub original_install_action: String,
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub origin: PluginOriginView,
    pub state: PluginObjectState,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRuntimeView {
    pub environment: sdk::RuntimeEnvironmentDescriptor,
    pub environment_digest: String,
    pub origin: PluginOriginView,
    pub state: PluginObjectState,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackageDecisionView {
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub origin: PluginOriginView,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRuntimeDecisionView {
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub origin: PluginOriginView,
}

/// An observation of the original retained removal journal. Sealed metadata is
/// not confirmation of an uncertain command's filesystem durability.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginUninstallView {
    pub action_id: String,
    pub settings_revision: UnsignedDecimal,
    pub installation: PluginPackageView,
    pub state: PluginObjectState,
}

/// Installation and approval remain separate even when only one exists. These
/// are metadata observations; Sealed and enabled are not runnable assertions.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginInventoryView {
    pub settings_revision: UnsignedDecimal,
    pub last_settings_action: Option<String>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = tsumugi_plugin_host::MAX_INSTALLED_PACKAGES)))]
    pub packages: Vec<PluginPackageView>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = tsumugi_plugin_host::MAX_INSTALLED_RUNTIMES)))]
    pub runtimes: Vec<PluginRuntimeView>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = tsumugi_plugin_host::MAX_INSTALLED_PACKAGES)))]
    pub uninstallations: Vec<PluginUninstallView>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = tsumugi_plugin_host::MAX_INSTALLED_PACKAGES)))]
    pub package_decisions: Vec<PluginPackageDecisionView>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = tsumugi_plugin_host::MAX_INSTALLED_RUNTIMES)))]
    pub runtime_decisions: Vec<PluginRuntimeDecisionView>,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 1)))]
    pub runtime_offers: Vec<PluginRuntimeOfferView>,
    pub native_host_offer: PluginNativeHostOfferView,
    pub defaults_offer: Option<PluginDefaultsOfferView>,
}

struct PluginDirectory {
    anchor: PathBuf,
    application: String,
}
impl PluginDirectory {
    fn new(app_data: PathBuf) -> Result<Self, CommandError> {
        let invalid = || map_store_error(InstallError::InvalidRoot);
        if !app_data.is_absolute()
            || app_data
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(invalid());
        }
        Ok(Self {
            anchor: app_data.parent().ok_or_else(invalid)?.to_path_buf(),
            application: app_data
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(invalid)?
                .to_owned(),
        })
    }

    fn provision(&self, allowed: impl Fn() -> bool) -> Result<PackageStore, InstallError> {
        let app_data = self.anchor.join(&self.application);
        match std::fs::symlink_metadata(&app_data) {
            // Tauri/WebView can already own an application directory with read
            // permission for other users. Use it as an existing anchor; the
            // Host still checks its owner, no links and no other-user writes.
            // Only the plugins suffix must be private. Never repair permissions.
            Ok(metadata) if metadata.is_dir() => {
                PackageStore::provision(&app_data, &["plugins"], allowed)
            }
            Ok(_) => Err(InstallError::InvalidRoot),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                PackageStore::provision(&self.anchor, &[&self.application, "plugins"], allowed)
            }
            Err(_) => Err(InstallError::Io),
        }
    }
}

#[derive(Default)]
struct PluginManager {
    directory: Option<PluginDirectory>,
    store: Option<PackageStore>,
    picker: Option<(
        tsumugi_core::execution::ExecutionId,
        std::sync::Arc<AtomicBool>,
    )>,
    candidate: Option<packages::Candidate>,
    pending: Option<packages::PendingMutation>,
    bundle: Option<runtimes::Bundle>,
    defaults: Option<defaults::Bundle>,
}

struct EnvironmentEpoch {
    revision: UnsignedDecimal,
    cancellation: Cancellation,
}

/// The mutex serializes application operations; the Store retains its existing
/// OS lock across reads. Contention rejects with Busy rather than parking an IO
/// worker. AppState drop revokes in-flight read guards; accepted IO remains owned
/// until its worker finishes, including when its reply receiver disappears.
pub(super) struct ApplicationPlugins {
    manager: Mutex<PluginManager>,
    open: AtomicBool,
    // Publication contains one ephemeral settings epoch, never Store data or
    // execution grants. Lock order is manager -> publication. Close only takes
    // publication, so it can withdraw authority without waiting for Store IO.
    environment_epoch: Mutex<Option<EnvironmentEpoch>>,
}
impl Default for ApplicationPlugins {
    fn default() -> Self {
        Self {
            manager: Mutex::default(),
            open: AtomicBool::new(true),
            environment_epoch: Mutex::default(),
        }
    }
}
impl ApplicationPlugins {
    pub(super) fn configure(&self, app_data: PathBuf) -> Result<(), CommandError> {
        let directory = PluginDirectory::new(app_data)?;
        let mut manager = self.try_manager()?;
        if manager.directory.is_some() {
            return Err(map_store_error(InstallError::StoreChanged));
        }
        manager.directory = Some(directory);
        Ok(())
    }

    fn try_manager(&self) -> Result<std::sync::MutexGuard<'_, PluginManager>, CommandError> {
        if !self.open.load(Ordering::Acquire) {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        self.manager.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => map_store_error(InstallError::Busy),
            TryLockError::Poisoned(_) => map_store_error(InstallError::CorruptStore),
        })
    }

    pub(super) fn close(&self) {
        self.open.store(false, Ordering::Release);
        // A poisoned publication still owns the original token. Withdraw it
        // rather than leaving in-flight work authorized during shutdown.
        let epoch = self
            .environment_epoch
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(epoch) = epoch.as_ref() {
            epoch.cancellation.request();
        }
    }

    fn revoke_environment_authority(&self) -> Result<(), CommandError> {
        match self.environment_epoch.lock() {
            Ok(epoch) => {
                if let Some(epoch) = epoch.as_ref() {
                    epoch.cancellation.request();
                }
                Ok(())
            }
            Err(error) => {
                let epoch = error.into_inner();
                if let Some(epoch) = epoch.as_ref() {
                    epoch.cancellation.request();
                }
                drop(epoch);
                Err(map_store_error(InstallError::CorruptStore))
            }
        }
    }

    // The caller holds the existing manager and has just read actual settings.
    // No IO or caller operation runs while publication is locked.
    fn capture_environment_authority(
        &self,
        expected: UnsignedDecimal,
        actual: UnsignedDecimal,
    ) -> Result<Cancellation, CommandError> {
        let mut epoch = match self.environment_epoch.lock() {
            Ok(epoch) => epoch,
            Err(error) => {
                let epoch = error.into_inner();
                if let Some(epoch) = epoch.as_ref() {
                    epoch.cancellation.request();
                }
                drop(epoch);
                return Err(map_store_error(InstallError::CorruptStore));
            }
        };
        if !self.open.load(Ordering::Acquire) {
            if let Some(epoch) = epoch.as_ref() {
                epoch.cancellation.request();
            }
            drop(epoch);
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        if let Some(epoch) = epoch.as_ref().filter(|epoch| epoch.revision != actual) {
            epoch.cancellation.request();
        }
        if expected != actual {
            drop(epoch);
            let mut error = CommandError::simple(
                CommandErrorCode::DependencyConflict,
                CommandStage::ExecutionRecover,
            );
            error.reason = Some("plugin-settings-changed".into());
            return Err(error);
        }
        if epoch
            .as_ref()
            .is_none_or(|epoch| epoch.cancellation.is_requested())
        {
            *epoch = Some(EnvironmentEpoch {
                revision: actual,
                cancellation: Cancellation::default(),
            });
        }
        Ok(epoch
            .as_ref()
            .expect("current settings epoch")
            .cancellation
            .clone())
    }

    fn provision(&self, manager: &mut PluginManager) -> Result<(), CommandError> {
        let allowed = || self.open.load(Ordering::Acquire);
        if manager.store.is_none() {
            let directory = manager
                .directory
                .as_ref()
                .ok_or_else(|| map_store_error(InstallError::InvalidRoot))?;
            // Provision through the Host's existing filesystem and lock owner.
            manager.store = Some(directory.provision(allowed).map_err(map_store_error)?);
        }
        Ok(())
    }

    fn inventory(&self) -> Result<PluginInventoryView, CommandError> {
        let mut manager = self.try_manager()?;
        self.inventory_locked(&mut manager)
    }

    fn inventory_locked(
        &self,
        manager: &mut PluginManager,
    ) -> Result<PluginInventoryView, CommandError> {
        self.provision(manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("store provisioned");
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let inventory = store.inventory(allowed).map_err(map_store_error)?;
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        Ok(PluginInventoryView {
            settings_revision: settings.revision().into(),
            last_settings_action: settings.action_id().map(str::to_owned),
            packages: inventory
                .packages
                .into_iter()
                .map(|record| PluginPackageView {
                    original_install_action: record.receipt.action_id().into(),
                    plugin: record.receipt.plugin().clone(),
                    package_digest: record.receipt.package_digest().into(),
                    origin: record.receipt.origin().into(),
                    state: record.state.into(),
                })
                .collect(),
            runtimes: inventory
                .runtimes
                .into_iter()
                .map(|record| {
                    Ok(PluginRuntimeView {
                        environment: record
                            .receipt
                            .approval()
                            .captured_environment()
                            .map_err(map_store_error)?
                            .clone(),
                        environment_digest: record.receipt.environment_digest().into(),
                        origin: (&record.receipt.approval().origin).into(),
                        state: record.state.into(),
                    })
                })
                .collect::<Result<Vec<_>, CommandError>>()?,
            uninstallations: store
                .uninstallations(allowed)
                .map_err(map_store_error)?
                .into_iter()
                .map(|record| {
                    let installation = record.receipt.installation();
                    PluginUninstallView {
                        action_id: record.receipt.action_id().into(),
                        settings_revision: record.receipt.settings_revision().into(),
                        installation: PluginPackageView {
                            original_install_action: installation.action_id().into(),
                            plugin: installation.plugin().clone(),
                            package_digest: installation.package_digest().into(),
                            origin: installation.origin().into(),
                            state: record.state.into(),
                        },
                        state: record.state.into(),
                    }
                })
                .collect(),
            package_decisions: settings
                .packages()
                .iter()
                .map(|decision| PluginPackageDecisionView {
                    plugin: decision.approval.plugin.clone(),
                    package_digest: decision.approval.package_digest.clone(),
                    origin: (&decision.approval.origin).into(),
                    enabled: decision.enabled,
                })
                .collect(),
            runtime_decisions: settings
                .runtimes()
                .iter()
                .map(|approval| {
                    Ok(PluginRuntimeDecisionView {
                        environment: approval.environment.clone(),
                        environment_digest: approval
                            .environment
                            .digest()
                            .map_err(|_| map_store_error(InstallError::CorruptSettings))?,
                        origin: (&approval.origin).into(),
                    })
                })
                .collect::<Result<Vec<_>, CommandError>>()?,
            defaults_offer: manager
                .defaults
                .as_ref()
                .map(|bundle| bundle.view(manager))
                .transpose()?,
            runtime_offers: manager
                .bundle
                .as_ref()
                .map(runtimes::Bundle::view)
                .transpose()?
                .into_iter()
                .collect(),
            native_host_offer: runtimes::native_host_offer(),
        })
    }
}

fn map_store_error(error: InstallError) -> CommandError {
    let (code, reason) = match error {
        InstallError::UnsupportedPlatform => (
            CommandErrorCode::DependencyConflict,
            "plugin-platform-unavailable",
        ),
        InstallError::InvalidRoot => (
            CommandErrorCode::PermissionDenied,
            "plugin-directory-unavailable",
        ),
        InstallError::Busy => (CommandErrorCode::Busy, "plugin-store-busy"),
        InstallError::StoreChanged => {
            (CommandErrorCode::DependencyConflict, "plugin-store-changed")
        }
        InstallError::CorruptSettings => {
            (CommandErrorCode::OutputInvalid, "plugin-settings-corrupt")
        }
        InstallError::CorruptStore | InstallError::CorruptReceipt => {
            (CommandErrorCode::OutputInvalid, "plugin-store-corrupt")
        }
        InstallError::LimitExceeded => (CommandErrorCode::LimitExceeded, "plugin-store-limit"),
        InstallError::AuthorityRevoked => (CommandErrorCode::Cancelled, "plugin-read-cancelled"),
        InstallError::Io => (CommandErrorCode::StorageFailed, "plugin-store-io"),
        InstallError::Host(HostError::Timeout) => {
            (CommandErrorCode::LimitExceeded, "plugin-read-timeout")
        }
        InstallError::UnknownCommit => (
            CommandErrorCode::OutcomeUnknown,
            "plugin-store-outcome-unknown",
        ),
        InstallError::InvalidAction => (CommandErrorCode::InvalidInput, "plugin-action-invalid"),
        InstallError::RevisionConflict => {
            (CommandErrorCode::StaleRevision, "plugin-settings-changed")
        }
        InstallError::MissingPackage => (
            CommandErrorCode::DependencyConflict,
            "plugin-package-missing",
        ),
        InstallError::MissingRuntime => (
            CommandErrorCode::DependencyConflict,
            "plugin-runtime-missing",
        ),
        InstallError::RecoveryRequired => (
            CommandErrorCode::DependencyConflict,
            "plugin-recovery-required",
        ),
        InstallError::ApprovalMismatch => (
            CommandErrorCode::PermissionDenied,
            "plugin-approval-mismatch",
        ),
        InstallError::ActionConflict => (
            CommandErrorCode::DependencyConflict,
            "plugin-action-conflict",
        ),
        InstallError::IdentityConflict => (
            CommandErrorCode::DependencyConflict,
            "plugin-identity-conflict",
        ),
        InstallError::SourceConflict => (
            CommandErrorCode::DependencyConflict,
            "plugin-source-conflict",
        ),
        InstallError::PublisherConflict => (
            CommandErrorCode::DependencyConflict,
            "plugin-publisher-conflict",
        ),
        InstallError::Host(HostError::PackageMismatch) => (
            CommandErrorCode::DependencyConflict,
            "plugin-candidate-changed",
        ),
        InstallError::Host(_) | InstallError::Catalog(_) => {
            (CommandErrorCode::OutputInvalid, "plugin-metadata-invalid")
        }
    };
    let mut error = CommandError::simple(code, CommandStage::Read);
    error.reason = Some(reason.into());
    error
}

#[tauri::command]
pub async fn read_plugin_inventory(
    state: State<'_, AppState>,
    request: PluginInventoryRequest,
) -> Result<PluginInventoryView, CommandError> {
    let PluginInventoryRequest {} = request;
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || plugins.inventory())
        .await
}

#[cfg(test)]
mod tests;
