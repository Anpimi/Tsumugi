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

pub const NATIVE_HOST_ENVIRONMENT_PROTOCOL: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum NativeHostProfile {
    NativeApplicationHostV1,
}

/// Identity of the actual application Host executable. This neither identifies
/// a publisher nor captures operating-system libraries or dynamically loaded
/// images. It must come from the trusted Host's OS observation, not a worker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum NativeHostExecutableIdentity {
    DarwinCodeDirectoryHashV1(String),
    LinuxExecutableSha256V1(String),
}

/// The native executable and its package resources are already fixed by the
/// separate provider binding. Native execution has no Node/tool/bootstrap tree.
/// This profile instead records the actual application Host executable identity.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct NativeHostEnvironmentDescriptor {
    pub protocol_version: u32,
    pub platform: RuntimePlatform,
    pub sdk_version: String,
    pub process_protocol: u32,
    pub profile: NativeHostProfile,
    pub host_version: String,
    pub executable: NativeHostExecutableIdentity,
}
impl NativeHostEnvironmentDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol_version != NATIVE_HOST_ENVIRONMENT_PROTOCOL
            || self.process_protocol != PROCESS_PROTOCOL
            || self.sdk_version != crate::SDK_VERSION
        {
            return Err(ContractError::at(
                ContractErrorCode::UnsupportedProtocol,
                "nativeEnvironment.protocol",
            ));
        }
        version(&self.host_version)?;
        let (value, length, system) = match &self.executable {
            NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1(value) => {
                (value, 40, RuntimeOperatingSystem::Macos)
            }
            NativeHostExecutableIdentity::LinuxExecutableSha256V1(value) => {
                (value, 64, RuntimeOperatingSystem::Linux)
            }
        };
        if self.platform.operating_system != system
            || value.len() != length
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || value.bytes().all(|byte| byte == b'0')
        {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "nativeEnvironment.executable",
            ));
        }
        Ok(())
    }
    pub fn digest(&self) -> Result<String, ContractError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| {
            ContractError::at(ContractErrorCode::InvalidSchema, "nativeEnvironment")
        })?;
        let mut hash = Sha256::new();
        hash.update(b"tsumugi-native-host-environment-v1\0");
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
        Ok(format!("{:x}", hash.finalize()))
    }
}

/// Fixed execution choices for the two actual runtime profiles. Each variant
/// has a strict, distinct profile value and its own data/hash owner. Captured
/// Node serialization and digests remain exactly those of its existing type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ExecutionEnvironmentDescriptor {
    Captured(RuntimeEnvironmentDescriptor),
    Native(NativeHostEnvironmentDescriptor),
}
impl ExecutionEnvironmentDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::Captured(value) => value.validate(),
            Self::Native(value) => value.validate(),
        }
    }
    pub fn digest(&self) -> Result<String, ContractError> {
        match self {
            Self::Captured(value) => value.digest(),
            Self::Native(value) => value.digest(),
        }
    }
}
impl From<RuntimeEnvironmentDescriptor> for ExecutionEnvironmentDescriptor {
    fn from(value: RuntimeEnvironmentDescriptor) -> Self {
        Self::Captured(value)
    }
}
impl From<NativeHostEnvironmentDescriptor> for ExecutionEnvironmentDescriptor {
    fn from(value: NativeHostEnvironmentDescriptor) -> Self {
        Self::Native(value)
    }
}

/// Data-only SHA-256 of the complete Linux Host executable observed through its
/// kernel executable handle. The caller owns stable file identity and IO.
pub fn native_host_executable_sha256(bytes: &[u8]) -> Result<String, ContractError> {
    if bytes.is_empty() || bytes.len() > MAX_RUNTIME_ARTIFACT_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "nativeEnvironment.executableBytes",
        ));
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum RuntimeOperatingSystem {
    Macos,
    Linux,
    Windows,
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
