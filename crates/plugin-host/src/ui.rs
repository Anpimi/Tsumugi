//! Bounded host-rendered UI bindings. Package data selects an existing renderer;
//! inspecting it neither activates JavaScript nor grants capability execution.
use crate::{HostError, HostResult, PackageImage};
use tsumugi_plugin_sdk::{CapabilityToolBinding, ContributionKind, tool_declaration_contract};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceQueryUi {
    pub component_id: String,
    pub ui_id: String,
    pub slot: String,
    pub resource_id: String,
    pub binding: CapabilityToolBinding,
}

impl PackageImage {
    /// Select only the supported UI slot and the unique exact-schema Resource
    /// owned by the same component in this immutable package. Names or manifest
    /// order never choose between competing declarations.
    pub fn reference_query_ui(&self, ui_id: &str) -> HostResult<ReferenceQueryUi> {
        let manifest = self.manifest().manifest();
        let ui = manifest
            .contributions
            .iter()
            .find(|value| value.id == ui_id)
            .ok_or(HostError::InvalidContract)?;
        let ContributionKind::Ui { slot, schema } = &ui.contribution else {
            return Err(HostError::InvalidContract);
        };
        if slot != "reference-query" || *schema != tool_declaration_contract() {
            return Err(HostError::InvalidContract);
        }
        let duplicates = manifest.contributions.iter().filter(|value| {
            value.component_id == ui.component_id
                && matches!(&value.contribution, ContributionKind::Ui { slot: candidate_slot, schema: candidate_schema }
                    if candidate_slot == slot && candidate_schema == schema)
        }).count();
        if duplicates != 1 {
            return Err(HostError::InvalidContract);
        }
        let mut resources = manifest.contributions.iter().filter(|value| {
            value.component_id == ui.component_id
                && matches!(&value.contribution, ContributionKind::Resource { schema: candidate, .. } if candidate == schema)
        });
        let resource = resources.next().ok_or(HostError::InvalidContract)?;
        if resources.next().is_some() {
            return Err(HostError::InvalidContract);
        }
        let binding = self.capability_tool(&resource.id)?;
        if binding.capability.provider.component_id != ui.component_id
            || binding.declaration.query.is_none()
        {
            return Err(HostError::InvalidContract);
        }
        Ok(ReferenceQueryUi {
            component_id: ui.component_id.clone(),
            ui_id: ui.id.clone(),
            slot: slot.clone(),
            resource_id: resource.id.clone(),
            binding,
        })
    }
}
