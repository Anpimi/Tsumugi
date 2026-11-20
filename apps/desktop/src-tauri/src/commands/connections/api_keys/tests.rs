use super::*;
use std::{collections::BTreeMap, sync::{Mutex, atomic::{AtomicBool, Ordering}}};

#[derive(Clone, Default)]
struct MemoryStorage {
    keys: Arc<Mutex<BTreeMap<ExecutionId, String>>>,
    failed: Arc<AtomicBool>,
}
impl ApiKeys {
    pub(in crate::commands) fn synthetic() -> Self {
        Self { storage: Box::new(MemoryStorage::default()), operations: Mutex::new(()) }
    }
}
impl CredentialStorage for MemoryStorage {
    fn supported(&self) -> bool { true }
    fn read(&self, reference: ExecutionId) -> Result<Option<String>, ExecutionError> {
        if self.failed.load(Ordering::Acquire) { return Err(storage_error()); }
        Ok(self.keys.lock().unwrap().get(&reference).cloned())
    }
    fn create(&self, reference: ExecutionId, secret: &str) -> Result<(), ExecutionError> {
        if self.failed.load(Ordering::Acquire) { return Err(storage_error()); }
        let mut keys = self.keys.lock().unwrap();
        if keys.get(&reference).is_some_and(|previous| previous != secret) {
            return Err(fail(ErrorCode::DependencyConflict, "api-key-reference-changed"));
        }
        keys.insert(reference, secret.into()); Ok(())
    }
    fn delete(&self, reference: ExecutionId) -> Result<(), ExecutionError> {
        if self.failed.load(Ordering::Acquire) { return Err(storage_error()); }
        self.keys.lock().unwrap().remove(&reference); Ok(())
    }
}
fn change(store: &ModelConnectionStore, profile: ExecutionId, name: &str) -> ModelConnectionChange {
    let action_id = ExecutionId::new();
    ModelConnectionChange {
        action_id, expected: store.snapshot().unwrap().basis().unwrap(),
        edit: ModelConnectionEdit::Save {
            profile_id: profile, name: name.into(),
            connection: AiConnection { endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic".into(), credential_env: String::new(),
                credential_reference: Some(action_id), token_field: "max_tokens".into(), chatgpt_account: None },
        },
    }
}
#[test]
fn immutable_keys_use_original_connection_cas_without_secret_receipts_or_replay() {
    let temp = tempfile::tempdir().unwrap();
    let store = ModelConnectionStore::at(temp.path().join("connections")).unwrap();
    let memory = MemoryStorage::default(); let owner = ApiKeys { storage: Box::new(memory.clone()), operations: Mutex::new(()) };
    let profile = ExecutionId::new(); let first = change(&store, profile, "Local fixture");
    assert_eq!(owner.status(first.action_id).unwrap().availability, ApiKeyAvailability::Missing);
    assert!(!temp.path().join("connections").exists());
    let receipt = owner.change(&store, &first, Some("synthetic-first-secret")).unwrap();
    assert!(!serde_json::to_string(&receipt).unwrap().contains("synthetic-first-secret"));
    let old_reference = store.snapshot().unwrap().reference(profile).unwrap();
    let replacement = change(&store, profile, "Local fixture");
    owner.change(&store, &replacement, Some("synthetic-replacement-secret")).unwrap();
    let references = store.credential_references(profile).unwrap();
    assert_eq!(references.len(), 2);
    assert!(references.contains(&first.action_id) && references.contains(&replacement.action_id));
    assert!(store.credential_references(ExecutionId::new()).unwrap().is_empty());
    assert!(store.resolve(&old_reference).is_err());
    assert_eq!(owner.api_key(first.action_id).unwrap(), "synthetic-first-secret");
    assert_eq!(owner.api_key(replacement.action_id).unwrap(), "synthetic-replacement-secret");
    owner.storage.delete(first.action_id).unwrap();
    assert_eq!(owner.change(&store, &first, Some("must-not-restore-an-old-secret")).unwrap(), receipt);
    assert_eq!(owner.status(first.action_id).unwrap().availability, ApiKeyAvailability::Missing);
    assert_eq!(owner.status(replacement.action_id).unwrap().availability, ApiKeyAvailability::Available);
    assert!(!String::from_utf8_lossy(&std::fs::read(temp.path().join("connections/model-connections.sqlite3")).unwrap()).contains("synthetic-first-secret"));
}
#[test]
fn invalid_stale_and_locked_writes_preserve_non_secret_configuration_and_other_keys() {
    let temp = tempfile::tempdir().unwrap();
    let store = ModelConnectionStore::at(temp.path().join("connections")).unwrap();
    let memory = MemoryStorage::default(); let owner = ApiKeys { storage: Box::new(memory.clone()), operations: Mutex::new(()) };
    let profile = ExecutionId::new();
    let mut invalid = change(&store, profile, "");
    assert!(owner.change(&store, &invalid, Some("synthetic-secret")).is_err());
    assert!(memory.keys.lock().unwrap().is_empty());
    invalid = change(&store, profile, "Synthetic");
    memory.failed.store(true, Ordering::Release);
    assert_eq!(owner.change(&store, &invalid, Some("synthetic-secret")).unwrap_err().stage, "api-key-secure-storage");
    assert_eq!(store.snapshot().unwrap().revision.get(), 0);
    assert!(owner.status(invalid.action_id).is_err());
    memory.failed.store(false, Ordering::Release);
    let first = change(&store, profile, "Synthetic");
    owner.change(&store, &first, Some("synthetic-secret")).unwrap();
    assert!(owner.change(&store, &invalid, Some("different-secret")).is_err());
    assert!(memory.keys.lock().unwrap().get(&invalid.action_id).is_none());
    let resumed = change(&store, profile, "Synthetic");
    assert!(owner.change(&store, &resumed, None).is_err());
    owner.storage.create(resumed.action_id, "synthetic-staged").unwrap();
    owner.change(&store, &resumed, None).unwrap();
    memory.failed.store(true, Ordering::Release);
    assert!(owner.storage.delete(first.action_id).is_err());
    memory.failed.store(false, Ordering::Release);
    assert_eq!(owner.api_key(first.action_id).unwrap(), "synthetic-secret");
}
#[test]
fn secure_input_bounds_and_source_binding_are_checked_before_storage() {
    let temp = tempfile::tempdir().unwrap(); let store = ModelConnectionStore::at(temp.path().join("connections")).unwrap();
    let memory = MemoryStorage::default(); let owner = ApiKeys { storage: Box::new(memory.clone()), operations: Mutex::new(()) };
    for value in [String::new(), " padded".into(), "line\nfeed".into(), "x".repeat(MAX_KEY_BYTES + 1)] {
        assert!(owner.change(&store, &change(&store, ExecutionId::new(), "Synthetic"), Some(&value)).is_err());
    }
    let mut wrong = change(&store, ExecutionId::new(), "Synthetic");
    if let ModelConnectionEdit::Save { connection, .. } = &mut wrong.edit { connection.credential_reference = Some(ExecutionId::new()); }
    assert!(owner.change(&store, &wrong, Some("synthetic")).is_err());
    assert!(memory.keys.lock().unwrap().is_empty());
    assert!(!temp.path().join("connections").exists());
}

