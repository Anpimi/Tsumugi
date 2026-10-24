// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT OR Apache-2.0

use crate::error::{self, Result};
use async_trait::async_trait;
use jiff::Timestamp;
use log::debug;
use serde::Serialize;
use snafu::{ensure, ResultExt};
use std::fmt::Debug;
use std::io::{self, ErrorKind};
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};

const ROOT_ROTATION_CONTEXT: &str = "root_rotation_context.json";

/// Caller-managed storage for serialized TUF metadata and the latest known time.
///
/// Keys identify datastore entries, not filesystem paths. Values are opaque,
/// already serialized bytes. Implementations are responsible for atomic writes,
/// durability, access control and recovery. A successful mutation must confirm
/// the caller's required durability before returning; tough adds no persistence
/// guarantees or fallback storage for this backend.
///
/// The custom backend also retains `root_rotation_context.json`, an opaque
/// serialized starting root for an interrupted root phase. Keep it across
/// failed loads until tough explicitly removes it. It preserves the existing
/// role-cache invalidation comparison while authentication continues from the
/// caller's latest trusted root.
#[async_trait]
pub trait MetadataStore: Debug + Send + Sync {
    /// Read an entry, returning `Ok(None)` only when it is absent.
    async fn read(&self, key: &str) -> io::Result<Option<Vec<u8>>>;

    /// Atomically replace an entry with these bytes and confirm its durability.
    async fn write(&self, key: &str, bytes: &[u8]) -> io::Result<()>;

    /// Remove an entry and confirm its durability. An absent entry should succeed.
    async fn remove(&self, key: &str) -> io::Result<()>;
}

/// `Datastore` persists TUF metadata files.
#[derive(Debug, Clone)]
pub(crate) struct Datastore {
    /// A lock around reads and writes to the selected datastore backend.
    path_lock: Arc<RwLock<DatastorePath>>,
    /// A lock to treat the `system_time` function as a critical section.
    time_lock: Arc<Mutex<()>>,
}

impl Datastore {
    pub(crate) fn new(path: Option<PathBuf>) -> Result<Self> {
        Ok(Self {
            path_lock: Arc::new(RwLock::new(match path {
                None => DatastorePath::TempDir(TempDir::new().context(error::DatastoreInitSnafu)?),
                Some(p) => DatastorePath::Path(p),
            })),
            time_lock: Arc::new(Mutex::new(())),
        })
    }

    pub(crate) fn with_metadata_store(store: Arc<dyn MetadataStore>) -> Self {
        Self {
            path_lock: Arc::new(RwLock::new(DatastorePath::MetadataStore(store))),
            time_lock: Arc::new(Mutex::new(())),
        }
    }

