use crate::{
    validation::{digest, encoded_limit, name, opaque_id, path, reference, unique},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Captured UTF-8 bytes, including a BOM and original line endings. These are
/// immutable source evidence; logical paths are not local filesystem authority.
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceReference {
    pub artifact_id: String,
    pub range: TextRange,
}

/// Domain-confirmed spelling for presentation, separate from canonical
/// matching. A source reference is optional when the identity is derived.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct NativeIdentityDisplay {
    pub value: String,
    #[serde(deserialize_with = "Option::deserialize")]
    #[cfg_attr(
        feature = "schema",
        schemars(required, schema_with = "identity_display_source_schema")
    )]
    pub source: Option<SourceReference>,
}

#[cfg(feature = "schema")]
fn identity_display_source_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    generator.subschema_for::<Option<SourceReference>>()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct NativeIdentityEvidence {
    pub namespace: String,
    /// The domain's canonical matching value, not necessarily its original
    /// literal spelling. Core does not normalize this value again.
    pub value: String,
    pub policy: ContractRef,
    pub display: NativeIdentityDisplay,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ContentOccurrence {
    pub id: String,
    pub source: SourceReference,
    pub native_identity: Option<NativeIdentityEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProtectedFragment {
    pub kind: ContractRef,
    /// Coordinates into the decoded unit text, not its original artifact.
    pub range: TextRange,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ContentUnit {
    /// Operation-local reference or a captured project identity, as specified by
    /// the capability. A plugin cannot allocate authoritative project revisions.
    pub id: String,
    /// During extraction this is an operation-local proposal reference. Only
    /// Core may map it to an authoritative project source revision.
    pub source_revision_id: String,
    pub text: String,
    pub occurrences: Vec<ContentOccurrence>,
    pub protected_fragments: Vec<ProtectedFragment>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ContentRelation {
    pub kind: ContractRef,
    pub from_occurrence: String,
    pub to_occurrence: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ContentTarget {
    Snapshot,
    Unit { id: String },
    Occurrence { id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ExtensionHandling {
    /// An operation that needs this block must have the exact interpreter.
    Required,
    /// Preserve the payload exactly, including when its schema is understood.
    Preserve,
    /// Interpretation is optional; an unknown payload is still preserved.
    Optional,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct DomainBlock {
    pub target: ContentTarget,
    pub schema: ContractRef,
    pub handling: ExtensionHandling,
    /// Exact UTF-8 payload, intentionally not an open JSON property bag. Its
    /// schema is interpreted by the domain, without loss through Value parsing.
    pub payload_utf8: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ContentExchange {
    pub profile: ContractRef,
    pub source_set_id: String,
    pub source_language: String,
    pub artifacts: Vec<CapturedTextArtifact>,
    pub units: Vec<ContentUnit>,
    /// Exact occurrence order. Hierarchies and other graphs use typed relations.
    pub order: Vec<String>,
    pub relations: Vec<ContentRelation>,
    pub domain_blocks: Vec<DomainBlock>,
}

pub(crate) fn count(len: usize, field: &str) -> Result<(), ContractError> {
    if len > MAX_CONTENT_ITEMS {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, field));
    }
    Ok(())
}
impl ContentExchange {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_source_material(
            &self.profile,
            &self.source_set_id,
            &self.source_language,
            &self.artifacts,
        )?;
        for (len, field) in [
            (self.units.len(), "content.units"),
            (self.order.len(), "content.order"),
            (self.relations.len(), "content.relations"),
            (self.domain_blocks.len(), "content.domainBlocks"),
        ] {
            count(len, field)?;
        }
        unique(self.units.iter().map(|u| &u.id), "content.units.id")?;
        let mut occurrences = BTreeSet::new();
        for unit in &self.units {
            opaque_id(&unit.id, "content.units.id")?;
            opaque_id(&unit.source_revision_id, "content.units.sourceRevisionId")?;
            if unit.text.len() > MAX_TEXT_BYTES {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "content.units.text",
                ));
            }
            count(unit.occurrences.len(), "content.occurrences")?;
            count(unit.protected_fragments.len(), "content.protectedFragments")?;
            if unit.occurrences.is_empty() {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "content.occurrences",
                ));
            }
            for occurrence in &unit.occurrences {
                opaque_id(&occurrence.id, "content.occurrences.id")?;
                if !occurrences.insert(&occurrence.id) {
                    return Err(ContractError::at(
                        ContractErrorCode::DuplicateIdentity,
                        "content.occurrences.id",
                    ));
                }
                count(occurrences.len(), "content.occurrences")?;
                validate_source_reference(&self.artifacts, &occurrence.source)?;
                if let Some(identity) = &occurrence.native_identity {
                    validate_native_identity(&self.artifacts, identity)?;
                }
            }
            for fragment in &unit.protected_fragments {
                reference(&fragment.kind, "content.protectedFragments.kind")?;
                convert_text_range(&unit.text, fragment.range, TextEncoding::Utf8Byte)?;
            }
        }
        unique(self.order.iter(), "content.order")?;
        if self.order.iter().collect::<BTreeSet<_>>() != occurrences {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "content.order",
            ));
        }
        unique(
            self.relations
                .iter()
                .map(|r| (&r.kind, &r.from_occurrence, &r.to_occurrence)),
            "content.relations",
        )?;
        for relation in &self.relations {
            reference(&relation.kind, "content.relations.kind")?;
            if !occurrences.contains(&relation.from_occurrence)
                || !occurrences.contains(&relation.to_occurrence)
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "content.relations",
                ));
            }
        }
        unique(
            self.domain_blocks.iter().map(|b| (&b.target, &b.schema)),
            "content.domainBlocks",
        )?;
        for block in &self.domain_blocks {
            reference(&block.schema, "content.domainBlocks.schema")?;
            if !block.schema.id.contains('.') || block.payload_utf8.len() > MAX_EXCHANGE_BYTES {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "content.domainBlocks",
                ));
            }
            let exists = match &block.target {
                ContentTarget::Snapshot => true,
                ContentTarget::Unit { id } => self.units.iter().any(|u| u.id == *id),
                ContentTarget::Occurrence { id } => occurrences.contains(id),
            };
            if !exists {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "content.domainBlocks.target",
                ));
            }
            if block.schema == source_context_facts_contract() {
                parse_source_context_block(block, &self.artifacts)?;
            }
        }
        encoded_limit(self, MAX_EXCHANGE_BYTES, "contentExchange")
    }

    /// Use before an operation that needs domain interpretation. Reading stored
    /// text and opaque evidence does not require this operation-level check.
    pub fn require_supported_extensions(
        &self,
        supported: &[ContractRef],
    ) -> Result<(), ContractError> {
        self.validate()?;
        if self
            .domain_blocks
            .iter()
            .any(|b| b.handling == ExtensionHandling::Required && !supported.contains(&b.schema))
        {
            return Err(ContractError::at(
                ContractErrorCode::UnsupportedExtension,
                "content.domainBlocks.schema",
            ));
        }
        Ok(())
    }
}

