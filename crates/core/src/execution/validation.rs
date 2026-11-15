//! Trusted semantic checks run on captured values outside project transactions.
use super::*;
use tsumugi_plugin_sdk as sdk;

pub(crate) fn requires_semantic_check(input: &FixedInput) -> bool {
    input.envelope().plugin.is_some()
        && matches!(
            input.envelope().operation.as_str(),
            crate::content::OPERATION
                | crate::content::BUILD_OPERATION
                | crate::content::TRANSLATION_EXTRACTION_OPERATION
        )
}

/// Normalize only generated identities; every policy, payload, scope and
/// selected environment must still equal the independently reconstructed input.
pub(crate) fn restore_check_input(
    expected: &FixedInput,
    actual: &FixedInput,
) -> Result<(), ExecutionError> {
    compare_check_input(expected.envelope().clone(), actual)
}

#[cfg(test)]
pub(super) fn restore_reconstructed_check_input(
    mut expected: InputEnvelope,
    actual: &FixedInput,
) -> Result<(), ExecutionError> {
    FixedInput::validate_capture(&mut expected)?;
    compare_check_input(expected, actual)
}

/// The payload is compared separately with the original producer evidence.
/// Check its canonical bytes and reuse them for the checker result binding.
pub(super) fn restore_check_header(
    expected: InputEnvelope,
    actual: &FixedInput,
) -> Result<(), ExecutionError> {
    let captured = actual.envelope();
    let binding = captured.plugin.as_ref().filter(|_| {
        matches!(captured.operation.as_str(), SOURCE_CHECK_OPERATION | ARTIFACT_CHECK_OPERATION)
    }).ok_or_else(|| ExecutionError::new(ErrorCode::ResultMismatch, "semantic-check-input"))?;
    let limit = (binding.capability.declaration.limits.max_input_bytes as usize)
        .min(sdk::MAX_MATERIAL_INVOCATION_BYTES);
    let payload = checked_payload_bytes(expected, actual, limit)?;
    let item_id = captured.items[0].item_id;
    actual.plugin_payload_digests.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(item_id).or_insert_with(|| codec::digest(payload));
    Ok(())
}

fn checked_payload_bytes(
    mut expected: InputEnvelope,
    actual: &FixedInput,
    limit: usize,
) -> Result<&[u8], ExecutionError> {
    let invalid = || ExecutionError::new(ErrorCode::ResultMismatch, "semantic-check-input");
    let captured = actual.envelope();
    bind_check_ids(&mut expected, captured)?;
    let frame_limit = FixedInput::byte_limit(&expected);
    // Serialize the small reconstructed header with two single-byte values.
    // Their one differing byte locates the payload without scanning material
    // or relying on field order, offsets or marker text in the stored frame.
    expected.items[0].payload = Value::from(0);
    let header = codec::encode(&expected, frame_limit)?;
    expected.items[0].payload = Value::from(1);
    let alternate = codec::encode(&expected, frame_limit)?;
    let offset = header.iter().zip(&alternate).position(|(a, b)| a != b).ok_or_else(invalid)?;
    let payload = actual.bytes().strip_prefix(&header[..offset])
        .and_then(|rest| rest.strip_suffix(&header[offset + 1..]))
        .ok_or_else(invalid)?;
    if !codec::matches_encoding(&captured.items[0].payload, limit, payload)? {
        return Err(invalid());
    }
    Ok(payload)
}

