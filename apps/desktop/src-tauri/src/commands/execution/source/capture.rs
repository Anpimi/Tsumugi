//! Authorized, bounded reads. No input path from an IPC payload reaches this module.
#[cfg(windows)]
use std::fs::OpenOptions;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tsumugi_core::{
    content::SourceBundle,
    execution::{Cancellation, ErrorCode, ExecutionError, ExecutionId},
};

#[cfg(any(test, feature = "execution-test-host"))]
use tsumugi_core::content::{self, MAX_MANIFEST_BYTES, MAX_SOURCE_BYTES, TranslationBundle};

mod destination;
pub(crate) use destination::Destination;

fn error(code: ErrorCode, reason: &str) -> ExecutionError {
    ExecutionError::new(code, reason)
}
fn io(error: std::io::Error) -> ExecutionError {
    if cfg!(windows) && error.raw_os_error() == Some(32) {
        self::error(ErrorCode::Busy, "input-busy")
    } else if error.kind() == std::io::ErrorKind::NotFound {
        self::error(ErrorCode::InvalidInput, "missing-companion")
    } else {
        self::error(ErrorCode::InvalidInput, "unauthorized-selection")
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        GetFileInformationByHandle, GetFinalPathNameByHandleW,
    };
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct Identity(pub u32, pub u32, pub u32);
    pub fn identity(file: &File) -> Result<Identity, ExecutionError> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // The borrowed handle remains live for this call; Windows fills a fixed-size value.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        Ok(Identity(
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ))
    }
    pub fn final_path(file: &File) -> Result<PathBuf, ExecutionError> {
        let mut buffer = vec![0u16; 32768];
        // The buffer is initialized, writable, and its length is passed unchanged.
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        };
        if len == 0 || len as usize >= buffer.len() {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        use std::os::windows::ffi::OsStringExt;
        Ok(PathBuf::from(std::ffi::OsString::from_wide(
            &buffer[..len as usize],
        )))
    }
    pub fn open(path: &Path, directory: bool) -> Result<File, ExecutionError> {
        let metadata = fs::symlink_metadata(path).map_err(io)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || metadata.is_dir() != directory
            || (!directory && !metadata.is_file())
        {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        let mut options = OpenOptions::new();
        if directory {
            options.access_mode(FILE_READ_ATTRIBUTES);
        } else {
            options.read(true);
        }
        let file = options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(
                FILE_FLAG_OPEN_REPARSE_POINT
                    | if directory {
                        FILE_FLAG_BACKUP_SEMANTICS
                    } else {
                        0
                    },
            )
            .open(path)
            .map_err(io)?;
        identity(&file)?;
        if file.metadata().map_err(io)?.is_dir() != directory {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        Ok(file)
    }
}

#[cfg(target_os = "macos")]
#[path = "capture/macos.rs"]
pub(crate) mod platform;

#[cfg(any(windows, target_os = "macos"))]
pub struct Selection {
    #[cfg(any(test, feature = "execution-test-host"))]
    webvtt: bool,
    root: PathBuf,
    root_file: File,
    identity: platform::Identity,
    _ancestors: Vec<File>,
}
#[cfg(any(windows, target_os = "macos"))]
impl Selection {
    pub fn authorize(path: PathBuf) -> Result<Self, ExecutionError> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        #[cfg(target_os = "macos")]
        let path = platform::system_path(&path);
        let mut ancestors = Vec::new();
        for ancestor in path.ancestors().skip(1) {
            ancestors.push(platform::open(ancestor, true)?);
        }
        let root_file = platform::open(&path, true)?;
        let root = platform::final_path(&root_file)?;
        let identity = platform::identity(&root_file)?;
        Ok(Self {
            #[cfg(any(test, feature = "execution-test-host"))]
            webvtt: false,
            root,
            root_file,
            identity,
            _ancestors: ancestors,
        })
    }
    pub fn label(&self) -> String {
        self.root
            .file_name()
            .unwrap_or(self.root.as_os_str())
            .to_string_lossy()
            .into()
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn authorize_webvtt(path: PathBuf) -> Result<Self, ExecutionError> {
        let mut selected = Self::authorize(path)?;
        selected.webvtt = true;
        Ok(selected)
    }
    /// Capture only the fixed material recipe from a selected immutable package.
    /// Approval of the root remains a native picker responsibility; neither the
    /// resource nor an IPC string authorizes another directory.
    pub fn capture_declared(
        &self,
        binding: &tsumugi_plugin_sdk::SourceImportBinding,
        language: &str,
        cancel: &Cancellation,
    ) -> Result<SourceBundle, ExecutionError> {
        self.capture_declared_inner(binding, language, cancel, || {})
    }
    fn capture_declared_inner(
        &self,
        binding: &tsumugi_plugin_sdk::SourceImportBinding,
        language: &str,
        cancel: &Cancellation,
        opened: impl FnOnce(),
    ) -> Result<SourceBundle, ExecutionError> {
        binding
            .validate()
            .map_err(|_| error(ErrorCode::InvalidInput, "source-import-binding"))?;
        self.verify()?;
        let started = Instant::now();
        let check = || {
            if cancel.is_requested() {
                Err(error(ErrorCode::Cancelled, "cancelled"))
            } else if started.elapsed() > Duration::from_secs(30) {
                Err(error(ErrorCode::Busy, "capture-timeout"))
            } else {
                Ok(())
            }
        };
        let mut files = Vec::new();
        let mut identities = Vec::new();
        for material in &binding.declaration.materials {
            check()?;
            let path = self.root.join(&material.logical_path);
            let file = platform::open(&path, false)?;
            let identity = platform::identity(&file)?;
            if platform::final_path(&file)? != path || identities.contains(&identity) {
                return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
            }
            identities.push(identity);
            #[cfg(target_os = "macos")]
            let stamp = platform::stamp(&file)?;
            files.push((
                path,
                file,
                material.max_bytes as usize,
                #[cfg(target_os = "macos")]
                stamp,
            ));
        }
        opened();
        let mut materials = Vec::new();
        for entry in &mut files {
            materials.push(read(&mut entry.1, entry.2, &check)?);
        }
        for (entry, bytes) in files.iter_mut().zip(&materials) {
            if *bytes != read(&mut entry.1, entry.2, &check)?
                || platform::final_path(&entry.1)? != entry.0
            {
                return Err(error(ErrorCode::DependencyConflict, "source-changed"));
            }
            #[cfg(target_os = "macos")]
            platform::verify_file(&entry.1, &entry.0, entry.3)?;
        }
        self.verify()?;
        let bundle = SourceBundle::capture_declared(binding, materials, language)?;
        check()?;
        Ok(bundle)
    }
    pub(crate) fn destination_root(&self) -> Result<&Path, ExecutionError> {
        self.verify()?;
        Ok(&self.root)
    }
    /// Recorded selection identity for project-thread metadata comparisons.
    /// Actual filesystem work must still verify the held selection on the IO worker.
    pub(crate) fn destination_path(&self) -> &Path {
        &self.root
    }
    /// List immediate non-directory names with the declared suffix. Capture
    /// still checks each actual file; names do not authorize links or aliases.
    pub fn declared_translation_files(
        &self,
        binding: &tsumugi_plugin_sdk::TranslationImportBinding,
    ) -> Result<Vec<String>, ExecutionError> {
        binding
            .validate()
            .map_err(|_| error(ErrorCode::InvalidInput, "translation-import-binding"))?;
        self.translation_file_listing(
            &binding.declaration.material.logical_directory,
            &binding.declaration.material.extension,
        )
    }
    fn translation_file_listing(
        &self,
        directory: &str,
        extension: &str,
    ) -> Result<Vec<String>, ExecutionError> {
        self.verify()?;
        let path = self.root.join(directory);
        let held = platform::open(&path, true)?;
        if platform::final_path(&held)? != path {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        let entries = listing(&path, &|| Ok(()))?;
        if platform::identity(&platform::open(&path, true)?)? != platform::identity(&held)? {
            return Err(error(ErrorCode::DependencyConflict, "source-changed"));
        }
        self.verify()?;
        let suffix = format!(".{extension}");
        Ok(entries
            .into_iter()
            .filter(|(name, directory)| {
                !directory && name.len() > suffix.len() && name.ends_with(&suffix)
            })
            .map(|(name, _)| name)
            .collect())
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn translation_files(&self) -> Result<Vec<String>, ExecutionError> {
        Ok(self
            .translation_file_listing("i18n", "json")?
            .into_iter()
            .filter(|name| content::declared_locale(&format!("i18n/{name}")).is_ok())
            .collect())
    }
    /// Capture exact UTF-8 bytes under the held native selection. No JSON,
    /// filename language or native-key interpretation happens in this boundary.
    pub fn capture_declared_translation(
        &self,
        binding: &tsumugi_plugin_sdk::TranslationImportBinding,
        file_name: &str,
        cancel: &Cancellation,
    ) -> Result<tsumugi_plugin_sdk::CapturedTextArtifact, ExecutionError> {
        binding
            .validate()
            .map_err(|_| error(ErrorCode::InvalidInput, "translation-import-binding"))?;
        let material = &binding.declaration.material;
        tsumugi_plugin_sdk::validate_portable_package_path(file_name)
            .map_err(|_| error(ErrorCode::Unauthorized, "unauthorized-selection"))?;
        if file_name.contains('/')
            || !file_name.ends_with(&format!(".{}", material.extension))
            || file_name.len() <= material.extension.len() + 1
        {
            return Err(error(ErrorCode::InvalidInput, "translation-file"));
        }
        let bytes = self.capture_translation_material_inner(
            &material.logical_directory,
            file_name,
            material.max_bytes as usize,
            cancel,
            || {},
        )?;
        let utf8 = String::from_utf8(bytes)
            .map_err(|_| error(ErrorCode::InvalidInput, "unsupported-encoding"))?;
        Ok(tsumugi_plugin_sdk::CapturedTextArtifact {
            id: ExecutionId::new().to_string(),
            logical_path: format!("{}/{file_name}", material.logical_directory),
            role: material.role.clone(),
            sha256: tsumugi_plugin_sdk::payload_digest(&utf8),
            utf8,
        })
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn capture_translation(
        &self,
        file_name: &str,
        target_locale: &str,
        source_snapshot_id: ExecutionId,
        cancel: &Cancellation,
    ) -> Result<TranslationBundle, ExecutionError> {
        self.capture_translation_inner(file_name, target_locale, source_snapshot_id, cancel, || {})
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    fn capture_translation_inner(
        &self,
        file_name: &str,
        target_locale: &str,
        source_snapshot_id: ExecutionId,
        cancel: &Cancellation,
        opened: impl FnOnce(),
    ) -> Result<TranslationBundle, ExecutionError> {
        let logical_path = format!("i18n/{file_name}");
        content::declared_locale(&logical_path)?;
        let bytes = self.capture_translation_material_inner(
            "i18n",
            file_name,
            MAX_SOURCE_BYTES,
            cancel,
            opened,
        )?;
        TranslationBundle::capture(&logical_path, &bytes, target_locale, source_snapshot_id)
    }
    fn capture_translation_material_inner(
        &self,
        directory: &str,
        file_name: &str,
        limit: usize,
        cancel: &Cancellation,
        opened: impl FnOnce(),
    ) -> Result<Vec<u8>, ExecutionError> {
        self.verify()?;
        let started = Instant::now();
        let check = || {
            if cancel.is_requested() {
                Err(error(ErrorCode::Cancelled, "cancelled"))
            } else if started.elapsed() > Duration::from_secs(30) {
                Err(error(ErrorCode::Busy, "capture-timeout"))
            } else {
                Ok(())
            }
        };
        let i18n_path = self.root.join(directory);
        let i18n = platform::open(&i18n_path, true)?;
        if platform::final_path(&i18n)? != i18n_path {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        let before = listing(&i18n_path, &check)?;
        let path = i18n_path.join(file_name);
        let mut file = platform::open(&path, false)?;
        if platform::final_path(&file)? != path {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        #[cfg(target_os = "macos")]
        let stamp = platform::stamp(&file)?;
        opened();
        let bytes = read(&mut file, limit, &check)?;
        if bytes != read(&mut file, limit, &check)?
            || before != listing(&i18n_path, &check)?
            || platform::identity(&platform::open(&i18n_path, true)?)? != platform::identity(&i18n)?
        {
            return Err(error(ErrorCode::DependencyConflict, "source-changed"));
        }
        #[cfg(target_os = "macos")]
        platform::verify_file(&file, &path, stamp)?;
        self.verify()?;
        Ok(bytes)
    }
    fn verify(&self) -> Result<(), ExecutionError> {
        if platform::identity(&self.root_file)? != self.identity
            || platform::final_path(&self.root_file)? != self.root
            || platform::identity(&platform::open(&self.root, true)?)? != self.identity
        {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        Ok(())
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn capture(
        &self,
        language: &str,
        cancel: &Cancellation,
    ) -> Result<SourceBundle, ExecutionError> {
        self.capture_inner(language, cancel, || {})
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    fn capture_inner(
        &self,
        language: &str,
        cancel: &Cancellation,
        opened: impl FnOnce(),
    ) -> Result<SourceBundle, ExecutionError> {
        self.verify()?;
        if self.webvtt {
            let path = self.root.join(content::webvtt::PATH);
            let mut file = platform::open(&path, false)?;
            if platform::final_path(&file)? != path {
                return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
            }
            let started = Instant::now();
            let check = || {
                if cancel.is_requested() {
                    Err(error(ErrorCode::Cancelled, "cancelled"))
                } else if started.elapsed() > Duration::from_secs(30) {
                    Err(error(ErrorCode::Busy, "capture-timeout"))
                } else {
                    Ok(())
                }
            };
            #[cfg(target_os = "macos")]
            let stamp = platform::stamp(&file)?;
            opened();
            check()?;
            let bytes = read(&mut file, MAX_SOURCE_BYTES, &check)?;
            if bytes != read(&mut file, MAX_SOURCE_BYTES, &check)? {
                return Err(error(ErrorCode::DependencyConflict, "source-changed"));
            }
            #[cfg(target_os = "macos")]
            platform::verify_file(&file, &path, stamp)?;
            self.verify()?;
            return SourceBundle::capture_webvtt(&bytes, language);
        }
        let started = Instant::now();
        let check = || {
            if cancel.is_requested() {
                Err(error(ErrorCode::Cancelled, "cancelled"))
            } else if started.elapsed() > Duration::from_secs(30) {
                Err(error(ErrorCode::Busy, "capture-timeout"))
            } else {
                Ok(())
            }
        };
        check()?;
        let i18n_path = self.root.join("i18n");
        let i18n = platform::open(&i18n_path, true)?;
        if platform::final_path(&i18n)? != i18n_path {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        let before = listing(&i18n_path, &check)?;
        if before
            .iter()
            .any(|(name, dir)| name.eq_ignore_ascii_case("default") && *dir)
        {
            return Err(error(ErrorCode::InvalidInput, "unsupported-format"));
        }
        let root_before = listing(&self.root, &check)?;
        let mut manifest = platform::open(&self.root.join("manifest.json"), false)?;
        let mut source = platform::open(&i18n_path.join("default.json"), false)?;
        if platform::final_path(&manifest)? != self.root.join("manifest.json")
            || platform::final_path(&source)? != i18n_path.join("default.json")
            || platform::identity(&manifest)? == platform::identity(&source)?
        {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        // Windows holds share-denying handles; macOS validates identity and change
        // stamps around both reads because POSIX locks do not exclude other writers.
        #[cfg(target_os = "macos")]
        let stamps = (platform::stamp(&manifest)?, platform::stamp(&source)?);
        opened();
        check()?;
        let manifest_bytes = read(&mut manifest, MAX_MANIFEST_BYTES, &check)?;
        let source_bytes = read(&mut source, MAX_SOURCE_BYTES, &check)?;
        check()?;
        if before != listing(&i18n_path, &check)?
            || root_before != listing(&self.root, &check)?
            || manifest_bytes != read(&mut manifest, MAX_MANIFEST_BYTES, &check)?
            || source_bytes != read(&mut source, MAX_SOURCE_BYTES, &check)?
        {
            return Err(error(ErrorCode::DependencyConflict, "source-changed"));
        }
        #[cfg(target_os = "macos")]
        {
            platform::verify_file(&manifest, &self.root.join("manifest.json"), stamps.0)?;
            platform::verify_file(&source, &i18n_path.join("default.json"), stamps.1)?;
        }
        self.verify()?;
        SourceBundle::capture(&manifest_bytes, &source_bytes, language)
    }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod translation_import_tests {
    use super::*;

    fn binding() -> tsumugi_plugin_sdk::TranslationImportBinding {
        let manifest = tsumugi_plugin_sdk::parse_manifest(include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.manifest.json"
        ))
        .unwrap();
        let mut declaration = tsumugi_plugin_sdk::parse_translation_import_declaration(include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/translation-import.declaration.json"
        )).unwrap();
        declaration.material.logical_directory = "localized/records".into();
        declaration.material.extension = "txt".into();
        declaration.bind(&manifest, &"a".repeat(64)).unwrap()
    }
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("localized/records")).unwrap();
        root
    }

    #[test]
    fn declared_translation_capture_preserves_raw_bytes_without_interpreting_names_or_text() {
        let root = fixture();
        let raw = "\u{feff}// uninterpreted 中文 👩🏽‍💻 é\r\nopaque text\r\n";
        fs::write(root.path().join("localized/records/not-a-locale.txt"), raw).unwrap();
        fs::write(
            root.path().join("localized/records/default.txt"),
            b"domain must decide",
        )
        .unwrap();
        fs::write(
            root.path().join("localized/records/ignored.json"),
            b"excluded",
        )
        .unwrap();
        fs::create_dir(root.path().join("localized/records/folder.txt")).unwrap();
        let selected = Selection::authorize(root.path().into()).unwrap();
        let binding = binding();
        assert_eq!(
            selected.declared_translation_files(&binding).unwrap(),
            vec!["default.txt", "not-a-locale.txt"]
        );
        let captured = selected
            .capture_declared_translation(&binding, "not-a-locale.txt", &Cancellation::default())
            .unwrap();
        assert_eq!(captured.logical_path, "localized/records/not-a-locale.txt");
        assert_eq!(captured.role, binding.declaration.material.role);
        assert_eq!(captured.utf8.as_bytes(), raw.as_bytes());
        assert_eq!(captured.sha256, tsumugi_plugin_sdk::payload_digest(raw));
        assert_eq!(
            fs::read(root.path().join(&captured.logical_path)).unwrap(),
            raw.as_bytes()
        );
    }

    #[test]
    fn declared_translation_capture_enforces_whole_file_n_and_n_plus_one_limit() {
        let root = fixture();
        let binding = binding();
        let path = root.path().join("localized/records/limit.txt");
        let raw = "x".repeat(binding.declaration.material.max_bytes as usize);
        fs::write(&path, &raw).unwrap();
        let selected = Selection::authorize(root.path().into()).unwrap();
        assert_eq!(
            selected
                .capture_declared_translation(&binding, "limit.txt", &Cancellation::default())
                .unwrap()
                .utf8,
            raw
        );
        fs::write(&path, format!("{raw}x")).unwrap();
        let error = selected
            .capture_declared_translation(&binding, "limit.txt", &Cancellation::default())
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::LimitExceeded);
        assert_eq!(error.stage, "limit-exceeded");
    }

    #[test]
    fn declared_translation_capture_refuses_cancel_invalid_utf8_and_escaping_or_wrong_suffix_names()
    {
        let root = fixture();
        let binding = binding();
        fs::write(root.path().join("localized/records/text.txt"), b"held").unwrap();
        fs::write(root.path().join("localized/records/invalid.txt"), [0xff]).unwrap();
        let selected = Selection::authorize(root.path().into()).unwrap();
        for name in [
            "../text.txt",
            "nested/text.txt",
            "/text.txt",
            "text.txt\\escape",
            ".txt",
            "text.json",
        ] {
            assert!(
                selected
                    .capture_declared_translation(&binding, name, &Cancellation::default())
                    .is_err(),
                "{name}"
            );
        }
        let cancel = Cancellation::default();
        cancel.request();
        assert_eq!(
            selected
                .capture_declared_translation(&binding, "text.txt", &cancel)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            selected
                .capture_declared_translation(&binding, "invalid.txt", &Cancellation::default())
                .unwrap_err()
                .stage,
            "unsupported-encoding"
        );
        assert_eq!(
            fs::read(root.path().join("localized/records/text.txt")).unwrap(),
            b"held"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn declared_translation_capture_refuses_linked_file_directory_and_changed_open_file() {
        use std::os::unix::fs::symlink;
        let root = fixture();
        let binding = binding();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("external.txt"), b"outside").unwrap();
        symlink(
            outside.path().join("external.txt"),
            root.path().join("localized/records/linked.txt"),
        )
        .unwrap();
        let selected = Selection::authorize(root.path().into()).unwrap();
        assert!(
            selected
                .capture_declared_translation(&binding, "linked.txt", &Cancellation::default())
                .is_err()
        );
        let path = root.path().join("localized/records/changed.txt");
        fs::write(&path, b"before").unwrap();
        let error = selected
            .capture_translation_material_inner(
                "localized/records",
                "changed.txt",
                131072,
                &Cancellation::default(),
                || {
                    fs::write(&path, b"after ").unwrap();
                },
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::DependencyConflict);
        fs::rename(
            root.path().join("localized/records"),
            root.path().join("localized/original"),
        )
        .unwrap();
        symlink(outside.path(), root.path().join("localized/records")).unwrap();
        assert!(selected.declared_translation_files(&binding).is_err());
        assert!(
            selected
                .capture_declared_translation(&binding, "external.txt", &Cancellation::default())
                .is_err()
        );
    }
}
fn listing(
    path: &Path,
    check: &impl Fn() -> Result<(), ExecutionError>,
) -> Result<Vec<(String, bool)>, ExecutionError> {
    let mut entries = Vec::new();
    let mut unique = std::collections::BTreeSet::new();
    for item in fs::read_dir(path).map_err(io)? {
        check()?;
        if entries.len() >= 256 {
            return Err(error(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        let item = item.map_err(io)?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| error(ErrorCode::InvalidInput, "unsupported-encoding"))?;
        if !unique.insert(name.to_ascii_lowercase()) {
            return Err(error(ErrorCode::InvalidInput, "duplicate-native-key"));
        }
        entries.push((name, item.file_type().map_err(io)?.is_dir()));
    }
    entries.sort();
    Ok(entries)
}
fn read(
    file: &mut File,
    limit: usize,
    check: &impl Fn() -> Result<(), ExecutionError>,
) -> Result<Vec<u8>, ExecutionError> {
    if file.metadata().map_err(io)?.len() > limit as u64 {
        return Err(error(ErrorCode::LimitExceeded, "limit-exceeded"));
    }
    file.seek(SeekFrom::Start(0)).map_err(io)?;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        check()?;
        let n = file.read(&mut chunk).map_err(io)?;
        if n == 0 {
            break;
        }
        if bytes.len() + n > limit {
            return Err(error(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    Ok(bytes)
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn read_resource_file(path: &Path) -> Result<Vec<u8>, ExecutionError> {
    read_resource_input(path, "json", 128 * 1024)
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn read_tmx_file(path: &Path) -> Result<Vec<u8>, ExecutionError> {
    read_resource_input(path, "tmx", tsumugi_core::MAX_TMX_INPUT_BYTES)
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn read_tbx_file(path: &Path) -> Result<Vec<u8>, ExecutionError> {
    read_resource_input(path, "tbx", tsumugi_core::MAX_TBX_INPUT_BYTES)
}

#[cfg(any(windows, target_os = "macos"))]
fn read_resource_input(
    path: &Path,
    extension: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    if !path.is_absolute()
        || path.extension().is_none_or(|actual| actual != extension)
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
    }
    #[cfg(target_os = "macos")]
    let normalized = platform::system_path(path);
    #[cfg(target_os = "macos")]
    let path = normalized.as_path();
    let mut ancestors = Vec::new();
    for ancestor in path.ancestors().skip(1) {
        ancestors.push(platform::open(ancestor, true)?);
    }
    let mut file = platform::open(path, false)?;
    let parent = ancestors
        .first()
        .ok_or_else(|| error(ErrorCode::Unauthorized, "unauthorized-selection"))?;
    if platform::final_path(&file)?.parent() != Some(platform::final_path(parent)?.as_path()) {
        return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
    }
    #[cfg(target_os = "macos")]
    let stamp = platform::stamp(&file)?;
    let bytes = read(&mut file, max_bytes, &|| Ok(()))?;
    #[cfg(target_os = "macos")]
    platform::verify_file(&file, path, stamp)?;
    if file.metadata().map_err(io)?.len() != bytes.len() as u64 {
        return Err(error(ErrorCode::DependencyConflict, "input-changed"));
    }
    Ok(bytes)
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn read_resource_file(_: &Path) -> Result<Vec<u8>, ExecutionError> {
    Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn read_tmx_file(_: &Path) -> Result<Vec<u8>, ExecutionError> {
    Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn read_tbx_file(_: &Path) -> Result<Vec<u8>, ExecutionError> {
    Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
}

// Other platforms are not silently given weaker capture guarantees.
#[cfg(not(any(windows, target_os = "macos")))]
pub struct Selection;
#[cfg(not(any(windows, target_os = "macos")))]
impl Selection {
    pub fn authorize(_: PathBuf) -> Result<Self, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn authorize_webvtt(path: PathBuf) -> Result<Self, ExecutionError> {
        Self::authorize(path)
    }
    pub(crate) fn destination_root(&self) -> Result<&Path, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    pub(crate) fn destination_path(&self) -> &Path {
        Path::new("")
    }
    pub fn label(&self) -> String {
        String::new()
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn capture(&self, _: &str, _: &Cancellation) -> Result<SourceBundle, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    pub fn capture_declared(
        &self,
        _: &tsumugi_plugin_sdk::SourceImportBinding,
        _: &str,
        _: &Cancellation,
    ) -> Result<SourceBundle, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    pub fn declared_translation_files(
        &self,
        _: &tsumugi_plugin_sdk::TranslationImportBinding,
    ) -> Result<Vec<String>, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    pub fn capture_declared_translation(
        &self,
        _: &tsumugi_plugin_sdk::TranslationImportBinding,
        _: &str,
        _: &Cancellation,
    ) -> Result<tsumugi_plugin_sdk::CapturedTextArtifact, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn translation_files(&self) -> Result<Vec<String>, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    #[cfg(any(test, feature = "execution-test-host"))]
    pub fn capture_translation(
        &self,
        _: &str,
        _: &str,
        _: ExecutionId,
        _: &Cancellation,
    ) -> Result<TranslationBundle, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn webvtt_capture_keeps_fixed_bytes_and_rejects_cancel_links_and_busy_input() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(content::webvtt::PATH);
        let bytes = include_bytes!("../../../../../../../crates/core/tests/fixtures/webvtt/s1.vtt");
        fs::write(&path, bytes).unwrap();
        let selected = Selection::authorize_webvtt(root.path().into()).unwrap();
        let bundle = selected.capture("en", &Cancellation::default()).unwrap();
        assert_eq!(bundle.files.len(), 1);
        assert_eq!(bundle.files[0].utf8.as_bytes(), bytes);
        let cancel = Cancellation::default();
        cancel.request();
        assert_eq!(
            selected.capture("en", &cancel).unwrap_err().code,
            ErrorCode::Cancelled
        );
        let writer = OpenOptions::new().write(true).open(&path).unwrap();
        assert_eq!(
            selected
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        drop(writer);
        fs::remove_file(&path).unwrap();
        assert_eq!(
            content::extract(&bundle, &Cancellation::default())
                .unwrap()
                .occurrences
                .len(),
            6
        );
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("other.vtt"), bytes).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&path)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(status.status.success(), "junction fixture creation failed");
        assert_eq!(
            selected
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        fs::remove_dir(&path).unwrap();
    }
    #[test]
    fn resource_file_capture_is_bounded_and_uses_an_authorized_read_handle() {
        let root = fixture();
        let path = root.path().join("terms.json");
        let bytes = include_bytes!(
            "../../../../../../../crates/core/tests/fixtures/resource-updates/g1.json"
        );
        fs::write(&path, bytes).unwrap();
        assert_eq!(read_resource_file(&path).unwrap(), bytes);
        let writer = OpenOptions::new().write(true).open(&path).unwrap();
        assert_eq!(read_resource_file(&path).unwrap_err().code, ErrorCode::Busy);
        drop(writer);
        fs::write(&path, vec![b' '; 128 * 1024 + 1]).unwrap();
        assert_eq!(
            read_resource_file(&path).unwrap_err().code,
            ErrorCode::LimitExceeded
        );
        assert!(read_resource_file(&root.path().join("terms.txt")).is_err());
    }
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("i18n")).unwrap();
        fs::write(root.path().join("manifest.json"), b"{}").unwrap();
        fs::write(root.path().join("i18n/default.json"), br#"{"a":"one"}"#).unwrap();
        fs::write(
            root.path().join("i18n/zh.json"),
            r#"{"a":"你好"}"#.as_bytes(),
        )
        .unwrap();
        root
    }
    #[test]
    fn translation_capture_uses_the_authorized_file_and_preserves_fixed_bytes() {
        let root = fixture();
        let selection = Selection::authorize(root.path().into()).unwrap();
        assert_eq!(selection.translation_files().unwrap(), vec!["zh.json"]);
        let snapshot = ExecutionId::new();
        let bundle = selection
            .capture_translation_inner(
                "zh.json",
                "zh-CN",
                snapshot,
                &Cancellation::default(),
                || {
                    assert!(
                        OpenOptions::new()
                            .write(true)
                            .open(root.path().join("i18n/zh.json"))
                            .is_err()
                    );
                    assert!(fs::remove_file(root.path().join("i18n/zh.json")).is_err());
                },
            )
            .unwrap();
        assert_eq!(bundle.file.utf8, r#"{"a":"你好"}"#);
        assert_eq!(bundle.source_snapshot_id, snapshot);
        assert!(
            selection
                .capture_translation("../zh.json", "zh-CN", snapshot, &Cancellation::default())
                .is_err()
        );
        assert!(
            selection
                .capture_translation("default.json", "zh-CN", snapshot, &Cancellation::default())
                .is_err()
        );
        assert!(
            selection
                .capture_translation("zh.json", "ja", snapshot, &Cancellation::default())
                .is_err()
        );
    }
    #[test]
    fn capture_holds_both_read_handles_and_keeps_original_bytes() {
        let root = fixture();
        let selection = Selection::authorize(root.path().into()).unwrap();
        let bundle = selection
            .capture_inner("en", &Cancellation::default(), || {
                assert!(
                    OpenOptions::new()
                        .write(true)
                        .open(root.path().join("manifest.json"))
                        .is_err()
                );
                assert!(fs::remove_file(root.path().join("i18n/default.json")).is_err());
            })
            .unwrap();
        drop(selection);
        fs::remove_file(root.path().join("i18n/default.json")).unwrap();
        assert_eq!(bundle.files[1].utf8, r#"{"a":"one"}"#);
    }
    #[test]
    fn capture_rejects_existing_writer_missing_files_split_layout_and_limits() {
        let root = fixture();
        let selection = Selection::authorize(root.path().into()).unwrap();
        let writer = OpenOptions::new()
            .write(true)
            .open(root.path().join("manifest.json"))
            .unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .stage,
            "input-busy"
        );
        drop(writer);
        fs::create_dir(root.path().join("i18n/default")).unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .stage,
            "unsupported-format"
        );
        fs::remove_dir(root.path().join("i18n/default")).unwrap();
        fs::write(
            root.path().join("i18n/default.json"),
            vec![b' '; MAX_SOURCE_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        fs::remove_file(root.path().join("i18n/default.json")).unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .stage,
            "missing-companion"
        );
    }
    #[test]
    fn capture_rejects_junction_escape_traversal_and_directory_entry_overflow() {
        let root = fixture();
        assert!(Selection::authorize(root.path().join("..").join("outside")).is_err());
        assert!(Selection::authorize(PathBuf::from("relative")).is_err());
        for n in 0..254 {
            fs::write(root.path().join("i18n").join(format!("extra-{n}")), b"").unwrap();
        }
        let selection = Selection::authorize(root.path().into()).unwrap();
        assert!(selection.capture("en", &Cancellation::default()).is_ok());
        fs::write(root.path().join("i18n/extra-256"), b"").unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        drop(selection);
        let outside = tempfile::tempdir().unwrap();
        let moved = outside.path().join("original");
        fs::rename(root.path().join("i18n"), &moved).unwrap();
        let linked = root.path().join("i18n");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&linked)
            .arg(&moved)
            .output()
            .unwrap();
        assert!(status.status.success(), "junction fixture creation failed");
        let selection = Selection::authorize(root.path().into()).unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        drop(selection);
        fs::remove_dir(&linked).unwrap();
    }

    #[test]
    fn captured_selection_rejects_links_and_cancelled_reads() {
        let root = fixture();
        let selection = Selection::authorize(root.path().into()).unwrap();
        let cancel = Cancellation::default();
        cancel.request();
        assert_eq!(
            selection.capture("en", &cancel).unwrap_err().code,
            ErrorCode::Cancelled
        );
        fs::remove_file(root.path().join("i18n/default.json")).unwrap();
        fs::hard_link(
            root.path().join("manifest.json"),
            root.path().join("i18n/default.json"),
        )
        .unwrap();
        assert_eq!(
            selection
                .capture("en", &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
    }

    #[test]
    fn preflight_captures_and_extracts_maximum_supported_source() {
        let root = fixture();
        fs::write(
            root.path().join("manifest.json"),
            br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
        )
        .unwrap();
        let mut entries = serde_json::Map::new();
        for index in 0..tsumugi_core::content::MAX_OCCURRENCES {
            entries.insert(
                format!("key-{index:04}"),
                serde_json::Value::String(String::new()),
            );
        }
        fs::write(
            root.path().join("i18n/default.json"),
            serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
        let selection = Selection::authorize(root.path().into()).unwrap();
        let bundle = selection.capture("en", &Cancellation::default()).unwrap();
        let output = tsumugi_core::content::extract(&bundle, &Cancellation::default()).unwrap();
        assert_eq!(
            output.occurrences.len(),
            tsumugi_core::content::MAX_OCCURRENCES
        );
    }
}

#[cfg(all(test, any(windows, target_os = "macos")))]
mod source_import_tests {
    use super::*;
    fn binding() -> tsumugi_plugin_sdk::SourceImportBinding {
        let manifest = tsumugi_plugin_sdk::parse_manifest(include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.manifest.json"
        ))
        .unwrap();
        tsumugi_plugin_sdk::parse_source_import_declaration(include_bytes!(
            "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.declaration.json"
        ))
        .unwrap()
        .bind(
            &manifest,
            &"a".repeat(64),
            &tsumugi_plugin_sdk::parse_review_declaration(include_bytes!(
                "../../../../../../../crates/plugin-sdk/tests/fixtures/source-import.review.json"
            ))
            .unwrap(),
        )
        .unwrap()
    }
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("materials")).unwrap();
        fs::create_dir(root.path().join("metadata")).unwrap();
        fs::write(
            root.path().join("materials/raw.txt"),
            "\u{feff}raw 👩🏽‍💻 é\r\n",
        )
        .unwrap();
        fs::write(root.path().join("metadata/header.txt"), b"opaque companion").unwrap();
        root
    }
    #[test]
    fn source_import_capture_reads_only_declared_files_and_retains_original_bytes() {
        let root = fixture();
        fs::write(root.path().join("unrelated.txt"), b"excluded").unwrap();
        let selected = Selection::authorize(root.path().into()).unwrap();
        let bundle = selected
            .capture_declared(&binding(), "en-US", &Cancellation::default())
            .unwrap();
        assert_eq!(bundle.files.len(), 2);
        assert_eq!(bundle.files[0].utf8, "\u{feff}raw 👩🏽‍💻 é\r\n");
        assert_eq!(bundle.files[1].utf8, "opaque companion");
        fs::write(root.path().join("materials/raw.txt"), b"new bytes").unwrap();
        assert_eq!(bundle.files[0].utf8, "\u{feff}raw 👩🏽‍💻 é\r\n");
    }
    #[test]
    fn source_import_capture_refuses_missing_oversized_invalid_utf8_and_cancelled_material() {
        for case in 0..4 {
            let root = fixture();
            let selected = Selection::authorize(root.path().into()).unwrap();
            let cancel = Cancellation::default();
            match case {
                0 => fs::remove_file(root.path().join("metadata/header.txt")).unwrap(),
                1 => fs::write(root.path().join("materials/raw.txt"), vec![b'x'; 131073]).unwrap(),
                2 => fs::write(root.path().join("materials/raw.txt"), [0xff]).unwrap(),
                _ => cancel.request(),
            }
            assert!(
                selected
                    .capture_declared(&binding(), "en-US", &cancel)
                    .is_err(),
                "case {case}"
            );
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn source_import_capture_refuses_links_fifo_aliases_and_changes_after_open() {
        use std::os::unix::fs::symlink;
        for case in 0..6 {
            let root = fixture();
            let selected = Selection::authorize(root.path().into()).unwrap();
            let source = root.path().join("materials/raw.txt");
            let header = root.path().join("metadata/header.txt");
            if case < 4 {
                match case {
                    0 => {
                        fs::remove_file(&source).unwrap();
                        symlink(&header, &source).unwrap();
                    }
                    1 => {
                        fs::rename(root.path().join("materials"), root.path().join("moved"))
                            .unwrap();
                        symlink(root.path().join("moved"), root.path().join("materials")).unwrap();
                    }
                    2 => {
                        fs::remove_file(&header).unwrap();
                        fs::hard_link(&source, &header).unwrap();
                    }
                    _ => {
                        use std::os::unix::ffi::OsStrExt;
                        fs::remove_file(&source).unwrap();
                        let path = std::ffi::CString::new(source.as_os_str().as_bytes()).unwrap();
                        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
                    }
                }
                assert!(
                    selected
                        .capture_declared(&binding(), "en-US", &Cancellation::default())
                        .is_err(),
                    "case {case}"
                );
            } else {
                let result = selected.capture_declared_inner(
                    &binding(),
                    "en-US",
                    &Cancellation::default(),
                    || {
                        if case == 4 {
                            fs::write(&source, b"changed").unwrap();
                        } else {
                            fs::rename(&source, root.path().join("old.txt")).unwrap();
                            fs::write(&source, "\u{feff}raw 👩🏽‍💻 é\r\n").unwrap();
                        }
                    },
                );
                assert_eq!(result.unwrap_err().code, ErrorCode::DependencyConflict);
            }
        }
    }
}
#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::*;
    use std::os::unix::fs::symlink;
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("i18n")).unwrap();
        fs::write(root.path().join("manifest.json"), b"{}").unwrap();
        fs::write(root.path().join("i18n/default.json"), br#"{"a":"one"}"#).unwrap();
        fs::write(root.path().join("i18n/zh.json"), "{\"a\":\"你好 👩🏽‍💻 é\"}").unwrap();
        root
    }
    #[test]
    fn macos_capture_preserves_bytes_and_rejects_changed_identity_and_content() {
        let root = fixture();
        let selected = Selection::authorize(root.path().into()).unwrap();
        assert_eq!(selected.translation_files().unwrap(), vec!["zh.json"]);
        let bundle = selected
            .capture_translation(
                "zh.json",
                "zh-CN",
                ExecutionId::new(),
                &Cancellation::default(),
            )
            .unwrap();
        assert_eq!(bundle.file.utf8, "{\"a\":\"你好 👩🏽‍💻 é\"}");
        let source = root.path().join("i18n/default.json");
        let changed = selected.capture_inner("en", &Cancellation::default(), || {
            fs::write(&source, br#"{"a":"two"}"#).unwrap();
        });
        assert_eq!(changed.unwrap_err().code, ErrorCode::DependencyConflict);
        let replaced = selected.capture_inner("en", &Cancellation::default(), || {
            fs::rename(&source, root.path().join("old.json")).unwrap();
            fs::write(&source, br#"{"a":"two"}"#).unwrap();
        });
        assert!(replaced.is_err());
        let cancel = Cancellation::default();
        cancel.request();
        assert_eq!(
            selected.capture("en", &cancel).unwrap_err().code,
            ErrorCode::Cancelled
        );
    }
    #[test]
    fn macos_capture_rejects_links_traversal_root_replacement_and_oversized_resources() {
        let root = fixture();
        let selected = Selection::authorize(root.path().into()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::rename(root.path().join("i18n"), outside.path().join("i18n")).unwrap();
        symlink(outside.path().join("i18n"), root.path().join("i18n")).unwrap();
        assert!(selected.capture("en", &Cancellation::default()).is_err());
        assert!(Selection::authorize(root.path().join("../elsewhere")).is_err());
        symlink(root.path(), outside.path().join("linked")).unwrap();
        assert!(Selection::authorize(outside.path().join("linked")).is_err());
        let terms = root.path().join("terms.json");
        fs::write(&terms, b"{}").unwrap();
        assert_eq!(read_resource_file(&terms).unwrap(), b"{}");
        fs::write(&terms, vec![b' '; 128 * 1024 + 1]).unwrap();
        assert_eq!(
            read_resource_file(&terms).unwrap_err().code,
            ErrorCode::LimitExceeded
        );
        fs::remove_file(&terms).unwrap();
        symlink(outside.path().join("i18n/zh.json"), &terms).unwrap();
        assert!(read_resource_file(&terms).is_err());
        let moved = outside.path().join("moved");
        fs::rename(root.path(), &moved).unwrap();
        fs::create_dir(root.path()).unwrap();
        assert!(selected.destination_root().is_err());
    }
    #[test]
    fn macos_webvtt_capture_keeps_bytes_and_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(content::webvtt::PATH);
        let bytes = include_bytes!("../../../../../../../crates/core/tests/fixtures/webvtt/s1.vtt");
        fs::write(&path, bytes).unwrap();
        let selected = Selection::authorize_webvtt(root.path().into()).unwrap();
        assert_eq!(
            selected
                .capture("en", &Cancellation::default())
                .unwrap()
                .files[0]
                .utf8
                .as_bytes(),
            bytes
        );
        fs::rename(&path, root.path().join("other.vtt")).unwrap();
        symlink(root.path().join("other.vtt"), &path).unwrap();
        assert!(selected.capture("en", &Cancellation::default()).is_err());
    }
}
