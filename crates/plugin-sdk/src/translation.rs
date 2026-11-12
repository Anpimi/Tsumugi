//! Complete existing-translation proposals and independent domain checks.
//! These operation-local entries allocate no project units/revisions. The
//! application owns current-source matching, locale consent and checked adoption.
use crate::{
    content::{
        SourceReferences, count, validate_native_identity, validate_native_scope,
        validate_source_material,
    },
    validation::{encoded_limit, name, opaque_id, reference, unique},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

mod paired;
pub use paired::*;
#[cfg(feature = "schema")]
mod schema;

pub const MAX_TRANSLATION_IMPORT_DECLARATION_BYTES: usize = 32 * 1024;
fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
pub fn translation_extraction_input_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.translation-extraction-input")
    }
}
pub fn translation_exchange_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.translation-exchange")
    }
}
pub fn translation_extraction_check_input_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.translation-extraction-check-input")
    }
}
pub fn translation_import_declaration_contract() -> ContractRef {
    contract("tsumugi.translation-import-declaration")
}
fn invalid(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidDeclaration, field)
}
fn mismatch(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::ResultMismatch, field)
}

/// Captured from the current adopted source. The plugin supplies canonical
/// native values under this exact policy; Core must never normalize them again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TranslationNativeScope {
    pub namespace: String,
    pub policy: ContractRef,
}

/// Describes the caller's recorded explicit choice, not an execution/adoption
/// grant. Only the trusted application can establish that consent actually ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum TranslationLanguageEvidence {
    UserConfirmed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TranslationExtractionInput {
    pub profile: ContractRef,
    pub import_id: String,
    pub source_set_id: String,
    pub source_snapshot_id: String,
    pub target_language: String,
    pub language_evidence: TranslationLanguageEvidence,
    pub native_scope: TranslationNativeScope,
    pub artifacts: Vec<CapturedArtifact>,
    /// Present only in the explicit paired schema-3 family.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "paired::explicit_paired_source"
    )]
    #[cfg_attr(feature = "schema", schemars(skip))]
    pub paired_source: Option<TranslationPairSource>,
}
impl TranslationExtractionInput {
    fn validate_material(&self) -> Result<(), ContractError> {
        validate_source_material(
            &self.profile,
            &self.source_set_id,
            &self.target_language,
            &self.artifacts,
        )?;
        opaque_id(&self.import_id, "translation.importId")?;
        opaque_id(&self.source_snapshot_id, "translation.sourceSnapshotId")?;
        validate_native_scope(&self.native_scope.namespace, &self.native_scope.policy)?;
        Ok(())
    }
    pub fn validate(&self) -> Result<(), ContractError> {
        self.validate_material()?;
        if let Some(source) = &self.paired_source {
            source.validate(&self.profile, &self.source_set_id)?;
        }
        encoded_limit(
            self,
            if self.paired_source.is_some() {
                MAX_PAIRED_TRANSLATION_INPUT_BYTES
            } else {
                MAX_EXCHANGE_BYTES
            },
            "translationExtractionInput",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ImportedTranslation {
    pub id: String,
    pub text: String,
    pub source: SourceReference,
    pub native_identity: NativeIdentityEvidence,
}

/// Complete captured file evidence is retained once, including an empty file.
/// Declared language is domain evidence, not an inferred project locale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TranslationExchange {
    pub profile: ContractRef,
    pub import_id: String,
    pub source_set_id: String,
    pub source_snapshot_id: String,
    pub target_language: String,
    pub declared_language: String,
    pub language_evidence: TranslationLanguageEvidence,
    pub native_scope: TranslationNativeScope,
    pub artifacts: Vec<CapturedArtifact>,
    pub entries: Vec<ImportedTranslation>,
    pub order: Vec<String>,
}
impl TranslationExchange {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.validate_with_limit(MAX_EXCHANGE_BYTES)
    }
    fn validate_with_limit(&self, limit: usize) -> Result<(), ContractError> {
        let input = TranslationExtractionInput {
            profile: self.profile.clone(),
            import_id: self.import_id.clone(),
            source_set_id: self.source_set_id.clone(),
            source_snapshot_id: self.source_snapshot_id.clone(),
            target_language: self.target_language.clone(),
            language_evidence: self.language_evidence,
            native_scope: self.native_scope.clone(),
            artifacts: self.artifacts.clone(),
            paired_source: None,
        };
        input.validate_material()?;
        // Registered/canonical languages and filename interpretation belong to
        // the existing application locale and selected domain owners.
        if self.declared_language.is_empty()
            || self.declared_language.len() > 128
            || !self
                .declared_language
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(invalid("translation.declaredLanguage"));
        }
        count(self.entries.len(), "translation.entries")?;
        count(self.order.len(), "translation.order")?;
        unique(
            self.entries.iter().map(|entry| &entry.id),
            "translation.entries.id",
        )?;
        unique(self.order.iter(), "translation.order")?;
        if self.order.iter().collect::<BTreeSet<_>>()
            != self
                .entries
                .iter()
                .map(|entry| &entry.id)
                .collect::<BTreeSet<_>>()
        {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "translation.order",
            ));
        }
        let mut sources = SourceReferences::new(&self.artifacts);
        for entry in &self.entries {
            opaque_id(&entry.id, "translation.entries.id")?;
            if entry.text.len() > MAX_TEXT_BYTES {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "translation.entries.text",
                ));
            }
            sources.validate(&entry.source)?;
            validate_native_identity(&mut sources, &entry.native_identity)?;
            if entry.native_identity.namespace != self.native_scope.namespace
                || entry.native_identity.policy != self.native_scope.policy
            {
                return Err(mismatch("translation.nativeScope"));
            }
        }
        encoded_limit(self, limit, "translationExchange")
    }
}

