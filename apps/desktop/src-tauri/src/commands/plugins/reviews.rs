//! Inspect advisory declarations or reopen the exact source format checker.
//! The installed catalog/runtime owner grants no permission through these reads.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;
use tsumugi_core::content::SourceReviewBinding;

pub(in crate::commands) mod text;
pub(in crate::commands) use text::TextReviewEnvironment;

/// Exact Resource/environment choice, without an execution grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTextReviewRequest {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: String,
}

/// An explicit action-local subset. Installation never selects these rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTextReviewSelection {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: String,
    pub rules: Vec<sdk::ContractRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTextReviewView {
    pub settings_revision: UnsignedDecimal,
    pub resource_id: String,
    pub binding: sdk::TextReviewBinding,
    pub resource_pins: Vec<sdk::TextReviewResourcePin>,
    pub rules: Vec<sdk::ContractRef>,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum PluginTextReviewAvailability {
    Ready { view: PluginTextReviewView },
    Unavailable { error: CommandError },
}

/// A missing environment is an observed unavailable Resource, never a synthetic
/// digest or a selectable request. An existing selection keeps its exact digest.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTextReviewListEntry {
    pub package: PluginPackageRequest,
    pub resource_id: String,
    pub environment_digest: Option<String>,
    pub availability: PluginTextReviewAvailability,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginTextReviewListView {
    pub settings_revision: UnsignedDecimal,
    pub entries: Vec<PluginTextReviewListEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginReviewView {
    pub settings_revision: UnsignedDecimal,
    pub declaration: sdk::ReviewDeclaration,
    pub checker: sdk::CapabilityBinding,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

pub(in crate::commands) type ReviewEnvironment = DeclaredEnvironment<sdk::ReviewBinding>;
impl ReviewEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginReviewView, CommandError> {
        Ok(PluginReviewView {
            settings_revision: self.settings_revision,
            declaration: self.binding.declaration.clone(),
            checker: self.binding.checker.clone(),
            package_origin: self.package.origin().into(),
            environment: self.runtime.environment(),
            environment_digest: self.runtime.environment().digest().map_err(|_| invalid())?,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_review(
        &self,
        captured: &SourceReviewBinding,
    ) -> Result<ReviewEnvironment, CommandError> {
        captured.checker.validate().map_err(|_| invalid())?;
        let capability = &captured.checker.capability;
        let environment = self.capture_capability_environment(
            &PluginPackageRequest {
                plugin: capability.provider.plugin.clone(),
                package_digest: capability.provider.package_digest.clone(),
            },
            None,
            &captured
                .checker
                .environment_digest()
                .map_err(|_| invalid())?,
            &[sdk::ComponentScope::Project],
            |image| {
                // The immutable source receipt owns this declaration; bind it
                // against the installed manifest rather than guessing a Resource.
                let binding = captured
                    .declaration
                    .bind(image.manifest(), &capability.provider.package_digest)
                    .map_err(|_| HostError::InvalidContract)?;
                if binding.checker != *capability {
                    return Err(HostError::PackageMismatch);
                }
                Ok((binding.clone(), [binding.checker]))
            },
        )?;
        if captured.checker.profile.as_ref() != Some(&environment.binding.declaration.profile)
            || environment.runtime.environment() != captured.checker.environment
        {
            return Err(invalid());
        }
        Ok(environment)
    }
}
