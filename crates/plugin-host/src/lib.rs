//! Bounded, experimental process channels. The SDK owns wire definitions; this
//! crate owns captured package bytes and the actual child/pipe identity. It has
//! no domain implementation or adoption authority. The optional Core adapter
//! implements the trusted Runner port without giving a child a store.
pub mod catalog;
#[cfg(feature = "core-adapter")]
pub mod core;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod filesystem;
mod package;
mod runtime;
mod session;
mod staging;
mod tree;
pub use package::installation::{
    InstallError, InstallReceipt, InstallResult, InstalledPackage, InstalledRuntime,
    MAX_INSTALLED_PACKAGES, MAX_INSTALLED_RUNTIMES, PackageStore, RuntimeApproval,
    RuntimeInstallReceipt,
};
pub use package::{PackageFile, PackageImage, PackageInspection};
pub use runtime::CapturedRuntime;
pub use session::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostError {
    InvalidContract,
    PackageLimit,
    PackagePath,
    PackageMismatch,
    RuntimeMismatch,
    PackageChanged,
    CaptureFailed,
    MissingArtifact,
    StageFailed,
    ExecutionNotAuthorized,
    UnsupportedPlatform,
    UnsupportedRuntime,
    DependencyUnavailable,
    InvalidLimits,
    SpawnFailed,
    ChannelFailed,
    OutputLimit,
    InvalidFrame,
    HandshakeMismatch,
    RequestMismatch,
    ResultMismatch,
    UnexpectedFrame,
    Timeout,
    Cancelled,
    AuthorityRevoked,
    Crashed,
    Closed,
}
pub type HostResult<T> = Result<T, HostError>;
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for HostError {}
