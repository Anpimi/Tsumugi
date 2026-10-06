//! Domain computation uses the original runtime, grants and immutable ledger.
//! These owned values establish evidence, never current QA or qualification.
use super::*;
use crate::execution::{
    FixedInput, FixedResult, InputEnvelope, InputItem, MAX_RESULT_BYTES, REVIEW_CHECK_OPERATION,
    ResultValidationCapture, Scope, restore_check_input,
};
use tsumugi_plugin_sdk as sdk;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutionBasis<'a> {
    version: u32,
    action_id: ExecutionId,
    request_digest: &'a str,
    unit_id: ExecutionId,
    review_basis: &'a str,
    qa_basis: &'a str,
    required_checks: &'a sdk::RequiredCheckSet,
}

fn invalid(stage: &str) -> ExecutionError {
    failure(ErrorCode::ResultMismatch, stage)
}

impl PreparedReviewCheck {
    /// Creates the single-item domain projection. Submission still requires a
    /// matching current grant and the independently installed checker/runtime.
    pub fn domain_execution_input(
        &self,
        attempt: ExecutionId,
    ) -> Result<FixedInput, ExecutionError> {
        let PreparedState::Pending(capture) = &self.state else {
            return Err(invalid("review-already-recorded"));
        };
        let plan = capture
            .plan
            .as_ref()
            .ok_or_else(|| invalid("review-checker-required"))?;
        let binding = &plan.binding().checker;
        let project = capture
            .project_id
            .to_string()
            .parse::<crate::ProjectId>()
            .map_err(|_| invalid("review-check-project"))?;
        let item = InputItem::new(
            Scope {
                kind: "review-check".into(),
                id: capture.target.unit_id.to_string(),
                locale: Some(capture.target.locale.clone()),
            },
            serde_json::to_value(plan.domain_input()).map_err(|_| invalid("review-check-input"))?,
            vec![],
        );
        let mut envelope = InputEnvelope::new(
            project,
            REVIEW_CHECK_OPERATION,
            &binding.capability.declaration.contract.id,
            &binding.capability_version(),
            vec![item],
        )?;
        envelope.task_id = capture.action_id;
        envelope.attempt_id = attempt;
        envelope.settings = serde_json::to_value(ExecutionBasis {
            version: 1,
            action_id: capture.action_id,
            request_digest: &capture.request_digest,
            unit_id: capture.target.unit_id,
            review_basis: plan.review_basis(),
            qa_basis: plan.basis(),
            required_checks: plan.fixed_checks().set(),
        })
        .map_err(|_| invalid("review-check-basis"))?;
        envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
        envelope.limits.timeout_ms = envelope
            .limits
            .timeout_ms
            .min(binding.capability.declaration.limits.timeout_ms);
        envelope.plugin = Some(binding.clone());
        FixedInput::capture(envelope)
    }
}

/// Store-owned actual domain result, retaining the action and original plan.
/// Construction reads one consistent snapshot and grants no business mutation.
#[derive(Debug)]
pub struct CapturedReviewCheckExecution {
    capture: Capture,
    input: FixedInput,
    result: FixedResult,
}

/// The complete captured Core/domain union and original channel evidence.
/// Completeness means coverage, including findings; it does not mean approval,
/// waiver eligibility, a current durable check, or release qualification.
#[derive(Debug)]
pub struct ComputedReviewEvidence {
    pub(super) project_id: ExecutionId,
    pub(super) action_id: ExecutionId,
    pub(super) request_digest: String,
    pub(super) plan: ReviewCheckPlan,
    pub(super) input: FixedInput,
    pub(super) result: FixedResult,
    pub(super) core_rules: Vec<CheckRuleResult>,
    pub(super) results: Vec<sdk::CheckResult>,
    coverage: sdk::CheckCoverage,
    pub(super) expected_check_id: Option<ExecutionId>,
}

