//! Shared Host error contract; no platform, execution or dependency owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
