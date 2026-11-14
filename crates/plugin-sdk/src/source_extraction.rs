//! Captured source material and the generic extraction result association.
//! Domain interpretation, execution permissions and project identity stay with
//! their respective owners; these data contracts grant none of those powers.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    CapturedArtifact, CheckImplementation, CheckRequirement, CheckResult, ContentExchange,
    ContractError, ContractErrorCode, ContractRef, MAX_CONTENT_EXCHANGE_BYTES,
    MAX_MATERIAL_INVOCATION_BYTES, MAX_SOURCE_EXTRACTION_INPUT_BYTES,
    checks::validate_check_results,
    content::validate_source_material,
    validation::{count, encoded_limit, opaque_id, reference, unique},
};

pub const SOURCE_EXTRACTION_INPUT_SCHEMA_ID: &str = "tsumugi.source-extraction-input";
pub const CONTENT_EXCHANGE_SCHEMA_ID: &str = "tsumugi.content-exchange";
pub const SOURCE_EXTRACTION_ERROR_SCHEMA_ID: &str = "tsumugi.source-extraction-error";
pub const SOURCE_EXTRACTION_CHECK_INPUT_SCHEMA_ID: &str = "tsumugi.source-extraction-check-input";
pub const CHECK_RESULTS_SCHEMA_ID: &str = "tsumugi.check-results";
pub const SOURCE_EXTRACTION_CONTRACT_VERSION: u32 = 1;
pub const CONTENT_EXCHANGE_SCHEMA_VERSION: u32 = 3;
pub const SOURCE_EXTRACTION_INPUT_SCHEMA_VERSION: u32 = 2;
pub const SOURCE_EXTRACTION_CHECK_INPUT_SCHEMA_VERSION: u32 = 2;
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
    ContractRef {
        schema_version: SOURCE_EXTRACTION_INPUT_SCHEMA_VERSION,
        ..contract(SOURCE_EXTRACTION_INPUT_SCHEMA_ID)
    }
}
pub fn content_exchange_contract() -> ContractRef {
    ContractRef {
        schema_version: CONTENT_EXCHANGE_SCHEMA_VERSION,
        ..contract(CONTENT_EXCHANGE_SCHEMA_ID)
    }
}
pub fn source_extraction_error_contract() -> ContractRef {
    contract(SOURCE_EXTRACTION_ERROR_SCHEMA_ID)
}
pub fn source_extraction_check_input_contract() -> ContractRef {
    ContractRef {
        schema_version: SOURCE_EXTRACTION_CHECK_INPUT_SCHEMA_VERSION,
        ..contract(SOURCE_EXTRACTION_CHECK_INPUT_SCHEMA_ID)
    }
}
pub fn check_results_contract() -> ContractRef {
    contract(CHECK_RESULTS_SCHEMA_ID)
}

/// Recognize the exact supported source contract pair. The original pair is
/// text-only; callers must keep its artifact representation restriction.
pub fn source_extraction_contracts_support_binary(
    input: &ContractRef,
    output: &ContractRef,
    error: &ContractRef,
) -> Result<bool, ContractError> {
    if error != &source_extraction_error_contract() {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "sourceExtraction.contracts",
        ));
    }
    if input == &source_extraction_input_contract() && output == &content_exchange_contract() {
        return Ok(true);
    }
    let old_input = ContractRef {
        schema_version: 1,
        ..source_extraction_input_contract()
    };
    let old_output = ContractRef {
        schema_version: 2,
        ..content_exchange_contract()
    };
    if input == &old_input && output == &old_output {
        return Ok(false);
    }
    Err(ContractError::at(
        ContractErrorCode::InvalidDeclaration,
        "sourceExtraction.contracts",
    ))
}

