//! Installation decisions retain one exact intent across Session and Store IO.
use super::*;
use std::sync::Arc;
use tsumugi_plugin_host::{InstallReceipt, UninstallReceipt};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginApprovalRemovalRequest {
    pub package: PluginPackageRequest,
    pub origin: PluginOriginView,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginUninstallRequest {
    pub package: PluginPackageRequest,
    pub origin: PluginOriginView,
    pub original_install_action: String,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

impl MutationRequest {
    fn cleanup_package(&self) -> Result<PluginPackageRequest, CommandError> {
        match self {
            Self::ApprovalRemoval(r) => Ok(r.package.clone()),
            Self::Uninstall(r) => Ok(r.package.clone()),
            _ => Err(failure(
                CommandErrorCode::InvalidInput,
                "plugin-cleanup-request",
                self.stage(),
            )),
        }
    }
    fn cleanup_approval(&self) -> Result<PackageApproval, CommandError> {
        let (package, origin) = match self {
            Self::ApprovalRemoval(r) => (&r.package, &r.origin),
            Self::Uninstall(r) => (&r.package, &r.origin),
            _ => {
                return Err(failure(
                    CommandErrorCode::InvalidInput,
                    "plugin-cleanup-request",
                    self.stage(),
                ));
            }
        };
        package
            .plugin
            .validate()
            .and_then(|_| sdk::validate_package_digest(&package.package_digest))
            .map_err(|_| at_stage(InstallError::ApprovalMismatch, self.stage()))?;
        Ok(PackageApproval {
            plugin: package.plugin.clone(),
            package_digest: package.package_digest.clone(),
            origin: PackageOrigin {
                source_id: origin.source_id.clone(),
                publisher_id: origin.publisher_id.clone(),
            },
        })
    }
}

fn installation_matches(request: &PluginUninstallRequest, receipt: &InstallReceipt) -> bool {
    receipt.action_id() == request.original_install_action
        && receipt.plugin() == &request.package.plugin
        && receipt.package_digest() == request.package.package_digest
        && PluginOriginView::from(receipt.origin()) == request.origin
}
fn removal_matches(request: &PluginUninstallRequest, receipt: &UninstallReceipt) -> bool {
    receipt.action_id() == request.action_id.to_string()
        && receipt.settings_revision() == request.expected_revision.get()
        && installation_matches(request, receipt.installation())
}

/// Only the accepted continuation owns this claim. It can relinquish running
/// ownership without discarding a Busy/Unknown intent or the Session fence.
struct CleanupClaim {
    running: Arc<AtomicBool>,
    durable_complete: bool,
}
impl Drop for CleanupClaim {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}

pub(super) fn original_required(mut error: CommandError) -> CommandError {
    // Retaining an accepted intent is distinct from an unknown Store commit.
    // Preserve its original classification and require the same request.
    error.recovery_required = true;
    error.recovery_guidance = Some(crate::commands::RecoveryGuidance::ReconcileOriginal);
    error
}

impl ApplicationPlugins {
    fn begin_cleanup(&self, request: &MutationRequest) -> Result<CleanupClaim, CommandError> {
        let stage = request.stage();
        let approval = request.cleanup_approval()?;
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
                pending.request != *request
                    && (!pending.complete
                        || !pending.handoff_complete
                        || pending.unknown
                        || pending.running.load(Ordering::Acquire))
            })
        {
            return Err(failure(
                CommandErrorCode::Busy,
                "plugin-operation-pending",
                stage,
            ));
        }
        self.provision(&mut manager)?;
        let allowed = || self.open.load(Ordering::Acquire);
        let same = manager
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request == *request);
        if !same {
            let store = manager.store.as_ref().expect("store provisioned");
            let settings = store.settings(allowed).map_err(|e| at_stage(e, stage))?;
            let mut desired = PluginSettingsUpdate {
                packages: settings.packages().to_vec(),
                runtimes: settings.runtimes().to_vec(),
            };
            match request {
                MutationRequest::ApprovalRemoval(_) => {
                    if settings.revision() != request.expected_revision() {
                        return Err(at_stage(InstallError::RevisionConflict, stage));
                    }
                    let index = desired
                        .packages
                        .iter()
                        .position(|entry| entry.approval == approval)
                        .ok_or_else(|| at_stage(InstallError::ApprovalMismatch, stage))?;
                    // Revocation remains available when the installed bytes are
                    // missing or corrupt; the trusted settings own this decision.
                    desired.packages.remove(index);
                }
                MutationRequest::Uninstall(r) => {
                    let records = store
                        .uninstallations(allowed)
                        .map_err(|e| at_stage(e, stage))?;
                    if let Some(record) = records
                        .iter()
                        .find(|record| record.receipt.action_id() == r.action_id.to_string())
                    {
                        if !removal_matches(r, &record.receipt) {
                            return Err(at_stage(InstallError::ActionConflict, stage));
                        }
                    } else {
                        if records.len() >= tsumugi_plugin_host::MAX_INSTALLED_PACKAGES {
                            return Err(at_stage(InstallError::LimitExceeded, stage));
                        }
                        if settings.revision() != r.expected_revision.get() {
                            return Err(at_stage(InstallError::RevisionConflict, stage));
                        }
                        if settings.packages().iter().any(|entry| {
                            entry.approval.plugin == approval.plugin
                                || entry.approval.package_digest == approval.package_digest
                        }) {
                            return Err(at_stage(InstallError::Busy, stage));
                        }
                        let inventory = store.inventory(allowed).map_err(|e| at_stage(e, stage))?;
                        let record = inventory
                            .packages
                            .iter()
                            .find(|record| installation_matches(r, &record.receipt))
                            .ok_or_else(|| at_stage(InstallError::ApprovalMismatch, stage))?;
                        if record.state != InstalledObjectState::Sealed {
                            return Err(at_stage(InstallError::RecoveryRequired, stage));
                        }
                    }
                }
                _ => {
                    return Err(failure(
                        CommandErrorCode::InvalidInput,
                        "plugin-cleanup-request",
                        stage,
                    ));
                }
            }
            manager.pending = Some(PendingMutation {
                request: request.clone(),
                desired,
                packages: Vec::new(),
                runtime: None,
                settings_confirmed: false,
                complete: false,
                unknown: false,
                running: Arc::new(AtomicBool::new(false)),
                handoff_complete: false,
            });
        }
        let pending = manager.pending.as_ref().expect("intent captured");
        if pending
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(original_required(failure(
                CommandErrorCode::Busy,
                "plugin-operation-pending",
                stage,
            )));
        }
        let mut claim = CleanupClaim {
            running: pending.running.clone(),
            durable_complete: false,
        };
        let result = (|| -> Result<(), CommandError> {
            match request {
                MutationRequest::Uninstall(r) => {
                    let store = manager.store.as_mut().expect("store provisioned");
                    let records = store
                        .uninstallations(allowed)
                        .map_err(|e| at_stage(e, stage))?;
                    if let Some(record) = records
                        .iter()
                        .find(|record| record.receipt.action_id() == r.action_id.to_string())
                    {
                        if !removal_matches(r, &record.receipt) {
                            return Err(at_stage(InstallError::ActionConflict, stage));
                        }
                        if record.state == InstalledObjectState::Sealed {
                            // This confirms the original bytes and filesystem sync.
                            // It must precede any new target stop: a completed old
                            // action may coexist with a later installation.
                            store
                                .uninstall(
                                    r.expected_revision.get(),
                                    &r.action_id.to_string(),
                                    &approval,
                                    allowed,
                                )
                                .and_then(|receipt| {
                                    if !removal_matches(r, &receipt) {
                                        return Err(InstallError::ActionConflict);
                                    }
                                    claim.durable_complete = true;
                                    Ok(())
                                })
                                .map_err(|error| at_stage(error, stage))
                        } else {
                            Ok(())
                        }
                    } else {
                        Ok(())
                    }
                }
                MutationRequest::ApprovalRemoval(_)
                    if manager.pending.as_ref().expect("captured").complete =>
                {
                    let PluginManager { store, pending, .. } = &mut *manager;
                    let pending = pending.as_ref().expect("captured");
                    store
                        .as_mut()
                        .expect("provisioned")
                        .update_settings(
                            pending.revision(),
                            &pending.action(),
                            &pending.desired,
                            allowed,
                        )
                        .map(|_| {
                            claim.durable_complete = true;
                        })
                        .map_err(|error| at_stage(error, stage))
                }
                _ => Ok(()),
            }
        })();
        if let Err(error) = result {
            let pending = manager.pending.as_mut().expect("captured");
            pending.unknown |= error.code == CommandErrorCode::OutcomeUnknown;
            return Err(
                if !pending.complete || !pending.handoff_complete || pending.unknown {
                    original_required(error)
                } else {
                    error
                },
            );
        }
        Ok(claim)
    }

    fn confirm_cleanup_handoff(&self, request: &MutationRequest) -> Result<(), CommandError> {
        let mut manager = self.try_manager()?;
        let pending = manager
            .pending
            .as_mut()
            .filter(|pending| pending.request == *request && pending.complete)
            .ok_or_else(|| at_stage(InstallError::ActionConflict, request.stage()))?;
        pending.handoff_complete = true;
        pending.unknown = false;
        Ok(())
    }

    fn withdraw_cleanup_approval(&self, request: &MutationRequest) -> Result<(), CommandError> {
        if !matches!(request, MutationRequest::ApprovalRemoval(_)) {
            return Ok(());
        }
        let mut manager = self.try_manager()?;
        let allowed = || self.open.load(Ordering::Acquire);
        let PluginManager { store, pending, .. } = &mut *manager;
        let pending = pending
            .as_mut()
            .filter(|pending| pending.request == *request)
            .ok_or_else(|| at_stage(InstallError::ActionConflict, request.stage()))?;
        if !pending.settings_confirmed {
            let result = store.as_mut().expect("provisioned").update_settings(
                pending.revision(),
                &pending.action(),
                &pending.desired,
                allowed,
            );
            if let Err(error) = result {
                pending.unknown |= error == InstallError::UnknownCommit;
                return Err(at_stage(error, request.stage()));
            }
            pending.settings_confirmed = true;
        }
        Ok(())
    }

    fn commit_cleanup_store(
        &self,
        request: &MutationRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        let mut manager = self.try_manager()?;
        let allowed = || self.open.load(Ordering::Acquire);
        let PluginManager { store, pending, .. } = &mut *manager;
        let pending = pending
            .as_mut()
            .filter(|pending| pending.request == *request)
            .ok_or_else(|| at_stage(InstallError::ActionConflict, request.stage()))?;
        let store = store.as_mut().expect("provisioned");
        let result = match request {
            MutationRequest::ApprovalRemoval(_) => store
                .update_settings(
                    pending.revision(),
                    &pending.action(),
                    &pending.desired,
                    allowed,
                )
                .map(|_| ()),
            MutationRequest::Uninstall(r) => {
                let approval = request.cleanup_approval()?;
                let records = store
                    .uninstallations(allowed)
                    .map_err(|e| at_stage(e, request.stage()))?;
                if let Some(record) = records
                    .iter()
                    .find(|record| record.receipt.action_id() == r.action_id.to_string())
                {
                    if !removal_matches(r, &record.receipt) {
                        return Err(at_stage(InstallError::ActionConflict, request.stage()));
                    }
                } else {
                    // Identity and original installation action are checked in
                    // this same manager-held IO step immediately before removal.
                    let inventory = store
                        .inventory(allowed)
                        .map_err(|e| at_stage(e, request.stage()))?;
                    if !inventory
                        .packages
                        .iter()
                        .any(|record| installation_matches(r, &record.receipt))
                    {
                        return Err(at_stage(InstallError::ApprovalMismatch, request.stage()));
                    }
                }
                store
                    .uninstall(
                        r.expected_revision.get(),
                        &r.action_id.to_string(),
                        &approval,
                        allowed,
                    )
                    .and_then(|receipt| {
                        if removal_matches(r, &receipt) {
                            Ok(())
                        } else {
                            Err(InstallError::ActionConflict)
                        }
                    })
            }
            _ => {
                return Err(failure(
                    CommandErrorCode::InvalidInput,
                    "plugin-cleanup-request",
                    request.stage(),
                ));
            }
        };
        if let Err(error) = result {
            pending.unknown |= error == InstallError::UnknownCommit;
            return Err(at_stage(error, request.stage()));
        }
        pending.complete = true;
        pending.unknown = false;
        self.inventory_locked(&mut manager).map_err(|_| {
            manager.pending.as_mut().expect("captured").unknown = true;
            failure(
                CommandErrorCode::OutcomeUnknown,
                "plugin-result-unconfirmed",
                request.stage(),
            )
        })
    }
}

