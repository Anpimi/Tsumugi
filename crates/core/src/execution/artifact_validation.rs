//! Independent artifact evidence binds the complete actual output to the
//! original qualified plan. Pure preparation never grants execution or release.
use super::*;
use crate::ReleasePlan;
use tsumugi_plugin_sdk as sdk;

pub const ARTIFACT_CHECK_OPERATION: &str = "artifact-semantic-check";
const POLICY: &str = "core.release-artifact-adoption";
const STRUCTURE: &str = "core.release-artifact-structure";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckBuildResultRef {
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
}

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
impl PreparedArtifactValidation {
    pub fn valid(&self) -> bool {
        self.proof.valid
    }
}
impl ArtifactValidationCapture {
    pub(crate) fn capture(
        build: ResultValidationCapture,
        attempt: Option<ExecutionId>,
    ) -> Result<Self, ExecutionError> {
        let plan = ReleasePlan::from_input(&build.input)?;
        let (mut envelope, checks, _) = Self::reconstruct(&build, &plan, None)?;
        envelope.attempt_id = attempt.unwrap_or(envelope.attempt_id);
        let check_input = FixedInput::capture(envelope)?;
        Ok(Self { build, check_input, checks })
    }

    fn reconstruct(
        build: &ResultValidationCapture,
        plan: &ReleasePlan,
        saved_payload: Option<&Value>,
    ) -> Result<(InputEnvelope, sdk::FixedCheckSet, sdk::ArtifactSet), ExecutionError> {
        let result = &build.result;
        result.validate_for_input(&build.input)?;
        let output = plan.parse_artifact_set(result)?;
        let item = build.input.item(result.envelope().item_id)?;
        let locale = item.scope.locale.as_deref().ok_or_else(invalid)?;
        if output.target_language != locale {
            return Err(invalid());
        }
        let input = plan.project_plugin_input(locale)?;
        let environment = plan.build_environment();
        let binding = environment.binding();
        let targets: Vec<_> = output.artifacts.iter().map(|a| a.id().to_owned()).collect();
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
        let encoded_payload = if let Some(saved) = saved_payload {
            let matched = saved.as_object().is_some_and(|saved| {
                saved.len() == 3
                    && saved.get("input").and_then(Value::as_object).is_some_and(|input| {
                        input.len() == 6
                            && validation::matches_exchange(input.get("source"), &payload.input.source)
                            && validation::matches_value(input.get("targetLanguage"), &payload.input.target_language)
                            && validation::matches_array(input.get("targets"), &payload.input.targets,
                                |saved, target| validation::matches_value(Some(saved), target))
                            && validation::matches_value(input.get("configuration"), &payload.input.configuration)
                            && validation::matches_value(input.get("outputPaths"), &payload.input.output_paths)
                            && validation::matches_value(input.get("outputLimits"), &payload.input.output_limits)
                    })
                    && validation::matches_artifact_set(saved.get("output"), &payload.output)
                    && validation::matches_value(saved.get("requirements"), &payload.requirements)
            });
            if !matched {
                return Err(ExecutionError::new(ErrorCode::ResultMismatch, "semantic-check-input"));
            }
            Value::Null
        } else {
            serde_json::to_value(&payload).map_err(|_| invalid())?
        };
        let item = InputItem::new(
            Scope {
                kind: "artifact-check".into(),
                id: payload.input.source.source_set_id.clone(),
                locale: Some(locale.into()),
            },
            encoded_payload,
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
        envelope.limits.timeout_ms = selected.capability.declaration.limits.timeout_ms.min(300_000);
        envelope.plugin = Some(selected);
        Ok((envelope, checks, payload.output))
    }
    pub fn check_input(&self) -> &FixedInput {
        &self.check_input
    }
    pub(crate) fn restore(
        build: ResultValidationCapture,
        check_input: FixedInput,
    ) -> Result<Self, ExecutionError> {
        let plan = match build.input.open_build_plan() {
            Some(plan) => plan.clone(),
            None => Arc::new(ReleasePlan::from_input(&build.input)?),
        };
        Self::restore_with_plan(build, check_input, &plan).map(|(capture, _)| capture)
    }

    /// The caller has checked the plan against the original build input.
    pub(crate) fn restore_with_plan(
        build: ResultValidationCapture,
        check_input: FixedInput,
        plan: &ReleasePlan,
    ) -> Result<(Self, sdk::ArtifactSet), ExecutionError> {
        let item = check_input.envelope().items.first().ok_or_else(invalid)?;
        let (envelope, checks, output) = Self::reconstruct(&build, plan, Some(&item.payload))?;
        validation::restore_check_header(envelope, &check_input)?;
        Ok((Self { build, check_input, checks }, output))
    }
    /// Coverage can be complete and still have blocking findings. The ledger
    /// records valid/invalid against these exact producer and checker results.
    pub fn prepare(
        self,
        check_result: FixedResult,
    ) -> Result<PreparedArtifactValidation, ExecutionError> {
        check_result.validate_for_input(&self.check_input)?;
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
