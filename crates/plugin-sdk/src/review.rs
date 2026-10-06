//! Domain review checks over fixed, operation-local source and selected text.
//! Policy, human decisions, waivers, runtime authority and persistence remain
//! host-owned. A declaration or a completed check grants none of those powers.

use crate::{
    validation::{encoded_limit, language_label, name, opaque_id, reference, unique},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_REVIEW_DECLARATION_BYTES: usize = 32 * 1024;
pub const MAX_REVIEW_RULES: usize = 32;
pub const MAX_REVIEW_ERROR_DETAIL_BYTES: usize = 4096;
pub const MISSING_REVIEW_TRANSLATION: &str = "missing-translation";

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
pub fn review_check_input_contract() -> ContractRef {
    contract("tsumugi.review-check-input")
}
pub fn review_declaration_contract() -> ContractRef {
    contract("tsumugi.review-declaration")
}
pub fn review_check_error_contract() -> ContractRef {
    contract("tsumugi.review-check-error")
}
fn invalid(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidDeclaration, field)
}
fn coverage(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidCoverage, field)
}

/// The original source unit identity/revision is operation-local. Missing text
/// stays explicit; it is not replaced by source text or treated as approval.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReviewSelection {
    pub unit_id: String,
    pub source_revision_id: String,
    pub translation_text: Option<String>,
}

/// Complete original content plus an explicit, nonempty subset to check for one
/// target language. Domain blocks and captured source bytes remain unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckInput {
    pub source: ContentExchange,
    pub target_language: String,
    pub selections: Vec<ReviewSelection>,
    pub requirements: Vec<CheckRequirement>,
}
impl ReviewCheckInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.source.validate()?;
        encoded_limit(&self.source, MAX_EXCHANGE_BYTES, "review.source")?;
        language_label(&self.target_language, "review.targetLanguage")?;
        if self.selections.is_empty() || self.selections.len() > MAX_CONTENT_ITEMS {
            return Err(coverage("review.selections"));
        }
        unique(
            self.selections.iter().map(|s| &s.unit_id),
            "review.selections",
        )?;
        for selected in &self.selections {
            opaque_id(&selected.unit_id, "review.unitId")?;
            opaque_id(&selected.source_revision_id, "review.sourceRevisionId")?;
            if !self.source.units.iter().any(|unit| {
                unit.id == selected.unit_id
                    && unit.source_revision_id == selected.source_revision_id
            }) {
                return Err(ContractError::at(
                    ContractErrorCode::ResultMismatch,
                    "review.sourceRevisionId",
                ));
            }
            if selected
                .translation_text
                .as_ref()
                .is_some_and(|text| text.len() > MAX_TEXT_BYTES)
            {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "review.translationText",
                ));
            }
        }
        if self.requirements.is_empty() || self.requirements.len() > MAX_REVIEW_RULES {
            return Err(coverage("review.requirements"));
        }
        unique(
            self.requirements.iter().map(|r| &r.key),
            "review.requirements",
        )?;
        let targets: BTreeSet<_> = self.selections.iter().map(|s| &s.unit_id).collect();
        let all_missing = self.selections.iter().all(|s| s.translation_text.is_none());
        let mut provider = None;
        for requirement in &self.requirements {
            requirement.validate()?;
            let CheckImplementation::Plugin { provider: actual } = &requirement.key.implementation
            else {
                return Err(coverage("review.implementation"));
            };
            if provider
                .as_ref()
                .is_some_and(|expected| *expected != actual)
            {
                return Err(coverage("review.provider"));
            }
            provider = Some(actual);
            if !requirement.mandatory
                || requirement.waivable
                || requirement.targets.iter().collect::<BTreeSet<_>>() != targets
            {
                return Err(coverage("review.requirements"));
            }
            if let Some(basis) = &requirement.not_applicable {
                if !all_missing || basis.code != MISSING_REVIEW_TRANSLATION {
                    return Err(coverage("review.notApplicable"));
                }
            }
        }
        encoded_limit(self, MAX_INVOCATION_PAYLOAD_BYTES, "reviewCheckInput")
    }
}

