//! Human disposition of advisory evidence. This never changes QA coverage,
//! mechanical waivers, approvals, or build eligibility.
use super::*;
use tsumugi_plugin_sdk as sdk;
use crate::ai::semantic_review::{AiSemanticReviewEvidence, AiSemanticReviewRun, ReviewRunPurpose};

pub(super) const TABLE: (&str, &str) = (
    "review_finding_decisions",
    "CREATE TABLE review_finding_decisions (
        decision_id TEXT PRIMARY KEY NOT NULL,
        action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id),
        locale TEXT NOT NULL,
        basis TEXT NOT NULL CHECK(length(basis)=64),
        run_id TEXT NOT NULL REFERENCES review_checks(run_id),
        issue_id TEXT NOT NULL CHECK(length(issue_id)=64),
        previous_decision_id TEXT REFERENCES review_finding_decisions(decision_id),
        request_json TEXT NOT NULL,
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
);
const INDEX: &str = "CREATE INDEX review_finding_scope ON review_finding_decisions (project_id,unit_id,locale,basis,issue_id)";
const HISTORY_INDEX: &str =
    "CREATE INDEX review_finding_history ON review_finding_decisions (project_id,unit_id,locale)";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewFindingDisposition {
    Rejected,
    Restored,
    RepairRequested,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewFindingWrite {
    pub project_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub expected_basis: String,
    pub run_id: ExecutionId,
    pub issue_id: String,
    pub expected_decision_id: Option<ExecutionId>,
    pub disposition: ReviewFindingDisposition,
    pub actor: String,
    pub reason: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewFindingDecision {
    pub purpose: ReviewRunPurpose,
    pub ai_origin: Option<AiSemanticReviewEvidence>,
    pub decision_id: ExecutionId,
    pub request: ReviewFindingWrite,
    pub basis_evidence: ReviewBasis,
    pub requirement: sdk::CheckRequirement,
    pub finding: CheckFinding,
    pub created_at: String,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct AdvisoryFinding {
    pub run_id: ExecutionId,
    pub purpose: ReviewRunPurpose,
    pub ai_origin: Option<AiSemanticReviewEvidence>,
    pub requirement: sdk::CheckRequirement,
    pub finding: CheckFinding,
    pub decision: Option<ReviewFindingDecision>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewRepairStatus {
    AwaitingCurrentRecheck,
    CurrentRuleClear,
    CurrentRuleFindings,
    Superseded,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewFindingRepair {
    pub decision: ReviewFindingDecision,
    pub status: ReviewRepairStatus,
    pub recheck_run_id: Option<ExecutionId>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReviewFindingView {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub basis: String,
    pub run_id: Option<ExecutionId>,
    pub semantic_run_id: Option<ExecutionId>,
    pub findings: Vec<AdvisoryFinding>,
    pub repairs: Vec<ReviewFindingRepair>,
    pub history: Vec<ReviewFindingDecision>,
    pub next_offset: Option<u32>,
}

pub(super) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(INDEX)?;
    c.execute_batch(HISTORY_INDEX)
}
fn corrupt() -> ExecutionError {
    failure(ErrorCode::CorruptLedger, "review-finding-evidence")
}
fn validate_request(r: &ReviewFindingWrite) -> Result<(), ExecutionError> {
    checked_actor(&r.actor)?;
    checked_note(&r.reason, true)?;
    if r.expected_basis.len() != 64
        || r.issue_id.len() != 64
        || !r
            .expected_basis
            .bytes()
            .chain(r.issue_id.bytes())
            .all(|b| b.is_ascii_hexdigit())
        || crate::Locale::parse(&r.locale)
            .ok()
            .as_ref()
            .map(crate::Locale::as_str)
            != Some(r.locale.as_str())
    {
        return Err(failure(ErrorCode::InvalidInput, "review-finding-input"));
    }
    Ok(())
}

/// Called only with a validated saved run. Both the fixed requirement and its
/// matching result authorize disposition; a plugin name or UI flag cannot.
fn advisory_requirement<'a>(
    run: &'a CheckRun,
    rule: &CheckRuleResult,
) -> Option<&'a sdk::CheckRequirement> {
    if rule.mandatory {
        return None;
    }
    let evidence = run.evidence.as_ref()?;
    let requirement =
        evidence.required_checks.requirements.iter().find(|r| {
            r.key == rule.key && !r.mandatory && !r.waivable && r.not_applicable.is_none()
        })?;
    let result = evidence.results.iter().find(|r| {
        r.key == requirement.key
            && r.input_digest == requirement.input_digest
            && r.scope_digest == requirement.scope_digest
    })?;
    matches!(result.outcome, sdk::CheckOutcome::Completed { .. }).then_some(requirement)
}
struct FindingRun {
    run_id: ExecutionId,
    unit_id: ExecutionId,
    locale: String,
    basis: String,
    basis_evidence: ReviewBasis,
    purpose: ReviewRunPurpose,
    ai_origin: Option<AiSemanticReviewEvidence>,
    entries: Vec<(sdk::CheckRequirement, CheckFinding)>,
}
fn qa_run(run: &CheckRun) -> FindingRun {
    let entries = run.rules.iter().filter_map(|rule| advisory_requirement(run, rule).map(|r| (r,rule)))
        .flat_map(|(requirement,rule)| rule.findings.iter().map(move |finding| (requirement.clone(),finding.clone()))).collect();
    FindingRun { run_id:run.run_id,unit_id:run.unit_id,locale:run.locale.clone(),basis:run.basis.clone(),
        basis_evidence:run.basis_evidence.clone(),purpose:ReviewRunPurpose::Qa,ai_origin:None,entries }
}
fn semantic_run(run: AiSemanticReviewRun) -> FindingRun {
    let entries = run.rules.iter().flat_map(|rule| {
        let requirement = sdk::CheckRequirement { key:rule.key.clone(), input_digest:run.evidence.semantic_input_digest.clone(),
            scope_digest:run.evidence.scope_digest.clone(),targets:vec![run.unit_id.to_string()],mandatory:false,waivable:false,not_applicable:None };
        rule.findings.iter().map(move |finding| (requirement.clone(),finding.clone()))
    }).collect();
    FindingRun { run_id:run.run_id,unit_id:run.unit_id,locale:run.locale,basis:run.basis,basis_evidence:run.basis_evidence,
        purpose:ReviewRunPurpose::AiSemantic,ai_origin:Some(run.evidence),entries }
}
fn advisory<'a>(
    run: &'a FindingRun,
    issue: &str,
) -> Option<(&'a sdk::CheckRequirement, &'a CheckFinding)> {
    run.entries.iter().find(|(_,finding)| finding.issue_id==issue).map(|(r,f)|(r,f))
}
fn run_in(
    c: &Connection,
    project: ExecutionId,
    run: ExecutionId,
) -> Result<FindingRun, ExecutionError> {
    let (action,purpose): (String,String) = c
        .query_row(
            "SELECT action_id,purpose FROM review_checks WHERE project_id=?1 AND run_id=?2",
            params![project.to_string(), run.to_string()],
            |r| Ok((r.get(0)?,r.get(1)?)),
        )
        .optional()
        .map_err(sql)?
        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-finding-run"))?;
    match purpose.as_str() {
        "qa" => check_by_action(c,project,parse_id(action)?)?.map(|v|qa_run(&v.0)).ok_or_else(corrupt),
        "ai-semantic" => super::super::ai_semantic_review::by_action(c,project,parse_id(action)?)?.map(semantic_run).ok_or_else(corrupt),
        _ => Err(corrupt()),
    }
}
fn load(
    c: &Connection,
    action: ExecutionId,
) -> Result<Option<ReviewFindingDecision>, ExecutionError> {
    let raw = c.query_row("SELECT decision_id,project_id,unit_id,locale,run_id,issue_id,previous_decision_id,request_json,request_digest,created_at,basis FROM review_finding_decisions WHERE action_id=?1",
        [action.to_string()], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,Option<String>>(6)?,r.get::<_,String>(7)?,r.get::<_,String>(8)?,r.get::<_,String>(9)?,r.get::<_,String>(10)?))).optional().map_err(sql)?;
    let Some((
        id,
        project,
        unit,
        locale,
        run,
        issue,
        previous,
        json,
        saved_digest,
        created_at,
        basis,
    )) = raw
    else {
        return Ok(None);
    };
    let request: ReviewFindingWrite = serde_json::from_str(&json).map_err(|_| corrupt())?;
    validate_request(&request).map_err(|_| corrupt())?;
    if request.action_id != action
        || request.project_id.to_string() != project
        || request.unit_id.to_string() != unit
        || request.locale != locale
        || request.expected_basis != basis
        || request.run_id.to_string() != run
        || request.issue_id != issue
        || request.expected_decision_id.map(|id| id.to_string()) != previous
        || digest(&request)? != saved_digest
    {
        return Err(corrupt());
    }
    let run = run_in(c, request.project_id, request.run_id)?;
    let (requirement, finding) = advisory(&run, &request.issue_id).ok_or_else(corrupt)?;
    if run.unit_id != request.unit_id
        || run.locale != request.locale
        || run.basis != request.expected_basis
    {
        return Err(corrupt());
    }
    Ok(Some(ReviewFindingDecision {
        purpose: run.purpose,
        ai_origin: run.ai_origin.clone(),
        decision_id: parse_id(id)?,
        basis_evidence: run.basis_evidence.clone(),
        requirement: requirement.clone(),
        finding: finding.clone(),
        request,
        created_at,
    }))
}
fn latest(
    c: &Connection,
    project: ExecutionId,
    unit: ExecutionId,
    locale: &str,
    basis: &str,
    issue: &str,
) -> Result<Option<ReviewFindingDecision>, ExecutionError> {
    let action: Option<String> = c.query_row("SELECT action_id FROM review_finding_decisions WHERE project_id=?1 AND unit_id=?2 AND locale=?3 AND basis=?4 AND issue_id=?5 ORDER BY rowid DESC LIMIT 1",
        params![project.to_string(),unit.to_string(),locale,basis,issue], |row|row.get(0)).optional().map_err(sql)?;
    action
        .map(|a| load(c, parse_id(a)?).and_then(|v| v.ok_or_else(corrupt)))
        .transpose()
}
fn transition(previous: Option<ReviewFindingDisposition>, next: ReviewFindingDisposition) -> bool {
    use ReviewFindingDisposition::*;
    match next {
        Restored => previous == Some(Rejected),
        Rejected => previous != Some(Rejected),
        RepairRequested => previous != Some(Rejected) && previous != Some(RepairRequested),
    }
}
pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in [
        ("review_finding_scope", INDEX),
        ("review_finding_history", HISTORY_INDEX),
    ] {
        let actual: String = c
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if actual != expected {
            return Err(corrupt());
        }
    }
    let mut statement = c
        .prepare("SELECT action_id FROM review_finding_decisions ORDER BY rowid")
        .map_err(sql)?;
    let mut chains = BTreeMap::new();
    for action in statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql)?
    {
        let decision = load(c, parse_id(action.map_err(sql)?)?)?.ok_or_else(corrupt)?;
        let r = &decision.request;
        let key = (
            r.project_id,
            r.unit_id,
            r.locale.clone(),
            r.expected_basis.clone(),
            r.issue_id.clone(),
        );
        let previous = chains.get(&key).copied();
        if previous.map(|(id, _)| id) != r.expected_decision_id
            || !transition(previous.map(|(_, d)| d), r.disposition)
        {
            return Err(corrupt());
        }
        chains.insert(key, (decision.decision_id, r.disposition));
    }
    Ok(())
}

