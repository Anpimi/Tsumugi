#![cfg(any(target_os = "macos", target_os = "linux"))]

use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::symlink,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tsumugi_plugin_host::{
    HostError,
    repository::{
        CapturedOfflineRepository, CapturedRepositoryRoot, RepositoryError, RepositoryResult,
        RepositoryStorageFuture, RepositoryTrustStorage,
    },
};

#[path = "support/offline_repository.rs"]
mod offline_repository;
use offline_repository::{EXPIRED, FUTURE, Fixture, package};

// This adapter tests the actual TUF callback boundary. It does not simulate or
// claim filesystem durability; the PackageStore suite owns that evidence.
#[derive(Default)]
struct MemoryStorage {
    files: Mutex<BTreeMap<String, Vec<u8>>>,
    fail_write: Mutex<Option<String>>,
    unknown: AtomicBool,
    writes: AtomicUsize,
}

impl MemoryStorage {
    fn bytes(&self, key: &str) -> Option<Vec<u8>> {
        self.files.lock().unwrap().get(key).cloned()
    }
}

impl RepositoryTrustStorage for MemoryStorage {
    fn read<'a>(&'a self, key: &'a str) -> RepositoryStorageFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            self.check_durability()?;
            Ok(self.bytes(key))
        })
    }

    fn write<'a>(&'a self, key: &'a str, bytes: &'a [u8]) -> RepositoryStorageFuture<'a, ()> {
        Box::pin(async move {
            self.check_durability()?;
            self.writes.fetch_add(1, Ordering::AcqRel);
            self.files.lock().unwrap().insert(key.into(), bytes.into());
            if self.fail_write.lock().unwrap().as_deref() == Some(key) {
                self.unknown.store(true, Ordering::Release);
                return Err(RepositoryError::WorkingStateOutcomeUnknown);
            }
            Ok(())
        })
    }

    fn remove<'a>(&'a self, key: &'a str) -> RepositoryStorageFuture<'a, ()> {
        Box::pin(async move {
            self.check_durability()?;
            self.files.lock().unwrap().remove(key);
            Ok(())
        })
    }

    fn check_durability(&self) -> RepositoryResult<()> {
        if self.unknown.load(Ordering::Acquire) {
            Err(RepositoryError::WorkingStateOutcomeUnknown)
        } else {
            Ok(())
        }
    }
}

