//! Session-local revocation handles for grants owned by the project ledger.
//! A handle cannot create, renew, or restore a durable authorization.
pub(crate) use super::runtime::PackageKey;
use super::{Cancellation, ErrorCode, ExecutionError, ExecutionId, FixedInput};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const MAX_PLUGIN_GRANT_LIFETIME_MS: u64 = 3_600_000;
const MAX_LIVE_GRANTS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PluginConsent {
    /// Acknowledge native execution with the current user's OS privileges;
    /// this execution profile does not provide a filesystem or network sandbox.
    pub unsandboxed_execution: bool,
    /// The original application's independent lifetime decision. Recording this
    /// fact neither creates nor restores an application-instance lease.
    pub application_execution: bool,
}

/// A trusted application entry captures this independent lifetime decision.
/// It only narrows project grants and is never restored from persisted values.
#[derive(Clone, Debug)]
pub struct ApplicationExecutionLease {
    bindings: Arc<[super::PluginExecutionBinding]>,
    revocation: Cancellation,
    settings_revocation: Cancellation,
}
impl ApplicationExecutionLease {
    pub fn capture(
        bindings: Vec<super::PluginExecutionBinding>,
        allow_until_application_exit: bool,
        revocation: Cancellation,
        settings_revocation: Cancellation,
    ) -> Result<Self, ExecutionError> {
        if !allow_until_application_exit
            || bindings.is_empty()
            || bindings.len() > 128 * 128
            || revocation.is_requested()
            || settings_revocation.is_requested()
        {
            return Err(denied());
        }
        // A component has at most 128 capabilities, each with at most 128
        // declared profiles. Retain exact tuples, including the null profile
        // only when explicitly valid, within the original Core byte ceiling.
        super::codec::encode(&bindings, super::MAX_INPUT_BYTES)?;
        let first = &bindings[0];
        let mut unique = BTreeSet::new();
        let mut contributions = BTreeMap::new();
        for binding in &bindings {
            binding.validate()?;
            let provider = &binding.capability.provider;
            let original = &first.capability.provider;
            if binding.component_scope != tsumugi_plugin_sdk::ComponentScope::Application
                || binding.application_scope.is_none()
                || binding.application_scope != first.application_scope
                || binding.environment != first.environment
                || provider.plugin != original.plugin
                || provider.component_id != original.component_id
                || provider.package_digest != original.package_digest
                || binding.capability.declaration.effect != tsumugi_plugin_sdk::EffectKind::ReadOnly
                || binding
                    .capability
                    .declaration
                    .permissions
                    .iter()
                    .any(|permission| {
                        matches!(
                            permission,
                            tsumugi_plugin_sdk::PermissionRequest::ProjectService { .. }
                        )
                    })
                || !unique.insert(super::codec::encode(binding, super::MAX_INPUT_BYTES)?)
            {
                return Err(denied());
            }
            if contributions
                .insert(&provider.contribution_id, &binding.capability)
                .is_some_and(|prior| prior != &binding.capability)
            {
                return Err(denied());
            }
        }
        if contributions.len() > 128 {
            return Err(denied());
        }
        Ok(Self {
            bindings: bindings.into(),
            revocation,
            settings_revocation,
        })
    }
    pub fn matches(&self, input: &FixedInput) -> bool {
        input
            .envelope()
            .plugin
            .as_ref()
            .is_some_and(|binding| self.matches_binding(binding))
    }
    /// Compare the complete captured tuple without creating an invocation or
    /// recovering authority from its persisted instance identity.
    pub fn matches_binding(&self, binding: &super::PluginExecutionBinding) -> bool {
        self.bindings.contains(binding) && self.is_live()
    }
    pub(crate) fn matches_capabilities(
        &self,
        binding: &super::PluginExecutionBinding,
        capabilities: &[tsumugi_plugin_sdk::ProcessCapability],
    ) -> bool {
        if !self.matches_binding(binding) {
            return false;
        }
        let members = self
            .bindings
            .iter()
            .map(|binding| {
                (
                    &binding.capability.provider.contribution_id,
                    &binding.capability.declaration,
                )
            })
            .collect::<BTreeMap<_, _>>();
        members.len() == capabilities.len()
            && capabilities.iter().all(|member| {
                members.get(&member.contribution_id).copied() == Some(&member.capability)
            })
    }
    pub fn revocation(&self) -> Cancellation {
        self.revocation.clone()
    }
    pub fn is_live(&self) -> bool {
        if self.settings_revocation.is_requested() {
            self.revocation.request();
        }
        !self.revocation.is_requested()
    }
}

