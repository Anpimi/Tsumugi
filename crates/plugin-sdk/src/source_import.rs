//! A captured package resource describes material and independent source checks.
//! It selects declarations, never filesystem or execution authority.
use crate::validation::{encoded_limit, name, reference, unique};
use crate::*;
use serde::{Deserialize, Serialize};

pub const MAX_SOURCE_IMPORT_DECLARATION_BYTES: usize = 32 * 1024;
pub const MAX_SOURCE_IMPORT_MATERIALS: usize = 32;

pub fn source_import_declaration_contract() -> ContractRef {
    ContractRef {
        id: "tsumugi.source-import-declaration".into(),
        schema_version: 5,
        behavior_version: 2,
    }
}
#[cfg(feature = "schema")]
pub fn source_import_declaration_schema() -> schemars::Schema {
    // Readers preserve v2/v3/v4 spelling. Current authoring states both the
    // selected sets and the actual shared byte budget explicitly.
    let mut schema = schemars::schema_for!(SourceImportDeclaration);
    schema
        .as_object_mut()
        .unwrap()
        .get_mut("required")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("fileSets"));
    schema
        .as_object_mut()
        .unwrap()
        .get_mut("required")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("maxTotalBytes"));
    let material = schema
        .as_object_mut()
        .expect("object schema")
        .get_mut("$defs")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|defs| defs.get_mut("SourceMaterialDeclaration"))
        .and_then(serde_json::Value::as_object_mut)
        .expect("material definition");
    let required = material
        .get_mut("required")
        .and_then(serde_json::Value::as_array_mut)
        .expect("material required fields");
    if !required.iter().any(|field| field == "encoding") {
        required.push(serde_json::json!("encoding"));
    }
    schema
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum SourceMaterialEncoding {
    Utf8,
    Binary,
    #[serde(skip)]
    LegacyUtf8,
}
fn legacy_utf8() -> SourceMaterialEncoding {
    SourceMaterialEncoding::LegacyUtf8
}
fn is_legacy_utf8(value: &SourceMaterialEncoding) -> bool {
    *value == SourceMaterialEncoding::LegacyUtf8
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceMaterialDeclaration {
    pub logical_path: String,
    pub role: String,
    pub max_bytes: u32,
    #[serde(default = "legacy_utf8", skip_serializing_if = "is_legacy_utf8")]
    pub encoding: SourceMaterialEncoding,
}

/// Explicit user choices within one authorized root. No glob, directory scan,
/// absolute path, or permission is part of this declaration or its resolution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceFileSetDeclaration {
    pub id: String,
    pub display_name: String,
    pub role: String,
    pub encoding: SourceMaterialEncoding,
    pub extensions: Vec<String>,
    pub min_files: u32,
    pub max_files: u32,
    pub max_bytes: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceFileSetSelection {
    pub id: String,
    pub logical_paths: Vec<String>,
}

fn explicit_file_sets<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<SourceFileSetDeclaration>>, D::Error> {
    Vec::<SourceFileSetDeclaration>::deserialize(deserializer).map(Some)
}
fn explicit_total_bytes<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u32>, D::Error> {
    u32::deserialize(deserializer).map(Some)
}
#[cfg(feature = "schema")]
fn total_bytes_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":1, "maximum":MAX_EXCHANGE_BYTES})
}

/// Fixed materials and explicitly chosen file sets share one captured input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceImportDeclaration {
    pub display_name: String,
    pub profile: ContractRef,
    pub materials: Vec<SourceMaterialDeclaration>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "explicit_file_sets"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "Vec<SourceFileSetDeclaration>"))]
    pub file_sets: Option<Vec<SourceFileSetDeclaration>>,
    /// v5 caps the sum of actual captured bytes, independently of the per-file
    /// ceilings. Absence retains the exact v2/v3/v4 reservation semantics.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "explicit_total_bytes"
    )]
    #[cfg_attr(feature = "schema", schemars(schema_with = "total_bytes_schema"))]
    pub max_total_bytes: Option<u32>,
    pub extractor: String,
    pub checker: String,
    /// Exact immutable Resource whose domain rules are adopted with this source.
    pub review_resource: String,
    pub revision_policy: SourceRevisionPolicy,
    pub semantic_rules: Vec<ContractRef>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceImportBinding {
    pub declaration: SourceImportDeclaration,
    pub extractor: CapabilityBinding,
    pub checker: CapabilityBinding,
    pub review: ReviewBinding,
}

