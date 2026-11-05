//! Read-only capture coverage for host presentation. Counts describe only the
//! declared projection of captured material, never translation or release status.
use serde::{Deserialize, Serialize};

use crate::{
    CapturedArtifact, ContentTarget, ContractError, ContractErrorCode, ContractRef, DomainBlock,
    ExtensionHandling, SourceReference,
    content::SourceReferences,
    validation::{encoded_limit, opaque_id, unique},
};

pub const SOURCE_CAPTURE_SUMMARY_SCHEMA_ID: &str = "tsumugi.source-capture-summary";
pub const MAX_SOURCE_CAPTURE_SUMMARY_BYTES: usize = 64 * 1024;
pub const MAX_SOURCE_CAPTURE_MATERIALS: usize = 64;
pub const MAX_SOURCE_CAPTURE_GROUPS: usize = 256;
pub const MAX_SOURCE_CAPTURE_PROPERTIES: usize = 16;
pub const MAX_SOURCE_CAPTURE_VALUES: usize = 256;
pub const MAX_SOURCE_CAPTURE_LABEL_BYTES: usize = 128;
pub const MAX_SOURCE_CAPTURE_TEXT_BYTES: usize = 1024;

pub fn source_capture_summary_contract() -> ContractRef {
    ContractRef {
        id: SOURCE_CAPTURE_SUMMARY_SCHEMA_ID.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceCaptureCounts {
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub items: u32,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub items_with_fields: u32,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub declared_fields: u32,
    #[cfg_attr(feature = "schema", schemars(schema_with = "crate::offset_schema"))]
    pub non_empty_fields: u32,
}
impl SourceCaptureCounts {
    fn valid(&self) -> bool {
        self.items_with_fields <= self.items
            && (self.declared_fields == 0) == (self.items_with_fields == 0)
            && self.items_with_fields <= self.declared_fields
            && self.non_empty_fields <= self.declared_fields
    }
    fn values(&self) -> [u64; 4] {
        [
            self.items,
            self.items_with_fields,
            self.declared_fields,
            self.non_empty_fields,
        ]
        .map(u64::from)
    }
}

/// Labels and values are literal plugin-authored data, rendered as plain text.
/// An empty values list explicitly reports no values, rather than missing data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceCaptureProperty {
    pub label: String,
    pub values: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceCaptureGroup {
    pub label: String,
    pub counts: SourceCaptureCounts,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceCaptureMaterial {
    /// Captured parse-input evidence, not a filesystem path or read permission.
    pub source: SourceReference,
    pub properties: Vec<SourceCaptureProperty>,
    pub counts: SourceCaptureCounts,
    /// When supplied, the disjoint groups must sum to the material counts.
    pub groups: Vec<SourceCaptureGroup>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceCaptureSummary {
    pub materials: Vec<SourceCaptureMaterial>,
}

fn invalid(code: ContractErrorCode) -> ContractError {
    ContractError::at(code, "sourceCaptureSummary")
}
fn label(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_SOURCE_CAPTURE_LABEL_BYTES
        && !value.chars().any(char::is_control)
}
impl SourceCaptureSummary {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.materials.is_empty() || self.materials.len() > MAX_SOURCE_CAPTURE_MATERIALS {
            return Err(invalid(if self.materials.is_empty() {
                ContractErrorCode::InvalidCoverage
            } else {
                ContractErrorCode::LimitExceeded
            }));
        }
        unique(
            self.materials.iter().map(|m| &m.source.artifact_id),
            "sourceCaptureSummary.materials",
        )?;
        for material in &self.materials {
            opaque_id(
                &material.source.artifact_id,
                "sourceCaptureSummary.source.artifactId",
            )?;
            if material.source.range.start >= material.source.range.end || !material.counts.valid()
            {
                return Err(invalid(ContractErrorCode::InvalidCoverage));
            }
            if material.properties.len() > MAX_SOURCE_CAPTURE_PROPERTIES
                || material.groups.len() > MAX_SOURCE_CAPTURE_GROUPS
            {
                return Err(invalid(ContractErrorCode::LimitExceeded));
            }
            unique(
                material.properties.iter().map(|p| &p.label),
                "sourceCaptureSummary.properties",
            )?;
            unique(
                material.groups.iter().map(|g| &g.label),
                "sourceCaptureSummary.groups",
            )?;
            for property in &material.properties {
                if !label(&property.label)
                    || property.values.len() > MAX_SOURCE_CAPTURE_VALUES
                    || property.values.iter().any(|value| {
                        value.is_empty()
                            || value.len() > MAX_SOURCE_CAPTURE_TEXT_BYTES
                            || value.contains('\0')
                    })
                {
                    return Err(invalid(ContractErrorCode::InvalidDeclaration));
                }
            }
            let mut totals = [0u64; 4];
            for group in &material.groups {
                if !label(&group.label) || !group.counts.valid() {
                    return Err(invalid(ContractErrorCode::InvalidCoverage));
                }
                for (total, count) in totals.iter_mut().zip(group.counts.values()) {
                    *total += count;
                }
            }
            if !material.groups.is_empty() && totals != material.counts.values() {
                return Err(invalid(ContractErrorCode::InvalidCoverage));
            }
        }
        encoded_limit(
            self,
            MAX_SOURCE_CAPTURE_SUMMARY_BYTES,
            "sourceCaptureSummary",
        )
    }
    /// The caller supplies validated captured artifacts. This checks reference
    /// bounds, not artifact authenticity, domain truth or execution permission.
    pub fn validate_sources(&self, artifacts: &[CapturedArtifact]) -> Result<(), ContractError> {
        self.validate_with_sources(&mut SourceReferences::new(artifacts))
    }
    fn validate_with_sources(
        &self,
        sources: &mut SourceReferences<'_>,
    ) -> Result<(), ContractError> {
        self.validate()?;
        for material in &self.materials {
            sources.validate(&material.source)?;
        }
        Ok(())
    }
}

pub fn parse_source_capture_summary(bytes: &[u8]) -> Result<SourceCaptureSummary, ContractError> {
    if bytes.len() > MAX_SOURCE_CAPTURE_SUMMARY_BYTES {
        return Err(invalid(ContractErrorCode::LimitExceeded));
    }
    let value: SourceCaptureSummary =
        serde_json::from_slice(bytes).map_err(|_| invalid(ContractErrorCode::InvalidSchema))?;
    value.validate()?;
    Ok(value)
}
pub fn parse_source_capture_summary_block(
    block: &DomainBlock,
    artifacts: &[CapturedArtifact],
) -> Result<SourceCaptureSummary, ContractError> {
    parse_block_with_sources(block, &mut SourceReferences::new(artifacts))
}
pub(crate) fn parse_block_with_sources(
    block: &DomainBlock,
    sources: &mut SourceReferences<'_>,
) -> Result<SourceCaptureSummary, ContractError> {
    if block.schema != source_capture_summary_contract()
        || block.target != ContentTarget::Snapshot
        || block.handling != ExtensionHandling::Preserve
    {
        return Err(invalid(ContractErrorCode::UnsupportedExtension));
    }
    let summary = parse_source_capture_summary(block.payload_utf8.as_bytes())?;
    summary.validate_with_sources(sources)?;
    Ok(summary)
}
#[cfg(feature = "schema")]
pub fn source_capture_summary_schema() -> schemars::Schema {
    schemars::schema_for!(SourceCaptureSummary)
}
#[cfg(feature = "schema")]
pub fn source_capture_summary_profile() -> serde_json::Value {
    serde_json::json!({"contract":source_capture_summary_contract(),
        "maxBytes":MAX_SOURCE_CAPTURE_SUMMARY_BYTES, "maxMaterials":MAX_SOURCE_CAPTURE_MATERIALS,
        "maxGroups":MAX_SOURCE_CAPTURE_GROUPS, "maxProperties":MAX_SOURCE_CAPTURE_PROPERTIES,
        "maxValues":MAX_SOURCE_CAPTURE_VALUES, "maxLabelBytes":MAX_SOURCE_CAPTURE_LABEL_BYTES,
        "maxTextBytes":MAX_SOURCE_CAPTURE_TEXT_BYTES,
        "identifierPattern":crate::source_context_facts_profile().identifier_pattern})
}
