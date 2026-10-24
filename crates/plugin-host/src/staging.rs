//! Owned ephemeral materialization through the shared descriptor IO primitives.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use tsumugi_plugin_sdk::RuntimeArtifactFile;

use crate::{CapturedRuntime, HostError, HostResult};

/// An exclusive instance namespace. Cleanup needs a confirmed child reap and
/// unchanged directory identities; callers retain it with `keep` otherwise.
#[derive(Debug)]
pub(crate) struct StagedDirectory {
    path: PathBuf,
    cleanup: bool,
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    owned: platform::OwnedDirectory,
}

impl StagedDirectory {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Retain bytes when the process lifetime or namespace binding is unknown.
    pub(crate) fn keep(mut self) -> PathBuf {
        self.cleanup = false;
        self.path.clone()
    }

    /// Recheck the namespace before launch. This is observed binding, not an OS
    /// sandbox or an atomic executable-path lock against other same-user code.
    pub(crate) fn verify_binding(&self) -> HostResult<()> {
        #[cfg(any(target_os = "macos", target_os = "linux", windows))]
        {
            self.owned.check_binding()
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        {
            Err(HostError::UnsupportedPlatform)
        }
    }
}

impl Drop for StagedDirectory {
    fn drop(&mut self) {
        #[cfg(any(target_os = "macos", target_os = "linux", windows))]
        if self.cleanup {
            // Unknown entries, replaced paths and failed cleanup are retained.
            // Never recursively delete a newly observed replacement directory.
            let _ = self.owned.remove_owned();
        }
    }
}

pub(crate) fn materialize(
    staging_parent: &Path,
    manifest: &[u8],
    package_files: &BTreeMap<String, RuntimeArtifactFile>,
    runtime: Option<&CapturedRuntime>,
    authorized: impl Fn() -> bool,
) -> HostResult<StagedDirectory> {
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    {
        platform::materialize(staging_parent, manifest, package_files, runtime, authorized)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = (staging_parent, manifest, package_files, runtime, authorized);
        Err(HostError::UnsupportedPlatform)
    }
}

#[cfg(any(target_os = "macos", target_os = "linux", windows))]
mod platform {
    use super::*;
    use crate::{
        filesystem,
        package::{MAX_DEPTH, MAX_DIRECTORIES, portable_path},
    };
    use std::{
        ffi::{OsStr, OsString},
        fs::File,
        io::Write,
        time::{Duration, Instant},
    };

    type Identity = filesystem::Identity;
    const STAGE_TIMEOUT: Duration = Duration::from_secs(60);

    #[derive(Debug)]
    struct OwnedFile {
        identity: Identity,
        length: u64,
        mode: u32,
    }

    #[derive(Debug)]
    pub(super) struct OwnedDirectory {
        parent_path: PathBuf,
        parent: File,
        parent_identity: Identity,
        name: OsString,
        root: File,
        root_identity: Identity,
        directories: BTreeMap<String, Identity>,
        files: BTreeMap<String, OwnedFile>,
        cleanup_deadline: Option<Instant>,
    }

    struct Guard<F> {
        authorized: F,
        deadline: Instant,
    }

    impl<F: Fn() -> bool> Guard<F> {
        fn check(&self) -> HostResult<()> {
            if !(self.authorized)() {
                Err(HostError::AuthorityRevoked)
            } else if Instant::now() >= self.deadline {
                Err(HostError::Timeout)
            } else {
                Ok(())
            }
        }
    }

    fn private_directory(file: &File, expected: Identity) -> HostResult<()> {
        filesystem::verify_private_directory(file, expected)
    }

    fn owned_file(file: &File, expected: Identity) -> HostResult<u64> {
        filesystem::verify_owned_file(file, expected, None)
    }

    fn split(path: &str) -> HostResult<(&str, &str)> {
        path.rsplit_once('/').ok_or(HostError::StageFailed)
    }

