//! Fixed plugin selection and channel evidence. These data values do not grant
//! execution or adoption authority; the project session owns that authority.
use super::*;
use tsumugi_plugin_sdk as sdk;

/// Identity allocated by the application instance owner before consent. This
/// persisted fact never recreates the owner's session-local execution lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ApplicationScopeBasis {
    pub instance_id: ExecutionId,
    pub activation_generation: u32,
}

pub fn required_application_scope<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ApplicationScopeBasis>, D::Error> {
    Option::deserialize(deserializer)
}

#[cfg(feature = "wire-schema")]
pub fn application_scope_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<ApplicationScopeBasis> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginExecutionBinding {
    pub capability: sdk::CapabilityBinding,
    /// Captured from the selected component, never inferred from a result.
    pub component_scope: sdk::ComponentScope,
    #[serde(deserialize_with = "required_application_scope")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "application_scope_schema")
    )]
    pub application_scope: Option<ApplicationScopeBasis>,
    pub profile: Option<sdk::ContractRef>,
    /// Exact captured Node artifacts or actual native application Host identity.
    /// This data value does not authenticate its source or grant execution.
    pub environment: sdk::ExecutionEnvironmentDescriptor,
}
impl PluginExecutionBinding {
    /// Derive transport scope from this captured declaration and Core identities.
    /// A result, service frame or caller-supplied scope cannot select its meaning.
    pub fn scope_id(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
    ) -> Result<String, ExecutionError> {
        match self.component_scope {
            sdk::ComponentScope::Project => Ok(project.to_string()),
            sdk::ComponentScope::Attempt => Ok(attempt.to_string()),
            sdk::ComponentScope::Application => self
                .application_scope
                .as_ref()
                .filter(|basis| basis.activation_generation > 0)
                .map(|basis| basis.instance_id.to_string())
                .ok_or_else(|| {
                    ExecutionError::new(ErrorCode::InvalidInput, "plugin-component-scope")
                }),
        }
    }

    /// Composition owners without an application-lifetime consent path must
    /// retain their explicit supported boundary even though generic Tool calls
    /// can now capture an independently authorized application instance.
    pub fn validate_project_or_attempt(&self) -> Result<(), ExecutionError> {
        self.validate()?;
        if self.component_scope == sdk::ComponentScope::Application {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "plugin-composition-scope",
            ));
        }
        Ok(())
    }

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
        if match (&self.component_scope, &self.application_scope) {
            (sdk::ComponentScope::Application, Some(basis)) => basis.activation_generation == 0,
            (sdk::ComponentScope::Application, None) => true,
            (_, Some(_)) => true,
            (_, None) => false,
        } {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "plugin-component-scope",
            ));
        }
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
    environment: &sdk::ExecutionEnvironmentDescriptor,
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
        if binding.application_scope.as_ref().is_some_and(|basis| {
            channel.instance_id != basis.instance_id.to_string()
                || channel.activation_generation != basis.activation_generation
        }) {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "plugin-application-instance",
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
        ) || (declaration.input_schema
            == sdk::generation_service_input_contract()
            && declaration.output_schema == sdk::generation_service_receipt_contract()
            && declaration.error_schema == sdk::generation_service_error_contract());
        // These contracts return strict JSON with bounded integer/string fields.
        // Quoting its original JSON costs at most twice the raw bytes; the
        // checked canonical projection is no larger. Reserve metadata separately.
        // Other contracts keep their conservative opaque-payload budget.
        let max_result_bytes = if envelope.operation == crate::content::OPERATION {
            // Source content retains one original SDK result plus a small
            // schema/digest projection. Bound the quoted result frame and
            // reserve the remaining ledger envelope metadata separately.
            let raw = declaration
                .limits
                .max_output_bytes
                .min(sdk::MAX_CONTENT_EXCHANGE_BYTES as u32);
            raw.saturating_mul(2)
                .saturating_add(32 * 1024)
                .min(envelope.limits.max_result_bytes.saturating_sub(64 * 1024))
        } else if envelope.operation == crate::content::TRANSLATION_EXTRACTION_OPERATION {
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
                scope_id: binding.scope_id(envelope.project_id, envelope.attempt_id)?,
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
        let payload = match &self.result.outcome {
            sdk::InvocationOutcome::Succeeded { output } => output,
            sdk::InvocationOutcome::Failed { error }
            | sdk::InvocationOutcome::Unknown { error } => error,
        };
        let binding = input
            .envelope()
            .plugin
            .as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "plugin-binding"))?;
        // Frame metadata and JSON quoting have their own allowance. The exact
        // captured raw payload limit still applies to success and both errors.
        if payload.utf8.len() > binding.capability.declaration.limits.max_output_bytes as usize {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "plugin-output-budget",
            ));
        }
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
    // source/translation contract from those same immutable bytes.
    let parsed: Value = codec::decode(
        output.utf8.as_bytes(),
        input.envelope().limits.max_result_bytes as usize,
    )?;
    if matches!(
        input.envelope().operation.as_str(),
        crate::content::OPERATION | crate::content::TRANSLATION_EXTRACTION_OPERATION
    ) {
        serde_json::to_value((&output.schema, &output.sha256))
            .map_err(|_| ExecutionError::new(ErrorCode::OutputInvalid, "plugin-output"))
    } else {
        Ok(parsed)
    }
}