#[cfg(test)]
#[test]
fn checker_payload_digest_uses_only_the_exact_canonical_item_payload() {
    let project = ProjectId::new_v4();
    let payload = serde_json::json!({"text": "a\n\"字\"", "payload": 0});
    let capture = |payload| {
        let scope = Scope { kind: "source-check".into(), id: "sample".into(), locale: None };
        let item = InputItem::new(scope, payload, vec![]);
        let mut envelope = InputEnvelope::new(project, "check", "controlled", "1", vec![item]).unwrap();
        envelope.settings = serde_json::json!({"payload": 0, "text": "payload"});
        envelope
    };
    let expected = capture(Value::Null);
    let fixed = FixedInput::capture(capture(payload.clone())).unwrap();
    let bytes = checked_payload_bytes(expected.clone(), &fixed, MAX_INPUT_BYTES).unwrap();
    assert_eq!(codec::digest(bytes), codec::digest_encoded(&payload, MAX_INPUT_BYTES).unwrap());
    assert_eq!(checked_payload_bytes(expected.clone(), &fixed, bytes.len() - 1).unwrap_err().code,
        ErrorCode::LimitExceeded);

    // The decoded value and full-frame digest still qualify, but the
    // payload's representation is different from the SDK's canonical bytes.
    let offset = fixed.bytes().windows(bytes.len()).position(|window| window == bytes).unwrap();
    let mut spaced = fixed.bytes().to_vec();
    spaced.insert(offset + 1, b' ');
    let spaced = FixedInput::restore(&spaced, &codec::digest(&spaced)).unwrap();
    assert_eq!(fixed.envelope(), spaced.envelope());
    assert_eq!(checked_payload_bytes(expected.clone(), &spaced, MAX_INPUT_BYTES).unwrap_err().code,
        ErrorCode::ResultMismatch);

    let mut wrong_header = expected;
    wrong_header.settings["payload"] = Value::from(1);
    assert_eq!(checked_payload_bytes(wrong_header, &fixed, MAX_INPUT_BYTES).unwrap_err().code,
        ErrorCode::ResultMismatch);
}

fn compare_check_input(mut rebuilt: InputEnvelope, actual: &FixedInput) -> Result<(), ExecutionError> {
    bind_check_ids(&mut rebuilt, actual.envelope())?;
    // Both inputs were already validated. Exact canonical bytes also check
    // the rebound identities without decoding and validating another frame.
    rebuilt.normalize();
    if !codec::matches_encoding(&rebuilt, FixedInput::byte_limit(&rebuilt), actual.bytes())? {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "semantic-check-input",
        ));
    }
    Ok(())
}

fn bind_check_ids(rebuilt: &mut InputEnvelope, captured: &InputEnvelope) -> Result<(), ExecutionError> {
    if captured.items.len() != 1 || captured.units.len() != 1 {
        return Err(ExecutionError::new(
            ErrorCode::ResultMismatch,
            "semantic-check-input",
        ));
    }
    rebuilt.task_id = captured.task_id;
    rebuilt.attempt_id = captured.attempt_id;
    rebuilt.items[0].item_id = captured.items[0].item_id;
    rebuilt.units[0].unit_id = captured.units[0].unit_id;
    rebuilt.units[0].item_ids = vec![captured.items[0].item_id];
    Ok(())
}

// Compare one typed value at a time to limit temporary JSON allocations.
pub(super) fn matches_value<T: ?Sized + Serialize>(saved: Option<&Value>, expected: &T) -> bool {
    serde_json::to_value(expected).is_ok_and(|value| saved == Some(&value))
}

pub(super) fn matches_array<T>(
    saved: Option<&Value>,
    expected: &[T],
    matches: impl Fn(&Value, &T) -> bool,
) -> bool {
    saved.and_then(Value::as_array).is_some_and(|saved| {
        saved.len() == expected.len() && saved.iter().zip(expected).all(|(a, b)| matches(a, b))
    })
}

fn matches_artifacts(saved: Option<&Value>, expected: &[sdk::CapturedArtifact]) -> bool {
    matches_array(saved, expected, |saved, artifact| {
        let Some(saved) = saved.as_object().filter(|object| object.len() == 5) else { return false; };
        let (field, data) = match artifact {
            sdk::CapturedArtifact::Text(text) => ("utf8", text.utf8.as_str()),
            sdk::CapturedArtifact::Binary(binary) => ("base64", binary.base64.as_ref()),
        };
        saved.get(field).and_then(Value::as_str) == Some(data)
            && saved.get("id").and_then(Value::as_str) == Some(artifact.id())
            && saved.get("logicalPath").and_then(Value::as_str) == Some(artifact.logical_path())
            && saved.get("role").and_then(Value::as_str) == Some(artifact.role())
            && saved.get("sha256").and_then(Value::as_str) == Some(artifact.sha256())
    })
}

pub(super) fn matches_source_input(saved: Option<&Value>, expected: &sdk::SourceExtractionInput) -> bool {
    saved.and_then(Value::as_object).is_some_and(|saved| {
        saved.len() == 4
            && matches_material(saved, &expected.profile, &expected.source_set_id, "sourceLanguage",
                &expected.source_language, &expected.artifacts)
    })
}