/// Structural association never interprets native keys, filename locales or
/// decoded text. A domain checker independently verifies complete semantics.
pub fn validate_translation_extraction(
    input: &TranslationExtractionInput,
    proposal: &TranslationExchange,
) -> Result<(), ContractError> {
    input.validate()?;
    proposal.validate_with_limit(if input.paired_source.is_some() {
        MAX_PAIRED_TRANSLATION_RESULT_BYTES
    } else {
        MAX_EXCHANGE_BYTES
    })?;
    if input.profile != proposal.profile
        || input.import_id != proposal.import_id
        || input.source_set_id != proposal.source_set_id
        || input.source_snapshot_id != proposal.source_snapshot_id
        || input.target_language != proposal.target_language
        || input.language_evidence != proposal.language_evidence
        || input.native_scope != proposal.native_scope
    {
        return Err(mismatch("translationExtraction.proposal"));
    }
    let captured: BTreeMap<_, _> = input.artifacts.iter().map(|a| (a.id(), a)).collect();
    let actual: BTreeMap<_, _> = proposal.artifacts.iter().map(|a| (a.id(), a)).collect();
    if captured != actual {
        return Err(mismatch("translationExtraction.artifacts"));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TranslationExtractionCheckInput {
    pub input: TranslationExtractionInput,
    pub proposal: TranslationExchange,
    pub requirements: Vec<CheckRequirement>,
}
impl TranslationExtractionCheckInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_translation_extraction(&self.input, &self.proposal)?;
        if self.requirements.is_empty() || self.requirements.len() > 32 {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "translationCheck.requirements",
            ));
        }
        unique(
            self.requirements.iter().map(|r| &r.key),
            "translationCheck.requirements",
        )?;
        for r in &self.requirements {
            r.validate()?;
            if !matches!(r.key.implementation, CheckImplementation::Plugin { .. })
                || !r.mandatory
                || r.waivable
                || r.not_applicable.is_some()
                || r.targets != [self.input.import_id.clone()]
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidCoverage,
                    "translationCheck.requirements",
                ));
            }
        }
        encoded_limit(self, if self.input.paired_source.is_some() { MAX_MATERIAL_INVOCATION_BYTES } else { MAX_INVOCATION_PAYLOAD_BYTES }, "translationCheck")
    }
}

/// Metadata describing one selected file relative to an explicitly granted
/// directory. No glob, executable discovery or filesystem authority is implied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TranslationMaterialDeclaration {
    pub logical_directory: String,
    pub extension: String,
    pub role: String,
    pub max_bytes: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(transform = schema::declaration_variants))]
