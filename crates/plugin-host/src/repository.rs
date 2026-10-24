//! Immutable offline repository input and authenticated package declarations.
//!
//! The application independently enrolls a root of trust and owns persistent
//! update state. Capturing a directory does not trust its metadata, install a
//! package, run code, or grant execution permissions.
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tsumugi_plugin_sdk as sdk;

use crate::{
    HostError, PackageFile, PackageImage,
    catalog::{PackageApproval, PackageCatalog, PackageOrigin, RegisteredPackage, validate_origin},
    tree::{TreeLimits, capture_tree_with_layout},
};

mod root;
mod verification;
pub use root::CapturedRepositoryRoot;

pub const MAX_REPOSITORY_PACKAGES: usize = 16;
pub const MAX_REPOSITORY_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_REPOSITORY_CATALOG_BYTES: usize = 64 * 1024;
pub const MAX_REPOSITORY_ROOT_BYTES: usize = 256 * 1024;
pub const MAX_REPOSITORY_ROOT_UPDATES: u64 = 32;
const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;
const MAX_METADATA_FILES: usize = 64;
const MAX_ROLE_BYTES: usize = 1024 * 1024;
const REPOSITORY_TIMEOUT: Duration = Duration::from_secs(30);

/// Stable classifications; no selected path, metadata text, or credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub enum RepositoryError {
    Capture(HostError),
    InvalidSource,
    InvalidLayout,
    InvalidCatalog,
    CatalogMismatch,
    TrustedRootMismatch,
    MetadataRejected,
    MetadataUnavailable,
    WorkingStateUnavailable,
    /// The original trust action must be reconciled before another can start.
    WorkingStateOutcomeUnknown,
    ClockChanged,
    ExpiredMetadata,
    MetadataRollback,
    SignatureRejected,
    LimitExceeded,
    AuthorityRevoked,
    Timeout,
}

pub type RepositoryResult<T> = Result<T, RepositoryError>;

impl fmt::Display for RepositoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}
impl std::error::Error for RepositoryError {}
impl From<HostError> for RepositoryError {
    fn from(error: HostError) -> Self {
        Self::Capture(error)
    }
}

pub type RepositoryStorageFuture<'a, T> =
    Pin<Box<dyn Future<Output = RepositoryResult<T>> + Send + 'a>>;

/// The existing application Store supplies opaque update metadata storage.
/// It must bound and validate every key, retain its original action and CAS
/// revision, and complete atomic writes/removals and file/directory durability
/// before returning success. Missing reads return None, never a fresh trust
/// database. Removing an absent key is successful only after the Store confirms
/// that absence belongs to this original operation.
///
/// A failed or uncertain mutation must remain sticky for this original action;
/// check_durability must reject it even if a later library call succeeds. No
/// caller may erase partial trusted progress, reset clock/version state, or
/// reconstruct a fresh trust database after a failed or unknown write. Parsing,
/// signature verification, rotation, and update policy remain with TUF.
pub trait RepositoryTrustStorage: Send + Sync {
    fn read<'a>(&'a self, key: &'a str) -> RepositoryStorageFuture<'a, Option<Vec<u8>>>;
    fn write<'a>(&'a self, key: &'a str, bytes: &'a [u8]) -> RepositoryStorageFuture<'a, ()>;
    fn remove<'a>(&'a self, key: &'a str) -> RepositoryStorageFuture<'a, ()>;
    fn check_durability(&self) -> RepositoryResult<()>;
}

/// This declaration is meaningful only after its complete target bytes have
/// passed the repository verifier. The repository attests publisher_id; it is
/// not an independent publisher-key authentication claim.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryPackageDeclaration {
    /// One direct child of the repository's packages directory.
    pub directory: String,
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub publisher_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCatalog {
    pub format_version: u32,
    pub display_name: String,
    pub packages: Vec<RepositoryPackageDeclaration>,
}

/// Informational versions from one successful authentication. The application's
/// durable update state, not this summary, owns rollback and clock watermarks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedRepositoryMetadata {
    pub root_version: u64,
    pub timestamp_version: u64,
    pub snapshot_version: u64,
    pub targets_version: u64,
    pub earliest_expiration_unix_milliseconds: i64,
}

/// A fully verified target index bound to these exact captured package bytes.
/// Installation and enablement still require the original application decision
/// boundary. This value must not be deserialized from an inventory or receipt.
#[derive(Clone)]
pub struct VerifiedOfflineRepository {
    source_id: String,
    capture_digest: String,
    catalog_digest: String,
    catalog: RepositoryCatalog,
    packages: Vec<RegisteredPackage>,
    metadata: VerifiedRepositoryMetadata,
}