#[test]
fn absent_key_change_can_be_discarded_but_a_committed_original_is_not_erased() {
    let temp = tempfile::tempdir().unwrap(); let store = ModelConnectionStore::at(temp.path().join("connections")).unwrap();
    let memory = MemoryStorage::default(); let owner = ApiKeys { storage: Box::new(memory.clone()), operations: Mutex::new(()) };
    let request = change(&store, ExecutionId::new(), "Synthetic");
    owner.storage.create(request.action_id, "synthetic-staged").unwrap();
    assert!(owner.discard_absent(&store, &request).unwrap().is_none());
    assert_eq!(owner.status(request.action_id).unwrap().availability, ApiKeyAvailability::Missing);
    assert!(!temp.path().join("connections").exists());
    let receipt = owner.change(&store, &request, Some("synthetic-saved")).unwrap();
    assert_eq!(owner.discard_absent(&store, &request).unwrap(), Some(receipt));
    assert_eq!(owner.api_key(request.action_id).unwrap(), "synthetic-saved");
    let absent = change(&store, ExecutionId::new(), "Not committed");
    owner.storage.create(absent.action_id, "synthetic-staged").unwrap();
    let later = change(&store, ExecutionId::new(), "Later connection");
    owner.change(&store, &later, Some("synthetic-other-key")).unwrap();
    assert!(owner.discard_absent(&store, &absent).unwrap().is_none());
    assert_eq!(owner.status(absent.action_id).unwrap().availability, ApiKeyAvailability::Missing);
    assert_eq!(owner.api_key(later.action_id).unwrap(), "synthetic-other-key");
    let mut forged = change(&store, ExecutionId::new(), "Other");
    if let ModelConnectionEdit::Save { connection, .. } = &mut forged.edit { connection.credential_reference = Some(request.action_id); }
    assert!(owner.discard_absent(&store, &forged).is_err());
    assert_eq!(owner.api_key(request.action_id).unwrap(), "synthetic-saved");
}

