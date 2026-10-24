//! Durable, explicitly authorized repository trust actions owned by PackageStore.
use super::*;
use crate::repository::{
    CapturedOfflineRepository, MAX_REPOSITORY_BYTES, MAX_REPOSITORY_ROOT_BYTES, RepositoryError,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tough::schema::{Role, Root, Signed};

pub const MAX_REPOSITORY_SOURCES: usize = 16;
pub const MAX_REPOSITORY_TRUST_ACTIONS: usize = 128;
pub(super) const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
pub(super) const MAX_STATE_BYTES: usize = 20 * 1024 * 1024;
const MAX_CAPTURE_HEADER_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_INPUT_BYTES: usize = MAX_REPOSITORY_BYTES + MAX_CAPTURE_HEADER_BYTES + 8;
const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const FORMAT_VERSION: u32 = 1;
pub(super) const ROOT_ROTATION_CONTEXT: &str = "root_rotation_context.json";

/// One exact, independent root decision and its frozen repository input.
/// Trust revisions are separate from plugin settings revisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryRefreshRequest {
    pub source_id: String,
    pub expected_revision: u64,
    pub action_id: String,
    pub initial_root: Vec<u8>,
    pub capture_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryPendingAction {
    pub expected_revision: u64,
    pub action_id: String,
    pub capture_digest: String,
}

/// An observation of retained trust state, never an authentication witness.
/// Reopened owners require original-action confirmation before accepting a new
/// refresh, including when a completed result is visible on disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepositorySourceRecord {
    pub source_id: String,
    pub display_name: Option<String>,
    pub initial_root_fingerprint: String,
    pub latest_root_version: u64,
    pub revision: u64,
    pub last_action_id: Option<String>,
    pub pending: Option<RepositoryPendingAction>,
    pub last_error: Option<RepositoryError>,
}

/// Derive a stable source identifier from the independently selected root's
/// canonical signed content. Formatting and signature ordering do not choose a
/// different source. This syntax/self-signature check does not enroll trust.
pub fn repository_source_id(initial_root: &[u8]) -> InstallResult<String> {
    let root = parse_root(initial_root)?;
    let canonical = root
        .signed
        .canonical_form()
        .map_err(|_| InstallError::Repository(RepositoryError::TrustedRootMismatch))?;
    let mut hash = Sha256::new();
    hash.update(b"tsumugi-repository-source-v1\0");
    hash.update(canonical);
    Ok(format!("tuf:{:x}", hash.finalize()))
}

pub(super) fn parse_root(bytes: &[u8]) -> InstallResult<Signed<Root>> {
    if bytes.is_empty() || bytes.len() > MAX_REPOSITORY_ROOT_BYTES {
        return Err(InstallError::LimitExceeded);
    }
    let root: Signed<Root> = serde_json::from_slice(bytes)
        .map_err(|_| InstallError::Repository(RepositoryError::TrustedRootMismatch))?;
    root.signed
        .verify_role(&root)
        .map_err(|_| InstallError::Repository(RepositoryError::SignatureRejected))?;
    Ok(root)
}

pub(super) fn source_directory(source: &str) -> InstallResult<&str> {
    source
        .strip_prefix("tuf:")
        .filter(|digest| valid_digest(digest))
        .ok_or(InstallError::ApprovalMismatch)
}

