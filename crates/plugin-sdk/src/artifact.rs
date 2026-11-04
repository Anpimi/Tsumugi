//! Exact captured bytes and source coordinates. These values identify immutable
//! evidence; they grant no access to local paths, project storage or execution.
use std::borrow::Cow;

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{ContractError, ContractErrorCode, MAX_EXCHANGE_BYTES, TextEncoding, TextRange};

// Payload families 1 and 2 are the exact supported text-only and binary-capable
// contracts. This does not select a provider or imply execution permission.
pub(crate) fn artifact_contract_version(
    actual: &crate::ContractRef,
    current: crate::ContractRef,
) -> Option<u32> {
    let legacy = crate::ContractRef {
        schema_version: 1,
        ..current.clone()
    };
    if actual == &current {
        Some(current.schema_version)
    } else if actual == &legacy {
        Some(1)
    } else {
        None
    }
}
pub(crate) fn require_text_artifacts(
    artifacts: &[CapturedArtifact],
    field: &str,
) -> Result<(), ContractError> {
    if artifacts
        .iter()
        .any(|artifact| artifact.as_text().is_none())
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}

/// Exact UTF-8 bytes, including BOMs and original line endings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapturedTextArtifact {
    pub id: String,
    pub logical_path: String,
    pub role: String,
    pub sha256: String,
    pub utf8: String,
}

/// Canonical padded RFC 4648 base64 of the original bytes. The digest describes
/// the decoded bytes, never their transport encoding. Decoding is domain-owned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapturedBinaryArtifact {
    pub id: String,
    pub logical_path: String,
    pub role: String,
    pub sha256: String,
    pub base64: String,
}

/// Exactly one representation. Text retains its original wire shape; mixed,
/// null and unknown fields are rejected by the two closed representations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum CapturedArtifact {
    Text(CapturedTextArtifact),
    Binary(CapturedBinaryArtifact),
}

/// A captured payload without file identity, for owners that retain their own
/// typed IDs and immutable manifest. Uses the same byte decoder as artifacts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "encoding",
    content = "value",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum CapturedArtifactData {
    Utf8(String),
    Base64(String),
}
impl CapturedArtifactData {
    pub fn bytes(&self) -> Result<Cow<'_, [u8]>, ContractError> {
        match self {
            Self::Utf8(text) => Ok(Cow::Borrowed(text.as_bytes())),
            Self::Base64(encoded) => decode_binary(encoded).map(Cow::Owned),
        }
    }
    pub fn into_artifact(
        self,
        id: String,
        logical_path: String,
        role: String,
        sha256: String,
    ) -> CapturedArtifact {
        match self {
            Self::Utf8(utf8) => CapturedTextArtifact {
                id,
                logical_path,
                role,
                sha256,
                utf8,
            }
            .into(),
            Self::Base64(base64) => CapturedBinaryArtifact {
                id,
                logical_path,
                role,
                sha256,
                base64,
            }
            .into(),
        }
    }
}

fn decode_binary(encoded: &str) -> Result<Vec<u8>, ContractError> {
    if encoded.len() > MAX_EXCHANGE_BYTES.div_ceil(3) * 4 {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "content.artifacts.base64",
        ));
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| {
        ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "content.artifacts.base64",
        )
    })?;
    if bytes.len() > MAX_EXCHANGE_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "content.artifacts",
        ));
    }
    Ok(bytes)
}

impl From<CapturedTextArtifact> for CapturedArtifact {
    fn from(value: CapturedTextArtifact) -> Self {
        Self::Text(value)
    }
}
impl From<CapturedBinaryArtifact> for CapturedArtifact {
    fn from(value: CapturedBinaryArtifact) -> Self {
        Self::Binary(value)
    }
}