    impl OwnedDirectory {
        fn create(parent_path: &Path, deadline: Instant) -> HostResult<StagedDirectory> {
            let (parent_path, parent) = filesystem::open_directory(parent_path)?;
            let parent_identity = filesystem::identity(&parent)?;
            let name = OsString::from(format!("plugin-instance-{}", uuid::Uuid::new_v4()));
            filesystem::create_directory(&parent, &name).map_err(|_| HostError::StageFailed)?;
            let root = filesystem::open_child(&parent, &name, true)?;
            let root_identity = filesystem::identity(&root)?;
            let mut staged = StagedDirectory {
                path: parent_path.join(&name),
                cleanup: true,
                owned: Self {
                    parent_path,
                    parent,
                    parent_identity,
                    name,
                    root,
                    root_identity,
                    directories: BTreeMap::from([(String::new(), root_identity)]),
                    files: BTreeMap::new(),
                    cleanup_deadline: Some(deadline),
                },
            };
            filesystem::set_mode(&staged.owned.root, 0o700).map_err(|_| HostError::StageFailed)?;
            private_directory(&staged.owned.root, root_identity)?;
            staged.owned.check_binding()?;
            // Cleanup is now guarded by the identities of both held directories.
            staged.cleanup = true;
            Ok(staged)
        }

        pub(super) fn check_binding(&self) -> HostResult<()> {
            let (_, parent) = filesystem::open_directory(&self.parent_path)
                .map_err(|_| HostError::StageFailed)?;
            if filesystem::identity(&parent)? != self.parent_identity
                || filesystem::identity(&self.parent)? != self.parent_identity
            {
                return Err(HostError::StageFailed);
            }
            let root = filesystem::open_child(&self.parent, &self.name, true)
                .map_err(|_| HostError::StageFailed)?;
            private_directory(&root, self.root_identity)?;
            private_directory(&self.root, self.root_identity)
        }

        fn open_directory(&self, relative: &str) -> HostResult<File> {
            let mut held = self.root.try_clone().map_err(|_| HostError::StageFailed)?;
            private_directory(&held, self.root_identity)?;
            if relative.is_empty() {
                return Ok(held);
            }
            let mut prefix = String::new();
            for part in relative.split('/') {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                let expected = self
                    .directories
                    .get(&prefix)
                    .ok_or(HostError::StageFailed)?;
                let child = filesystem::open_child(&held, OsStr::new(part), true)
                    .map_err(|_| HostError::StageFailed)?;
                private_directory(&child, *expected)?;
                held = child;
            }
            Ok(held)
        }

        fn create_directory(
            &mut self,
            relative: &str,
            guard: &Guard<impl Fn() -> bool>,
        ) -> HostResult<()> {
            guard.check()?;
            self.check_binding()?;
            let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative));
            let held_parent = self.open_directory(parent)?;
            filesystem::create_directory(&held_parent, OsStr::new(name))
                .map_err(|_| HostError::StageFailed)?;
            let child = filesystem::open_child(&held_parent, OsStr::new(name), true)?;
            let identity = filesystem::identity(&child)?;
            self.directories.insert(relative.into(), identity);
            filesystem::set_mode(&child, 0o700).map_err(|_| HostError::StageFailed)?;
            private_directory(&child, identity)?;
            guard.check()?;
            self.check_binding()
        }

        fn write_file(
            &mut self,
            relative: &str,
            bytes: &[u8],
            executable: bool,
            guard: &Guard<impl Fn() -> bool>,
        ) -> HostResult<()> {
            guard.check()?;
            self.check_binding()?;
            let (parent, name) = split(relative)?;
            let held_parent = self.open_directory(parent)?;
            let mut file = filesystem::create_file(&held_parent, OsStr::new(name))
                .map_err(|_| HostError::StageFailed)?;
            let identity = filesystem::identity(&file)?;
            let mode = if executable { 0o500 } else { 0o400 };
            self.files.insert(
                relative.into(),
                OwnedFile {
                    identity,
                    length: bytes.len() as u64,
                    mode,
                },
            );
            owned_file(&file, identity)?;
            filesystem::set_mode(&file, 0o600).map_err(|_| HostError::StageFailed)?;
            for chunk in bytes.chunks(64 * 1024) {
                guard.check()?;
                file.write_all(chunk).map_err(|_| HostError::StageFailed)?;
            }
            guard.check()?;
            file.sync_all().map_err(|_| HostError::StageFailed)?;
            guard.check()?;
            filesystem::set_mode(&file, mode).map_err(|_| HostError::StageFailed)?;
            file.sync_all().map_err(|_| HostError::StageFailed)?;
            guard.check()?;
            self.verify_file(relative)?;
            self.check_binding()
        }

