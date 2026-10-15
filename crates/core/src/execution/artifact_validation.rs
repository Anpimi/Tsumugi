//! Independent artifact evidence binds the complete actual output to the
//! original qualified plan. Pure preparation never grants execution or release.
use super::*;
use crate::ReleasePlan;
use tsumugi_plugin_sdk as sdk;

pub const ARTIFACT_CHECK_OPERATION: &str = "artifact-semantic-check";
const POLICY: &str = "core.release-artifact-adoption";
const STRUCTURE: &str = "core.release-artifact-structure";

fn reference(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn invalid() -> ExecutionError {
    ExecutionError::new(ErrorCode::OutputInvalid, "artifact-semantic-check")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtifactValidationBasis {
    build_attempt_id: ExecutionId,
    build_item_id: ExecutionId,
    build_result_id: ExecutionId,
    build_input_digest: String,
    build_result_digest: String,
}

/// One store-owned builder result, including every returned artifact for that
/// locale. The independent checker receives fixed SDK data and no Core history.
#[derive(Clone)]
pub struct ArtifactValidationCapture {
    pub(crate) build: ResultValidationCapture,
    pub(crate) check_input: FixedInput,
    checks: sdk::FixedCheckSet,
}
pub struct PreparedArtifactValidation {
    pub(crate) capture: ArtifactValidationCapture,
    pub(crate) check_result: FixedResult,
    pub(crate) proof: validation::ValidationProof,
}
impl ArtifactValidationCapture {
    pub(crate) fn capture(build: ResultValidationCapture) -> Result<Self, ExecutionError> {
        let plan = ReleasePlan::from_input(&build.input)?;
        let result = &build.result;
        FixedResult::restore(
            result.bytes(),
            result.digest(),
            &build.input,
            result.envelope().dispatch_token,
        )?;
        let output = plan.artifact_set(result)?;
        let item = build.input.item(result.envelope().item_id)?;
        let locale = item.scope.locale.as_deref().ok_or_else(invalid)?;
        let input = plan.plugin_input(locale)?;
        let environment = plan.build_environment();
        let binding = environment.binding();
        binding
            .validate_artifacts(&input, &output)
            .map_err(|_| invalid())?;
        let targets: Vec<_> = output.artifacts.iter().map(|a| a.id.clone()).collect();
        let requirement = |key| sdk::CheckRequirement {
            key,
            input_digest: build.input.digest().into(),
            scope_digest: build.result.digest().into(),
            targets: targets.clone(),
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
        let domain: Vec<_> = binding
            .declaration
            .artifact_rules
            .iter()
            .map(|rule| {
                requirement(sdk::CheckKey {
                    rule: rule.clone(),
                    implementation: sdk::CheckImplementation::Plugin {
                        provider: binding.checker.provider.clone(),
                    },
                })
            })
            .collect();
        let checks = sdk::capture_required_checks(reference(POLICY), vec![core], domain.clone())
            .map_err(|_| invalid())?;
        let payload = sdk::ArtifactCheckInput {
            input,
            output,
            requirements: domain,
        };
        binding
            .validate_check_input(&payload)
            .map_err(|_| invalid())?;
        let selected = environment.checker().clone();
        selected.validate()?;
        let basis = ArtifactValidationBasis {
            build_attempt_id: build.input.envelope().attempt_id,
            build_item_id: result.envelope().item_id,
            build_result_id: result.envelope().result_id,
            build_input_digest: build.input.digest().into(),
            build_result_digest: result.digest().into(),
        };
        let item = InputItem::new(
            Scope {
                kind: "artifact-check".into(),
                id: payload.input.source.source_set_id.clone(),
                locale: Some(locale.into()),
            },
            serde_json::to_value(payload).map_err(|_| invalid())?,
            vec![],
        );
        let project = build
            .input
            .envelope()
            .project_id
            .to_string()
            .parse::<ProjectId>()
            .map_err(|_| invalid())?;
        let mut envelope = InputEnvelope::new(
            project,
            ARTIFACT_CHECK_OPERATION,
            &selected.capability.declaration.contract.id,
            &selected.capability_version(),
            vec![item],
        )?;
        envelope.settings = serde_json::to_value(basis).map_err(|_| invalid())?;
        envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
        envelope.limits.timeout_ms = envelope
            .limits
            .timeout_ms
            .min(selected.capability.declaration.limits.timeout_ms);
        envelope.plugin = Some(selected);
        let check_input = FixedInput::capture(envelope)?;
        Ok(Self {
            build,
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
        build: ResultValidationCapture,
        check_input: FixedInput,
    ) -> Result<Self, ExecutionError> {
        let mut capture = Self::capture(build)?;
        validation::restore_check_input(&capture.check_input, &check_input)?;
        capture.check_input = check_input;
        Ok(capture)
    }
    /// Coverage can be complete and still have blocking findings. The ledger
    /// records valid/invalid against these exact producer and checker results.
    pub fn prepare(
        self,
        check_result: FixedResult,
    ) -> Result<PreparedArtifactValidation, ExecutionError> {
        FixedResult::restore(
            check_result.bytes(),
            check_result.digest(),
            &self.check_input,
            check_result.envelope().dispatch_token,
        )?;
        let proof = validation::ValidationProof {
            input_digest: self.build.input.digest().into(),
            result_digest: self.build.result.digest().into(),
            operation: crate::content::BUILD_OPERATION.into(),
            valid: validation::validate_required_check_result(&self.checks, &check_result).is_ok(),
        };
        Ok(PreparedArtifactValidation {
            capture: self,
            check_result,
            proof,
        })
    }
}
