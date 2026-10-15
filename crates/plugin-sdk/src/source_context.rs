//! Source-associated context data. A declaration describes its claimed origin;
//! only the trusted caller and independent domain check can establish evidence.
//! These values carry no project identity, sharing consent or execution grant.

use serde::{Deserialize, Serialize};

use crate::{
    CapturedTextArtifact, ContractError, ContractErrorCode, ContractRef, DomainBlock,
    SourceReference,
    content::validate_source_reference,
    validation::{encoded_limit, opaque_id, unique},
};

pub const SOURCE_CONTEXT_FACTS_SCHEMA_ID: &str = "tsumugi.source-context-facts";
pub const MAX_SOURCE_CONTEXT_FACTS_BYTES: usize = 64 * 1024;
pub const MAX_SOURCE_CONTEXT_FACTS: usize = 32;
pub const MAX_SOURCE_CONTEXT_FACT_TEXT_BYTES: usize = 4096;
pub const MAX_SOURCE_CONTEXT_FACT_SOURCES: usize = 8;
const IDENTIFIER_PATTERN: &str = r"^[A-Za-z0-9.\-_:/]{1,128}(?![\s\S])";

pub fn source_context_facts_contract() -> ContractRef {
    ContractRef {
        id: SOURCE_CONTEXT_FACTS_SCHEMA_ID.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContextFactsProfile {
    pub contract: ContractRef,
    pub max_bytes: usize,
    pub max_facts: usize,
    pub max_text_bytes: usize,
    pub max_sources: usize,
    pub identifier_pattern: String,
}
pub fn source_context_facts_profile() -> SourceContextFactsProfile {
    SourceContextFactsProfile {
        contract: source_context_facts_contract(),
        max_bytes: MAX_SOURCE_CONTEXT_FACTS_BYTES,
        max_facts: MAX_SOURCE_CONTEXT_FACTS,
        max_text_bytes: MAX_SOURCE_CONTEXT_FACT_TEXT_BYTES,
        max_sources: MAX_SOURCE_CONTEXT_FACT_SOURCES,
        identifier_pattern: IDENTIFIER_PATTERN.into(),
    }
}

/// Classification for presentation, without interpreting a format's syntax or
/// normalizing its literal text. Other source-associated information uses Note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum SourceContextFactKind {
    Speaker,
    Role,
    Scene,
    Time,
    Location,
    Note,
}

/// References are observations in captured source, not proof of an inference.
/// Human project decisions remain in the project's independent revision owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum SourceContextFactOrigin {
    Extracted {
        #[cfg_attr(feature = "schema", schemars(schema_with = "sources_schema"))]
        sources: Vec<SourceReference>,
    },
    Inferred {
        #[cfg_attr(feature = "schema", schemars(schema_with = "text_schema"))]
        rationale: String,
        #[cfg_attr(feature = "schema", schemars(schema_with = "sources_schema"))]
        sources: Vec<SourceReference>,
    },
}
impl SourceContextFactOrigin {
    pub fn sources(&self) -> &[SourceReference] {
        match self {
            Self::Extracted { sources } | Self::Inferred { sources, .. } => sources,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceContextFact {
    /// Unique only inside this block; it is not a project revision or entity ID.
    #[cfg_attr(feature = "schema", schemars(schema_with = "id_schema"))]
    pub id: String,
    pub kind: SourceContextFactKind,
    #[cfg_attr(feature = "schema", schemars(schema_with = "text_schema"))]
    pub text: String,
    pub origin: SourceContextFactOrigin,
}

/// The surrounding DomainBlock supplies Snapshot/Unit/Occurrence applicability.
/// Empty facts report an explicit empty observation; absence is not that report.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceContextFacts {
    #[cfg_attr(feature = "schema", schemars(schema_with = "facts_schema"))]
    pub facts: Vec<SourceContextFact>,
}
impl SourceContextFacts {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.facts.len() > MAX_SOURCE_CONTEXT_FACTS {
            return Err(invalid(ContractErrorCode::LimitExceeded));
        }
        unique(
            self.facts.iter().map(|fact| &fact.id),
            "sourceContextFacts.id",
        )?;
        for fact in &self.facts {
            opaque_id(&fact.id, "sourceContextFacts.id")?;
            text(&fact.text)?;
            if let SourceContextFactOrigin::Inferred { rationale, .. } = &fact.origin {
                text(rationale)?;
            }
            let sources = fact.origin.sources();
            if sources.is_empty() || sources.len() > MAX_SOURCE_CONTEXT_FACT_SOURCES {
                return Err(invalid(if sources.is_empty() {
                    ContractErrorCode::InvalidCoverage
                } else {
                    ContractErrorCode::LimitExceeded
                }));
            }
            for (index, source) in sources.iter().enumerate() {
                opaque_id(&source.artifact_id, "sourceContextFacts.source.artifactId")?;
                if source.range.start >= source.range.end {
                    return Err(invalid(ContractErrorCode::InvalidRange));
                }
                if sources[..index].contains(source) {
                    return Err(invalid(ContractErrorCode::DuplicateIdentity));
                }
            }
        }
        encoded_limit(self, MAX_SOURCE_CONTEXT_FACTS_BYTES, "sourceContextFacts")
    }

    /// The material must come from the caller's captured source scope. Checking
    /// coordinates does not authenticate that material or establish fact truth.
    pub fn validate_sources(
        &self,
        artifacts: &[CapturedTextArtifact],
    ) -> Result<(), ContractError> {
        self.validate()?;
        for fact in &self.facts {
            for source in fact.origin.sources() {
                validate_source_reference(artifacts, source)?;
            }
        }
        Ok(())
    }
}

fn invalid(code: ContractErrorCode) -> ContractError {
    ContractError::at(code, "sourceContextFacts")
}
fn text(value: &str) -> Result<(), ContractError> {
    if value.is_empty() {
        return Err(invalid(ContractErrorCode::InvalidDeclaration));
    }
    if value.len() > MAX_SOURCE_CONTEXT_FACT_TEXT_BYTES {
        return Err(invalid(ContractErrorCode::LimitExceeded));
    }
    Ok(())
}

pub fn parse_source_context_facts(bytes: &[u8]) -> Result<SourceContextFacts, ContractError> {
    if bytes.len() > MAX_SOURCE_CONTEXT_FACTS_BYTES {
        return Err(invalid(ContractErrorCode::LimitExceeded));
    }
    let facts: SourceContextFacts =
        serde_json::from_slice(bytes).map_err(|_| invalid(ContractErrorCode::InvalidSchema))?;
    facts.validate()?;
    Ok(facts)
}

pub fn parse_source_context_block(
    block: &DomainBlock,
    artifacts: &[CapturedTextArtifact],
) -> Result<SourceContextFacts, ContractError> {
    if block.schema != source_context_facts_contract() {
        return Err(invalid(ContractErrorCode::UnsupportedExtension));
    }
    let facts = parse_source_context_facts(block.payload_utf8.as_bytes())?;
    facts.validate_sources(artifacts)?;
    Ok(facts)
}

#[cfg(feature = "schema")]
pub fn source_context_facts_schema() -> schemars::Schema {
    schemars::schema_for!(SourceContextFacts)
}

#[cfg(feature = "schema")]
fn id_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "string", "pattern": IDENTIFIER_PATTERN })
}
#[cfg(feature = "schema")]
fn text_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    // JSON Schema counts characters. Receivers additionally check UTF-8 bytes.
    schemars::json_schema!({ "type": "string", "pattern": format!(r"^[\s\S]{{1,{MAX_SOURCE_CONTEXT_FACT_TEXT_BYTES}}}(?![\s\S])") })
}
#[cfg(feature = "schema")]
fn sources_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "minItems": 1, "maxItems": MAX_SOURCE_CONTEXT_FACT_SOURCES,
        "items": generator.subschema_for::<SourceReference>() })
}
#[cfg(feature = "schema")]
fn facts_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "maxItems": MAX_SOURCE_CONTEXT_FACTS,
        "items": generator.subschema_for::<SourceContextFact>() })
}
