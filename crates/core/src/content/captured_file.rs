//! Captured file bytes with the original UTF-8 snapshot encoding preserved.
use super::{ExecutionError, ExecutionId, codec, invalid, source_contract_error};
use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeMap};
use tsumugi_plugin_sdk as sdk;

#[derive(Deserialize)]
#[serde(untagged)]
enum CapturedFileWire {
    Text(TextFileWire),
    Binary(BinaryFileWire),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextFileWire {
    artifact_id: ExecutionId,
    logical_path: String,
    role: String,
    byte_length: u32,
    sha256: String,
    utf8: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BinaryFileWire {
    artifact_id: ExecutionId,
    logical_path: String,
    role: String,
    byte_length: u32,
    sha256: String,
    base64: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedFile {
    pub artifact_id: ExecutionId,
    pub logical_path: String,
    pub role: String,
    pub byte_length: u32,
    pub sha256: String,
    pub data: sdk::CapturedArtifactData,
}
impl Serialize for CapturedFile {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Field order and the utf8 property retain the frozen supported shape.
        let mut map = serializer.serialize_map(Some(6))?;
        map.serialize_entry("artifactId", &self.artifact_id)?;
        map.serialize_entry("logicalPath", &self.logical_path)?;
        map.serialize_entry("role", &self.role)?;
        map.serialize_entry("byteLength", &self.byte_length)?;
        map.serialize_entry("sha256", &self.sha256)?;
        match &self.data {
            sdk::CapturedArtifactData::Utf8(value) => map.serialize_entry("utf8", value)?,
            sdk::CapturedArtifactData::Base64(value) => map.serialize_entry("base64", value)?,
        }
        map.end()
    }
}
impl<'de> Deserialize<'de> for CapturedFile {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match CapturedFileWire::deserialize(deserializer)? {
            CapturedFileWire::Text(value) => Self {
                artifact_id: value.artifact_id,
                logical_path: value.logical_path,
                role: value.role,
                byte_length: value.byte_length,
                sha256: value.sha256,
                data: sdk::CapturedArtifactData::Utf8(value.utf8),
            },
            CapturedFileWire::Binary(value) => Self {
                artifact_id: value.artifact_id,
                logical_path: value.logical_path,
                role: value.role,
                byte_length: value.byte_length,
                sha256: value.sha256,
                data: sdk::CapturedArtifactData::Base64(value.base64),
            },
        })
    }
}
impl CapturedFile {
    pub(super) fn new(path: &str, role: &str, bytes: &[u8]) -> Result<Self, ExecutionError> {
        let utf8 = std::str::from_utf8(bytes)
            .map_err(|_| invalid("unsupported-encoding"))?
            .to_owned();
        Ok(Self {
            artifact_id: ExecutionId::new(),
            logical_path: path.into(),
            role: role.into(),
            byte_length: bytes.len() as u32,
            sha256: codec::digest(bytes),
            data: sdk::CapturedArtifactData::Utf8(utf8),
        })
    }
    pub fn bytes(&self) -> Result<std::borrow::Cow<'_, [u8]>, ExecutionError> {
        self.data.bytes().map_err(source_contract_error)
    }
    pub fn text(&self) -> Result<&str, ExecutionError> {
        match &self.data {
            sdk::CapturedArtifactData::Utf8(text) => Ok(text),
            sdk::CapturedArtifactData::Base64(_) => Err(invalid("unsupported-encoding")),
        }
    }
    pub(super) fn from_artifact(
        artifact: &sdk::CapturedArtifact,
        artifact_id: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        let bytes = artifact.validated_bytes().map_err(source_contract_error)?;
        Ok(Self {
            artifact_id,
            logical_path: artifact.logical_path().into(),
            role: artifact.role().into(),
            byte_length: u32::try_from(bytes.len()).map_err(|_| invalid("source-bytes"))?,
            sha256: artifact.sha256().into(),
            data: artifact.data(),
        })
    }
}