impl VerifiedOfflineRepository {
    pub fn source_id(&self) -> &str {
        &self.source_id
    }
    pub fn capture_digest(&self) -> &str {
        &self.capture_digest
    }
    pub fn catalog_digest(&self) -> &str {
        &self.catalog_digest
    }
    pub fn catalog(&self) -> &RepositoryCatalog {
        &self.catalog
    }
    pub fn packages(&self) -> &[RegisteredPackage] {
        &self.packages
    }
    pub fn metadata(&self) -> &VerifiedRepositoryMetadata {
        &self.metadata
    }
}

impl fmt::Debug for VerifiedOfflineRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedOfflineRepository")
            .field("source_id", &self.source_id)
            .field("capture_digest", &self.capture_digest)
            .field("catalog_digest", &self.catalog_digest)
            .field("package_count", &self.packages.len())
            .field("metadata", &self.metadata)
            .finish_non_exhaustive()
    }
}

/// A complete bounded snapshot. Only metadata/, targets/, and packages/ are
/// accepted. Metadata uses canonical positive versioned root filenames;
/// targets contains exactly catalog.json or its consistent-snapshot SHA-256
/// filename. Packages are already built directories. No archive is unpacked
/// and no installation script is executed.
#[derive(Clone)]
pub struct CapturedOfflineRepository {
    files: Arc<BTreeMap<String, PackageFile>>,
    directories: Arc<Vec<String>>,
    capture_digest: String,
}

impl fmt::Debug for CapturedOfflineRepository {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapturedOfflineRepository")
            .field("capture_digest", &self.capture_digest)
            .field("file_count", &self.files.len())
            .field("directory_count", &self.directories.len())
            .finish_non_exhaustive()
    }
}

impl CapturedOfflineRepository {
    /// Uses the same held-descriptor, two-scan owner as individual packages.
    /// The returned bytes remain fixed if the selected source is later changed
    /// or removed. This synchronous capture belongs on a blocking worker.
    pub fn capture_directory(root: &Path, authorized: impl Fn() -> bool) -> RepositoryResult<Self> {
        let (_, package_depth) = package_layout_limits()?;
        let started = Instant::now();
        let captured = capture_tree_with_layout(
            root,
            &TreeLimits {
                max_files: 1024,
                max_bytes: MAX_REPOSITORY_BYTES,
                max_directories: 1024,
                max_depth: package_depth + 2,
                timeout: REPOSITORY_TIMEOUT,
                special_file_limit: Some(("targets/catalog.json", MAX_REPOSITORY_CATALOG_BYTES)),
            },
            &authorized,
        )?;
        validate_layout(&captured.files, &captured.directories)?;
        let capture_digest = capture_digest(&captured.files, &captured.directories);
        if !authorized() {
            return Err(RepositoryError::AuthorityRevoked);
        }
        if started.elapsed() >= REPOSITORY_TIMEOUT {
            return Err(RepositoryError::Timeout);
        }
        Ok(Self {
            files: Arc::new(captured.files),
            directories: Arc::new(captured.directories),
            capture_digest,
        })
    }