fn matches_material(
    saved: &serde_json::Map<String, Value>,
    profile: &sdk::ContractRef,
    set: &str,
    language_key: &str,
    language: &str,
    artifacts: &[sdk::CapturedArtifact],
) -> bool {
    matches_value(saved.get("profile"), profile)
        && saved.get("sourceSetId").and_then(Value::as_str) == Some(set)
        && saved.get(language_key).and_then(Value::as_str) == Some(language)
        && matches_artifacts(saved.get("artifacts"), artifacts)
}

pub(super) fn matches_exchange(saved: Option<&Value>, expected: &sdk::ContentExchange) -> bool {
    saved.and_then(Value::as_object).is_some_and(|saved| {
        saved.len() == 8
            && matches_material(saved, &expected.profile, &expected.source_set_id, "sourceLanguage",
                &expected.source_language, &expected.artifacts)
            && matches_array(saved.get("units"), &expected.units, matches_content_unit)
            && matches_array(saved.get("order"), &expected.order, |saved, id| saved.as_str() == Some(id.as_str()))
            && matches_array(saved.get("relations"), &expected.relations, |saved, relation| matches_value(Some(saved), relation))
            && matches_array(saved.get("domainBlocks"), &expected.domain_blocks, matches_domain_block)
    })
}

fn matches_content_unit(saved: &Value, unit: &sdk::ContentUnit) -> bool {
    saved.as_object().is_some_and(|saved| {
        saved.len() == 5
            && saved.get("id").and_then(Value::as_str) == Some(&unit.id)
            && saved.get("sourceRevisionId").and_then(Value::as_str) == Some(&unit.source_revision_id)
            && saved.get("text").and_then(Value::as_str) == Some(&unit.text)
            && matches_value(saved.get("occurrences"), &unit.occurrences)
            && matches_value(saved.get("protectedFragments"), &unit.protected_fragments)
    })
}

fn matches_domain_block(saved: &Value, block: &sdk::DomainBlock) -> bool {
    saved.as_object().is_some_and(|saved| {
        saved.len() == 4
            && saved.get("payloadUtf8").and_then(Value::as_str) == Some(&block.payload_utf8)
            && matches_value(saved.get("target"), &block.target)
            && matches_value(saved.get("schema"), &block.schema)
            && matches_value(saved.get("handling"), &block.handling)
    })
}

pub(super) fn matches_artifact_set(saved: Option<&Value>, expected: &sdk::ArtifactSet) -> bool {
    saved.and_then(Value::as_object).is_some_and(|saved| {
        saved.len() == 4
            && matches_material(saved, &expected.profile, &expected.source_set_id, "targetLanguage",
                &expected.target_language, &expected.artifacts)
    })
}

/// Domain output cannot assert Core checks or another provider's coverage. Core
/// appends only the generic checks already established by the capture owner.
pub(super) fn validate_required_check_result(
    checks: &sdk::FixedCheckSet,
    result: &FixedResult,
) -> Result<(), ExecutionError> {
    let invalid = || ExecutionError::new(ErrorCode::OutputInvalid, "required-semantic-check");
    let evidence = result.envelope().plugin.as_ref().ok_or_else(invalid)?;
    let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
        return Err(invalid());
    };
    if output.schema != sdk::check_results_contract() {
        return Err(invalid());
    }
    let mut results = sdk::parse_check_results(output.utf8.as_bytes()).map_err(|_| invalid())?;
    if results.iter().any(|r| match &r.key.implementation {
        sdk::CheckImplementation::Plugin { provider } => *provider != evidence.channel.selection(),
        sdk::CheckImplementation::Core { .. } => true,
    }) {
        return Err(invalid());
    }
    for core in checks
        .set()
        .requirements
        .iter()
        .filter(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }))
    {
        results.push(sdk::CheckResult {
            key: core.key.clone(),
            input_digest: core.input_digest.clone(),
            scope_digest: core.scope_digest.clone(),
            covered_targets: core.targets.clone(),
            outcome: sdk::CheckOutcome::Completed { findings: vec![] },
        });
    }
    let coverage = checks.evaluate(&results).map_err(|_| invalid())?;
    if !coverage.complete
        || results.iter().any(|r| match &r.outcome {
            sdk::CheckOutcome::Completed { findings } => findings
                .iter()
                .any(|f| f.severity == sdk::FindingSeverity::Error),
            _ => true,
        })
    {
        return Err(invalid());
    }
    Ok(())
}