fn stored_version(storage: &MemoryStorage, key: &str) -> u64 {
    serde_json::from_slice::<Value>(&storage.bytes(key).unwrap()).unwrap()["signed"]["version"]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn rejects_signed_delegations_before_any_working_state_callback() {
    let fixture = Fixture::new(false).await;
    fixture.publish_delegated().await;
    let storage = Arc::new(MemoryStorage::default());
    assert_eq!(
        fixture
            .capture()
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::MetadataRejected
    );
    assert_eq!(storage.writes.load(Ordering::Acquire), 0);
    assert!(storage.files.lock().unwrap().is_empty());
}

#[tokio::test]
async fn authenticates_frozen_bytes_and_maps_independent_source_and_publisher() {
    let fixture = Fixture::new(false).await;
    let captured = fixture.capture();
    let restored = CapturedOfflineRepository::restore_snapshot(
        captured.files().clone(),
        captured.directories().to_vec(),
        captured.capture_digest(),
        || true,
    )
    .unwrap();
    fs::remove_dir_all(&fixture.directory).unwrap();
    let storage = Arc::new(MemoryStorage::default());
    let verified = restored
        .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
        .await
        .unwrap();
    assert_eq!(verified.source_id(), "enrolled-source");
    assert_eq!(verified.packages().len(), 1);
    assert_eq!(verified.packages()[0].origin().source_id, "enrolled-source");
    assert_eq!(
        verified.packages()[0].origin().publisher_id,
        "repo-attested-publisher"
    );
    assert_eq!(
        verified.packages()[0].plugin().publisher,
        "declared-publisher"
    );
    assert_eq!(
        verified.packages()[0].package_digest(),
        fixture.catalog.packages[0].package_digest
    );
    assert_eq!(verified.metadata().timestamp_version, 1);
    assert_eq!(stored_version(&storage, "root.json"), 1);
}

#[tokio::test]
async fn consistent_snapshot_index_can_authenticate_multiple_exact_versions() {
    let mut fixture = Fixture::new(true).await;
    fixture
        .catalog
        .packages
        .push(package(&fixture.directory, "previous", "0.9.0"));
    fixture
        .publish(
            (2, 2, 2),
            FUTURE,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    let verified = fixture
        .capture()
        .verify(
            "enrolled-source",
            &fixture.anchor,
            Arc::new(MemoryStorage::default()),
            || true,
        )
        .await
        .unwrap();
    assert_eq!(verified.packages().len(), 2);
    assert_eq!(verified.packages()[0].plugin().version, "1.0.0");
    assert_eq!(verified.packages()[1].plugin().version, "0.9.0");
}

#[tokio::test]
async fn strict_catalog_is_decoded_only_after_real_target_authentication() {
    let fixture = Fixture::new(false).await;
    let mut catalog = serde_json::to_value(&fixture.catalog).unwrap();
    catalog["sourceId"] = json!("attacker-chosen-source");
    fixture.publish((2, 2, 2), FUTURE, catalog).await;
    let storage = Arc::new(MemoryStorage::default());
    assert_eq!(
        fixture
            .capture()
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::InvalidCatalog
    );
    assert_eq!(stored_version(&storage, "targets.json"), 2);
    fixture
        .publish(
            (3, 3, 3),
            FUTURE,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    let target = fixture.directory.join("targets/catalog.json");
    let mut bytes = fs::read(&target).unwrap();
    bytes[0] = b'[';
    fs::write(target, bytes).unwrap();
    assert_eq!(
        fixture
            .capture()
            .verify(
                "enrolled-source",
                &fixture.anchor,
                Arc::new(MemoryStorage::default()),
                || true
            )
            .await
            .unwrap_err(),
        RepositoryError::MetadataRejected
    );
}

#[tokio::test]
async fn rejects_package_mutation_and_unsigned_metadata_changes() {
    let fixture = Fixture::new(false).await;
    fs::write(
        fixture.directory.join("packages/current/data.bin"),
        b"changed",
    )
    .unwrap();
    assert_eq!(
        fixture
            .capture()
            .verify(
                "enrolled-source",
                &fixture.anchor,
                Arc::new(MemoryStorage::default()),
                || true
            )
            .await
            .unwrap_err(),
        RepositoryError::Capture(HostError::PackageMismatch)
    );
    let path = fixture.directory.join("metadata/timestamp.json");
    let mut timestamp: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    timestamp["signed"]["version"] = json!(20);
    fs::write(path, serde_json::to_vec(&timestamp).unwrap()).unwrap();
    assert_eq!(
        fixture
            .capture()
            .verify(
                "enrolled-source",
                &fixture.anchor,
                Arc::new(MemoryStorage::default()),
                || true
            )
            .await
            .unwrap_err(),
        RepositoryError::SignatureRejected
    );
}

#[tokio::test]
async fn refuses_tofu_and_revoked_live_guard_before_any_trust_write() {
    let fixture = Fixture::new(false).await;
    let unrelated = Fixture::new(false).await;
    let storage = Arc::new(MemoryStorage::default());
    assert_eq!(
        fixture
            .capture()
            .verify(
                "enrolled-source",
                &unrelated.anchor,
                storage.clone(),
                || true
            )
            .await
            .unwrap_err(),
        RepositoryError::TrustedRootMismatch
    );
    assert_eq!(
        fixture
            .capture()
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || {
                false
            })
            .await
            .unwrap_err(),
        RepositoryError::AuthorityRevoked
    );
    assert!(storage.files.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejects_expiry_and_all_metadata_rollback_layers_with_retained_state() {
    let fixture = Fixture::new(false).await;
    let storage = Arc::new(MemoryStorage::default());
    fixture
        .publish(
            (2, 2, 2),
            FUTURE,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    fixture
        .capture()
        .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
        .await
        .unwrap();
    for versions in [(1, 1, 1), (3, 1, 1), (3, 3, 1)] {
        fixture
            .publish(
                versions,
                FUTURE,
                serde_json::to_value(&fixture.catalog).unwrap(),
            )
            .await;
        assert_eq!(
            fixture
                .capture()
                .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
                .await
                .unwrap_err(),
            RepositoryError::MetadataRollback
        );
        assert_eq!(stored_version(&storage, "snapshot.json"), 2);
    }
    // The final attack's valid timestamp was learned before its snapshot was
    // rejected. A failed full refresh must not discard that partial progress.
    assert_eq!(stored_version(&storage, "timestamp.json"), 3);
    fixture
        .publish(
            (4, 4, 4),
            EXPIRED,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    assert_eq!(
        fixture
            .capture()
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::ExpiredMetadata
    );
    assert_eq!(stored_version(&storage, "timestamp.json"), 3);
}

#[tokio::test]
async fn valid_rotation_survives_later_expiry_and_reopens_at_latest_root() {
    let mut fixture = Fixture::new(false).await;
    let storage = Arc::new(MemoryStorage::default());
    fixture
        .capture()
        .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
        .await
        .unwrap();
    fixture.rotate(true).await;
    fixture
        .publish(
            (2, 2, 2),
            EXPIRED,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    assert_eq!(
        fixture
            .capture()
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::ExpiredMetadata
    );
    assert_eq!(stored_version(&storage, "root.json"), 2);
    let latest_root = storage.bytes("root.json").unwrap();
    fixture
        .publish(
            (2, 2, 2),
            FUTURE,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    let verified = fixture
        .capture()
        .verify("enrolled-source", &latest_root, storage, || true)
        .await
        .unwrap();
    assert_eq!(verified.metadata().root_version, 2);
}

#[tokio::test]
async fn refuses_a_root_rotation_without_the_prior_threshold() {
    let mut fixture = Fixture::new(false).await;
    fixture.rotate(false).await;
    fixture
        .publish(
            (2, 2, 2),
            FUTURE,
            serde_json::to_value(&fixture.catalog).unwrap(),
        )
        .await;
    let storage = Arc::new(MemoryStorage::default());
    assert_eq!(
        fixture
            .capture()
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::SignatureRejected
    );
    assert!(storage.bytes("root.json").is_none());
}

#[tokio::test]
async fn unknown_metadata_commit_stays_unknown_without_replaying_a_new_action() {
    let fixture = Fixture::new(false).await;
    let captured = fixture.capture();
    let storage = Arc::new(MemoryStorage::default());
    *storage.fail_write.lock().unwrap() = Some("targets.json".into());
    assert_eq!(
        captured
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::WorkingStateOutcomeUnknown
    );
    let original_writes = storage.writes.load(Ordering::Acquire);
    assert!(original_writes > 0);
    assert_eq!(
        captured
            .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
            .await
            .unwrap_err(),
        RepositoryError::WorkingStateOutcomeUnknown
    );
    assert_eq!(stored_version(&storage, "targets.json"), 1);
    assert_eq!(storage.writes.load(Ordering::Acquire), original_writes);
}

#[tokio::test]
async fn corrupt_or_future_clock_watermarks_are_preserved_and_block_refresh() {
    let fixture = Fixture::new(false).await;
    for (bytes, expected) in [
        (
            b"invalid time".to_vec(),
            RepositoryError::WorkingStateUnavailable,
        ),
        (
            serde_json::to_vec(&"2098-01-01T00:00:00Z").unwrap(),
            RepositoryError::ClockChanged,
        ),
    ] {
        let storage = Arc::new(MemoryStorage::default());
        storage
            .files
            .lock()
            .unwrap()
            .insert("latest_known_time.json".into(), bytes.clone());
        assert_eq!(
            fixture
                .capture()
                .verify("enrolled-source", &fixture.anchor, storage.clone(), || true)
                .await
                .unwrap_err(),
            expected
        );
        assert_eq!(storage.bytes("latest_known_time.json"), Some(bytes));
        assert_eq!(storage.writes.load(Ordering::Acquire), 0);
    }
}

#[tokio::test]
async fn rejects_unclaimed_empty_directories_and_changed_frozen_input() {
    let fixture = Fixture::new(false).await;
    let captured = fixture.capture();
    let mut changed = captured.files().clone();
    changed
        .get_mut("metadata/timestamp.json")
        .unwrap()
        .bytes
        .push(b' ');
    assert_eq!(
        CapturedOfflineRepository::restore_snapshot(
            changed,
            captured.directories().to_vec(),
            captured.capture_digest(),
            || true
        )
        .unwrap_err(),
        RepositoryError::CatalogMismatch
    );
    fs::create_dir_all(fixture.directory.join("packages/unclaimed")).unwrap();
    assert_eq!(
        fixture
            .capture()
            .verify(
                "enrolled-source",
                &fixture.anchor,
                Arc::new(MemoryStorage::default()),
                || true
            )
            .await
            .unwrap_err(),
        RepositoryError::InvalidLayout
    );
}

#[tokio::test]
async fn independent_root_capture_is_bounded_and_rejects_links() {
    let fixture = Fixture::new(false).await;
    let selected = fixture.write_initial_root();
    let captured = CapturedRepositoryRoot::capture_file(&selected, || true).unwrap();
    assert_eq!(captured.bytes(), fixture.anchor);
    assert_eq!(captured.version(), 1);
    assert_eq!(
        CapturedRepositoryRoot::restore_bytes(
            captured.bytes().to_vec(),
            captured.fingerprint(),
            || true
        )
        .unwrap()
        .fingerprint(),
        captured.fingerprint()
    );
    let linked = fixture.directory.join("root-link.json");
    symlink(&selected, &linked).unwrap();
    assert_eq!(
        CapturedRepositoryRoot::capture_file(&linked, || true).unwrap_err(),
        RepositoryError::Capture(HostError::PackagePath)
    );
    let hard_link = fixture.directory.join("root-hard-link.json");
    fs::hard_link(&selected, &hard_link).unwrap();
    assert_eq!(
        CapturedRepositoryRoot::capture_file(&selected, || true).unwrap_err(),
        RepositoryError::Capture(HostError::PackagePath)
    );
    fs::remove_file(hard_link).unwrap();
    fs::write(&selected, vec![b' '; 256 * 1024 + 1]).unwrap();
    assert_eq!(
        CapturedRepositoryRoot::capture_file(&selected, || true).unwrap_err(),
        RepositoryError::LimitExceeded
    );
}
