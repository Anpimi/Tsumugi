//! Actual application Host identity; no worker claim, mutable launcher path or
//! artificial Node artifact. OS/dynamic-library contents are not captured.
use crate::{HostError, HostResult};
use std::sync::Arc;
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Debug)]
pub struct CapturedNativeRuntime {
    inner: Arc<NativeSnapshot>,
}
#[derive(Debug)]
struct NativeSnapshot {
    descriptor: sdk::NativeHostEnvironmentDescriptor,
    digest: String,
    process_id: u32,
}
impl CapturedNativeRuntime {
    /// Read-only observation of this actual Host. Observation is not approval,
    /// publisher authentication, execution permission or a Core grant.
    pub fn inspect_current() -> HostResult<sdk::NativeHostEnvironmentDescriptor> {
        let (platform, executable) = current_executable()?;
        let descriptor = sdk::NativeHostEnvironmentDescriptor {
            protocol_version: sdk::NATIVE_HOST_ENVIRONMENT_PROTOCOL,
            platform,
            sdk_version: sdk::SDK_VERSION.into(),
            process_protocol: sdk::PROCESS_PROTOCOL,
            profile: sdk::NativeHostProfile::NativeApplicationHostV1,
            host_version: env!("CARGO_PKG_VERSION").into(),
            executable,
        };
        descriptor
            .validate()
            .map_err(|_| HostError::InvalidContract)?;
        Ok(descriptor)
    }
    /// Compare an independently approved complete description with the actual
    /// current application executable. This neither executes a package nor
    /// creates authorization. No independently supplied free digest is accepted.
    pub fn capture(approval: &sdk::NativeHostEnvironmentDescriptor) -> HostResult<Self> {
        approval
            .validate()
            .map_err(|_| HostError::InvalidContract)?;
        let descriptor = Self::inspect_current()?;
        if descriptor != *approval {
            return Err(HostError::RuntimeMismatch);
        }
        let digest = descriptor
            .digest()
            .map_err(|_| HostError::InvalidContract)?;
        Ok(Self {
            inner: Arc::new(NativeSnapshot {
                descriptor,
                digest,
                process_id: std::process::id(),
            }),
        })
    }
    pub fn descriptor(&self) -> &sdk::NativeHostEnvironmentDescriptor {
        &self.inner.descriptor
    }
    pub fn environment_digest(&self) -> &str {
        &self.inner.digest
    }
    pub(crate) fn require_current(&self) -> HostResult<()> {
        if self.inner.process_id != std::process::id()
            || Self::inspect_current()? != self.inner.descriptor
        {
            return Err(HostError::RuntimeMismatch);
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn current_executable() -> HostResult<(sdk::RuntimePlatform, sdk::NativeHostExecutableIdentity)> {
    unsafe extern "C" {
        fn csops(
            pid: libc::pid_t,
            operation: libc::c_uint,
            buffer: *mut libc::c_void,
            length: libc::size_t,
        ) -> libc::c_int;
    }
    // Darwin's read-only CS_OPS_CDHASH query returns the actual process's
    // 20-byte CodeDirectory hash. Never reopen current_exe's mutable pathname.
    let mut hash = [0u8; 20];
    // SAFETY: own live PID, read-only operation 5, writable exact-size buffer.
    if unsafe { csops(libc::getpid(), 5, hash.as_mut_ptr().cast(), hash.len()) } != 0
        || hash.iter().all(|byte| *byte == 0)
    {
        return Err(HostError::CaptureFailed);
    }
    let architecture = current_architecture()?;
    let value = hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((
        sdk::RuntimePlatform {
            operating_system: sdk::RuntimeOperatingSystem::Macos,
            architecture,
        },
        sdk::NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1(value),
    ))
}

#[cfg(target_os = "linux")]
fn current_executable() -> HostResult<(sdk::RuntimePlatform, sdk::NativeHostExecutableIdentity)> {
    use std::{fs::File, io::Read, os::unix::fs::MetadataExt};
    // This is the kernel executable handle, intentionally dereferenced here.
    // A readlink followed by opening its pathname would lose that identity.
    let mut file = File::open("/proc/self/exe").map_err(|_| HostError::CaptureFailed)?;
    let before = file.metadata().map_err(|_| HostError::CaptureFailed)?;
    if !before.is_file()
        || before.len() == 0
        || before.len() > sdk::MAX_RUNTIME_ARTIFACT_BYTES as u64
    {
        return Err(HostError::CaptureFailed);
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&mut file)
        .take(sdk::MAX_RUNTIME_ARTIFACT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HostError::CaptureFailed)?;
    let after = file.metadata().map_err(|_| HostError::CaptureFailed)?;
    if bytes.len() != before.len() as usize
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(HostError::PackageChanged);
    }
    let value = sdk::native_host_executable_sha256(&bytes).map_err(|_| HostError::CaptureFailed)?;
    Ok((
        sdk::RuntimePlatform {
            operating_system: sdk::RuntimeOperatingSystem::Linux,
            architecture: current_architecture()?,
        },
        sdk::NativeHostExecutableIdentity::LinuxExecutableSha256V1(value),
    ))
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn current_executable() -> HostResult<(sdk::RuntimePlatform, sdk::NativeHostExecutableIdentity)> {
    Err(HostError::UnsupportedPlatform)
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn current_architecture() -> HostResult<sdk::RuntimeArchitecture> {
    #[cfg(target_arch = "aarch64")]
    {
        Ok(sdk::RuntimeArchitecture::Aarch64)
    }
    #[cfg(target_arch = "x86_64")]
    {
        Ok(sdk::RuntimeArchitecture::X86_64)
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        Err(HostError::UnsupportedPlatform)
    }
}