impl PluginConsent {
    /// Validate a proposed consent before retaining a request for dispatch.
    /// This neither creates authority nor proves that a grant was persisted.
    pub fn validate(&self, input: &FixedInput, expires_at_ms: u64) -> Result<(), ExecutionError> {
        if !self.allows(input) {
            return Err(denied());
        }
        plugin_grant_deadline(expires_at_ms).map(|_| ())
    }

    pub(crate) fn allows(&self, input: &FixedInput) -> bool {
        input.envelope().plugin.is_some()
            && input.envelope().automation.is_none()
            && self.unsandboxed_execution
            && (!self.application_execution
                || input
                    .envelope()
                    .plugin
                    .as_ref()
                    .is_some_and(|binding| binding.application_scope.is_some()))
    }
}

pub(crate) fn plugin_grant_deadline(expires_at_ms: u64) -> Result<Instant, ExecutionError> {
    let remaining = expires_at_ms
        .checked_sub(plugin_now_ms()?)
        .filter(|remaining| *remaining > 0 && *remaining <= MAX_PLUGIN_GRANT_LIFETIME_MS)
        .filter(|_| expires_at_ms <= i64::MAX as u64)
        .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "plugin-grant-expiry"))?;
    Instant::now()
        .checked_add(std::time::Duration::from_millis(remaining))
        .ok_or_else(denied)
}

fn denied() -> ExecutionError {
    ExecutionError::new(ErrorCode::Unauthorized, "plugin-authority")
}

pub(crate) fn plugin_now_ms() -> Result<u64, ExecutionError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| ExecutionError::new(ErrorCode::StorageFailed, "plugin-clock"))
}

#[derive(Debug)]
struct GrantState {
    grant_id: ExecutionId,
    attempt_id: ExecutionId,
    task_id: ExecutionId,
    input_digest: String,
    package: super::runtime::PackageKey,
    generation: ExecutionId,
    expires_at_ms: u64,
    application_execution: bool,
    deadline: Instant,
    delegation: Option<crate::application::WorkPlanToolDelegation>,
    application_revocation: Option<ApplicationExecutionLease>,
    revoked: AtomicBool,
}
impl GrantState {
    fn live(&self) -> bool {
        if self.revoked.load(Ordering::Acquire) {
            return false;
        }
        let live = self
            .application_revocation
            .as_ref()
            .is_none_or(|lease| lease.is_live())
            && Instant::now() < self.deadline
            && plugin_now_ms().is_ok_and(|now| now < self.expires_at_ms);
        // Once an expiry (or unavailable clock) is observed, moving the wall
        // clock backwards cannot make the same handle valid again.
        if !live {
            self.revoked.store(true, Ordering::Release);
        }
        live && !self.revoked.load(Ordering::Acquire)
    }

    fn matches(&self, input: &FixedInput) -> bool {
        let envelope = input.envelope();
        envelope.plugin.is_some()
            && match &self.delegation {
                None => envelope.automation.is_none(),
                Some(delegation) => envelope.automation == Some(delegation.lease),
            }
            && self.attempt_id == envelope.attempt_id
            && self.task_id == envelope.task_id
            && self.input_digest == input.digest()
    }
}

/// A read-only, revocable dispatch guard. It contains no store or renewal API.
#[derive(Clone, Debug)]
pub struct PluginPermit {
    epoch: Weak<PluginEpoch>,
    grant: Arc<GrantState>,
}
impl PluginPermit {
    pub(crate) fn original_package(&self) -> &super::runtime::PackageKey {
        &self.grant.package
    }
    pub(crate) fn original_deadline(&self) -> Instant {
        self.grant.deadline
    }
    pub(crate) fn expires_at_ms(&self) -> u64 {
        self.grant.expires_at_ms
    }
    pub(crate) fn generation(&self) -> ExecutionId {
        self.grant.generation
    }
    pub fn is_authorized(&self) -> bool {
        self.epoch.upgrade().is_some_and(|epoch| {
            epoch.generation == self.grant.generation
                && !epoch.revoked.load(Ordering::Acquire)
                && self.grant.live()
                && !epoch.revoked.load(Ordering::Acquire)
        })
    }

    pub fn matches(&self, input: &FixedInput) -> bool {
        self.grant.matches(input)
    }