impl ProjectStore {
    pub fn review_finding_action(
        &self,
        project: ExecutionId,
        action: ExecutionId,
    ) -> Result<Option<ReviewFindingDecision>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        if super::super::read_metadata_from(c)
            .map_err(|_| corrupt())?
            .project_id()
            .to_string()
            != project.to_string()
        {
            return Err(failure(ErrorCode::Unauthorized, "review-project"));
        }
        let value = load(c, action)?;
        if value
            .as_ref()
            .is_some_and(|v| v.request.project_id != project)
        {
            return Err(failure(ErrorCode::Unauthorized, "review-project"));
        }
        Ok(value)
    }
    pub fn write_review_finding(
        &mut self,
        r: &ReviewFindingWrite,
    ) -> Result<ReviewFindingDecision, ExecutionError> {
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-session"));
        }
        validate_request(r)?;
        let changes = self.changes.clone();
        let unknown = self.execution_unknown.clone();
        let tx = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-session"))?
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql)?;
        let observer = changes.observe(&tx, super::super::ChangeScope::Review);
        check_project(&tx, r.project_id, &r.locale)?;
        // A lost ACK is recovered before current-basis/CAS checks. Changed input
        // with the same identity never becomes a second mutation.
        if let Some(saved) = load(&tx, r.action_id)? {
            return if saved.request == *r {
                Ok(saved)
            } else {
                Err(failure(ErrorCode::ResultMismatch, "review-finding-action"))
            };
        }
        let target = target_in(&tx, r.project_id, r.unit_id, &r.locale)?;
        if target.basis != r.expected_basis {
            return Err(
                failure(ErrorCode::DependencyConflict, "review-current").with_conflict(
                    ConflictEvidence::ReviewBasis {
                        expected: r.expected_basis.clone(),
                        current: target.basis,
                    },
                ),
            );
        }
        let run = run_in(&tx, r.project_id, r.run_id)?;
        let current = match run.purpose {
            ReviewRunPurpose::Qa => target.current_check.as_ref().map(|run|run.run_id),
            ReviewRunPurpose::AiSemantic => super::super::ai_semantic_review::current_run(&tx,r.project_id,r.unit_id,&r.locale,&target.basis)?.map(|run|run.run_id),
        };
        if current != Some(r.run_id) || advisory(&run, &r.issue_id).is_none()
            || run.unit_id != r.unit_id || run.locale != r.locale || run.basis != r.expected_basis {
            return Err(failure(
                ErrorCode::Unauthorized,
                "review-finding-not-advisory",
            ));
        }
        let previous = latest(
            &tx,
            r.project_id,
            r.unit_id,
            &r.locale,
            &r.expected_basis,
            &r.issue_id,
        )?;
        if previous.as_ref().map(|d| d.decision_id) != r.expected_decision_id
            || !transition(
                previous.as_ref().map(|d| d.request.disposition),
                r.disposition,
            )
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-finding-current",
            ));
        }
        let json = serde_json::to_string(r)
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-finding-input"))?;
        tx.execute("INSERT INTO review_finding_decisions (decision_id,action_id,project_id,unit_id,locale,basis,run_id,issue_id,previous_decision_id,request_json,request_digest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![ExecutionId::new().to_string(),r.action_id.to_string(),r.project_id.to_string(),r.unit_id.to_string(),r.locale,r.expected_basis,r.run_id.to_string(),r.issue_id,r.expected_decision_id.map(|id|id.to_string()),json,digest(r)?]).map_err(sql)?;
        #[cfg(test)]
        super::super::migration_crash_hook("before-review-finding-commit");
        observer.commit(tx).map_err(|_| {
            unknown.store(true, std::sync::atomic::Ordering::Release);
            failure(ErrorCode::OutcomeUnknown, "review-finding-commit")
        })?;
        #[cfg(test)]
        super::super::migration_crash_hook("after-review-finding-commit");
        self.review_finding_action(r.project_id, r.action_id)?
            .ok_or_else(corrupt)
    }
    pub fn review_findings(
        &self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<ReviewFindingView, ExecutionError> {
        if limit == 0 || limit > 50 {
            return Err(failure(ErrorCode::InvalidInput, "review-history-page"));
        }
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        read_snapshot(c, |c| {
            let target = target_in(c, project, unit, locale)?;
            let semantic = super::super::ai_semantic_review::current_run(c,project,unit,locale,&target.basis)?;
            let semantic_run_id = semantic.as_ref().map(|run|run.run_id);
            let mut current_runs = Vec::new();
            if let Some(run) = &target.current_check {
                current_runs.push(qa_run(run));
            }
            if let Some(run) = semantic { current_runs.push(semantic_run(run)); }
            let mut findings = Vec::new();
            for (run,requirement,finding) in current_runs.iter().flat_map(|run| run.entries.iter().map(move |(r,f)|(run,r,f)))
                .skip(offset as usize).take(limit as usize+1) {
                findings.push(AdvisoryFinding { run_id:run.run_id,purpose:run.purpose,ai_origin:run.ai_origin.clone(),
                    requirement:requirement.clone(),finding:finding.clone(),
                    decision:latest(c,project,unit,locale,&run.basis,&finding.issue_id)? });
            }
            let more_findings = findings.len() > limit as usize;
            findings.truncate(limit as usize);
            let mut statement = c.prepare("SELECT action_id FROM review_finding_decisions WHERE project_id=?1 AND unit_id=?2 AND locale=?3 ORDER BY rowid DESC LIMIT ?4 OFFSET ?5").map_err(sql)?;
            let mut history = statement
                .query_map(
                    params![
                        project.to_string(),
                        unit.to_string(),
                        locale,
                        limit + 1,
                        offset
                    ],
                    |r| r.get::<_, String>(0),
                )
                .map_err(sql)?
                .map(|a| load(c, parse_id(a.map_err(sql)?)?).and_then(|v| v.ok_or_else(corrupt)))
                .collect::<Result<Vec<_>, _>>()?;
            let more = more_findings || history.len() > limit as usize;
            let next_offset =
                if more {
                    Some(offset.checked_add(limit).ok_or_else(|| {
                        failure(ErrorCode::LimitExceeded, "review-history-cursor")
                    })?)
                } else {
                    None
                };
            history.truncate(limit as usize);
            // Repair state accompanies this bounded history page. Older repair
            // requests remain reachable through the same explicit next cursor.
            let repairs = history.iter().filter(|d|d.request.disposition==ReviewFindingDisposition::RepairRequested).map(|decision| {
                let latest = latest(c,project,unit,locale,&decision.request.expected_basis,&decision.request.issue_id)?;
                if latest.as_ref().map(|d|d.decision_id)!=Some(decision.decision_id) {
                    return Ok(ReviewFindingRepair{decision:decision.clone(),status:ReviewRepairStatus::Superseded,recheck_run_id:None});
                }
                if decision.purpose == ReviewRunPurpose::AiSemantic {
                    let run = super::super::ai_semantic_review::current_run(c,project,unit,locale,&target.basis)?;
                    let recheck = run.filter(|run| run.run_id != decision.request.run_id
                        && decision.ai_origin.as_ref().is_some_and(|old|old.endpoint==run.evidence.endpoint && old.model==run.evidence.model && old.recipe==run.evidence.recipe)
                        && run.rules.iter().any(|rule|rule.key==decision.requirement.key));
                    let recheck = match recheck {
                        Some(run) => {
                            let newer:bool=c.query_row("SELECT newer.rowid>original.rowid FROM review_checks newer JOIN review_checks original ON original.run_id=?2 WHERE newer.run_id=?1",
                                params![run.run_id.to_string(),decision.request.run_id.to_string()],|row|row.get(0)).map_err(sql)?;
                            newer.then_some(run)
                        }, None=>None,
                    };
                    let status=match recheck.as_ref().and_then(|run|run.rules.iter().find(|rule|rule.key==decision.requirement.key)) {
                        None=>ReviewRepairStatus::AwaitingCurrentRecheck,
                        Some(rule) if rule.findings.is_empty()=>ReviewRepairStatus::CurrentRuleClear,
                        Some(_)=>ReviewRepairStatus::CurrentRuleFindings,
                    };
                    return Ok(ReviewFindingRepair { decision:decision.clone(),status,recheck_run_id:recheck.map(|run|run.run_id) });
                }
                let recheck = target.current_check.as_ref().filter(|run| run.run_id!=decision.request.run_id && run.basis==target.basis
                    && run.outcome==ReviewCheckOutcome::Completed && checks::coverage_complete(run))
                    .filter(|run| run.evidence.as_ref().is_some_and(|e| e.required_checks.requirements.iter().any(|r|r.key==decision.requirement.key && !r.mandatory && r.not_applicable.is_none())
                        && e.results.iter().any(|r|r.key==decision.requirement.key && matches!(r.outcome,sdk::CheckOutcome::Completed{..}))));
                let recheck = match recheck {
                    Some(run) => {
                        let newer: bool = c.query_row("SELECT newer.rowid>original.rowid FROM review_checks newer JOIN review_checks original ON original.run_id=?2 WHERE newer.run_id=?1",
                            params![run.run_id.to_string(),decision.request.run_id.to_string()],|row|row.get(0)).map_err(sql)?;
                        newer.then_some(run)
                    }
                    None => None,
                };
                let status = match recheck.and_then(|run|run.rules.iter().find(|rule|rule.key==decision.requirement.key)) {
                    None => ReviewRepairStatus::AwaitingCurrentRecheck,
                    Some(rule) if rule.findings.is_empty() => ReviewRepairStatus::CurrentRuleClear,
                    Some(_) => ReviewRepairStatus::CurrentRuleFindings,
                };
                Ok(ReviewFindingRepair { recheck_run_id:recheck.map(|r|r.run_id),status,decision:decision.clone() })
            }).collect::<Result<Vec<_>,ExecutionError>>()?;
            Ok(ReviewFindingView {
                unit_id: unit,
                locale: locale.into(),
                basis: target.basis,
                run_id: target.current_check.map(|r| r.run_id),
                semantic_run_id,
                findings,
                repairs,
                history,
                next_offset,
            })
        })
    }
}

#[cfg(test)]
mod tests;