/// Registered by the trusted application, never selected by a producer result.
/// Implementations inspect bounded captured data without project writes or IO.
pub trait ResultValidator: Send + Sync + 'static {
    fn operation(&self) -> &str;
    fn validate(&self, input: &FixedInput, result: &FixedResult) -> Result<(), ExecutionError>;
}

#[derive(Clone, Debug)]
pub(crate) struct ValidationProof {
    pub(crate) input_digest: String,
    pub(crate) result_digest: String,
    pub(crate) operation: String,
    pub(crate) valid: bool,
}
impl ValidationProof {
    pub(crate) fn matches(&self, input: &FixedInput, result: &FixedResult) -> bool {
        self.input_digest == input.digest()
            && self.result_digest == result.digest()
            && self.operation == input.envelope().operation
    }
}

/// Store-owned immutable snapshot; preparation does not retain the store.
#[derive(Clone)]
pub struct ResultValidationCapture {
    pub(crate) input: FixedInput,
    pub(crate) result: FixedResult,
}
pub struct PreparedResultValidation {
    pub(crate) capture: ResultValidationCapture,
    pub(crate) proof: ValidationProof,
}
impl ResultValidationCapture {
    /// Restore an original artifact checker without renewing either grant.
    pub fn restore_artifact_check(
        self,
        input: FixedInput,
    ) -> Result<ArtifactValidationCapture, ExecutionError> {
        ArtifactValidationCapture::restore(self, input)
    }
    /// Recover the original independently captured checker input. Only generated
    /// identities may differ from reconstruction; every payload and binding is
    /// compared by the same owner used when restoring durable proof links.
    pub fn restore_translation_check(
        self,
        input: FixedInput,
    ) -> Result<TranslationValidationCapture, ExecutionError> {
        TranslationValidationCapture::restore(self, input)
    }

    pub fn prepare_translation_check(
        self,
        attempt: ExecutionId,
    ) -> Result<TranslationValidationCapture, ExecutionError> {
        let mut capture = TranslationValidationCapture::capture(self)?;
        let mut envelope = capture.check_input().envelope().clone();
        envelope.attempt_id = attempt;
        capture.set_check_input(FixedInput::capture(envelope)?);
        Ok(capture)
    }
    /// Capture actual artifacts and the independently fixed checker policy on a
    /// computation worker. Submission still requires a separate current grant.
    pub fn prepare_artifact_check(
        self,
        attempt: ExecutionId,
    ) -> Result<ArtifactValidationCapture, ExecutionError> {
        ArtifactValidationCapture::capture(self, Some(attempt))
    }
    /// Build the mandatory source checker input from store-owned evidence on a
    /// computation worker, without retaining a project connection or write.
    pub fn prepare_source_check(
        self,
        attempt: ExecutionId,
    ) -> Result<SourceValidationCapture, ExecutionError> {
        SourceValidationCapture::capture(self, Some(attempt))
    }

    pub fn input(&self) -> &FixedInput {
        &self.input
    }
    pub fn result(&self) -> &FixedResult {
        &self.result
    }
    pub fn prepare(
        self,
        validator: &dyn ResultValidator,
    ) -> Result<PreparedResultValidation, ExecutionError> {
        if requires_semantic_check(&self.input) {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                match self.input.envelope().operation.as_str() {
                    crate::content::OPERATION => "source-semantic-check-required",
                    crate::content::TRANSLATION_EXTRACTION_OPERATION => {
                        "translation-semantic-check-required"
                    }
                    _ => "artifact-semantic-check-required",
                },
            ));
        }
        if validator.operation() != self.input.envelope().operation
            || self.result.envelope().outcome != ExecutionState::Succeeded
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "result-validator",
            ));
        }
        let proof = ValidationProof {
            input_digest: self.input.digest().into(),
            result_digest: self.result.digest().into(),
            operation: validator.operation().into(),
            valid: validator.validate(&self.input, &self.result).is_ok(),
        };
        Ok(PreparedResultValidation {
            capture: self,
            proof,
        })
    }
}
