//! TUF owns all signature, expiry, rotation, and metadata rollback decisions.
//! The application injects its existing Store's durable opaque state boundary.
use super::*;
use std::{
    io,
    sync::{Mutex, atomic::AtomicU64},
};

use futures_util::stream;
use tough::{
    Bytes, ExpirationEnforcement, IntoVec, Limits, MetadataStore, RepositoryLoader, TargetName,
    Transport, TransportError, TransportErrorKind, TransportStream,
};
use url::Url;

const ORIGIN: &str = "https://offline.invalid/";
const METADATA_BASE: &str = "https://offline.invalid/metadata/";
const TARGETS_BASE: &str = "https://offline.invalid/targets/";

impl CapturedOfflineRepository {
    /// Authenticate this frozen source using an independently approved, latest
    /// trusted root and the existing Store's original pending trust action.
    /// No root is enrolled from the selected source, and no filesystem or HTTP
    /// transport is available. Every target byte is verified before it is used.
    ///
    /// The storage owner must retain successful intermediate root/role/time
    /// writes even when this method returns an error. Unknown writes require
    /// reconciliation of the same original action; do not reset state, delete a
    /// candidate, revert the root, or retry with an empty cache. The supplied
    /// root must match the owner's latest trusted root and its captured source
    /// pin; it is not inferred from an installation receipt or directory name.
    ///
    /// Callers use an isolated storage copy for a read-only preview. A real
    /// trust refresh requires the application's mutation authorization, CAS,
    /// original-action durability and subsequent installation decision checks.
    pub async fn verify(
        &self,
        source_id: &str,
        latest_trusted_root: &[u8],
        storage: Arc<dyn RepositoryTrustStorage>,
        authorized: impl Fn() -> bool + Send + Sync + 'static,
    ) -> RepositoryResult<VerifiedOfflineRepository> {
        storage.check_durability()?;
        validate_source(source_id)?;
        let root_version = self.check_trusted_root_pin(latest_trusted_root)?;
        // The upstream loader computes its bounded root-loop limit using u64
        // addition. Reject an anchor that cannot represent that finite limit.
        root_version
            .checked_add(MAX_REPOSITORY_ROOT_UPDATES + 1)
            .ok_or(RepositoryError::LimitExceeded)?;
        let guard = VerificationGuard::new(authorized);
        guard.check()?;
        // This local profile stores only the top-level roles. Reject delegated
        // targets before any trusted metadata callback: a delegation whose name
        // resembles a versioned filename must not reach an unsupported Store
        // key and leave an otherwise deterministic rejection permanently pending.
        for (path, file) in self.files.iter() {
            guard.check()?;
            if path.strip_prefix("metadata/").and_then(metadata_kind) != Some("targets.json") {
                continue;
            }
            let targets: tough::schema::Signed<tough::schema::Targets> =
                serde_json::from_slice(&file.bytes)
                    .map_err(|_| RepositoryError::MetadataRejected)?;
            if targets
                .signed
                .delegations
                .as_ref()
                .is_some_and(|delegations| !delegations.roles.is_empty())
            {
                return Err(RepositoryError::MetadataRejected);
            }
        }
        let local = Arc::new(StoreAdapter {
            storage,
            guard: guard.clone(),
            failed: Mutex::new(None),
        });
        let remote = CapturedTransport {
            files: self.files.clone(),
            guard: guard.clone(),
            root_updates: Arc::new(AtomicU64::new(0)),
            rejected: Arc::new(AtomicU8::new(0)),
        };
        let loaded = RepositoryLoader::new(
            &latest_trusted_root,
            Url::parse(METADATA_BASE).map_err(|_| RepositoryError::InvalidLayout)?,
            Url::parse(TARGETS_BASE).map_err(|_| RepositoryError::InvalidLayout)?,
        )
        .transport(remote.clone())
        .metadata_store(local.clone())
        .limits(Limits {
            max_root_size: MAX_REPOSITORY_ROOT_BYTES as u64,
            max_targets_size: MAX_ROLE_BYTES as u64,
            max_timestamp_size: MAX_ROLE_BYTES as u64,
            max_snapshot_size: MAX_ROLE_BYTES as u64,
            // Include the final missing-root probe. The captured transport
            // independently bounds actual returned root updates to 32.
            max_root_updates: MAX_REPOSITORY_ROOT_UPDATES + 1,
        })
        .expiration_enforcement(ExpirationEnforcement::Safe)
        .load()
        .await;
        // Durable failure has priority over a generic TUF/transport error.
        // In particular, do not report a swallowed root-fetch error as success.
        local.check()?;
        remote.check()?;
        let repository = loaded.map_err(metadata_error)?;
        let name = TargetName::new("catalog.json").map_err(metadata_error)?;
        let description = repository
            .targets()
            .signed
            .targets
            .get(&name)
            .ok_or(RepositoryError::MetadataUnavailable)?;
        if description.length == 0 || description.length > MAX_REPOSITORY_CATALOG_BYTES as u64 {
            return Err(RepositoryError::LimitExceeded);
        }
        let target_result = async {
            repository
                .read_target(&name)
                .await
                .map_err(metadata_error)?
                .ok_or(RepositoryError::MetadataUnavailable)?
                .into_vec()
                .await
                .map_err(metadata_error)
        }
        .await;
        local.check()?;
        remote.check()?;
        let catalog = target_result?;
        if catalog.len() as u64 != description.length {
            return Err(RepositoryError::CatalogMismatch);
        }
        let earliest_expiration = [
            repository.root().signed.expires,
            repository.timestamp().signed.expires,
            repository.snapshot().signed.expires,
            repository.targets().signed.expires,
        ]
        .into_iter()
        .min()
        .ok_or(RepositoryError::MetadataRejected)?;
        let metadata = VerifiedRepositoryMetadata {
            root_version: repository.root().signed.version.get(),
            timestamp_version: repository.timestamp().signed.version.get(),
            snapshot_version: repository.snapshot().signed.version.get(),
            targets_version: repository.targets().signed.version.get(),
            earliest_expiration_unix_milliseconds: earliest_expiration.as_millisecond(),
        };
        let verified = self.authenticated_catalog(source_id, catalog, metadata, &guard)?;
        local.check()?;
        remote.check()?;
        // Package capture/hashing may finish after the target read. This is an
        // additional admission check; it never relaxes TUF's own fixed-start
        // expiry or persistent latest-known-time checks.
        if jiff::Timestamp::now() >= earliest_expiration {
            return Err(RepositoryError::ExpiredMetadata);
        }
        Ok(verified)
    }
}

