//! Small projections of already validated, current QA evidence.
use super::super::{CheckRuleResult, CheckRun, ReviewCheckOutcome};
use super::coverage_complete;
use crate::execution::{ErrorCode, ExecutionError};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentQaCounts {
    pub passed: u32,
    pub findings: u32,
    pub missing: u32,
    pub unavailable: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub unknown: u32,
    pub not_applicable: u32,
    pub finding_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SegmentQaSummary {
    pub current: bool,
    pub outcome: Option<ReviewCheckOutcome>,
    pub mandatory_coverage_complete: Option<bool>,
    pub mandatory: SegmentQaCounts,
    pub advisory: SegmentQaCounts,
}

fn invalid_summary() -> ExecutionError {
    ExecutionError::new(ErrorCode::CorruptLedger, "review-check-summary")
}

impl SegmentQaCounts {
    fn add_rule(&mut self, rule: &CheckRuleResult) -> Result<(), ExecutionError> {
        let count = match rule.status.as_str() {
            "passed" => &mut self.passed,
            "findings" => &mut self.findings,
            "missing" => &mut self.missing,
            "unavailable" => &mut self.unavailable,
            "failed" => &mut self.failed,
            "cancelled" => &mut self.cancelled,
            "unknown" => &mut self.unknown,
            "not-applicable" => &mut self.not_applicable,
            _ => return Err(invalid_summary()),
        };
        *count = count.checked_add(1).ok_or_else(invalid_summary)?;
        self.finding_count = self
            .finding_count
            .checked_add(u32::try_from(rule.findings.len()).map_err(|_| invalid_summary())?)
            .ok_or_else(invalid_summary)?;
        Ok(())
    }
}

/// Callers supply the current run from the original evidence and material reader.
/// Coverage and raw findings remain independent of approval, waivers and fallback.
pub(in crate::persistence::review) fn segment_check_summary(
    run: Option<&CheckRun>,
) -> Result<SegmentQaSummary, ExecutionError> {
    let mut summary = SegmentQaSummary {
        current: run.is_some(),
        outcome: run.map(|run| run.outcome),
        mandatory_coverage_complete: run.map(coverage_complete),
        mandatory: SegmentQaCounts::default(),
        advisory: SegmentQaCounts::default(),
    };
    if let Some(run) = run {
        for rule in &run.rules {
            let counts = if rule.mandatory {
                &mut summary.mandatory
            } else {
                &mut summary.advisory
            };
            counts.add_rule(rule)?;
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CheckFinding, ReviewBasis, execution::ExecutionId};

    fn rule(name: &str, status: &str, mandatory: bool, finding_count: usize) -> CheckRuleResult {
        CheckRuleResult {
            rule: name.into(),
            key: crate::review::core_check_key(name),
            mandatory,
            status: status.into(),
            reason: None,
            findings: (0..finding_count)
                .map(|index| CheckFinding {
                    issue_id: format!("issue-{index}"),
                    rule: name.into(),
                    code: "synthetic".into(),
                    detail: "Synthetic finding".into(),
                    severity: "warning".into(),
                    waivable: true,
                })
                .collect(),
        }
    }

    fn run(rules: Vec<CheckRuleResult>) -> CheckRun {
        let source_snapshot_id = ExecutionId::new();
        let source_revision_id = ExecutionId::new();
        CheckRun {
            run_id: ExecutionId::new(),
            action_id: ExecutionId::new(),
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
            basis: "synthetic-basis".into(),
            basis_evidence: ReviewBasis {
                source_snapshot_id,
                source_revision_id,
                selection_id: None,
                revision_id: None,
                context_revision_id: None,
                term_revision_ids: Vec::new(),
            },
            validator_version: crate::review::CHECK_VERSION.into(),
            outcome: ReviewCheckOutcome::Unknown,
            rules,
            evidence: None,
            created_at: "2026-10-27T00:00:00Z".into(),
        }
    }

    #[test]
    fn absent_current_evidence_has_no_outcome_or_coverage() {
        let summary = segment_check_summary(None).unwrap();
        assert!(!summary.current);
        assert_eq!(summary.outcome, None);
        assert_eq!(summary.mandatory_coverage_complete, None);
        assert_eq!(summary.mandatory, SegmentQaCounts::default());
        assert_eq!(summary.advisory, SegmentQaCounts::default());
    }

    #[test]
    fn status_counts_keep_mandatory_and_advisory_findings_separate() {
        let statuses = [
            "passed", "findings", "missing", "unavailable", "failed", "cancelled", "unknown",
            "not-applicable",
        ];
        let rules = [true, false]
            .into_iter()
            .flat_map(|mandatory| {
                statuses.into_iter().map(move |status| {
                    rule(
                        "synthetic",
                        status,
                        mandatory,
                        usize::from(status == "findings") * 2,
                    )
                })
            })
            .collect();
        let run = run(rules);
        let summary = segment_check_summary(Some(&run)).unwrap();
        let expected = SegmentQaCounts {
            passed: 1,
            findings: 1,
            missing: 1,
            unavailable: 1,
            failed: 1,
            cancelled: 1,
            unknown: 1,
            not_applicable: 1,
            finding_count: 2,
        };
        assert!(summary.current);
        assert_eq!(summary.outcome, Some(ReviewCheckOutcome::Unknown));
        assert_eq!(summary.mandatory_coverage_complete, Some(false));
        assert_eq!(summary.mandatory, expected);
        assert_eq!(summary.advisory, expected);
    }

    #[test]
    fn complete_coverage_does_not_erase_findings() {
        let rules = ["required-translation", "placeholders", "format", "terminology"]
            .into_iter()
            .enumerate()
            .map(|(index, name)| {
                rule(
                    name,
                    if index == 0 { "findings" } else { "passed" },
                    true,
                    usize::from(index == 0),
                )
            })
            .collect();
        let mut run = run(rules);
        run.outcome = ReviewCheckOutcome::Completed;
        let summary = segment_check_summary(Some(&run)).unwrap();
        assert_eq!(summary.mandatory_coverage_complete, Some(true));
        assert_eq!(summary.mandatory.findings, 1);
        assert_eq!(summary.mandatory.finding_count, 1);
        assert_eq!(summary.mandatory.passed, 3);
    }

    #[test]
    fn unknown_status_is_not_silently_counted_as_success() {
        let run = run(vec![rule("synthetic", "unsupported", true, 0)]);
        let error = segment_check_summary(Some(&run)).unwrap_err();
        assert_eq!(error.code, ErrorCode::CorruptLedger);
        assert_eq!(error.stage, "review-check-summary");
    }
}
