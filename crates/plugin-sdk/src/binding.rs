use crate::{
    validation::{digest, name, version},
    *,
};
use serde::{Deserialize, Serialize};

/// A fixed package/contribution choice, independent of any active instance.
/// Its digest is supplied by the trusted package owner; this value neither
/// authenticates those bytes nor grants permission to load or call them.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProviderSelectionBinding {
    pub plugin: PluginIdentity,
    pub component_id: String,
    pub contribution_id: String,
    pub package_digest: String,
}
impl ProviderSelectionBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_provider_selection(
            &self.plugin,
            &self.component_id,
            &self.contribution_id,
            &self.package_digest,
        )
    }
}

pub(crate) fn validate_provider_selection(
    plugin: &PluginIdentity,
    component_id: &str,
    contribution_id: &str,
    package_digest: &str,
) -> Result<(), ContractError> {
    name(&plugin.publisher, "binding.publisher")?;
    name(&plugin.id, "binding.pluginId")?;
    version(&plugin.version)?;
    name(component_id, "binding.componentId")?;
    name(contribution_id, "binding.contributionId")?;
    digest(package_digest, "binding.packageDigest")
}

/// Captured declaration data for one selected capability. Requested permissions
/// remain declarations; validation does not establish an active provider, a
/// grant, current authority or permission to adopt a result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapabilityBinding {
    pub provider: ProviderSelectionBinding,
    pub declaration: CapabilityDeclaration,
}
impl CapabilityBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.provider.validate()?;
        self.declaration.validate(&self.declaration.permissions)
    }
}

/// Capture the exact capability and owner from a validated manifest, with a
/// separately supplied package digest. This performs no package IO, source
/// authentication, dependency resolution, loading or authorization.
pub fn bind_capability(
    manifest: &ValidatedManifest,
    contribution_id: &str,
    package_digest: &str,
) -> Result<CapabilityBinding, ContractError> {
    name(contribution_id, "contributions.id")?;
    let manifest = manifest.manifest();
    let contribution = manifest
        .contributions
        .iter()
        .find(|contribution| contribution.id == contribution_id)
        .ok_or_else(|| {
            ContractError::at(ContractErrorCode::IncompatibleContract, "contributions.id")
        })?;
    let ContributionKind::Capability { declaration } = &contribution.contribution else {
        return Err(ContractError::at(
            ContractErrorCode::IncompatibleContract,
            "contributions.kind",
        ));
    };
    let owner = manifest
        .components
        .iter()
        .find(|component| component.id == contribution.component_id)
        .ok_or_else(|| {
            ContractError::at(ContractErrorCode::MissingOwner, "contributions.componentId")
        })?;
    let binding = CapabilityBinding {
        provider: ProviderSelectionBinding {
            plugin: manifest.plugin.clone(),
            component_id: owner.id.clone(),
            contribution_id: contribution.id.clone(),
            package_digest: package_digest.into(),
        },
        declaration: declaration.clone(),
    };
    binding.validate()?;
    Ok(binding)
}