    /// Restore the exact frozen input read by the application's existing
    /// pending-action owner. This does not reread a former source or establish
    /// trust. The saved fingerprint must come from that same original action,
    /// and verify still authenticates every admitted declaration and package.
    pub fn restore_snapshot(
        files: BTreeMap<String, PackageFile>,
        directories: Vec<String>,
        expected_capture_digest: &str,
        authorized: impl Fn() -> bool,
    ) -> RepositoryResult<Self> {
        let (_, package_depth) = package_layout_limits()?;
        let started = Instant::now();
        if !authorized() {
            return Err(RepositoryError::AuthorityRevoked);
        }
        sdk::validate_package_digest(expected_capture_digest)
            .map_err(|_| RepositoryError::InvalidLayout)?;
        if files.is_empty()
            || files.len() > 1024
            || directories.is_empty()
            || directories.len() > 1024
            || directories.first().is_none_or(|path| !path.is_empty())
            || directories.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(RepositoryError::LimitExceeded);
        }
        let known_directories: BTreeSet<_> = directories.iter().map(String::as_str).collect();
        for directory in directories.iter().filter(|path| !path.is_empty()) {
            if !authorized() {
                return Err(RepositoryError::AuthorityRevoked);
            }
            crate::package::portable_path(directory)?;
            if directory.split('/').count() > package_depth + 2 {
                return Err(RepositoryError::LimitExceeded);
            }
            let parent = directory.rsplit_once('/').map_or("", |(parent, _)| parent);
            if !known_directories.contains(parent) || files.contains_key(directory) {
                return Err(RepositoryError::InvalidLayout);
            }
        }
        let mut bytes = 0usize;
        for (path, file) in &files {
            if !authorized() {
                return Err(RepositoryError::AuthorityRevoked);
            }
            crate::package::portable_path(path)?;
            let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
            if !known_directories.contains(parent) {
                return Err(RepositoryError::InvalidLayout);
            }
            bytes = bytes
                .checked_add(file.bytes.len())
                .ok_or(RepositoryError::LimitExceeded)?;
            if bytes > MAX_REPOSITORY_BYTES {
                return Err(RepositoryError::LimitExceeded);
            }
        }
        validate_layout(&files, &directories)?;
        let digest = capture_digest(&files, &directories);
        if digest != expected_capture_digest {
            return Err(RepositoryError::CatalogMismatch);
        }
        if !authorized() {
            return Err(RepositoryError::AuthorityRevoked);
        }
        if started.elapsed() >= REPOSITORY_TIMEOUT {
            return Err(RepositoryError::Timeout);
        }
        Ok(Self {
            files: Arc::new(files),
            directories: Arc::new(directories),
            capture_digest: digest,
        })
    }

    /// A source-snapshot fingerprint, not source or publisher authentication.
    pub fn capture_digest(&self) -> &str {
        &self.capture_digest
    }

    /// Exact immutable source members for the application's existing durable
    /// pending-action owner. These bytes do not approve a repository or package.
    pub fn files(&self) -> &BTreeMap<String, PackageFile> {
        &self.files
    }

    pub fn directories(&self) -> &[String] {
        &self.directories
    }

    fn check_trusted_root_pin(&self, trusted_root: &[u8]) -> RepositoryResult<u64> {
        if trusted_root.is_empty() || trusted_root.len() > MAX_REPOSITORY_ROOT_BYTES {
            return Err(RepositoryError::LimitExceeded);
        }
        let value: serde_json::Value = serde_json::from_slice(trusted_root)
            .map_err(|_| RepositoryError::TrustedRootMismatch)?;
        let signed = value
            .get("signed")
            .ok_or(RepositoryError::TrustedRootMismatch)?;
        let version = signed
            .get("version")
            .and_then(serde_json::Value::as_u64)
            .filter(|version| *version > 0)
            .ok_or(RepositoryError::TrustedRootMismatch)?;
        if signed.get("_type").and_then(serde_json::Value::as_str) != Some("root") {
            return Err(RepositoryError::TrustedRootMismatch);
        }
        let source = self
            .files
            .get(&format!("metadata/{version}.root.json"))
            .ok_or(RepositoryError::TrustedRootMismatch)?;
        let source_value: serde_json::Value = serde_json::from_slice(&source.bytes)
            .map_err(|_| RepositoryError::TrustedRootMismatch)?;
        // Preserve every signed field and signature while allowing harmless
        // JSON whitespace/object-key ordering differences in persisted roots.
        if value != source_value {
            return Err(RepositoryError::TrustedRootMismatch);
        }
        Ok(version)
    }

    /// Called only after the authentication owner has completely consumed the
    /// catalog target and checked its signed length/hash, roles, and freshness.
    fn authenticated_catalog(
        &self,
        source_id: &str,
        bytes: Vec<u8>,
        metadata: VerifiedRepositoryMetadata,
        guard: &VerificationGuard,
    ) -> RepositoryResult<VerifiedOfflineRepository> {
        guard.check()?;
        if bytes.is_empty() || bytes.len() > MAX_REPOSITORY_CATALOG_BYTES {
            return Err(RepositoryError::LimitExceeded);
        }
        if !self
            .files
            .iter()
            .any(|(path, file)| path.starts_with("targets/") && file.bytes == bytes)
        {
            return Err(RepositoryError::CatalogMismatch);
        }
        let (package_directory_limit, package_depth_limit) = package_layout_limits()?;
        let catalog: RepositoryCatalog =
            serde_json::from_slice(&bytes).map_err(|_| RepositoryError::InvalidCatalog)?;
        catalog.validate(source_id)?;
        let mut catalog_owner = PackageCatalog::new();
        let mut packages = Vec::with_capacity(catalog.packages.len());
        let mut consumed = BTreeSet::new();
        let mut allowed_directories = BTreeSet::from([String::new(), "packages".into()]);
        for member in &catalog.packages {
            guard.check()?;
            let package_root = format!("packages/{}", member.directory);
            let prefix = format!("{package_root}/");
            let package_directories: Vec<_> = self
                .directories
                .iter()
                .filter(|path| **path == package_root || path.starts_with(&prefix))
                .collect();
            if package_directories.is_empty() {
                return Err(RepositoryError::InvalidLayout);
            }
            if package_directories.len() > package_directory_limit {
                return Err(RepositoryError::LimitExceeded);
            }
            for directory in package_directories {
                let relative_depth = directory[prefix.len().saturating_sub(1)..]
                    .bytes()
                    .filter(|byte| *byte == b'/')
                    .count();
                if relative_depth > package_depth_limit {
                    return Err(RepositoryError::LimitExceeded);
                }
                allowed_directories.insert(directory.clone());
            }
            let mut contents = BTreeMap::new();
            for (path, file) in self
                .files
                .iter()
                .filter(|(path, _)| path.starts_with(&prefix))
            {
                guard.check()?;
                let relative = path[prefix.len()..].to_owned();
                consumed.insert(path.clone());
                contents.insert(relative, file.clone());
            }
            let manifest = contents
                .remove("manifest.json")
                .ok_or(RepositoryError::InvalidLayout)?;
            if manifest.executable {
                return Err(RepositoryError::InvalidLayout);
            }
            let image = PackageImage::capture(manifest.bytes, contents, &member.package_digest)?;
            let approval = PackageApproval {
                plugin: member.plugin.clone(),
                package_digest: member.package_digest.clone(),
                origin: PackageOrigin {
                    source_id: source_id.into(),
                    publisher_id: member.publisher_id.clone(),
                },
            };
            catalog_owner
                .register(image, approval)
                .map_err(|_| RepositoryError::CatalogMismatch)?;
            packages.push(
                catalog_owner
                    .registered(&member.plugin)
                    .map_err(|_| RepositoryError::CatalogMismatch)?
                    .clone(),
            );
        }
        if self
            .files
            .keys()
            .any(|path| path.starts_with("packages/") && !consumed.contains(path))
            || self.directories.iter().any(|path| {
                (path == "packages" || path.starts_with("packages/"))
                    && !allowed_directories.contains(path)
            })
        {
            return Err(RepositoryError::InvalidLayout);
        }
        guard.check()?;
        Ok(VerifiedOfflineRepository {
            source_id: source_id.into(),
            capture_digest: self.capture_digest.clone(),
            catalog_digest: format!("{:x}", Sha256::digest(&bytes)),
            catalog,
            packages,
            metadata,
        })
    }
}