async fn cleanup(
    state: &AppState,
    request: MutationRequest,
) -> Result<PluginInventoryView, CommandError> {
    let stage = request.stage();
    let lease = state.sessions.lease(stage)?;
    let initial = request.clone();
    let admitted = lease.submit("plugin_cleanup.begin", stage, move |sessions| {
        sessions.begin_package_operation(initial)
    })?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    // The original continuation owns every subsequent stage even if the webview
    // no longer receives its reply. The target guard never waits on this owner.
    tauri::async_runtime::spawn(async move {
        let (new_hold, operation_claim) = admitted.await?;
        let initial = request.clone();
        let owner = plugins.clone();
        let claim = match io.run(stage, move || owner.begin_cleanup(&initial)).await {
            Ok(claim) => claim,
            Err(error) => {
                if new_hold
                    && error.outcome != crate::commands::CommandOutcome::Unknown
                    && !error.recovery_required
                {
                    let original = request.clone();
                    lease
                        .run("plugin_cleanup.reject", stage, move |sessions| {
                            sessions.finish_package_operation(&original)
                        })
                        .await
                        .map_err(original_required)?;
                }
                return Err(if !new_hold {
                    original_required(error)
                } else {
                    error
                });
            }
        };
        let result = async {
            if !claim.durable_complete {
                let original = request.clone();
                lease
                    .run("plugin_cleanup.stop", stage, move |sessions| {
                        sessions
                            .begin_plugin_cleanup(original.action_id(), original.cleanup_package()?)
                    })
                    .await?;
                let original = request.clone();
                let owner = plugins.clone();
                io.run(stage, move || owner.withdraw_cleanup_approval(&original))
                    .await?;
                let action = request.action_id();
                lease
                    .run("plugin_cleanup.drain", stage, move |sessions| {
                        sessions.finish_plugin_cleanup(action)
                    })
                    .await?;
            }
            let original = request.clone();
            let owner = plugins.clone();
            let view = io
                .run(stage, move || owner.commit_cleanup_store(&original))
                .await?;
            let original = request.clone();
            lease
                .run("plugin_cleanup.complete", stage, move |sessions| {
                    sessions.complete_plugin_cleanup(
                        original.action_id(),
                        &original.cleanup_package()?,
                    )?;
                    sessions.finish_package_operation(&original)
                })
                .await?;
            let original = request.clone();
            io.run(stage, move || plugins.confirm_cleanup_handoff(&original))
                .await
                .map_err(|_| CommandError::unknown(stage))?;
            Ok(view)
        }
        .await;
        drop(claim);
        drop(operation_claim);
        result.map_err(original_required)
    })
    .await
    .map_err(|_| CommandError::unknown(stage))?
}

#[tauri::command]
pub async fn remove_plugin_approval(
    state: State<'_, AppState>,
    request: PluginApprovalRemovalRequest,
) -> Result<PluginInventoryView, CommandError> {
    cleanup(&state, MutationRequest::ApprovalRemoval(request)).await
}

#[tauri::command]
pub async fn uninstall_plugin_package(
    state: State<'_, AppState>,
    request: PluginUninstallRequest,
) -> Result<PluginInventoryView, CommandError> {
    cleanup(&state, MutationRequest::Uninstall(request)).await
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;
