use super::*;
use std::sync::{Condvar, atomic::AtomicUsize, mpsc};

#[derive(Clone)]
struct MemoryStorage {
    value: Arc<Mutex<Vault>>,
    fail: Arc<AtomicBool>,
    reads: Arc<AtomicUsize>,
}
impl storage::CredentialStorage for MemoryStorage {
    fn load(&self) -> Result<Vault, ExecutionError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) { return Err(storage_error()); }
        Ok(self.value.lock().unwrap().clone())
    }
    fn save(&self, vault: &Vault) -> Result<(), ExecutionError> {
        storage::validate_fixture(vault)?;
        if self.fail.load(Ordering::SeqCst) { return Err(storage_error()); }
        *self.value.lock().unwrap() = vault.clone();
        Ok(())
    }
}

struct RejectRemote;
impl oauth::Remote for RejectRemote {
    fn login(&self, _: &oauth::PreparedLogin, _: oauth::Callback) -> Result<oauth::Grant, ChatGptAccountIssue> {
        Err(ChatGptAccountIssue::LoginFailed)
    }
    fn refresh(&self, _: &Registration) -> Result<Credentials, ExecutionError> { Err(unauthorized()) }
    fn models(&self, _: &str) -> Result<Vec<ChatGptModelView>, ExecutionError> { Err(unauthorized()) }
    fn revoke(&self, _: &Registration) -> Result<(), ExecutionError> { Err(unauthorized()) }
}

fn memory(vault: Vault) -> MemoryStorage {
    MemoryStorage { value:Arc::new(Mutex::new(vault)), fail:Arc::new(AtomicBool::new(false)),
        reads:Arc::new(AtomicUsize::new(0)) }
}
fn owner(storage: MemoryStorage, remote: impl oauth::Remote + 'static) -> ChatGptAccounts {
    ChatGptAccounts { state:Mutex::new(AccountState::default()), rotation:Mutex::new(()),
        storage:Box::new(storage),remote:Box::new(remote) }
}
pub(super) fn synthetic_owner() -> ChatGptAccounts {
    owner(memory(Vault::empty(ExecutionId::new())), RejectRemote)
}

fn credentials(account: ExecutionId, expired: bool) -> Credentials {
    Credentials { account,access_token:"synthetic-access".into(),refresh_token:"synthetic-refresh".into(),
        id_token:"synthetic-id-token".into(),nonce:"synthetic-nonce".into(),
        scopes:vec!["offline_access".into(),"resource.invoke".into(),"chatgpt.tokens.use.direct".into()],
        expires_at:if expired {now_ms().unwrap()-1000} else {now_ms().unwrap()+3_600_000},
        earliest_refresh_at:None }
}
fn registration(account: ExecutionId, client: &str, expired: bool) -> Registration {
    Registration { id:ExecutionId::new(),client_id:client.into(),subject:format!("subject-{client}"),
        label:"account@example.test".into(),credentials:Some(credentials(account,expired)) }
}
fn vault(records: Vec<Registration>, active: ExecutionId) -> Vault {
    Vault {version:1,host:ExecutionId::new(),active:Some(active),registrations:records}
}

#[test]
fn synthetic_constructor_and_offline_status_never_create_external_credentials() {
    let storage = memory(Vault::empty(ExecutionId::new()));
    let owner = owner(storage.clone(),RejectRemote);
    assert_eq!(storage.reads.load(Ordering::SeqCst),0);
    let status = owner.status().unwrap();
    assert!(status.account.is_none() && status.registrations.is_empty() && status.login.is_none());
    owner.status().unwrap();
    assert_eq!(storage.reads.load(Ordering::SeqCst),1);
    assert!(ChatGptAccounts::synthetic().status().unwrap().account.is_none());
}

#[test]
fn account_reference_cannot_select_inactive_saved_credentials_or_fallback_to_another_account() {
    let first = ExecutionId::new();
    let second = ExecutionId::new();
    let storage = memory(vault(vec![registration(first,"oaiapp_first",false),
        registration(second,"oaiapp_second",false)],second));
    let owner = owner(storage,RejectRemote);
    assert!(owner.check_active(first).is_err());
    assert!(owner.access_token(first).is_err());
    assert_eq!(owner.access_token(second).unwrap(),"synthetic-access");
    let status = owner.status().unwrap();
    let serialized = serde_json::to_string(&status).unwrap();
    assert_eq!(status.registrations.len(),2);
    assert!(!serialized.contains("synthetic-access") && !serialized.contains("synthetic-refresh") &&
        !serialized.contains("synthetic-id-token") && !serialized.contains("subject-oaiapp"));
}

