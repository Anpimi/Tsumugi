//! Bounded, experimental process channels. The SDK owns wire definitions; this
//! crate owns captured package bytes and the actual child/pipe identity. It has
//! no domain implementation or adoption authority. Its optional Core adapter
//! implements the trusted Runner port without acquiring a Store handle.
mod candidate_archive;
pub mod catalog;
mod child;
#[cfg(feature = "core-adapter")]
pub mod core;
#[cfg(feature = "core-adapter")]
pub mod member;
#[cfg(any(target_os = "macos", target_os = "linux", windows))]
mod filesystem;
mod host_error;
mod native_runtime;
mod pack;
mod package;
mod package_profile;
pub mod repository;
mod runtime;
mod service;
mod session;
mod staging;
mod tree;
mod ui;
#[cfg(windows)]
mod windows_security;
pub use native_runtime::CapturedNativeRuntime;
pub use pack::{
    CapturedOfflinePack, MAX_PACK_BYTES, MAX_PACK_MEMBERS, OfflinePackDescriptor, OfflinePackMember,
};
pub use package::installation::{
    ApprovedPackageSetting, InstallError, InstallReceipt, InstallResult, InstalledInventory,
    InstalledObjectState, InstalledPackage, InstalledPackageRecord, InstalledRuntime,
    InstalledRuntimeRecord, MAX_INSTALLED_PACKAGES, MAX_INSTALLED_RUNTIMES, MAX_REPOSITORY_SOURCES,
    MAX_REPOSITORY_TRUST_ACTIONS, PackageStore, PluginSettings, PluginSettingsUpdate,
    RepositoryPendingAction, RepositoryRefreshRequest, RepositorySourceRecord, RuntimeApproval,
    RuntimeInstallReceipt, UninstallReceipt, UninstallRecord, repository_source_id,
};
pub use package::{PackageCompatibilityInspection, PackageFile, PackageImage, PackageInspection};
pub use runtime::{
    CapturedMemberArtifact, CapturedRuntime, MemberArtifactManifest, RuntimeInspection,
    RuntimeInspectionRequest,
};
pub use service::*;
pub use session::*;
pub use ui::ReferenceQueryUi;

pub use candidate_archive::MAX_PACKAGE_ARCHIVE_BYTES;
pub use host_error::{HostError, HostResult};