pub struct TranslationImportDeclaration {
    pub display_name: String,
    pub profile: ContractRef,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "paired::explicit_single_material"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "TranslationMaterialDeclaration"))]
    pub material: Option<TranslationMaterialDeclaration>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::source_import::explicit_file_sets"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Vec<SourceFileSetDeclaration>"))]
    pub file_sets: Option<Vec<SourceFileSetDeclaration>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::source_import::explicit_total_bytes"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "u32"))]
    pub max_total_bytes: Option<u32>,
    pub extractor: String,
    pub checker: String,
    pub semantic_rules: Vec<ContractRef>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranslationImportBinding {
    pub declaration: TranslationImportDeclaration,
    pub extractor: CapabilityBinding,
    pub checker: CapabilityBinding,
}
impl TranslationImportDeclaration {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.display_name.trim().is_empty()
            || self.display_name.len() > 128
            || self.display_name.chars().any(char::is_control)
        {
            return Err(invalid("translationImport.displayName"));
        }
        reference(&self.profile, "translationImport.profile")?;
        name(&self.extractor, "translationImport.extractor")?;
        name(&self.checker, "translationImport.checker")?;
        if self.extractor == self.checker
            || self.semantic_rules.is_empty()
            || self.semantic_rules.len() > 32
        {
            return Err(invalid("translationImport.material"));
        }
        match (&self.material, &self.file_sets, self.max_total_bytes) {
            (Some(material), None, None) => {
                validate_portable_package_path(&material.logical_directory)?;
                name(&material.role, "translationImport.material.role")?;
                if material.logical_directory.split('/').count() > 15
                    || material.extension.is_empty()
                    || material.extension.len() > 16
                    || !material
                        .extension
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                    || material.max_bytes == 0
                    || material.max_bytes as usize > MAX_EXCHANGE_BYTES
                {
                    return Err(invalid("translationImport.material"));
                }
            }
            (None, Some(sets), Some(_)) => {
                self.paired_capture()?.validate()?;
                // A captured role identifies exactly one selected group. This
                // lets the binding reconstruct complete coverage from the bytes.
                unique(
                    sets.iter().map(|set| &set.role),
                    "translationImport.fileSets.role",
                )?;
            }
            _ => return Err(invalid("translationImport.material")),
        }
        unique(
            self.semantic_rules.iter(),
            "translationImport.semanticRules",
        )?;
        for rule in &self.semantic_rules {
            reference(rule, "translationImport.semanticRules")?;
        }
        encoded_limit(
            self,
            MAX_TRANSLATION_IMPORT_DECLARATION_BYTES,
            "translationImport",
        )
    }
    pub fn bind(
        &self,
        manifest: &ValidatedManifest,
        package_digest: &str,
    ) -> Result<TranslationImportBinding, ContractError> {
        self.validate()?;
        let binding = TranslationImportBinding {
            declaration: self.clone(),
            extractor: bind_capability(manifest, &self.extractor, package_digest)?,
            checker: bind_capability(manifest, &self.checker, package_digest)?,
        };
        binding.validate()?;
        Ok(binding)
    }
}
impl TranslationImportBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.declaration.validate()?;
        self.extractor.validate()?;
        self.checker.validate()?;
        if self.extractor.provider.plugin != self.checker.provider.plugin
            || self.extractor.provider.package_digest != self.checker.provider.package_digest
            || self.extractor.provider.contribution_id != self.declaration.extractor
            || self.checker.provider.contribution_id != self.declaration.checker
        {
            return Err(invalid("translationImport.provider"));
        }
        let paired = self.declaration.is_paired();
        let version = if paired {
            if self.extractor.declaration.input_schema
                != paired_translation_extraction_input_contract()
            {
                return Err(invalid("translationImport.capability"));
            }
            3
        } else {
            crate::artifact::artifact_contract_version(
                &self.extractor.declaration.input_schema,
                translation_extraction_input_contract(),
            )
            .ok_or_else(|| invalid("translationImport.capability"))?
        };
        for (binding, mut input, mut output) in [
            (
                &self.extractor,
                translation_extraction_input_contract(),
                translation_exchange_contract(),
            ),
            (
                &self.checker,
                translation_extraction_check_input_contract(),
                check_results_contract(),
            ),
        ] {
            if version == 1 {
                input.schema_version = 1;
                output.schema_version = 1;
            } else if paired {
                input.schema_version = 3;
                if binding == &self.extractor {
                    output.schema_version = 3;
                }
            }
            let d = &binding.declaration;
            if d.input_schema != input
                || d.output_schema != output
                || d.error_schema != source_extraction_error_contract()
                || !d.profiles.contains(&self.declaration.profile)
                || !matches!(d.effect, EffectKind::ReadOnly | EffectKind::Proposal)
                || !crate::validation::domain_permissions_are_allowed(&d.permissions, paired)
            {
                return Err(invalid("translationImport.capability"));
            }
        }
        if self.checker.declaration.effect != EffectKind::ReadOnly {
            return Err(invalid("translationImport.checker.effect"));
        }
        Ok(())
    }
    pub fn validate_input(&self, input: &TranslationExtractionInput) -> Result<(), ContractError> {
        self.validate()?;
        input.validate()?;
        if self.declaration.is_paired() {
            return self.validate_paired_input(input);
        }
        if input.paired_source.is_some() {
            return Err(mismatch("translationImport.pairedSource"));
        }
        if self.extractor.declaration.input_schema.schema_version == 1 {
            crate::artifact::require_text_artifacts(
                &input.artifacts,
                "translationImport.artifacts",
            )?;
        }
        if input.profile != self.declaration.profile || input.artifacts.len() != 1 {
            return Err(mismatch("translationImport.input"));
        }
        let artifact = &input.artifacts[0];
        let material = self
            .declaration
            .material
            .as_ref()
            .ok_or_else(|| invalid("translationImport.material"))?;
        validate_portable_package_path(artifact.logical_path())?;
        let prefix = format!("{}/", material.logical_directory);
        let leaf = artifact
            .logical_path()
            .strip_prefix(&prefix)
            .ok_or_else(|| mismatch("translationImport.path"))?;
        if leaf.contains('/')
            || !leaf.ends_with(&format!(".{}", material.extension))
            || leaf.len() <= material.extension.len() + 1
            || artifact.role() != material.role
            || artifact.bytes()?.len() > material.max_bytes as usize
        {
            return Err(mismatch("translationImport.material"));
        }
        Ok(())
    }
}