    /// Only Core can issue this delegated mode; an envelope lease is not proof.
    pub fn is_work_plan_tool(&self) -> bool {
        self.grant.delegation.is_some()
    }
    pub fn originating_caller_id(&self) -> Option<ExecutionId> {
        self.grant.delegation.as_ref().map(|d| d.caller_id)
    }
    pub fn originating_caller(&self) -> Option<&str> {
        self.grant.delegation.as_ref().map(|d| d.caller.as_str())
    }
    pub fn parent_task(&self) -> Option<ExecutionId> {
        self.grant.delegation.as_ref().map(|d| d.root_task)
    }
    pub(crate) fn delegation(&self) -> Option<&crate::application::WorkPlanToolDelegation> {
        self.grant.delegation.as_ref()
    }

    pub fn grant_id(&self) -> ExecutionId {
        self.grant.grant_id
    }

    pub(crate) fn matches_record(
        &self,
        input: &FixedInput,
        grant_id: ExecutionId,
        generation: ExecutionId,
        expires_at_ms: u64,
        application_execution: bool,
    ) -> bool {
        self.matches(input)
            && self.grant.grant_id == grant_id
            && self.grant.generation == generation
            && self.grant.expires_at_ms == expires_at_ms
            && self.grant.application_execution == application_execution
    }
}

/// Owned by one runtime generation. Revoking an old epoch cannot affect a new one.
#[derive(Debug)]
pub(crate) struct PluginEpoch {
    generation: ExecutionId,
    revoked: AtomicBool,
    grants: Mutex<BTreeMap<ExecutionId, Arc<GrantState>>>,
    service_origins: Mutex<BTreeMap<ExecutionId, Arc<ServiceOriginGuard>>>,
}

/// The original grant and absolute dispatch deadline outlive the process channel.
/// Reopening a store cannot recreate this handle from a durable receipt.
#[derive(Debug)]
pub(crate) struct ServiceOriginGuard {
    pub(crate) permit: PluginPermit,
    pub(crate) cancellation: Cancellation,
    pub(crate) settings_revocation: Cancellation,
    pub(crate) revoked: Cancellation,
    pub(crate) deadline: Instant,
    pub(crate) digest: String,
    pub(crate) retain_until_terminal: bool,
}
impl ServiceOriginGuard {
    pub(crate) fn live(&self) -> bool {
        if Instant::now() >= self.deadline {
            self.revoked.request();
        }
        !self.cancellation.is_requested()
            && !self.settings_revocation.is_requested()
            && !self.revoked.is_requested()
            && self.permit.is_authorized()
    }
}
impl PluginEpoch {
    pub(crate) fn revoke_package(
        &self,
        package: &super::runtime::PackageKey,
    ) -> Result<Vec<ExecutionId>, ExecutionError> {
        let grants = self.grants()?;
        Ok(grants
            .values()
            .filter(|grant| &grant.package == package)
            .map(|grant| {
                grant.revoked.store(true, Ordering::Release);
                grant.grant_id
            })
            .collect())
    }
    pub(crate) fn generation(&self) -> ExecutionId {
        self.generation
    }

    pub(crate) fn is_active(&self) -> bool {
        !self.revoked.load(Ordering::Acquire)
    }

    pub(crate) fn revoke(&self) {
        self.revoked.store(true, Ordering::Release);
    }

    fn grants(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, BTreeMap<ExecutionId, Arc<GrantState>>>, ExecutionError>
    {
        self.grants.lock().map_err(|_| {
            self.revoke();
            denied()
        })
    }
}
impl Drop for PluginEpoch {
    fn drop(&mut self) {
        self.revoke();
    }
}

#[derive(Debug, Default)]
pub(crate) struct PluginAuthority {
    current: Mutex<Option<Arc<PluginEpoch>>>,
}
impl PluginAuthority {
    pub(crate) fn owns_epoch(&self, expected: &Arc<PluginEpoch>) -> Result<bool, ExecutionError> {
        Ok(self
            .current_lock()?
            .as_ref()
            .is_some_and(|epoch| Arc::ptr_eq(epoch, expected)))
    }
    pub(crate) fn rotate_epoch(
        &self,
        expected: &Arc<PluginEpoch>,
        generation: ExecutionId,
    ) -> Result<Arc<PluginEpoch>, ExecutionError> {
        let mut current = self.current_lock()?;
        if !current
            .as_ref()
            .is_some_and(|epoch| Arc::ptr_eq(epoch, expected))
            || expected.generation == generation
        {
            return Err(denied());
        }
        expected.revoke();
        let epoch = Arc::new(PluginEpoch {
            generation,
            revoked: AtomicBool::new(false),
            grants: Mutex::new(BTreeMap::new()),
            service_origins: Mutex::new(BTreeMap::new()),
        });
        *current = Some(epoch.clone());
        Ok(epoch)
    }
    fn current_lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<Arc<PluginEpoch>>>, ExecutionError> {
        self.current.lock().map_err(|poisoned| {
            if let Some(epoch) = poisoned.get_ref().as_ref() {
                epoch.revoke();
            }
            denied()
        })
    }

