//! Package-scoped shutdown belongs to the runtime that owns its registrations.
//! A control receipt is not execution permission or an installation decision.
use super::*;
use std::sync::Mutex;
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
    pub(crate) fn plugin(&self) -> &sdk::PluginIdentity {
        &self.plugin
    }
    pub(crate) fn digest(&self) -> &str {
        &self.digest
    }
    pub(crate) fn from_provider(provider: &sdk::ProviderSelectionBinding) -> Self {
        Self::from_package(&provider.plugin, &provider.package_digest)
    }
    pub(crate) fn from_package(plugin: &sdk::PluginIdentity, digest: &str) -> Self {
        Self {
            plugin: plugin.clone(),
            digest: digest.into(),
        }
    }
    fn from_input(input: &FixedInput) -> Option<Self> {
        input
            .envelope()
            .plugin
            .as_ref()
            .map(|binding| Self::from_provider(&binding.capability.provider))
    }
    fn from_request(request: &DispatchRequest) -> Option<Self> {
        Self::from_input(&request.input).or_else(|| {
            request
                .service_origin
                .as_ref()
                .map(|origin| origin.permit.original_package().clone())
        })
    }
    fn matches_request(request: &DispatchRequest, package: &Self) -> bool {
        Self::from_input(&request.input).as_ref() == Some(package)
            || request
                .service_origin
                .as_ref()
                .is_some_and(|origin| origin.permit.original_package() == package)
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
    packages: Mutex<BTreeMap<PackageKey, Arc<PackageQueries>>>,
}
#[derive(Default)]
pub(super) struct PackageQueries {
    stopped: AtomicBool,
    active: AtomicUsize,
}
impl QueryGate {
    pub(super) fn capture_package(
        &self,
        package: Option<&PackageKey>,
    ) -> Result<Option<Arc<PackageQueries>>, ExecutionError> {
        let Some(package) = package else {
            return Ok(None);
        };
        let mut packages = self.packages.lock().map_err(|_| stopped())?;
        Ok(Some(packages.entry(package.clone()).or_default().clone()))
    }
    fn enter(
        self: &Arc<Self>,
        packages: &[Arc<PackageQueries>],
    ) -> Result<QueryCall, ExecutionError> {
        // Admission and stop share this lock. An accepted call is counted before
        // stop can return, so cleanup cannot finish while that call can do I/O.
        let _packages = self.packages.lock().map_err(|_| stopped())?;
        if self.stopped(packages) {
            return Err(stopped());
        }
        if self.active.load(Ordering::Acquire) >= MAX_QUERIES {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "outcome-query-limit",
            ));
        }
        self.active.fetch_add(1, Ordering::AcqRel);
        for package in packages {
            package.active.fetch_add(1, Ordering::AcqRel);
        }
        Ok(QueryCall {
            gate: self.clone(),
            packages: packages.to_vec(),
        })
    }
    pub(super) fn active(&self) -> bool {
        self.active.load(Ordering::Acquire) != 0
    }
    pub(super) fn stopped(&self, packages: &[Arc<PackageQueries>]) -> bool {
        self.stopped.load(Ordering::Acquire)
            || packages
                .iter()
                .any(|package| package.stopped.load(Ordering::Acquire))
    }
    pub(super) fn stop(&self) {
        // A poisoned gate still fails closed, including cached query handles.
        let _packages = self
            .packages
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.stopped.store(true, Ordering::Release);
    }
    fn stop_package(&self, package: &PackageKey) -> Result<(), ExecutionError> {
        let mut packages = self.packages.lock().map_err(|_| stopped())?;
        packages
            .entry(package.clone())
            .or_default()
            .stopped
            .store(true, Ordering::Release);
        Ok(())
    }
    fn package_active(&self, package: &PackageKey) -> Result<bool, ExecutionError> {
        Ok(self
            .packages
            .lock()
            .map_err(|_| stopped())?
            .get(package)
            .is_some_and(|queries| queries.active.load(Ordering::Acquire) != 0))
    }
    fn finish_package(&self, package: &PackageKey) -> Result<(), ExecutionError> {
        let mut packages = self.packages.lock().map_err(|_| stopped())?;
        if packages
            .get(package)
            .is_some_and(|queries| queries.active.load(Ordering::Acquire) != 0)
        {
            return Err(ExecutionError::new(ErrorCode::Busy, "package-draining"));
        }
        // Old captures keep their stopped scope. New calls can obtain a fresh
        // scope only after the original package has completely drained.
        packages.remove(package);
        Ok(())
    }
}
struct QueryCall {
    gate: Arc<QueryGate>,
    packages: Vec<Arc<PackageQueries>>,
}
impl Drop for QueryCall {
    fn drop(&mut self) {
        for package in &self.packages {
            package.active.fetch_sub(1, Ordering::AcqRel);
        }
        self.gate.active.fetch_sub(1, Ordering::AcqRel);
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
    origin_package: Option<PackageKey>,
    pub(super) thread: JoinHandle<Result<(), ExecutionError>>,
}
impl RetiredWorker {
    pub(super) fn new(worker: Worker) -> Self {
        Self {
            attempt: worker.request.input.envelope().attempt_id,
            package: PackageKey::from_request(&worker.request),
            origin_package: worker
                .request
                .service_origin
                .as_ref()
                .map(|origin| origin.permit.original_package().clone()),
            thread: worker.thread,
        }
    }
    fn matches_package(&self, package: &PackageKey) -> bool {
        self.package.as_ref() == Some(package) || self.origin_package.as_ref() == Some(package)
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
    pub(super) fn original_package_stopped(&self, package: Option<&PackageKey>) -> bool {
        package.is_some_and(|package| {
            self.package_controls
                .values()
                .any(|control| !control.complete && &control.token.package == package)
        })
    }
    pub(super) fn stored_input_packages(
        store: &ProjectStore,
        input: &FixedInput,
    ) -> Result<Vec<PackageKey>, ExecutionError> {
        let service = store.work_plan_service_package(input)?;
        let direct = PackageKey::from_input(input);
        let mut packages = Vec::with_capacity(2);
        if let Some(direct) = direct {
            packages.push(direct);
        }
        if let Some(service) = service {
            if !packages.contains(&service) {
                packages.push(service);
            }
        }
        Ok(packages)
    }
    pub(super) fn stored_input_package_stopped(
        &self,
        store: &ProjectStore,
        input: &FixedInput,
    ) -> Result<bool, ExecutionError> {
        Ok(Self::stored_input_packages(store, input)?
            .iter()
            .any(|package| self.original_package_stopped(Some(package))))
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
        for entry in self.runners.values() {
            entry.queries.stop_package(&package)?;
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
            if PackageKey::matches_request(&worker.request, &token.package) {
                tasks.insert(worker.request.input.envelope().task_id);
            }
        }
        for attempt in store.queued_execution_attempts(self.initial_sequence)? {
            let input = store.execution_input_cached(attempt)?;
            if Self::stored_input_packages(store, &input)?.contains(&token.package) {
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
            if Self::stored_input_packages(store, &store.execution_input_cached(attempt)?)?
                .contains(&token.package)
            {
                return Err(ExecutionError::new(ErrorCode::Busy, "package-draining"));
            }
        }
        if self
            .workers
            .iter()
            .any(|worker| PackageKey::matches_request(&worker.request, &token.package))
            || self
                .retired
                .iter()
                .any(|worker| worker.matches_package(&token.package))
        {
            return Err(ExecutionError::new(ErrorCode::Busy, "package-draining"));
        }
        for entry in self.runners.values() {
            if entry.queries.package_active(&token.package)? {
                return Err(ExecutionError::new(ErrorCode::Busy, "package-draining"));
            }
        }
        for entry in self.runners.values() {
            entry.queries.finish_package(&token.package)?;
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
        let _call = self.queries.enter(&self.package_queries)?;
        self.request.check_service_dispatch()?;
        self.runner.query(&self.request)
    }
}
