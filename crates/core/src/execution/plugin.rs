//! Fixed plugin selection and channel evidence. These data values do not grant
//! execution or adoption authority; the project session owns that authority.
use super::*;
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginExecutionBinding {
    pub capability: sdk::CapabilityBinding,
    pub profile: Option<sdk::ContractRef>,
    /// Exact tool and Host artifacts captured and approved by the trusted installer.
    /// This data value does not authenticate its source or grant execution.
    pub environment: sdk::RuntimeEnvironmentDescriptor,
}
impl PluginExecutionBinding {
    pub fn capability_version(&self) -> String {
        let contract = &self.capability.declaration.contract;
        format!("{}:{}", contract.schema_version, contract.behavior_version)
    }
    pub fn environment_digest(&self) -> Result<String, ExecutionError> {
        environment_key(&self.environment)
    }
    pub fn validate(&self) -> Result<(), ExecutionError> {
        self.capability.validate().map_err(contract_error)?;
        self.environment.validate().map_err(environment_error)?;
        if (self.profile.is_none() && !self.capability.declaration.profiles.is_empty())
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

fn contract_error(_: sdk::ContractError) -> ExecutionError {
    ExecutionError::new(ErrorCode::ResultMismatch, "plugin-contract")
}
fn environment_error(_: sdk::ContractError) -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, "plugin-environment")
}
pub(crate) fn environment_key(
    environment: &sdk::RuntimeEnvironmentDescriptor,
) -> Result<String, ExecutionError> {
    environment.digest().map_err(environment_error)
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
        let payload = if envelope.operation == TRANSLATION_CHECK_OPERATION {
            translation_validation::expand_translation_check_payload(&item.payload)?
        } else {
            item.payload.clone()
        };
        let bytes = codec::encode(&payload, declaration.limits.max_input_bytes as usize)?;
        let input = sdk::EncodedPayload::capture(
            declaration.input_schema.clone(),
            String::from_utf8(bytes)
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "plugin-input"))?,
        )
        .map_err(contract_error)?;
        let bounded_json_contract = matches!(
            envelope.operation.as_str(),
            crate::content::OPERATION
                | SOURCE_CHECK_OPERATION
                | crate::content::BUILD_OPERATION
                | ARTIFACT_CHECK_OPERATION
                | crate::content::TRANSLATION_EXTRACTION_OPERATION
                | TRANSLATION_CHECK_OPERATION
                | REVIEW_CHECK_OPERATION
        );
        // Content/check/build output is strict JSON with bounded integer/string fields.
        // Quoting its original JSON costs at most twice the raw bytes; the
        // checked canonical projection is no larger. Reserve metadata separately.
        // Other contracts keep their conservative opaque-payload budget.
        let max_result_bytes =
            if envelope.operation == crate::content::TRANSLATION_EXTRACTION_OPERATION {
                // This operation stores the complete channel result once, with a
                // small digest reference rather than a duplicate parsed proposal.
                // The SDK receiver bounds the entire encoded response, including
                // quoting; Core metadata has its own reserved space.
                envelope
                    .limits
                    .max_result_bytes
                    .saturating_sub(64 * 1024)
                    .min(declaration.limits.max_output_bytes)
                    .min(sdk::MAX_EXCHANGE_BYTES as u32)
            } else if bounded_json_contract {
                let raw = envelope.limits.max_result_bytes.saturating_sub(64 * 1024) / 3;
                let raw = raw
                    .min(declaration.limits.max_output_bytes)
                    .min(sdk::MAX_EXCHANGE_BYTES as u32);
                if raw == 0 { 0 } else { raw * 2 + 32 * 1024 }
            } else {
                (envelope.limits.max_result_bytes.saturating_sub(16 * 1024) / 8)
                    .min(declaration.limits.max_output_bytes)
            };
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
                environment_digest: binding.environment_digest()?,
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
            max_result_bytes,
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
        let bytes = codec::encode(&document, sdk::MAX_PROCESS_FRAME_BYTES)?;
        sdk::receive_invocation_result(&bytes, &request, &self.channel).map_err(contract_error)?;
        match &self.result.outcome {
            sdk::InvocationOutcome::Succeeded { output } => {
                let projected = ledger_output(input, output)?;
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
                Some(ledger_output(input, output)?),
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

fn ledger_output(
    input: &FixedInput,
    output: &sdk::EncodedPayload,
) -> Result<Value, ExecutionError> {
    // Decode strict JSON before accepting the original bytes even when the
    // ledger projects only their schema/hash. Qualification parses the SDK
    // translation contract from those same immutable bytes.
    let parsed: Value = codec::decode(
        output.utf8.as_bytes(),
        input.envelope().limits.max_result_bytes as usize,
    )?;
    if input.envelope().operation == crate::content::TRANSLATION_EXTRACTION_OPERATION {
        serde_json::to_value((&output.schema, &output.sha256))
            .map_err(|_| ExecutionError::new(ErrorCode::OutputInvalid, "plugin-output"))
    } else {
        Ok(parsed)
    }
}
