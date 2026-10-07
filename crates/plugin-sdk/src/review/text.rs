//! Explicit advisory checks over captured text, independent of source formats.
//! Resource pins and provider claims remain data until the Host verifies the
//! original package, bytes and execution channel. No operation grants authority.

use super::{
    MAX_REVIEW_DECLARATION_BYTES, MAX_REVIEW_ERROR_DETAIL_BYTES, MAX_REVIEW_RULES,
    MISSING_REVIEW_TRANSLATION, contract,
};
use crate::{
    checks::validate_check_results,
    validation::{digest, encoded_limit, language_label, name, opaque_id, reference, unique},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub fn text_review_declaration_contract() -> ContractRef {
    contract("tsumugi.text-review-declaration")
}
pub fn text_review_input_contract() -> ContractRef {
    contract("tsumugi.text-review-input")
}
pub fn text_review_report_contract() -> ContractRef {
    contract("tsumugi.text-review-report")
}
fn invalid(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidDeclaration, field)
}
fn coverage(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidCoverage, field)
}
fn public_text(value: &str, limit: usize, field: &str) -> Result<(), ContractError> {
    if value.is_empty() || value.contains('\0') {
        return Err(invalid(field));
    }
    if value.len() > limit {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, field));
    }
    Ok(())
}

/// Selecting a check is not adopting its resource or requiring its findings.
/// Blocking checks continue to use the original mandatory Review contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum TextReviewDisposition {
    Advisory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewRuleDeclaration {
    pub rule: ContractRef,
    pub requires_translation: bool,
    pub title: String,
    pub description: String,
}

/// One provider's available rules. An invocation must use an explicitly chosen
/// nonempty subset; installation and a matching spelling do not select rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewDeclaration {
    pub profile: ContractRef,
    pub checker: String,
    pub disposition: TextReviewDisposition,
    pub supporting_resources: Vec<String>,
    pub rules: Vec<TextReviewRuleDeclaration>,
}

/// A declared Resource contribution in the exact same package as the checker.
/// This mirrors Resource metadata, without coupling review to tool declarations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewResourceBinding {
    pub contribution_id: String,
    pub schema: ContractRef,
}
impl TextReviewResourceBinding {
    fn validate(&self) -> Result<(), ContractError> {
        name(&self.contribution_id, "textReview.resource.contributionId")?;
        reference(&self.schema, "textReview.resource.schema")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewBinding {
    pub declaration: TextReviewDeclaration,
    pub checker: CapabilityBinding,
    pub resources: Vec<TextReviewResourceBinding>,
}
impl TextReviewDeclaration {
    pub fn validate(&self) -> Result<(), ContractError> {
        reference(&self.profile, "textReviewDeclaration.profile")?;
        name(&self.checker, "textReviewDeclaration.checker")?;
        if self.rules.is_empty()
            || self.rules.len() > MAX_REVIEW_RULES
            || self.supporting_resources.len() > MAX_REVIEW_RULES
        {
            return Err(invalid("textReviewDeclaration.rules"));
        }
        unique(
            self.rules.iter().map(|r| &r.rule.id),
            "textReviewDeclaration.rules",
        )?;
        unique(
            self.supporting_resources.iter(),
            "textReviewDeclaration.resources",
        )?;
        for id in &self.supporting_resources {
            name(id, "textReviewDeclaration.resources")?;
        }
        for rule in &self.rules {
            reference(&rule.rule, "textReviewDeclaration.rules")?;
            public_text(
                &rule.title,
                MAX_REVIEW_ERROR_DETAIL_BYTES,
                "textReviewDeclaration.title",
            )?;
            public_text(
                &rule.description,
                MAX_REVIEW_ERROR_DETAIL_BYTES,
                "textReviewDeclaration.description",
            )?;
        }
        encoded_limit(self, MAX_REVIEW_DECLARATION_BYTES, "textReviewDeclaration")
    }

    /// Bind metadata only. The Host must independently capture Resource bytes,
    /// check current availability and obtain permission for actual execution.
    pub fn bind(
        &self,
        manifest: &ValidatedManifest,
        package_digest: &str,
    ) -> Result<TextReviewBinding, ContractError> {
        self.validate()?;
        let checker = bind_capability(manifest, &self.checker, package_digest)?;
        let resources = self
            .supporting_resources
            .iter()
            .map(|id| {
                let contribution = manifest
                    .manifest()
                    .contributions
                    .iter()
                    .find(|c| c.id == *id)
                    .ok_or_else(|| invalid("textReviewDeclaration.resources"))?;
                let ContributionKind::Resource { schema, .. } = &contribution.contribution else {
                    return Err(invalid("textReviewDeclaration.resources"));
                };
                Ok(TextReviewResourceBinding {
                    contribution_id: id.clone(),
                    schema: schema.clone(),
                })
            })
            .collect::<Result<Vec<_>, ContractError>>()?;
        let binding = TextReviewBinding {
            declaration: self.clone(),
            checker,
            resources,
        };
        binding.validate()?;
        Ok(binding)
    }
}

impl TextReviewBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.declaration.validate()?;
        self.checker.validate()?;
        let capability = &self.checker.declaration;
        if self.checker.provider.contribution_id != self.declaration.checker
            || capability.input_schema != text_review_input_contract()
            || capability.output_schema != text_review_report_contract()
            || capability.error_schema != review_check_error_contract()
            || !capability.profiles.contains(&self.declaration.profile)
            || capability.effect != EffectKind::ReadOnly
            || capability.permissions.as_slice() != [PermissionRequest::CapturedInput]
        {
            return Err(invalid("textReviewDeclaration.capability"));
        }
        if self.resources.len() != self.declaration.supporting_resources.len() {
            return Err(invalid("textReviewDeclaration.resources"));
        }
        unique(
            self.resources.iter().map(|r| &r.contribution_id),
            "textReviewDeclaration.resources",
        )?;
        for resource in &self.resources {
            resource.validate()?;
            if !self
                .declaration
                .supporting_resources
                .contains(&resource.contribution_id)
            {
                return Err(invalid("textReviewDeclaration.resources"));
            }
        }
        Ok(())
    }