#[test]
fn stale_cancel_does_not_cancel_new_login_and_close_preserves_saved_session() {
    let account = ExecutionId::new();
    let record = registration(account,"oaiapp_synthetic",false);
    let storage = memory(vault(vec![record],account));
    let owner = Arc::new(owner(storage.clone(),RejectRemote));
    let first = owner.begin(None).unwrap();
    let second = owner.begin(None).unwrap();
    assert_eq!(owner.cancel(first.id).unwrap().login.unwrap().id,second.id);
    assert!(owner.check_active(account).is_ok());
    owner.close();
    assert!(owner.check_active(account).is_err());
    assert!(owner.lock().unwrap().pending.is_none());
    assert_eq!(storage.value.lock().unwrap().active,Some(account));
    assert!(storage.value.lock().unwrap().registrations[0].credentials.is_some());
}

#[derive(Clone)]
struct Gate {
    entered: mpsc::SyncSender<()>,
    release: Arc<(Mutex<bool>,Condvar)>,
    revoked: Arc<Mutex<Vec<String>>>,
}
impl Gate {
    fn wait(&self) {
        self.entered.send(()).unwrap();
        let (ready,wake) = &*self.release;
        let ready = ready.lock().unwrap();
        let (ready,timeout) = wake.wait_timeout_while(ready,Duration::from_secs(5),|ready| !*ready).unwrap();
        assert!(!timeout.timed_out() && *ready);
    }
    fn open(&self) {
        let (ready,wake) = &*self.release;
        *ready.lock().unwrap() = true;
        wake.notify_all();
    }
}
fn gate() -> (Gate,mpsc::Receiver<()>) {
    let (entered,rx) = mpsc::sync_channel(1);
    (Gate {entered,release:Arc::new((Mutex::new(false),Condvar::new())),
        revoked:Arc::new(Mutex::new(Vec::new()))},rx)
}
struct GatedRemote { gate: Gate, login: bool }
impl oauth::Remote for GatedRemote {
    fn login(&self, _: &oauth::PreparedLogin, _: oauth::Callback) -> Result<oauth::Grant,ChatGptAccountIssue> {
        assert!(self.login);
        self.gate.wait();
        Ok(oauth::Grant {client_id:"oaiapp_synthetic".into(),subject:"validated-subject".into(),
            label:"validated@example.test".into(),credentials:credentials(ExecutionId::new(),false)})
    }
    fn refresh(&self, registration: &Registration) -> Result<Credentials,ExecutionError> {
        assert!(!self.login);
        self.gate.wait();
        let mut refreshed = registration.credentials.as_ref().unwrap().clone();
        refreshed.access_token = "synthetic-refreshed-access".into();
        refreshed.refresh_token = "synthetic-rotated-refresh".into();
        refreshed.expires_at = now_ms().unwrap()+3_600_000;
        Ok(refreshed)
    }
    fn models(&self, _: &str) -> Result<Vec<ChatGptModelView>,ExecutionError> { Err(unauthorized()) }
    fn revoke(&self, registration: &Registration) -> Result<(),ExecutionError> {
        self.gate.revoked.lock().unwrap().push(registration.credentials.as_ref().unwrap().refresh_token.clone());
        Ok(())
    }
}

#[test]
fn logout_withdraws_immediately_during_refresh_and_revokes_the_latest_rotation_only() {
    let account = ExecutionId::new();
    let inactive = ExecutionId::new();
    let storage = memory(vault(vec![registration(account,"oaiapp_active",true),
        registration(inactive,"oaiapp_inactive",false)],account));
    let (gate,entered) = gate();
    let owner = Arc::new(owner(storage.clone(),GatedRemote {gate:gate.clone(),login:false}));
    let refreshing = {let owner=owner.clone();std::thread::spawn(move || owner.access_token(account))};
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let logout = {let owner=owner.clone();std::thread::spawn(move || owner.logout(account))};
    let deadline = Instant::now()+Duration::from_secs(2);
    while owner.check_active(account).is_ok() && Instant::now()<deadline {std::thread::yield_now();}
    assert!(owner.check_active(account).is_err());
    gate.open();
    assert!(refreshing.join().unwrap().is_err());
    assert!(logout.join().unwrap().unwrap().account.is_none());
    assert_eq!(*gate.revoked.lock().unwrap(),vec!["synthetic-rotated-refresh"]);
    let saved = storage.value.lock().unwrap();
    assert!(saved.registrations[0].credentials.is_none());
    assert_eq!(saved.registrations[1].credentials.as_ref().unwrap().account,inactive);
    assert!(saved.active.is_none());
}

