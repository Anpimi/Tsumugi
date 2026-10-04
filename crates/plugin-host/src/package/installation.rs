//! Immutable, application-owned local package objects. Installation is neither
//! source authentication, declaration enablement nor an execution permission.

use std::{fmt, path::Path};

use serde::{Deserialize, Serialize};
use tsumugi_plugin_sdk::{self as sdk, PluginIdentity};

use super::PackageImage;
use crate::{
    CapturedRuntime, HostError,
    catalog::{CatalogError, PackageApproval, PackageOrigin, RegisteredPackage},
};

pub const MAX_INSTALLED_PACKAGES: usize = 128;
pub const MAX_INSTALLED_RUNTIMES: usize = 128;
const RECEIPT_VERSION: u32 = 1;
const MAX_RECEIPT_BYTES: usize = 4096;

/// Static classifications deliberately omit filesystem paths and OS messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallError {
    UnsupportedPlatform,
    InvalidAction,
    InvalidRoot,
    Busy,
    StoreChanged,
    CorruptStore,
    CorruptReceipt,
    MissingPackage,
    MissingRuntime,
    /// A verified promoted object still has its private writable wrapper.
    /// Only installation retry with its original action and approval may seal it.
    RecoveryRequired,
    ApprovalMismatch,
    ActionConflict,
    IdentityConflict,
    SourceConflict,
    PublisherConflict,
    LimitExceeded,
    AuthorityRevoked,
    Io,
    /// Promotion occurred or IO left its outcome uncertain. Durability or the
    /// live authorization/binding was not confirmed. Retry the original action.
    UnknownCommit,
    Host(HostError),
    Catalog(CatalogError),
}

pub type InstallResult<T> = Result<T, InstallError>;

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for InstallError {}
impl From<HostError> for InstallError {
    fn from(error: HostError) -> Self {
        match error {
            HostError::AuthorityRevoked => Self::AuthorityRevoked,
            HostError::UnsupportedPlatform => Self::UnsupportedPlatform,
            other => Self::Host(other),
        }
    }
}
impl From<CatalogError> for InstallError {
    fn from(error: CatalogError) -> Self {
        Self::Catalog(error)
    }
}

/// Receipt values are immutable and strictly decoded. Origin identifiers are
/// retained from independently approved application metadata, never inferred
/// from a manifest, a path or a successful digest comparison.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallReceipt {
    format_version: u32,
    action_id: String,
    plugin: PluginIdentity,
    package_digest: String,
    origin: PackageOrigin,
}

impl InstallReceipt {
    pub fn format_version(&self) -> u32 {
        self.format_version
    }
    pub fn action_id(&self) -> &str {
        &self.action_id
    }
    pub fn plugin(&self) -> &PluginIdentity {
        &self.plugin
    }
    pub fn package_digest(&self) -> &str {
        &self.package_digest
    }
    pub fn origin(&self) -> &PackageOrigin {
        &self.origin
    }

    fn approval(&self) -> PackageApproval {
        PackageApproval {
            plugin: self.plugin.clone(),
            package_digest: self.package_digest.clone(),
            origin: self.origin.clone(),
        }
    }
    fn validate(&self) -> InstallResult<()> {
        if self.format_version != RECEIPT_VERSION
            || validate_action(&self.action_id).is_err()
            || !valid_digest(&self.package_digest)
        {
            return Err(InstallError::CorruptReceipt);
        }
        Ok(())
    }
}

/// Verified bytes survive closing the store and cannot change with its files.
#[derive(Clone)]
pub struct InstalledPackage {
    image: PackageImage,
    receipt: InstallReceipt,
}

impl InstalledPackage {
    pub fn image(&self) -> &PackageImage {
        &self.image
    }
    pub fn receipt(&self) -> &InstallReceipt {
        &self.receipt
    }
}
impl fmt::Debug for InstalledPackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstalledPackage")
            .field("receipt", &self.receipt)
            .finish_non_exhaustive()
    }
}

/// Independent trusted installer metadata for a complete captured environment.
/// This value does not authenticate a publisher, inspect system libraries or
/// grant execution permission. Applications must obtain approval independently
/// of stored receipts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeApproval {
    pub environment: sdk::RuntimeEnvironmentDescriptor,
    pub origin: PackageOrigin,
}

impl RuntimeApproval {
    fn validate(&self) -> InstallResult<String> {
        crate::catalog::validate_origin(&self.origin)?;
        self.environment
            .digest()
            .map_err(|_| InstallError::ApprovalMismatch)
    }
}

/// A strict record of one runtime installation, never a source of approval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInstallReceipt {
    format_version: u32,
    action_id: String,
    approval: RuntimeApproval,
    environment_digest: String,
}

impl RuntimeInstallReceipt {
    pub fn action_id(&self) -> &str {
        &self.action_id
    }
    pub fn approval(&self) -> &RuntimeApproval {
        &self.approval
    }
    pub fn environment_digest(&self) -> &str {
        &self.environment_digest
    }

    fn validate(&self) -> InstallResult<()> {
        if self.format_version != RECEIPT_VERSION
            || validate_action(&self.action_id).is_err()
            || !valid_digest(&self.environment_digest)
            || self.approval.validate().ok().as_deref() != Some(self.environment_digest.as_str())
        {
            return Err(InstallError::CorruptReceipt);
        }
        Ok(())
    }
}

/// Complete immutable runtime bytes verified against independent approval.
#[derive(Clone, Debug)]
pub struct InstalledRuntime {
    runtime: CapturedRuntime,
    receipt: RuntimeInstallReceipt,
}
impl InstalledRuntime {
    pub fn runtime(&self) -> &CapturedRuntime {
        &self.runtime
    }
    pub fn receipt(&self) -> &RuntimeInstallReceipt {
        &self.receipt
    }
}

/// A single owner of an existing private application directory. Operations are
/// synchronous bounded local IO and belong on an application blocking worker.
/// The OS lock stays held until this value is dropped. No root provisioning,
/// network, activation, replacement, uninstall or garbage collection occurs.
/// A whole operation observes a 60-second deadline between guard checkpoints;
/// it does not interrupt an individual blocking filesystem syscall.
pub struct PackageStore {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    inner: platform::Store,
}

impl fmt::Debug for PackageStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PackageStore").finish_non_exhaustive()
    }
}

impl PackageStore {
    /// Open an existing current-user mode-0700 managed directory without
    /// following links. The caller chooses its application-owned location.
    pub fn open_existing(root: &Path) -> InstallResult<Self> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            Ok(Self {
                inner: platform::Store::open(root)?,
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = root;
            Err(InstallError::UnsupportedPlatform)
        }
    }

    /// Persist already approved, captured bytes under their actual digest.
    /// Only the original canonical non-nil UUID action can retry an existing
    /// object. A successful receipt follows object and parent directory syncs.
    /// Uncommitted candidates are private and are never treated as installed;
    /// interrupted candidates are retained without deleting unknown files.
    /// A promoted but unsealed object is recovered only by its original action
    /// and the complete independently approved registered package.
    pub fn install(
        &mut self,
        action_id: &str,
        package: &RegisteredPackage,
        authorized: impl Fn() -> bool,
    ) -> InstallResult<InstallReceipt> {
        validate_action(action_id)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.inner.install(action_id, package, &authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (package, authorized);
            Err(InstallError::UnsupportedPlatform)
        }
    }

    /// Persist the complete captured tool and Host under the approved environment
    /// digest. Uses the same lock, action namespace and commit recovery as packages.
    /// No source paths, execution permissions or activation state are retained.
    pub fn install_runtime(
        &mut self,
        action_id: &str,
        runtime: &CapturedRuntime,
        approval: &RuntimeApproval,
        authorized: impl Fn() -> bool,
    ) -> InstallResult<RuntimeInstallReceipt> {
        validate_action(action_id)?;
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.inner
                .install_runtime(action_id, runtime, approval, &authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (runtime, approval, authorized);
            Err(InstallError::UnsupportedPlatform)
        }
    }

    /// Reopen complete stored bytes using independently supplied exact metadata.
    /// Unsealed objects need the original install action; loading never repairs.
    pub fn load_runtime(
        &self,
        approval: &RuntimeApproval,
        authorized: impl Fn() -> bool,
    ) -> InstallResult<InstalledRuntime> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.inner.load_runtime(approval, &authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (approval, authorized);
            Err(InstallError::UnsupportedPlatform)
        }
    }

    /// Verify both the independent approval and actual installed bytes. This
    /// does not register or enable the package, execute code or mint a grant.
    /// Unsealed objects return RecoveryRequired and are never repaired here.
    pub fn load(
        &self,
        approval: &PackageApproval,
        authorized: impl Fn() -> bool,
    ) -> InstallResult<InstalledPackage> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            self.inner.load(approval, &authorized)
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (approval, authorized);
            Err(InstallError::UnsupportedPlatform)
        }
    }
}