pub(crate) fn validate_source_reference(
    artifacts: &[CapturedTextArtifact],
    source: &SourceReference,
) -> Result<(), ContractError> {
    let artifact = artifacts
        .iter()
        .find(|artifact| artifact.id == source.artifact_id)
        .ok_or_else(|| {
            ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "content.source.artifactId",
            )
        })?;
    convert_text_range(&artifact.utf8, source.range, TextEncoding::Utf8Byte)?;
    Ok(())
}

pub(crate) fn validate_native_scope(
    namespace: &str,
    policy: &ContractRef,
) -> Result<(), ContractError> {
    if namespace.is_empty() || namespace.len() > 256 || namespace.contains('\0') {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "content.nativeIdentity",
        ));
    }
    reference(policy, "content.nativeIdentity.policy")
}

pub(crate) fn validate_native_identity(
    artifacts: &[CapturedTextArtifact],
    identity: &NativeIdentityEvidence,
) -> Result<(), ContractError> {
    validate_native_scope(&identity.namespace, &identity.policy)?;
    if identity.value.is_empty()
        || identity.value.len() > 1024
        || identity.value.contains('\0')
        || identity.display.value.is_empty()
        || identity.display.value.len() > 1024
        || identity.display.value.contains('\0')
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "content.nativeIdentity",
        ));
    }
    if let Some(source) = &identity.display.source {
        validate_source_reference(artifacts, source)?;
    }
    Ok(())
}

