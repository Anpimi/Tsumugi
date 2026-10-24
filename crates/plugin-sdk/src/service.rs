use crate::{
    validation::{digest, limits, name, opaque_id, reference},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Bounded metadata and total service calls on one serialized process channel.
pub const MAX_SERVICE_BINDINGS: usize = 16;
pub const MAX_SERVICE_CALLS: usize = 128;

/// A Host-selected service descriptor, not a grant or a project/store handle.
/// The Host authenticates its provider, scope, configuration and live generation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ServiceBinding {
    pub handle_id: String,
    pub provider_id: String,
    pub contract: ContractRef,
    pub input_schema: ContractRef,
    pub output_schema: ContractRef,
    pub error_schema: ContractRef,
    pub effect: EffectKind,
    pub project_id: String,
    pub scope_id: String,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub activation_generation: u32,
    pub configuration_digest: String,
    pub limits: CapabilityLimits,
}
impl ServiceBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        opaque_id(&self.handle_id, "service.handleId")?;
        name(&self.provider_id, "service.providerId")?;
        for (value, field) in [
            (&self.contract, "service.contract"),
            (&self.input_schema, "service.inputSchema"),
            (&self.output_schema, "service.outputSchema"),
            (&self.error_schema, "service.errorSchema"),
        ] {
            reference(value, field)?;
        }
        opaque_id(&self.project_id, "service.projectId")?;
        opaque_id(&self.scope_id, "service.scopeId")?;
        digest(&self.configuration_digest, "service.configurationDigest")?;
        if self.activation_generation == 0 {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "service.activationGeneration",
            ));
        }
        limits(&self.limits, "service.limits")?;
        if self.limits.concurrency != 1
            || self.limits.max_input_bytes as usize > MAX_INVOCATION_PAYLOAD_BYTES
            || self.limits.max_output_bytes as usize > MAX_INVOCATION_PAYLOAD_BYTES
        {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "service.limits",
            ));
        }
        Ok(())
    }
}

/// Validate syntax and unique selections only. Dependency/effect/permission
/// resolution and current authority are the actual Host's responsibility.
pub fn validate_service_bindings(bindings: &[ServiceBinding]) -> Result<(), ContractError> {
    if bindings.len() > MAX_SERVICE_BINDINGS {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "activation.services",
        ));
    }
    let mut handles = BTreeSet::new();
    let mut providers = BTreeSet::new();
    for binding in bindings {
        binding.validate()?;
        if !handles.insert(&binding.handle_id)
            || !providers.insert((&binding.provider_id, &binding.contract))
        {
            return Err(ContractError::at(
                ContractErrorCode::DuplicateIdentity,
                "activation.services",
            ));
        }
    }
    Ok(())
}

/// The context is the original outer invocation. Its inputDigest describes that
/// invocation, while input.sha256 independently authenticates the service bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ServiceRequest {
    pub call_id: String,
    pub handle_id: String,
    pub context: InvocationContext,
    pub input: EncodedPayload,
}
impl ServiceRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        opaque_id(&self.call_id, "service.callId")?;
        opaque_id(&self.handle_id, "service.handleId")?;
        self.context.validate()?;
        self.input.validate()
    }
    pub fn validate_against(
        &self,
        binding: &ServiceBinding,
        original_context: &InvocationContext,
    ) -> Result<(), ContractError> {
        self.validate()?;
        binding.validate()?;
        original_context.validate()?;
        if self.handle_id != binding.handle_id
            || self.context != *original_context
            || self.context.project_id != binding.project_id
            || self.context.scope_id != binding.scope_id
            || self.input.schema != binding.input_schema
        {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "service.request",
            ));
        }
        if self.input.utf8.len() > binding.limits.max_input_bytes as usize {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "service.input",
            ));
        }
        Ok(())
    }
}

/// A response preserves failed/unknown outcomes. Matching it does not authorize
/// a mutation, validate its domain payload or prove that a child task finished.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ServiceResponse {
    pub call_id: String,
    pub handle_id: String,
    pub context: InvocationContext,
    pub outcome: InvocationOutcome,
}
impl ServiceResponse {
    pub fn validate(&self) -> Result<(), ContractError> {
        opaque_id(&self.call_id, "service.callId")?;
        opaque_id(&self.handle_id, "service.handleId")?;
        self.context.validate()?;
        match &self.outcome {
            InvocationOutcome::Succeeded { output } => output.validate(),
            InvocationOutcome::Failed { error } | InvocationOutcome::Unknown { error } => {
                error.validate()
            }
        }
    }
    pub fn validate_against(
        &self,
        request: &ServiceRequest,
        binding: &ServiceBinding,
    ) -> Result<(), ContractError> {
        self.validate()?;
        request.validate_against(binding, &request.context)?;
        if self.call_id != request.call_id
            || self.handle_id != request.handle_id
            || self.context != request.context
        {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "service.response",
            ));
        }
        let (payload, schema) = match &self.outcome {
            InvocationOutcome::Succeeded { output } => (output, &binding.output_schema),
            InvocationOutcome::Failed { error } | InvocationOutcome::Unknown { error } => {
                (error, &binding.error_schema)
            }
        };
        if payload.schema != *schema {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "service.response.schema",
            ));
        }
        if payload.utf8.len() > binding.limits.max_output_bytes as usize {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "service.output",
            ));
        }
        Ok(())
    }
}
