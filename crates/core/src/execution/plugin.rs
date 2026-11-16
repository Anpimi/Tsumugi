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
        let binding = self.plugin_binding_for_channel(channel)?;
        let input = if validation::is_derived_check(&self.envelope().operation) {
            self.item(item_id)?;
            self.check_wire.clone().ok_or_else(|| {
                ExecutionError::new(ErrorCode::InvalidInput, "semantic-check-dispatch-material")
            })?
        } else {
            let bytes = self.plugin_payload_bytes(item_id)?;
            sdk::EncodedPayload::capture(
                binding.capability.declaration.input_schema.clone(),
                String::from_utf8(bytes)
                    .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "plugin-input"))?,
            ).map_err(contract_error)?
        };
        let request = sdk::InvocationRequest {
            context: self.plugin_context(item_id, dispatch_token, binding, input.sha256.clone())?,
            provider: channel.clone(),
            capability: binding.capability.declaration.contract.clone(),
            profile: binding.profile.clone(),
            input,
            output_schema: binding.capability.declaration.output_schema.clone(),
            error_schema: binding.capability.declaration.error_schema.clone(),
            max_result_bytes: self.plugin_result_budget(binding)?,
        };
        request.validate().map_err(contract_error)?;
        self.plugin_payload_digests.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(item_id, request.input.sha256.clone());
        Ok(request)
    }

    fn plugin_binding_for_channel(&self, channel: &sdk::ProviderBinding) -> Result<&PluginExecutionBinding, ExecutionError> {
        let binding = self.envelope()
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
        Ok(binding)
    }

    fn plugin_payload<T>(
        &self,
        item_id: ExecutionId,
        encode: impl FnOnce(&dyn erased_payload::Payload, usize) -> Result<T, ExecutionError>,
    ) -> Result<T, ExecutionError> {
        let envelope = self.envelope();
        let binding = envelope.plugin.as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "plugin-binding"))?;
        let item = self.item(item_id)?;
        let limit = binding.capability.declaration.limits.max_input_bytes as usize;
        if envelope.operation == TRANSLATION_CHECK_OPERATION {
            let payload = translation_validation::expand_translation_check_payload(&item.payload)?;
            encode(&payload, limit)
        } else if envelope.operation == crate::content::BUILD_OPERATION
            && crate::ReleasePlan::is_projected_payload(&item.payload)
        {
            let locale = item.scope.locale.as_deref()
                .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "release-plan"))?;
            let restored;
            let plan = if let Some(plan) = self.open_build_plan() {
                plan.as_ref()
            } else {
                restored = crate::ReleasePlan::from_input(self)?;
                &restored
            };
            let payload = erased_payload::BuildPayload {
                binding: plan.build_environment().binding(),
                input: plan.project_plugin_input(locale)?,
            };
            encode(&payload, limit)
        } else {
            encode(&item.payload, limit)
        }
    }

    fn plugin_payload_bytes(&self, item_id: ExecutionId) -> Result<Vec<u8>, ExecutionError> {
        self.plugin_payload(item_id, |payload, limit| payload.encode(limit))
    }

    fn plugin_payload_digest(&self, item_id: ExecutionId) -> Result<String, ExecutionError> {
        if validation::is_derived_check(&self.envelope().operation) {
            return Ok(validation::check_payload_identity(self.item(item_id)?)?.sha256);
        }
        let mut digests = self.plugin_payload_digests.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(digest) = digests.get(&item_id) {
            return Ok(digest.clone());
        }
        let digest = self.plugin_payload(item_id, |payload, limit| {
            payload.digest(limit.min(sdk::MAX_MATERIAL_INVOCATION_BYTES))
        })?;
        digests.insert(item_id, digest.clone());
        Ok(digest)
    }

    fn plugin_result_budget(&self, binding: &PluginExecutionBinding) -> Result<u32, ExecutionError> {
        let envelope = self.envelope();
        let declaration = &binding.capability.declaration;
        let bounded_json_contract = matches!(
            envelope.operation.as_str(),
            crate::content::OPERATION
                | SOURCE_CHECK_OPERATION
                | crate::content::BUILD_OPERATION
                | ARTIFACT_CHECK_OPERATION
                | crate::content::TRANSLATION_EXTRACTION_OPERATION
                | TRANSLATION_CHECK_OPERATION
                | REVIEW_CHECK_OPERATION
        ) || ((declaration.input_schema
            == sdk::generation_service_input_contract()
            || declaration.input_schema == sdk::generation_component_input_contract())
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
            if declaration.output_schema == sdk::paired_translation_exchange_contract() {
                declaration
                    .limits
                    .max_output_bytes
                    .min(sdk::MAX_PAIRED_TRANSLATION_RESULT_BYTES as u32)
                    .saturating_mul(2)
                    .saturating_add(32 * 1024)
                    .min(envelope.limits.max_result_bytes.saturating_sub(64 * 1024))
            } else {
                envelope
                    .limits
                    .max_result_bytes
                    .saturating_sub(64 * 1024)
                    .min(declaration.limits.max_output_bytes)
                    .min(sdk::MAX_EXCHANGE_BYTES as u32)
            }
        } else if bounded_json_contract {
            let raw = envelope.limits.max_result_bytes.saturating_sub(64 * 1024) / 3;
            let payload_limit = if declaration.output_schema == sdk::artifact_set_contract() {
                sdk::MAX_ARTIFACT_SET_BYTES
            } else if declaration.output_schema == sdk::check_results_contract() {
                sdk::MAX_CHECK_RESULTS_BYTES
            } else {
                sdk::MAX_EXCHANGE_BYTES
            };
            let raw = raw
                .min(declaration.limits.max_output_bytes)
                .min(payload_limit as u32);
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
        Ok(max_result_bytes)
    }

    fn plugin_context(
        &self,
        item_id: ExecutionId,
        dispatch_token: ExecutionId,
        binding: &PluginExecutionBinding,
        input_digest: String,
    ) -> Result<sdk::InvocationContext, ExecutionError> {
        let envelope = self.envelope();
        let item = self.item(item_id)?;
        Ok(sdk::InvocationContext {
            project_id: envelope.project_id.to_string(),
            scope_id: binding.scope_id(envelope.project_id, envelope.attempt_id)?,
            operation_id: envelope.task_id.to_string(),
            attempt_id: envelope.attempt_id.to_string(),
            item_id: item_id.to_string(),
            dispatch_id: dispatch_token.to_string(),
            input_digest,
            scope_digest: codec::digest(&codec::encode(&(&item.scope, &item.dependencies), MAX_INPUT_BYTES)?),
            environment_digest: binding.environment_digest()?,
            configuration_digest: codec::digest_encoded(&envelope.settings, MAX_FIXED_INPUT_BYTES)?,
        })
    }
}

