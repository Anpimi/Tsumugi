//! Explicit paired native-material contracts. The source is captured by Core;
//! it is neither a project read capability nor a path the worker may reopen.
use super::*;

/// Each side retains the original 2 MiB decoded-material ceiling. The extra
/// space is JSON/base64 framing, not permission to capture larger files.
pub const MAX_PAIRED_TRANSLATION_INPUT_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_PAIRED_TRANSLATION_RESULT_BYTES: usize = 8 * 1024 * 1024;

pub fn paired_translation_extraction_input_contract() -> ContractRef {
    ContractRef {
        schema_version: 3,
        ..translation_extraction_input_contract()
    }
}
pub fn paired_translation_exchange_contract() -> ContractRef {
    ContractRef {
        schema_version: 3,
        ..translation_exchange_contract()
    }
}
pub fn paired_translation_extraction_check_input_contract() -> ContractRef {
    ContractRef {
        schema_version: 3,
        ..translation_extraction_check_input_contract()
    }
}
pub fn paired_translation_import_declaration_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..translation_import_declaration_contract()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TranslationPairSource {
    pub source_language: String,
    pub artifacts: Vec<CapturedArtifact>,
}
impl TranslationPairSource {
    pub(super) fn validate(
        &self,
        profile: &ContractRef,
        source_set_id: &str,
    ) -> Result<(), ContractError> {
        validate_source_material(
            profile,
            source_set_id,
            &self.source_language,
            &self.artifacts,
        )
        .map(|_| ())
    }
}

pub(super) fn explicit_paired_source<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<TranslationPairSource>, D::Error> {
    TranslationPairSource::deserialize(deserializer).map(Some)
}
pub(super) fn explicit_single_material<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<TranslationMaterialDeclaration>, D::Error> {
    TranslationMaterialDeclaration::deserialize(deserializer).map(Some)
}

impl TranslationImportDeclaration {
    pub fn is_paired(&self) -> bool {
        self.material.is_none()
    }
    pub fn declaration_contract(&self) -> ContractRef {
        if self.is_paired() {
            paired_translation_import_declaration_contract()
        } else {
            translation_import_declaration_contract()
        }
    }
    pub(super) fn paired_capture(
        &self,
    ) -> Result<crate::source_import::MaterialCapture<'_>, ContractError> {
        if !self.is_paired() || self.file_sets.is_none() || self.max_total_bytes.is_none() {
            return Err(invalid("translationImport.fileSets"));
        }
        Ok(crate::source_import::MaterialCapture {
            materials: &[],
            file_sets: self.file_sets.as_deref(),
            max_total_bytes: self.max_total_bytes,
        })
    }
    pub fn resolve_paired_materials(
        &self,
        selections: &[SourceFileSetSelection],
    ) -> Result<Vec<SourceMaterialDeclaration>, ContractError> {
        self.validate()?;
        self.paired_capture()?.resolve_materials(selections)
    }
    pub fn validate_paired_capture_sizes(
        &self,
        selections: &[SourceFileSetSelection],
        sizes: &[usize],
    ) -> Result<(), ContractError> {
        self.validate()?;
        self.paired_capture()?
            .validate_capture_sizes(selections, sizes)
    }
}
impl TranslationImportBinding {
    pub(super) fn validate_paired_input(
        &self,
        input: &TranslationExtractionInput,
    ) -> Result<(), ContractError> {
        if input.paired_source.is_none() || input.profile != self.declaration.profile {
            return Err(mismatch("translationImport.pairedSource"));
        }
        let sets = self
            .declaration
            .file_sets
            .as_deref()
            .ok_or_else(|| invalid("translationImport.fileSets"))?;
        let selections: Vec<_> = sets
            .iter()
            .map(|set| SourceFileSetSelection {
                id: set.id.clone(),
                logical_paths: input
                    .artifacts
                    .iter()
                    .filter(|artifact| artifact.role() == set.role)
                    .map(|artifact| artifact.logical_path().into())
                    .collect(),
            })
            .collect();
        let resolved = self.declaration.resolve_paired_materials(&selections)?;
        if resolved.len() != input.artifacts.len() {
            return Err(mismatch("translationImport.materials"));
        }
        for (material, artifact) in resolved.iter().zip(&input.artifacts) {
            let text = artifact.as_text().is_some();
            if material.logical_path != artifact.logical_path()
                || material.role != artifact.role()
                || !matches!(
                    (&material.encoding, text),
                    (SourceMaterialEncoding::Utf8, true) | (SourceMaterialEncoding::Binary, false)
                )
            {
                return Err(mismatch("translationImport.materials"));
            }
        }
        let sizes = input
            .artifacts
            .iter()
            .map(|artifact| artifact.bytes().map(|bytes| bytes.len()))
            .collect::<Result<Vec<_>, _>>()?;
        self.declaration
            .validate_paired_capture_sizes(&selections, &sizes)
    }
}