fn invalid(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidDeclaration, field)
}
fn validate_materials(
    materials: &[SourceMaterialDeclaration],
    limit: usize,
    reserve_maximum: bool,
) -> Result<usize, ContractError> {
    if materials.len() > MAX_SOURCE_IMPORT_MATERIALS {
        return Err(invalid("sourceImport.materials"));
    }
    let mut paths: Vec<String> = Vec::new();
    let mut total = 0;
    for material in materials {
        validate_package_path(&material.logical_path)?;
        name(&material.role, "sourceImport.materials.role")?;
        let folded = material.logical_path.to_ascii_lowercase();
        if folded.split('/').count() > 16
            || paths.iter().any(|prior| {
                *prior == folded
                    || prior.starts_with(&(folded.clone() + "/"))
                    || folded.starts_with(&(prior.clone() + "/"))
            })
        {
            return Err(invalid("sourceImport.materials.logicalPath"));
        }
        paths.push(folded);
        if material.max_bytes == 0 || material.max_bytes as usize > limit {
            return Err(invalid("sourceImport.materials.maxBytes"));
        }
        total += material.max_bytes as usize;
    }
    if reserve_maximum && total > limit {
        return Err(invalid("sourceImport.limits"));
    }
    Ok(total)
}
impl SourceImportDeclaration {
    pub fn is_legacy_text(&self) -> bool {
        self.file_sets.is_none()
            && !self.materials.is_empty()
            && self
                .materials
                .iter()
                .all(|material| is_legacy_utf8(&material.encoding))
    }
    pub fn declaration_contract(&self) -> ContractRef {
        ContractRef {
            schema_version: if self.max_total_bytes.is_some() {
                5
            } else if self.file_sets.is_some() {
                4
            } else if self.is_legacy_text() {
                2
            } else {
                3
            },
            ..source_import_declaration_contract()
        }
    }
    fn validate_current(&self) -> Result<(), ContractError> {
        self.validate()?;
        if self.file_sets.is_none() {
            return Err(invalid("sourceImport.fileSets"));
        }
        if self.max_total_bytes.is_none() {
            return Err(invalid("sourceImport.maxTotalBytes"));
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.display_name.trim().is_empty()
            || self.display_name.len() > 128
            || self.display_name.chars().any(char::is_control)
        {
            return Err(invalid("sourceImport.displayName"));
        }
        reference(&self.profile, "sourceImport.profile")?;
        name(&self.extractor, "sourceImport.extractor")?;
        name(&self.checker, "sourceImport.checker")?;
        name(&self.review_resource, "sourceImport.reviewResource")?;
        if self.extractor == self.checker {
            return Err(invalid("sourceImport.checker"));
        }
        self.revision_policy.validate()?;
        if self.revision_policy.profile != self.profile {
            return Err(invalid("sourceImport.revisionPolicy"));
        }
        if self.materials.len() > MAX_SOURCE_IMPORT_MATERIALS {
            return Err(invalid("sourceImport.materials"));
        }
        if self
            .materials
            .iter()
            .any(|material| is_legacy_utf8(&material.encoding))
            && !self.is_legacy_text()
        {
            return Err(invalid("sourceImport.materials.encoding"));
        }
        if self
            .max_total_bytes
            .is_some_and(|bytes| bytes == 0 || bytes as usize > MAX_EXCHANGE_BYTES)
            || (self.max_total_bytes.is_some() && self.file_sets.is_none())
        {
            return Err(invalid("sourceImport.maxTotalBytes"));
        }
        let limit = self.capture_byte_limit();
        let reserve_maximum = self.max_total_bytes.is_none();
        let mut total = validate_materials(&self.materials, limit, reserve_maximum)?;
        let mut maximum = self.materials.len();
        let mut minimum = self.materials.len();
        if let Some(sets) = &self.file_sets {
            if sets.len() > MAX_SOURCE_IMPORT_MATERIALS {
                return Err(invalid("sourceImport.fileSets"));
            }
            unique(sets.iter().map(|set| &set.id), "sourceImport.fileSets.id")?;
            for set in sets {
                name(&set.id, "sourceImport.fileSets.id")?;
                name(&set.role, "sourceImport.fileSets.role")?;
                if set.display_name.trim().is_empty()
                    || set.display_name.len() > 128
                    || set.display_name.chars().any(char::is_control)
                    || is_legacy_utf8(&set.encoding)
                    || set.max_files == 0
                    || set.max_files as usize > MAX_SOURCE_IMPORT_MATERIALS
                    || set.min_files > set.max_files
                    || set.max_bytes == 0
                    || set.max_bytes as usize > limit
                    || set.extensions.is_empty()
                    || set.extensions.len() > 16
                {
                    return Err(invalid("sourceImport.fileSets"));
                }
                unique(set.extensions.iter(), "sourceImport.fileSets.extensions")?;
                if set.extensions.iter().any(|ext| {
                    ext.is_empty()
                        || ext.len() > 16
                        || !ext
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
                }) {
                    return Err(invalid("sourceImport.fileSets.extensions"));
                }
                maximum += set.max_files as usize;
                minimum += set.min_files as usize;
                total += set.max_bytes as usize * set.max_files as usize;
            }
        }
        if maximum == 0
            || (reserve_maximum && minimum == 0)
            || maximum > MAX_SOURCE_IMPORT_MATERIALS
        {
            return Err(invalid("sourceImport.materials"));
        }
        if (reserve_maximum && total > limit)
            || self.semantic_rules.is_empty()
            || self.semantic_rules.len() > 32
        {
            return Err(invalid("sourceImport.limits"));
        }
        unique(self.semantic_rules.iter(), "sourceImport.semanticRules")?;
        for rule in &self.semantic_rules {
            reference(rule, "sourceImport.semanticRules")?;
        }
        encoded_limit(self, MAX_SOURCE_IMPORT_DECLARATION_BYTES, "sourceImport")
    }

    /// Resolve typed choices into the one ordered capture recipe. The caller
    /// separately authorizes and reads those relative files as one snapshot.
    pub fn resolve_materials(
        &self,
        selections: &[SourceFileSetSelection],
    ) -> Result<Vec<SourceMaterialDeclaration>, ContractError> {
        self.validate()?;
        let sets = self.file_sets.as_deref().unwrap_or(&[]);
        if selections.len() > sets.len() {
            return Err(invalid("sourceImport.selection"));
        }
        unique(
            selections.iter().map(|selection| &selection.id),
            "sourceImport.selection.id",
        )?;
        if selections
            .iter()
            .any(|selection| !sets.iter().any(|set| set.id == selection.id))
        {
            return Err(invalid("sourceImport.selection.id"));
        }
        let mut materials = self.materials.clone();
        for set in sets {
            let paths = selections
                .iter()
                .find(|selection| selection.id == set.id)
                .map(|selection| selection.logical_paths.as_slice())
                .unwrap_or(&[]);
            if paths.len() < set.min_files as usize || paths.len() > set.max_files as usize {
                return Err(invalid("sourceImport.selection.count"));
            }
            for path in paths {
                validate_package_path(path)?;
                let (stem, extension) = path
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .rsplit_once('.')
                    .ok_or_else(|| invalid("sourceImport.selection.extension"))?;
                if stem.is_empty()
                    || !set
                        .extensions
                        .iter()
                        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
                {
                    return Err(invalid("sourceImport.selection.extension"));
                }
                materials.push(SourceMaterialDeclaration {
                    logical_path: path.clone(),
                    role: set.role.clone(),
                    max_bytes: set.max_bytes,
                    encoding: set.encoding.clone(),
                });
            }
        }
        if materials.is_empty() {
            return Err(invalid("sourceImport.selection.count"));
        }
        validate_materials(
            &materials,
            self.capture_byte_limit(),
            self.max_total_bytes.is_none(),
        )?;
        Ok(materials)
    }

    pub fn capture_byte_limit(&self) -> usize {
        self.max_total_bytes
            .map(|bytes| bytes as usize)
            .unwrap_or(MAX_EXCHANGE_BYTES)
    }

    /// Validate measured bytes in the exact resolved order. Resolution is pure;
    /// it cannot reserve the per-file maxima as though they were observed sizes.
    pub fn validate_capture_sizes(
        &self,
        selections: &[SourceFileSetSelection],
        sizes: &[usize],
    ) -> Result<(), ContractError> {
        let resolved = self.resolve_materials(selections)?;
        if resolved.len() != sizes.len() {
            return Err(invalid("sourceImport.capture.count"));
        }
        let mut total = 0usize;
        for (material, size) in resolved.iter().zip(sizes) {
            total = total.checked_add(*size).ok_or_else(|| {
                ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "sourceImport.capture.bytes",
                )
            })?;
            if *size > material.max_bytes as usize || total > self.capture_byte_limit() {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "sourceImport.capture.bytes",
                ));
            }
        }
        Ok(())
    }

    /// Bind source and Review providers from the same captured manifest. The application
    /// separately chooses approved runtime bytes and grants each fixed attempt.
    pub fn bind(
        &self,
        manifest: &ValidatedManifest,
        package_digest: &str,
        review: &ReviewDeclaration,
    ) -> Result<SourceImportBinding, ContractError> {
        self.validate()?;
        let extractor = bind_capability(manifest, &self.extractor, package_digest)?;
        let checker = bind_capability(manifest, &self.checker, package_digest)?;
        let resource = manifest
            .manifest()
            .contributions
            .iter()
            .find(|entry| entry.id == self.review_resource)
            .ok_or_else(|| invalid("sourceImport.reviewResource"))?;
        if !matches!(&resource.contribution, ContributionKind::Resource { schema, .. }
            if *schema == review_declaration_contract())
        {
            return Err(invalid("sourceImport.reviewResource"));
        }
        let review = review.bind(manifest, package_digest)?;
        let binding = SourceImportBinding {
            declaration: self.clone(),
            extractor,
            checker,
            review,
        };
        binding.validate()?;
        Ok(binding)
    }
}
impl SourceImportBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.declaration.validate()?;
        self.extractor.validate()?;
        self.checker.validate()?;
        self.review.validate()?;
        if self.extractor.provider.plugin != self.checker.provider.plugin
            || self.extractor.provider.package_digest != self.checker.provider.package_digest
            || self.extractor.provider.contribution_id != self.declaration.extractor
            || self.checker.provider.contribution_id != self.declaration.checker
            || self.review.declaration.profile != self.declaration.profile
            || self.review.checker.provider.plugin != self.extractor.provider.plugin
            || self.review.checker.provider.package_digest != self.extractor.provider.package_digest
        {
            return Err(invalid("sourceImport.provider"));
        }
        for (binding, mut input, mut output) in [
            (
                &self.extractor,
                source_extraction_input_contract(),
                content_exchange_contract(),
            ),
            (
                &self.checker,
                source_extraction_check_input_contract(),
                check_results_contract(),
            ),
        ] {
            if self.declaration.is_legacy_text() {
                input.schema_version = 1;
                output.schema_version = if binding == &self.extractor { 2 } else { 1 };
            }
            let d = &binding.declaration;
            if d.input_schema != input
                || d.output_schema != output
                || d.error_schema != source_extraction_error_contract()
                || !d.profiles.contains(&self.declaration.profile)
                || !matches!(d.effect, EffectKind::ReadOnly | EffectKind::Proposal)
                || !crate::validation::domain_permissions_are_allowed(
                    &d.permissions,
                    d.input_schema.schema_version == 2,
                )
            {
                return Err(invalid("sourceImport.capability"));
            }
        }
        if self.checker.declaration.effect != EffectKind::ReadOnly {
            return Err(invalid("sourceImport.checker.effect"));
        }
        Ok(())
    }
}

pub fn parse_source_import_declaration(
    bytes: &[u8],
) -> Result<SourceImportDeclaration, ContractError> {
    if bytes.len() > MAX_SOURCE_IMPORT_DECLARATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "sourceImport",
        ));
    }
    let value: SourceImportDeclaration = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "sourceImport"))?;
    value.validate_current()?;
    Ok(value)
}

/// Decode the exact resource profile named by the captured package image.
pub fn parse_source_import_declaration_for_contract(
    bytes: &[u8],
    contract: &ContractRef,
) -> Result<SourceImportDeclaration, ContractError> {
    if contract == &source_import_declaration_contract() {
        return parse_source_import_declaration(bytes);
    }
    if ![2, 3, 4].iter().any(|version| {
        *contract
            == ContractRef {
                schema_version: *version,
                ..source_import_declaration_contract()
            }
    }) {
        return Err(invalid("sourceImport.contract"));
    }
    if bytes.len() > MAX_SOURCE_IMPORT_DECLARATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "sourceImport",
        ));
    }
    let value: SourceImportDeclaration = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "sourceImport"))?;
    value.validate()?;
    if value.declaration_contract() != *contract {
        return Err(invalid("sourceImport.contract"));
    }
    Ok(value)
}