        fn write_tree(
            &mut self,
            base: &str,
            files: &BTreeMap<String, RuntimeArtifactFile>,
            package_profile: bool,
            guard: &Guard<impl Fn() -> bool>,
        ) -> HostResult<()> {
            let mut directory_count = 1usize;
            for (name, file) in files {
                guard.check()?;
                portable_path(name)?;
                let parts: Vec<_> = name.split('/').collect();
                if package_profile && parts.len() - 1 > MAX_DEPTH {
                    return Err(HostError::PackageLimit);
                }
                let mut parent = base.to_owned();
                for part in &parts[..parts.len() - 1] {
                    parent.push('/');
                    parent.push_str(part);
                    if !self.directories.contains_key(&parent) {
                        directory_count += 1;
                        if package_profile && directory_count > MAX_DIRECTORIES {
                            return Err(HostError::PackageLimit);
                        }
                        // Runtime trees already satisfy their capture owner's
                        // bounds. Do not introduce a separate runtime profile.
                        self.create_directory(&parent, guard)?;
                    }
                }
                self.write_file(
                    &format!("{base}/{name}"),
                    &file.bytes,
                    file.executable,
                    guard,
                )?;
            }
            Ok(())
        }

        fn verify_file(&self, relative: &str) -> HostResult<()> {
            let expected = self.files.get(relative).ok_or(HostError::StageFailed)?;
            let (parent, name) = split(relative)?;
            let parent = self.open_directory(parent)?;
            let file = filesystem::open_child(&parent, OsStr::new(name), false)
                .map_err(|_| HostError::StageFailed)?;
            let length =
                filesystem::verify_owned_file(&file, expected.identity, Some(expected.mode))?;
            if length != expected.length {
                return Err(HostError::StageFailed);
            }
            Ok(())
        }