    async fn read(&self) -> RwLockReadGuard<'_, DatastorePath> {
        self.path_lock.read().await
    }

    async fn write(&self) -> RwLockWriteGuard<'_, DatastorePath> {
        self.path_lock.write().await
    }

    /// Get contents of a file in the datastore. This function is thread safe.
    ///
    /// TODO: [provide a thread safe interface](https://github.com/awslabs/tough/issues/602)
    ///
    pub(crate) async fn bytes(&self, file: &str) -> Result<Option<Vec<u8>>> {
        let lock = &self.read().await;
        let path = lock.file_path(file);
        if let DatastorePath::MetadataStore(store) = &**lock {
            return store
                .read(file)
                .await
                .context(error::DatastoreOpenSnafu { path: &path });
        }
        match tokio::fs::read(&path).await {
            Ok(file) => Ok(Some(file)),
            Err(err) => match err.kind() {
                ErrorKind::NotFound => Ok(None),
                _ => Err(err).context(error::DatastoreOpenSnafu { path: &path }),
            },
        }
    }

    /// Writes a JSON metadata file in the datastore. This function is thread safe.
    pub(crate) fn create<T: Serialize>(
        &self,
        file: &str,
        value: &T,
    ) -> impl std::future::Future<Output = Result<()>> + Send + '_ {
        // Serialize before constructing the future so a borrowed generic value
        // need not cross an await or acquire additional Send/Sync bounds.
        let bytes = serde_json::to_vec(value);
        let file = file.to_owned();
        async move {
            let lock = &self.write().await;
            let path = lock.file_path(&file);
            let bytes = bytes.with_context(|_| error::DatastoreSerializeSnafu {
                what: format!("{file} in datastore"),
                path: path.clone(),
            })?;
            if let DatastorePath::MetadataStore(store) = &**lock {
                return store
                    .write(&file, &bytes)
                    .await
                    .context(error::DatastoreCreateSnafu { path: &path });
            }
            tokio::fs::write(&path, bytes)
                .await
                .context(error::DatastoreCreateSnafu { path: &path })
        }
    }

    /// Deletes a file from the datastore. This function is thread safe.
    pub(crate) async fn remove(&self, file: &str) -> Result<()> {
        let lock = self.write().await;
        let path = lock.file_path(file);
        debug!("removing '{}'", path.display());
        if let DatastorePath::MetadataStore(store) = &*lock {
            return store
                .remove(file)
                .await
                .context(error::DatastoreRemoveSnafu { path: &path });
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(err) => match err.kind() {
                ErrorKind::NotFound => Ok(()),
                _ => Err(err).context(error::DatastoreRemoveSnafu { path: &path }),
            },
        }
    }

    /// Retain the original root-phase comparison input before any root write.
    /// Path/TempDir backends keep their upstream behavior without this entry.
    pub(crate) fn root_rotation_context<T: Serialize>(
        &self,
        root: &T,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>>> + Send + '_ {
        let bytes = serde_json::to_vec(root);
        async move {
            let lock = self.write().await;
            let DatastorePath::MetadataStore(store) = &*lock else {
                return Ok(None);
            };
            let path = lock.file_path(ROOT_ROTATION_CONTEXT);
            if let Some(bytes) = store
                .read(ROOT_ROTATION_CONTEXT)
                .await
                .context(error::DatastoreOpenSnafu { path: &path })?
            {
                return Ok(Some(bytes));
            }
            let bytes = bytes.with_context(|_| error::DatastoreSerializeSnafu {
                what: format!("{ROOT_ROTATION_CONTEXT} in datastore"),
                path: path.clone(),
            })?;
            store
                .write(ROOT_ROTATION_CONTEXT, &bytes)
                .await
                .context(error::DatastoreCreateSnafu { path: &path })?;
            Ok(Some(bytes))
        }
    }

    /// Clear the continuation only after root checks and both invalidations
    /// have completed durably, before any new timestamp/snapshot is stored.
    pub(crate) async fn finish_root_rotation(&self) -> Result<()> {
        let lock = self.write().await;
        if let DatastorePath::MetadataStore(store) = &*lock {
            let path = lock.file_path(ROOT_ROTATION_CONTEXT);
            store
                .remove(ROOT_ROTATION_CONTEXT)
                .await
                .context(error::DatastoreRemoveSnafu { path: &path })?;
        }
        Ok(())
    }

    /// Ensures that system time has not stepped backward since it was last sampled. This function
    /// is protected by a lock guard to ensure thread safety.
    pub(crate) async fn system_time(&self) -> Result<Timestamp> {
        // Treat this function as a critical section. This lock is not used for anything else.
        let lock = self.time_lock.lock().await;

        let file = "latest_known_time.json";
        // Load the latest known system time, if it exists
        let poss_latest_known_time = self
            .bytes(file)
            .await?
            .map(|b| serde_json::from_slice::<Timestamp>(&b));

        // Get 'current' system time
        let sys_time = Timestamp::now();

        if let Some(Ok(latest_known_time)) = poss_latest_known_time {
            // Make sure the sampled system time did not go back in time
            ensure!(
                sys_time >= latest_known_time,
                error::SystemTimeSteppedBackwardSnafu {
                    sys_time,
                    latest_known_time
                }
            );
        }
        // Store the latest known time
        // Serializes RFC3339 time string and store to datastore
        self.create(file, &sys_time).await?;

        // Explicitly drop the lock to avoid any compiler optimization.
        drop(lock);
        Ok(sys_time)
    }
}

/// Retain the selected storage backend and any owned temporary directory.
#[derive(Debug)]
enum DatastorePath {
    /// Path to a user-managed directory.
    Path(PathBuf),
    /// A `TempDir` that we created on the user's behalf.
    TempDir(TempDir),
    /// Caller-managed storage without a filesystem datastore path.
    MetadataStore(Arc<dyn MetadataStore>),
}

impl DatastorePath {
    /// Use a synthetic diagnostic path for custom storage without disclosing
    /// the caller's underlying storage location or treating a key as a path.
    fn file_path(&self, file: &str) -> PathBuf {
        match self {
            DatastorePath::Path(p) => p.join(file),
            DatastorePath::TempDir(t) => t.path().join(file),
            DatastorePath::MetadataStore(_) => PathBuf::from("metadata-store"),
        }
    }
}