    /// Accept only an explicit rule subset and the exact provider/profile and
    /// Resource schemas. SHA-256 syntax is checked here; actual bytes are not.
    pub fn validate_input(&self, input: &TextReviewCheckInput) -> Result<(), ContractError> {
        self.validate()?;
        input.validate()?;
        if input.profile != self.declaration.profile
            || input.resources.len() != self.resources.len()
        {
            return Err(coverage("textReview.binding"));
        }
        for pin in &input.resources {
            if !self.resources.iter().any(|resource| {
                resource.contribution_id == pin.contribution_id && resource.schema == pin.schema
            }) {
                return Err(coverage("textReview.resources"));
            }
        }
        for requirement in &input.requirements {
            let declared = self
                .declaration
                .rules
                .iter()
                .find(|r| r.rule == requirement.key.rule)
                .ok_or_else(|| coverage("textReview.rule"))?;
            if requirement.key.implementation
                != (CheckImplementation::Plugin {
                    provider: self.checker.provider.clone(),
                })
                || (requirement.not_applicable.is_some() && !declared.requires_translation)
            {
                return Err(coverage("textReview.binding"));
            }
        }
        encoded_limit(
            input,
            self.checker.declaration.limits.max_input_bytes as usize,
            "textReview.input",
        )
    }

    /// The Host must first receive the actual invocation/channel with
    /// receive_invocation_result. Payload metadata does not authenticate it.
    pub fn validate_report(
        &self,
        input: &TextReviewCheckInput,
        report: &TextReviewCheckReport,
    ) -> Result<(), ContractError> {
        self.validate_input(input)?;
        report.validate_against(input)?;
        encoded_limit(
            report,
            self.checker.declaration.limits.max_output_bytes as usize,
            "textReview.report",
        )
    }
}

/// Exact package Resource bytes captured by the Host, never a plugin's mutable
/// lookup or a claim that the referenced resource has been adopted by a project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewResourcePin {
    pub contribution_id: String,
    pub schema: ContractRef,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewSelection {
    pub unit_id: String,
    pub source_revision_id: String,
    pub source_text: String,
    pub translation_text: Option<String>,
}

