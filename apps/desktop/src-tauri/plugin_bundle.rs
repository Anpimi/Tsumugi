//! Source-owned selection of independent prebuilt packages. Observations never
//! authenticate a publisher or replace these trusted application-build pins.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use tsumugi_plugin_host::catalog::PackageOrigin;
use tsumugi_plugin_sdk as sdk;

pub const BUNDLE_ID: &str = "bundled-extensions";
pub const RESOURCE_DIRECTORY: &str = "bundled-plugins";
pub const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackagePin {
    pub id: String,
    pub display_name: String,
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub source_repository: String,
    pub source_commit: String,
    pub sdk_version: String,
    pub sdk_artifact_sha256: String,
    pub archive_name: String,
    pub archive_sha256: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleSelection {
    pub format_version: u32,
    pub platform: sdk::RuntimePlatform,
    pub runtime_profile: sdk::RuntimeEnvironmentProfile,
    pub process_protocol: u32,
    pub packages: Vec<PackagePin>,
}
impl BundleSelection {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.format_version != 1
            || self.packages.is_empty()
            || self.packages.len() > 128
            || self.process_protocol != sdk::PROCESS_PROTOCOL
            || self.runtime_profile != sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1
            || self.platform
                != (sdk::RuntimePlatform {
                    operating_system: sdk::RuntimeOperatingSystem::Macos,
                    architecture: sdk::RuntimeArchitecture::Aarch64,
                })
        {
            return Err("invalid bundled package selection");
        }
        let mut ids = BTreeSet::new();
        let mut plugins = BTreeSet::new();
        for pin in &self.packages {
            pin.plugin
                .validate()
                .map_err(|_| "invalid bundled identity")?;
            sdk::validate_package_digest(&pin.package_digest).map_err(|_| "invalid package pin")?;
            sdk::validate_package_digest(&pin.archive_sha256).map_err(|_| "invalid archive pin")?;
            sdk::validate_package_digest(&pin.sdk_artifact_sha256)
                .map_err(|_| "invalid SDK artifact pin")?;
            // One portable resource directory, never a caller-selected path.
            if pin.id.is_empty()
                || pin.id.len() > 64
                || !pin
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || !ids.insert(&pin.id)
                || !plugins.insert(&pin.plugin)
                || pin.display_name.trim().is_empty()
                || pin.display_name.len() > 128
                || pin.display_name.chars().any(char::is_control)
                || !pin.source_repository.starts_with("https://github.com/")
                || pin.source_commit.len() != 40
                || !pin
                    .source_commit
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || pin.sdk_version != sdk::SDK_VERSION
                || pin.archive_name != format!("{}.tar", pin.id)
            {
                return Err("invalid bundled provenance or compatibility");
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageMetadata {
    pub pin: PackagePin,
    pub manifest_sha256: String,
    pub file_count: u32,
    pub byte_count: u64,
}
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleMetadata {
    pub format_version: u32,
    pub platform: sdk::RuntimePlatform,
    pub runtime_profile: sdk::RuntimeEnvironmentProfile,
    pub process_protocol: u32,
    pub packages: Vec<PackageMetadata>,
}
impl BundleMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        BundleSelection {
            format_version: self.format_version,
            platform: self.platform.clone(),
            runtime_profile: self.runtime_profile,
            process_protocol: self.process_protocol,
            packages: self
                .packages
                .iter()
                .map(|entry| entry.pin.clone())
                .collect(),
        }
        .validate()?;
        let mut total = 0u64;
        for entry in &self.packages {
            sdk::validate_package_digest(&entry.manifest_sha256)
                .map_err(|_| "invalid bundled manifest")?;
            if entry.file_count == 0
                || entry.file_count > 256
                || entry.byte_count > MAX_BUNDLE_BYTES
            {
                return Err("bundled package exceeds fixed limits");
            }
            total = total
                .checked_add(entry.byte_count)
                .ok_or("bundle exceeds limits")?;
        }
        if total > MAX_BUNDLE_BYTES {
            return Err("bundle exceeds limits");
        }
        Ok(())
    }
}
pub fn bundled_origin() -> PackageOrigin {
    PackageOrigin {
        source_id: "application-bundle".into(),
        publisher_id: "application-build".into(),
    }
}
pub fn selection() -> Result<BundleSelection, &'static str> {
    let selection: BundleSelection =
        serde_json::from_str(include_str!("bundled-plugins.macos-aarch64.json"))
            .map_err(|_| "invalid bundled selection")?;
    selection.validate()?;
    Ok(selection)
}
