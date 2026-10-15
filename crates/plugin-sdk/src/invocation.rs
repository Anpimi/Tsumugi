use crate::{
    binding::validate_provider_selection,
    validation::{digest, opaque_id, reference},
    *,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// A claimed wire binding. Only the trusted host can compare it to the actual
/// verified package and channel; constructing this value proves no authority.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProviderBinding {
    pub plugin: PluginIdentity,
    pub component_id: String,
    pub contribution_id: String,
    pub package_digest: String,
    pub instance_id: String,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub activation_generation: u32,
}
impl ProviderBinding {
    /// The fixed package/contribution choice, without a runtime instance or
    /// activation generation. Equality of this projection proves no authority.
    pub fn selection(&self) -> ProviderSelectionBinding {
        ProviderSelectionBinding {
            plugin: self.plugin.clone(),
            component_id: self.component_id.clone(),
            contribution_id: self.contribution_id.clone(),
            package_digest: self.package_digest.clone(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        validate_provider_selection(
            &self.plugin,
            &self.component_id,
            &self.contribution_id,
            &self.package_digest,
        )?;
        opaque_id(&self.instance_id, "binding.instanceId")?;
        if self.activation_generation == 0 {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "binding.activationGeneration",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct InvocationContext {
    pub project_id: String,
    pub operation_id: String,
    pub attempt_id: String,
    pub item_id: String,
    pub dispatch_id: String,
    pub scope_id: String,
    pub input_digest: String,
    pub scope_digest: String,
    pub environment_digest: String,
    pub configuration_digest: String,
}
impl InvocationContext {
    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        for id in [
            &self.project_id,
            &self.operation_id,
            &self.attempt_id,
            &self.item_id,
            &self.dispatch_id,
            &self.scope_id,
        ] {
            opaque_id(id, "context.identity")?;
        }
        for hash in [
            &self.input_digest,
            &self.scope_digest,
            &self.environment_digest,
            &self.configuration_digest,
        ] {
            digest(hash, "context.digest")?;
        }
        Ok(())
    }
}

/// Exact UTF-8 schema payload. The SDK verifies its byte digest but does not
/// substitute a generic parser for that schema's actual semantic validator.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct EncodedPayload {
    pub schema: ContractRef,
    pub utf8: String,
    pub sha256: String,
}
impl EncodedPayload {
    pub fn capture(schema: ContractRef, utf8: String) -> Result<Self, ContractError> {
        let payload = Self {
            schema,
            sha256: payload_digest(&utf8),
            utf8,
        };
        payload.validate()?;
        Ok(payload)
    }
    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        reference(&self.schema, "payload.schema")?;
        digest(&self.sha256, "payload.sha256")?;
        if self.utf8.len() > MAX_INVOCATION_PAYLOAD_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "payload",
            ));
        }
        if payload_digest(&self.utf8) != self.sha256 {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "payload.sha256",
            ));
        }
        Ok(())
    }
}
pub fn payload_digest(utf8: &str) -> String {
    format!("{:x}", Sha256::digest(utf8.as_bytes()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct InvocationRequest {
    pub context: InvocationContext,
    pub provider: ProviderBinding,
    pub capability: ContractRef,
    pub profile: Option<ContractRef>,
    pub input: EncodedPayload,
    pub output_schema: ContractRef,
    pub error_schema: ContractRef,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub max_result_bytes: u32,
}
impl InvocationRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.context.validate()?;
        self.provider.validate()?;
        reference(&self.capability, "request.capability")?;
        if let Some(profile) = &self.profile {
            reference(profile, "request.profile")?;
        }
        self.input.validate()?;
        reference(&self.output_schema, "request.outputSchema")?;
        reference(&self.error_schema, "request.errorSchema")?;
        if self.context.input_digest != self.input.sha256 {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "context.inputDigest",
            ));
        }
        if self.max_result_bytes == 0 || self.max_result_bytes as usize > MAX_PROCESS_FRAME_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "request.maxResultBytes",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum InvocationOutcome {
    Succeeded { output: EncodedPayload },
    Failed { error: EncodedPayload },
    Unknown { error: EncodedPayload },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct InvocationResult {
    pub context: InvocationContext,
    pub provider: ProviderBinding,
    pub capability: ContractRef,
    pub profile: Option<ContractRef>,
    pub result_id: String,
    pub outcome: InvocationOutcome,
}
impl InvocationResult {
    pub(crate) fn validate(&self) -> Result<(), ContractError> {
        self.context.validate()?;
        self.provider.validate()?;
        reference(&self.capability, "result.capability")?;
        if let Some(profile) = &self.profile {
            reference(profile, "result.profile")?;
        }
        opaque_id(&self.result_id, "result.resultId")?;
        match &self.outcome {
            InvocationOutcome::Succeeded { output } => output.validate(),
            InvocationOutcome::Failed { error } | InvocationOutcome::Unknown { error } => {
                error.validate()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ExchangeBody {
    Content(ContentExchange),
    Request(InvocationRequest),
    Result(InvocationResult),
    CheckSet(RequiredCheckSet),
    CheckResults(Vec<CheckResult>),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ExchangeDocument {
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::exchange_protocol_schema")
    )]
    pub protocol_version: u32,
    pub body: ExchangeBody,
}

/// Structural/semantic wire validation only; not an adoption or authorization.
#[derive(Clone, Debug)]
pub struct ValidatedExchange(ExchangeDocument);
impl ValidatedExchange {
    pub fn document(&self) -> &ExchangeDocument {
        &self.0
    }
}
pub fn parse_exchange(bytes: &[u8]) -> Result<ValidatedExchange, ContractError> {
    let received = parse_exchange_with_limit(bytes, MAX_CONTENT_EXCHANGE_BYTES)?;
    if bytes.len() > MAX_EXCHANGE_BYTES
        && !matches!(&received.document().body, ExchangeBody::Content(_))
    {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "exchange",
        ));
    }
    Ok(received)
}
fn parse_exchange_with_limit(
    bytes: &[u8],
    limit: usize,
) -> Result<ValidatedExchange, ContractError> {
    if bytes.len() > limit {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "exchange",
        ));
    }
    // All envelope objects deny unknown/duplicate fields. Opaque domain/schema
    // payloads are strings, so JSON Value cannot silently strip their members.
    let document: ExchangeDocument = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "exchange"))?;
    if document.protocol_version != EXCHANGE_PROTOCOL {
        return Err(ContractError::at(
            ContractErrorCode::UnsupportedProtocol,
            "protocolVersion",
        ));
    }
    match &document.body {
        ExchangeBody::Content(content) => content.validate()?,
        ExchangeBody::Request(request) => request.validate()?,
        ExchangeBody::Result(result) => result.validate()?,
        ExchangeBody::CheckSet(set) => set.validate()?,
        ExchangeBody::CheckResults(results) => validate_check_results(results)?,
    }
    Ok(ValidatedExchange(document))
}

