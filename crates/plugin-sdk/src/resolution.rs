use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::*;

/// A declaration selector, not a verified artifact, runtime principal or grant.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProviderKey {
    pub plugin: PluginIdentity,
    pub contribution_id: String,
}

#[derive(Debug)]
pub struct DeclaredProvider<'a> {
    pub key: ProviderKey,
    pub owner: &'a ComponentDeclaration,
    pub capability: &'a CapabilityDeclaration,
}

/// Inspect exact-compatible declarations without starting code or selecting a
/// runtime instance. Multiple single providers require an explicit choice.
/// Collection retains independent identities in canonical order, never precedence.
pub fn resolve_declarations<'a>(
    manifests: &'a [ValidatedManifest],
    contract: &ContractRef,
    profile: Option<&ContractRef>,
    mode: ProviderSelection,
    chosen: &[ProviderKey],
) -> Result<Vec<DeclaredProvider<'a>>, ContractError> {
    if manifests.len() > 128 || chosen.len() > 128 {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "catalog",
        ));
    }
    let mut packages = BTreeSet::new();
    let mut candidates = Vec::new();
    for manifest in manifests {
        if !packages.insert(&manifest.manifest().plugin) {
            return Err(ContractError::at(
                ContractErrorCode::DuplicateIdentity,
                "catalog.plugin",
            ));
        }
        for contribution in &manifest.manifest().contributions {
            let capability = match manifest.capability(&contribution.id, contract, profile) {
                Ok(capability) => capability,
                Err(error) if error.code == ContractErrorCode::IncompatibleContract => continue,
                Err(error) => return Err(error),
            };
            let owner = manifest
                .manifest()
                .components
                .iter()
                .find(|c| c.id == contribution.component_id)
                .expect("validated contribution owner");
            candidates.push(DeclaredProvider {
                key: ProviderKey {
                    plugin: manifest.manifest().plugin.clone(),
                    contribution_id: contribution.id.clone(),
                },
                owner,
                capability,
            });
        }
    }
    let mut selected = BTreeSet::new();
    for key in chosen {
        if !selected.insert(key) {
            return Err(ContractError::at(
                ContractErrorCode::DuplicateIdentity,
                "chosen",
            ));
        }
        if !candidates.iter().any(|candidate| candidate.key == *key) {
            return Err(ContractError::at(
                ContractErrorCode::IncompatibleContract,
                "chosen",
            ));
        }
    }
    if !chosen.is_empty() {
        candidates.retain(|c| selected.contains(&c.key));
    }
    if candidates.is_empty() {
        return Err(ContractError::at(
            ContractErrorCode::IncompatibleContract,
            "contract",
        ));
    }
    if mode == ProviderSelection::Single && candidates.len() != 1 {
        return Err(ContractError::at(
            ContractErrorCode::AmbiguousProvider,
            "chosen",
        ));
    }
    candidates.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(candidates)
}
