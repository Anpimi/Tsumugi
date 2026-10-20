//! Compile and exercise actual Host sources without repository/database C
//! libraries. Target metadata checks do not replace real target execution.
#![allow(dead_code)]
#[path = "../../src/host_error.rs"]
mod host_error;
pub use host_error::{HostError, HostResult};
#[path = "../../src/package_profile.rs"]
mod package_profile;
use package_profile as package;
#[path = "../../src/runtime.rs"]
mod runtime;
pub use runtime::{CapturedMemberArtifact, CapturedRuntime, MemberArtifactManifest};
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
#[path = "../../src/filesystem.rs"]
mod filesystem;
#[path = "../../src/staging.rs"]
mod staging;
#[path = "../../src/tree.rs"]
mod tree;
#[cfg(windows)]
#[path = "../../src/windows_security.rs"]
mod windows_security;