fn parse<T: serde::de::DeserializeOwned>(
    bytes: &[u8],
    limit: usize,
    field: &str,
) -> Result<T, ContractError> {
    if bytes.len() > limit {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, field));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, field))
}
pub fn parse_translation_extraction_input(
    bytes: &[u8],
) -> Result<TranslationExtractionInput, ContractError> {
    let v: TranslationExtractionInput =
        parse(bytes, MAX_EXCHANGE_BYTES, "translationExtractionInput")?;
    v.validate()?;
    if v.paired_source.is_some() {
        return Err(invalid("translationExtractionInput.pairedSource"));
    }
    Ok(v)
}
pub fn parse_translation_exchange(bytes: &[u8]) -> Result<TranslationExchange, ContractError> {
    let v: TranslationExchange = parse(bytes, MAX_EXCHANGE_BYTES, "translationExchange")?;
    v.validate()?;
    Ok(v)
}
pub fn parse_translation_extraction_check_input(
    bytes: &[u8],
) -> Result<TranslationExtractionCheckInput, ContractError> {
    let v: TranslationExtractionCheckInput =
        parse(bytes, MAX_INVOCATION_PAYLOAD_BYTES, "translationCheck")?;
    v.validate()?;
    if v.input.paired_source.is_some() {
        return Err(invalid("translationCheck.pairedSource"));
    }
    Ok(v)
}
pub fn parse_translation_import_declaration(
    bytes: &[u8],
) -> Result<TranslationImportDeclaration, ContractError> {
    let v: TranslationImportDeclaration = parse(
        bytes,
        MAX_TRANSLATION_IMPORT_DECLARATION_BYTES,
        "translationImport",
    )?;
    v.validate()?;
    if v.is_paired() {
        return Err(invalid("translationImport.contract"));
    }
    Ok(v)
}
#[cfg(feature = "schema")]
pub fn translation_extraction_input_schema() -> schemars::Schema {
    schemars::schema_for!(TranslationExtractionInput)
}
#[cfg(feature = "schema")]
pub fn translation_exchange_schema() -> schemars::Schema {
    schemars::schema_for!(TranslationExchange)
}
#[cfg(feature = "schema")]
pub fn translation_extraction_check_input_schema() -> schemars::Schema {
    schemars::schema_for!(TranslationExtractionCheckInput)
}
#[cfg(feature = "schema")]
pub fn translation_import_declaration_schema() -> schemars::Schema {
    schemars::schema_for!(schema::LegacyTranslationImportDeclaration)
}
#[cfg(feature = "schema")]
pub fn translation_types_schema() -> schemars::Schema {
    #[allow(dead_code)]
    #[derive(schemars::JsonSchema)]
    struct TranslationTypes {
        input: TranslationExtractionInput,
        exchange: TranslationExchange,
        check_input: TranslationExtractionCheckInput,
        declaration: schema::LegacyTranslationImportDeclaration,
    }
    schemars::schema_for!(TranslationTypes)
}