    pub(crate) fn begin_epoch(
        &self,
        generation: ExecutionId,
    ) -> Result<Arc<PluginEpoch>, ExecutionError> {
        let mut current = self.current_lock()?;
        if current
            .as_ref()
            .is_some_and(|epoch| epoch.generation == generation)
        {
            return Err(denied());
        }
        if let Some(epoch) = current.as_ref() {
            epoch.revoke();
        }
        let epoch = Arc::new(PluginEpoch {
            generation,
            revoked: AtomicBool::new(false),
            grants: Mutex::new(BTreeMap::new()),
            service_origins: Mutex::new(BTreeMap::new()),
        });
        *current = Some(epoch.clone());
        Ok(epoch)
    }

    pub(crate) fn current_epoch(&self) -> Result<Arc<PluginEpoch>, ExecutionError> {
        self.current_lock()?
            .as_ref()
            .cloned()
            .filter(|epoch| !epoch.revoked.load(Ordering::Acquire))
            .ok_or_else(denied)
    }

    pub(crate) fn require_generation(
        &self,
        generation: ExecutionId,
    ) -> Result<Arc<PluginEpoch>, ExecutionError> {
        let epoch = self.current_epoch()?;
        if epoch.generation != generation {
            return Err(denied());
        }
        Ok(epoch)
    }

