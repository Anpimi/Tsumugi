//! Build-owned bundle metadata, independent of selected files and receipts.
use serde::{Deserialize, Serialize};
use tsumugi_plugin_host::catalog::PackageOrigin;
use tsumugi_plugin_sdk as sdk;

pub const BUNDLE_ID: &str = "bundled-javascript";
pub const RESOURCE_DIRECTORY: &str = "runtimes/javascript";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeDistributionPin {
    pub version: String,
    pub archive: String,
    pub url: String,
    pub checksums_url: String,
    pub archive_sha256: String,
    pub tool_tree_digest: String,
    pub files: std::collections::BTreeMap<String, String>,
    pub minimum_system_version: String,
    pub system_libraries: Vec<String>,
}

pub fn node_pin() -> Result<NodeDistributionPin, &'static str> {
    let pin: NodeDistributionPin = serde_json::from_str(include_str!(
        "../../../runtimes/javascript-host/scripts/node-distribution.macos-aarch64.json"
    ))
    .map_err(|_| "invalid source-owned Node distribution pin")?;
    sdk::validate_package_digest(&pin.tool_tree_digest).map_err(|_| "invalid tool artifact pin")?;
    sdk::validate_package_digest(&pin.archive_sha256).map_err(|_| "invalid archive pin")?;
    if pin.files.len() != 2
        || !pin.files.contains_key("bin/node")
        || !pin.files.contains_key("LICENSE")
        || !pin.url.starts_with("https://nodejs.org/dist/")
        || !pin.checksums_url.starts_with("https://nodejs.org/dist/")
        || pin.archive != format!("node-v{}-darwin-arm64.tar.xz", pin.version)
        || pin.system_libraries.len() != 4
        || system_version(&pin.minimum_system_version).is_none()
    {
        return Err("invalid source-owned Node distribution profile");
    }
    for digest in pin.files.values() {
        sdk::validate_package_digest(digest).map_err(|_| "invalid selected-file pin")?;
    }
    Ok(pin)
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundledRuntimeMetadata {
    pub format_version: u32,
    pub id: String,
    pub environment: sdk::RuntimeEnvironmentDescriptor,
    pub origin: PackageOrigin,
    pub minimum_system_version: String,
    pub file_count: u32,
    pub byte_count: u64,
}

impl BundledRuntimeMetadata {
    pub fn validate(&self) -> Result<(), &'static str> {
        let pin = node_pin()?;
        self.environment
            .validate()
            .map_err(|_| "invalid bundled environment")?;
        if self.format_version != 1
            || self.id != BUNDLE_ID
            || self.origin != bundled_origin()
            || self.minimum_system_version != pin.minimum_system_version
            || self.file_count == 0
            || self.file_count as usize > sdk::MAX_RUNTIME_ARTIFACT_FILES
            || self.byte_count > sdk::MAX_RUNTIME_ARTIFACT_BYTES as u64
            || !supported_tool(&self.environment, &pin)
        {
            return Err("bundled runtime does not match source-owned distribution policy");
        }
        Ok(())
    }
}

pub fn bundled_origin() -> PackageOrigin {
    // Application assembly is the source of this identity, never a signature
    // claim inferred from runtime JSON, Node or a worker's self-report.
    PackageOrigin {
        source_id: "application-bundle".into(),
        publisher_id: "application-build".into(),
    }
}

pub fn supported_tool(
    environment: &sdk::RuntimeEnvironmentDescriptor,
    pin: &NodeDistributionPin,
) -> bool {
    environment.platform
        == sdk::RuntimePlatform {
            operating_system: sdk::RuntimeOperatingSystem::Macos,
            architecture: sdk::RuntimeArchitecture::Aarch64,
        }
        && environment.profile == sdk::RuntimeEnvironmentProfile::NodeSystemLibrariesV1
        && environment.tool_version == pin.version
        && environment.tool.tree_digest == pin.tool_tree_digest
        && environment.tool.entrypoint == "bin/node"
        && environment.host.entrypoint == "dist/main.js"
}

pub fn system_version(value: &str) -> Option<(u16, u16, u16)> {
    let components = value.split('.').collect::<Vec<_>>();
    if !(2..=3).contains(&components.len())
        || components
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    Some((
        components[0].parse().ok()?,
        components[1].parse().ok()?,
        components
            .get(2)
            .map_or(Some(0), |part| part.parse().ok())?,
    ))
}