/// Captured by the trusted policy owner before a proposal is received. Only
/// these exact block schemas contribute opaque bytes to source revisions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceRevisionPolicy {
    pub profile: ContractRef,
    pub revision_basis: Vec<ContractRef>,
}
impl SourceRevisionPolicy {
    pub fn validate(&self) -> Result<(), ContractError> {
        reference(&self.profile, "sourceRevisionPolicy.profile")?;
        if self.revision_basis.len() > 32 {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "sourceRevisionPolicy.revisionBasis",
            ));
        }
        unique(
            self.revision_basis.iter(),
            "sourceRevisionPolicy.revisionBasis",
        )?;
        for basis in &self.revision_basis {
            reference(basis, "sourceRevisionPolicy.revisionBasis")?;
            if basis.id == crate::SOURCE_CAPTURE_SUMMARY_SCHEMA_ID {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "sourceRevisionPolicy.revisionBasis",
                ));
            }
        }
        Ok(())
    }
}

/// Raw captured text or binary material for one selected extraction profile.
/// Logical paths and artifact IDs carry no filesystem or execution authority.
/// This input contains no authoritative project unit or source revision IDs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceExtractionInput {
    pub profile: ContractRef,
    pub source_set_id: String,
    pub source_language: String,
    pub artifacts: Vec<CapturedArtifact>,
}
impl SourceExtractionInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_source_material(
            &self.profile,
            &self.source_set_id,
            &self.source_language,
            &self.artifacts,
        )?;
        encoded_limit(
            self,
            MAX_SOURCE_EXTRACTION_INPUT_BYTES,
            "sourceExtractionInput",
        )
    }
}

/// A domain checker receives captured source and the complete proposal, with
/// requirements fixed independently by its caller. Receiving these values does
/// not authenticate the selected provider or authorize adoption.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceExtractionCheckInput {
    pub source: SourceExtractionInput,
    pub proposal: ContentExchange,
    pub requirements: Vec<CheckRequirement>,
}
impl SourceExtractionCheckInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_source_extraction(&self.source, &self.proposal)?;
        count(
            self.requirements.len(),
            "sourceExtractionCheckInput.requirements",
        )?;
        if self.requirements.is_empty() {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "sourceExtractionCheckInput.requirements",
            ));
        }
        unique(
            self.requirements.iter().map(|r| &r.key),
            "sourceExtractionCheckInput.requirements",
        )?;
        for requirement in &self.requirements {
            requirement.validate()?;
            if !matches!(
                requirement.key.implementation,
                CheckImplementation::Plugin { .. }
            ) || !requirement.mandatory
                || requirement.waivable
                || requirement.not_applicable.is_some()
                || requirement.targets != [self.source.source_set_id.clone()]
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidCoverage,
                    "sourceExtractionCheckInput.requirements",
                ));
            }
        }
        encoded_limit(
            self,
            MAX_MATERIAL_INVOCATION_BYTES,
            "sourceExtractionCheckInput",
        )
    }
}

pub fn parse_content_exchange(bytes: &[u8]) -> Result<ContentExchange, ContractError> {
    let content = decode_content_exchange(bytes)?;
    validate_source_material(
        &content.profile,
        &content.source_set_id,
        &content.source_language,
        &content.artifacts,
    )?;
    content.validate_references()?;
    check_decoded_content_size(bytes.len(), &content, MAX_CONTENT_EXCHANGE_BYTES)?;
    Ok(content)
}

/// Decode a source result directly from its original bytes and match its
/// material to the captured input before interpreting occurrence references.
pub fn parse_source_extraction_result(
    input: &SourceExtractionInput,
    bytes: &[u8],
) -> Result<ContentExchange, ContractError> {
    let content = decode_content_exchange(bytes)?;
    validate_source_extraction_references(input, &content)?;
    check_decoded_content_size(bytes.len(), &content, MAX_CONTENT_EXCHANGE_BYTES)?;
    Ok(content)
}

fn decode_content_exchange(bytes: &[u8]) -> Result<ContentExchange, ContractError> {
    if bytes.len() > MAX_CONTENT_EXCHANGE_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "contentExchange",
        ));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "contentExchange"))
}

fn check_decoded_content_size(
    wire_size: usize,
    content: &ContentExchange,
    limit: usize,
) -> Result<(), ContractError> {
    // Compact JSON string escaping and unsigned numbers cannot grow. Serde
    // also accepts positional structs, which gain their field names when
    // written as objects. Allow 128 bytes per group of fields, including
    // nested refs and ranges. Occurrences may include two source references,
    // identity evidence, and its display or gain an omitted nativeIdentity.
    let mut groups = 2
        + content.artifacts.len()
        + content.units.len()
        + content.relations.len()
        + content.domain_blocks.len();
    for unit in &content.units {
        groups += 4 * unit.occurrences.len() + unit.protected_fragments.len();
    }
    if wire_size.saturating_add(groups.saturating_mul(128)) <= limit {
        return Ok(());
    }
    encoded_limit(content, limit, "contentExchange")
}