mod erased_payload {
    use super::*;

    pub(super) trait Payload {
        fn encode(&self, limit: usize) -> Result<Vec<u8>, ExecutionError>;
        fn digest(&self, limit: usize) -> Result<String, ExecutionError>;
    }
    impl<T: Serialize> Payload for T {
        fn encode(&self, limit: usize) -> Result<Vec<u8>, ExecutionError> {
            codec::encode(self, limit)
        }
        fn digest(&self, limit: usize) -> Result<String, ExecutionError> {
            codec::digest_encoded(self, limit)
        }
    }

    pub(super) struct BuildPayload<'a> {
        pub(super) binding: &'a sdk::BuildBinding,
        pub(super) input: sdk::BuildInput,
    }

    impl BuildPayload<'_> {
        fn write(&self, writer: impl std::io::Write) -> Result<(), ExecutionError> {
            self.binding.write_input(&self.input, writer)
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "release-plan"))
        }
    }

    impl Payload for BuildPayload<'_> {
        // The restored plan binds this builder to the fixed capability. Its
        // SDK encoder owns the same limit and the material ceiling together.
        fn encode(&self, _limit: usize) -> Result<Vec<u8>, ExecutionError> {
            let mut bytes = Vec::new();
            self.write(&mut bytes)?;
            Ok(bytes)
        }
        fn digest(&self, _limit: usize) -> Result<String, ExecutionError> {
            codec::digest_written(|writer| self.write(writer)).map(|(digest, _)| digest)
        }
    }
}