        pub(super) fn remove_owned(&self) -> HostResult<()> {
            // Failed materialization uses its remaining operation budget. A
            // later reaped session has a separate bounded cleanup lifetime.
            let deadline = self
                .cleanup_deadline
                .unwrap_or_else(|| Instant::now() + STAGE_TIMEOUT);
            self.check_binding()?;
            // Operate only on recorded identities. Plugin-created or replaced
            // entries are not adopted into the cleanup set; rmdir will retain a
            // nonempty namespace instead of deleting unknown contents.
            for (relative, file) in &self.files {
                if Instant::now() >= deadline {
                    return Err(HostError::Timeout);
                }
                self.check_binding()?;
                let (parent, name) = split(relative)?;
                let parent = self.open_directory(parent)?;
                let held = filesystem::open_child(&parent, OsStr::new(name), false)
                    .map_err(|_| HostError::StageFailed)?;
                owned_file(&held, file.identity)?;
                filesystem::remove_recorded_child(&parent, OsStr::new(name), false, file.identity)
                    .map_err(|_| HostError::StageFailed)?;
            }
            let mut directories: Vec<_> = self
                .directories
                .keys()
                .filter(|path| !path.is_empty())
                .collect();
            directories.sort_by_key(|path| std::cmp::Reverse(path.split('/').count()));
            for relative in directories {
                if Instant::now() >= deadline {
                    return Err(HostError::Timeout);
                }
                self.check_binding()?;
                let (parent, name) = relative.rsplit_once('/').unwrap_or(("", relative.as_str()));
                let held_parent = self.open_directory(parent)?;
                let child = filesystem::open_child(&held_parent, OsStr::new(name), true)
                    .map_err(|_| HostError::StageFailed)?;
                private_directory(&child, self.directories[relative])?;
                filesystem::remove_recorded_child(
                    &held_parent,
                    OsStr::new(name),
                    true,
                    self.directories[relative],
                )
                .map_err(|_| HostError::StageFailed)?;
            }
            if Instant::now() >= deadline {
                return Err(HostError::Timeout);
            }
            self.check_binding()?;
            filesystem::remove_recorded_child(&self.parent, &self.name, true, self.root_identity)
                .map_err(|_| HostError::StageFailed)
        }
    }

    pub(super) fn materialize(
        staging_parent: &Path,
        manifest: &[u8],
        package_files: &BTreeMap<String, RuntimeArtifactFile>,
        runtime: Option<&CapturedRuntime>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<StagedDirectory> {
        materialize_runtime(
            staging_parent,
            manifest,
            package_files,
            runtime,
            false,
            authorized,
        )
    }

    pub(super) fn materialize_runtime(
        staging_parent: &Path,
        manifest: &[u8],
        package_files: &BTreeMap<String, RuntimeArtifactFile>,
        runtime: Option<&CapturedRuntime>,
        tool_only: bool,
        authorized: impl Fn() -> bool,
    ) -> HostResult<StagedDirectory> {
        let guard = Guard {
            authorized,
            deadline: Instant::now() + STAGE_TIMEOUT,
        };
        guard.check()?;
        let mut staged = OwnedDirectory::create(staging_parent, guard.deadline)?;
        guard.check()?;
        staged.owned.create_directory("package", &guard)?;
        staged
            .owned
            .write_file("package/manifest.json", manifest, false, &guard)?;
        staged
            .owned
            .write_tree("package", package_files, true, &guard)?;
        if let Some(runtime) = runtime {
            staged.owned.create_directory("runtime", &guard)?;
            staged.owned.create_directory("runtime/tool", &guard)?;
            staged
                .owned
                .write_tree("runtime/tool", runtime.tool_files(), false, &guard)?;
            if !tool_only {
                staged.owned.create_directory("runtime/host", &guard)?;
                staged
                    .owned
                    .write_tree("runtime/host", runtime.host_files(), false, &guard)?;
            }
        }
        for relative in staged.owned.directories.keys() {
            guard.check()?;
            staged.owned.open_directory(relative)?;
        }
        for relative in staged.owned.files.keys() {
            guard.check()?;
            staged.owned.verify_file(relative)?;
        }
        guard.check()?;
        staged.verify_binding()?;
        guard.check()?;
        staged.owned.cleanup_deadline = None;
        Ok(staged)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;

        fn parent(temporary: &tempfile::TempDir) -> PathBuf {
            let path = temporary.path().join("staging");
            fs::create_dir(&path).unwrap();
            let (_, directory) = filesystem::open_directory(&path).unwrap();
            filesystem::set_mode(&directory, 0o700).unwrap();
            path
        }

        fn stage(parent: &Path) -> StagedDirectory {
            let files = BTreeMap::from([(
                "resource.bin".into(),
                RuntimeArtifactFile {
                    bytes: vec![0, 255, 13, 10],
                    executable: false,
                },
            )]);
            materialize(parent, b"{}", &files, None, || true).unwrap()
        }

        #[test]
        fn normal_drop_removes_only_its_owned_instance() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let unrelated = parent.join("unrelated.txt");
            fs::write(&unrelated, b"preserved").unwrap();
            let directory = stage(&parent);
            let path = directory.path().to_owned();
            assert_eq!(
                fs::read(path.join("package/resource.bin")).unwrap(),
                [0, 255, 13, 10]
            );
            #[cfg(unix)]
            {
                assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o700);
                assert_eq!(
                    fs::metadata(path.join("package")).unwrap().mode() & 0o7777,
                    0o700
                );
                assert_eq!(
                    fs::metadata(path.join("package/resource.bin"))
                        .unwrap()
                        .mode()
                        & 0o7777,
                    0o400
                );
            }
            drop(directory);
            assert!(!path.exists());
            assert_eq!(fs::read(&unrelated).unwrap(), b"preserved");
        }

        #[test]
        fn replaced_root_is_retained_and_never_cleaned_as_the_original() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let directory = stage(&parent);
            let path = directory.path().to_owned();
            let moved = parent.join("moved-instance");
            fs::rename(&path, &moved).unwrap();
            fs::create_dir(&path).unwrap();
            fs::write(path.join("sentinel.txt"), b"replacement").unwrap();
            assert_eq!(directory.verify_binding(), Err(HostError::StageFailed));
            drop(directory);
            assert_eq!(fs::read(path.join("sentinel.txt")).unwrap(), b"replacement");
            assert!(moved.join("package/resource.bin").exists());
        }

        #[test]
        fn replaced_parent_cannot_redirect_cleanup_to_a_new_instance() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let directory = stage(&parent);
            let name = directory.path().file_name().unwrap().to_owned();
            let moved = temporary.path().join("moved-parent");
            fs::rename(&parent, &moved).unwrap();
            fs::create_dir(&parent).unwrap();
            let replacement = parent.join(&name);
            fs::create_dir(&replacement).unwrap();
            fs::write(replacement.join("sentinel.txt"), b"replacement").unwrap();
            assert_eq!(directory.verify_binding(), Err(HostError::StageFailed));
            drop(directory);
            assert_eq!(
                fs::read(replacement.join("sentinel.txt")).unwrap(),
                b"replacement"
            );
            assert!(moved.join(name).join("package/resource.bin").exists());
        }

        #[test]
        fn revocation_after_file_creation_cleans_the_partial_owned_tree() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let files = BTreeMap::from([(
                "resource.bin".into(),
                RuntimeArtifactFile {
                    bytes: vec![0; 128 * 1024],
                    executable: false,
                },
            )]);
            let result = materialize(&parent, b"{}", &files, None, || {
                !fs::read_dir(&parent)
                    .unwrap()
                    .any(|entry| entry.unwrap().path().join("package/resource.bin").exists())
            });
            assert!(matches!(result, Err(HostError::AuthorityRevoked)));
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
        }

        #[test]
        fn captured_flags_control_permissions_independently_of_file_names() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let files = BTreeMap::from([
                (
                    "tool.bin".into(),
                    RuntimeArtifactFile {
                        bytes: b"tool".to_vec(),
                        executable: true,
                    },
                ),
                (
                    "resource.exe".into(),
                    RuntimeArtifactFile {
                        bytes: b"data".to_vec(),
                        executable: false,
                    },
                ),
            ]);
            let directory = materialize(&parent, b"{}", &files, None, || true).unwrap();
            for (name, mode) in [("tool.bin", 0o500), ("resource.exe", 0o400)] {
                let recorded = &directory.owned.files[&format!("package/{name}")];
                let (_, held_parent) =
                    filesystem::open_directory(&directory.path().join("package")).unwrap();
                let file = filesystem::open_child(&held_parent, OsStr::new(name), false).unwrap();
                assert_eq!(
                    filesystem::verify_owned_file(&file, recorded.identity, Some(mode)),
                    Ok(4)
                );
            }
            let path = directory.path().to_owned();
            drop(directory);
            assert!(!path.exists());
        }

        #[test]
        fn an_unknown_child_prevents_removing_its_owned_namespace() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let directory = stage(&parent);
            let path = directory.path().to_owned();
            fs::write(path.join("package/unrecorded.bin"), b"retain").unwrap();
            drop(directory);
            assert_eq!(
                fs::read(path.join("package/unrecorded.bin")).unwrap(),
                b"retain"
            );
            assert!(!path.join("package/resource.bin").exists());
        }

        #[test]
        fn explicit_keep_preserves_the_complete_materialization() {
            let temporary = tempfile::tempdir().unwrap();
            let parent = parent(&temporary);
            let path = stage(&parent).keep();
            assert_eq!(
                fs::read(path.join("package/resource.bin")).unwrap(),
                [0, 255, 13, 10]
            );
        }
    }
}