fn validate_action(value: &str) -> InstallResult<()> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| InstallError::InvalidAction)?;
    if parsed.is_nil() || parsed.hyphenated().to_string() != value {
        return Err(InstallError::InvalidAction);
    }
    Ok(())
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    use super::super::{MAX_DEPTH, MAX_DIRECTORIES};
    use super::*;
    use crate::{catalog::PackageCatalog, filesystem};
    use std::{
        cell::Cell,
        collections::{BTreeMap, BTreeSet},
        ffi::{CString, OsStr},
        fs::{File, Metadata},
        io::{Read, Write},
        os::{
            fd::AsRawFd,
            unix::{ffi::OsStrExt, fs::MetadataExt},
        },
        path::PathBuf,
        time::{Duration, Instant},
    };

    const OPERATION_TIMEOUT: Duration = Duration::from_secs(60);

    struct OperationGuard<'a, F> {
        authorized: &'a F,
        deadline: Instant,
        timed_out: Cell<bool>,
    }
    impl<'a, F: Fn() -> bool> OperationGuard<'a, F> {
        fn new(authorized: &'a F) -> Self {
            Self {
                authorized,
                deadline: Instant::now() + OPERATION_TIMEOUT,
                timed_out: Cell::new(false),
            }
        }
        fn allowed(&self) -> bool {
            if !(self.authorized)() {
                return false;
            }
            if Instant::now() >= self.deadline {
                self.timed_out.set(true);
                return false;
            }
            true
        }
        fn finish<T>(&self, result: InstallResult<T>) -> InstallResult<T> {
            if matches!(&result, Err(InstallError::UnknownCommit)) {
                return Err(InstallError::UnknownCommit);
            }
            if self.timed_out.get() {
                return Err(InstallError::Host(HostError::Timeout));
            }
            result
        }
    }

    #[cfg(test)]
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum CommitCheckpoint {
        Seal,
        ObjectsSync,
        RootSync,
    }

    pub(super) struct Store {
        path: PathBuf,
        root: File,
        root_id: (u64, u64),
        lock: File,
        lock_id: (u64, u64),
        objects: File,
        objects_id: (u64, u64),
        runtimes: File,
        runtimes_id: (u64, u64),
        #[cfg(test)]
        fail_commit_checkpoint: Option<CommitCheckpoint>,
    }

    struct Object {
        directory: File,
        directory_id: (u64, u64),
        directory_mode: u32,
        package: File,
        package_id: (u64, u64),
        receipt_file: File,
        receipt_bytes: Vec<u8>,
        receipt: InstallReceipt,
    }

    struct RuntimeObject {
        directory: File,
        directory_id: (u64, u64),
        directory_mode: u32,
        tool: File,
        tool_id: (u64, u64),
        host: File,
        host_id: (u64, u64),
        receipt_file: File,
        receipt_bytes: Vec<u8>,
        receipt: RuntimeInstallReceipt,
    }

    #[derive(Clone, Copy)]
    struct TreeProfile {
        max_files: usize,
        max_directories: usize,
        max_depth: usize,
    }
    const PACKAGE_TREE: TreeProfile = TreeProfile {
        max_files: super::super::MAX_FILES + 1,
        max_directories: MAX_DIRECTORIES,
        max_depth: MAX_DEPTH,
    };
    const RUNTIME_TREE: TreeProfile = TreeProfile {
        max_files: sdk::MAX_RUNTIME_ARTIFACT_FILES,
        max_directories: 1024,
        max_depth: 32,
    };

    #[derive(Clone, PartialEq, Eq)]
    struct Stamp {
        device: u64,
        inode: u64,
        uid: u32,
        mode: u32,
        links: u64,
        length: u64,
        modified: (i64, i64),
        changed: (i64, i64),
    }
    impl From<&Metadata> for Stamp {
        fn from(value: &Metadata) -> Self {
            Self {
                device: value.dev(),
                inode: value.ino(),
                uid: value.uid(),
                mode: value.mode(),
                links: value.nlink(),
                length: value.len(),
                modified: (value.mtime(), value.mtime_nsec()),
                changed: (value.ctime(), value.ctime_nsec()),
            }
        }
    }

    fn metadata(file: &File) -> InstallResult<Metadata> {
        file.metadata().map_err(|_| InstallError::Io)
    }
    fn private(file: &File, directory: bool, mode: u32) -> InstallResult<()> {
        let info = metadata(file)?;
        if info.uid() != unsafe { libc::geteuid() }
            || info.mode() & 0o7777 != mode
            || (directory && !info.is_dir())
            || (!directory && (!info.is_file() || info.nlink() != 1))
        {
            return Err(InstallError::CorruptStore);
        }
        Ok(())
    }
    fn name(value: &OsStr) -> InstallResult<CString> {
        CString::new(value.as_bytes()).map_err(|_| InstallError::CorruptStore)
    }
    fn sync(file: &File) -> InstallResult<()> {
        file.sync_all().map_err(|_| InstallError::Io)
    }
    fn unchanged(file: &File, expected: &Stamp) -> InstallResult<()> {
        if Stamp::from(&metadata(file)?) != *expected {
            return Err(InstallError::StoreChanged);
        }
        Ok(())
    }
    fn chmod(file: &File, mode: u32) -> InstallResult<()> {
        filesystem::set_mode(file, mode).map_err(|_| InstallError::Io)
    }
    fn mkdir(parent: &File, child: &OsStr) -> InstallResult<File> {
        name(child)?;
        filesystem::create_directory(parent, child).map_err(|_| InstallError::Io)?;
        let file = filesystem::open_child(parent, child, true)?;
        chmod(&file, 0o700)?;
        private(&file, true, 0o700)?;
        Ok(file)
    }
    fn new_file(parent: &File, child: &OsStr) -> InstallResult<File> {
        name(child)?;
        let file = filesystem::create_file(parent, child).map_err(|_| InstallError::Io)?;
        chmod(&file, 0o600)?;
        private(&file, false, 0o600)?;
        Ok(file)
    }
    fn same_file(
        parent: &File,
        child: &OsStr,
        directory: bool,
        expected: (u64, u64),
    ) -> InstallResult<()> {
        let reopened = filesystem::open_child(parent, child, directory)
            .map_err(|_| InstallError::StoreChanged)?;
        if filesystem::identity(&reopened)? != expected {
            return Err(InstallError::StoreChanged);
        }
        Ok(())
    }
    fn same_root(path: &Path, expected: (u64, u64)) -> InstallResult<()> {
        let (_, reopened) =
            filesystem::open_directory(path).map_err(|_| InstallError::StoreChanged)?;
        if filesystem::identity(&reopened)? != expected {
            return Err(InstallError::StoreChanged);
        }
        Ok(())
    }
    fn read_receipt(file: &File) -> InstallResult<Vec<u8>> {
        private(file, false, 0o400)?;
        let before = metadata(file)?;
        if before.len() > MAX_RECEIPT_BYTES as u64 {
            return Err(InstallError::CorruptReceipt);
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        file.take((MAX_RECEIPT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| InstallError::Io)?;
        let after = metadata(file)?;
        if bytes.len() as u64 != before.len()
            || after.dev() != before.dev()
            || after.ino() != before.ino()
            || after.mode() != before.mode()
            || after.nlink() != before.nlink()
            || after.uid() != before.uid()
            || after.len() != before.len()
            || (after.mtime(), after.mtime_nsec()) != (before.mtime(), before.mtime_nsec())
            || (after.ctime(), after.ctime_nsec()) != (before.ctime(), before.ctime_nsec())
        {
            return Err(InstallError::StoreChanged);
        }
        Ok(bytes)
    }

    fn open_namespace(root: &File, child: &str, root_id: (u64, u64)) -> InstallResult<File> {
        let directory = match filesystem::open_child(root, OsStr::new(child), true) {
            Ok(file) => file,
            Err(_) => match mkdir(root, OsStr::new(child)) {
                Ok(file) => file,
                Err(_) => filesystem::open_child(root, OsStr::new(child), true)
                    .map_err(|_| InstallError::CorruptStore)?,
            },
        };
        private(&directory, true, 0o700)?;
        if filesystem::identity(&directory)?.0 != root_id.0 {
            return Err(InstallError::CorruptStore);
        }
        Ok(directory)
    }

    impl Store {
        pub(super) fn open(root: &Path) -> InstallResult<Self> {
            let (path, root) =
                filesystem::open_directory(root).map_err(|_| InstallError::InvalidRoot)?;
            private(&root, true, 0o700).map_err(|_| InstallError::InvalidRoot)?;
            let root_id = filesystem::identity(&root)?;
            same_root(&path, root_id)?;
            let lock = match filesystem::open_child(&root, OsStr::new(".lock"), false) {
                Ok(file) => file,
                Err(_) => match new_file(&root, OsStr::new(".lock")) {
                    Ok(file) => file,
                    Err(_) => filesystem::open_child(&root, OsStr::new(".lock"), false)
                        .map_err(|_| InstallError::InvalidRoot)?,
                },
            };
            private(&lock, false, 0o600).map_err(|_| InstallError::InvalidRoot)?;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                let error = std::io::Error::last_os_error().raw_os_error();
                return Err(
                    if error == Some(libc::EWOULDBLOCK) || error == Some(libc::EAGAIN) {
                        InstallError::Busy
                    } else {
                        InstallError::Io
                    },
                );
            }
            let lock_id = filesystem::identity(&lock)?;
            same_root(&path, root_id)?;
            same_file(&root, OsStr::new(".lock"), false, lock_id)?;
            let objects = open_namespace(&root, "objects", root_id)?;
            let objects_id = filesystem::identity(&objects)?;
            let runtimes = open_namespace(&root, "runtimes", root_id)?;
            let runtimes_id = filesystem::identity(&runtimes)?;
            let store = Self {
                path,
                root,
                root_id,
                lock,
                lock_id,
                objects_id,
                objects,
                runtimes,
                runtimes_id,
                #[cfg(test)]
                fail_commit_checkpoint: None,
            };
            store.check(&|| true)?;
            sync(&store.lock)?;
            sync(&store.objects)?;
            sync(&store.runtimes)?;
            sync(&store.root)?;
            store.check(&|| true)?;
            Ok(store)
        }

        fn check(&self, authorized: &impl Fn() -> bool) -> InstallResult<()> {
            if !authorized() {
                return Err(InstallError::AuthorityRevoked);
            }
            private(&self.root, true, 0o700)?;
            private(&self.objects, true, 0o700)?;
            private(&self.runtimes, true, 0o700)?;
            private(&self.lock, false, 0o600)?;
            same_root(&self.path, self.root_id)?;
            same_file(&self.root, OsStr::new("objects"), true, self.objects_id)?;
            same_file(&self.root, OsStr::new("runtimes"), true, self.runtimes_id)?;
            same_file(&self.root, OsStr::new(".lock"), false, self.lock_id)?;
            if !authorized() {
                return Err(InstallError::AuthorityRevoked);
            }
            Ok(())
        }

        fn names(&self, authorized: &impl Fn() -> bool) -> InstallResult<Vec<String>> {
            self.names_in(&self.objects, MAX_INSTALLED_PACKAGES, authorized)
        }

        fn names_in(
            &self,
            parent: &File,
            limit: usize,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<Vec<String>> {
            self.check(authorized)?;
            let before = Stamp::from(&metadata(parent)?);
            let failure = Cell::new(None);
            let result = filesystem::directory_names(
                parent,
                || {
                    self.check(authorized).map_err(|error| {
                        failure.set(Some(error));
                        HostError::AuthorityRevoked
                    })
                },
                limit,
            );
            let names = result.map_err(|error| {
                failure
                    .get()
                    .unwrap_or(if error == HostError::PackageLimit {
                        InstallError::LimitExceeded
                    } else {
                        InstallError::CorruptStore
                    })
            })?;
            if names.iter().any(|value| !valid_digest(value)) {
                return Err(InstallError::CorruptStore);
            }
            unchanged(parent, &before)?;
            self.check(authorized)?;
            Ok(names)
        }

        fn open_envelope(
            &self,
            parent: &File,
            digest: &str,
            expected_names: &[&str],
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<(File, (u64, u64), u32, File, Vec<u8>)> {
            self.check(authorized)?;
            let directory = filesystem::open_child(parent, OsStr::new(digest), true)
                .map_err(|_| InstallError::CorruptStore)?;
            let mode = metadata(&directory)?.mode() & 0o7777;
            if mode != 0o500 && mode != 0o700 {
                return Err(InstallError::CorruptStore);
            }
            private(&directory, true, mode)?;
            let id = filesystem::identity(&directory)?;
            let names = filesystem::directory_names(
                &directory,
                || {
                    if authorized() {
                        Ok(())
                    } else {
                        Err(HostError::AuthorityRevoked)
                    }
                },
                expected_names.len(),
            )?;
            if names
                .iter()
                .map(String::as_str)
                .ne(expected_names.iter().copied())
            {
                return Err(InstallError::CorruptStore);
            }
            let receipt_file =
                filesystem::open_child(&directory, OsStr::new("receipt.json"), false)?;
            let bytes = read_receipt(&receipt_file)?;
            self.check_envelope(
                parent,
                digest,
                &directory,
                id,
                mode,
                &receipt_file,
                authorized,
            )?;
            Ok((directory, id, mode, receipt_file, bytes))
        }

        fn check_envelope(
            &self,
            parent: &File,
            digest: &str,
            directory: &File,
            id: (u64, u64),
            mode: u32,
            receipt: &File,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check(authorized)?;
            same_file(parent, OsStr::new(digest), true, id)?;
            private(directory, true, mode)?;
            same_file(
                directory,
                OsStr::new("receipt.json"),
                false,
                filesystem::identity(receipt)?,
            )?;
            private(receipt, false, 0o400)?;
            self.check(authorized)
        }

        fn seal_wrapper(
            &self,
            directory: &File,
            mode: &mut u32,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check(authorized)?;
            if *mode == 0o700 {
                #[cfg(test)]
                if self.fail_commit_checkpoint == Some(CommitCheckpoint::Seal) {
                    return Err(InstallError::Io);
                }
                chmod(directory, 0o500)?;
                *mode = 0o500;
            }
            private(directory, true, 0o500)?;
            sync(directory)?;
            self.check(authorized)
        }

        fn open_object(
            &self,
            digest: &str,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<Object> {
            let (directory, directory_id, directory_mode, receipt_file, receipt_bytes) = self
                .open_envelope(
                    &self.objects,
                    digest,
                    &["package", "receipt.json"],
                    authorized,
                )?;
            let package = filesystem::open_child(&directory, OsStr::new("package"), true)?;
            private(&package, true, 0o500)?;
            let package_id = filesystem::identity(&package)?;
            let receipt: InstallReceipt =
                serde_json::from_slice(&receipt_bytes).map_err(|_| InstallError::CorruptReceipt)?;
            receipt.validate()?;
            if receipt.package_digest != digest {
                return Err(InstallError::CorruptReceipt);
            }
            let object = Object {
                directory,
                directory_id,
                directory_mode,
                package,
                package_id,
                receipt_file,
                receipt_bytes,
                receipt,
            };
            self.check_object(digest, &object, authorized)?;
            Ok(object)
        }

        fn check_object(
            &self,
            digest: &str,
            object: &Object,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check_envelope(
                &self.objects,
                digest,
                &object.directory,
                object.directory_id,
                object.directory_mode,
                &object.receipt_file,
                authorized,
            )?;
            same_file(
                &object.directory,
                OsStr::new("package"),
                true,
                object.package_id,
            )?;
            private(&object.package, true, 0o500)?;
            private(&object.receipt_file, false, 0o400)?;
            if !authorized() {
                return Err(InstallError::AuthorityRevoked);
            }
            Ok(())
        }

        fn capture_object(
            &self,
            digest: &str,
            object: &Object,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<PackageImage> {
            self.inspect_package(&object.package, authorized, false)?;
            let failure = Cell::new(None);
            let path = self.path.join("objects").join(digest).join("package");
            let image = PackageImage::capture_directory(&path, digest, || {
                match self.check_object(digest, object, authorized) {
                    Ok(()) => true,
                    Err(error) => {
                        failure.set(Some(error));
                        false
                    }
                }
            })
            .map_err(|error| failure.get().unwrap_or(InstallError::Host(error)))?;
            self.inspect_package(&object.package, authorized, false)?;
            self.check_object(digest, object, authorized)?;
            // Reopen the receipt after the capture; metadata-only scans cannot
            // turn a changed provenance/action into the original approval.
            let reopened =
                filesystem::open_child(&object.directory, OsStr::new("receipt.json"), false)?;
            if read_receipt(&reopened)? != object.receipt_bytes {
                return Err(InstallError::StoreChanged);
            }
            let mut catalog = PackageCatalog::new();
            catalog.register(image.clone(), object.receipt.approval())?;
            self.check_object(digest, object, authorized)?;
            Ok(image)
        }

        pub(super) fn load(
            &self,
            approval: &PackageApproval,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<InstalledPackage> {
            let guard = OperationGuard::new(authorized);
            let result = self.load_inner(approval, &|| guard.allowed());
            guard.finish(result)
        }

        fn load_inner(
            &self,
            approval: &PackageApproval,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<InstalledPackage> {
            self.check(authorized)?;
            if !valid_digest(&approval.package_digest) {
                return Err(InstallError::ApprovalMismatch);
            }
            let names = self.names(authorized)?;
            if !names.iter().any(|name| name == &approval.package_digest) {
                return Err(InstallError::MissingPackage);
            }
            let object = self.open_object(&approval.package_digest, authorized)?;
            if object.receipt.approval() != *approval {
                return Err(InstallError::ApprovalMismatch);
            }
            let image = self.capture_object(&approval.package_digest, &object, authorized)?;
            self.check_object(&approval.package_digest, &object, authorized)?;
            if object.directory_mode != 0o500 {
                return Err(InstallError::RecoveryRequired);
            }
            Ok(InstalledPackage {
                image,
                receipt: object.receipt,
            })
        }

        pub(super) fn install(
            &mut self,
            action_id: &str,
            package: &RegisteredPackage,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<InstallReceipt> {
            let guard = OperationGuard::new(authorized);
            let result = self.install_inner(action_id, package, &|| guard.allowed());
            guard.finish(result)
        }

        fn install_inner(
            &mut self,
            action_id: &str,
            package: &RegisteredPackage,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<InstallReceipt> {
            self.check(authorized)?;
            let objects_before = Stamp::from(&metadata(&self.objects)?);
            let runtimes_before = Stamp::from(&metadata(&self.runtimes)?);
            let mut seen_actions = self.runtime_actions(action_id, authorized)?;
            let names = self.names(authorized)?;
            let receipt = InstallReceipt {
                format_version: RECEIPT_VERSION,
                action_id: action_id.into(),
                plugin: package.plugin().clone(),
                package_digest: package.package_digest().into(),
                origin: package.origin().clone(),
            };
            receipt.validate()?;
            let mut seen_plugins = BTreeSet::new();
            let mut origins: BTreeMap<String, (String, String, String)> = BTreeMap::new();
            let mut existing = None;
            let mut unrelated_pending = false;
            // Count and verify the complete bounded object set. A corrupt
            // receipt cannot hide a previous action or identity from conflict
            // checks. Each captured image is dropped before the next object.
            for digest in &names {
                let object = self.open_object(digest, authorized)?;
                let image = self.capture_object(digest, &object, authorized)?;
                let prior = &object.receipt;
                if !seen_actions.insert(prior.action_id.clone())
                    || !seen_plugins.insert(prior.plugin.clone())
                {
                    return Err(InstallError::CorruptStore);
                }
                let origin = (
                    prior.origin.source_id.clone(),
                    prior.origin.publisher_id.clone(),
                    prior.plugin.publisher.clone(),
                );
                if origins
                    .insert(prior.plugin.id.clone(), origin.clone())
                    .is_some_and(|old| old != origin)
                {
                    return Err(InstallError::CorruptStore);
                }
                if prior.action_id == action_id && prior != &receipt {
                    return Err(InstallError::ActionConflict);
                }
                if prior.plugin.id == receipt.plugin.id {
                    if prior.origin.source_id != receipt.origin.source_id {
                        return Err(InstallError::SourceConflict);
                    }
                    if prior.origin.publisher_id != receipt.origin.publisher_id
                        || prior.plugin.publisher != receipt.plugin.publisher
                    {
                        return Err(InstallError::PublisherConflict);
                    }
                }
                if prior.plugin == receipt.plugin && prior.package_digest != receipt.package_digest
                {
                    return Err(InstallError::IdentityConflict);
                }
                if digest == &receipt.package_digest {
                    if prior != &receipt {
                        return Err(InstallError::ActionConflict);
                    }
                    existing = Some((object, image));
                } else if object.directory_mode == 0o700 {
                    // A different action cannot silently advance while a
                    // promoted object still requires its original recovery.
                    unrelated_pending = true;
                }
            }
            self.check(authorized)?;
            unchanged(&self.objects, &objects_before)?;
            unchanged(&self.runtimes, &runtimes_before)?;
            if unrelated_pending {
                return Err(InstallError::RecoveryRequired);
            }
            if let Some((mut object, _image)) = existing {
                // A visible object may be the result of an earlier unknown
                // commit. Reconfirm durable bytes and parents before success.
                let confirmed = (|| {
                    self.seal_object(&mut object, &receipt, authorized)?;
                    self.sync_object(&object, authorized)?;
                    self.sync_installed_parents(authorized)?;
                    self.capture_object(&receipt.package_digest, &object, authorized)?;
                    unchanged(&self.objects, &objects_before)?;
                    unchanged(&self.runtimes, &runtimes_before)?;
                    self.check_object(&receipt.package_digest, &object, authorized)
                })();
                confirmed.map_err(|_| InstallError::UnknownCommit)?;
                return Ok(object.receipt);
            }
            if names.len() >= MAX_INSTALLED_PACKAGES {
                return Err(InstallError::LimitExceeded);
            }
            let candidate_name = format!(".candidate-{}", uuid::Uuid::new_v4());
            self.check(authorized)?;
            let candidate = mkdir(&self.root, OsStr::new(&candidate_name))?;
            let candidate_id = filesystem::identity(&candidate)?;
            self.check_candidate(&candidate_name, candidate_id, authorized)?;
            let held_package = mkdir(&candidate, OsStr::new("package"))?;
            self.write_image(
                package.image(),
                &held_package,
                &candidate_name,
                candidate_id,
                authorized,
            )?;
            let receipt_bytes =
                serde_json::to_vec(&receipt).map_err(|_| InstallError::CorruptReceipt)?;
            if receipt_bytes.len() > MAX_RECEIPT_BYTES {
                return Err(InstallError::CorruptReceipt);
            }
            self.write_file(
                &candidate,
                "receipt.json",
                &receipt_bytes,
                false,
                &candidate_name,
                candidate_id,
                authorized,
            )?;
            // Directory rename can require write access to the directory
            // being moved. Only the private envelope remains writable; the
            // package subtree and receipt are already read-only and synced.
            sync(&candidate)?;
            sync(&self.root)?;
            self.check_candidate(&candidate_name, candidate_id, authorized)?;
            let failure = Cell::new(None);
            let path = self.path.join(&candidate_name).join("package");
            let staged = PackageImage::capture_directory(&path, package.package_digest(), || {
                match self.check_candidate(&candidate_name, candidate_id, authorized) {
                    Ok(()) => true,
                    Err(error) => {
                        failure.set(Some(error));
                        false
                    }
                }
            })
            .map_err(|error| failure.get().unwrap_or(InstallError::Host(error)))?;
            if staged.manifest().manifest().plugin != *package.plugin() {
                return Err(InstallError::CorruptStore);
            }
            private(&candidate, true, 0o700)?;
            self.inspect_package(&held_package, authorized, false)?;
            let candidate_names = filesystem::directory_names(
                &candidate,
                || {
                    if authorized() {
                        Ok(())
                    } else {
                        Err(HostError::AuthorityRevoked)
                    }
                },
                2,
            )?;
            if candidate_names != ["package", "receipt.json"] {
                return Err(InstallError::CorruptStore);
            }
            same_file(
                &candidate,
                OsStr::new("package"),
                true,
                filesystem::identity(&held_package)?,
            )?;
            let final_receipt =
                filesystem::open_child(&candidate, OsStr::new("receipt.json"), false)?;
            if read_receipt(&final_receipt)? != receipt_bytes {
                return Err(InstallError::StoreChanged);
            }
            self.check_candidate(&candidate_name, candidate_id, authorized)?;
            unchanged(&self.objects, &objects_before)?;
            unchanged(&self.runtimes, &runtimes_before)?;
            promote(
                &self.root,
                OsStr::new(&candidate_name),
                &self.objects,
                OsStr::new(package.package_digest()),
            )?;
            // From this point every error is an unknown commit. Never remove
            // the promoted object or claim that the action was rejected.
            let confirmed = (|| {
                self.check(authorized)?;
                same_file(
                    &self.objects,
                    OsStr::new(package.package_digest()),
                    true,
                    candidate_id,
                )?;
                let mut object = self.open_object(package.package_digest(), authorized)?;
                if object.directory_id != candidate_id {
                    return Err(InstallError::StoreChanged);
                }
                if object.receipt != receipt {
                    return Err(InstallError::CorruptReceipt);
                }
                self.capture_object(package.package_digest(), &object, authorized)?;
                self.seal_object(&mut object, &receipt, authorized)?;
                self.sync_object(&object, authorized)?;
                self.sync_installed_parents(authorized)?;
                let mut expected_names = names;
                expected_names.push(package.package_digest().into());
                expected_names.sort();
                unchanged(&self.runtimes, &runtimes_before)?;
                if self.names(authorized)? != expected_names {
                    return Err(InstallError::StoreChanged);
                }
                self.check(authorized)?;
                same_file(
                    &self.objects,
                    OsStr::new(package.package_digest()),
                    true,
                    candidate_id,
                )
            })();
            confirmed.map_err(|_| InstallError::UnknownCommit)?;
            Ok(receipt)
        }

        fn open_runtime_object(
            &self,
            digest: &str,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<RuntimeObject> {
            let (directory, directory_id, directory_mode, receipt_file, receipt_bytes) = self
                .open_envelope(
                    &self.runtimes,
                    digest,
                    &["host", "receipt.json", "tool"],
                    authorized,
                )?;
            let receipt: RuntimeInstallReceipt =
                serde_json::from_slice(&receipt_bytes).map_err(|_| InstallError::CorruptReceipt)?;
            receipt.validate()?;
            if receipt.environment_digest != digest {
                return Err(InstallError::CorruptReceipt);
            }
            let tool = filesystem::open_child(&directory, OsStr::new("tool"), true)?;
            let host = filesystem::open_child(&directory, OsStr::new("host"), true)?;
            private(&tool, true, 0o500)?;
            private(&host, true, 0o500)?;
            let object = RuntimeObject {
                directory,
                directory_id,
                directory_mode,
                tool_id: filesystem::identity(&tool)?,
                host_id: filesystem::identity(&host)?,
                tool,
                host,
                receipt_file,
                receipt_bytes,
                receipt,
            };
            self.check_runtime_object(digest, &object, authorized)?;
            Ok(object)
        }

        fn check_runtime_object(
            &self,
            digest: &str,
            object: &RuntimeObject,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check_envelope(
                &self.runtimes,
                digest,
                &object.directory,
                object.directory_id,
                object.directory_mode,
                &object.receipt_file,
                authorized,
            )?;
            same_file(&object.directory, OsStr::new("tool"), true, object.tool_id)?;
            same_file(&object.directory, OsStr::new("host"), true, object.host_id)?;
            private(&object.tool, true, 0o500)?;
            private(&object.host, true, 0o500)?;
            self.check(authorized)
        }

        fn inspect_runtime_trees(
            &self,
            tool: &File,
            host: &File,
            authorized: &impl Fn() -> bool,
            synchronize: bool,
        ) -> InstallResult<()> {
            let tool = self.inspect_tree(tool, RUNTIME_TREE, authorized, synchronize)?;
            let host = self.inspect_tree(host, RUNTIME_TREE, authorized, synchronize)?;
            if tool
                .0
                .checked_add(host.0)
                .is_none_or(|count| count > sdk::MAX_RUNTIME_ARTIFACT_FILES)
                || tool
                    .1
                    .checked_add(host.1)
                    .is_none_or(|bytes| bytes > sdk::MAX_RUNTIME_ARTIFACT_BYTES as u64)
            {
                return Err(InstallError::CorruptStore);
            }
            self.check(authorized)
        }

        // An unselected object contributes only a strict conflict index. This
        // verifies immutable metadata and receipt bindings, not executable bytes.
        fn inspect_runtime_index(
            &self,
            digest: &str,
            object: &RuntimeObject,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check_runtime_object(digest, object, authorized)?;
            self.inspect_runtime_trees(&object.tool, &object.host, authorized, false)?;
            let reopened =
                filesystem::open_child(&object.directory, OsStr::new("receipt.json"), false)?;
            if read_receipt(&reopened)? != object.receipt_bytes {
                return Err(InstallError::StoreChanged);
            }
            self.check_runtime_object(digest, object, authorized)
        }

        fn capture_runtime_object(
            &self,
            digest: &str,
            object: &RuntimeObject,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<CapturedRuntime> {
            self.inspect_runtime_trees(&object.tool, &object.host, authorized, false)?;
            let path = self.path.join("runtimes").join(digest);
            let failure = Cell::new(None);
            let runtime = CapturedRuntime::capture_directories(
                &path.join("tool"),
                &path.join("host"),
                &object.receipt.approval.environment,
                || match self.check_runtime_object(digest, object, authorized) {
                    Ok(()) => true,
                    Err(error) => {
                        failure.set(Some(error));
                        false
                    }
                },
            )
            .map_err(|error| failure.get().unwrap_or(InstallError::from(error)))?;
            self.inspect_runtime_trees(&object.tool, &object.host, authorized, false)?;
            self.check_runtime_object(digest, object, authorized)?;
            let reopened =
                filesystem::open_child(&object.directory, OsStr::new("receipt.json"), false)?;
            if read_receipt(&reopened)? != object.receipt_bytes {
                return Err(InstallError::StoreChanged);
            }
            if runtime.environment_digest() != digest {
                return Err(InstallError::CorruptReceipt);
            }
            self.check_runtime_object(digest, object, authorized)?;
            Ok(runtime)
        }

        // Both object kinds share action UUIDs. Unselected runtime records
        // participate only in a strict receipt/readonly metadata index.
        fn runtime_actions(
            &self,
            action: &str,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<BTreeSet<String>> {
            let mut seen = BTreeSet::new();
            let mut pending = false;
            for digest in self.names_in(&self.runtimes, MAX_INSTALLED_RUNTIMES, authorized)? {
                let object = self.open_runtime_object(&digest, authorized)?;
                self.inspect_runtime_index(&digest, &object, authorized)?;
                if !seen.insert(object.receipt.action_id.clone()) {
                    return Err(InstallError::CorruptStore);
                }
                if object.receipt.action_id == action {
                    return Err(InstallError::ActionConflict);
                }
                pending |= object.directory_mode == 0o700;
            }
            if pending {
                return Err(InstallError::RecoveryRequired);
            }
            Ok(seen)
        }

        fn package_actions(
            &self,
            action: &str,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<BTreeSet<String>> {
            let mut seen = BTreeSet::new();
            let mut plugins = BTreeSet::new();
            let mut origins = BTreeMap::new();
            let mut pending = false;
            for digest in self.names(authorized)? {
                let object = self.open_object(&digest, authorized)?;
                self.capture_object(&digest, &object, authorized)?;
                let prior = &object.receipt;
                if !seen.insert(prior.action_id.clone()) || !plugins.insert(prior.plugin.clone()) {
                    return Err(InstallError::CorruptStore);
                }
                let origin = (
                    prior.origin.source_id.clone(),
                    prior.origin.publisher_id.clone(),
                    prior.plugin.publisher.clone(),
                );
                if origins
                    .insert(prior.plugin.id.clone(), origin.clone())
                    .is_some_and(|old| old != origin)
                {
                    return Err(InstallError::CorruptStore);
                }
                if prior.action_id == action {
                    return Err(InstallError::ActionConflict);
                }
                pending |= object.directory_mode == 0o700;
            }
            if pending {
                return Err(InstallError::RecoveryRequired);
            }
            Ok(seen)
        }

        pub(super) fn load_runtime(
            &self,
            approval: &RuntimeApproval,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<InstalledRuntime> {
            let guard = OperationGuard::new(authorized);
            let result = (|| {
                self.check(&|| guard.allowed())?;
                let digest = approval.validate()?;
                let names =
                    self.names_in(&self.runtimes, MAX_INSTALLED_RUNTIMES, &|| guard.allowed())?;
                if !names.contains(&digest) {
                    return Err(InstallError::MissingRuntime);
                }
                let object = self.open_runtime_object(&digest, &|| guard.allowed())?;
                if object.receipt.approval != *approval {
                    return Err(InstallError::ApprovalMismatch);
                }
                let runtime = self.capture_runtime_object(&digest, &object, &|| guard.allowed())?;
                self.check_runtime_object(&digest, &object, &|| guard.allowed())?;
                if object.directory_mode != 0o500 {
                    return Err(InstallError::RecoveryRequired);
                }
                Ok(InstalledRuntime {
                    runtime,
                    receipt: object.receipt,
                })
            })();
            guard.finish(result)
        }

        pub(super) fn install_runtime(
            &mut self,
            action_id: &str,
            runtime: &CapturedRuntime,
            approval: &RuntimeApproval,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<RuntimeInstallReceipt> {
            let guard = OperationGuard::new(authorized);
            let result =
                self.install_runtime_inner(action_id, runtime, approval, &|| guard.allowed());
            guard.finish(result)
        }

        fn install_runtime_inner(
            &mut self,
            action_id: &str,
            runtime: &CapturedRuntime,
            approval: &RuntimeApproval,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<RuntimeInstallReceipt> {
            self.check(authorized)?;
            let digest = approval.validate()?;
            if runtime.descriptor() != &approval.environment
                || runtime.environment_digest() != digest
            {
                return Err(InstallError::ApprovalMismatch);
            }
            let objects_before = Stamp::from(&metadata(&self.objects)?);
            let runtimes_before = Stamp::from(&metadata(&self.runtimes)?);
            let mut seen_actions = self.package_actions(action_id, authorized)?;
            let names = self.names_in(&self.runtimes, MAX_INSTALLED_RUNTIMES, authorized)?;
            let receipt = RuntimeInstallReceipt {
                format_version: RECEIPT_VERSION,
                action_id: action_id.into(),
                approval: approval.clone(),
                environment_digest: digest.clone(),
            };
            receipt.validate()?;
            let mut existing = None;
            let mut unrelated_pending = false;
            for prior_digest in &names {
                let object = self.open_runtime_object(prior_digest, authorized)?;
                self.inspect_runtime_index(prior_digest, &object, authorized)?;
                let prior = &object.receipt;
                if !seen_actions.insert(prior.action_id.clone()) {
                    return Err(InstallError::CorruptStore);
                }
                if prior.action_id == action_id && prior != &receipt {
                    return Err(InstallError::ActionConflict);
                }
                if prior_digest == &digest {
                    if prior.approval.origin.source_id != approval.origin.source_id {
                        return Err(InstallError::SourceConflict);
                    }
                    if prior.approval.origin.publisher_id != approval.origin.publisher_id {
                        return Err(InstallError::PublisherConflict);
                    }
                    if prior != &receipt {
                        return Err(InstallError::ActionConflict);
                    }
                    self.capture_runtime_object(prior_digest, &object, authorized)?;
                    existing = Some(object);
                } else if object.directory_mode == 0o700 {
                    unrelated_pending = true;
                }
            }
            self.check(authorized)?;
            unchanged(&self.objects, &objects_before)?;
            unchanged(&self.runtimes, &runtimes_before)?;
            if unrelated_pending {
                return Err(InstallError::RecoveryRequired);
            }
            if let Some(mut object) = existing {
                // A previous unknown commit needs all byte, mode and durability
                // checks again; a visible receipt alone cannot complete it.
                let confirmed = (|| {
                    self.check_runtime_object(&digest, &object, authorized)?;
                    self.seal_wrapper(&object.directory, &mut object.directory_mode, authorized)?;
                    self.sync_runtime_object(&object, authorized)?;
                    self.sync_parents(&self.runtimes, authorized)?;
                    self.capture_runtime_object(&digest, &object, authorized)?;
                    unchanged(&self.objects, &objects_before)?;
                    unchanged(&self.runtimes, &runtimes_before)?;
                    self.check_runtime_object(&digest, &object, authorized)
                })();
                confirmed.map_err(|_| InstallError::UnknownCommit)?;
                return Ok(object.receipt);
            }
            if names.len() >= MAX_INSTALLED_RUNTIMES {
                return Err(InstallError::LimitExceeded);
            }
            let candidate_name = format!(".candidate-{}", uuid::Uuid::new_v4());
            self.check(authorized)?;
            let candidate = mkdir(&self.root, OsStr::new(&candidate_name))?;
            let candidate_id = filesystem::identity(&candidate)?;
            self.check_candidate(&candidate_name, candidate_id, authorized)?;
            let held_tool = mkdir(&candidate, OsStr::new("tool"))?;
            let held_host = mkdir(&candidate, OsStr::new("host"))?;
            let tool_id = filesystem::identity(&held_tool)?;
            let host_id = filesystem::identity(&held_host)?;
            self.write_tree(
                runtime.tool_files(),
                &held_tool,
                RUNTIME_TREE,
                &candidate_name,
                candidate_id,
                authorized,
            )?;
            self.write_tree(
                runtime.host_files(),
                &held_host,
                RUNTIME_TREE,
                &candidate_name,
                candidate_id,
                authorized,
            )?;
            let receipt_bytes =
                serde_json::to_vec(&receipt).map_err(|_| InstallError::CorruptReceipt)?;
            if receipt_bytes.len() > MAX_RECEIPT_BYTES {
                return Err(InstallError::CorruptReceipt);
            }
            self.write_file(
                &candidate,
                "receipt.json",
                &receipt_bytes,
                false,
                &candidate_name,
                candidate_id,
                authorized,
            )?;
            sync(&candidate)?;
            sync(&self.root)?;
            let check_candidate = || -> InstallResult<()> {
                self.check_candidate(&candidate_name, candidate_id, authorized)?;
                private(&candidate, true, 0o700)?;
                same_file(&candidate, OsStr::new("tool"), true, tool_id)?;
                same_file(&candidate, OsStr::new("host"), true, host_id)?;
                self.check_candidate(&candidate_name, candidate_id, authorized)
            };
            check_candidate()?;
            self.inspect_runtime_trees(&held_tool, &held_host, authorized, false)?;
            let path = self.path.join(&candidate_name);
            let failure = Cell::new(None);
            let staged = CapturedRuntime::capture_directories(
                &path.join("tool"),
                &path.join("host"),
                &approval.environment,
                || match check_candidate() {
                    Ok(()) => true,
                    Err(error) => {
                        failure.set(Some(error));
                        false
                    }
                },
            )
            .map_err(|error| failure.get().unwrap_or(InstallError::from(error)))?;
            if staged.environment_digest() != digest {
                return Err(InstallError::ApprovalMismatch);
            }
            drop(staged);
            self.inspect_runtime_trees(&held_tool, &held_host, authorized, false)?;
            let candidate_names = filesystem::directory_names(
                &candidate,
                || {
                    check_candidate().map_err(|error| {
                        failure.set(Some(error));
                        HostError::AuthorityRevoked
                    })
                },
                3,
            )
            .map_err(|error| failure.get().unwrap_or(InstallError::from(error)))?;
            if candidate_names != ["host", "receipt.json", "tool"] {
                return Err(InstallError::CorruptStore);
            }
            let final_receipt =
                filesystem::open_child(&candidate, OsStr::new("receipt.json"), false)?;
            if read_receipt(&final_receipt)? != receipt_bytes {
                return Err(InstallError::StoreChanged);
            }
            check_candidate()?;
            unchanged(&self.objects, &objects_before)?;
            unchanged(&self.runtimes, &runtimes_before)?;
            promote(
                &self.root,
                OsStr::new(&candidate_name),
                &self.runtimes,
                OsStr::new(&digest),
            )?;
            let confirmed = (|| {
                self.check(authorized)?;
                same_file(&self.runtimes, OsStr::new(&digest), true, candidate_id)?;
                let mut object = self.open_runtime_object(&digest, authorized)?;
                if object.directory_id != candidate_id {
                    return Err(InstallError::StoreChanged);
                }
                if object.receipt != receipt {
                    return Err(InstallError::CorruptReceipt);
                }
                self.capture_runtime_object(&digest, &object, authorized)?;
                self.check_runtime_object(&digest, &object, authorized)?;
                self.seal_wrapper(&object.directory, &mut object.directory_mode, authorized)?;
                self.sync_runtime_object(&object, authorized)?;
                self.sync_parents(&self.runtimes, authorized)?;
                let mut expected_names = names;
                expected_names.push(digest.clone());
                expected_names.sort();
                if self.names_in(&self.runtimes, MAX_INSTALLED_RUNTIMES, authorized)?
                    != expected_names
                {
                    return Err(InstallError::StoreChanged);
                }
                unchanged(&self.objects, &objects_before)?;
                self.check_runtime_object(&digest, &object, authorized)
            })();
            confirmed.map_err(|_| InstallError::UnknownCommit)?;
            Ok(receipt)
        }

        fn sync_runtime_object(
            &self,
            object: &RuntimeObject,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.inspect_runtime_trees(&object.tool, &object.host, authorized, true)?;
            sync(&object.receipt_file)?;
            sync(&object.directory)?;
            self.check_runtime_object(&object.receipt.environment_digest, object, authorized)
        }

        fn check_candidate(
            &self,
            candidate: &str,
            expected: (u64, u64),
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check(authorized)?;
            same_file(&self.root, OsStr::new(candidate), true, expected)?;
            if !authorized() {
                return Err(InstallError::AuthorityRevoked);
            }
            Ok(())
        }

        fn write_file(
            &self,
            parent: &File,
            child: &str,
            bytes: &[u8],
            executable: bool,
            candidate: &str,
            candidate_id: (u64, u64),
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.check_candidate(candidate, candidate_id, authorized)?;
            let mut file = new_file(parent, OsStr::new(child))?;
            for chunk in bytes.chunks(64 * 1024) {
                self.check_candidate(candidate, candidate_id, authorized)?;
                file.write_all(chunk).map_err(|_| InstallError::Io)?;
            }
            self.check_candidate(candidate, candidate_id, authorized)?;
            sync(&file)?;
            chmod(&file, if executable { 0o500 } else { 0o400 })?;
            sync(&file)?;
            self.check_candidate(candidate, candidate_id, authorized)
        }

        fn write_image(
            &self,
            image: &PackageImage,
            package: &File,
            candidate: &str,
            candidate_id: (u64, u64),
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.write_file(
                package,
                "manifest.json",
                &image.manifest_bytes,
                false,
                candidate,
                candidate_id,
                authorized,
            )?;
            self.write_tree(
                &image.files,
                package,
                PACKAGE_TREE,
                candidate,
                candidate_id,
                authorized,
            )
        }

        fn write_tree(
            &self,
            files: &BTreeMap<String, sdk::RuntimeArtifactFile>,
            root: &File,
            profile: TreeProfile,
            candidate: &str,
            candidate_id: (u64, u64),
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            if files.len() > profile.max_files {
                return Err(InstallError::LimitExceeded);
            }
            let mut directories = BTreeMap::new();
            directories.insert(
                String::new(),
                root.try_clone().map_err(|_| InstallError::Io)?,
            );
            for (path, captured) in files {
                let parts: Vec<_> = path.split('/').collect();
                if parts.len() - 1 > profile.max_depth {
                    return Err(InstallError::Host(HostError::PackageLimit));
                }
                let mut prefix = String::new();
                for part in &parts[..parts.len() - 1] {
                    let next = if prefix.is_empty() {
                        (*part).to_owned()
                    } else {
                        format!("{prefix}/{part}")
                    };
                    if !directories.contains_key(&next) {
                        if directories.len() >= profile.max_directories {
                            return Err(InstallError::Host(HostError::PackageLimit));
                        }
                        self.check_candidate(candidate, candidate_id, authorized)?;
                        let directory = mkdir(&directories[&prefix], OsStr::new(part))?;
                        directories.insert(next.clone(), directory);
                    }
                    prefix = next;
                }
                self.write_file(
                    &directories[&prefix],
                    parts[parts.len() - 1],
                    &captured.bytes,
                    captured.executable,
                    candidate,
                    candidate_id,
                    authorized,
                )?;
            }
            // Descendants first, including final read-only modes in each sync.
            let mut keys: Vec<_> = directories.keys().cloned().collect();
            keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
            for key in keys {
                self.check_candidate(candidate, candidate_id, authorized)?;
                chmod(&directories[&key], 0o500)?;
                sync(&directories[&key])?;
            }
            self.check_candidate(candidate, candidate_id, authorized)
        }

        fn inspect_package(
            &self,
            package: &File,
            authorized: &impl Fn() -> bool,
            synchronize: bool,
        ) -> InstallResult<()> {
            self.inspect_tree(package, PACKAGE_TREE, authorized, synchronize)
                .map(|_| ())
        }

        fn inspect_tree(
            &self,
            root: &File,
            profile: TreeProfile,
            authorized: &impl Fn() -> bool,
            synchronize: bool,
        ) -> InstallResult<(usize, u64)> {
            fn walk(
                store: &Store,
                directory: &File,
                depth: usize,
                counts: &mut (usize, usize, u64),
                profile: TreeProfile,
                authorized: &impl Fn() -> bool,
                synchronize: bool,
            ) -> InstallResult<()> {
                store.check(authorized)?;
                counts.0 += 1;
                if depth > profile.max_depth || counts.0 > profile.max_directories {
                    return Err(InstallError::CorruptStore);
                }
                private(directory, true, 0o500)?;
                let before = Stamp::from(&metadata(directory)?);
                for child in filesystem::directory_names(
                    directory,
                    || {
                        if authorized() {
                            Ok(())
                        } else {
                            Err(HostError::AuthorityRevoked)
                        }
                    },
                    profile.max_files + profile.max_directories,
                )? {
                    store.check(authorized)?;
                    let file = filesystem::open_entry(directory, OsStr::new(&child))?;
                    if metadata(&file)?.is_dir() {
                        walk(
                            store,
                            &file,
                            depth + 1,
                            counts,
                            profile,
                            authorized,
                            synchronize,
                        )?;
                    } else {
                        let mode = metadata(&file)?.mode() & 0o7777;
                        if mode != 0o400 && mode != 0o500 {
                            return Err(InstallError::CorruptStore);
                        }
                        private(&file, false, mode)?;
                        let before = Stamp::from(&metadata(&file)?);
                        if synchronize {
                            sync(&file)?;
                        }
                        unchanged(&file, &before)?;
                        counts.1 += 1;
                        counts.2 = counts
                            .2
                            .checked_add(before.length)
                            .ok_or(InstallError::CorruptStore)?;
                        if counts.1 > profile.max_files {
                            return Err(InstallError::CorruptStore);
                        }
                    }
                }
                if synchronize {
                    sync(directory)?;
                }
                unchanged(directory, &before)?;
                store.check(authorized)
            }
            let mut counts = (0, 0, 0);
            walk(self, root, 0, &mut counts, profile, authorized, synchronize)?;
            Ok((counts.1, counts.2))
        }

        fn sync_object(
            &self,
            object: &Object,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            self.inspect_package(&object.package, authorized, true)?;
            sync(&object.receipt_file)?;
            sync(&object.directory)?;
            self.check_object(&object.receipt.package_digest, object, authorized)
        }

        fn seal_object(
            &self,
            object: &mut Object,
            expected: &InstallReceipt,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<()> {
            if object.receipt != *expected {
                return Err(InstallError::ActionConflict);
            }
            self.check_object(&object.receipt.package_digest, object, authorized)?;
            self.seal_wrapper(&object.directory, &mut object.directory_mode, authorized)?;
            self.check_object(&object.receipt.package_digest, object, authorized)
        }

        fn sync_installed_parents(&self, authorized: &impl Fn() -> bool) -> InstallResult<()> {
            self.sync_parents(&self.objects, authorized)
        }

        fn sync_parents(&self, parent: &File, authorized: &impl Fn() -> bool) -> InstallResult<()> {
            self.check(authorized)?;
            #[cfg(test)]
            if self.fail_commit_checkpoint == Some(CommitCheckpoint::ObjectsSync) {
                return Err(InstallError::Io);
            }
            sync(parent)?;
            self.check(authorized)?;
            #[cfg(test)]
            if self.fail_commit_checkpoint == Some(CommitCheckpoint::RootSync) {
                return Err(InstallError::Io);
            }
            sync(&self.root)?;
            self.check(authorized)
        }
    }

    fn promote(
        source_parent: &File,
        source: &OsStr,
        destination_parent: &File,
        destination: &OsStr,
    ) -> InstallResult<()> {
        let source = name(source)?;
        let destination = name(destination)?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                source_parent.as_raw_fd(),
                source.as_ptr(),
                destination_parent.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                source_parent.as_raw_fd(),
                source.as_ptr(),
                destination_parent.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EEXIST) => InstallError::ActionConflict,
                // POSIX does not promise an unchanged namespace after EIO.
                // Retain the candidate/object and recover by the same action.
                Some(libc::EIO) => InstallError::UnknownCommit,
                _ => InstallError::Io,
            });
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs, os::unix::fs::PermissionsExt};
        use tsumugi_plugin_sdk as sdk;

        struct OwnedRoot(tempfile::TempDir);
        impl Drop for OwnedRoot {
            fn drop(&mut self) {
                fn prepare(path: &Path) {
                    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
                        if let Ok(entries) = fs::read_dir(path) {
                            for entry in entries.flatten() {
                                prepare(&entry.path());
                            }
                        }
                    }
                }
                prepare(self.0.path());
            }
        }

        fn runtime_fixture(root: &Path) -> (CapturedRuntime, RuntimeApproval) {
            let tool_root = root.join("approved-tool");
            let host_root = root.join("approved-host");
            fs::create_dir(&tool_root).unwrap();
            fs::create_dir(&host_root).unwrap();
            let tool = BTreeMap::from([(
                "node".into(),
                sdk::RuntimeArtifactFile {
                    bytes: b"synthetic non-executable program".to_vec(),
                    executable: true,
                },
            )]);
            let host = BTreeMap::from([(
                "main.js".into(),
                sdk::RuntimeArtifactFile {
                    bytes: b"throw new Error('capture only');".to_vec(),
                    executable: false,
                },
            )]);
            fs::write(tool_root.join("node"), &tool["node"].bytes).unwrap();
            fs::set_permissions(tool_root.join("node"), fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(host_root.join("main.js"), &host["main.js"].bytes).unwrap();
            let environment = sdk::RuntimeEnvironmentDescriptor {
                protocol_version: sdk::RUNTIME_ENVIRONMENT_PROTOCOL,
                platform: sdk::RuntimePlatform {
                    operating_system: if cfg!(target_os = "macos") {
                        sdk::RuntimeOperatingSystem::Macos
                    } else {
                        sdk::RuntimeOperatingSystem::Linux
                    },
                    architecture: if cfg!(target_arch = "aarch64") {
                        sdk::RuntimeArchitecture::Aarch64
                    } else {
                        sdk::RuntimeArchitecture::X86_64
                    },
                },
                sdk_version: "0.1.0-alpha.1".into(),
                process_protocol: sdk::PROCESS_PROTOCOL,
                profile: sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1,
                tool_version: "26.10.0".into(),
                tool: sdk::RuntimeArtifactBinding {
                    tree_digest: sdk::runtime_artifact_digest(&tool).unwrap(),
                    entrypoint: "node".into(),
                },
                host: sdk::RuntimeArtifactBinding {
                    tree_digest: sdk::runtime_artifact_digest(&host).unwrap(),
                    entrypoint: "main.js".into(),
                },
            };
            let runtime =
                CapturedRuntime::capture_directories(&tool_root, &host_root, &environment, || true)
                    .unwrap();
            (
                runtime,
                RuntimeApproval {
                    environment,
                    origin: PackageOrigin {
                        source_id: "approved-source".into(),
                        publisher_id: "approved-key".into(),
                    },
                },
            )
        }

        #[test]
        #[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
        fn runtime_commit_checkpoints_require_original_action_and_confirm_all_syncs() {
            for checkpoint in [
                CommitCheckpoint::Seal,
                CommitCheckpoint::ObjectsSync,
                CommitCheckpoint::RootSync,
            ] {
                let root = OwnedRoot(
                    tempfile::Builder::new()
                        .permissions(fs::Permissions::from_mode(0o700))
                        .tempdir()
                        .unwrap(),
                );
                let (runtime, approval) = runtime_fixture(root.0.path());
                let action = "00000000-0000-4000-8000-000000000001";
                let wrong_action = "00000000-0000-4000-8000-000000000002";
                let mut store = PackageStore::open_existing(root.0.path()).unwrap();
                store.inner.fail_commit_checkpoint = Some(checkpoint);
                assert_eq!(
                    store
                        .install_runtime(action, &runtime, &approval, || true)
                        .unwrap_err(),
                    InstallError::UnknownCommit
                );
                let object_path = root
                    .0
                    .path()
                    .join("runtimes")
                    .join(runtime.environment_digest());
                assert!(object_path.join("receipt.json").exists());
                assert_eq!(
                    store
                        .install_runtime(wrong_action, &runtime, &approval, || true)
                        .unwrap_err(),
                    InstallError::ActionConflict
                );
                let mut wrong = approval.clone();
                wrong.origin.source_id = "other-source".into();
                assert_eq!(
                    store
                        .install_runtime(action, &runtime, &wrong, || true)
                        .unwrap_err(),
                    InstallError::ActionConflict
                );
                if checkpoint == CommitCheckpoint::Seal {
                    assert_eq!(
                        store.load_runtime(&approval, || true).unwrap_err(),
                        InstallError::RecoveryRequired
                    );
                    assert_eq!(
                        fs::metadata(&object_path).unwrap().permissions().mode() & 0o777,
                        0o700
                    );
                } else {
                    // Loaded bytes establish integrity, not the durability of a
                    // prior action whose parent sync returned an unknown result.
                    assert_eq!(
                        store
                            .load_runtime(&approval, || true)
                            .unwrap()
                            .receipt()
                            .action_id(),
                        action
                    );
                }
                drop(store);
                let mut store = PackageStore::open_existing(root.0.path()).unwrap();
                // Recovery must also retry the selected namespace and root sync,
                // including when the wrapper was already sealed before failure.
                store.inner.fail_commit_checkpoint = Some(CommitCheckpoint::RootSync);
                assert_eq!(
                    store
                        .install_runtime(action, &runtime, &approval, || true)
                        .unwrap_err(),
                    InstallError::UnknownCommit
                );
                store.inner.fail_commit_checkpoint = None;
                let receipt = store
                    .install_runtime(action, &runtime, &approval, || true)
                    .unwrap();
                let loaded = store.load_runtime(&approval, || true).unwrap();
                assert_eq!(loaded.receipt(), &receipt);
                assert_eq!(
                    loaded.runtime().tool_files()["node"].bytes,
                    b"synthetic non-executable program"
                );
                assert!(loaded.runtime().tool_files()["node"].executable);
                assert_eq!(
                    fs::metadata(&object_path).unwrap().permissions().mode() & 0o777,
                    0o500
                );
                assert_eq!(
                    fs::read_dir(root.0.path().join("runtimes"))
                        .unwrap()
                        .count(),
                    1
                );
            }
        }

        #[test]
        #[cfg(any(target_arch = "aarch64", target_arch = "x86_64"))]
        fn loaded_runtime_snapshot_does_not_change_with_persisted_files() {
            let root = OwnedRoot(
                tempfile::Builder::new()
                    .permissions(fs::Permissions::from_mode(0o700))
                    .tempdir()
                    .unwrap(),
            );
            let (runtime, approval) = runtime_fixture(root.0.path());
            let mut store = PackageStore::open_existing(root.0.path()).unwrap();
            store
                .install_runtime(
                    "00000000-0000-4000-8000-000000000001",
                    &runtime,
                    &approval,
                    || true,
                )
                .unwrap();
            let loaded = store.load_runtime(&approval, || true).unwrap();
            let path = root
                .0
                .path()
                .join("runtimes")
                .join(runtime.environment_digest())
                .join("host/main.js");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            fs::write(&path, b"changed stored bytes").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            assert_eq!(
                loaded.runtime().host_files()["main.js"].bytes,
                b"throw new Error('capture only');"
            );
            assert!(store.load_runtime(&approval, || true).is_err());
        }

        #[test]
        fn each_commit_checkpoint_preserves_object_and_requires_original_action_retry() {
            let manifest = sdk::PluginManifest {
                protocol_version: sdk::MANIFEST_PROTOCOL,
                plugin: sdk::PluginIdentity {
                    publisher: "example".into(),
                    id: "example.resource".into(),
                    version: "0.1.0".into(),
                },
                permissions: vec![],
                components: vec![sdk::ComponentDeclaration {
                    id: "data".into(),
                    scope: sdk::ComponentScope::Application,
                    runtime: sdk::RuntimeKind::Data,
                    entrypoint: None,
                    dependencies: vec![],
                    exit: sdk::ExitRequirements {
                        stop_timeout_ms: 100,
                        cleanup_timeout_ms: 100,
                    },
                }],
                contributions: vec![sdk::ContributionDeclaration {
                    id: "resource".into(),
                    component_id: "data".into(),
                    contribution: sdk::ContributionKind::Resource {
                        schema: sdk::ContractRef {
                            id: "example.resource".into(),
                            schema_version: 1,
                            behavior_version: 1,
                        },
                        path: "resource.json".into(),
                    },
                }],
            };
            let bytes = serde_json::to_vec(&manifest).unwrap();
            let files = BTreeMap::from([(
                "resource.json".into(),
                super::super::super::PackageFile {
                    bytes: b"{}".to_vec(),
                    executable: false,
                },
            )]);
            let digest = PackageImage::digest(&bytes, &files).unwrap();
            let image = PackageImage::capture(bytes, files, &digest).unwrap();
            let approval = PackageApproval {
                plugin: manifest.plugin,
                package_digest: digest.clone(),
                origin: PackageOrigin {
                    source_id: "approved-registry".into(),
                    publisher_id: "approved-key".into(),
                },
            };
            let mut catalog = PackageCatalog::new();
            catalog.register(image, approval.clone()).unwrap();
            let package = catalog.registered(&approval.plugin).unwrap();
            let action = "00000000-0000-4000-8000-000000000001";
            for checkpoint in [
                CommitCheckpoint::Seal,
                CommitCheckpoint::ObjectsSync,
                CommitCheckpoint::RootSync,
            ] {
                let root = OwnedRoot(
                    tempfile::Builder::new()
                        .permissions(fs::Permissions::from_mode(0o700))
                        .tempdir()
                        .unwrap(),
                );
                let mut store = PackageStore::open_existing(root.0.path()).unwrap();
                store.inner.fail_commit_checkpoint = Some(checkpoint);
                assert_eq!(
                    store.install(action, package, || true).unwrap_err(),
                    InstallError::UnknownCommit
                );
                assert!(
                    root.0
                        .path()
                        .join("objects")
                        .join(&digest)
                        .join("receipt.json")
                        .exists()
                );
                let object_path = root.0.path().join("objects").join(&digest);
                if checkpoint == CommitCheckpoint::Seal {
                    assert_eq!(
                        store.load(&approval, || true).unwrap_err(),
                        InstallError::RecoveryRequired
                    );
                    assert_eq!(
                        fs::metadata(&object_path).unwrap().permissions().mode() & 0o777,
                        0o700
                    );
                    let wrong_action = "00000000-0000-4000-8000-000000000002";
                    assert_eq!(
                        store.install(wrong_action, package, || true).unwrap_err(),
                        InstallError::ActionConflict
                    );
                    let mut changed_approval = approval.clone();
                    changed_approval.origin.source_id = "other-registry".into();
                    let mut changed_catalog = PackageCatalog::new();
                    changed_catalog
                        .register(package.image().clone(), changed_approval.clone())
                        .unwrap();
                    assert_eq!(
                        store
                            .install(
                                action,
                                changed_catalog
                                    .registered(&changed_approval.plugin)
                                    .unwrap(),
                                || true
                            )
                            .unwrap_err(),
                        InstallError::ActionConflict
                    );
                    assert_eq!(
                        fs::metadata(&object_path).unwrap().permissions().mode() & 0o777,
                        0o700
                    );
                } else {
                    assert_eq!(
                        store
                            .load(&approval, || true)
                            .unwrap()
                            .receipt()
                            .action_id(),
                        action
                    );
                    assert_eq!(
                        fs::metadata(&object_path).unwrap().permissions().mode() & 0o777,
                        0o500
                    );
                }
                drop(store);
                let mut store = PackageStore::open_existing(root.0.path()).unwrap();
                let receipt = store.install(action, package, || true).unwrap();
                assert_eq!(receipt.action_id(), action);
                assert_eq!(store.load(&approval, || true).unwrap().receipt(), &receipt);
                assert_eq!(
                    fs::metadata(&object_path).unwrap().permissions().mode() & 0o777,
                    0o500
                );
                assert_eq!(
                    fs::read_dir(root.0.path().join("objects")).unwrap().count(),
                    1
                );
            }
        }
    }
}
