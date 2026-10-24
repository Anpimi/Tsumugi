//! Ephemeral application instance control beside the original installation
//! owner. These records contain no project stores, grants or saved results.
use super::*;
use std::{collections::BTreeMap, sync::Arc};
use tsumugi_core::execution::{ApplicationExecutionLease, ApplicationScopeBasis, ExecutionId};
use tsumugi_plugin_host::core::ApplicationInstance;

struct Slot {
    key: Vec<u8>,
    package: PluginPackageRequest,
    basis: ApplicationScopeBasis,
    instance: Option<Arc<ApplicationInstance>>,
}
impl Slot {
    fn reap(&mut self) {
        if self
            .instance
            .as_ref()
            .is_some_and(|instance| instance.is_stopped() && instance.drained())
        {
            // The ledger owns history. Keep only bounded status metadata after
            // the exact activation has confirmed cleanup, releasing its image.
            self.instance = None;
        }
    }
    fn view(&self) -> ApplicationInstanceView {
        self.instance.as_ref().map_or_else(
            || ApplicationInstanceView {
                basis: self.basis.clone(),
                state: ApplicationInstanceState::Stopped,
            },
            |instance| view(instance),
        )
    }
}
struct Cleanup {
    package: PluginPackageRequest,
    instances: Vec<Arc<ApplicationInstance>>,
    complete: bool,
}
struct Shutdown {
    instances: Vec<Arc<ApplicationInstance>>,
    drained: bool,
    resumed: bool,
}
impl Shutdown {
    fn refresh(&mut self) {
        if !self.drained && self.instances.iter().all(|instance| instance.drained()) {
            self.drained = true;
            self.instances.clear();
        }
    }
    fn state(&self) -> ApplicationShutdownState {
        if self.resumed {
            ApplicationShutdownState::Resumed
        } else if self.drained {
            ApplicationShutdownState::Stopped
        } else {
            ApplicationShutdownState::Stopping
        }
    }
}
#[derive(Default)]
pub(super) struct Instances {
    slots: Vec<Slot>,
    stops: BTreeMap<ExecutionId, ApplicationScopeBasis>,
    cleanup: BTreeMap<ExecutionId, Cleanup>,
    shutdown: BTreeMap<ExecutionId, Shutdown>,
    closing: Option<ExecutionId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ApplicationInstanceState {
    Reserved,
    Active,
    Stopping,
    Stopped,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApplicationInstanceView {
    pub basis: ApplicationScopeBasis,
    pub state: ApplicationInstanceState,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApplicationInstanceRequest {
    pub basis: ApplicationScopeBasis,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StopApplicationInstanceRequest {
    pub action_id: ExecutionId,
    pub basis: ApplicationScopeBasis,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApplicationShutdownRequest {
    pub action_id: ExecutionId,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ApplicationShutdownState {
    Stopping,
    Stopped,
    Resumed,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApplicationShutdownView {
    pub action_id: ExecutionId,
    pub state: ApplicationShutdownState,
}
fn denied() -> CommandError {
    crate::commands::execution::map_execution(
        tsumugi_core::execution::ExecutionError::new(
            tsumugi_core::execution::ErrorCode::Unauthorized,
            "application-instance-lease",
        ),
        CommandStage::ExecutionRecover,
    )
}
fn busy() -> CommandError {
    map_store_error(InstallError::Busy)
}
fn view(instance: &ApplicationInstance) -> ApplicationInstanceView {
    let authorized = instance.is_authorized();
    let state = if instance.is_stopped() {
        if instance.drained() {
            ApplicationInstanceState::Stopped
        } else {
            ApplicationInstanceState::Stopping
        }
    } else if authorized {
        ApplicationInstanceState::Active
    } else {
        ApplicationInstanceState::Reserved
    };
    ApplicationInstanceView {
        basis: instance.basis().clone(),
        state,
    }
}
impl ApplicationPlugins {
    /// Reuse only the instance captured in this immutable plan. A stopped or
    /// missing activation cannot be replaced while loading an old tool input.
    pub(in crate::commands) fn work_plan_tool_instance(
        &self,
        tool: &tsumugi_core::application::WorkPlanToolSpec,
    ) -> Result<Arc<ApplicationInstance>, CommandError> {
        let basis = tool
            .execution
            .application_scope
            .as_ref()
            .ok_or_else(denied)?;
        let instances = self.application_instances.try_lock().map_err(|_| busy())?;
        if !self.open.load(Ordering::Acquire) || instances.closing.is_some() {
            return Err(denied());
        }
        let provider = &tool.binding.capability.provider;
        let instance = instances
            .slots
            .iter()
            .find(|slot| {
                &slot.basis == basis
                    && slot.package.plugin == provider.plugin
                    && slot.package.package_digest == provider.package_digest
            })
            .and_then(|slot| slot.instance.as_ref())
            .cloned()
            .ok_or_else(denied)?;
        if instance.is_stopped()
            || instance
                .binding(&provider.contribution_id, tool.execution.profile.clone())
                .map_err(|_| denied())?
                != tool.execution
            || instance.capabilities() != tool.application_capabilities
        {
            return Err(denied());
        }
        Ok(instance)
    }
    pub(in crate::commands) fn reserve_application_tool(
        &self,
        environment: &tools::ToolEnvironment,
    ) -> Result<Option<Arc<ApplicationInstance>>, CommandError> {
        if environment.component_scope()? != sdk::ComponentScope::Application {
            return Ok(None);
        }
        let key = serde_json::to_vec(&(
            &environment.binding.capability.provider.plugin,
            &environment.binding.capability.provider.package_digest,
            &environment.binding.capability.provider.component_id,
            environment.runtime.environment(),
            environment.settings_revision,
        ))
        .map_err(|_| denied())?;
        let package = PluginPackageRequest {
            plugin: environment.binding.capability.provider.plugin.clone(),
            package_digest: environment
                .binding
                .capability
                .provider
                .package_digest
                .clone(),
        };
        let mut instances = self.application_instances.try_lock().map_err(|_| busy())?;
        if !self.open.load(Ordering::Acquire)
            || instances.closing.is_some()
            || instances
                .cleanup
                .values()
                .any(|control| !control.complete && control.package == package)
        {
            return Err(busy());
        }
        for slot in &mut instances.slots {
            slot.reap();
        }
        if let Some(instance) = instances
            .slots
            .iter()
            .filter(|slot| slot.key == key)
            .filter_map(|slot| slot.instance.as_ref())
            .find(|instance| !instance.is_stopped())
        {
            return Ok(Some(instance.clone()));
        }
        // Keep bounded stopped metadata for exact status/action reconciliation.
        if instances.slots.len() >= 128 {
            return Err(busy());
        }
        let instance = ApplicationInstance::reserve(
            environment.package.image().clone(),
            environment.resource_id.as_deref().ok_or_else(denied)?,
            environment.runtime.clone(),
            environment.staging_parent.clone(),
            tsumugi_plugin_host::HostLimits::default(),
        )
        .map_err(|_| denied())?;
        instances.slots.push(Slot {
            key,
            package,
            basis: instance.basis().clone(),
            instance: Some(instance.clone()),
        });
        Ok(Some(instance))
    }
    pub(in crate::commands) fn authorize_application_tool(
        &self,
        instance: &Arc<ApplicationInstance>,
        action: ExecutionId,
        consent: bool,
        settings: Cancellation,
    ) -> Result<ApplicationExecutionLease, CommandError> {
        {
            let instances = self.application_instances.try_lock().map_err(|_| busy())?;
            if !self.open.load(Ordering::Acquire)
                || instances.closing.is_some()
                || !instances.slots.iter().any(|slot| {
                    slot.instance
                        .as_ref()
                        .is_some_and(|owned| Arc::ptr_eq(owned, instance))
                })
            {
                return Err(denied());
            }
        }
        instance
            .authorize(action, consent, settings)
            .map_err(|_| denied())
    }
    pub(in crate::commands) fn application_instance(
        &self,
        basis: &ApplicationScopeBasis,
    ) -> Result<ApplicationInstanceView, CommandError> {
        let mut instances = self.application_instances.try_lock().map_err(|_| busy())?;
        let slot = instances
            .slots
            .iter_mut()
            .find(|slot| &slot.basis == basis)
            .ok_or_else(denied)?;
        slot.reap();
        Ok(slot.view())
    }
    fn shutdown_application_instances(
        &self,
        action: ExecutionId,
    ) -> Result<ApplicationShutdownView, CommandError> {
        let mut instances = self.application_instances.lock().map_err(|_| denied())?;
        if let Some(original) = instances.shutdown.get_mut(&action) {
            original.refresh();
            return Ok(ApplicationShutdownView {
                action_id: action,
                state: original.state(),
            });
        }
        if instances.closing.is_some() || instances.shutdown.len() >= 128 {
            return Err(busy());
        }
        // Closing admission and capturing the exact original instances share
        // one owner lock. Historical control replay never visits later slots.
        instances.closing = Some(action);
        let owned = instances
            .slots
            .iter()
            .filter_map(|slot| slot.instance.clone())
            .collect::<Vec<_>>();
        for instance in &owned {
            instance.stop();
        }
        let mut control = Shutdown {
            instances: owned,
            drained: false,
            resumed: false,
        };
        control.refresh();
        let state = control.state();
        instances.shutdown.insert(action, control);
        for slot in &mut instances.slots {
            slot.reap();
        }
        Ok(ApplicationShutdownView {
            action_id: action,
            state,
        })
    }
    fn resume_application_instances(
        &self,
        action: ExecutionId,
    ) -> Result<ApplicationShutdownView, CommandError> {
        let mut instances = self.application_instances.lock().map_err(|_| denied())?;
        let closing = instances.closing;
        let original = instances.shutdown.get_mut(&action).ok_or_else(denied)?;
        original.refresh();
        if original.resumed {
            // A historical ACK cannot clear a newer exit's admission fence.
            return Ok(ApplicationShutdownView {
                action_id: action,
                state: ApplicationShutdownState::Resumed,
            });
        }
        if closing != Some(action) || !original.drained {
            return Err(busy());
        }
        original.resumed = true;
        instances.closing = None;
        Ok(ApplicationShutdownView {
            action_id: action,
            state: ApplicationShutdownState::Resumed,
        })
    }
    pub(super) fn stop_application_instances(&self) {
        let instances = self
            .application_instances
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for instance in instances
            .slots
            .iter()
            .filter_map(|slot| slot.instance.as_ref())
        {
            instance.stop();
        }
    }
    pub(in crate::commands) fn begin_application_cleanup(
        &self,
        action: ExecutionId,
        package: &PluginPackageRequest,
    ) -> Result<(), CommandError> {
        let mut instances = self.application_instances.try_lock().map_err(|_| busy())?;
        if let Some(control) = instances.cleanup.get(&action) {
            return if control.package == *package {
                Ok(())
            } else {
                Err(denied())
            };
        }
        if instances.cleanup.len() >= 128 {
            return Err(busy());
        }
        let owned = instances
            .slots
            .iter()
            .filter(|slot| slot.package == *package)
            .filter_map(|slot| slot.instance.clone())
            .collect::<Vec<_>>();
        for instance in &owned {
            instance.stop();
        }
        instances.cleanup.insert(
            action,
            Cleanup {
                package: package.clone(),
                instances: owned,
                complete: false,
            },
        );
        Ok(())
    }
    pub(in crate::commands) fn finish_application_cleanup(
        &self,
        action: ExecutionId,
    ) -> Result<(), CommandError> {
        let instances = self.application_instances.try_lock().map_err(|_| busy())?;
        if instances
            .cleanup
            .get(&action)
            .is_some_and(|control| control.instances.iter().any(|instance| !instance.drained()))
        {
            return Err(busy());
        }
        Ok(())
    }
    pub(in crate::commands) fn complete_application_cleanup(
        &self,
        action: ExecutionId,
        package: &PluginPackageRequest,
    ) -> Result<(), CommandError> {
        let mut instances = self.application_instances.try_lock().map_err(|_| busy())?;
        if let Some(control) = instances.cleanup.get_mut(&action) {
            if control.package != *package
                || control.instances.iter().any(|instance| !instance.drained())
            {
                return Err(busy());
            }
            control.complete = true;
            control.instances.clear();
        }
        for slot in &mut instances.slots {
            slot.reap();
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn read_application_plugin_instance(
    state: State<'_, AppState>,
    request: ApplicationInstanceRequest,
) -> Result<ApplicationInstanceView, CommandError> {
    state.plugins.application_instance(&request.basis)
}
#[tauri::command]
pub async fn stop_application_plugin_instance(
    state: State<'_, AppState>,
    request: StopApplicationInstanceRequest,
) -> Result<ApplicationInstanceView, CommandError> {
    let mut instances = state
        .plugins
        .application_instances
        .try_lock()
        .map_err(|_| busy())?;
    if let Some(basis) = instances.stops.get(&request.action_id) {
        if basis != &request.basis {
            return Err(denied());
        }
    } else {
        if instances.stops.len() >= 128 {
            return Err(busy());
        }
        let slot = instances
            .slots
            .iter()
            .find(|slot| slot.basis == request.basis)
            .ok_or_else(denied)?;
        if let Some(instance) = &slot.instance {
            instance.stop();
        }
        instances
            .stops
            .insert(request.action_id, request.basis.clone());
    }
    let slot = instances
        .slots
        .iter_mut()
        .find(|slot| slot.basis == request.basis)
        .ok_or_else(denied)?;
    slot.reap();
    Ok(slot.view())
}

/// Original application exit control. This never closes a project, authorizes
/// another query, rotates an instance or reports completion before actual reap.
#[tauri::command]
pub async fn stop_application_plugin_instances(
    state: State<'_, AppState>,
    request: ApplicationShutdownRequest,
) -> Result<ApplicationShutdownView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Close, move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let status = plugins.shutdown_application_instances(request.action_id)?;
                if status.state != ApplicationShutdownState::Stopping
                    || std::time::Instant::now() >= deadline
                {
                    return Ok(status);
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        })
        .await
}

/// Explicitly reopen admission only after the original shutdown has drained.
/// This creates no instance, execution lease, project grant or renewed budget.
#[tauri::command]
pub async fn resume_application_plugin_instances(
    state: State<'_, AppState>,
    request: ApplicationShutdownRequest,
) -> Result<ApplicationShutdownView, CommandError> {
    state
        .plugins
        .resume_application_instances(request.action_id)
}
