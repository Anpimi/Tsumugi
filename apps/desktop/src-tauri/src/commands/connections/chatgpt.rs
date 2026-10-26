//! Trusted, application-scoped ChatGPT account owner. Only non-secret views
//! cross desktop IPC; project and member processes receive account references.
mod oauth;
mod storage;

use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tsumugi_core::{
    ai::provider::SubscriptionCredentials,
    execution::{ErrorCode, ExecutionError, ExecutionId},
};

const SESSION_LIFETIME: Duration = Duration::from_secs(300);
const REFRESH_MARGIN_MS: u64 = 30_000;
const MAX_REGISTRATIONS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptRegistrationView {
    pub id: ExecutionId,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptAccountView {
    pub id: ExecutionId,
    pub registration: ExecutionId,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptLoginView {
    pub id: ExecutionId,
    pub authorization_url: String,
    /// Unix milliseconds. The listener also enforces a monotonic deadline.
    pub expires_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ChatGptAccountIssue {
    LoginFailed,
    LoginExpired,
    LoginCancelled,
    StorageUnavailable,
    SessionSuperseded,
    ReauthenticationRequired,
    RemoteRevocationUnconfirmed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptAccountStatus {
    pub account: Option<ChatGptAccountView>,
    pub registrations: Vec<ChatGptRegistrationView>,
    pub login: Option<ChatGptLoginView>,
    pub issue: Option<ChatGptAccountIssue>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptModelView {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ChatGptModelCatalog {
    pub account: ExecutionId,
    pub models: Vec<ChatGptModelView>,
}

// Secret-bearing types deliberately have no Debug or IPC/schema derivation.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    account: ExecutionId,
    access_token: String,
    refresh_token: String,
    id_token: String,
    nonce: String,
    scopes: Vec<String>,
    expires_at: u64,
    earliest_refresh_at: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    id: ExecutionId,
    client_id: String,
    subject: String,
    label: String,
    credentials: Option<Credentials>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Vault {
    version: u32,
    host: ExecutionId,
    active: Option<ExecutionId>,
    registrations: Vec<Registration>,
}

impl Vault {
    fn empty(host: ExecutionId) -> Self {
        Self {
            version: 1,
            host,
            active: None,
            registrations: Vec::new(),
        }
    }

    fn active_registration(&self, account: ExecutionId) -> Result<&Registration, ExecutionError> {
        if self.active != Some(account) {
            return Err(unauthorized());
        }
        self.registrations
            .iter()
            .find(|registration| {
                registration
                    .credentials
                    .as_ref()
                    .is_some_and(|value| value.account == account)
            })
            .ok_or_else(unauthorized)
    }
}

struct PendingLogin {
    view: ChatGptLoginView,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

#[derive(Default)]
struct AccountState {
    vault: Option<Vault>,
    pending: Option<PendingLogin>,
    issue: Option<ChatGptAccountIssue>,
    closed: bool,
    // A failed secure-store write must never leave an older token usable from
    // the process cache, even if the platform retained its previous value.
    storage_failed: bool,
}

pub struct ChatGptAccounts {
    state: Mutex<AccountState>,
    // Token exchange, rotating refresh, persistence and revocation have one
    // order. Logout/cancel first invalidate admission under `state`, so they do
    // not wait for a network request before withdrawing local authorization.
    rotation: Mutex<()>,
    storage: Box<dyn storage::CredentialStorage>,
    remote: Box<dyn oauth::Remote>,
}

impl ChatGptAccounts {
    /// No filesystem, Keychain, browser or network action happens here.
    pub fn new(application_directory: &Path) -> Result<Self, ExecutionError> {
        Ok(Self {
            state: Mutex::new(AccountState::default()),
            rotation: Mutex::new(()),
            storage: Box::new(storage::KeychainStorage::new(application_directory)),
            remote: Box::new(oauth::OpenAi),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, AccountState>, ExecutionError> {
        self.state.lock().map_err(|_| storage_error())
    }

    fn loaded(&self) -> Result<MutexGuard<'_, AccountState>, ExecutionError> {
        let mut state = self.lock()?;
        if state.closed {
            return Err(unauthorized());
        }
        if state.vault.is_none() {
            state.vault = Some(self.storage.load()?);
        }
        Ok(state)
    }

    fn save(
        &self,
        state: &mut AccountState,
        mut candidate: Vault,
        changed_registration: Option<ExecutionId>,
    ) -> Result<(), ExecutionError> {
        if let Err(error) = self.storage.save(&candidate) {
            // The write may have reached storage even when its completion is
            // uncertain. Keep the safe replacement in memory for explicit
            // retry; never reload the previous vault or revive its account.
            candidate.active = None;
            if let Some(record) = candidate
                .registrations
                .iter_mut()
                .find(|record| Some(record.id) == changed_registration)
            {
                record.credentials = None;
            }
            state.vault = Some(candidate);
            cancel_pending(state);
            state.storage_failed = true;
            state.issue = Some(ChatGptAccountIssue::StorageUnavailable);
            return Err(error);
        }
        state.vault = Some(candidate);
        state.storage_failed = false;
        Ok(())
    }

    /// Read local status only. It cannot start refresh, discovery or inference.
    pub fn status(&self) -> Result<ChatGptAccountStatus, ExecutionError> {
        let mut state = self.loaded()?;
        expire_pending(&mut state);
        Ok(view(&state))
    }

    /// Explicitly retry a failed secure-store update, never a login or request.
    pub fn retry_storage(&self) -> Result<ChatGptAccountStatus, ExecutionError> {
        let _rotation = self.rotation.lock().map_err(|_| storage_error())?;
        let mut state = self.loaded()?;
        if state.storage_failed {
            let candidate = state.vault.clone().ok_or_else(storage_error)?;
            self.save(&mut state, candidate, None)?;
            state.issue = Some(ChatGptAccountIssue::ReauthenticationRequired);
        }
        Ok(view(&state))
    }

    /// None registers another account; Some reauthorizes that exact saved
    /// client/subject. The current account remains active until validation.
    pub fn begin(
        self: &Arc<Self>,
        registration: Option<ExecutionId>,
    ) -> Result<ChatGptLoginView, ExecutionError> {
        let mut state = self.loaded()?;
        if state.storage_failed {
            return Err(storage_error());
        }
        let vault = state.vault.as_ref().ok_or_else(storage_error)?;
        let selected = match registration {
            Some(id) => Some(
                vault
                    .registrations
                    .iter()
                    .find(|item| item.id == id)
                    .ok_or_else(unauthorized)?
                    .clone(),
            ),
            None if vault.registrations.len() >= MAX_REGISTRATIONS => {
                return Err(failure(ErrorCode::LimitExceeded, "chatgpt-registrations"));
            }
            None => None,
        };
        let id = ExecutionId::new();
        let expires_at = now_ms()?
            .checked_add(SESSION_LIFETIME.as_millis() as u64)
            .ok_or_else(storage_error)?;
        let prepared = oauth::prepare(vault.host, selected, id, expires_at)?;
        cancel_pending(&mut state);
        let login = prepared.view.clone();
        state.pending = Some(PendingLogin {
            view: login.clone(),
            cancelled: prepared.cancelled.clone(),
            deadline: prepared.deadline,
        });
        state.issue = None;
        let owner = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("chatgpt-sign-in".into())
            .spawn(move || {
                let callback = oauth::wait_callback(&prepared);
                if let Some(owner) = owner.upgrade() {
                    owner.complete_login(prepared, callback);
                }
            })
            .map_err(|_| {
                cancel_pending(&mut state);
                state.issue = Some(ChatGptAccountIssue::LoginFailed);
                failure(ErrorCode::DependencyConflict, "chatgpt-listener")
            })?;
        Ok(login)
    }

    fn complete_login(
        &self,
        pending: oauth::PreparedLogin,
        callback: Result<oauth::Callback, ChatGptAccountIssue>,
    ) {
        let mut unaccepted = None;
        let result = (|| {
            let callback = callback.map_err(|issue| (issue, None))?;
            let _rotation = self
                .rotation
                .lock()
                .map_err(|_| (ChatGptAccountIssue::StorageUnavailable, None))?;
            self.require_pending(pending.view.id)?;
            let grant = self
                .remote
                .login(&pending, callback)
                .map_err(|issue| (issue, None))?;
            unaccepted = Some(Registration {
                id: ExecutionId::new(),
                client_id: grant.client_id.clone(),
                subject: grant.subject.clone(),
                label: grant.label.clone(),
                credentials: Some(grant.credentials.clone()),
            });
            let mut state = self
                .lock()
                .map_err(|_| (ChatGptAccountIssue::StorageUnavailable, None))?;
            if !pending_is_current(&state, pending.view.id) {
                return Err((ChatGptAccountIssue::SessionSuperseded, None));
            }
            let mut candidate = state
                .vault
                .clone()
                .ok_or((ChatGptAccountIssue::StorageUnavailable, None))?;
            let target = match &pending.selected {
                Some(selected) => {
                    if selected.client_id != grant.client_id || selected.subject != grant.subject {
                        return Err((ChatGptAccountIssue::LoginFailed, None));
                    }
                    selected.id
                }
                None => match candidate
                    .registrations
                    .iter()
                    .find(|item| item.client_id == grant.client_id)
                {
                    Some(existing) if existing.subject == grant.subject => existing.id,
                    Some(_) => return Err((ChatGptAccountIssue::LoginFailed, None)),
                    None => ExecutionId::new(),
                },
            };
            let account = grant.credentials.account;
            let label = registration_label(&candidate, target, &grant.label);
            let record = Registration {
                id: target,
                client_id: grant.client_id,
                subject: grant.subject,
                label,
                credentials: Some(grant.credentials),
            };
            if let Some(existing) = candidate
                .registrations
                .iter_mut()
                .find(|item| item.id == target)
            {
                *existing = record;
            } else {
                candidate.registrations.push(record);
            }
            candidate.active = Some(account);
            self.save(&mut state, candidate, Some(target))
                .map_err(|error| (ChatGptAccountIssue::StorageUnavailable, Some(error)))?;
            state.pending = None;
            state.issue = None;
            unaccepted = None;
            Ok::<(), (ChatGptAccountIssue, Option<ExecutionError>)>(())
        })();
        // A validated but cancelled/superseded login must not leave an unused
        // renewable session behind. No token or remote error reaches the UI.
        if let Some(record) = unaccepted {
            let _ = self.remote.revoke(&record);
        }
        if let Err((issue, _)) = result {
            if let Ok(mut state) = self.lock() {
                // Late failure and cancellation cannot clear a newer session.
                if state
                    .pending
                    .as_ref()
                    .is_some_and(|value| value.view.id == pending.view.id)
                {
                    cancel_pending(&mut state);
                    state.issue = Some(issue);
                }
            }
        }
    }

    fn require_pending(
        &self,
        id: ExecutionId,
    ) -> Result<(), (ChatGptAccountIssue, Option<ExecutionError>)> {
        let state = self
            .lock()
            .map_err(|_| (ChatGptAccountIssue::StorageUnavailable, None))?;
        if pending_is_current(&state, id) {
            Ok(())
        } else {
            Err((ChatGptAccountIssue::SessionSuperseded, None))
        }
    }

    pub fn cancel(&self, session_id: ExecutionId) -> Result<ChatGptAccountStatus, ExecutionError> {
        let mut state = self.loaded()?;
        if state
            .pending
            .as_ref()
            .is_some_and(|value| value.view.id == session_id)
        {
            cancel_pending(&mut state);
            state.issue = Some(ChatGptAccountIssue::LoginCancelled);
        }
        // A stale cancel is an idempotent observation, not permission to cancel
        // whichever login happened to replace the captured session.
        Ok(view(&state))
    }

    pub fn logout(
        &self,
        expected_account: ExecutionId,
    ) -> Result<ChatGptAccountStatus, ExecutionError> {
        let (registration, original) = {
            let mut state = self.loaded()?;
            let vault = state.vault.as_mut().ok_or_else(storage_error)?;
            let record = vault.active_registration(expected_account)?.clone();
            vault.active = None;
            cancel_pending(&mut state);
            (record.id, record)
        };
        let _rotation = self.rotation.lock().map_err(|_| storage_error())?;
        let (revoke, storage_failure) = {
            let mut state = self.lock()?;
            let mut candidate = state.vault.clone().ok_or_else(storage_error)?;
            // A refresh finishing after local withdrawal may have rotated this
            // record. Revoke its latest replacement, never another login's.
            let current = candidate
                .registrations
                .iter_mut()
                .find(|item| item.id == registration);
            let revoke = if let Some(record) = current {
                if record
                    .credentials
                    .as_ref()
                    .is_some_and(|value| value.account == expected_account)
                {
                    let revoke = record.clone();
                    record.credentials = None;
                    revoke
                } else {
                    original
                }
            } else {
                original
            };
            let storage_failure = self.save(&mut state, candidate, Some(registration)).err();
            (revoke, storage_failure)
        };
        let revoked = self.remote.revoke(&revoke).is_ok();
        let mut state = self.lock()?;
        if let Some(error) = storage_failure {
            return Err(error);
        }
        if state
            .vault
            .as_ref()
            .is_some_and(|vault| vault.active.is_none())
            && state.pending.is_none()
        {
            state.issue = (!revoked).then_some(ChatGptAccountIssue::RemoteRevocationUnconfirmed);
        }
        Ok(view(&state))
    }

    pub fn models(&self, account: ExecutionId) -> Result<ChatGptModelCatalog, ExecutionError> {
        let token = self.access_token(account)?;
        self.check_active(account)?;
        let models = self.remote.models(&token)?;
        self.check_active(account)?;
        Ok(ChatGptModelCatalog { account, models })
    }

    /// Stop callback admission on application exit without signing out.
    pub fn close(&self) {
        if let Ok(mut state) = self.lock() {
            state.closed = true;
            cancel_pending(&mut state);
        }
    }

    #[cfg(test)]
    pub(crate) fn synthetic() -> Self {
        tests::synthetic_owner()
    }

    fn reject_credentials(
        &self,
        state: &mut AccountState,
        registration: ExecutionId,
        account: ExecutionId,
        issue: ChatGptAccountIssue,
    ) {
        let Some(mut candidate) = state.vault.clone() else {
            return;
        };
        if let Some(record) = candidate
            .registrations
            .iter_mut()
            .find(|record| record.id == registration)
        {
            if record
                .credentials
                .as_ref()
                .is_some_and(|value| value.account == account)
            {
                record.credentials = None;
            }
        }
        if candidate.active == Some(account) {
            candidate.active = None;
        }
        // In-memory withdrawal is unconditional if persistence is unavailable.
        state.vault = Some(candidate.clone());
        state.issue = Some(issue);
        let _ = self.save(state, candidate, Some(registration));
    }
}

impl SubscriptionCredentials for ChatGptAccounts {
    fn check_active(&self, account: ExecutionId) -> Result<(), ExecutionError> {
        let state = self.loaded()?;
        if state.storage_failed {
            return Err(storage_error());
        }
        state
            .vault
            .as_ref()
            .ok_or_else(storage_error)?
            .active_registration(account)?;
        Ok(())
    }

    fn access_token(&self, account: ExecutionId) -> Result<String, ExecutionError> {
        let _rotation = self.rotation.lock().map_err(|_| storage_error())?;
        let registration = {
            let state = self.loaded()?;
            if state.storage_failed {
                return Err(storage_error());
            }
            let registration = state
                .vault
                .as_ref()
                .ok_or_else(storage_error)?
                .active_registration(account)?
                .clone();
            let credentials = registration.credentials.as_ref().ok_or_else(unauthorized)?;
            let now = now_ms()?;
            if credentials.expires_at > now.saturating_add(REFRESH_MARGIN_MS)
                || credentials.expires_at > now
                    && credentials.earliest_refresh_at.is_some_and(|at| now < at)
            {
                return Ok(credentials.access_token.clone());
            }
            registration
        };
        let refreshed = self.remote.refresh(&registration);
        let mut state = self.lock()?;
        let original_is_current = state.vault.as_ref().is_some_and(|vault| {
            vault.registrations.iter().any(|item| {
                item.id == registration.id
                    && item
                        .credentials
                        .as_ref()
                        .is_some_and(|value| value.account == account)
            })
        });
        if !original_is_current {
            return Err(unauthorized());
        }
        let refreshed = match refreshed {
            Ok(credentials) => credentials,
            Err(_) => {
                self.reject_credentials(
                    &mut state,
                    registration.id,
                    account,
                    ChatGptAccountIssue::ReauthenticationRequired,
                );
                return Err(unauthorized());
            }
        };
        let token = refreshed.access_token.clone();
        let unpersisted = Registration {
            credentials: Some(refreshed.clone()),
            ..registration.clone()
        };
        let mut candidate = state.vault.clone().ok_or_else(storage_error)?;
        let record = candidate
            .registrations
            .iter_mut()
            .find(|item| item.id == registration.id)
            .ok_or_else(unauthorized)?;
        record.credentials = Some(refreshed);
        if let Err(error) = self.save(&mut state, candidate, Some(registration.id)) {
            drop(state);
            let _ = self.remote.revoke(&unpersisted);
            return Err(error);
        }
        if state.closed
            || state
                .vault
                .as_ref()
                .is_none_or(|vault| vault.active != Some(account))
        {
            return Err(unauthorized());
        }
        Ok(token)
    }
}

impl Drop for ChatGptAccounts {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            cancel_pending(state);
        }
    }
}

fn pending_is_current(state: &AccountState, id: ExecutionId) -> bool {
    !state.closed
        && !state.storage_failed
        && state.pending.as_ref().is_some_and(|value| {
            value.view.id == id
                && !value.cancelled.load(Ordering::Acquire)
                && Instant::now() < value.deadline
        })
}

fn cancel_pending(state: &mut AccountState) {
    if let Some(pending) = state.pending.take() {
        pending.cancelled.store(true, Ordering::Release);
    }
}

fn expire_pending(state: &mut AccountState) {
    if state
        .pending
        .as_ref()
        .is_some_and(|value| Instant::now() >= value.deadline)
    {
        cancel_pending(state);
        state.issue = Some(ChatGptAccountIssue::LoginExpired);
    }
}

fn registration_label(vault: &Vault, target: ExecutionId, identity_label: &str) -> String {
    // Labels identify saved registrations, including multiple workspaces that
    // share an email. Reauthorization keeps the user's existing stable label.
    if let Some(existing) = vault
        .registrations
        .iter()
        .find(|record| record.id == target)
    {
        return existing.label.clone();
    }
    let available = |label: &str| {
        vault
            .registrations
            .iter()
            .all(|record| record.label != label)
    };
    if available(identity_label) {
        return identity_label.to_owned();
    }
    for ordinal in 2..=MAX_REGISTRATIONS + 1 {
        let label = format!("{identity_label} ({ordinal})");
        if available(&label) {
            return label;
        }
    }
    // At most MAX_REGISTRATIONS labels exist, so one of the candidates above
    // is necessarily available without exposing an internal client identity.
    unreachable!("bounded registration labels exhausted")
}

fn view(state: &AccountState) -> ChatGptAccountStatus {
    let vault = state.vault.as_ref();
    let account = (!state.closed && !state.storage_failed)
        .then(|| {
            vault.and_then(|vault| {
                let id = vault.active?;
                let record = vault.active_registration(id).ok()?;
                Some(ChatGptAccountView {
                    id,
                    registration: record.id,
                    label: record.label.clone(),
                })
            })
        })
        .flatten();
    ChatGptAccountStatus {
        account,
        registrations: vault
            .map(|vault| {
                vault
                    .registrations
                    .iter()
                    .map(|record| ChatGptRegistrationView {
                        id: record.id,
                        label: record.label.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        login: state.pending.as_ref().map(|value| value.view.clone()),
        issue: state.issue,
    }
}

fn now_ms() -> Result<u64, ExecutionError> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| storage_error())?
            .as_millis(),
    )
    .map_err(|_| storage_error())
}
fn failure(code: ErrorCode, stage: &'static str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn unauthorized() -> ExecutionError {
    failure(ErrorCode::Unauthorized, "chatgpt-account")
}
fn storage_error() -> ExecutionError {
    failure(ErrorCode::StorageFailed, "chatgpt-secure-storage")
}

#[cfg(test)]
mod tests;