#[cfg(test)]
mod content_size_tests {
    use super::*;

    #[test]
    fn positional_structs_do_not_bypass_the_canonical_byte_limit() {
        let wire = br#"[
            ["profile",1,1],"source","en",
            [["artifact","sample.txt","primary","digest","sample"]],
            [["unit","revision","sample",[["occurrence",["artifact",["utf8-byte",0,6]],null]],[]]],
            ["occurrence"],[],[]
        ]"#;
        let content = decode_content_exchange(wire).unwrap();
        let compact_wire =
            serde_json::to_vec(&serde_json::from_slice::<serde_json::Value>(wire).unwrap()).unwrap();
        let canonical = serde_json::to_vec(&content).unwrap();
        assert!(canonical.len() > compact_wire.len());
        assert_eq!(
            check_decoded_content_size(compact_wire.len(), &content, canonical.len() - 1)
                .unwrap_err()
                .code,
            ContractErrorCode::LimitExceeded
        );
        check_decoded_content_size(compact_wire.len(), &content, canonical.len()).unwrap();
    }
}

pub fn parse_source_extraction_check_input(
    bytes: &[u8],
) -> Result<SourceExtractionCheckInput, ContractError> {
    if bytes.len() > MAX_MATERIAL_INVOCATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "sourceExtractionCheckInput",
        ));
    }
    let input: SourceExtractionCheckInput = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(
            ContractErrorCode::InvalidSchema,
            "sourceExtractionCheckInput",
        )
    })?;
    input.validate()?;
    Ok(input)
}

pub fn parse_check_results(bytes: &[u8]) -> Result<Vec<CheckResult>, ContractError> {
    if bytes.len() > crate::MAX_CHECK_RESULTS_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "checks.results",
        ));
    }
    let results: Vec<CheckResult> = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "checks.results"))?;
    validate_check_results(&results)?;
    Ok(results)
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
    if bytes.len() > MAX_SOURCE_EXTRACTION_INPUT_BYTES {
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
    validate_source_extraction_references(input, exchange)?;
    exchange.validate_encoded_size()
}

fn validate_source_extraction_references(
    input: &SourceExtractionInput,
    exchange: &ContentExchange,
) -> Result<(), ContractError> {
    input.validate()?;
    if input.profile != exchange.profile
        || input.source_set_id != exchange.source_set_id
        || input.source_language != exchange.source_language
    {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "sourceExtraction.content",
        ));
    }
    // Artifact order has no semantics. Exact equality and unique IDs bind
    // every proposed artifact to already checked material without redecoding.
    let captured: BTreeMap<_, _> = input.artifacts.iter().map(|a| (a.id(), a)).collect();
    let proposed: BTreeMap<_, _> = exchange.artifacts.iter().map(|a| (a.id(), a)).collect();
    if proposed.len() != exchange.artifacts.len() || captured != proposed {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "sourceExtraction.artifacts",
        ));
    }
    exchange.validate_references()
}

#[cfg(feature = "schema")]
pub fn source_extraction_input_schema() -> schemars::Schema {
    schemars::schema_for!(SourceExtractionInput)
}
#[cfg(feature = "schema")]
pub fn source_extraction_error_schema() -> schemars::Schema {
    schemars::schema_for!(SourceExtractionError)
}
#[cfg(feature = "schema")]
pub fn source_extraction_check_input_schema() -> schemars::Schema {
    schemars::schema_for!(SourceExtractionCheckInput)
}
#[cfg(feature = "schema")]
pub fn check_results_schema() -> schemars::Schema {
    schemars::schema_for!(Vec<CheckResult>)
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
        revision_policy: SourceRevisionPolicy,
        check_input: SourceExtractionCheckInput,
        check_results: Vec<CheckResult>,
    }
    schemars::schema_for!(SourceExtractionTypes)
}
