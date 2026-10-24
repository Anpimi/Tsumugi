//! Held, verified descendants of a native directory selection. Logical paths
//! are supplied only by saved Release artifacts, never by an IPC path payload.
use super::*;
use std::ffi::OsStr;

#[cfg(any(windows, target_os = "macos"))]
pub(crate) struct Destination<'a> {
    selection: &'a Selection,
    path: PathBuf,
    parents: Vec<(PathBuf, File, platform::Identity)>,
}

#[cfg(any(windows, target_os = "macos"))]
impl Selection {
    /// Preview/reconciliation never create directories. Export creates only
    /// validated parents while retaining every ancestor's native handle.
    pub(crate) fn destination(
        &self,
        logical_path: &str,
        create: bool,
    ) -> Result<Option<Destination<'_>>, ExecutionError> {
        tsumugi_plugin_sdk::validate_portable_package_path(logical_path)
            .map_err(|_| error(ErrorCode::InvalidInput, "delivery-file"))?;
        self.verify()?;
        let mut destination = Destination {
            selection: self,
            path: self.root.join(logical_path),
            parents: Vec::new(),
        };
        let mut path = self.root.clone();
        let mut parts = logical_path.split('/').peekable();
        while let Some(part) = parts.next() {
            if parts.peek().is_none() {
                break;
            }
            destination.verify()?;
            path.push(part);
            match fs::symlink_metadata(&path) {
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                    if !create {
                        destination.verify()?;
                        return Ok(None);
                    }
                    #[cfg(target_os = "macos")]
                    {
                        use std::os::fd::AsRawFd;
                        let name = platform::name(OsStr::new(part))?;
                        if unsafe {
                            libc::mkdirat(destination.directory().as_raw_fd(), name.as_ptr(), 0o700)
                        } == -1
                            && std::io::Error::last_os_error().kind()
                                != std::io::ErrorKind::AlreadyExists
                        {
                            return Err(io(std::io::Error::last_os_error()));
                        }
                        destination.directory().sync_all().map_err(io)?;
                    }
                    #[cfg(windows)]
                    if let Err(cause) = fs::create_dir(&path) {
                        if cause.kind() != std::io::ErrorKind::AlreadyExists {
                            return Err(io(cause));
                        }
                    }
                }
                Err(cause) => return Err(io(cause)),
                Ok(_) => {}
            }
            #[cfg(target_os = "macos")]
            let child = platform::open_child(destination.directory(), OsStr::new(part), true)?;
            #[cfg(windows)]
            let child = platform::open(&path, true)?;
            let identity = platform::identity(&child)?;
            if platform::final_path(&child)? != path {
                return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
            }
            destination.parents.push((path.clone(), child, identity));
        }
        destination.verify()?;
        Ok(Some(destination))
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl Destination<'_> {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn directory(&self) -> &File {
        self.parents
            .last()
            .map_or(&self.selection.root_file, |p| &p.1)
    }
    pub(crate) fn verify(&self) -> Result<(), ExecutionError> {
        self.selection.verify()?;
        for (path, held, identity) in &self.parents {
            if platform::identity(held)? != *identity
                || platform::final_path(held)? != *path
                || platform::identity(&platform::open(path, true)?)? != *identity
            {
                return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
            }
        }
        Ok(())
    }
    /// Read a target or our fresh temporary file in this exact held directory.
    /// The SDK's complete artifact bound also covers empty and >1 MiB outputs.
    pub(crate) fn read_file(&self, path: &Path) -> Result<Option<Vec<u8>>, ExecutionError> {
        if path.parent() != self.path.parent() {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        let name = path
            .file_name()
            .ok_or_else(|| error(ErrorCode::InvalidInput, "delivery-file"))?;
        self.verify()?;
        if let Err(cause) = fs::symlink_metadata(path) {
            if cause.kind() == std::io::ErrorKind::NotFound {
                self.verify()?;
                return Ok(None);
            }
            return Err(io(cause));
        }
        #[cfg(target_os = "macos")]
        let mut file = platform::open_child(self.directory(), name, false)?;
        #[cfg(windows)]
        let mut file = platform::open(path, false)?;
        if platform::final_path(&file)? != path {
            return Err(error(ErrorCode::Unauthorized, "unauthorized-selection"));
        }
        #[cfg(target_os = "macos")]
        let stamp = platform::stamp(&file)?;
        let bytes = read(
            &mut file,
            tsumugi_plugin_sdk::MAX_EXCHANGE_BYTES,
            &|| Ok(()),
        )?;
        #[cfg(target_os = "macos")]
        platform::verify_file(&file, path, stamp)?;
        self.verify()?;
        Ok(Some(bytes))
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) struct Destination<'a>(std::marker::PhantomData<&'a Selection>);
#[cfg(not(any(windows, target_os = "macos")))]
impl Selection {
    pub(crate) fn destination(
        &self,
        _: &str,
        _: bool,
    ) -> Result<Option<Destination<'_>>, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
impl Destination<'_> {
    pub(crate) fn path(&self) -> &Path {
        Path::new("")
    }
    pub(crate) fn verify(&self) -> Result<(), ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
    pub(crate) fn read_file(&self, _: &Path) -> Result<Option<Vec<u8>>, ExecutionError> {
        Err(error(ErrorCode::InvalidInput, "unsupported-platform"))
    }
}
