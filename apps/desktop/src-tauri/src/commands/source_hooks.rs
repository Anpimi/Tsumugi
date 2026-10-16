//! One bounded observer of a committed source action, owned by the original
//! project command queue. Notification failure never changes source acceptance.
use super::*;
use tsumugi_core::{
    content::*,
    execution::{Cancellation, ExecutionError, ExecutionId, Revision},
};

#[cfg(test)]
mod tests;

fn required<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn nullable_view(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SourceMaintenanceHookView> as schemars::JsonSchema>::json_schema(g)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookReadRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub source_action_id: ExecutionId,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookStopRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub stop: StopSourceMaintenanceHook,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookObservation {
    pub source_action_id: ExecutionId,
    pub state: SourceMaintenanceHookReadState,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_view"))]
    pub view: Option<SourceMaintenanceHookView>,
    pub callbacks_drained: bool,
    #[serde(deserialize_with = "required")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "nullable_error"))]
    pub error: Option<CommandError>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookStopped {
    pub request: StopSourceMaintenanceHook,
    pub result: SourceMaintenanceHookStopResult,
    pub callbacks_drained: bool,
}

#[tauri::command]
pub async fn read_source_maintenance_hook_session(
    state: State<'_, AppState>,
    request: execution::SessionRequest,
) -> Result<SourceMaintenanceHookSession, CommandError> {
    state
        .sessions
        .run(
            "read_source_maintenance_hook_session",
            CommandStage::ExecutionRead,
            move |sessions| {
                execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_maintenance_hook_session()
                .map_err(map_read)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_source_maintenance_hook(
    state: State<'_, AppState>,
    request: SourceMaintenanceHookReadRequest,
) -> Result<SourceMaintenanceHookObservation, CommandError> {
    state
        .sessions
        .run(
            "read_source_maintenance_hook",
            CommandStage::ExecutionRead,
            move |sessions| {
                let read = execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .source_maintenance_hook(request.project_id, request.source_action_id)
                .map_err(map_read)?;
                Ok(SourceMaintenanceHookObservation {
                    source_action_id: request.source_action_id,
                    state: read.state,
                    view: read.view,
                    error: sessions
                        .source_hooks
                        .slot
                        .as_ref()
                        .filter(|s| s.source == request.source_action_id)
                        .and_then(|s| s.error.clone()),
                    callbacks_drained: sessions.source_hooks.drained(request.source_action_id),
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn stop_source_maintenance_hook(
    state: State<'_, AppState>,
    request: SourceMaintenanceHookStopRequest,
) -> Result<SourceMaintenanceHookStopped, CommandError> {
    state
        .sessions
        .run(
            "stop_source_maintenance_hook",
            CommandStage::ExecutionCancel,
            move |sessions| {
                if request.project_id != request.stop.project_id {
                    return Err(CommandError::simple(
                        CommandErrorCode::PermissionDenied,
                        CommandStage::ExecutionCancel,
                    ));
                }
                let result = execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?
                .store
                .stop_source_maintenance_hook(&request.stop)
                .map_err(|e| execution::map_execution(e, CommandStage::ExecutionCancel))?;
                if matches!(result, SourceMaintenanceHookStopResult::Stopped { .. }) {
                    sessions.source_hooks.stopped(request.stop.clone());
                }
                Ok(SourceMaintenanceHookStopped {
                    callbacks_drained: sessions.source_hooks.drained(request.stop.source_action_id),
                    request: request.stop,
                    result,
                })
            },
        )
        .await
}

fn map_read(error: ExecutionError) -> CommandError {
    execution::map_execution(error, CommandStage::ExecutionRead)
}
#[cfg(feature = "wire-schema")]
fn nullable_error(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<CommandError> as schemars::JsonSchema>::json_schema(g)
}

#[derive(Default)]
pub(super) struct Shutdown {
    closed: std::sync::atomic::AtomicBool,
    running: Mutex<Option<Cancellation>>,
}
impl Shutdown {
    pub(super) fn close(&self) {
        use std::sync::atomic::Ordering;
        let running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        self.closed.store(true, Ordering::Release);
        if let Some(cancel) = &*running {
            cancel.request();
        }
    }
}

struct Slot {
    source: ExecutionId,
    activation: SourceMaintenanceHookActivation,
    cancel: Cancellation,
    live: Weak<()>,
    stop: Option<StopSourceMaintenanceHook>,
    error: Option<CommandError>,
}
#[derive(Default)]
pub(super) struct SourceHooks {
    shutdown: Arc<Shutdown>,
    token: Option<String>,
    sequence: Option<Revision>,
    change_epoch: Option<String>,
    wake: bool,
    slot: Option<Slot>,
    #[cfg(test)]
    probe: Option<ComputeProbe>,
}
#[cfg(test)]
pub(super) struct ComputeProbe {
    pub action: ExecutionId,
    pub reached: std::sync::mpsc::SyncSender<()>,
    pub release: std::sync::mpsc::Receiver<()>,
}
impl SourceHooks {
    pub(super) fn with_shutdown(shutdown: Arc<Shutdown>) -> Self {
        Self {
            shutdown,
            ..Self::default()
        }
    }
    fn drained(&self, source: ExecutionId) -> bool {
        self.slot
            .as_ref()
            .filter(|s| s.source == source)
            .is_none_or(|s| s.live.strong_count() == 0)
    }
    fn stopped(&mut self, request: StopSourceMaintenanceHook) {
        if let Some(slot) = self
            .slot
            .as_mut()
            .filter(|s| s.source == request.source_action_id)
        {
            slot.cancel.request();
            slot.stop = Some(request);
        }
    }
    fn live(&self) -> bool {
        self.slot
            .as_ref()
            .is_some_and(|s| s.live.strong_count() != 0)
    }
    pub(super) fn is_active(&self) -> bool {
        self.live()
    }
    pub(super) fn prepare(
        &mut self,
        store: &ProjectStore,
        project: ExecutionId,
        action: ExecutionId,
    ) -> Result<(), CommandError> {
        // Reconstructing an accepted source action is data, not a reservation
        // for another observer or permission to replace a newer pending action.
        if store.adoption_receipt(action).map_err(map_read)?.is_some() {
            return Ok(());
        }
        if let Some(slot) = &self.slot {
            if slot.source != action {
                let read = store
                    .source_maintenance_hook(project, slot.source)
                    .map_err(map_read)?;
                if self.live() || read.view.is_some_and(|v| !v.admission_closed) {
                    return Err(CommandError::simple(
                        CommandErrorCode::Busy,
                        CommandStage::ExecutionAdopt,
                    ));
                }
            }
        }
        Ok(())
    }
    pub(super) fn prepared(
        &mut self,
        token: String,
        source: ExecutionId,
        activation: SourceMaintenanceHookActivation,
    ) {
        self.token = Some(token);
        if self.slot.as_ref().is_some_and(|s| s.source == source) {
            return;
        }
        self.slot = Some(Slot {
            source,
            activation,
            cancel: Cancellation::default(),
            live: Weak::new(),
            stop: None,
            error: None,
        });
    }
    pub(super) fn close(&mut self, store: &mut ProjectStore) -> Result<(), CommandError> {
        self.wake = false;
        let Some(slot) = &mut self.slot else {
            return Ok(());
        };
        slot.cancel.request();
        let project = ExecutionId::parse(
            &store
                .metadata()
                .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRead))?
                .project_id()
                .to_string(),
        )
        .map_err(map_read)?;
        let read = store
            .source_maintenance_hook(project, slot.source)
            .map_err(map_read)?;
        if read.view.as_ref().is_some_and(|v| v.admission_closed) && slot.live.strong_count() == 0 {
            return Ok(());
        }
        if slot.stop.is_none() {
            slot.stop = read.view.and_then(|v| v.stop).map(|s| s.request);
        }
        let request = slot.stop.get_or_insert_with(|| StopSourceMaintenanceHook {
            project_id: project,
            source_action_id: slot.source,
            action_id: ExecutionId::new(),
            activation: slot.activation.clone(),
        });
        match store
            .stop_source_maintenance_hook(request)
            .map_err(map_read)?
        {
            SourceMaintenanceHookStopResult::Stopped { .. } => {}
            SourceMaintenanceHookStopResult::NotKnown => {
                return Err(CommandError::unknown(CommandStage::ExecutionCancel));
            }
        }
        if slot.live.strong_count() != 0 {
            return Err(CommandError::simple(
                CommandErrorCode::Busy,
                CommandStage::ExecutionCancel,
            ));
        }
        Ok(())
    }
}

/// The in-memory change clock is only a wake-up. The Core cause, original claim
/// and outcome are the authority. No idle tick performs a SQLite queue scan.
pub(super) fn advance(sessions: &mut SessionManager) {
    let Some(active) = &mut sessions.active else {
        return;
    };
    let hooks = &mut sessions.source_hooks;
    if hooks
        .shutdown
        .closed
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return;
    }
    if hooks.token.as_ref() != Some(&active.token) {
        hooks.token = Some(active.token.clone());
        hooks.sequence = None;
        hooks.change_epoch = None;
        hooks.wake = true;
        hooks.slot = None;
    }
    let mut changes = active.store.changes_since(
        hooks
            .sequence
            .unwrap_or_else(|| Revision::new(0).expect("zero revision")),
    );
    if hooks.change_epoch.as_ref() != Some(&changes.epoch) {
        changes = active
            .store
            .changes_since(Revision::new(0).expect("zero revision"));
        hooks.change_epoch = Some(changes.epoch.clone());
        hooks.wake = true;
    }
    if changes.scopes.contains(&tsumugi_core::ChangeScope::Source) {
        hooks.wake = true;
    }
    hooks.sequence = Some(changes.sequence);
    if !hooks.wake || hooks.live() || active.store.is_reconciling() {
        return;
    }
    hooks.wake = false;
    let Some(context) = active.services.clone() else {
        return;
    };
    let mut work = || -> Result<(), CommandError> {
        let project = ExecutionId::parse(
            &active
                .store
                .metadata()
                .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRead))?
                .project_id()
                .to_string(),
        )
        .map_err(map_read)?;
        let Some(source) = active
            .store
            .next_source_maintenance_hook()
            .map_err(map_read)?
        else {
            return Ok(());
        };
        let read = active
            .store
            .source_maintenance_hook(project, source)
            .map_err(map_read)?;
        let view = read
            .view
            .ok_or_else(|| CommandError::unknown(CommandStage::ExecutionRead))?;
        // Admission and cancellation registration share the Drop close lock.
        // An already closed owner cannot claim new work, even when an earlier
        // continuation still keeps the command queue alive.
        let shutdown = hooks.shutdown.clone();
        let mut running = shutdown.running.lock().unwrap_or_else(|p| p.into_inner());
        if shutdown.closed.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        // Reserve the original control queue's completion capacity before the
        // single durable claim. This lease completes only this accepted cause;
        // it never grants a new business operation or extends its deadline.
        let lease = match context.callback.reserve_control() {
            Ok(lease) => Some(lease),
            Err(error) if error.code == CommandErrorCode::Busy => None,
            Err(error) => return Err(error),
        };
        let Some(claim) = active
            .store
            .claim_source_maintenance_hook(project, source, ExecutionId::new())
            .map_err(map_read)?
        else {
            return Ok(());
        };
        let cancel = Cancellation::default();
        let Some(lease) = lease else {
            // No asynchronous work was accepted, so this short owner operation
            // needs no completion reservation. Consume this cause once with an
            // explicit failure rather than leaving an unwakeable Pending intent.
            // Core still gives stop, expiry and source supersession precedence.
            active
                .store
                .finish_source_maintenance_hook(claim.failed(ExecutionError::new(
                    tsumugi_core::execution::ErrorCode::Busy,
                    "source-hook-admission",
                )))
                .map_err(map_read)?;
            hooks.slot = Some(Slot {
                source,
                activation: view.activation,
                cancel,
                live: Weak::new(),
                stop: None,
                error: None,
            });
            hooks.wake = true;
            return Ok(());
        };
        *running = Some(cancel.clone());
        drop(running);
        let captured = active.store.capture_source_maintenance_hook(claim.clone());
        let live = Arc::new(());
        hooks.slot = Some(Slot {
            source,
            activation: view.activation.clone(),
            cancel: cancel.clone(),
            live: Arc::downgrade(&live),
            stop: None,
            error: None,
        });
        #[cfg(test)]
        let probe = hooks.probe.take().filter(|probe| probe.action == source);
        let io = context.io.clone();
        let token = active.token.clone();
        tauri::async_runtime::spawn(async move {
            let computed = match captured {
                Err(error) => claim.failed(error),
                Ok(captured) => {
                    let fallback = captured.clone();
                    io.run(CommandStage::ExecutionRead, move || {
                        #[cfg(test)]
                        if let Some(probe) = probe {
                            probe.reached.send(()).unwrap();
                            probe
                                .release
                                .recv_timeout(std::time::Duration::from_secs(10))
                                .expect("test did not release hook computation");
                        }
                        Ok(captured.evaluate())
                    })
                    .await
                    .unwrap_or_else(|error| {
                        fallback.failed(ExecutionError::new(
                            if error.code == CommandErrorCode::Busy {
                                tsumugi_core::execution::ErrorCode::Busy
                            } else {
                                tsumugi_core::execution::ErrorCode::StorageFailed
                            },
                            "source-hook-computation",
                        ))
                    })
                }
            };
            let finish_live = live.clone();
            let completion = lease
                .run(
                    "source_maintenance_hook.finish",
                    CommandStage::ExecutionCancel,
                    move |sessions| {
                        let _live = finish_live;
                        let active = execution::authorized(
                            sessions,
                            &token,
                            project,
                            CommandStage::ExecutionCancel,
                        )?;
                        if cancel.is_requested()
                            || shutdown.closed.load(std::sync::atomic::Ordering::Acquire)
                        {
                            // Stop is durable before an accepted late completion. Its
                            // opaque finish still records the original run's closure.
                            let stop = StopSourceMaintenanceHook {
                                project_id: project,
                                source_action_id: source,
                                action_id: ExecutionId::new(),
                                activation: view.activation,
                            };
                            let read = active
                                .store
                                .source_maintenance_hook(project, source)
                                .map_err(map_read)?;
                            if read.view.as_ref().and_then(|v| v.stop.as_ref()).is_none() {
                                active
                                    .store
                                    .stop_source_maintenance_hook(&stop)
                                    .map_err(map_read)?;
                            }
                        }
                        active
                            .store
                            .finish_source_maintenance_hook(computed)
                            .map_err(map_read)?;
                        sessions.source_hooks.wake = true;
                        Ok(())
                    },
                )
                .await;
            if let Err(error) = completion {
                let _ = lease
                    .run(
                        "source_maintenance_hook.report",
                        CommandStage::ExecutionCancel,
                        move |sessions| {
                            if let Some(slot) = sessions
                                .source_hooks
                                .slot
                                .as_mut()
                                .filter(|s| s.source == source)
                            {
                                slot.error = Some(error);
                            }
                            Ok(())
                        },
                    )
                    .await;
            }
            drop(live);
        });
        Ok(())
    };
    // The notification is a separate action. Its failure cannot change the
    // already committed source receipt or panic the project command loop.
    if let Err(error) = work() {
        if let Some(slot) = &mut hooks.slot {
            slot.error = Some(error);
        }
    }
}
