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
        schema_version: 2,
        behavior_version: 2,
    }
}
#[cfg(feature = "schema")]
pub fn source_import_declaration_schema() -> schemars::Schema {
    schemars::schema_for!(SourceImportDeclaration)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceMaterialDeclaration {
    pub logical_path: String,
    pub role: String,
    pub max_bytes: u32,
}

/// All listed materials are required, relative to one user-selected directory.
/// This first contract supports fixed files, not globs or discovery programs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct SourceImportDeclaration {
    pub display_name: String,
    pub profile: ContractRef,
    pub materials: Vec<SourceMaterialDeclaration>,
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
impl SourceImportDeclaration {
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
        if self.materials.is_empty() || self.materials.len() > MAX_SOURCE_IMPORT_MATERIALS {
            return Err(invalid("sourceImport.materials"));
        }
        let mut paths: Vec<String> = Vec::new();
        let mut total = 0usize;
        for material in &self.materials {
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
            if material.max_bytes == 0 || material.max_bytes as usize > MAX_EXCHANGE_BYTES {
                return Err(invalid("sourceImport.materials.maxBytes"));
            }
            total += material.max_bytes as usize;
        }
        if total > MAX_EXCHANGE_BYTES
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
        for (binding, input, output) in [
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
            let d = &binding.declaration;
            if d.input_schema != input
                || d.output_schema != output
                || d.error_schema != source_extraction_error_contract()
                || !d.profiles.contains(&self.declaration.profile)
                || !matches!(d.effect, EffectKind::ReadOnly | EffectKind::Proposal)
                || d.permissions
                    .iter()
                    .any(|p| *p != PermissionRequest::CapturedInput)
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
    value.validate()?;
    Ok(value)
}
