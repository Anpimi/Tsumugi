//! Immutable, application-owned local package objects. Installation is neither
//! source authentication, declaration enablement nor an execution permission.

use std::{fmt, path::Path};

use serde::{Deserialize, Serialize};
use tsumugi_plugin_sdk::PluginIdentity;

use super::PackageImage;
use crate::{
    HostError,
    catalog::{CatalogError, PackageApproval, PackageOrigin, RegisteredPackage},
};

pub const MAX_INSTALLED_PACKAGES: usize = 128;
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
            fd::{AsRawFd, FromRawFd},
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
        if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } != 0 {
            return Err(InstallError::Io);
        }
        Ok(())
    }
    fn mkdir(parent: &File, child: &OsStr) -> InstallResult<File> {
        let child_name = name(child)?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), child_name.as_ptr(), 0o700) } != 0 {
            return Err(InstallError::Io);
        }
        let file = filesystem::open_child(parent, child, true)?;
        chmod(&file, 0o700)?;
        private(&file, true, 0o700)?;
        Ok(file)
    }
    fn new_file(parent: &File, child: &OsStr) -> InstallResult<File> {
        let child_name = name(child)?;
        let descriptor = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                child_name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK
                    | libc::O_NOCTTY,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(InstallError::Io);
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
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
            let objects = match filesystem::open_child(&root, OsStr::new("objects"), true) {
                Ok(file) => file,
                Err(_) => match mkdir(&root, OsStr::new("objects")) {
                    Ok(file) => file,
                    Err(_) => filesystem::open_child(&root, OsStr::new("objects"), true)
                        .map_err(|_| InstallError::CorruptStore)?,
                },
            };
            private(&objects, true, 0o700)?;
            let objects_id = filesystem::identity(&objects)?;
            if objects_id.0 != root_id.0 {
                return Err(InstallError::CorruptStore);
            }
            let store = Self {
                path,
                root,
                root_id,
                lock,
                lock_id,
                objects_id,
                objects,
                #[cfg(test)]
                fail_commit_checkpoint: None,
            };
            store.check(&|| true)?;
            sync(&store.lock)?;
            sync(&store.objects)?;
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
            private(&self.lock, false, 0o600)?;
            same_root(&self.path, self.root_id)?;
            same_file(&self.root, OsStr::new("objects"), true, self.objects_id)?;
            same_file(&self.root, OsStr::new(".lock"), false, self.lock_id)?;
            if !authorized() {
                return Err(InstallError::AuthorityRevoked);
            }
            Ok(())
        }

        fn names(&self, authorized: &impl Fn() -> bool) -> InstallResult<Vec<String>> {
            self.check(authorized)?;
            let before = Stamp::from(&metadata(&self.objects)?);
            let failure = Cell::new(None);
            let result = filesystem::directory_names(
                &self.objects,
                || {
                    self.check(authorized).map_err(|error| {
                        failure.set(Some(error));
                        HostError::AuthorityRevoked
                    })
                },
                MAX_INSTALLED_PACKAGES,
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
            unchanged(&self.objects, &before)?;
            self.check(authorized)?;
            Ok(names)
        }

        fn open_object(
            &self,
            digest: &str,
            authorized: &impl Fn() -> bool,
        ) -> InstallResult<Object> {
            self.check(authorized)?;
            let directory = filesystem::open_child(&self.objects, OsStr::new(digest), true)
                .map_err(|_| InstallError::CorruptStore)?;
            let directory_mode = metadata(&directory)?.mode() & 0o7777;
            if directory_mode != 0o500 && directory_mode != 0o700 {
                return Err(InstallError::CorruptStore);
            }
            private(&directory, true, directory_mode)?;
            let directory_id = filesystem::identity(&directory)?;
            let names = filesystem::directory_names(
                &directory,
                || {
                    if authorized() {
                        Ok(())
                    } else {
                        Err(HostError::AuthorityRevoked)
                    }
                },
                2,
            )?;
            if names != ["package", "receipt.json"] {
                return Err(InstallError::CorruptStore);
            }
            let package = filesystem::open_child(&directory, OsStr::new("package"), true)?;
            private(&package, true, 0o500)?;
            let package_id = filesystem::identity(&package)?;
            let receipt_file =
                filesystem::open_child(&directory, OsStr::new("receipt.json"), false)?;
            let receipt_bytes = read_receipt(&receipt_file)?;
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
            self.check(authorized)?;
            same_file(&self.objects, OsStr::new(digest), true, object.directory_id)?;
            private(&object.directory, true, object.directory_mode)?;
            same_file(
                &object.directory,
                OsStr::new("package"),
                true,
                object.package_id,
            )?;
            same_file(
                &object.directory,
                OsStr::new("receipt.json"),
                false,
                filesystem::identity(&object.receipt_file)?,
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
            let names = self.names(authorized)?;
            let receipt = InstallReceipt {
                format_version: RECEIPT_VERSION,
                action_id: action_id.into(),
                plugin: package.plugin().clone(),
                package_digest: package.package_digest().into(),
                origin: package.origin().clone(),
            };
            receipt.validate()?;
            let mut seen_actions = BTreeSet::new();
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
            let mut directories = BTreeMap::new();
            directories.insert(
                String::new(),
                package.try_clone().map_err(|_| InstallError::Io)?,
            );
            for (path, captured) in image.files.iter() {
                let parts: Vec<_> = path.split('/').collect();
                if parts.len() - 1 > MAX_DEPTH {
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
                        if directories.len() >= MAX_DIRECTORIES {
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
            self.write_file(
                package,
                "manifest.json",
                &image.manifest_bytes,
                false,
                candidate,
                candidate_id,
                authorized,
            )?;
            // Descendants first, then their parents. Every entry and final
            // private read-only mode is synced before the candidate is sealed.
            let mut keys: Vec<_> = directories.keys().cloned().collect();
            keys.sort_by_key(|key| std::cmp::Reverse(key.len()));
            for key in keys {
                self.check_candidate(candidate, candidate_id, authorized)?;
                chmod(&directories[&key], 0o500)?;
                sync(&directories[&key])?;
            }
            Ok(())
        }

        fn inspect_package(
            &self,
            package: &File,
            authorized: &impl Fn() -> bool,
            synchronize: bool,
        ) -> InstallResult<()> {
            fn walk(
                store: &Store,
                directory: &File,
                depth: usize,
                count: &mut usize,
                authorized: &impl Fn() -> bool,
                synchronize: bool,
            ) -> InstallResult<()> {
                store.check(authorized)?;
                *count += 1;
                if depth > MAX_DEPTH || *count > MAX_DIRECTORIES + super::super::MAX_FILES + 2 {
                    return Err(InstallError::CorruptStore);
                }
                private(directory, true, 0o500)?;
                for child in filesystem::directory_names(
                    directory,
                    || {
                        if authorized() {
                            Ok(())
                        } else {
                            Err(HostError::AuthorityRevoked)
                        }
                    },
                    super::super::MAX_FILES + MAX_DIRECTORIES + 1,
                )? {
                    store.check(authorized)?;
                    let file = filesystem::open_entry(directory, OsStr::new(&child))?;
                    if metadata(&file)?.is_dir() {
                        walk(store, &file, depth + 1, count, authorized, synchronize)?;
                    } else {
                        let mode = metadata(&file)?.mode() & 0o7777;
                        if mode != 0o400 && mode != 0o500 {
                            return Err(InstallError::CorruptStore);
                        }
                        private(&file, false, mode)?;
                        if synchronize {
                            sync(&file)?;
                        }
                        *count += 1;
                        if *count > MAX_DIRECTORIES + super::super::MAX_FILES + 2 {
                            return Err(InstallError::CorruptStore);
                        }
                    }
                }
                if synchronize {
                    sync(directory)?;
                }
                Ok(())
            }
            let mut count = 0;
            walk(self, package, 0, &mut count, authorized, synchronize)
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
            if object.directory_mode == 0o700 {
                #[cfg(test)]
                if self.fail_commit_checkpoint == Some(CommitCheckpoint::Seal) {
                    return Err(InstallError::Io);
                }
                chmod(&object.directory, 0o500)?;
                object.directory_mode = 0o500;
            }
            private(&object.directory, true, 0o500)?;
            sync(&object.directory)?;
            self.check_object(&object.receipt.package_digest, object, authorized)
        }

        fn sync_installed_parents(&self, authorized: &impl Fn() -> bool) -> InstallResult<()> {
            self.check(authorized)?;
            #[cfg(test)]
            if self.fail_commit_checkpoint == Some(CommitCheckpoint::ObjectsSync) {
                return Err(InstallError::Io);
            }
            sync(&self.objects)?;
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
