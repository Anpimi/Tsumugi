//! Package-scoped shutdown belongs to the runtime that owns its registrations.
//! A control receipt is not execution permission or an installation decision.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tsumugi_plugin_sdk as sdk;

const MAX_CONTROLS: usize = 128;
const MAX_QUERIES: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct PackageKey {
    pub(super) plugin: sdk::PluginIdentity,
    pub(super) digest: String,
}
impl PackageKey {
    pub(crate) fn from_provider(provider: &sdk::ProviderSelectionBinding) -> Self {
        Self {
            plugin: provider.plugin.clone(),
            digest: provider.package_digest.clone(),
        }
    }
    fn from_input(input: &FixedInput) -> Option<Self> {
        input
            .envelope()
            .plugin
            .as_ref()
            .map(|binding| Self::from_provider(&binding.capability.provider))
    }
    fn matches(&self, input: &FixedInput) -> bool {
        Self::from_input(input).as_ref() == Some(self)
    }
}

/// An opaque control for one package and runtime generation. Cloning it never
/// refreshes grants, retries external work, or selects a replacement instance.
#[derive(Clone, Debug)]
pub struct PackageQuiescence {
    generation: ExecutionId,
    action: ExecutionId,
    package: PackageKey,
}
pub(super) struct PackageControl {
    token: PackageQuiescence,
    grants: Vec<ExecutionId>,
    cancellations: BTreeMap<ExecutionId, ExecutionId>,
    pub(super) complete: bool,
}

#[derive(Default)]
pub(super) struct QueryGate {
    stopped: AtomicBool,
    active: AtomicUsize,
}
impl QueryGate {
    fn enter(self: &Arc<Self>) -> Result<QueryCall, ExecutionError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(stopped());
        }
        let mut current = self.active.load(Ordering::Acquire);
        loop {
            if current >= MAX_QUERIES {
                return Err(ExecutionError::new(
                    ErrorCode::LimitExceeded,
                    "outcome-query-limit",
                ));
            }
            match self.active.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => current = observed,
            }
        }
        let call = QueryCall(self.clone());
        if self.stopped.load(Ordering::Acquire) {
            return Err(stopped());
        }
        Ok(call)
    }
    pub(super) fn active(&self) -> bool {
        self.active.load(Ordering::Acquire) != 0
    }
    pub(super) fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub(super) fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }
}
struct QueryCall(Arc<QueryGate>);
impl Drop for QueryCall {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}
fn stopped() -> ExecutionError {
    ExecutionError::new(ErrorCode::Unauthorized, "outcome-query-stopped")
}

#[derive(Clone)]
pub(super) struct RunnerEntry {
    pub(super) runner: Arc<dyn Runner>,
    pub(super) queries: Arc<QueryGate>,
}
impl RunnerEntry {
    pub(super) fn new(runner: Arc<dyn Runner>) -> Self {
        Self {
            runner,
            queries: Arc::default(),
        }
    }
    fn package(&self) -> Option<PackageKey> {
        self.runner.plugin_provider().map(PackageKey::from_provider)
    }
}
pub(super) struct RetiredWorker {
    pub(super) attempt: ExecutionId,
    pub(super) package: Option<PackageKey>,
    pub(super) thread: JoinHandle<Result<(), ExecutionError>>,
}
impl RetiredWorker {
    pub(super) fn new(worker: Worker) -> Self {
        Self {
            attempt: worker.request.input.envelope().attempt_id,
            package: PackageKey::from_input(&worker.request.input),
            thread: worker.thread,
        }
    }
}