pub fn parse_paired_translation_extraction_input(
    bytes: &[u8],
) -> Result<TranslationExtractionInput, ContractError> {
    let value: TranslationExtractionInput = parse(
        bytes,
        MAX_PAIRED_TRANSLATION_INPUT_BYTES,
        "pairedTranslationInput",
    )?;
    value.validate()?;
    if value.paired_source.is_none() {
        return Err(invalid("pairedTranslationInput.source"));
    }
    Ok(value)
}
pub fn parse_paired_translation_exchange(
    bytes: &[u8],
) -> Result<TranslationExchange, ContractError> {
    let value: TranslationExchange = parse(
        bytes,
        MAX_PAIRED_TRANSLATION_RESULT_BYTES,
        "pairedTranslationExchange",
    )?;
    value.validate_with_limit(MAX_PAIRED_TRANSLATION_RESULT_BYTES)?;
    Ok(value)
}
pub fn parse_paired_translation_extraction_check_input(
    bytes: &[u8],
) -> Result<TranslationExtractionCheckInput, ContractError> {
    let value: TranslationExtractionCheckInput = parse(
        bytes,
        MAX_INVOCATION_PAYLOAD_BYTES,
        "pairedTranslationCheck",
    )?;
    value.validate()?;
    if value.input.paired_source.is_none() {
        return Err(invalid("pairedTranslationCheck.source"));
    }
    Ok(value)
}
pub fn parse_translation_import_declaration_for_contract(
    bytes: &[u8],
    schema: &ContractRef,
) -> Result<TranslationImportDeclaration, ContractError> {
    if *schema == translation_import_declaration_contract() {
        parse_translation_import_declaration(bytes)
    } else if *schema == paired_translation_import_declaration_contract() {
        parse_paired_translation_import_declaration(bytes)
    } else {
        Err(invalid("translationImport.schema"))
    }
}

pub fn parse_paired_translation_import_declaration(
    bytes: &[u8],
) -> Result<TranslationImportDeclaration, ContractError> {
    let declaration: TranslationImportDeclaration = parse(
        bytes,
        MAX_TRANSLATION_IMPORT_DECLARATION_BYTES,
        "pairedTranslationImport",
    )?;
    declaration.validate()?;
    if !declaration.is_paired() {
        return Err(invalid("pairedTranslationImport.material"));
    }
    Ok(declaration)
}

#[cfg(feature = "schema")]
pub fn paired_translation_extraction_input_schema() -> schemars::Schema {
    super::schema::paired_input()
}
#[cfg(feature = "schema")]
pub fn paired_translation_exchange_schema() -> schemars::Schema {
    translation_exchange_schema()
}
#[cfg(feature = "schema")]
pub fn paired_translation_extraction_check_input_schema() -> schemars::Schema {
    super::schema::paired_check_input()
}
#[cfg(feature = "schema")]
pub fn paired_translation_import_declaration_schema() -> schemars::Schema {
    super::schema::paired_declaration()
}
#[cfg(feature = "schema")]
pub fn paired_translation_types_schema() -> schemars::Schema {
    super::schema::paired_types()
}
