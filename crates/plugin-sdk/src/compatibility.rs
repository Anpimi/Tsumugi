//! Exact declaration compatibility diagnostics. These do not establish runtime
//! availability, input/output/error compatibility or permission to call code.
use crate::{
    validation::{encoded_limit, name, reference},
    *,
};
use serde::{Deserialize, Serialize};

pub const MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES: usize = 4096;

/// An independently supplied capability contract and optional exact profile.
/// Package SemVer and matching JSON shapes do not imply behavioral compatibility.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityCompatibilityRequest {
    pub contribution_id: String,
    pub contract: ContractRef,
    pub profile: Option<ContractRef>,
}
impl CapabilityCompatibilityRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        name(&self.contribution_id, "compatibility.contributionId")?;
        reference(&self.contract, "compatibility.contract")?;
        if let Some(profile) = &self.profile {
            reference(profile, "compatibility.profile")?;
        }
        encoded_limit(
            self,
            MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES,
            "compatibility.request",
        )
    }
}

/// Parse bounded, strict typed JSON, including duplicate-field and UTF-8 checks.
pub fn parse_capability_compatibility_request(
    bytes: &[u8],
) -> Result<CapabilityCompatibilityRequest, ContractError> {
    if bytes.len() > MAX_CAPABILITY_COMPATIBILITY_REQUEST_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "compatibility.request",
        ));
    }
    let request: CapabilityCompatibilityRequest = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(ContractErrorCode::InvalidSchema, "compatibility.request")
    })?;
    request.validate()?;
    Ok(request)
}

/// The first mismatch in contribution, contract ID/schema/behavior, then profile
/// order. Unsupported profiles are reported as complete exact identities; no
/// nearest version or implicit profile is selected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityCompatibilityStatus {
    Compatible,
    ContributionMissing,
    NotCallable,
    ContractIdMismatch,
    ContractSchemaMismatch,
    ContractBehaviorMismatch,
    ProfileRequired,
    ProfileUnsupported,
}

/// Bounded declaration metadata only, without package authentication, active
/// instances, runtime or process compatibility, or semantic execution evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityCompatibilityReport {
    pub request: CapabilityCompatibilityRequest,
    pub status: CapabilityCompatibilityStatus,
    pub component_id: Option<String>,
    pub declared_contract: Option<ContractRef>,
    pub declared_profiles: Vec<ContractRef>,
}
impl CapabilityCompatibilityReport {
    pub const fn is_compatible(&self) -> bool {
        matches!(self.status, CapabilityCompatibilityStatus::Compatible)
    }
}

impl ValidatedManifest {
    /// Diagnose only a capability contract/profile selection against this
    /// immutable declaration. Manually constructed requests are validated too.
    pub fn diagnose_capability(
        &self,
        request: &CapabilityCompatibilityRequest,
    ) -> Result<CapabilityCompatibilityReport, ContractError> {
        request.validate()?;
        let assessment = assess_capability(
            self.manifest(),
            &request.contribution_id,
            &request.contract,
            request.profile.as_ref(),
        );
        Ok(CapabilityCompatibilityReport {
            request: request.clone(),
            status: assessment.status,
            component_id: assessment.component_id.map(str::to_owned),
            declared_contract: assessment.declaration.map(|value| value.contract.clone()),
            declared_profiles: assessment
                .declaration
                .map(|value| value.profiles.clone())
                .unwrap_or_default(),
        })
    }
}

struct CapabilityAssessment<'a> {
    status: CapabilityCompatibilityStatus,
    component_id: Option<&'a str>,
    declaration: Option<&'a CapabilityDeclaration>,
}

/// Shared by the existing declaration resolver and the diagnostic API. Keep the
/// legacy error fields even when diagnostics distinguish a more precise reason.
pub(crate) fn resolve_capability_declaration<'a>(
    manifest: &'a PluginManifest,
    contribution_id: &str,
    contract: &ContractRef,
    profile: Option<&ContractRef>,
) -> Result<&'a CapabilityDeclaration, ContractError> {
    let assessment = assess_capability(manifest, contribution_id, contract, profile);
    let field = match assessment.status {
        CapabilityCompatibilityStatus::Compatible => {
            return Ok(assessment.declaration.expect("compatible capability"));
        }
        CapabilityCompatibilityStatus::ContributionMissing => "contributions.id",
        CapabilityCompatibilityStatus::NotCallable => "contributions.kind",
        CapabilityCompatibilityStatus::ProfileRequired => "contributions.profiles",
        CapabilityCompatibilityStatus::ContractIdMismatch
        | CapabilityCompatibilityStatus::ContractSchemaMismatch
        | CapabilityCompatibilityStatus::ContractBehaviorMismatch
        | CapabilityCompatibilityStatus::ProfileUnsupported => "contributions.contract",
    };
    Err(ContractError::at(
        ContractErrorCode::IncompatibleContract,
        field,
    ))
}

fn assess_capability<'a>(
    manifest: &'a PluginManifest,
    contribution_id: &str,
    contract: &ContractRef,
    profile: Option<&ContractRef>,
) -> CapabilityAssessment<'a> {
    use CapabilityCompatibilityStatus::*;
    let Some(contribution) = manifest
        .contributions
        .iter()
        .find(|value| value.id == contribution_id)
    else {
        return CapabilityAssessment {
            status: ContributionMissing,
            component_id: None,
            declaration: None,
        };
    };
    let ContributionKind::Capability { declaration } = &contribution.contribution else {
        return CapabilityAssessment {
            status: NotCallable,
            component_id: Some(&contribution.component_id),
            declaration: None,
        };
    };
    let status = if declaration.contract.id != contract.id {
        ContractIdMismatch
    } else if declaration.contract.schema_version != contract.schema_version {
        ContractSchemaMismatch
    } else if declaration.contract.behavior_version != contract.behavior_version {
        ContractBehaviorMismatch
    } else if profile.is_some_and(|value| !declaration.profiles.contains(value)) {
        ProfileUnsupported
    } else if profile.is_none() && !declaration.profiles.is_empty() {
        ProfileRequired
    } else {
        Compatible
    };
    CapabilityAssessment {
        status,
        component_id: Some(&contribution.component_id),
        declaration: Some(declaration),
    }
}