/// The caller must supply the captured request and an independently verified
/// actual channel binding. A matching payload identity alone is insufficient.
/// Success here still needs payload-schema/domain validation and Core adoption.
pub fn receive_invocation_result(
    bytes: &[u8],
    request: &InvocationRequest,
    actual_channel: &ProviderBinding,
) -> Result<ValidatedExchange, ContractError> {
    request.validate()?;
    actual_channel.validate()?;
    let received = parse_exchange_with_limit(bytes, request.max_result_bytes as usize)?;
    let ExchangeBody::Result(result) = &received.0.body else {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "result.kind",
        ));
    };
    if result.context != request.context
        || result.provider != request.provider
        || result.provider != *actual_channel
        || result.capability != request.capability
        || result.profile != request.profile
    {
        return Err(ContractError::at(
            ContractErrorCode::ResultMismatch,
            "result.binding",
        ));
    }
    let matches_schema = match &result.outcome {
        InvocationOutcome::Succeeded { output } => output.schema == request.output_schema,
        InvocationOutcome::Failed { error } | InvocationOutcome::Unknown { error } => {
            error.schema == request.error_schema
        }
    };
    if !matches_schema {
        return Err(ContractError::at(
            ContractErrorCode::IncompatibleContract,
            "result.payload.schema",
        ));
    }
    Ok(received)
}
