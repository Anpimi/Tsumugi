//! Action-local text choices retain original metadata without adopting policy.
use super::*;
use crate::execution::PluginExecutionBinding;
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckerKey {
    pub provider: sdk::ProviderSelectionBinding,
    pub profile: sdk::ContractRef,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewCheckerKind {
    Format,
    AdvisoryText,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewChecker {
    pub key: ReviewCheckerKey,
    pub kind: ReviewCheckerKind,
    pub binding: PluginExecutionBinding,
}
impl ReviewChecker {
    pub(super) fn format(binding: &crate::content::SourceReviewBinding) -> Self {
        Self {
            key: ReviewCheckerKey {
                provider: binding.checker.capability.provider.clone(),
                profile: binding.declaration.profile.clone(),
            },
            kind: ReviewCheckerKind::Format,
            binding: binding.checker.clone(),
        }
    }
}

/// Captured by the trusted package adapter. Selecting these rules neither
/// adopts Resource entries nor grants permission to run the checker.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AdvisoryReviewCheck {
    pub binding: sdk::TextReviewBinding,
    pub execution: PluginExecutionBinding,
    pub declaration_resource_id: String,
    pub resource_pins: Vec<sdk::TextReviewResourcePin>,
    pub rules: Vec<sdk::ContractRef>,
}
impl AdvisoryReviewCheck {
    pub fn capture(
        binding: &sdk::TextReviewBinding,
        execution: &PluginExecutionBinding,
        declaration_resource_id: &str,
        resource_pins: Vec<sdk::TextReviewResourcePin>,
        rules: Vec<sdk::ContractRef>,
    ) -> Result<Self, ExecutionError> {
        let value = Self {
            binding: binding.clone(),
            execution: execution.clone(),
            declaration_resource_id: declaration_resource_id.into(),
            resource_pins,
            rules,
        };
        value.validate()?;
        Ok(value)
    }
    pub fn checker(&self) -> ReviewChecker {
        ReviewChecker {
            key: ReviewCheckerKey {
                provider: self.binding.checker.provider.clone(),
                profile: self.binding.declaration.profile.clone(),
            },
            kind: ReviewCheckerKind::AdvisoryText,
            binding: self.execution.clone(),
        }
    }
    pub fn validate(&self) -> Result<(), ExecutionError> {
        let invalid = || failure(ErrorCode::InvalidInput, "advisory-review-choice");
        self.binding.validate().map_err(|_| invalid())?;
        self.checker().binding.validate_project_or_attempt()?;
        if self.execution.capability != self.binding.checker
            || self.execution.profile.as_ref() != Some(&self.binding.declaration.profile)
            || sdk::validate_contribution_id(&self.declaration_resource_id).is_err()
            || self.rules.is_empty()
            || self.rules.len() > sdk::MAX_REVIEW_RULES
            || self.rules.iter().collect::<BTreeSet<_>>().len() != self.rules.len()
            || self.rules.iter().any(|rule| {
                !self
                    .binding
                    .declaration
                    .rules
                    .iter()
                    .any(|r| &r.rule == rule)
            })
            || self.resource_pins.len() != self.binding.resources.len()
            || self
                .resource_pins
                .iter()
                .map(|p| &p.contribution_id)
                .collect::<BTreeSet<_>>()
                .len()
                != self.resource_pins.len()
            || self.resource_pins.iter().any(|pin| {
                sdk::validate_package_digest(&pin.sha256).is_err()
                    || !self
                        .binding
                        .resources
                        .iter()
                        .any(|r| r.contribution_id == pin.contribution_id && r.schema == pin.schema)
            })
        {
            return Err(invalid());
        }
        codec::encode(self, MAX_INPUT_BYTES)?;
        Ok(())
    }
}

pub(crate) fn validate_choices(choices: &[AdvisoryReviewCheck]) -> Result<(), ExecutionError> {
    if choices.len() > sdk::MAX_REVIEW_RULES
        || choices
            .iter()
            .map(|c| c.checker().key)
            .collect::<BTreeSet<_>>()
            .len()
            != choices.len()
    {
        return Err(failure(ErrorCode::InvalidInput, "advisory-review-choices"));
    }
    for choice in choices {
        choice.validate()?;
    }
    codec::encode(&choices, MAX_INPUT_BYTES)?;
    Ok(())
}

pub(in crate::persistence::review) fn request_digest(
    project: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    basis: &str,
    action: ExecutionId,
    choices: &[AdvisoryReviewCheck],
) -> Result<String, ExecutionError> {
    validate_choices(choices)?;
    digest(&(project, unit, locale, basis, action, choices))
}