impl PluginResultEvidence {
    pub(crate) fn validate(
        &self,
        envelope: &ResultEnvelope,
        input: &FixedInput,
        token: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let binding = input.plugin_binding_for_channel(&self.channel)?;
        let declaration = &binding.capability.declaration;
        let context = input.plugin_context(
            envelope.item_id, token, binding, input.plugin_payload_digest(envelope.item_id)?,
        )?;
        let max_result_bytes = input.plugin_result_budget(binding)?;
        sdk::validate_invocation_result_binding(
            &self.result, &context, &self.channel, &declaration.contract, binding.profile.as_ref(),
            &declaration.output_schema, &declaration.error_schema, &self.channel,
        ).map_err(contract_error)?;
        let payload = match &self.result.outcome {
            sdk::InvocationOutcome::Succeeded { output } => output,
            sdk::InvocationOutcome::Failed { error }
            | sdk::InvocationOutcome::Unknown { error } => error,
        };
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
                let mismatch = || ExecutionError::new(ErrorCode::ResultMismatch, "plugin-output");
                let expected = envelope.output.as_ref().ok_or_else(mismatch)?;
                if envelope.outcome != ExecutionState::Succeeded {
                    return Err(mismatch());
                }
                if stores_output_reference(input) {
                    codec::validate_json(output.utf8.as_bytes(), input.envelope().limits.max_result_bytes as usize)?;
                }
                if *expected != ledger_output(input, output)? {
                    return Err(mismatch());
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
        check_result_document_size(&self.result, max_result_bytes as usize)?;
        if envelope.diagnostic.as_ref().is_some_and(|d| d.retry_safe) {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "plugin-retry",
            ));
        }
        Ok(())
    }
}

fn check_result_document_size(result: &sdk::InvocationResult, limit: usize) -> Result<(), ExecutionError> {
    let check = |result, limit| {
        let doc = sdk::ExchangeDocument {
            protocol_version: sdk::EXCHANGE_PROTOCOL,
            body: sdk::ExchangeBody::Result(result),
        };
        codec::check_encoded_size(&doc, limit)
    };
    // Successful output has already passed strict JSON validation above.
    // Its only literal control bytes can be tab, LF and CR. Quoting any
    // byte therefore needs at most two bytes. The empty string counts the
    // quotes in the actual SDK envelope so metadata stays inside the limit.
    if let sdk::InvocationOutcome::Succeeded { output } = &result.outcome
        && let Some(metadata_limit) = limit.checked_sub(output.utf8.len().saturating_mul(2))
    {
        let metadata = sdk::InvocationResult {
            outcome: sdk::InvocationOutcome::Succeeded {
                output: sdk::EncodedPayload { utf8: "".into(), ..output.clone() },
            },
            ..result.clone()
        };
        if check(metadata, metadata_limit).is_ok() {
            return Ok(());
        }
    }
    // Opaque failure payloads and successes close to the limit use exact size.
    check(result.clone(), limit).map_err(|_| ExecutionError::new(ErrorCode::ResultMismatch, "plugin-contract"))
}
impl FixedResult {
    /// Called by a trusted adapter after actual-channel validation. This keeps
    /// opaque errors and the raw JSON proposal alongside its ledger projection.
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
    if stores_output_reference(input) {
        serde_json::to_value((&output.schema, &output.sha256))
            .map_err(|_| ExecutionError::new(ErrorCode::OutputInvalid, "plugin-output"))
    } else {
        codec::decode(output.utf8.as_bytes(), input.envelope().limits.max_result_bytes as usize)
    }
}

pub(super) fn stores_output_reference(input: &FixedInput) -> bool {
    matches!(
        input.envelope().operation.as_str(),
        crate::content::OPERATION
            | crate::content::BUILD_OPERATION
            | crate::content::TRANSLATION_EXTRACTION_OPERATION
    )
}

#[cfg(test)]
#[test]
fn result_wire_budget_accepts_exact_size_and_rejects_one_byte_less() {
    let document: sdk::ExchangeDocument = serde_json::from_slice(include_bytes!(
        "../../../plugin-sdk/tests/fixtures/invocation.result.json"
    )).unwrap();
    let sdk::ExchangeBody::Result(mut result) = document.body else {
        panic!("expected a plugin result fixture")
    };
    let sdk::InvocationOutcome::Succeeded { output } = &result.outcome else {
        panic!("expected a successful result fixture")
    };
    let text = "\"path\\name\"\n\u{0001}文".repeat(512);
    let success = sdk::EncodedPayload::capture(
        output.schema.clone(),
        serde_json::to_string(&text).unwrap(),
    ).unwrap();
    let error = sdk::EncodedPayload::capture(output.schema.clone(), text).unwrap();
    for outcome in [
        sdk::InvocationOutcome::Succeeded { output: success },
        sdk::InvocationOutcome::Failed { error: error.clone() },
        sdk::InvocationOutcome::Unknown { error },
    ] {
        result.outcome = outcome;
        let wire = serde_json::to_vec(&sdk::ExchangeDocument {
            protocol_version: sdk::EXCHANGE_PROTOCOL,
            body: sdk::ExchangeBody::Result(result.clone()),
        }).unwrap();
        check_result_document_size(&result, wire.len()).unwrap();
        assert_eq!(
            check_result_document_size(&result, wire.len() - 1).unwrap_err().code,
            ErrorCode::ResultMismatch
        );
    }
}