struct StoreAdapter {
    storage: Arc<dyn RepositoryTrustStorage>,
    guard: VerificationGuard,
    failed: Mutex<Option<RepositoryError>>,
}

impl fmt::Debug for StoreAdapter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RepositoryStoreAdapter")
            .finish_non_exhaustive()
    }
}

impl StoreAdapter {
    fn check(&self) -> RepositoryResult<()> {
        self.storage.check_durability()?;
        if let Some(error) = *self
            .failed
            .lock()
            .map_err(|_| RepositoryError::WorkingStateUnavailable)?
        {
            return Err(error);
        }
        self.guard.check()
    }

    fn remember<T>(&self, result: RepositoryResult<T>) -> io::Result<T> {
        result.map_err(|error| {
            if let Ok(mut failed) = self.failed.lock() {
                if failed.is_none() || error == RepositoryError::WorkingStateOutcomeUnknown {
                    *failed = Some(error);
                }
            }
            io::Error::other("repository update state unavailable")
        })
    }
}

#[tough::async_trait]
impl MetadataStore for StoreAdapter {
    async fn read(&self, key: &str) -> io::Result<Option<Vec<u8>>> {
        self.check().map_err(storage_io)?;
        let bytes = self.remember(self.storage.read(key).await)?;
        // Upstream ignores an invalid serialized latest-known time. Preserve a
        // corrupt application's existing watermark as a blocking state instead.
        if key == "latest_known_time.json"
            && bytes
                .as_ref()
                .is_some_and(|bytes| serde_json::from_slice::<jiff::Timestamp>(bytes).is_err())
        {
            return self.remember(Err(RepositoryError::WorkingStateUnavailable));
        }
        self.check().map_err(storage_io)?;
        Ok(bytes)
    }

    async fn write(&self, key: &str, bytes: &[u8]) -> io::Result<()> {
        self.check().map_err(storage_io)?;
        self.remember(self.storage.write(key, bytes).await)?;
        self.check().map_err(storage_io)
    }

    async fn remove(&self, key: &str) -> io::Result<()> {
        self.check().map_err(storage_io)?;
        self.remember(self.storage.remove(key).await)?;
        self.check().map_err(storage_io)
    }
}

fn storage_io(_: RepositoryError) -> io::Error {
    io::Error::other("repository update state unavailable")
}

#[derive(Clone)]
struct CapturedTransport {
    files: Arc<BTreeMap<String, PackageFile>>,
    guard: VerificationGuard,
    root_updates: Arc<AtomicU64>,
    rejected: Arc<AtomicU8>,
}

impl fmt::Debug for CapturedTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedRepositoryTransport")
            .field("file_count", &self.files.len())
            .finish_non_exhaustive()
    }
}