/// A rule may permit N/A only for a captured scope with no selected translation.
/// Source-only rules must still run for a source fallback. Domain findings in
/// this contract are mandatory and cannot acquire ordinary issue waivers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReviewRuleDeclaration {
    pub rule: ContractRef,
    pub requires_translation: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReviewDeclaration {
    pub profile: ContractRef,
    pub checker: String,
    pub rules: Vec<ReviewRuleDeclaration>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReviewBinding {
    pub declaration: ReviewDeclaration,
    pub checker: CapabilityBinding,
}
impl ReviewDeclaration {
    pub fn validate(&self) -> Result<(), ContractError> {
        reference(&self.profile, "reviewDeclaration.profile")?;
        name(&self.checker, "reviewDeclaration.checker")?;
        if self.rules.is_empty() || self.rules.len() > MAX_REVIEW_RULES {
            return Err(invalid("reviewDeclaration.rules"));
        }
        unique(
            self.rules.iter().map(|r| &r.rule.id),
            "reviewDeclaration.rules",
        )?;
        for rule in &self.rules {
            reference(&rule.rule, "reviewDeclaration.rules")?;
        }
        encoded_limit(self, MAX_REVIEW_DECLARATION_BYTES, "reviewDeclaration")
    }
    pub fn bind(
        &self,
        manifest: &ValidatedManifest,
        package_digest: &str,
    ) -> Result<ReviewBinding, ContractError> {
        self.validate()?;
        let binding = ReviewBinding {
            declaration: self.clone(),
            checker: bind_capability(manifest, &self.checker, package_digest)?,
        };
        binding.validate()?;
        Ok(binding)
    }
}
impl ReviewBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.declaration.validate()?;
        self.checker.validate()?;
        let d = &self.checker.declaration;
        if self.checker.provider.contribution_id != self.declaration.checker
            || d.input_schema != review_check_input_contract()
            || d.output_schema != check_results_contract()
            || d.error_schema != review_check_error_contract()
            || !d.profiles.contains(&self.declaration.profile)
            || d.effect != EffectKind::ReadOnly
            || d.permissions
                .iter()
                .any(|p| *p != PermissionRequest::CapturedInput)
        {
            return Err(invalid("reviewDeclaration.capability"));
        }
        Ok(())
    }

    /// Compare an already captured request to this exact immutable resource.
    /// The caller must still bind results to the actual execution channel and
    /// evaluate its independent Core/domain union with FixedCheckSet.
    pub fn validate_input(&self, input: &ReviewCheckInput) -> Result<(), ContractError> {
        self.validate()?;
        input.validate()?;
        if input.source.profile != self.declaration.profile
            || input.requirements.len() != self.declaration.rules.len()
        {
            return Err(coverage("review.binding"));
        }
        for requirement in &input.requirements {
            let Some(declared) = self
                .declaration
                .rules
                .iter()
                .find(|r| r.rule == requirement.key.rule)
            else {
                return Err(coverage("review.rule"));
            };
            if requirement.key.implementation
                != (CheckImplementation::Plugin {
                    provider: self.checker.provider.clone(),
                })
                || (requirement.not_applicable.is_some() && !declared.requires_translation)
            {
                return Err(coverage("review.binding"));
            }
        }
        Ok(())
    }
}

pub fn parse_review_check_input(bytes: &[u8]) -> Result<ReviewCheckInput, ContractError> {
    if bytes.len() > MAX_INVOCATION_PAYLOAD_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "reviewCheckInput",
        ));
    }
    let input: ReviewCheckInput = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "reviewCheckInput"))?;
    input.validate()?;
    Ok(input)
}
pub fn parse_review_declaration(bytes: &[u8]) -> Result<ReviewDeclaration, ContractError> {
    if bytes.len() > MAX_REVIEW_DECLARATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "reviewDeclaration",
        ));
    }
    let declaration: ReviewDeclaration = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "reviewDeclaration"))?;
    declaration.validate()?;
    Ok(declaration)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ReviewCheckErrorCode {
    InvalidInput,
    UnsupportedProfile,
    InvalidSource,
    InvalidTranslation,
    UnsupportedStructure,
    LimitExceeded,
    Cancelled,
}

/// Public descriptions and operation-local unit references only. Arbitrary
/// diagnostic text is not thereby authenticated or safe to disclose.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckError {
    pub code: ReviewCheckErrorCode,
    pub unit_id: Option<String>,
    pub detail: String,
}
impl ReviewCheckError {
    pub fn validate(&self) -> Result<(), ContractError> {
        if let Some(unit) = &self.unit_id {
            opaque_id(unit, "reviewCheckError.unitId")?;
        }
        if self.detail.is_empty()
            || self.detail.contains('\0')
            || self.detail.len() > MAX_REVIEW_ERROR_DETAIL_BYTES
        {
            return Err(invalid("reviewCheckError.detail"));
        }
        encoded_limit(self, MAX_REVIEW_DECLARATION_BYTES, "reviewCheckError")
    }
}
pub fn parse_review_check_error(bytes: &[u8]) -> Result<ReviewCheckError, ContractError> {
    if bytes.len() > MAX_REVIEW_DECLARATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "reviewCheckError",
        ));
    }
    let error: ReviewCheckError = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "reviewCheckError"))?;
    error.validate()?;
    Ok(error)
}

#[cfg(feature = "schema")]
pub fn review_check_input_schema() -> schemars::Schema {
    schemars::schema_for!(ReviewCheckInput)
}
#[cfg(feature = "schema")]
pub fn review_declaration_schema() -> schemars::Schema {
    schemars::schema_for!(ReviewDeclaration)
}
#[cfg(feature = "schema")]
pub fn review_check_error_schema() -> schemars::Schema {
    schemars::schema_for!(ReviewCheckError)
}
#[cfg(feature = "schema")]
pub fn review_types_schema() -> schemars::Schema {
    #[allow(dead_code)]
    #[derive(schemars::JsonSchema)]
    struct ReviewTypes {
        input: ReviewCheckInput,
        binding: ReviewBinding,
        results: Vec<CheckResult>,
        error: ReviewCheckError,
    }
    schemars::schema_for!(ReviewTypes)
}
