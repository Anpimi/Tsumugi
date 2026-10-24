//! Shared held-handle filesystem operations for capture, installation and staging.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "filesystem/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "filesystem/windows.rs"]
mod platform;

pub(crate) use platform::*;
