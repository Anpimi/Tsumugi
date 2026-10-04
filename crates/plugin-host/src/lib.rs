//! Bounded, experimental process channels. The SDK owns wire definitions; this
//! crate owns captured package bytes and the actual child/pipe identity. It has
//! no domain implementation or adoption authority. The optional Core adapter
//! implements the trusted Runner port without giving a child a store.
#[cfg(feature = "core-adapter")]
pub mod core;
mod package;
mod session;
pub use package::{PackageFile, PackageImage};
pub use session::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostError {
    InvalidContract,
    PackageLimit,
    PackagePath,
    PackageMismatch,
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
