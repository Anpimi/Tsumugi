//! Session-local revocation handles for grants owned by the project ledger.
//! A handle cannot create, renew, or restore a durable authorization.
use super::{Cancellation, ErrorCode, ExecutionError, ExecutionId, FixedInput};
use std::{
    collections::BTreeMap,
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
    generation: ExecutionId,
    expires_at_ms: u64,
    deadline: Instant,
    delegation: Option<crate::application::WorkPlanToolDelegation>,
    revoked: AtomicBool,
}
impl GrantState {
    fn live(&self) -> bool {
        if self.revoked.load(Ordering::Acquire) {
            return false;
        }
        let live = Instant::now() < self.deadline
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
    ) -> bool {
        self.matches(input)
            && self.grant.grant_id == grant_id
            && self.grant.generation == generation
            && self.grant.expires_at_ms == expires_at_ms
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
    pub(crate) revoked: Cancellation,
    pub(crate) deadline: Instant,
    pub(crate) digest: String,
}
impl ServiceOriginGuard {
    pub(crate) fn live(&self) -> bool {
        if Instant::now() >= self.deadline {
            self.revoked.request();
        }
        !self.cancellation.is_requested()
            && !self.revoked.is_requested()
            && self.permit.is_authorized()
    }
}
impl PluginEpoch {
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
    ) -> Result<PluginPermit, ExecutionError> {
        self.activate_with_delegation(generation, grant_id, input, expires_at_ms, deadline, None)
    }

    pub(crate) fn activate_with_delegation(
        &self,
        generation: ExecutionId,
        grant_id: ExecutionId,
        input: &FixedInput,
        expires_at_ms: u64,
        deadline: Instant,
        delegation: Option<crate::application::WorkPlanToolDelegation>,
    ) -> Result<PluginPermit, ExecutionError> {
        let epoch = self.require_generation(generation)?;
        let now = plugin_now_ms()?;
        expires_at_ms
            .checked_sub(now)
            .filter(|remaining| *remaining > 0 && *remaining <= MAX_PLUGIN_GRANT_LIFETIME_MS)
            .ok_or_else(denied)?;
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
            generation,
            expires_at_ms,
            deadline,
            delegation,
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
        origins.retain(|_, origin| origin.live());
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
        if origin.as_ref().is_some_and(|origin| !origin.live()) {
            return Err(denied());
        }
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
