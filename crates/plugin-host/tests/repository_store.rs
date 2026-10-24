#![cfg(any(target_os = "macos", target_os = "linux"))]

use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tsumugi_plugin_host::{
    InstallError, PackageStore, RepositoryRefreshRequest,
    repository::{CapturedOfflineRepository, RepositoryError},
    repository_source_id,
};

#[path = "support/offline_repository.rs"]
mod offline_repository;
use offline_repository::{EXPIRED, FUTURE, Fixture};

const FIRST: &str = "00000000-0000-4000-8000-000000000101";
const SECOND: &str = "00000000-0000-4000-8000-000000000102";
const THIRD: &str = "00000000-0000-4000-8000-000000000103";
const FOURTH: &str = "00000000-0000-4000-8000-000000000104";

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
}

fn request(
    fixture: &Fixture,
    captured: &CapturedOfflineRepository,
    revision: u64,
    action: &str,
) -> RepositoryRefreshRequest {
    RepositoryRefreshRequest {
        source_id: repository_source_id(&fixture.anchor).unwrap(),
        expected_revision: revision,
        action_id: action.into(),
        initial_root: fixture.anchor.clone(),
        capture_digest: captured.capture_digest().into(),
    }
}

fn state_path(root: &Path, source: &str, action: &str) -> PathBuf {
    root.join("repositories")
        .join(source.strip_prefix("tuf:").unwrap())
        .join(action)
        .join("state.json")
}

fn state(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn cache(path: &Path, key: &str) -> Vec<u8> {
    serde_json::from_value(state(path)["cache"][key].clone()).unwrap()
}

fn version(path: &Path, key: &str) -> u64 {
    serde_json::from_slice::<Value>(&cache(path, key)).unwrap()["signed"]["version"]
        .as_u64()
        .unwrap()
}

fn revoke_after_root(
    path: PathBuf,
    expected: u64,
) -> (Arc<AtomicBool>, impl Fn() -> bool + Send + Sync + 'static) {
    let revoked = Arc::new(AtomicBool::new(false));
    let guard_state = revoked.clone();
    let guard = move || {
        if guard_state.load(Ordering::Acquire) {
            return false;
        }
        let version = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|state| serde_json::from_value::<Vec<u8>>(state["latestRoot"].clone()).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|root| root["signed"]["version"].as_u64());
        if version == Some(expected) {
            guard_state.store(true, Ordering::Release);
            return false;
        }
        true
    };
    (revoked, guard)
}