/// One source-material validator shared by captured input and extracted content.
/// It checks wire labels and exact UTF-8 bytes, never a domain grammar or locale.
pub(crate) fn validate_source_material(
    profile: &ContractRef,
    source_set_id: &str,
    source_language: &str,
    artifacts: &[CapturedTextArtifact],
) -> Result<(), ContractError> {
    reference(profile, "content.profile")?;
    opaque_id(source_set_id, "content.sourceSetId")?;
    crate::validation::language_label(source_language, "content.sourceLanguage")?;
    // Canonical supported locales remain the host's existing locale owner's job.
    count(artifacts.len(), "content.artifacts")?;
    if artifacts.is_empty() {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "content.artifacts",
        ));
    }
    unique(artifacts.iter().map(|a| &a.id), "content.artifacts.id")?;
    unique(
        artifacts.iter().map(|a| &a.logical_path),
        "content.artifacts.logicalPath",
    )?;
    let mut total_bytes = 0usize;
    for artifact in artifacts {
        opaque_id(&artifact.id, "content.artifacts.id")?;
        path(&artifact.logical_path, "content.artifacts.logicalPath")?;
        name(&artifact.role, "content.artifacts.role")?;
        digest(&artifact.sha256, "content.artifacts.sha256")?;
        total_bytes = total_bytes.saturating_add(artifact.utf8.len());
        if total_bytes > MAX_EXCHANGE_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "content.artifacts",
            ));
        }
        if payload_digest(&artifact.utf8) != artifact.sha256 {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "content.artifacts.sha256",
            ));
        }
    }
    Ok(())
}

/// Verifies raw fidelity and opaque extension preservation, not domain meaning,
/// source identity adoption, segmentation or project authorization.
pub fn verify_content_preservation(
    before: &ContentExchange,
    after: &ContentExchange,
    interpreted: &[ContractRef],
) -> Result<(), ContractError> {
    before.validate()?;
    after.validate()?;
    if before.profile != after.profile
        || before.source_set_id != after.source_set_id
        || before.source_language != after.source_language
        || before.artifacts != after.artifacts
    {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "content.fidelity",
        ));
    }
    for block in &before.domain_blocks {
        if (block.handling == ExtensionHandling::Preserve || !interpreted.contains(&block.schema))
            && !after.domain_blocks.contains(block)
        {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "content.domainBlocks",
            ));
        }
    }
    Ok(())
}

/// For a capability that promises fixed segmentation, reject additional,
/// omitted or renamed units/occurrences and changed revision/ordering/relations.
/// Changed text is still only a proposal requiring domain checks and Core's
/// authorized identity/revision adoption. Extraction uses a different contract.
pub fn verify_fixed_content_scope(
    captured: &ContentExchange,
    proposed: &ContentExchange,
    interpreted: &[ContractRef],
) -> Result<(), ContractError> {
    verify_content_preservation(captured, proposed, interpreted)?;
    if captured.order != proposed.order
        || captured.relations != proposed.relations
        || captured.units.len() != proposed.units.len()
        || captured.units.iter().any(|unit| {
            !proposed.units.iter().any(|p| {
                p.id == unit.id
                    && p.source_revision_id == unit.source_revision_id
                    && p.occurrences == unit.occurrences
            })
        })
    {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "content.scope",
        ));
    }
    Ok(())
}
