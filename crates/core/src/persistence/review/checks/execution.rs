//! Each checker uses the original runtime, its own grant and immutable ledger.
use super::*;
use crate::execution::{
    FixedInput, FixedResult, InputEnvelope, InputItem, MAX_RESULT_BYTES, REVIEW_CHECK_OPERATION,
    Scope, restore_check_input,
};
use tsumugi_plugin_sdk as sdk;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckOrigin {
    pub checker: ReviewCheckerKey,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewInvocationOutcome {
    Succeeded,
    Failed,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewCheckOriginEvidence {
    pub checker: ReviewCheckerKey,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub result_id: ExecutionId,
    pub result_digest: String,
    pub outcome: ReviewInvocationOutcome,
}
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
    source_binding: &'a crate::content::SourceReviewBinding,
    advisory_checks: &'a [AdvisoryReviewCheck],
    checker_key: &'a ReviewCheckerKey,
}
fn invalid(stage: &str) -> ExecutionError {
    failure(ErrorCode::ResultMismatch, stage)
}

pub(super) fn execution_inputs(capture: &Capture) -> Result<Vec<FixedInput>, ExecutionError> {
    let Some(plan) = &capture.plan else {
        return Ok(Vec::new());
    };
    let project = capture
        .project_id
        .to_string()
        .parse::<crate::ProjectId>()
        .map_err(|_| invalid("review-check-project"))?;
    plan.checkers()
        .iter()
        .map(|checker| {
            let binding = &checker.binding;
            let item = InputItem::new(
                Scope {
                    kind: "review-check".into(),
                    id: capture.target.unit_id.to_string(),
                    locale: Some(capture.target.locale.clone()),
                },
                plan.checker_payload(&checker.key)?,
                vec![],
            );
            let mut envelope = InputEnvelope::new(
                project,
                REVIEW_CHECK_OPERATION,
                &binding.capability.declaration.contract.id,
                &binding.capability_version(),
                vec![item],
            )?;
            // Independent executions are siblings in one QA action, not retries or
            // delegated tasks. Their original generated identities stay captured.
            envelope.settings = serde_json::to_value(ExecutionBasis {
                version: 2,
                action_id: capture.action_id,
                request_digest: &capture.request_digest,
                unit_id: capture.target.unit_id,
                review_basis: plan.review_basis(),
                qa_basis: plan.basis(),
                required_checks: plan.fixed_checks().set(),
                source_binding: plan.binding(),
                advisory_checks: plan.advisory_checks(),
                checker_key: &checker.key,
            })
            .map_err(|_| invalid("review-check-basis"))?;
            envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
            envelope.limits.timeout_ms = envelope
                .limits
                .timeout_ms
                .min(binding.capability.declaration.limits.timeout_ms);
            envelope.plugin = Some(binding.clone());
            FixedInput::capture(envelope)
        })
        .collect()
}
impl PreparedReviewCheck {
    pub fn execution_inputs(&self) -> &[FixedInput] {
        match &self.state {
            PreparedState::Pending(capture) => &capture.inputs,
            PreparedState::Recorded { .. } => &[],
        }
    }
    /// Compare semantic capture while normalizing only generated identities.
    /// The QA action and typed slot live in exact settings, not the task ID.
    pub fn validate_execution_input(&self, input: &FixedInput) -> Result<(), ExecutionError> {
        let key = &input.envelope().settings["checkerKey"];
        let expected = self
            .execution_inputs()
            .iter()
            .find(|i| &i.envelope().settings["checkerKey"] == key)
            .ok_or_else(|| invalid("review-checker"))?;
        restore_check_input(expected, input)
    }
}
#[derive(Debug)]
pub(super) struct ComputedOrigin {
    pub key: ReviewCheckerKey,
    pub input: FixedInput,
    pub result: FixedResult,
    pub outcome: ReviewInvocationOutcome,
}
#[derive(Debug)]
pub struct CapturedReviewCheckExecution {
    capture: Capture,
    origins: Vec<(ReviewCheckerKey, FixedInput, FixedResult)>,
}
#[derive(Debug)]
pub struct ComputedReviewEvidence {
    pub(super) project_id: ExecutionId,
    pub(super) action_id: ExecutionId,
    pub(super) request_digest: String,
    pub(super) plan: ReviewCheckPlan,
    pub(super) origins: Vec<ComputedOrigin>,
    pub(super) core_rules: Vec<CheckRuleResult>,
    pub(super) results: Vec<sdk::CheckResult>,
    pub(super) diagnostics: Vec<sdk::TextReviewDiagnostic>,
    coverage: sdk::CheckCoverage,
    pub(super) expected_check_id: Option<ExecutionId>,
}

/// Receive an actual successful/failed/unknown invocation without converting
/// a transport failure to a check result or accepting producer Core claims.
pub(super) fn receive_checker(
    source_binding: &crate::content::SourceReviewBinding,
    advisory_checks: &[AdvisoryReviewCheck],
    key: &ReviewCheckerKey,
    input: &FixedInput,
    result: &FixedResult,
) -> Result<
    (
        ReviewInvocationOutcome,
        Vec<sdk::CheckResult>,
        Vec<sdk::TextReviewDiagnostic>,
    ),
    ExecutionError,
> {
    let format = ReviewChecker::format(source_binding);
    let choice = advisory_checks.iter().find(|c| &c.checker().key == key);
    let kind = if &format.key == key {
        ReviewCheckerKind::Format
    } else if choice.is_some() {
        ReviewCheckerKind::AdvisoryText
    } else {
        return Err(invalid("review-checker"));
    };
    let origin = result
        .envelope()
        .plugin
        .as_ref()
        .ok_or_else(|| invalid("review-check-channel"))?;
    if origin.channel.selection() != key.provider {
        return Err(invalid("review-check-provider"));
    }
    match &origin.result.outcome {
        sdk::InvocationOutcome::Succeeded { output } => {
            let (results, diagnostics) = match kind {
                ReviewCheckerKind::Format => {
                    if output.schema != sdk::check_results_contract() {
                        return Err(invalid("review-check-schema"));
                    }
                    let captured: sdk::ReviewCheckInput =
                        serde_json::from_value(input.envelope().items[0].payload.clone())
                            .map_err(|_| invalid("review-check-input"))?;
                    sdk::ReviewBinding {
                        declaration: source_binding.declaration.clone(),
                        checker: source_binding.checker.capability.clone(),
                    }
                    .validate_input(&captured)
                    .map_err(|_| invalid("review-check-input"))?;
                    let results = sdk::parse_check_results(output.utf8.as_bytes())
                        .map_err(|_| invalid("review-check-results"))?;
                    if results.iter().any(|r| {
                        !captured
                            .requirements
                            .iter()
                            .any(|required| required.key == r.key)
                    }) {
                        return Err(invalid("review-check-slot"));
                    }
                    if results.iter().any(|r| !matches!(&r.key.implementation, sdk::CheckImplementation::Plugin { provider } if provider == &key.provider)) { return Err(invalid("review-check-provider")); }
                    (results, Vec::new())
                }
                ReviewCheckerKind::AdvisoryText => {
                    if output.schema != sdk::text_review_report_contract() {
                        return Err(invalid("review-check-schema"));
                    }
                    let choice = choice.ok_or_else(|| invalid("review-checker"))?;
                    let captured: sdk::TextReviewCheckInput =
                        serde_json::from_value(input.envelope().items[0].payload.clone())
                            .map_err(|_| invalid("review-check-input"))?;
                    let report = sdk::parse_text_review_report(output.utf8.as_bytes())
                        .map_err(|_| invalid("review-check-report"))?;
                    choice
                        .binding
                        .validate_report(&captured, &report)
                        .map_err(|_| invalid("review-check-report"))?;
                    (report.results, report.diagnostics)
                }
            };
            Ok((ReviewInvocationOutcome::Succeeded, results, diagnostics))
        }
        sdk::InvocationOutcome::Failed { error } | sdk::InvocationOutcome::Unknown { error } => {
            if error.schema != sdk::review_check_error_contract() {
                return Err(invalid("review-check-error"));
            }
            sdk::parse_review_check_error(error.utf8.as_bytes())
                .map_err(|_| invalid("review-check-error"))?;
            Ok((
                if matches!(origin.result.outcome, sdk::InvocationOutcome::Failed { .. }) {
                    ReviewInvocationOutcome::Failed
                } else {
                    ReviewInvocationOutcome::Unknown
                },
                Vec::new(),
                Vec::new(),
            ))
        }
    }
}
impl CapturedReviewCheckExecution {
    pub fn compute(
        mut self,
        cancellation: &Cancellation,
    ) -> Result<ComputedReviewEvidence, ExecutionError> {
        let plan = self
            .capture
            .plan
            .take()
            .ok_or_else(|| invalid("review-checker-required"))?;
        let (mut results, mut core_rules) = plan.compute_core_evidence(cancellation)?;
        let mut origins = Vec::new();
        let mut diagnostics = Vec::new();
        for (key, input, result) in self.origins {
            let (outcome, domain, rich) = receive_checker(
                plan.binding(),
                plan.advisory_checks(),
                &key,
                &input,
                &result,
            )?;
            results.extend(domain);
            diagnostics.extend(rich);
            origins.push(ComputedOrigin {
                key,
                input,
                result,
                outcome,
            });
        }
        if cancellation.is_requested() {
            for check in results
                .iter_mut()
                .filter(|r| matches!(r.key.implementation, sdk::CheckImplementation::Core { .. }))
            {
                check.outcome = sdk::CheckOutcome::Cancelled;
            }
            for rule in &mut core_rules {
                rule.status = "cancelled".into();
                rule.reason = Some("Cancelled before completion".into());
                rule.findings.clear();
            }
        }
        let coverage = plan
            .fixed_checks()
            .evaluate(&results)
            .map_err(|_| invalid("review-check-coverage"))?;
        Ok(ComputedReviewEvidence {
            project_id: self.capture.project_id,
            action_id: self.capture.action_id,
            request_digest: self.capture.request_digest,
            plan,
            origins,
            core_rules,
            results,
            diagnostics,
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
    pub fn core_rules(&self) -> &[CheckRuleResult] {
        &self.core_rules
    }
    pub fn results(&self) -> &[sdk::CheckResult] {
        &self.results
    }
    pub fn checker_input(&self, key: &ReviewCheckerKey) -> Option<&FixedInput> {
        self.origins
            .iter()
            .find(|origin| &origin.key == key)
            .map(|origin| &origin.input)
    }
    pub fn checker_result(&self, key: &ReviewCheckerKey) -> Option<&FixedResult> {
        self.origins
            .iter()
            .find(|origin| &origin.key == key)
            .map(|origin| &origin.result)
    }
    pub fn diagnostics(&self) -> &[sdk::TextReviewDiagnostic] {
        &self.diagnostics
    }
    pub fn coverage(&self) -> &sdk::CheckCoverage {
        &self.coverage
    }
}
impl ProjectStore {
    pub fn capture_review_check_execution(
        &self,
        prepared: PreparedReviewCheck,
        origins: &[ReviewCheckOrigin],
    ) -> Result<CapturedReviewCheckExecution, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        let plan = prepared
            .plan()
            .ok_or_else(|| invalid("review-already-recorded"))?;
        if origins.len() != plan.checkers().len()
            || origins
                .iter()
                .map(|o| &o.checker)
                .collect::<BTreeSet<_>>()
                .len()
                != origins.len()
            || origins
                .iter()
                .map(|o| (o.attempt_id, o.result_id))
                .collect::<BTreeSet<_>>()
                .len()
                != origins.len()
        {
            return Err(invalid("review-check-origins"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?;
        let captures = queries::read_snapshot(connection, |c| {
            origins
                .iter()
                .map(|o| {
                    if !plan
                        .checkers()
                        .iter()
                        .any(|checker| checker.key == o.checker)
                    {
                        return Err(invalid("review-checker"));
                    }
                    let original = super::super::super::ledger::capture_current_review_result_in(
                        c,
                        &self.plugin_authority,
                        o.attempt_id,
                        o.result_id,
                    )?;
                    prepared.validate_execution_input(&original.input)?;
                    if original.input.envelope().settings["checkerKey"]
                        != serde_json::to_value(&o.checker)
                            .map_err(|_| invalid("review-checker"))?
                    {
                        return Err(invalid("review-checker"));
                    }
                    Ok((o.checker.clone(), original.input, original.result))
                })
                .collect::<Result<Vec<_>, ExecutionError>>()
        })?;
        let PreparedState::Pending(capture) = prepared.state else {
            return Err(invalid("review-already-recorded"));
        };
        Ok(CapturedReviewCheckExecution {
            capture,
            origins: captures,
        })
    }
}