impl RepositoryCatalog {
    fn validate(&self, source_id: &str) -> RepositoryResult<()> {
        validate_source(source_id)?;
        if self.format_version != 1
            || self.display_name.trim().is_empty()
            || self.display_name.len() > 256
            || self.display_name.chars().any(char::is_control)
        {
            return Err(RepositoryError::InvalidCatalog);
        }
        if self.packages.is_empty() || self.packages.len() > MAX_REPOSITORY_PACKAGES {
            return Err(RepositoryError::LimitExceeded);
        }
        let mut directories = BTreeSet::new();
        let mut plugins = BTreeSet::new();
        for member in &self.packages {
            crate::package::portable_path(&member.directory)?;
            if member.directory.contains('/')
                || !directories.insert(member.directory.to_ascii_lowercase())
                || !plugins.insert(member.plugin.clone())
            {
                return Err(RepositoryError::InvalidCatalog);
            }
            PackageApproval {
                plugin: member.plugin.clone(),
                package_digest: member.package_digest.clone(),
                origin: PackageOrigin {
                    source_id: source_id.into(),
                    publisher_id: member.publisher_id.clone(),
                },
            }
            .validate()
            .map_err(|_| RepositoryError::InvalidCatalog)?;
        }
        Ok(())
    }
}

fn validate_source(source_id: &str) -> RepositoryResult<()> {
    validate_origin(&PackageOrigin {
        source_id: source_id.into(),
        publisher_id: "syntax-check".into(),
    })
    .map_err(|_| RepositoryError::InvalidSource)
}

fn package_layout_limits() -> RepositoryResult<(usize, usize)> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        Ok((crate::package::MAX_DIRECTORIES, crate::package::MAX_DEPTH))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(RepositoryError::Capture(HostError::UnsupportedPlatform))
    }
}