impl CapturedTransport {
    fn check(&self) -> RepositoryResult<()> {
        self.guard.check()?;
        match self.rejected.load(Ordering::Acquire) {
            0 => Ok(()),
            1 => Err(RepositoryError::InvalidLayout),
            _ => Err(RepositoryError::LimitExceeded),
        }
    }

    fn reject(&self, reason: u8, url: &Url) -> TransportError {
        let _ = self
            .rejected
            .compare_exchange(0, reason, Ordering::AcqRel, Ordering::Acquire);
        TransportError::new(TransportErrorKind::Other, url.as_str())
    }
}

#[tough::async_trait]
impl Transport for CapturedTransport {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        if self.check().is_err() {
            return Err(TransportError::new(TransportErrorKind::Other, url.as_str()));
        }
        let Some(relative) = url.as_str().strip_prefix(ORIGIN) else {
            return Err(self.reject(1, &url));
        };
        let valid = if let Some(name) = relative.strip_prefix("metadata/") {
            metadata_kind(name).is_some()
        } else if let Some(name) = relative.strip_prefix("targets/") {
            catalog_filename(name)
        } else {
            false
        };
        if !valid
            || url.scheme() != "https"
            || url.host_str() != Some("offline.invalid")
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(self.reject(1, &url));
        }
        let Some(file) = self.files.get(relative) else {
            return Err(TransportError::new(
                TransportErrorKind::FileNotFound,
                url.as_str(),
            ));
        };
        if relative.starts_with("metadata/")
            && relative.ends_with(".root.json")
            && self.root_updates.fetch_add(1, Ordering::AcqRel) >= MAX_REPOSITORY_ROOT_UPDATES
        {
            return Err(self.reject(2, &url));
        }
        let bytes: Arc<[u8]> = file.bytes.clone().into();
        let guard = self.guard.clone();
        let stream_url = url.to_string();
        let stream = stream::unfold(
            (bytes, 0usize, guard, stream_url),
            |(bytes, offset, guard, stream_url)| async move {
                if offset == bytes.len() {
                    return None;
                }
                if guard.check().is_err() {
                    let end = bytes.len();
                    return Some((
                        Err(TransportError::new(TransportErrorKind::Other, &stream_url)),
                        (bytes, end, guard, stream_url),
                    ));
                }
                let end = (offset + 64 * 1024).min(bytes.len());
                let chunk = Bytes::copy_from_slice(&bytes[offset..end]);
                Some((Ok(chunk), (bytes, end, guard, stream_url)))
            },
        );
        Ok(Box::pin(stream))
    }
}

fn metadata_error(error: tough::error::Error) -> RepositoryError {
    use tough::error::Error;
    match error {
        Error::ExpiredMetadata { .. } => RepositoryError::ExpiredMetadata,
        Error::OlderMetadata { .. }
        | Error::OlderSnapshotInTimestamp { .. }
        | Error::SnapshotRoleRollback { .. } => RepositoryError::MetadataRollback,
        Error::VerifyMetadata { .. } | Error::VerifyTrustedMetadata { .. } => {
            RepositoryError::SignatureRejected
        }
        Error::SystemTimeSteppedBackward { .. } => RepositoryError::ClockChanged,
        Error::DatastoreInit { .. }
        | Error::DatastoreCreate { .. }
        | Error::DatastoreOpen { .. }
        | Error::DatastoreRemove { .. }
        | Error::DatastoreSerialize { .. } => RepositoryError::WorkingStateUnavailable,
        Error::Transport { source, .. } => match source.kind() {
            TransportErrorKind::Other => RepositoryError::MetadataRejected,
            _ => RepositoryError::MetadataUnavailable,
        },
        _ => RepositoryError::MetadataRejected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captured_transport_rejects_other_origins_queries_and_encoded_aliases() {
        for url in [
            "http://offline.invalid/metadata/1.root.json",
            "file:///metadata/1.root.json",
            "https://other.invalid/metadata/1.root.json",
            "https://offline.invalid/metadata/1.root.json?download=1",
            "https://offline.invalid/metadata/1.root.json#part",
            "https://offline.invalid/metadata/%31.root.json",
            "https://offline.invalid/targets/subdirectory/catalog.json",
            "https://offline.invalid/packages/current/manifest.json",
        ] {
            let remote = CapturedTransport {
                files: Arc::new(BTreeMap::new()),
                guard: VerificationGuard::new(|| true),
                root_updates: Arc::new(AtomicU64::new(0)),
                rejected: Arc::new(AtomicU8::new(0)),
            };
            assert!(remote.fetch(Url::parse(url).unwrap()).await.is_err());
            assert_eq!(remote.check(), Err(RepositoryError::InvalidLayout));
        }
    }
}
