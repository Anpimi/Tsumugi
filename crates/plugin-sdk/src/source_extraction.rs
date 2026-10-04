//! Captured source material and the generic extraction result association.
//! Domain interpretation, execution permissions and project identity stay with
//! their respective owners; these data contracts grant none of those powers.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    CapturedTextArtifact, ContentExchange, ContractError, ContractErrorCode, ContractRef,
    MAX_EXCHANGE_BYTES, content::validate_source_material, validation::opaque_id,
};

pub const SOURCE_EXTRACTION_INPUT_SCHEMA_ID: &str = "tsumugi.source-extraction-input";
pub const CONTENT_EXCHANGE_SCHEMA_ID: &str = "tsumugi.content-exchange";
pub const SOURCE_EXTRACTION_ERROR_SCHEMA_ID: &str = "tsumugi.source-extraction-error";
pub const SOURCE_EXTRACTION_CONTRACT_VERSION: u32 = 1;
pub const MAX_SOURCE_EXTRACTION_ERROR_DETAIL_BYTES: usize = 4096;
pub const MAX_SOURCE_EXTRACTION_ERROR_BYTES: usize = 32 * 1024;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: SOURCE_EXTRACTION_CONTRACT_VERSION,
        behavior_version: SOURCE_EXTRACTION_CONTRACT_VERSION,
    }
}
pub fn source_extraction_input_contract() -> ContractRef {
    contract(SOURCE_EXTRACTION_INPUT_SCHEMA_ID)
}
pub fn content_exchange_contract() -> ContractRef {
    contract(CONTENT_EXCHANGE_SCHEMA_ID)
}
pub fn source_extraction_error_contract() -> ContractRef {
    contract(SOURCE_EXTRACTION_ERROR_SCHEMA_ID)
}

/// Raw captured UTF-8 material supplied for one selected extraction profile.
/// Logical paths and artifact IDs carry no filesystem or execution authority.
/// This input contains no authoritative project unit or source revision IDs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceExtractionInput {
    pub profile: ContractRef,
    pub source_set_id: String,
    pub source_language: String,
    pub artifacts: Vec<CapturedTextArtifact>,
}
impl SourceExtractionInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_source_material(
            &self.profile,
            &self.source_set_id,
            &self.source_language,
            &self.artifacts,
        )
    }
}

/// Finite public failure classifications; details never determine permissions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum SourceExtractionErrorCode {
    InvalidInput,
    UnsupportedProfile,
    InvalidSource,
    UnsupportedStructure,
    LimitExceeded,
    Cancelled,
}

/// A bounded public diagnostic. Producers must use public descriptions and
/// captured artifact IDs, never local paths, raw source text or secrets. Data
/// validation cannot establish that arbitrary diagnostic text is safe to share.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceExtractionError {
    pub code: SourceExtractionErrorCode,
    pub artifact_id: Option<String>,
    pub detail: String,
}
impl SourceExtractionError {
    pub fn validate(&self) -> Result<(), ContractError> {
        if let Some(artifact) = &self.artifact_id {
            opaque_id(artifact, "sourceExtractionError.artifactId")?;
        }
        if self.detail.is_empty()
            || self.detail.contains('\0')
            || self.detail.len() > MAX_SOURCE_EXTRACTION_ERROR_DETAIL_BYTES
        {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "sourceExtractionError.detail",
            ));
        }
        Ok(())
    }
}

pub fn parse_source_extraction_input(bytes: &[u8]) -> Result<SourceExtractionInput, ContractError> {
    if bytes.len() > MAX_EXCHANGE_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "sourceExtractionInput",
        ));
    }
    let input: SourceExtractionInput = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(ContractErrorCode::InvalidSchema, "sourceExtractionInput")
    })?;
    input.validate()?;
    Ok(input)
}

pub fn parse_source_extraction_error(bytes: &[u8]) -> Result<SourceExtractionError, ContractError> {
    if bytes.len() > MAX_SOURCE_EXTRACTION_ERROR_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "sourceExtractionError",
        ));
    }
    let error: SourceExtractionError = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(ContractErrorCode::InvalidSchema, "sourceExtractionError")
    })?;
    error.validate()?;
    Ok(error)
}

/// Match an extraction proposal to the exact captured material. This verifies
/// structure, references and unchanged artifact bytes/metadata, not domain
/// semantics, complete domain extraction or authoritative project identity.
pub fn validate_source_extraction(
    input: &SourceExtractionInput,
    exchange: &ContentExchange,
) -> Result<(), ContractError> {
    input.validate()?;
    exchange.validate()?;
    if input.profile != exchange.profile
        || input.source_set_id != exchange.source_set_id
        || input.source_language != exchange.source_language
    {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "sourceExtraction.content",
        ));
    }
    // Artifact collection order does not define occurrence order. IDs are
    // unique after validation; every captured byte and metadata field matches.
    let captured: BTreeMap<_, _> = input.artifacts.iter().map(|a| (&a.id, a)).collect();
    let proposed: BTreeMap<_, _> = exchange.artifacts.iter().map(|a| (&a.id, a)).collect();
    if captured != proposed {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "sourceExtraction.artifacts",
        ));
    }
    Ok(())
}

#[cfg(feature = "schema")]
pub fn source_extraction_input_schema() -> schemars::Schema {
    schemars::schema_for!(SourceExtractionInput)
}
#[cfg(feature = "schema")]
pub fn source_extraction_error_schema() -> schemars::Schema {
    schemars::schema_for!(SourceExtractionError)
}

/// Build-time type catalog for one generated JavaScript declaration file, not
/// another accepted wire envelope. Its definitions all come from Rust types.
#[cfg(feature = "schema")]
pub fn source_extraction_types_schema() -> schemars::Schema {
    #[allow(dead_code)]
    #[derive(schemars::JsonSchema)]
    struct SourceExtractionTypes {
        input: SourceExtractionInput,
        content: ContentExchange,
        error: SourceExtractionError,
    }
    schemars::schema_for!(SourceExtractionTypes)
}