fn metadata_kind(name: &str) -> Option<&str> {
    if matches!(name, "timestamp.json" | "snapshot.json" | "targets.json") {
        return Some(name);
    }
    let (version, role) = name.split_once('.')?;
    let number = version.parse::<u64>().ok()?;
    if number == 0 || number.to_string() != version {
        return None;
    }
    matches!(role, "root.json" | "snapshot.json" | "targets.json").then_some(role)
}

fn catalog_filename(name: &str) -> bool {
    name == "catalog.json"
        || name.strip_suffix(".catalog.json").is_some_and(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn validate_layout(
    files: &BTreeMap<String, PackageFile>,
    directories: &[String],
) -> RepositoryResult<()> {
    let mut names = BTreeSet::new();
    for path in files
        .keys()
        .chain(directories.iter())
        .filter(|path| !path.is_empty())
    {
        if !names.insert(path.to_ascii_lowercase()) {
            return Err(RepositoryError::InvalidLayout);
        }
    }
    for directory in directories {
        if !matches!(directory.as_str(), "" | "metadata" | "targets" | "packages")
            && !directory.starts_with("packages/")
        {
            return Err(RepositoryError::InvalidLayout);
        }
    }
    if ["metadata", "targets", "packages"]
        .iter()
        .any(|expected| !directories.iter().any(|path| path == expected))
    {
        return Err(RepositoryError::InvalidLayout);
    }
    let mut metadata_bytes = 0usize;
    let mut metadata_files = 0usize;
    let mut target_files = 0usize;
    for (path, file) in files {
        if let Some(name) = path.strip_prefix("metadata/") {
            let role = metadata_kind(name).ok_or(RepositoryError::InvalidLayout)?;
            let limit = if role == "root.json" {
                MAX_REPOSITORY_ROOT_BYTES
            } else {
                MAX_ROLE_BYTES
            };
            metadata_bytes = metadata_bytes
                .checked_add(file.bytes.len())
                .ok_or(RepositoryError::LimitExceeded)?;
            metadata_files += 1;
            if file.executable || file.bytes.is_empty() || file.bytes.len() > limit {
                return Err(RepositoryError::InvalidLayout);
            }
        } else if let Some(name) = path.strip_prefix("targets/") {
            if !catalog_filename(name) || file.executable || file.bytes.is_empty() {
                return Err(RepositoryError::InvalidLayout);
            }
            if file.bytes.len() > MAX_REPOSITORY_CATALOG_BYTES {
                return Err(RepositoryError::LimitExceeded);
            }
            target_files += 1;
        } else if !path.starts_with("packages/") {
            return Err(RepositoryError::InvalidLayout);
        }
    }
    if metadata_bytes > MAX_METADATA_BYTES || metadata_files > MAX_METADATA_FILES {
        return Err(RepositoryError::LimitExceeded);
    }
    if target_files != 1
        || !files.contains_key("metadata/timestamp.json")
        || !files
            .keys()
            .any(|path| path.starts_with("metadata/") && path.ends_with(".root.json"))
    {
        return Err(RepositoryError::InvalidLayout);
    }
    Ok(())
}

fn capture_digest(files: &BTreeMap<String, PackageFile>, directories: &[String]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"tsumugi-captured-repository-v1\0");
    for directory in directories {
        hash.update(b"d");
        hash.update((directory.len() as u64).to_be_bytes());
        hash.update(directory.as_bytes());
    }
    for (path, file) in files {
        hash.update(b"f");
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update([u8::from(file.executable)]);
        hash.update((file.bytes.len() as u64).to_be_bytes());
        hash.update(&file.bytes);
    }
    format!("{:x}", hash.finalize())
}

#[derive(Clone)]
struct VerificationGuard {
    authorized: Arc<dyn Fn() -> bool + Send + Sync>,
    deadline: Instant,
    stopped: Arc<AtomicU8>,
}

impl fmt::Debug for VerificationGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerificationGuard")
            .finish_non_exhaustive()
    }
}

impl VerificationGuard {
    fn new(authorized: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            authorized: Arc::new(authorized),
            deadline: Instant::now() + REPOSITORY_TIMEOUT,
            stopped: Arc::new(AtomicU8::new(0)),
        }
    }

    fn check(&self) -> RepositoryResult<()> {
        let observed = if !(self.authorized)() {
            1
        } else if Instant::now() >= self.deadline {
            2
        } else {
            0
        };
        if observed != 0 {
            let _ = self
                .stopped
                .compare_exchange(0, observed, Ordering::AcqRel, Ordering::Acquire);
        }
        match self.stopped.load(Ordering::Acquire) {
            0 => Ok(()),
            1 => Err(RepositoryError::AuthorityRevoked),
            _ => Err(RepositoryError::Timeout),
        }
    }
}