impl ExecutionRuntime {
    pub(super) fn package_stopped(&self, provider: Option<&sdk::ProviderSelectionBinding>) -> bool {
        provider.is_some_and(|provider| {
            let package = PackageKey::from_provider(provider);
            self.package_controls
                .values()
                .any(|control| !control.complete && control.token.package == package)
        })
    }
    pub(super) fn input_package_stopped(&self, input: &FixedInput) -> bool {
        self.package_stopped(
            input
                .envelope()
                .plugin
                .as_ref()
                .map(|binding| &binding.capability.provider),
        )
    }
    /// Stop admission and existing query calls for this exact package, revoke
    /// its original grants, and cancel only its queued/running tasks. Errors
    /// retain the fence and original grant IDs for the same action's retry.
    pub fn begin_package_quiesce(
        &mut self,
        store: &mut ProjectStore,
        action: ExecutionId,
        plugin: &sdk::PluginIdentity,
        package_digest: &str,
    ) -> Result<PackageQuiescence, ExecutionError> {
        store.check_plugin_epoch_owner(&self.plugin_epoch)?;
        if !self.accepting || !self.plugin_epoch.is_active() {
            return Err(ExecutionError::new(ErrorCode::Busy, "quiescing"));
        }
        plugin
            .validate()
            .and_then(|_| sdk::validate_package_digest(package_digest))
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "package-quiesce"))?;
        let package = PackageKey {
            plugin: plugin.clone(),
            digest: package_digest.into(),
        };
        let token = if let Some(control) = self.package_controls.get(&action) {
            if control.token.package != package {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "package-control-action",
                ));
            }
            if control.complete {
                return Ok(control.token.clone());
            }
            control.token.clone()
        } else {
            if self
                .package_controls
                .values()
                .any(|control| !control.complete && control.token.package == package)
            {
                return Err(ExecutionError::new(
                    ErrorCode::Busy,
                    "package-control-pending",
                ));
            }
            if self.package_controls.len() >= MAX_CONTROLS {
                return Err(ExecutionError::new(
                    ErrorCode::LimitExceeded,
                    "package-controls",
                ));
            }
            let token = PackageQuiescence {
                generation: self.generation,
                action,
                package: package.clone(),
            };
            // Fence new scheduling before any fallible storage transition.
            let grants = self.plugin_epoch.revoke_package(&package)?;
            self.package_controls.insert(
                action,
                PackageControl {
                    token: token.clone(),
                    grants,
                    cancellations: BTreeMap::new(),
                    complete: false,
                },
            );
            token
        };
        for entry in self
            .runners
            .values()
            .filter(|entry| entry.package().as_ref() == Some(&package))
        {
            entry.queries.stop();
        }
        self.drive_package_quiesce(store, &token)?;
        Ok(token)
    }
    fn drive_package_quiesce(
        &mut self,
        store: &mut ProjectStore,
        token: &PackageQuiescence,
    ) -> Result<(), ExecutionError> {
        let control = self
            .package_controls
            .get(&token.action)
            .ok_or_else(stopped)?;
        store.revoke_plugin_grants(self.generation, &control.grants)?;
        let mut tasks = BTreeSet::new();
        for worker in &self.workers {
            if token.package.matches(&worker.request.input) {
                tasks.insert(worker.request.input.envelope().task_id);
            }
        }
        for attempt in store.queued_execution_attempts(self.initial_sequence)? {
            let input = store.execution_input_cached(attempt)?;
            if token.package.matches(&input) {
                tasks.insert(input.envelope().task_id);
            }
        }
        for task in tasks {
            // Retain each cancellation's original receipt even when its commit
            // fails or is uncertain. Retrying the package action never issues
            // a fresh cancellation revision or refreshes task authority.
            let request = *self
                .package_controls
                .get_mut(&token.action)
                .expect("control checked")
                .cancellations
                .entry(task)
                .or_insert_with(ExecutionId::new);
            self.cancel(store, task, request)?;
        }
        Ok(())
    }
    /// Complete only after owned workers and active outcome queries drain.
    /// Other packages remain admitted. A completed old control is an inert
    /// receipt: it cannot remove registrations created by a later action.
    pub fn finish_package_quiesce(
        &mut self,
        store: &mut ProjectStore,
        token: &PackageQuiescence,
    ) -> Result<(), ExecutionError> {
        store.check_plugin_epoch_owner(&self.plugin_epoch)?;
        if token.generation != self.generation {
            return Err(stopped());
        }
        let control = self
            .package_controls
            .get(&token.action)
            .ok_or_else(stopped)?;
        if control.token.package != token.package {
            return Err(stopped());
        }
        if control.complete {
            return Ok(());
        }
        self.drive_package_quiesce(store, token)?;
        self.tick(store)?;
        for attempt in store.queued_execution_attempts(self.initial_sequence)? {
            if token
                .package
                .matches(&store.execution_input_cached(attempt)?)
            {
                return Err(ExecutionError::new(ErrorCode::Busy, "package-draining"));
            }
        }
        if self
            .workers
            .iter()
            .any(|worker| token.package.matches(&worker.request.input))
            || self
                .retired
                .iter()
                .any(|worker| worker.package.as_ref() == Some(&token.package))
            || self.runners.values().any(|entry| {
                entry.package().as_ref() == Some(&token.package) && entry.queries.active()
            })
        {
            return Err(ExecutionError::new(ErrorCode::Busy, "package-draining"));
        }
        let keys: Vec<_> = self
            .runners
            .iter()
            .filter(|(_, entry)| entry.package().as_ref() == Some(&token.package))
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            self.runners.remove(&key);
            self.policies.remove(&key);
        }
        self.package_controls
            .get_mut(&token.action)
            .expect("control checked")
            .complete = true;
        Ok(())
    }
}

impl OutcomeQuery {
    pub fn run(&self) -> Result<QueryOutcome, ExecutionError> {
        let _call = self.queries.enter()?;
        self.runner.query(&self.request)
    }
}
