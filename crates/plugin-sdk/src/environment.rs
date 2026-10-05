//! Data-only descriptions of captured runtime artifacts. These values do not
//! authenticate a distribution, load it, freeze the operating system or grant
//! permission to execute code.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ContractError, ContractErrorCode, PROCESS_PROTOCOL,
    validation::{digest, path, version},
};

pub const RUNTIME_ENVIRONMENT_PROTOCOL: u32 = 1;
pub const MAX_RUNTIME_ARTIFACT_FILES: usize = 2048;
pub const MAX_RUNTIME_ARTIFACT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum RuntimeOperatingSystem {
    Macos,
    Linux,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum RuntimeArchitecture {
    Aarch64,
    #[serde(rename = "x86_64")]
    X86_64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RuntimePlatform {
    pub operating_system: RuntimeOperatingSystem,
    pub architecture: RuntimeArchitecture,
}

/// The installer must independently verify that the approved tool distribution
/// depends only on the supported platform's system libraries. The profile does
/// not describe arbitrary Homebrew/npm installations, a sandbox or a captured
/// OS image. Runtime capture must refuse unsupported profiles and platforms.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum RuntimeEnvironmentProfile {
    NodeSystemLibrariesV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RuntimeArtifactBinding {
    /// Digest of every actual file and its executable flag, including metadata,
    /// dependencies and licenses; this is not the entrypoint's file digest.
    pub tree_digest: String,
    pub entrypoint: String,
}

/// Exact tool and Host choices for a fixed invocation. Paths are logical within
/// their respective artifacts, never machine paths. The trusted installer owns
/// approval of these bytes and the tool version, independently of worker output.
/// A digest is derived from the whole validated value, not separately supplied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct RuntimeEnvironmentDescriptor {
    pub protocol_version: u32,
    pub platform: RuntimePlatform,
    pub sdk_version: String,
    pub process_protocol: u32,
    pub profile: RuntimeEnvironmentProfile,
    pub tool_version: String,
    pub tool: RuntimeArtifactBinding,
    pub host: RuntimeArtifactBinding,
}

impl RuntimeEnvironmentDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol_version != RUNTIME_ENVIRONMENT_PROTOCOL
            || self.process_protocol != PROCESS_PROTOCOL
            || self.sdk_version != crate::SDK_VERSION
        {
            return Err(ContractError::at(
                ContractErrorCode::UnsupportedProtocol,
                "environment.protocol",
            ));
        }
        version(&self.tool_version)?;
        for artifact in [&self.tool, &self.host] {
            digest(&artifact.tree_digest, "environment.treeDigest")?;
            path(&artifact.entrypoint, "environment.entrypoint")?;
        }
        Ok(())
    }

    /// SHA-256 of a domain tag and length-prefixed canonical struct JSON. There
    /// are no maps, optional values or caller-controlled field order in this
    /// profile. Changes to any platform, profile, tool or Host field change the
    /// digest; OS contents and execution permission remain outside this value.
    pub fn digest(&self) -> Result<String, ContractError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "environment"))?;
        let mut hash = Sha256::new();
        hash.update(b"tsumugi-runtime-environment-v1\0");
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
        Ok(format!("{:x}", hash.finalize()))
    }
}

/// Actual bytes supplied by a trusted capture owner. The SDK performs no IO and
/// cannot establish that these bytes came from a particular filesystem source.
#[derive(Clone)]
pub struct RuntimeArtifactFile {
    pub bytes: Vec<u8>,
    pub executable: bool,
}

/// A separate artifact profile, independent of plugin package/manifest hashes.
/// Ordered logical paths, executable flags and actual contents all participate.
/// Filesystem links, portable aliases and source changes must be rejected by
/// the capture owner before these data values are supplied.
pub fn runtime_artifact_digest(
    files: &BTreeMap<String, RuntimeArtifactFile>,
) -> Result<String, ContractError> {
    if files.is_empty() || files.len() > MAX_RUNTIME_ARTIFACT_FILES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "environment.files",
        ));
    }
    let mut total = 0usize;
    let mut hash = Sha256::new();
    hash.update(b"tsumugi-runtime-artifact-v1\0");
    for (name, file) in files {
        path(name, "environment.filePath")?;
        total = total.checked_add(file.bytes.len()).ok_or_else(|| {
            ContractError::at(ContractErrorCode::LimitExceeded, "environment.bytes")
        })?;
        if total > MAX_RUNTIME_ARTIFACT_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "environment.bytes",
            ));
        }
        hash.update((name.len() as u64).to_be_bytes());
        hash.update(name.as_bytes());
        hash.update([u8::from(file.executable)]);
        hash.update((file.bytes.len() as u64).to_be_bytes());
        hash.update(&file.bytes);
    }
    Ok(format!("{:x}", hash.finalize()))
}