#[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
#[test]
#[ignore = "writes one synthetic key to the system credential store, then removes exactly that reference"]
fn native_system_credential_round_trip_reopens_and_removes_only_the_test_reference() {
    struct Cleanup { directory: std::path::PathBuf, reference: ExecutionId }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let storage = storage::SystemStorage::new(&self.directory);
            if storage.delete(self.reference).is_err() { eprintln!("synthetic API-key cleanup could not be confirmed"); }
        }
    }
    let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("application");
    let reference = ExecutionId::new(); let _cleanup = Cleanup { directory: directory.clone(), reference };
    let owner = ApiKeys::new(&directory);
    owner.storage.create(reference, "synthetic-native-key-for-local-test-only").unwrap();
    assert_eq!(owner.api_key(reference).unwrap(), "synthetic-native-key-for-local-test-only");
    assert!(owner.storage.create(reference, "cannot-replace-an-immutable-reference").is_err());
    drop(owner);
    let reopened = ApiKeys::new(&directory);
    assert_eq!(reopened.status(reference).unwrap().availability, ApiKeyAvailability::Available);
    reopened.storage.delete(reference).unwrap();
    assert_eq!(reopened.status(reference).unwrap().availability, ApiKeyAvailability::Missing);
    assert!(reopened.api_key(reference).is_err());
}
#[cfg(any(target_os = "macos", all(windows, target_arch = "x86_64")))]
#[test]
fn missing_system_credential_identity_status_creates_no_files() {
    let temp = tempfile::tempdir().unwrap(); let root = temp.path().join("application");
    let owner = ApiKeys::new(&root);
    assert_eq!(owner.status(ExecutionId::new()).unwrap().availability, ApiKeyAvailability::Missing);
    assert!(!root.exists());
}

#[cfg(all(windows, target_arch = "x86_64"))]
#[test]
fn windows_credential_size_is_checked_before_identity_creation() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("application");
    let owner = ApiKeys::new(&directory);
    let settings = temp.path().join("connections");
    let store = ModelConnectionStore::at(settings.clone()).unwrap();

    for oversized_key in ["键".repeat(854), "x".repeat(MAX_KEY_BYTES + 1)] {
        let request = change(&store, ExecutionId::new(), "Synthetic");
        let error = owner
            .change(&store, &request, Some(&oversized_key))
            .unwrap_err();
        assert_eq!(error.stage, "api-key-windows-limit");
    }
    assert!(!directory.exists());
    assert!(!settings.exists());
}