#[test]
fn storage_failure_during_logout_still_attempts_revocation_and_blocks_process_cache() {
    let account = ExecutionId::new();
    let storage = memory(vault(vec![registration(account,"oaiapp_active",false)],account));
    let (gate,_) = gate();
    let owner = owner(storage.clone(),GatedRemote {gate:gate.clone(),login:false});
    owner.status().unwrap();
    storage.fail.store(true,Ordering::SeqCst);
    assert_eq!(owner.logout(account).unwrap_err().code,ErrorCode::StorageFailed);
    assert_eq!(*gate.revoked.lock().unwrap(),vec!["synthetic-refresh"]);
    assert!(owner.check_active(account).is_err());
    let status = owner.status().unwrap();
    assert!(status.account.is_none());
    assert_eq!(status.issue,Some(ChatGptAccountIssue::StorageUnavailable));
}

#[test]
fn refresh_storage_failure_revokes_unpersisted_rotation_and_does_not_return_a_token() {
    let account = ExecutionId::new();
    let storage = memory(vault(vec![registration(account,"oaiapp_active",true)],account));
    let (gate,entered) = gate();
    let owner = Arc::new(owner(storage.clone(),GatedRemote {gate:gate.clone(),login:false}));
    let refreshing = {let owner=owner.clone();std::thread::spawn(move || owner.access_token(account))};
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    storage.fail.store(true,Ordering::SeqCst);
    gate.open();
    assert_eq!(refreshing.join().unwrap().unwrap_err().code,ErrorCode::StorageFailed);
    assert_eq!(*gate.revoked.lock().unwrap(),vec!["synthetic-rotated-refresh"]);
    assert!(owner.check_active(account).is_err());
    let status = owner.status().unwrap();
    assert!(status.account.is_none());
    assert_eq!(status.issue,Some(ChatGptAccountIssue::StorageUnavailable));
}

#[test]
fn duplicate_email_registrations_have_distinct_stable_labels_without_internal_identity() {
    let account = ExecutionId::new();
    let first = registration(account,"oaiapp_first",false);
    let mut saved = vault(vec![first.clone()],account);
    let target = ExecutionId::new();
    let label = registration_label(&saved,target,"account@example.test");
    assert_eq!(label,"account@example.test (2)");
    let mut second = registration(ExecutionId::new(),"oaiapp_second",false);
    second.id = target;
    second.label = label.clone();
    saved.registrations.push(second);
    assert_eq!(registration_label(&saved,target,"changed@example.test"),label);
    assert_eq!(registration_label(&saved,first.id,"changed@example.test"),"account@example.test");
    assert_eq!(registration_label(&saved,ExecutionId::new(),"account@example.test"),"account@example.test (3)");
    assert!(!label.contains("oaiapp") && !label.contains(&target.to_string()));
}

#[test]
fn successful_late_login_is_revoked_without_replacing_account_or_new_pending_session() {
    let account = ExecutionId::new();
    let storage = memory(vault(vec![registration(account,"oaiapp_active",false)],account));
    let (gate,entered) = gate();
    let owner = Arc::new(owner(storage,GatedRemote {gate:gate.clone(),login:true}));
    owner.status().unwrap();
    let pending = oauth::prepare(ExecutionId::new(),None,ExecutionId::new(),now_ms().unwrap()+300_000).unwrap();
    owner.lock().unwrap().pending = Some(PendingLogin {view:pending.view.clone(),
        cancelled:pending.cancelled.clone(),deadline:pending.deadline});
    let old_login = {let owner=owner.clone();std::thread::spawn(move ||
        owner.complete_login(pending,Ok(oauth::synthetic_callback())))};
    entered.recv_timeout(Duration::from_secs(2)).unwrap();
    let new_login = owner.begin(None).unwrap();
    gate.open();
    old_login.join().unwrap();
    let status = owner.status().unwrap();
    assert_eq!(status.account.unwrap().id,account);
    assert_eq!(status.login.unwrap().id,new_login.id);
    assert_eq!(*gate.revoked.lock().unwrap(),vec!["synthetic-refresh"]);
    owner.cancel(new_login.id).unwrap();
}

#[test]
fn saved_document_rejects_invalid_credential_scope_duplicate_clients_and_wrong_active_reference() {
    let account = ExecutionId::new();
    let mut invalid = vault(vec![registration(account,"oaiapp_synthetic",false)],account);
    assert!(storage::validate_fixture(&invalid).is_ok());
    invalid.registrations[0].credentials.as_mut().unwrap().scopes.clear();
    assert!(storage::validate_fixture(&invalid).is_err());
    let mut invalid = vault(vec![registration(account,"oaiapp_synthetic",false)],ExecutionId::new());
    assert!(storage::validate_fixture(&invalid).is_err());
    invalid.active=Some(account);
    let mut duplicate = invalid.registrations[0].clone();
    duplicate.id=ExecutionId::new();
    duplicate.credentials=None;
    invalid.registrations.push(duplicate);
    assert!(storage::validate_fixture(&invalid).is_err());
}
