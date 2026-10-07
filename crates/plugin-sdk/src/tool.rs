//! Read-only tool adapters select existing capabilities, never another executor,
//! installer, authority or project mutation path. Tool guidance is untrusted.
use crate::{
    validation::{encoded_limit, name, reference, unique},
    *,
};
use serde::{Deserialize, Serialize};
mod query;
pub use query::*;

pub const MAX_TOOL_DECLARATION_BYTES: usize = 16 * 1024;
pub const MAX_TOOL_RESOURCES: usize = 16;

pub fn tool_declaration_contract() -> ContractRef {
    ContractRef {
        id: "tsumugi.capability-tool-declaration".into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn invalid(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidDeclaration, field)
}
fn display(value: &str, maximum: usize, field: &str) -> Result<(), ContractError> {
    if value.trim().is_empty()
        || value.len() > maximum
        || value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(invalid(field));
    }
    Ok(())
}

/// A package-local adapter to one declared, read-only capability. Input/output
/// contracts, limits and permissions are taken from that capability, rather
/// than repeated in a model-specific descriptor. A profile is an exact choice.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapabilityToolDeclaration {
    pub name: String,
    pub title: String,
    pub description: String,
    pub capability_id: String,
    pub profile: Option<ContractRef>,
    pub supporting_resources: Vec<String>,
    pub skill: Option<String>,
    /// Optional bounded semantic text-query presentation. It grants no access
    /// beyond the original capability and remains untrusted package data.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<ToolQueryDeclaration>,
}
impl CapabilityToolDeclaration {
    pub fn validate(&self) -> Result<(), ContractError> {
        name(&self.name, "tool.name")?;
        name(&self.capability_id, "tool.capabilityId")?;
        display(&self.title, 256, "tool.title")?;
        display(&self.description, 4096, "tool.description")?;
        if let Some(profile) = &self.profile {
            reference(profile, "tool.profile")?;
        }
        if self.supporting_resources.len() > MAX_TOOL_RESOURCES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "tool.resources",
            ));
        }
        unique(self.supporting_resources.iter(), "tool.resources")?;
        for resource in &self.supporting_resources {
            name(resource, "tool.resources")?;
        }
        if let Some(skill) = &self.skill {
            name(skill, "tool.skill")?;
        }
        if let Some(query) = &self.query {
            query.validate()?;
        }
        encoded_limit(self, MAX_TOOL_DECLARATION_BYTES, "tool")
    }

    /// Bind only to this actual manifest/package selection. The Host must still
    /// capture supporting bytes and check current availability and permission.
    pub fn bind(
        &self,
        manifest: &ValidatedManifest,
        package_digest: &str,
    ) -> Result<CapabilityToolBinding, ContractError> {
        self.validate()?;
        let capability = bind_capability(manifest, &self.capability_id, package_digest)?;
        let mut resources = Vec::new();
        for id in &self.supporting_resources {
            let contribution = manifest
                .manifest()
                .contributions
                .iter()
                .find(|c| c.id == *id)
                .ok_or_else(|| invalid("tool.resources"))?;
            let ContributionKind::Resource { schema, .. } = &contribution.contribution else {
                return Err(invalid("tool.resources"));
            };
            resources.push(ToolResourceBinding {
                contribution_id: id.clone(),
                schema: schema.clone(),
            });
        }
        if let Some(id) = &self.skill {
            let contribution = manifest
                .manifest()
                .contributions
                .iter()
                .find(|c| c.id == *id)
                .ok_or_else(|| invalid("tool.skill"))?;
            if !matches!(contribution.contribution, ContributionKind::Skill { .. }) {
                return Err(invalid("tool.skill"));
            }
        }
        let binding = CapabilityToolBinding {
            declaration: self.clone(),
            capability,
            resources,
        };
        binding.validate()?;
        Ok(binding)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ToolResourceBinding {
    pub contribution_id: String,
    pub schema: ContractRef,
}

/// A fixed selection, not an execution grant or a trusted model instruction.
/// Deserialized claims must be rebound against the actual captured package.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapabilityToolBinding {
    pub declaration: CapabilityToolDeclaration,
    pub capability: CapabilityBinding,
    pub resources: Vec<ToolResourceBinding>,
}
impl CapabilityToolBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.declaration.validate()?;
        self.capability.validate()?;
        let capability = &self.capability.declaration;
        if let Some(query) = &self.declaration.query {
            encoded_limit(
                &query.input_template,
                capability.limits.max_input_bytes as usize,
                "tool.query.inputTemplate",
            )?;
            if query.input_schema != capability.input_schema
                || query.output_schema != capability.output_schema
                || query.max_text_bytes > capability.limits.max_input_bytes
            {
                return Err(invalid("tool.query.capability"));
            }
        }
        if self.capability.provider.contribution_id != self.declaration.capability_id
            || capability.effect != EffectKind::ReadOnly
            || capability
                .permissions
                .iter()
                .any(|p| *p != PermissionRequest::CapturedInput)
            || (self.declaration.profile.is_none() && !capability.profiles.is_empty())
            || self
                .declaration
                .profile
                .as_ref()
                .is_some_and(|profile| !capability.profiles.contains(profile))
            || self.resources.len() != self.declaration.supporting_resources.len()
        {
            return Err(invalid("tool.capability"));
        }
        for (resource, id) in self
            .resources
            .iter()
            .zip(&self.declaration.supporting_resources)
        {
            if resource.contribution_id != *id {
                return Err(invalid("tool.resources"));
            }
            reference(&resource.schema, "tool.resources.schema")?;
        }
        Ok(())
    }
}

pub fn parse_tool_declaration(bytes: &[u8]) -> Result<CapabilityToolDeclaration, ContractError> {
    if bytes.len() > MAX_TOOL_DECLARATION_BYTES {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, "tool"));
    }
    let declaration: CapabilityToolDeclaration = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "tool"))?;
    declaration.validate()?;
    Ok(declaration)
}

#[cfg(feature = "schema")]
pub fn tool_declaration_schema() -> schemars::Schema {
    schemars::schema_for!(CapabilityToolDeclaration)
}
#[cfg(feature = "schema")]
pub fn tool_types_schema() -> schemars::Schema {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct ToolTypes {
        declaration: CapabilityToolDeclaration,
        binding: CapabilityToolBinding,
    }
    schemars::schema_for!(ToolTypes)
}