#[test]
fn interrupted_role_key_rollover_replays_its_original_invalidation_context() {
    let mut fixture = runtime().block_on(Fixture::new(false));
    runtime().block_on(fixture.publish(
        (100, 100, 100),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let initial = fixture.capture();
    let first = request(&fixture, &initial, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store.refresh_repository(&first, &initial, || true).unwrap();
    runtime().block_on(fixture.rotate_retaining_role_keys(FUTURE));
    runtime().block_on(fixture.publish(
        (1, 1, 1),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let captured = fixture.capture();
    let second = request(&fixture, &captured, 1, SECOND);
    let path = state_path(&root, &first.source_id, SECOND);
    let (revoked, guard) = revoke_after_root(path.clone(), 2);
    assert_eq!(
        store
            .refresh_repository(&second, &captured, guard)
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    assert!(revoked.load(Ordering::Acquire));
    assert_eq!(version(&path, "root.json"), 2);
    assert_eq!(version(&path, "root_rotation_context.json"), 1);
    assert_eq!(version(&path, "timestamp.json"), 100);
    assert_eq!(version(&path, "snapshot.json"), 100);
    // Without the continuation the old high cache would still authenticate
    // under Root2, making the lost invalidation observable as MetadataRollback.
    let new_root: tough::schema::Signed<tough::schema::Root> =
        serde_json::from_slice(&cache(&path, "root.json")).unwrap();
    let old_timestamp: tough::schema::Signed<tough::schema::Timestamp> =
        serde_json::from_slice(&cache(&path, "timestamp.json")).unwrap();
    new_root.signed.verify_role(&old_timestamp).unwrap();
    drop(store);
    fs::remove_dir_all(&fixture.directory).unwrap();
    let mut store = PackageStore::open_existing(&root).unwrap();
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_some()
    );
    let verified = store
        .resume_repository(&first.source_id, 1, SECOND, || true)
        .unwrap();
    assert_eq!(verified.metadata().root_version, 2);
    assert_eq!(verified.metadata().timestamp_version, 1);
    assert_eq!(verified.metadata().snapshot_version, 1);
    assert_eq!(version(&path, "targets.json"), 1);
    assert!(
        state(&path)["cache"]
            .get("root_rotation_context.json")
            .is_none()
    );
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_none()
    );
}

#[test]
fn interrupted_same_key_root_increment_retains_role_rollback_watermarks() {
    let mut fixture = runtime().block_on(Fixture::new(false));
    runtime().block_on(fixture.publish(
        (100, 100, 100),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let initial = fixture.capture();
    let first = request(&fixture, &initial, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store.refresh_repository(&first, &initial, || true).unwrap();
    runtime().block_on(fixture.advance_root_same_keys(FUTURE));
    runtime().block_on(fixture.publish(
        (1, 1, 1),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let captured = fixture.capture();
    let second = request(&fixture, &captured, 1, SECOND);
    let path = state_path(&root, &first.source_id, SECOND);
    let (revoked, guard) = revoke_after_root(path.clone(), 2);
    assert_eq!(
        store
            .refresh_repository(&second, &captured, guard)
            .unwrap_err(),
        InstallError::UnknownCommit
    );
    assert!(revoked.load(Ordering::Acquire));
    assert_eq!(version(&path, "root_rotation_context.json"), 1);
    drop(store);
    let mut store = PackageStore::open_existing(&root).unwrap();
    assert_eq!(
        store
            .resume_repository(&first.source_id, 1, SECOND, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::MetadataRollback)
    );
    assert_eq!(version(&path, "root.json"), 2);
    assert_eq!(version(&path, "timestamp.json"), 100);
    assert_eq!(version(&path, "snapshot.json"), 100);
    assert!(
        state(&path)["cache"]
            .get("root_rotation_context.json")
            .is_none()
    );
    let record = store.repository_sources(|| true).unwrap().remove(0);
    assert!(record.pending.is_none());
    assert_eq!(record.last_error, Some(RepositoryError::MetadataRollback));
    runtime().block_on(fixture.publish(
        (101, 101, 101),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let next = fixture.capture();
    let third = request(&fixture, &next, 2, THIRD);
    store.refresh_repository(&third, &next, || true).unwrap();
    assert_eq!(
        store.repository_sources(|| true).unwrap()[0].latest_root_version,
        2
    );
}

#[test]
fn rejected_expired_root_keeps_invalidation_context_for_the_next_action() {
    let mut fixture = runtime().block_on(Fixture::new(false));
    runtime().block_on(fixture.publish(
        (100, 100, 100),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let initial = fixture.capture();
    let first = request(&fixture, &initial, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store.refresh_repository(&first, &initial, || true).unwrap();
    runtime().block_on(fixture.rotate_retaining_role_keys(EXPIRED));
    runtime().block_on(fixture.publish(
        (1, 1, 1),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let expired = fixture.capture();
    let second = request(&fixture, &expired, 1, SECOND);
    assert_eq!(
        store
            .refresh_repository(&second, &expired, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::ExpiredMetadata)
    );
    let failed = state_path(&root, &first.source_id, SECOND);
    assert_eq!(version(&failed, "root.json"), 2);
    assert_eq!(version(&failed, "root_rotation_context.json"), 1);
    assert_eq!(version(&failed, "timestamp.json"), 100);
    drop(store);
    let mut store = PackageStore::open_existing(&root).unwrap();
    assert_eq!(
        store
            .resume_repository(&first.source_id, 1, SECOND, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::ExpiredMetadata)
    );
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_none()
    );
    runtime().block_on(fixture.advance_root_same_keys(FUTURE));
    let next = fixture.capture();
    let third = request(&fixture, &next, 2, THIRD);
    let verified = store.refresh_repository(&third, &next, || true).unwrap();
    assert_eq!(verified.metadata().root_version, 3);
    assert_eq!(verified.metadata().timestamp_version, 1);
    assert_eq!(verified.metadata().snapshot_version, 1);
    let succeeded = state_path(&root, &first.source_id, THIRD);
    assert_eq!(version(&succeeded, "root.json"), 3);
    assert!(
        state(&succeeded)["cache"]
            .get("root_rotation_context.json")
            .is_none()
    );
}

#[test]
fn source_identity_is_canonical_and_observation_never_enrolls() {
    let fixture = runtime().block_on(Fixture::new(false));
    let value: Value = serde_json::from_slice(&fixture.anchor).unwrap();
    let formatted = serde_json::to_vec_pretty(&value).unwrap();
    assert_eq!(
        repository_source_id(&fixture.anchor).unwrap(),
        repository_source_id(&formatted).unwrap()
    );
    let unrelated = runtime().block_on(Fixture::new(false));
    assert_ne!(
        repository_source_id(&fixture.anchor).unwrap(),
        repository_source_id(&unrelated.anchor).unwrap()
    );
    let temporary = tempfile::tempdir().unwrap();
    let store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    assert!(store.repository_sources(|| true).unwrap().is_empty());
    assert!(!temporary.path().join("store/repositories").exists());
    assert!(!temporary.path().join("store/settings.json").exists());
}

#[test]
fn exact_action_reopens_from_frozen_bytes_and_never_changes_plugin_settings() {
    let fixture = runtime().block_on(Fixture::new(false));
    let captured = fixture.capture();
    let first = request(&fixture, &captured, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    let verified = store
        .refresh_repository(&first, &captured, || true)
        .unwrap();
    assert_eq!(verified.source_id(), first.source_id);
    let records = store.repository_sources(|| true).unwrap();
    assert_eq!(records[0].revision, 1);
    assert_eq!(
        records[0].display_name.as_deref(),
        Some("Offline repository")
    );
    assert!(records[0].pending.is_none());
    let before = fs::read(state_path(&root, &first.source_id, FIRST)).unwrap();
    let mut changed = first.clone();
    changed.initial_root =
        serde_json::to_vec_pretty(&serde_json::from_slice::<Value>(&first.initial_root).unwrap())
            .unwrap();
    assert_eq!(
        store
            .refresh_repository(&changed, &captured, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    changed = first.clone();
    changed.expected_revision = 1;
    assert_eq!(
        store
            .refresh_repository(&changed, &captured, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    runtime().block_on(fixture.publish(
        (2, 2, 2),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let changed_capture = fixture.capture();
    changed = request(&fixture, &changed_capture, 0, FIRST);
    assert_eq!(
        store
            .refresh_repository(&changed, &changed_capture, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
    assert_eq!(
        fs::read(state_path(&root, &first.source_id, FIRST)).unwrap(),
        before
    );
    assert!(!root.join("settings.json").exists());
    assert_eq!(fs::read_dir(root.join("objects")).unwrap().count(), 0);
    drop(store);
    fs::remove_dir_all(&fixture.directory).unwrap();
    let mut store = PackageStore::open_existing(&root).unwrap();
    let pending = store.repository_sources(|| true).unwrap()[0]
        .pending
        .clone()
        .unwrap();
    assert_eq!(pending.action_id, FIRST);
    assert_eq!(pending.expected_revision, 0);
    assert_eq!(pending.capture_digest, captured.capture_digest());
    let next = RepositoryRefreshRequest {
        action_id: SECOND.into(),
        expected_revision: 1,
        ..first.clone()
    };
    assert_eq!(
        store
            .refresh_repository(&next, &captured, || true)
            .unwrap_err(),
        InstallError::RecoveryRequired
    );
    assert_eq!(
        store
            .resume_repository(&first.source_id, 0, FIRST, || true)
            .unwrap()
            .capture_digest(),
        captured.capture_digest()
    );
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_none()
    );
    assert_eq!(
        store
            .resume_repository(&first.source_id, 1, FIRST, || true)
            .unwrap_err(),
        InstallError::RevisionConflict
    );
    assert!(!root.join("settings.json").exists());
}

#[test]
fn rejected_action_retains_new_metadata_and_can_be_confirmed_then_replaced() {
    let fixture = runtime().block_on(Fixture::new(false));
    let captured = fixture.capture();
    let first = request(&fixture, &captured, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store
        .refresh_repository(&first, &captured, || true)
        .unwrap();
    let mut invalid = serde_json::to_value(&fixture.catalog).unwrap();
    invalid["displayName"] = json!("Untrusted candidate name");
    invalid["unexpected"] = json!(true);
    runtime().block_on(fixture.publish((2, 2, 2), FUTURE, invalid));
    let rejected = fixture.capture();
    let second = request(&fixture, &rejected, 1, SECOND);
    assert_eq!(
        store
            .refresh_repository(&second, &rejected, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::InvalidCatalog)
    );
    let path = state_path(&root, &first.source_id, SECOND);
    assert_eq!(version(&path, "targets.json"), 2);
    assert_eq!(
        store.repository_sources(|| true).unwrap()[0]
            .display_name
            .as_deref(),
        Some("Offline repository")
    );
    drop(store);
    let mut store = PackageStore::open_existing(&root).unwrap();
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_some()
    );
    assert_eq!(
        store
            .resume_repository(&first.source_id, 1, SECOND, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::InvalidCatalog)
    );
    let record = store.repository_sources(|| true).unwrap().remove(0);
    assert!(record.pending.is_none());
    assert_eq!(record.last_error, Some(RepositoryError::InvalidCatalog));
    runtime().block_on(fixture.publish(
        (3, 3, 3),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let next = fixture.capture();
    let third = request(&fixture, &next, 2, THIRD);
    store.refresh_repository(&third, &next, || true).unwrap();
    assert_eq!(store.repository_sources(|| true).unwrap()[0].revision, 3);
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .last_error
            .is_none()
    );
    assert_eq!(
        store
            .resume_repository(&first.source_id, 0, FIRST, || true)
            .unwrap_err(),
        InstallError::ActionConflict
    );
}

#[test]
fn rotated_root_survives_later_rejection_and_older_repository_is_refused() {
    let mut fixture = runtime().block_on(Fixture::new(false));
    let original = fixture.capture();
    let first = request(&fixture, &original, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store
        .refresh_repository(&first, &original, || true)
        .unwrap();
    runtime().block_on(fixture.rotate(true));
    runtime().block_on(fixture.publish(
        (2, 2, 2),
        EXPIRED,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let rotated = fixture.capture();
    let second = request(&fixture, &rotated, 1, SECOND);
    assert_eq!(
        store
            .refresh_repository(&second, &rotated, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::ExpiredMetadata)
    );
    let path = state_path(&root, &first.source_id, SECOND);
    let latest: Vec<u8> = serde_json::from_value(state(&path)["latestRoot"].clone()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&latest).unwrap()["signed"]["version"],
        2
    );
    assert_eq!(
        store.repository_sources(|| true).unwrap()[0].latest_root_version,
        2
    );
    let third = request(&fixture, &original, 2, THIRD);
    assert_eq!(
        store
            .refresh_repository(&third, &original, || true)
            .unwrap_err(),
        InstallError::Repository(RepositoryError::TrustedRootMismatch)
    );
    assert_eq!(
        store.repository_sources(|| true).unwrap()[0].latest_root_version,
        2
    );
    runtime().block_on(fixture.publish(
        (2, 2, 2),
        FUTURE,
        serde_json::to_value(&fixture.catalog).unwrap(),
    ));
    let valid = fixture.capture();
    let fourth = request(&fixture, &valid, 3, FOURTH);
    let fourth_path = state_path(&root, &first.source_id, FOURTH);
    let watched = fourth_path.clone();
    let revoked = Arc::new(AtomicBool::new(false));
    let guard_state = revoked.clone();
    let result = store.refresh_repository(&fourth, &valid, move || {
        if guard_state.load(Ordering::Acquire) {
            return false;
        }
        let removed_root = fs::read(&watched)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|value| value["cache"].get("root.json").is_none());
        if removed_root {
            guard_state.store(true, Ordering::Release);
            return false;
        }
        true
    });
    assert!(revoked.load(Ordering::Acquire));
    assert_eq!(result.unwrap_err(), InstallError::UnknownCommit);
    assert!(state(&fourth_path)["cache"].get("root.json").is_none());
    let retained: Vec<u8> =
        serde_json::from_value(state(&fourth_path)["latestRoot"].clone()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&retained).unwrap()["signed"]["version"],
        2
    );
    drop(store);
    fs::remove_dir_all(&fixture.directory).unwrap();
    let mut store = PackageStore::open_existing(&root).unwrap();
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_some()
    );
    assert_eq!(
        store
            .resume_repository(&first.source_id, 3, FOURTH, || true)
            .unwrap()
            .metadata()
            .root_version,
        2
    );
}

#[test]
fn completed_resume_persists_new_time_and_unknown_keeps_original_action_pending() {
    let fixture = runtime().block_on(Fixture::new(false));
    let captured = fixture.capture();
    let first = request(&fixture, &captured, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store
        .refresh_repository(&first, &captured, || true)
        .unwrap();
    let path = state_path(&root, &first.source_id, FIRST);
    let old_time = cache(&path, "latest_known_time.json");
    let old_sample: jiff::Timestamp = serde_json::from_slice(&old_time).unwrap();
    store
        .resume_repository(&first.source_id, 0, FIRST, || true)
        .unwrap();
    let sample: jiff::Timestamp =
        serde_json::from_slice(&cache(&path, "latest_known_time.json")).unwrap();
    assert!(sample > old_sample);
    let before_unknown = cache(&path, "latest_known_time.json");
    let trigger_path = path.clone();
    let revoked = Arc::new(AtomicBool::new(false));
    let guard_state = revoked.clone();
    let result = store.resume_repository(&first.source_id, 0, FIRST, move || {
        if guard_state.load(Ordering::Acquire) {
            return false;
        }
        let current = fs::read(&trigger_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                serde_json::from_value::<Vec<u8>>(value["cache"]["latest_known_time.json"].clone())
                    .ok()
            });
        if current
            .as_ref()
            .is_some_and(|bytes| bytes != &before_unknown)
        {
            guard_state.store(true, Ordering::Release);
            return false;
        }
        true
    });
    assert!(revoked.load(Ordering::Acquire));
    assert_eq!(result.unwrap_err(), InstallError::UnknownCommit);
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_some()
    );
    assert_eq!(state(&path)["complete"], true);
    assert!(state(&path)["error"].is_null());
    let new_request = RepositoryRefreshRequest {
        expected_revision: 1,
        action_id: SECOND.into(),
        ..first.clone()
    };
    assert_eq!(
        store
            .refresh_repository(&new_request, &captured, || true)
            .unwrap_err(),
        InstallError::RecoveryRequired
    );
    let learned = cache(&path, "latest_known_time.json");
    drop(store);
    fs::remove_dir_all(&fixture.directory).unwrap();
    let mut store = PackageStore::open_existing(&root).unwrap();
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_some()
    );
    store
        .resume_repository(&first.source_id, 0, FIRST, || true)
        .unwrap();
    let restored: jiff::Timestamp =
        serde_json::from_slice(&cache(&path, "latest_known_time.json")).unwrap();
    assert!(restored >= serde_json::from_slice::<jiff::Timestamp>(&learned).unwrap());
    assert!(
        store.repository_sources(|| true).unwrap()[0]
            .pending
            .is_none()
    );
}

#[test]
fn corrupted_time_and_linked_namespace_are_errors_without_cache_reset() {
    let fixture = runtime().block_on(Fixture::new(false));
    let captured = fixture.capture();
    let first = request(&fixture, &captured, 0, FIRST);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    store
        .refresh_repository(&first, &captured, || true)
        .unwrap();
    let path = state_path(&root, &first.source_id, FIRST);
    let mut corrupted = state(&path);
    corrupted["cache"]["latest_known_time.json"] =
        serde_json::to_value(b"not a timestamp".to_vec()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, serde_json::to_vec(&corrupted).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        store.repository_sources(|| true).unwrap_err(),
        InstallError::CorruptStore
    );
    assert_eq!(
        store
            .resume_repository(&first.source_id, 0, FIRST, || true)
            .unwrap_err(),
        InstallError::CorruptStore
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(store);
    let isolated = tempfile::tempdir().unwrap();
    let isolated_store = PackageStore::provision(isolated.path(), &["store"], || true).unwrap();
    symlink(
        root.join("repositories"),
        isolated.path().join("store/repositories"),
    )
    .unwrap();
    assert_eq!(
        isolated_store.repository_sources(|| true).unwrap_err(),
        InstallError::CorruptStore
    );
}
