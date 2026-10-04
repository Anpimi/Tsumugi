//! Fixed plugin selection and channel evidence. These data values do not grant
//! execution or adoption authority; the project session owns that authority.
use super::*;
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginExecutionBinding {
    pub capability: sdk::CapabilityBinding,
    pub profile: Option<sdk::ContractRef>,
    /// Exact runtime/tool/resource environment captured by the trusted installer.
    /// A digest supplied by a plugin is not source authentication.
    pub environment_digest: String,
}
impl PluginExecutionBinding {
    pub fn capability_version(&self) -> String {
        let contract = &self.capability.declaration.contract;
        format!("{}:{}", contract.schema_version, contract.behavior_version)
    }
    pub fn validate(&self) -> Result<(), ExecutionError> {
        self.capability.validate().map_err(contract_error)?;
        if !valid_digest(&self.environment_digest)
            || (self.profile.is_none() && !self.capability.declaration.profiles.is_empty())
            || self
                .profile
                .as_ref()
                .is_some_and(|profile| !self.capability.declaration.profiles.contains(profile))
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "plugin-binding",
            ));
        }
        Ok(())
    }
}

/// The complete received SDK result retains exact payload bytes and identity.
/// `channel` is supplied independently by the trusted Host, not read from output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginResultEvidence {
    pub authorization_id: ExecutionId,
    pub channel: sdk::ProviderBinding,
    pub result: sdk::InvocationResult,
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn contract_error(_: sdk::ContractError) -> ExecutionError {
    ExecutionError::new(ErrorCode::ResultMismatch, "plugin-contract")
}
pub(crate) fn provider_key(
    selection: &sdk::ProviderSelectionBinding,
) -> Result<String, ExecutionError> {
    selection.validate().map_err(contract_error)?;
    Ok(codec::digest(&codec::encode(selection, MAX_INPUT_BYTES)?))
}

impl FixedInput {
    /// Build one bounded request from the selected item, not the whole project
    /// or multi-item input. The actual channel must match the captured selection.
    pub fn plugin_request(
        &self,
        item_id: ExecutionId,
        dispatch_token: ExecutionId,
        channel: &sdk::ProviderBinding,
    ) -> Result<sdk::InvocationRequest, ExecutionError> {
        let envelope = self.envelope();
        let binding = envelope
            .plugin
            .as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "plugin-binding"))?;
        if channel.selection() != binding.capability.provider {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "plugin-provider",
            ));
        }
        let declaration = &binding.capability.declaration;
        let item = self.item(item_id)?;
        let bytes = codec::encode(&item.payload, declaration.limits.max_input_bytes as usize)?;
        let input = sdk::EncodedPayload::capture(
            declaration.input_schema.clone(),
            String::from_utf8(bytes)
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "plugin-input"))?,
        )
        .map_err(contract_error)?;
        // Core stores the original SDK payload plus a checked JSON projection.
        // Leave room for metadata and worst-case JSON escaping in both copies.
        let max_result_bytes = envelope.limits.max_result_bytes.saturating_sub(16 * 1024) / 8;
        if max_result_bytes == 0 {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "plugin-result-budget",
            ));
        }
        let request = sdk::InvocationRequest {
            context: sdk::InvocationContext {
                project_id: envelope.project_id.to_string(),
                scope_id: envelope.project_id.to_string(),
                operation_id: envelope.task_id.to_string(),
                attempt_id: envelope.attempt_id.to_string(),
                item_id: item_id.to_string(),
                dispatch_id: dispatch_token.to_string(),
                input_digest: input.sha256.clone(),
                scope_digest: codec::digest(&codec::encode(
                    &(&item.scope, &item.dependencies),
                    MAX_INPUT_BYTES,
                )?),
                environment_digest: binding.environment_digest.clone(),
                configuration_digest: codec::digest(&codec::encode(
                    &envelope.settings,
                    MAX_INPUT_BYTES,
                )?),
            },
            provider: channel.clone(),
            capability: declaration.contract.clone(),
            profile: binding.profile.clone(),
            input,
            output_schema: declaration.output_schema.clone(),
            error_schema: declaration.error_schema.clone(),
            max_result_bytes: max_result_bytes.min(declaration.limits.max_output_bytes),
        };
        request.validate().map_err(contract_error)?;
        Ok(request)
    }
}
impl PluginResultEvidence {
    pub(crate) fn validate(
        &self,
        envelope: &ResultEnvelope,
        input: &FixedInput,
        token: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let request = input.plugin_request(envelope.item_id, token, &self.channel)?;
        let document = sdk::ExchangeDocument {
            protocol_version: sdk::EXCHANGE_PROTOCOL,
            body: sdk::ExchangeBody::Result(self.result.clone()),
        };
        let bytes = codec::encode(&document, sdk::MAX_EXCHANGE_BYTES)?;
        sdk::receive_invocation_result(&bytes, &request, &self.channel).map_err(contract_error)?;
        match &self.result.outcome {
            sdk::InvocationOutcome::Succeeded { output } => {
                let projected: Value =
                    codec::decode(output.utf8.as_bytes(), request.max_result_bytes as usize)?;
                if envelope.outcome != ExecutionState::Succeeded
                    || envelope.output.as_ref() != Some(&projected)
                {
                    return Err(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "plugin-output",
                    ));
                }
            }
            sdk::InvocationOutcome::Failed { .. } if envelope.outcome == ExecutionState::Failed => {
            }
            sdk::InvocationOutcome::Unknown { .. }
                if envelope.outcome == ExecutionState::Unknown => {}
            _ => {
                return Err(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "plugin-outcome",
                ));
            }
        }
        if envelope.diagnostic.as_ref().is_some_and(|d| d.retry_safe) {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "plugin-retry",
            ));
        }
        Ok(())
    }
}
impl FixedResult {
    /// Called by a trusted adapter after actual-channel validation. This keeps
    /// opaque errors and the raw JSON proposal alongside its strict projection.
    pub fn capture_plugin(
        input: &FixedInput,
        item: ExecutionId,
        token: ExecutionId,
        evidence: PluginResultEvidence,
    ) -> Result<Self, ExecutionError> {
        let (outcome, output, diagnostic) = match &evidence.result.outcome {
            sdk::InvocationOutcome::Succeeded { output } => (
                ExecutionState::Succeeded,
                Some(codec::decode(
                    output.utf8.as_bytes(),
                    input.envelope().limits.max_result_bytes as usize,
                )?),
                None,
            ),
            sdk::InvocationOutcome::Failed { .. } => (
                ExecutionState::Failed,
                None,
                Some(Diagnostic {
                    code: "plugin-failed".into(),
                    retry_safe: false,
                }),
            ),
            sdk::InvocationOutcome::Unknown { .. } => (
                ExecutionState::Unknown,
                None,
                Some(Diagnostic {
                    code: "plugin-unknown".into(),
                    retry_safe: false,
                }),
            ),
        };
        Self::capture(
            ResultEnvelope {
                project_id: input.envelope().project_id,
                attempt_id: input.envelope().attempt_id,
                item_id: item,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: token,
                capability_id: input.envelope().capability_id.clone(),
                capability_version: input.envelope().capability_version.clone(),
                plugin: Some(evidence),
                outcome,
                output,
                diagnostic,
            },
            input,
            token,
        )
    }
}
