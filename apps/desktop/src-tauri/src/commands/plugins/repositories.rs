//! Explicit offline repository trust and exact, independently chosen packages.
//! Repository metadata never grants execution or chooses a package version.
use super::packages::{at_stage, failure};
use super::*;
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    PluginSettings,
    catalog::{PackageApproval, RegisteredPackage},
    repository::{
        CapturedOfflineRepository, CapturedRepositoryRoot, RepositoryError,
        VerifiedOfflineRepository,
    },
};

pub(super) fn repository_error(error: RepositoryError) -> CommandError {
    let (code, reason) = match error {
        RepositoryError::WorkingStateOutcomeUnknown => {
            (CommandErrorCode::OutcomeUnknown, "plugin-repository-state")
        }
        RepositoryError::WorkingStateUnavailable => {
            (CommandErrorCode::StorageFailed, "plugin-repository-state")
        }
        RepositoryError::ClockChanged => (
            CommandErrorCode::DependencyConflict,
            "plugin-repository-clock",
        ),
        RepositoryError::ExpiredMetadata => (
            CommandErrorCode::DependencyConflict,
            "plugin-repository-expired",
        ),
        RepositoryError::MetadataRollback => (
            CommandErrorCode::DependencyConflict,
            "plugin-repository-rollback",
        ),
        RepositoryError::SignatureRejected | RepositoryError::TrustedRootMismatch => (
            CommandErrorCode::PermissionDenied,
            "plugin-repository-signature",
        ),
        RepositoryError::LimitExceeded | RepositoryError::Timeout => (
            CommandErrorCode::LimitExceeded,
            "plugin-repository-metadata",
        ),
        RepositoryError::AuthorityRevoked => (CommandErrorCode::Cancelled, "plugin-read-cancelled"),
        _ => (
            CommandErrorCode::OutputInvalid,
            "plugin-repository-metadata",
        ),
    };
    failure(code, reason, CommandStage::PluginInstall)
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositorySelectionView {
    pub ticket: ExecutionId,
    pub source_id: String,
    pub root_fingerprint: String,
    pub capture_digest: String,
    pub revision: UnsignedDecimal,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositoryRefreshRequest {
    pub ticket: ExecutionId,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositoryResumeRequest {
    pub source_id: String,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum PluginRepositoryState {
    Pending,
    Verified,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositorySourceView {
    pub source_id: String,
    pub display_name: Option<String>,
    pub root_fingerprint: String,
    pub revision: UnsignedDecimal,
    pub action_id: Option<ExecutionId>,
    pub expected_revision: Option<UnsignedDecimal>,
    pub state: PluginRepositoryState,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositorySourcesView {
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub sources: Vec<PluginRepositorySourceView>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum PluginRepositoryInstallKind {
    Install,
    Update,
    Rollback,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositoryMemberView {
    pub manifest: sdk::PluginManifest,
    pub package_digest: String,
    pub file_count: u32,
    pub byte_count: UnsignedDecimal,
    pub origin: PluginOriginView,
    pub kind: PluginRepositoryInstallKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositoryVerifiedView {
    pub ticket: ExecutionId,
    pub source_id: String,
    pub revision: UnsignedDecimal,
    pub action_id: ExecutionId,
    pub capture_digest: String,
    pub display_name: String,
    pub root_version: UnsignedDecimal,
    pub timestamp_version: UnsignedDecimal,
    pub snapshot_version: UnsignedDecimal,
    pub targets_version: UnsignedDecimal,
    /// Decimal UTC epoch milliseconds. Negative dates are never admitted.
    pub expires_at_unix_milliseconds: UnsignedDecimal,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 16)))]
    pub packages: Vec<PluginRepositoryMemberView>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositoryMemberRequest {
    pub package: PluginPackageRequest,
    pub kind: PluginRepositoryInstallKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginRepositoryInstallRequest {
    pub ticket: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 16)))]
    pub members: Vec<PluginRepositoryMemberRequest>,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

pub(super) struct VerifiedCandidate {
    ticket: ExecutionId,
    verified: VerifiedOfflineRepository,
    revision: u64,
    action: ExecutionId,
    expires: Instant,
    verified_wall_clock: SystemTime,
}

pub(super) struct Candidate {
    ticket: ExecutionId,
    root: CapturedRepositoryRoot,
    captured: CapturedOfflineRepository,
    source_id: String,
    expires: Instant,
}

/// Distinguish deliberate software rollback from an update using retained local
/// knowledge. TUF metadata rollback is always refused by the verifier itself.
fn installation_kind<'a>(
    package: &RegisteredPackage,
    prior: impl IntoIterator<Item = &'a PackageApproval>,
) -> Result<PluginRepositoryInstallKind, CommandError> {
    let target = semver::Version::parse(&package.plugin().version)
        .map_err(|_| at_stage(InstallError::ApprovalMismatch, CommandStage::Read))?;
    let mut highest: Option<semver::Version> = None;
    for approval in prior {
        if approval.plugin.id != package.plugin().id {
            continue;
        }
        // Conflicts stay visible in review and are refused by the original
        // settings preflight before any package approvals are promoted.
        let version = semver::Version::parse(&approval.plugin.version)
            .map_err(|_| at_stage(InstallError::CorruptReceipt, CommandStage::Read))?;
        if highest
            .as_ref()
            .is_none_or(|old| old.cmp_precedence(&version).is_lt())
        {
            highest = Some(version);
        }
    }
    Ok(match highest.map(|old| target.cmp_precedence(&old)) {
        Some(std::cmp::Ordering::Less) => PluginRepositoryInstallKind::Rollback,
        Some(std::cmp::Ordering::Greater) => PluginRepositoryInstallKind::Update,
        _ => PluginRepositoryInstallKind::Install,
    })
}

fn prior_approvals(
    store: &PackageStore,
    settings: &PluginSettings,
    allowed: impl Fn() -> bool,
) -> Result<Vec<PackageApproval>, CommandError> {
    let mut prior: Vec<_> = settings
        .packages()
        .iter()
        .map(|p| p.approval.clone())
        .collect();
    for record in store.inventory(&allowed).map_err(map_store_error)?.packages {
        prior.push(PackageApproval {
            plugin: record.receipt.plugin().clone(),
            package_digest: record.receipt.package_digest().into(),
            origin: record.receipt.origin().clone(),
        });
    }
    for record in store.uninstallations(allowed).map_err(map_store_error)? {
        let receipt = record.receipt.installation();
        prior.push(PackageApproval {
            plugin: receipt.plugin().clone(),
            package_digest: receipt.package_digest().into(),
            origin: receipt.origin().clone(),
        });
    }
    Ok(prior)
}

pub(super) fn capture_offer(
    manager: &PluginManager,
    request: &PluginRepositoryInstallRequest,
    settings: &PluginSettings,
    allowed: impl Fn() -> bool,
) -> Result<Vec<RegisteredPackage>, CommandError> {
    let stage = CommandStage::PluginInstall;
    let invalid = || {
        failure(
            CommandErrorCode::InvalidInput,
            "plugin-repository-selection",
            stage,
        )
    };
    if request.members.is_empty() || request.members.len() > 16 {
        return Err(invalid());
    }
    let candidate = manager
        .repository_verified
        .as_ref()
        .filter(|candidate| {
            candidate.ticket == request.ticket && Instant::now() < candidate.expires
        })
        .ok_or_else(|| {
            failure(
                CommandErrorCode::DependencyConflict,
                "plugin-selection-expired",
                stage,
            )
        })?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| invalid())?
        .as_millis();
    if candidate
        .verified
        .metadata()
        .earliest_expiration_unix_milliseconds
        < 0
        || now
            >= candidate
                .verified
                .metadata()
                .earliest_expiration_unix_milliseconds as u128
    {
        return Err(failure(
            CommandErrorCode::DependencyConflict,
            "plugin-repository-expired",
            stage,
        ));
    }
    if SystemTime::now()
        .duration_since(candidate.verified_wall_clock)
        .is_err()
    {
        return Err(repository_error(RepositoryError::ClockChanged));
    }
    check_verified_current(manager, candidate, &allowed)?;
    let prior = prior_approvals(
        manager.store.as_ref().expect("provisioned"),
        settings,
        allowed,
    )?;
    let mut seen = BTreeSet::new();
    request
        .members
        .iter()
        .map(|selection| {
            let package = candidate
                .verified
                .packages()
                .iter()
                .find(|package| {
                    package.plugin() == &selection.package.plugin
                        && package.package_digest() == selection.package.package_digest
                })
                .ok_or_else(invalid)?;
            if !seen.insert(package.plugin().id.clone())
                || installation_kind(package, &prior)? != selection.kind
            {
                return Err(invalid());
            }
            Ok(package.clone())
        })
        .collect()
}

fn check_verified_current(
    manager: &PluginManager,
    candidate: &VerifiedCandidate,
    allowed: impl Fn() -> bool,
) -> Result<(), CommandError> {
    let sources = manager
        .store
        .as_ref()
        .expect("provisioned")
        .repository_sources(allowed)
        .map_err(map_store_error)?;
    if !sources.iter().any(|source| {
        source.source_id == candidate.verified.source_id()
            && source.revision == candidate.revision
            && source.last_action_id.as_deref() == Some(candidate.action.to_string().as_str())
            && source.pending.is_none()
            && source.last_error.is_none()
    }) {
        return Err(failure(
            CommandErrorCode::DependencyConflict,
            "plugin-repository-changed",
            CommandStage::PluginInstall,
        ));
    }
    Ok(())
}

fn ensure_idle(manager: &PluginManager) -> Result<(), CommandError> {
    if manager
        .picker
        .as_ref()
        .is_some_and(|(_, cancelled)| !cancelled.load(Ordering::Acquire))
        || manager
            .pending
            .as_ref()
            .is_some_and(packages::PendingMutation::blocks_new_operation)
    {
        return Err(failure(
            CommandErrorCode::Busy,
            "plugin-operation-pending",
            CommandStage::PluginInstall,
        ));
    }
    Ok(())
}

impl ApplicationPlugins {
    fn repository_failure(
        &self,
        manager: &PluginManager,
        source_id: &str,
        action: ExecutionId,
        error: InstallError,
    ) -> CommandError {
        let mut error = map_store_error(error);
        error.stage = CommandStage::PluginInstall;
        let pending = manager.store.as_ref().is_some_and(|store| {
            match store.repository_sources(|| self.open.load(Ordering::Acquire)) {
                Ok(sources) => sources.iter().any(|source| {
                    source.source_id == source_id
                        && source
                            .pending
                            .as_ref()
                            .is_some_and(|pending| pending.action_id == action.to_string())
                }),
                // An unreadable accepted source cannot justify discarding its
                // original recovery intent. Observation never clears Unknown.
                Err(_) => true,
            }
        });
        if pending {
            packages::cleanup::original_required(error)
        } else {
            error
        }
    }
    /// Observe an existing Store without creating the application directory or
    /// an empty trust database. Absence is distinguished from unsafe/corrupt IO.
    fn open_repository_store_if_present(
        &self,
        manager: &mut PluginManager,
    ) -> Result<(), CommandError> {
        if manager.store.is_none() {
            let directory = manager
                .directory
                .as_ref()
                .ok_or_else(|| map_store_error(InstallError::InvalidRoot))?;
            let root = directory
                .anchor
                .join(&directory.application)
                .join("plugins");
            match std::fs::symlink_metadata(&root) {
                Ok(_) => {
                    manager.store =
                        Some(PackageStore::open_existing(&root).map_err(map_store_error)?)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(map_store_error(InstallError::Io)),
            }
        }
        if !self.open.load(Ordering::Acquire) {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        Ok(())
    }

    fn repository_sources_view(&self) -> Result<PluginRepositorySourcesView, CommandError> {
        let mut manager = self.try_manager()?;
        self.open_repository_store_if_present(&mut manager)?;
        let sources = match manager.store.as_ref() {
            Some(store) => store
                .repository_sources(|| self.open.load(Ordering::Acquire))
                .map_err(map_store_error)?,
            None => vec![],
        };
        Ok(PluginRepositorySourcesView {
            sources: sources
                .into_iter()
                .map(|source| {
                    let action_id = source
                        .pending
                        .as_ref()
                        .map(|pending| pending.action_id.as_str())
                        .or(source.last_action_id.as_deref())
                        .map(ExecutionId::parse)
                        .transpose()
                        .map_err(|_| map_store_error(InstallError::CorruptStore))?;
                    Ok(PluginRepositorySourceView {
                        source_id: source.source_id,
                        display_name: source.display_name,
                        root_fingerprint: source.initial_root_fingerprint,
                        revision: source.revision.into(),
                        action_id,
                        expected_revision: source
                            .pending
                            .as_ref()
                            .map(|p| p.expected_revision)
                            .or_else(|| {
                                source
                                    .last_action_id
                                    .as_ref()
                                    .and(source.revision.checked_sub(1))
                            })
                            .map(Into::into),
                        state: if source.pending.is_some() {
                            PluginRepositoryState::Pending
                        } else if source.last_error.is_some() {
                            PluginRepositoryState::Rejected
                        } else {
                            PluginRepositoryState::Verified
                        },
                    })
                })
                .collect::<Result<_, CommandError>>()?,
        })
    }

    fn finish_repository_picker(
        &self,
        picker: ExecutionId,
        selected: Option<(PathBuf, PathBuf)>,
    ) -> Result<Option<PluginRepositorySelectionView>, CommandError> {
        let mut manager = self.try_manager()?;
        let cancelled = packages::take_picker(&mut manager, picker)?;
        let Some((directory, root_path)) = selected else {
            return Ok(None);
        };
        let allowed = || self.open.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire);
        let root =
            CapturedRepositoryRoot::capture_file(&root_path, allowed).map_err(repository_error)?;
        let source_id =
            tsumugi_plugin_host::repository_source_id(root.bytes()).map_err(map_store_error)?;
        let captured = CapturedOfflineRepository::capture_directory(&directory, allowed)
            .map_err(repository_error)?;
        self.open_repository_store_if_present(&mut manager)?;
        let sources = manager
            .store
            .as_ref()
            .map(|store| store.repository_sources(allowed))
            .transpose()
            .map_err(map_store_error)?
            .unwrap_or_default();
        let revision = sources
            .iter()
            .find(|source| source.source_id == source_id)
            .map_or(0, |source| source.revision);
        let view = PluginRepositorySelectionView {
            ticket: picker,
            source_id: source_id.clone(),
            root_fingerprint: root.fingerprint().into(),
            capture_digest: captured.capture_digest().into(),
            revision: revision.into(),
        };
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        manager.candidate = None;
        manager.pack_candidate = None;
        manager.repository_verified = None;
        manager.repository_candidate = Some(Candidate {
            ticket: picker,
            root,
            captured,
            source_id,
            expires: Instant::now() + packages::CANDIDATE_LIFETIME,
        });
        Ok(Some(view))
    }

    fn finish_repository_verification(
        &self,
        manager: &mut PluginManager,
        action: ExecutionId,
        expected_revision: u64,
        verified: VerifiedOfflineRepository,
    ) -> Result<PluginRepositoryVerifiedView, CommandError> {
        let allowed = || self.open.load(Ordering::Acquire);
        let store = manager.store.as_ref().expect("provisioned");
        let source = store
            .repository_sources(allowed)
            .map_err(map_store_error)?
            .into_iter()
            .find(|source| source.source_id == verified.source_id())
            .ok_or_else(|| map_store_error(InstallError::CorruptStore))?;
        if source.revision
            != expected_revision
                .checked_add(1)
                .ok_or_else(|| map_store_error(InstallError::LimitExceeded))?
            || source.last_action_id.as_deref() != Some(action.to_string().as_str())
            || source.pending.is_some()
            || source.last_error.is_some()
        {
            return Err(map_store_error(InstallError::UnknownCommit));
        }
        let settings = store.settings(allowed).map_err(map_store_error)?;
        let prior = prior_approvals(store, &settings, allowed)?;
        let packages = verified
            .packages()
            .iter()
            .map(|package| {
                let inspection = package.image().inspection();
                Ok(PluginRepositoryMemberView {
                    manifest: package.image().manifest().manifest().clone(),
                    package_digest: inspection.package_digest,
                    file_count: inspection.file_count,
                    byte_count: inspection.byte_count.into(),
                    origin: package.origin().into(),
                    kind: installation_kind(package, &prior)?,
                })
            })
            .collect::<Result<_, CommandError>>()?;
        let wall_clock = SystemTime::now();
        let now = wall_clock
            .duration_since(UNIX_EPOCH)
            .map_err(|_| repository_error(RepositoryError::ClockChanged))?
            .as_millis();
        let expiration = u64::try_from(verified.metadata().earliest_expiration_unix_milliseconds)
            .map_err(|_| repository_error(RepositoryError::ExpiredMetadata))?;
        let remaining = (expiration as u128)
            .checked_sub(now)
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| repository_error(RepositoryError::ExpiredMetadata))?;
        let lifetime =
            Duration::from_millis(u64::try_from(remaining.min(600_000)).expect("bounded"));
        let ticket = ExecutionId::new();
        let metadata = verified.metadata();
        let view = PluginRepositoryVerifiedView {
            ticket,
            source_id: verified.source_id().into(),
            revision: source.revision.into(),
            action_id: action,
            capture_digest: verified.capture_digest().into(),
            display_name: verified.catalog().display_name.clone(),
            root_version: metadata.root_version.into(),
            timestamp_version: metadata.timestamp_version.into(),
            snapshot_version: metadata.snapshot_version.into(),
            targets_version: metadata.targets_version.into(),
            expires_at_unix_milliseconds: expiration.into(),
            packages,
        };
        manager.repository_verified = Some(VerifiedCandidate {
            ticket,
            verified,
            revision: source.revision,
            action,
            expires: Instant::now() + lifetime,
            verified_wall_clock: wall_clock,
        });
        Ok(view)
    }

    fn refresh_repository(
        self: &Arc<Self>,
        request: PluginRepositoryRefreshRequest,
    ) -> Result<PluginRepositoryVerifiedView, CommandError> {
        let mut manager = self.try_manager()?;
        ensure_idle(&manager)?;
        self.provision(&mut manager)?;
        let candidate = manager
            .repository_candidate
            .as_ref()
            .filter(|c| c.ticket == request.ticket)
            .ok_or_else(|| {
                failure(
                    CommandErrorCode::DependencyConflict,
                    "plugin-selection-expired",
                    CommandStage::PluginInstall,
                )
            })?;
        let store = manager.store.as_ref().expect("provisioned");
        let source = store
            .repository_sources(|| self.open.load(Ordering::Acquire))
            .map_err(map_store_error)?
            .into_iter()
            .find(|source| source.source_id == candidate.source_id);
        let original = source.as_ref().is_some_and(|source| {
            source.pending.as_ref().is_some_and(|p| {
                p.action_id == request.action_id.to_string()
                    && p.expected_revision == request.expected_revision.get()
                    && p.capture_digest == candidate.captured.capture_digest()
            }) || source.last_action_id.as_deref() == Some(request.action_id.to_string().as_str())
        });
        if Instant::now() >= candidate.expires && !original {
            return Err(failure(
                CommandErrorCode::DependencyConflict,
                "plugin-selection-expired",
                CommandStage::PluginInstall,
            ));
        }
        let captured = candidate.captured.clone();
        let trust_request = tsumugi_plugin_host::RepositoryRefreshRequest {
            source_id: candidate.source_id.clone(),
            expected_revision: request.expected_revision.get(),
            action_id: request.action_id.to_string(),
            initial_root: candidate.root.bytes().to_vec(),
            capture_digest: captured.capture_digest().into(),
        };
        manager.repository_verified = None;
        let owner = self.clone();
        let verified = match manager
            .store
            .as_mut()
            .expect("provisioned")
            .refresh_repository(&trust_request, &captured, move || {
                owner.open.load(Ordering::Acquire)
            }) {
            Ok(verified) => verified,
            Err(error) => {
                return Err(self.repository_failure(
                    &manager,
                    &trust_request.source_id,
                    request.action_id,
                    error,
                ));
            }
        };
        self.finish_repository_verification(
            &mut manager,
            request.action_id,
            request.expected_revision.get(),
            verified,
        )
    }

    fn resume_repository(
        self: &Arc<Self>,
        request: PluginRepositoryResumeRequest,
    ) -> Result<PluginRepositoryVerifiedView, CommandError> {
        let mut manager = self.try_manager()?;
        ensure_idle(&manager)?;
        self.provision(&mut manager)?;
        manager.repository_verified = None;
        let owner = self.clone();
        let verified = match manager
            .store
            .as_mut()
            .expect("provisioned")
            .resume_repository(
                &request.source_id,
                request.expected_revision.get(),
                &request.action_id.to_string(),
                move || owner.open.load(Ordering::Acquire),
            ) {
            Ok(verified) => verified,
            Err(error) => {
                return Err(self.repository_failure(
                    &manager,
                    &request.source_id,
                    request.action_id,
                    error,
                ));
            }
        };
        self.finish_repository_verification(
            &mut manager,
            request.action_id,
            request.expected_revision.get(),
            verified,
        )
    }
}

#[tauri::command]
pub async fn select_plugin_repository<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: PluginInventoryRequest,
) -> Result<Option<PluginRepositorySelectionView>, CommandError> {
    let PluginInventoryRequest {} = request;
    let plugins = state.plugins.clone();
    let picker = plugins.begin_picker()?;
    let selected = state
        .dialogs
        .run(CommandStage::Read, move || {
            let Some(directory) = app.dialog().file().blocking_pick_folder() else {
                return Ok(None);
            };
            let Some(root) = app.dialog().file().blocking_pick_file() else {
                return Ok(None);
            };
            let directory = directory
                .into_path()
                .map_err(|_| map_store_error(InstallError::InvalidRoot))?;
            let root = root
                .into_path()
                .map_err(|_| map_store_error(InstallError::InvalidRoot))?;
            Ok(Some((directory, root)))
        })
        .await;
    state
        .io
        .run(CommandStage::Read, move || match selected {
            Ok(selected) => plugins.finish_repository_picker(picker.id, selected),
            Err(error) => {
                plugins.finish_repository_picker(picker.id, None)?;
                Err(error)
            }
        })
        .await
}

#[tauri::command]
pub async fn read_plugin_repositories(
    state: State<'_, AppState>,
    request: PluginInventoryRequest,
) -> Result<PluginRepositorySourcesView, CommandError> {
    let PluginInventoryRequest {} = request;
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.repository_sources_view()
        })
        .await
}

#[tauri::command]
pub async fn refresh_plugin_repository(
    state: State<'_, AppState>,
    request: PluginRepositoryRefreshRequest,
) -> Result<PluginRepositoryVerifiedView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.refresh_repository(request)
        })
        .await
}

#[tauri::command]
pub async fn resume_plugin_repository(
    state: State<'_, AppState>,
    request: PluginRepositoryResumeRequest,
) -> Result<PluginRepositoryVerifiedView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.resume_repository(request)
        })
        .await
}

#[tauri::command]
pub async fn install_repository_packages(
    state: State<'_, AppState>,
    request: PluginRepositoryInstallRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.mutate(packages::MutationRequest::RepositoryInstall(request))
        })
        .await
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;
