//! Independent complete-file translation checks use the existing proof owner.
use super::*;
use tsumugi_plugin_sdk as sdk;

pub const TRANSLATION_CHECK_OPERATION: &str = "translation-semantic-check";
const POLICY: &str = "core.translation-import";
const STRUCTURE: &str = "core.translation-structure";

fn reference(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn invalid() -> ExecutionError {
    ExecutionError::new(ErrorCode::OutputInvalid, "translation-semantic-check")
}

// The ledger captures each material once. The SDK checker still receives its
// complete original contract; only fields proven equal by SDK association are
// shared here. Coordinates, opaque IDs and proposal artifact order stay exact.
type CheckSource = (String, sdk::TextEncoding, u32, u32);
type CheckEntry = (
    String,
    String,
    CheckSource,
    String,
    String,
    Option<CheckSource>,
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranslationCheckPayload {
    version: u32,
    input: sdk::TranslationExtractionInput,
    declared_language: String,
    artifact_order: Vec<String>,
    entries: Vec<CheckEntry>,
    order: Vec<String>,
    requirements: Vec<sdk::CheckRequirement>,
}
fn pack_source(source: sdk::SourceReference) -> CheckSource {
    (
        source.artifact_id,
        source.range.encoding,
        source.range.start,
        source.range.end,
    )
}
fn unpack_source(source: CheckSource) -> sdk::SourceReference {
    sdk::SourceReference {
        artifact_id: source.0,
        range: sdk::TextRange {
            encoding: source.1,
            start: source.2,
            end: source.3,
        },
    }
}
impl TranslationCheckPayload {
    fn capture(payload: sdk::TranslationExtractionCheckInput) -> Result<Self, ExecutionError> {
        payload.validate().map_err(|_| invalid())?;
        Ok(Self {
            version: 1,
            input: payload.input,
            declared_language: payload.proposal.declared_language,
            artifact_order: payload
                .proposal
                .artifacts
                .into_iter()
                .map(|a| a.id)
                .collect(),
            entries: payload
                .proposal
                .entries
                .into_iter()
                .map(|entry| {
                    (
                        entry.id,
                        entry.text,
                        pack_source(entry.source),
                        entry.native_identity.value,
                        entry.native_identity.display.value,
                        entry.native_identity.display.source.map(pack_source),
                    )
                })
                .collect(),
            order: payload.proposal.order,
            requirements: payload.requirements,
        })
    }
    fn expand(self) -> Result<sdk::TranslationExtractionCheckInput, ExecutionError> {
        if self.version != 1 {
            return Err(invalid());
        }
        let artifacts = self
            .artifact_order
            .iter()
            .map(|id| {
                self.input
                    .artifacts
                    .iter()
                    .find(|artifact| &artifact.id == id)
                    .cloned()
                    .ok_or_else(invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let entries = self
            .entries
            .into_iter()
            .map(
                |(id, text, source, value, display, display_source)| sdk::ImportedTranslation {
                    id,
                    text,
                    source: unpack_source(source),
                    native_identity: sdk::NativeIdentityEvidence {
                        namespace: self.input.native_scope.namespace.clone(),
                        policy: self.input.native_scope.policy.clone(),
                        value,
                        display: sdk::NativeIdentityDisplay {
                            value: display,
                            source: display_source.map(unpack_source),
                        },
                    },
                },
            )
            .collect();
        let proposal = sdk::TranslationExchange {
            profile: self.input.profile.clone(),
            import_id: self.input.import_id.clone(),
            source_set_id: self.input.source_set_id.clone(),
            source_snapshot_id: self.input.source_snapshot_id.clone(),
            target_language: self.input.target_language.clone(),
            declared_language: self.declared_language,
            language_evidence: self.input.language_evidence,
            native_scope: self.input.native_scope.clone(),
            artifacts,
            entries,
            order: self.order,
        };
        let payload = sdk::TranslationExtractionCheckInput {
            input: self.input,
            proposal,
            requirements: self.requirements,
        };
        payload.validate().map_err(|_| invalid())?;
        Ok(payload)
    }
}
pub(crate) fn expand_translation_check_payload(value: &Value) -> Result<Value, ExecutionError> {
    let captured: TranslationCheckPayload =
        serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    serde_json::to_value(captured.expand()?).map_err(|_| invalid())
}
/// Restore the full SDK checker payload from its single-material ledger capture.
/// This pure read neither creates a proof nor grants execution permission.
pub fn translation_check_payload(
    input: &FixedInput,
) -> Result<sdk::TranslationExtractionCheckInput, ExecutionError> {
    if input.envelope().operation != TRANSLATION_CHECK_OPERATION
        || input.envelope().items.len() != 1
        || input.bytes().len() > crate::content::MAX_TRANSLATION_INPUT_BYTES
    {
        return Err(invalid());
    }
    let captured: TranslationCheckPayload =
        serde_json::from_value(input.envelope().items[0].payload.clone()).map_err(|_| invalid())?;
    captured.expand()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranslationValidationBasis {
    producer_attempt_id: ExecutionId,
    producer_result_id: ExecutionId,
    producer_input_digest: String,
    producer_result_digest: String,
}

/// Captured from the store's immutable producer evidence. Language choice,
/// data fields and a successful checker do not themselves authorize adoption.
#[derive(Clone)]
pub struct TranslationValidationCapture {
    pub(crate) producer: ResultValidationCapture,
    pub(crate) check_input: FixedInput,
    checks: sdk::FixedCheckSet,
}
pub struct PreparedTranslationValidation {
    pub(crate) capture: TranslationValidationCapture,
    pub(crate) check_result: FixedResult,
    pub(crate) proof: validation::ValidationProof,
}
impl TranslationValidationCapture {
    pub(crate) fn capture(producer: ResultValidationCapture) -> Result<Self, ExecutionError> {
        let proposal =
            crate::content::validate_plugin_translation_output(&producer.input, &producer.result)?;
        let (input, settings) = crate::content::plugin_translation_input(&producer.input)?;
        let binding = settings.checker;
        let requirement = |key| sdk::CheckRequirement {
            key,
            input_digest: producer.input.digest().into(),
            scope_digest: producer.result.digest().into(),
            targets: vec![input.import_id.clone()],
            mandatory: true,
            waivable: false,
            not_applicable: None,
        };
        let core = requirement(sdk::CheckKey {
            rule: reference(STRUCTURE),
            implementation: sdk::CheckImplementation::Core {
                validator: reference(STRUCTURE),
            },
        });
        let domain: Vec<_> = settings
            .declaration
            .semantic_rules
            .into_iter()
            .map(|rule| {
                requirement(sdk::CheckKey {
                    rule,
                    implementation: sdk::CheckImplementation::Plugin {
                        provider: binding.capability.provider.clone(),
                    },
                })
            })
            .collect();
        let checks = sdk::capture_required_checks(reference(POLICY), vec![core], domain.clone())
            .map_err(|_| invalid())?;
        let payload = sdk::TranslationExtractionCheckInput {
            input,
            proposal,
            requirements: domain,
        };
        payload.validate().map_err(|_| invalid())?;
        let basis = TranslationValidationBasis {
            producer_attempt_id: producer.input.envelope().attempt_id,
            producer_result_id: producer.result.envelope().result_id,
            producer_input_digest: producer.input.digest().into(),
            producer_result_digest: producer.result.digest().into(),
        };
        let item = InputItem::new(
            Scope {
                kind: "translation-check".into(),
                id: payload.input.import_id.clone(),
                locale: Some(payload.input.target_language.clone()),
            },
            serde_json::to_value(TranslationCheckPayload::capture(payload)?)
                .map_err(|_| invalid())?,
            vec![],
        );
        let project = producer
            .input
            .envelope()
            .project_id
            .to_string()
            .parse::<ProjectId>()
            .map_err(|_| invalid())?;
        let mut envelope = InputEnvelope::new(
            project,
            TRANSLATION_CHECK_OPERATION,
            &binding.capability.declaration.contract.id,
            &binding.capability_version(),
            vec![item],
        )?;
        envelope.settings = serde_json::to_value(basis).map_err(|_| invalid())?;
        envelope.limits.max_result_bytes = crate::content::MAX_TRANSLATION_RESULT_BYTES as u32;
        envelope.limits.timeout_ms = envelope
            .limits
            .timeout_ms
            .min(binding.capability.declaration.limits.timeout_ms);
        envelope.plugin = Some(binding);
        let check_input = FixedInput::capture(envelope)?;
        if check_input.bytes().len() > crate::content::MAX_TRANSLATION_INPUT_BYTES {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "translation-check-input-budget",
            ));
        }
        Ok(Self {
            producer,
            check_input,
            checks,
        })
    }
    pub fn check_input(&self) -> &FixedInput {
        &self.check_input
    }
    pub(super) fn set_check_input(&mut self, input: FixedInput) {
        self.check_input = input;
    }
    pub(crate) fn restore(
        producer: ResultValidationCapture,
        check_input: FixedInput,
    ) -> Result<Self, ExecutionError> {
        let mut capture = Self::capture(producer)?;
        validation::restore_check_input(&capture.check_input, &check_input)?;
        capture.check_input = check_input;
        Ok(capture)
    }
    pub fn prepare(
        self,
        check_result: FixedResult,
    ) -> Result<PreparedTranslationValidation, ExecutionError> {
        FixedResult::restore(
            check_result.bytes(),
            check_result.digest(),
            &self.check_input,
            check_result.envelope().dispatch_token,
        )?;
        let valid = validation::validate_required_check_result(&self.checks, &check_result).is_ok();
        let proof = validation::ValidationProof {
            input_digest: self.producer.input.digest().into(),
            result_digest: self.producer.result.digest().into(),
            operation: crate::content::TRANSLATION_EXTRACTION_OPERATION.into(),
            valid,
        };
        Ok(PreparedTranslationValidation {
            capture: self,
            check_result,
            proof,
        })
    }
}
