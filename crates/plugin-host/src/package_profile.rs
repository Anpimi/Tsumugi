//! Shared materialization bounds and the SDK-owned portable-path predicate.
use crate::{HostError, HostResult};

pub(crate) const MAX_DIRECTORIES: usize = 256;
pub(crate) const MAX_DEPTH: usize = 16;
pub(crate) const MAX_FILES: usize = 256;
pub(crate) const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn portable_path(path: &str) -> HostResult<()> {
    tsumugi_plugin_sdk::validate_portable_package_path(path).map_err(|_| HostError::PackagePath)
}