/// Generic captured text only. The profile selects the text checker, not the
/// original file format. Mapping to project revisions remains Host-owned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewCheckInput {
    pub profile: ContractRef,
    pub source_language: String,
    pub target_language: String,
    pub resources: Vec<TextReviewResourcePin>,
    pub selections: Vec<TextReviewSelection>,
    pub requirements: Vec<CheckRequirement>,
}
impl TextReviewCheckInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        reference(&self.profile, "textReview.profile")?;
        language_label(&self.source_language, "textReview.sourceLanguage")?;
        language_label(&self.target_language, "textReview.targetLanguage")?;
        if self.resources.len() > MAX_REVIEW_RULES {
            return Err(coverage("textReview.resources"));
        }
        unique(
            self.resources.iter().map(|r| &r.contribution_id),
            "textReview.resources",
        )?;
        for resource in &self.resources {
            name(
                &resource.contribution_id,
                "textReview.resource.contributionId",
            )?;
            reference(&resource.schema, "textReview.resource.schema")?;
            digest(&resource.sha256, "textReview.resource.sha256")?;
        }
        if self.selections.is_empty() || self.selections.len() > MAX_CONTENT_ITEMS {
            return Err(coverage("textReview.selections"));
        }
        unique(
            self.selections.iter().map(|s| &s.unit_id),
            "textReview.selections",
        )?;
        for selected in &self.selections {
            opaque_id(&selected.unit_id, "textReview.unitId")?;
            opaque_id(&selected.source_revision_id, "textReview.sourceRevisionId")?;
            if selected.source_text.len() > MAX_TEXT_BYTES
                || selected
                    .translation_text
                    .as_ref()
                    .is_some_and(|text| text.len() > MAX_TEXT_BYTES)
            {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "textReview.text",
                ));
            }
        }
        if self.requirements.is_empty() || self.requirements.len() > MAX_REVIEW_RULES {
            return Err(coverage("textReview.requirements"));
        }
        unique(
            self.requirements.iter().map(|r| &r.key),
            "textReview.requirements",
        )?;
        let targets: BTreeSet<_> = self.selections.iter().map(|s| &s.unit_id).collect();
        let all_missing = self.selections.iter().all(|s| s.translation_text.is_none());
        let mut provider = None;
        for requirement in &self.requirements {
            requirement.validate()?;
            let CheckImplementation::Plugin { provider: actual } = &requirement.key.implementation
            else {
                return Err(coverage("textReview.implementation"));
            };
            if provider
                .as_ref()
                .is_some_and(|expected| *expected != actual)
            {
                return Err(coverage("textReview.provider"));
            }
            provider = Some(actual);
            if requirement.mandatory
                || requirement.waivable
                || requirement.targets.iter().collect::<BTreeSet<_>>() != targets
            {
                return Err(coverage("textReview.requirements"));
            }
            if let Some(basis) = &requirement.not_applicable {
                if !all_missing || basis.code != MISSING_REVIEW_TRANSLATION {
                    return Err(coverage("textReview.notApplicable"));
                }
            }
        }
        encoded_limit(self, MAX_INVOCATION_PAYLOAD_BYTES, "textReviewCheckInput")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum TextReviewField {
    Source,
    Translation,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewLocation {
    pub field: TextReviewField,
    pub range: TextRange,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewResourceEntry {
    pub contribution_id: String,
    pub entry_id: String,
}

/// Optional public presentation associated with one actual finding. Diagnostic
/// prose is not authenticated or sanitized by these structural checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewDiagnostic {
    pub key: CheckKey,
    pub code: String,
    pub target: String,
    pub location: Option<TextReviewLocation>,
    pub detail: Option<String>,
    pub suggestion: Option<String>,
    pub resource_entry: Option<TextReviewResourceEntry>,
}

/// A successful report includes one explicit outcome for every selected rule.
/// Failed/cancelled/unavailable outcomes are not converted to passed coverage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TextReviewCheckReport {
    pub results: Vec<CheckResult>,
    pub diagnostics: Vec<TextReviewDiagnostic>,
}
impl TextReviewCheckReport {
    /// Structural validation cannot establish complete request coverage, exact
    /// resources, scalar range boundaries or actual channel identity.
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.results.is_empty()
            || self.results.len() > MAX_REVIEW_RULES
            || self.diagnostics.len() > MAX_CONTENT_ITEMS
        {
            return Err(coverage("textReviewReport.results"));
        }
        validate_check_results(&self.results)?;
        let mut provider = None;
        let mut findings = BTreeSet::new();
        for result in &self.results {
            let CheckImplementation::Plugin { provider: actual } = &result.key.implementation
            else {
                return Err(coverage("textReviewReport.implementation"));
            };
            if provider
                .as_ref()
                .is_some_and(|expected| *expected != actual)
            {
                return Err(coverage("textReviewReport.provider"));
            }
            provider = Some(actual);
            if let CheckOutcome::Completed { findings: actual } = &result.outcome {
                for finding in actual {
                    findings.insert((&result.key, &finding.code, &finding.target));
                }
            }
        }
        unique(
            self.diagnostics
                .iter()
                .map(|d| (&d.key, &d.code, &d.target)),
            "textReviewReport.diagnostics",
        )?;
        for diagnostic in &self.diagnostics {
            if !findings.contains(&(&diagnostic.key, &diagnostic.code, &diagnostic.target)) {
                return Err(coverage("textReviewReport.finding"));
            }
            if let Some(location) = &diagnostic.location {
                if location.range.start > location.range.end {
                    return Err(ContractError::at(
                        ContractErrorCode::InvalidRange,
                        "textReviewReport.range",
                    ));
                }
            }
            if let Some(detail) = &diagnostic.detail {
                public_text(
                    detail,
                    MAX_REVIEW_ERROR_DETAIL_BYTES,
                    "textReviewReport.detail",
                )?;
            }
            if let Some(suggestion) = &diagnostic.suggestion {
                public_text(suggestion, MAX_TEXT_BYTES, "textReviewReport.suggestion")?;
            }
            if let Some(entry) = &diagnostic.resource_entry {
                name(
                    &entry.contribution_id,
                    "textReviewReport.resourceEntry.contributionId",
                )?;
                opaque_id(&entry.entry_id, "textReviewReport.resourceEntry.entryId")?;
            }
        }
        encoded_limit(self, MAX_EXCHANGE_BYTES, "textReviewCheckReport")
    }

    /// Compare with a trusted, captured input after actual channel reception.
    /// Missing, extra or mismatched results are invalid even for advisory rules.
    pub fn validate_against(&self, input: &TextReviewCheckInput) -> Result<(), ContractError> {
        input.validate()?;
        self.validate()?;
        if self.results.len() != input.requirements.len() {
            return Err(coverage("textReviewReport.results"));
        }
        let requirements: BTreeMap<_, _> = input
            .requirements
            .iter()
            .map(|r| (r.key.clone(), r))
            .collect();
        for result in &self.results {
            let expected = requirements
                .get(&result.key)
                .ok_or_else(|| coverage("textReviewReport.key"))?;
            if result.input_digest != expected.input_digest
                || result.scope_digest != expected.scope_digest
                || result.covered_targets.iter().collect::<BTreeSet<_>>()
                    != expected.targets.iter().collect()
            {
                return Err(coverage("textReviewReport.basis"));
            }
            if let CheckOutcome::NotApplicable { basis } = &result.outcome {
                if expected.not_applicable.as_ref() != Some(basis) {
                    return Err(coverage("textReviewReport.notApplicable"));
                }
            }
        }
        let selections: BTreeMap<_, _> = input
            .selections
            .iter()
            .map(|s| (s.unit_id.as_str(), s))
            .collect();
        for diagnostic in &self.diagnostics {
            let selected = selections
                .get(diagnostic.target.as_str())
                .ok_or_else(|| coverage("textReviewReport.target"))?;
            if let Some(location) = &diagnostic.location {
                let text = match location.field {
                    TextReviewField::Source => &selected.source_text,
                    TextReviewField::Translation => selected
                        .translation_text
                        .as_ref()
                        .ok_or_else(|| coverage("textReviewReport.translation"))?,
                };
                convert_text_range(text, location.range, location.range.encoding)?;
            }
            if let Some(entry) = &diagnostic.resource_entry {
                if !input
                    .resources
                    .iter()
                    .any(|r| r.contribution_id == entry.contribution_id)
                {
                    return Err(coverage("textReviewReport.resourceEntry"));
                }
            }
        }
        Ok(())
    }
}