    pub(crate) fn check_new_grant(&self, generation: ExecutionId) -> Result<(), ExecutionError> {
        let epoch = self.require_generation(generation)?;
        let mut grants = epoch.grants()?;
        grants.retain(|_, grant| grant.live());
        if grants.len() >= MAX_LIVE_GRANTS {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "plugin-grants",
            ));
        }
        Ok(())
    }

    /// Called only after the new grant's transaction has committed. Existing
    /// rows are never used to reconstruct a handle after restart or revocation.
    pub(crate) fn activate(
        &self,
        generation: ExecutionId,
        grant_id: ExecutionId,
        input: &FixedInput,
        expires_at_ms: u64,
        deadline: Instant,
        consent: PluginConsent,
        application_revocation: Option<ApplicationExecutionLease>,
    ) -> Result<PluginPermit, ExecutionError> {
        self.activate_with_delegation(
            generation,
            grant_id,
            input,
            expires_at_ms,
            deadline,
            consent.application_execution,
            None,
            application_revocation,
        )
    }

    pub(crate) fn activate_with_delegation(
        &self,
        generation: ExecutionId,
        grant_id: ExecutionId,
        input: &FixedInput,
        expires_at_ms: u64,
        deadline: Instant,
        application_execution: bool,
        delegation: Option<crate::application::WorkPlanToolDelegation>,
        application_revocation: Option<ApplicationExecutionLease>,
    ) -> Result<PluginPermit, ExecutionError> {
        let epoch = self.require_generation(generation)?;
        plugin_grant_deadline(expires_at_ms).map_err(|error| {
            if error.stage == "plugin-grant-expiry" {
                denied()
            } else {
                error
            }
        })?;
        if Instant::now() >= deadline {
            return Err(denied());
        }
        let mut grants = epoch.grants()?;
        grants.retain(|_, grant| grant.live());
        if grants.len() >= MAX_LIVE_GRANTS {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "plugin-grants",
            ));
        }
        if grants.contains_key(&grant_id)
            || grants
                .values()
                .any(|grant| grant.attempt_id == input.envelope().attempt_id)
        {
            return Err(denied());
        }
        let grant = Arc::new(GrantState {
            grant_id,
            attempt_id: input.envelope().attempt_id,
            task_id: input.envelope().task_id,
            input_digest: input.digest().into(),
            package: super::runtime::PackageKey::from_provider(
                &input
                    .envelope()
                    .plugin
                    .as_ref()
                    .ok_or_else(denied)?
                    .capability
                    .provider,
            ),
            generation,
            expires_at_ms,
            application_execution,
            deadline,
            delegation,
            application_revocation,
            revoked: AtomicBool::new(false),
        });
        let permit = PluginPermit {
            epoch: Arc::downgrade(&epoch),
            grant: grant.clone(),
        };
        if !permit.matches(input) || !permit.is_authorized() {
            return Err(denied());
        }
        grants.insert(grant_id, grant);
        Ok(permit)
    }

    pub(crate) fn permit(&self, input: &FixedInput) -> Result<PluginPermit, ExecutionError> {
        let epoch = self.current_epoch()?;
        let grant = epoch
            .grants()?
            .values()
            .find(|grant| grant.matches(input))
            .cloned()
            .ok_or_else(denied)?;
        let permit = PluginPermit {
            epoch: Arc::downgrade(&epoch),
            grant,
        };
        if !permit.is_authorized() {
            return Err(denied());
        }
        Ok(permit)
    }

    pub(crate) fn register_service_origin(
        &self,
        child: ExecutionId,
        guard: Arc<ServiceOriginGuard>,
    ) -> Result<(), ExecutionError> {
        let epoch = self.require_generation(guard.permit.generation())?;
        if !guard.live() {
            return Err(denied());
        }
        let mut origins = epoch.service_origins.lock().map_err(|_| denied())?;
        if let Some(existing) = origins.get(&child) {
            return if Arc::ptr_eq(existing, &guard) {
                Ok(())
            } else {
                Err(denied())
            };
        }
        origins.retain(|_, origin| origin.retain_until_terminal || origin.live());
        if origins.len() >= MAX_LIVE_GRANTS {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "service-origins",
            ));
        }
        origins.insert(child, guard);
        Ok(())
    }

    pub(crate) fn check_service_origin(
        &self,
        child: ExecutionId,
        digest: &str,
    ) -> Result<(), ExecutionError> {
        let epoch = self.current_epoch()?;
        let guard = epoch
            .service_origins
            .lock()
            .map_err(|_| denied())?
            .get(&child)
            .cloned()
            .ok_or_else(denied)?;
        if guard.digest != digest || !guard.live() {
            return Err(denied());
        }
        Ok(())
    }

    pub(crate) fn service_origin(
        &self,
        child: ExecutionId,
    ) -> Result<Option<Arc<ServiceOriginGuard>>, ExecutionError> {
        let origin = self.retained_service_origin(child)?;
        if origin.as_ref().is_some_and(|origin| !origin.live()) {
            return Err(denied());
        }
        Ok(origin)
    }

    /// Attribution survives revocation; this does not check or grant dispatch.
    pub(crate) fn retained_service_origin(
        &self,
        child: ExecutionId,
    ) -> Result<Option<Arc<ServiceOriginGuard>>, ExecutionError> {
        let current = self.current_lock()?;
        let Some(epoch) = current.as_ref() else {
            return Ok(None);
        };
        let origin = epoch
            .service_origins
            .lock()
            .map_err(|_| denied())?
            .get(&child)
            .cloned();
        Ok(origin)
    }

    pub(crate) fn release_service_origin(&self, child: ExecutionId) -> Result<(), ExecutionError> {
        let epoch = self.current_epoch()?;
        epoch
            .service_origins
            .lock()
            .map_err(|_| denied())?
            .remove(&child);
        Ok(())
    }

    pub(crate) fn revoke_grant(
        &self,
        generation: ExecutionId,
        grant_id: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let epoch = self.require_generation(generation)?;
        if let Some(grant) = epoch.grants()?.get(&grant_id) {
            grant.revoked.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub(crate) fn revoke_task(&self, task: ExecutionId) -> Result<(), ExecutionError> {
        let current = self.current_lock()?;
        if let Some(epoch) = current.as_ref() {
            for grant in epoch
                .grants()?
                .values()
                .filter(|grant| grant.task_id == task)
            {
                grant.revoked.store(true, Ordering::Release);
            }
        }
        Ok(())
    }

    pub(crate) fn revoke_all(&self) {
        match self.current.lock() {
            Ok(current) => {
                if let Some(epoch) = current.as_ref() {
                    epoch.revoke();
                }
            }
            Err(poisoned) => {
                if let Some(epoch) = poisoned.into_inner().as_ref() {
                    epoch.revoke();
                }
            }
        }
    }
}
impl Drop for PluginAuthority {
    fn drop(&mut self) {
        self.revoke_all();
    }
}