impl CapturedArtifact {
    pub fn data(&self) -> CapturedArtifactData {
        match self {
            Self::Text(value) => CapturedArtifactData::Utf8(value.utf8.clone()),
            Self::Binary(value) => CapturedArtifactData::Base64(value.base64.clone()),
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Self::Text(value) => &value.id,
            Self::Binary(value) => &value.id,
        }
    }
    pub fn logical_path(&self) -> &str {
        match self {
            Self::Text(value) => &value.logical_path,
            Self::Binary(value) => &value.logical_path,
        }
    }
    pub fn role(&self) -> &str {
        match self {
            Self::Text(value) => &value.role,
            Self::Binary(value) => &value.role,
        }
    }
    pub fn sha256(&self) -> &str {
        match self {
            Self::Text(value) => &value.sha256,
            Self::Binary(value) => &value.sha256,
        }
    }
    pub fn as_text(&self) -> Option<&CapturedTextArtifact> {
        match self {
            Self::Text(value) => Some(value),
            Self::Binary(_) => None,
        }
    }
    pub fn as_text_mut(&mut self) -> Option<&mut CapturedTextArtifact> {
        match self {
            Self::Text(value) => Some(value),
            Self::Binary(_) => None,
        }
    }
    /// Decode bounded transport bytes. Metadata and digest are checked by
    /// `validated_bytes`; callers must not treat decoding alone as validation.
    pub fn bytes(&self) -> Result<Cow<'_, [u8]>, ContractError> {
        match self {
            Self::Text(value) => Ok(Cow::Borrowed(value.utf8.as_bytes())),
            Self::Binary(value) => decode_binary(&value.base64).map(Cow::Owned),
        }
    }
    pub fn validated_bytes(&self) -> Result<Cow<'_, [u8]>, ContractError> {
        use crate::validation::{digest, name, opaque_id, path};
        opaque_id(self.id(), "content.artifacts.id")?;
        path(self.logical_path(), "content.artifacts.logicalPath")?;
        name(self.role(), "content.artifacts.role")?;
        digest(self.sha256(), "content.artifacts.sha256")?;
        let bytes = self.bytes()?;
        if artifact_bytes_digest(&bytes) != self.sha256() {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "content.artifacts.sha256",
            ));
        }
        Ok(bytes)
    }
    pub fn from_bytes(
        id: String,
        logical_path: String,
        role: String,
        bytes: &[u8],
    ) -> Result<Self, ContractError> {
        if bytes.len() > MAX_EXCHANGE_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "content.artifacts",
            ));
        }
        let artifact = Self::Binary(CapturedBinaryArtifact {
            id,
            logical_path,
            role,
            sha256: artifact_bytes_digest(bytes),
            base64: STANDARD.encode(bytes),
        });
        artifact.validated_bytes()?;
        Ok(artifact)
    }
}

pub fn artifact_bytes_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Source coordinates are separate from ranges in decoded unit/target text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum SourceEncoding {
    Utf8Byte,
    Utf16,
    Grapheme,
    RawByte,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceRange {
    pub encoding: SourceEncoding,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub start: u32,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub end: u32,
}
impl From<TextRange> for SourceRange {
    fn from(range: TextRange) -> Self {
        Self {
            start: range.start,
            end: range.end,
            encoding: match range.encoding {
                TextEncoding::Utf8Byte => SourceEncoding::Utf8Byte,
                TextEncoding::Utf16 => SourceEncoding::Utf16,
                TextEncoding::Grapheme => SourceEncoding::Grapheme,
            },
        }
    }
}
impl SourceRange {
    pub fn raw_bytes(start: u32, end: u32) -> Self {
        Self {
            encoding: SourceEncoding::RawByte,
            start,
            end,
        }
    }
    pub fn text_range(&self) -> Result<TextRange, ContractError> {
        let encoding = match self.encoding {
            SourceEncoding::Utf8Byte => TextEncoding::Utf8Byte,
            SourceEncoding::Utf16 => TextEncoding::Utf16,
            SourceEncoding::Grapheme => TextEncoding::Grapheme,
            SourceEncoding::RawByte => {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidRange,
                    "content.source.range",
                ));
            }
        };
        Ok(TextRange {
            encoding,
            start: self.start,
            end: self.end,
        })
    }
    /// Return half-open offsets in the captured original bytes. Raw byte ranges
    /// never pass through Unicode conversion or point into the base64 string.
    pub fn byte_range(&self, artifact: &CapturedArtifact) -> Result<[u32; 2], ContractError> {
        let invalid = || ContractError::at(ContractErrorCode::InvalidRange, "content.source.range");
        match artifact {
            CapturedArtifact::Binary(_) => {
                if self.encoding != SourceEncoding::RawByte
                    || self.start > self.end
                    || self.end as usize > artifact.bytes()?.len()
                {
                    return Err(invalid());
                }
                Ok([self.start, self.end])
            }
            CapturedArtifact::Text(text) => {
                let range = crate::convert_text_range(
                    &text.utf8,
                    self.text_range()?,
                    TextEncoding::Utf8Byte,
                )?;
                Ok([range.start, range.end])
            }
        }
    }
}