pub fn parse_text_review_declaration(bytes: &[u8]) -> Result<TextReviewDeclaration, ContractError> {
    if bytes.len() > MAX_REVIEW_DECLARATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "textReviewDeclaration",
        ));
    }
    let declaration: TextReviewDeclaration = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(ContractErrorCode::InvalidSchema, "textReviewDeclaration")
    })?;
    declaration.validate()?;
    Ok(declaration)
}
pub fn parse_text_review_input(bytes: &[u8]) -> Result<TextReviewCheckInput, ContractError> {
    if bytes.len() > MAX_INVOCATION_PAYLOAD_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "textReviewCheckInput",
        ));
    }
    let input: TextReviewCheckInput = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "textReviewCheckInput"))?;
    input.validate()?;
    Ok(input)
}
pub fn parse_text_review_report(bytes: &[u8]) -> Result<TextReviewCheckReport, ContractError> {
    if bytes.len() > MAX_EXCHANGE_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "textReviewCheckReport",
        ));
    }
    let report: TextReviewCheckReport = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(ContractErrorCode::InvalidSchema, "textReviewCheckReport")
    })?;
    report.validate()?;
    Ok(report)
}

#[cfg(feature = "schema")]
pub fn text_review_declaration_schema() -> schemars::Schema {
    schemars::schema_for!(TextReviewDeclaration)
}
#[cfg(feature = "schema")]
pub fn text_review_input_schema() -> schemars::Schema {
    schemars::schema_for!(TextReviewCheckInput)
}
#[cfg(feature = "schema")]
pub fn text_review_report_schema() -> schemars::Schema {
    schemars::schema_for!(TextReviewCheckReport)
}
#[cfg(feature = "schema")]
pub fn text_review_types_schema() -> schemars::Schema {
    #[allow(dead_code)]
    #[derive(schemars::JsonSchema)]
    struct TextReviewTypes {
        declaration: TextReviewDeclaration,
        binding: TextReviewBinding,
        input: TextReviewCheckInput,
        report: TextReviewCheckReport,
        error: ReviewCheckError,
    }
    schemars::schema_for!(TextReviewTypes)
}