impl RepositoryRefreshRequest {
    pub(super) fn validate(&self) -> InstallResult<()> {
        validate_action(&self.action_id)?;
        source_directory(&self.source_id)?;
        if self.expected_revision == u64::MAX || !valid_digest(&self.capture_digest) {
            return Err(InstallError::LimitExceeded);
        }
        if repository_source_id(&self.initial_root)? != self.source_id {
            return Err(InstallError::ApprovalMismatch);
        }
        Ok(())
    }
    pub(super) fn pending(&self) -> RepositoryPendingAction {
        RepositoryPendingAction {
            expected_revision: self.expected_revision,
            action_id: self.action_id.clone(),
            capture_digest: self.capture_digest.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredRequest {
    pub(super) format_version: u32,
    pub(super) request: RepositoryRefreshRequest,
    pub(super) input_digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TrustState {
    pub(super) format_version: u32,
    pub(super) revision: u64,
    pub(super) source_id: String,
    pub(super) action_id: String,
    pub(super) input_digest: String,
    pub(super) latest_root: Vec<u8>,
    #[serde(deserialize_with = "required_option")]
    pub(super) display_name: Option<String>,
    pub(super) cache: BTreeMap<String, Vec<u8>>,
    pub(super) complete: bool,
    #[serde(deserialize_with = "required_option")]
    pub(super) error: Option<RepositoryError>,
}

fn required_option<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

pub(super) fn validate_cache_entry(key: &str, bytes: &[u8]) -> InstallResult<()> {
    use tough::schema::{Snapshot, Targets, Timestamp};
    let invalid = || InstallError::CorruptStore;
    match key {
        "root.json" | ROOT_ROTATION_CONTEXT => {
            parse_root(bytes).map_err(|_| invalid())?;
        }
        "latest_known_time.json" => {
            if bytes.len() > 128 {
                return Err(invalid());
            }
            serde_json::from_slice::<jiff::Timestamp>(bytes).map_err(|_| invalid())?;
        }
        "timestamp.json" | "snapshot.json" | "targets.json" => {
            if bytes.is_empty() || bytes.len() > 1024 * 1024 {
                return Err(invalid());
            }
            match key {
                "timestamp.json" => {
                    serde_json::from_slice::<Signed<Timestamp>>(bytes).map_err(|_| invalid())?;
                }
                "snapshot.json" => {
                    serde_json::from_slice::<Signed<Snapshot>>(bytes).map_err(|_| invalid())?;
                }
                _ => {
                    serde_json::from_slice::<Signed<Targets>>(bytes).map_err(|_| invalid())?;
                }
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

impl TrustState {
    pub(super) fn validate(&self, request: &StoredRequest) -> InstallResult<()> {
        let original = &request.request;
        if self.format_version != FORMAT_VERSION
            || self.revision != original.expected_revision + 1
            || self.source_id != original.source_id
            || self.action_id != original.action_id
            || self.input_digest != request.input_digest
            || (!self.complete && self.error.is_some())
            || self.cache.len() > 6
            || self.cache.values().map(Vec::len).sum::<usize>() > MAX_CACHE_BYTES
            || self.display_name.as_ref().is_some_and(|name| {
                name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control)
            })
        {
            return Err(InstallError::CorruptStore);
        }
        let initial = parse_root(&original.initial_root).map_err(|_| InstallError::CorruptStore)?;
        let latest = parse_root(&self.latest_root).map_err(|_| InstallError::CorruptStore)?;
        if latest.signed.version < initial.signed.version {
            return Err(InstallError::CorruptStore);
        }
        for (key, bytes) in &self.cache {
            validate_cache_entry(key, bytes)?;
        }
        if let Some(context) = self.cache.get(ROOT_ROTATION_CONTEXT) {
            let context = parse_root(context).map_err(|_| InstallError::CorruptStore)?;
            // This opaque continuation records an already trusted earlier
            // phase input. It never raises or replaces the authentication floor.
            if context.signed.version > latest.signed.version
                || (context.signed.version == latest.signed.version
                    && context
                        .signed
                        .canonical_form()
                        .map_err(|_| InstallError::CorruptStore)?
                        != latest
                            .signed
                            .canonical_form()
                            .map_err(|_| InstallError::CorruptStore)?)
            {
                return Err(InstallError::CorruptStore);
            }
        }
        if let Some(root) = self.cache.get("root.json") {
            let cached: serde_json::Value =
                serde_json::from_slice(root).map_err(|_| InstallError::CorruptStore)?;
            let latest: serde_json::Value = serde_json::from_slice(&self.latest_root)
                .map_err(|_| InstallError::CorruptStore)?;
            if cached != latest {
                return Err(InstallError::CorruptStore);
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenHeader {
    format_version: u32,
    directories: Vec<String>,
    files: Vec<FrozenFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FrozenFile {
    path: String,
    length: usize,
    executable: bool,
}

pub(super) fn freeze(captured: &CapturedOfflineRepository) -> InstallResult<Vec<u8>> {
    let header = FrozenHeader {
        format_version: FORMAT_VERSION,
        directories: captured.directories().to_vec(),
        files: captured
            .files()
            .iter()
            .map(|(path, file)| FrozenFile {
                path: path.clone(),
                length: file.bytes.len(),
                executable: file.executable,
            })
            .collect(),
    };
    let header = serde_json::to_vec(&header).map_err(|_| InstallError::CorruptStore)?;
    if header.len() > MAX_CAPTURE_HEADER_BYTES {
        return Err(InstallError::LimitExceeded);
    }
    let mut bytes = (header.len() as u64).to_be_bytes().to_vec();
    bytes.extend_from_slice(&header);
    for file in captured.files().values() {
        bytes.extend_from_slice(&file.bytes);
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(InstallError::LimitExceeded);
    }
    Ok(bytes)
}

pub(super) fn restore(
    bytes: &[u8],
    request: &StoredRequest,
    authorized: impl Fn() -> bool,
) -> InstallResult<CapturedOfflineRepository> {
    if bytes.len() < 8
        || bytes.len() > MAX_INPUT_BYTES
        || format!("{:x}", Sha256::digest(bytes)) != request.input_digest
    {
        return Err(InstallError::CorruptStore);
    }
    let header_len = u64::from_be_bytes(bytes[..8].try_into().expect("eight bytes"));
    let header_len = usize::try_from(header_len).map_err(|_| InstallError::CorruptStore)?;
    let end = 8usize
        .checked_add(header_len)
        .ok_or(InstallError::CorruptStore)?;
    if header_len > MAX_CAPTURE_HEADER_BYTES || end > bytes.len() {
        return Err(InstallError::CorruptStore);
    }
    let header: FrozenHeader =
        serde_json::from_slice(&bytes[8..end]).map_err(|_| InstallError::CorruptStore)?;
    if header.format_version != FORMAT_VERSION
        || header.files.len() > 1024
        || header.directories.len() > 1024
    {
        return Err(InstallError::CorruptStore);
    }
    let mut files = BTreeMap::new();
    let mut offset = end;
    for file in header.files {
        let end = offset
            .checked_add(file.length)
            .ok_or(InstallError::CorruptStore)?;
        if end > bytes.len()
            || files
                .insert(
                    file.path,
                    crate::PackageFile {
                        bytes: bytes[offset..end].to_vec(),
                        executable: file.executable,
                    },
                )
                .is_some()
        {
            return Err(InstallError::CorruptStore);
        }
        offset = end;
    }
    if offset != bytes.len() {
        return Err(InstallError::CorruptStore);
    }
    CapturedOfflineRepository::restore_snapshot(
        files,
        header.directories,
        &request.request.capture_digest,
        authorized,
    )
    .map_err(InstallError::Repository)
}
