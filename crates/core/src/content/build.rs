//! Generic immutable build-source references and artifact integrity.
use super::*;

pub const BUILD_OPERATION: &str = "locale-build";

pub fn artifact_digest(bytes: &[u8]) -> String {
    codec::digest(bytes)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct BuildSourceFile {
    pub logical_path: String,
    pub sha256: String,
}
