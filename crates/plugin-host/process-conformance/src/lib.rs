//! Compile and exercise the actual platform process owner without pulling in
//! repository verification or database C libraries. This does not replace
//! integrated Host tests or actual execution on the target operating system.
#[path = "../../src/child.rs"]
mod child;

#[cfg(windows)]
#[path = "../../src/windows_security.rs"]
#[allow(dead_code)]
mod windows_security;