impl CapturedReviewCheckExecution {
    /// Strict receiving and Core computation run without a store/transaction.
    /// The producer cannot assert Core coverage or another provider's results.
    pub fn compute(
        mut self,
        cancellation: &Cancellation,
    ) -> Result<ComputedReviewEvidence, ExecutionError> {
        let plan = self
            .capture
            .plan
            .take()
            .ok_or_else(|| invalid("review-checker-required"))?;
        let evidence = self
            .result
            .envelope()
            .plugin
            .as_ref()
            .ok_or_else(|| invalid("review-check-channel"))?;
        let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
            return Err(invalid("review-check-outcome"));
        };
        if output.schema != sdk::check_results_contract() {
            return Err(invalid("review-check-schema"));
        }
        let domain = sdk::parse_check_results(output.utf8.as_bytes())
            .map_err(|_| invalid("review-check-results"))?;
        if domain.iter().any(|check| match &check.key.implementation {
            sdk::CheckImplementation::Plugin { provider } => {
                *provider != evidence.channel.selection()
            }
            sdk::CheckImplementation::Core { .. } => true,
        }) {
            return Err(invalid("review-check-provider"));
        }
        let (mut results, mut core_rules) = plan.compute_core_evidence(cancellation)?;
        // Retain the actual domain evidence if cancellation arrives while Core
        // computes. Core cancellation prevents complete coverage; adoption must
        // independently recheck cancellation and authority at its boundary.
        if cancellation.is_requested() {
            for check in &mut results {
                check.outcome = sdk::CheckOutcome::Cancelled;
            }
            for rule in &mut core_rules {
                rule.status = "cancelled".into();
                rule.reason = Some("Cancelled before completion".into());
                rule.findings.clear();
            }
        }
        results.extend(domain);
        let coverage = plan
            .fixed_checks()
            .evaluate(&results)
            .map_err(|_| invalid("review-check-coverage"))?;
        Ok(ComputedReviewEvidence {
            project_id: self.capture.project_id,
            action_id: self.capture.action_id,
            request_digest: self.capture.request_digest,
            plan,
            input: self.input,
            result: self.result,
            core_rules,
            results,
            coverage,
            expected_check_id: self.capture.target.current_check.as_ref().map(|r| r.run_id),
        })
    }
}

impl ComputedReviewEvidence {
    pub fn project_id(&self) -> ExecutionId {
        self.project_id
    }
    pub fn action_id(&self) -> ExecutionId {
        self.action_id
    }
    pub fn request_digest(&self) -> &str {
        &self.request_digest
    }
    pub fn plan(&self) -> &ReviewCheckPlan {
        &self.plan
    }
    pub fn domain_input(&self) -> &FixedInput {
        &self.input
    }
    pub fn domain_result(&self) -> &FixedResult {
        &self.result
    }
    pub fn core_rules(&self) -> &[CheckRuleResult] {
        &self.core_rules
    }
    pub fn results(&self) -> &[sdk::CheckResult] {
        &self.results
    }
    pub fn coverage(&self) -> &sdk::CheckCoverage {
        &self.coverage
    }
}

impl ProjectStore {
    /// Reads the actual live current result through the ledger owner, then
    /// associates every non-generated input value with this store-owned plan.
    /// Worker/receiving computation and current-QA adoption remain separate.
    pub fn capture_review_check_execution(
        &self,
        prepared: PreparedReviewCheck,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<CapturedReviewCheckExecution, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let expected = prepared.domain_execution_input(attempt)?;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?;
        if !connection.is_autocommit() {
            return Err(failure(ErrorCode::DependencyConflict, "review-transaction"));
        }
        let ResultValidationCapture { input, result } =
            queries::read_snapshot(connection, |connection| {
                super::super::super::ledger::capture_current_plugin_result_in(
                    connection,
                    &self.plugin_authority,
                    attempt,
                    result,
                )
            })?;
        if input.envelope().task_id != expected.envelope().task_id {
            return Err(invalid("review-check-action"));
        }
        restore_check_input(&expected, &input)?;
        let PreparedState::Pending(capture) = prepared.state else {
            return Err(invalid("review-already-recorded"));
        };
        Ok(CapturedReviewCheckExecution {
            capture,
            input,
            result,
        })
    }
}
