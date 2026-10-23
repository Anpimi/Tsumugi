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

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewedArtifactSelection {
    format_version: u32,
    reviewed: bool,
    packages: Vec<ReviewedArtifact>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewedArtifact {
    archive: std::path::PathBuf,
    archive_sha256: String,
    plugin: tsumugi_plugin_sdk::PluginIdentity,
    package_digest: String,
    source_repository: String,
    source_commit: String,
    sdk_artifact: Value,
}

// Test-only review admission. Every input is checked before the existing
// fixture can create its ephemeral key or sign any metadata. Source fields are
// reviewed declarations, not independently authenticated build provenance.
async fn sign_reviewed_artifacts(
    selection: &ReviewedArtifactSelection,
    signing_started: &AtomicUsize,
) -> Result<Vec<Fixture>, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    use tsumugi_plugin_host::{PackageImage, repository::RepositoryPackageDeclaration};

    if selection.format_version != 1 || !selection.reviewed || selection.packages.is_empty() {
        return Err("an explicit nonempty reviewed selection is required".into());
    }
    let mut prepared = Vec::new();
    for reviewed in &selection.packages {
        if !reviewed.source_repository.starts_with("https://")
            || reviewed.source_commit.len() != 40
            || !reviewed
                .source_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("complete reviewed source declarations are required".into());
        }
        let bytes = fs::read(&reviewed.archive).map_err(|error| error.to_string())?;
        if format!("{:x}", Sha256::digest(&bytes)) != reviewed.archive_sha256 {
            return Err("reviewed transport digest mismatch".into());
        }
        let image = PackageImage::capture_archive(&bytes, &reviewed.package_digest, || true)
            .map_err(|error| format!("reviewed package rejected: {error:?}"))?;
        let inspection = image.inspection();
        if inspection.plugin != reviewed.plugin {
            return Err("reviewed plugin identity mismatch".into());
        }
        // Re-encode only the Host-admitted immutable image. The tar library
        // materializes this image later; it does not admit an arbitrary archive.
        let encoded = image.encode_archive(|| true).unwrap();
        let mut sdk_lock = None;
        for entry in tar::Archive::new(encoded.as_slice()).entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().as_ref() == std::path::Path::new("sdk/lock.json") {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                sdk_lock = Some(serde_json::from_slice::<Value>(&bytes).unwrap());
            }
        }
        if sdk_lock.as_ref() != Some(&reviewed.sdk_artifact) {
            return Err("reviewed SDK artifact mismatch".into());
        }
        prepared.push((inspection, encoded));
    }

    let mut signed = Vec::new();
    for (inspection, encoded) in prepared {
        signing_started.fetch_add(1, Ordering::AcqRel);
        signed.push(
            Fixture::new_with_package(false, move |repository| {
                let directory = repository.join("packages/reviewed");
                fs::create_dir_all(&directory).unwrap();
                tar::Archive::new(encoded.as_slice())
                    .unpack(&directory)
                    .unwrap();
                assert_eq!(
                    PackageImage::capture_directory(&directory, &inspection.package_digest, || {
                        true
                    })
                    .unwrap()
                    .inspection(),
                    inspection
                );
                RepositoryPackageDeclaration {
                    directory: "reviewed".into(),
                    plugin: inspection.plugin,
                    package_digest: inspection.package_digest,
                    publisher_id: "reviewed-fixture-publisher".into(),
                }
            })
            .await,
        );
    }
    Ok(signed)
}

#[tokio::test]
#[ignore = "requires an explicit reviewed selection of already built package archives"]
async fn reviewed_fixed_artifacts_are_signed_and_tampering_is_rejected() {
    let input = std::env::var_os("TSUMUGI_TEST_REVIEWED_ARTIFACTS")
        .expect("set the reviewed selection JSON path explicitly");
    let selection: ReviewedArtifactSelection =
        serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let signing_started = AtomicUsize::new(0);
    for (field, expected) in [
        (
            "review",
            "an explicit nonempty reviewed selection is required",
        ),
        ("transport", "reviewed transport digest mismatch"),
        ("package", "reviewed package rejected: PackageMismatch"),
        ("identity", "reviewed plugin identity mismatch"),
        ("sdk", "reviewed SDK artifact mismatch"),
    ] {
        let mut rejected = selection.clone();
        // Reject the last member before signing even an earlier valid member.
        let package = rejected.packages.last_mut().unwrap();
        match field {
            "review" => rejected.reviewed = false,
            "transport" => package.archive_sha256 = "0".repeat(64),
            "package" => package.package_digest = "0".repeat(64),
            "identity" => package.plugin.version.push_str("-unreviewed"),
            "sdk" => package.sdk_artifact["sha256"] = json!("0".repeat(64)),
            _ => unreachable!(),
        }
        assert_eq!(
            sign_reviewed_artifacts(&rejected, &signing_started)
                .await
                .err()
                .unwrap(),
            expected
        );
        assert_eq!(signing_started.load(Ordering::Acquire), 0, "{field}");
        println!("review mismatch rejected before signing: {field}");
    }

    let fixtures = sign_reviewed_artifacts(&selection, &signing_started)
        .await
        .unwrap();
    assert_eq!(
        signing_started.load(Ordering::Acquire),
        selection.packages.len()
    );
    for (fixture, reviewed) in fixtures.iter().zip(&selection.packages) {
        let verified = fixture
            .capture()
            .verify(
                "reviewed-source",
                &fixture.anchor,
                Arc::new(MemoryStorage::default()),
                || true,
            )
            .await
            .unwrap();
        assert_eq!(verified.packages().len(), 1);
        assert_eq!(verified.packages()[0].plugin(), &reviewed.plugin);
        assert_eq!(
            verified.packages()[0].package_digest(),
            reviewed.package_digest
        );
        assert_eq!(
            verified.packages()[0].image().package_digest(),
            reviewed.package_digest
        );

        let package_file = fixture.directory.join("packages/reviewed/sdk/lock.json");
        let original = fs::read(&package_file).unwrap();
        let mut changed = original.clone();
        changed.push(b' ');
        fs::write(&package_file, changed).unwrap();
        assert_eq!(
            fixture
                .capture()
                .verify(
                    "reviewed-source",
                    &fixture.anchor,
                    Arc::new(MemoryStorage::default()),
                    || true
                )
                .await
                .unwrap_err(),
            RepositoryError::Capture(HostError::PackageMismatch)
        );
        fs::write(&package_file, original).unwrap();
        let metadata_file = fixture.directory.join("metadata/timestamp.json");
        let mut metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_file).unwrap()).unwrap();
        metadata["signed"]["version"] = json!(20);
        fs::write(&metadata_file, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert_eq!(
            fixture
                .capture()
                .verify(
                    "reviewed-source",
                    &fixture.anchor,
                    Arc::new(MemoryStorage::default()),
                    || true
                )
                .await
                .unwrap_err(),
            RepositoryError::SignatureRejected
        );
        println!(
            "{}",
            json!({
                "plugin": reviewed.plugin, "archiveSha256": reviewed.archive_sha256,
                "packageDigest": reviewed.package_digest, "sourceRepository": reviewed.source_repository,
                "declaredSourceCommit": reviewed.source_commit, "sdkArtifact": reviewed.sdk_artifact,
                "signedVerification": "passed", "packageMutationRejected": true,
                "unsignedMetadataMutationRejected": true, "sourceProvenanceIndependentlyVerified": false,
                "publication": "not-run", "key": "ephemeral-memory-only"
            })
        );
    }
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
