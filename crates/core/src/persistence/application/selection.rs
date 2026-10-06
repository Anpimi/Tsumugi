//! Checked policy selection shares ordinary translation and QA authorities.
use super::{ProjectStore, control};
use crate::{
    CheckRuleResult, ReviewTarget, TermResolution,
    application::*,
    execution::{Cancellation, ErrorCode, ExecutionError, ExecutionId, MAX_INPUT_BYTES, codec},
    persistence::{ledger, resources, review, translation},
};
use rusqlite::{Connection, OptionalExtension, params};

const POLICY_VERSION: &str = "checked-selection-2";

fn error(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn encode<T: serde::Serialize>(value: &T) -> Result<Vec<u8>, ExecutionError> {
    codec::encode(value, MAX_INPUT_BYTES)
}
fn checks_allow_selection(
    rules: &[CheckRuleResult],
    evidence: Option<&crate::ReviewCheckEvidence>,
) -> bool {
    // Selection requires clean complete QA; it never inherits human approval or
    // waivers. The existing Review owner evaluates the exact captured union.
    match evidence {
        Some(evidence) => review::candidate_checks_clean(rules, evidence),
        None => {
            #[cfg(any(test, feature = "execution-test-host"))]
            {
                crate::review::complete_rules(rules)
                    && rules.iter().all(|rule| {
                        matches!(rule.status.as_str(), "passed" | "not-applicable")
                            && rule.findings.is_empty()
                    })
            }
            #[cfg(not(any(test, feature = "execution-test-host")))]
            {
                false
            }
        }
    }
}

#[derive(Clone, Debug)]
struct Capture {
    request: AutomaticSelectionRequest,
    target: ReviewTarget,
    terms: TermResolution,
    text: String,
    policy: SelectionPolicy,
    protection: WorkProtection,
    selection_event: ExecutionId,
    check: Option<crate::PreparedReviewCheck>,
}
#[derive(Clone, Debug)]
enum Prepared {
    Pending(Capture),
    Recorded(AutomaticSelectionReceipt),
}

/// Store-created evidence cannot be constructed or deserialized by a caller.
#[derive(Clone, Debug)]
pub struct PreparedAutomaticSelection(Prepared);
#[derive(Debug)]
pub struct ComputedAutomaticSelection {
    prepared: PreparedAutomaticSelection,
    rules: Vec<CheckRuleResult>,
    adoption: Option<review::PreparedReviewAdoption>,
}

/// Original candidate action plus its actual, authorized domain execution.
#[derive(Debug)]
pub struct CapturedAutomaticSelection {
    capture: Capture,
    execution: crate::CapturedReviewCheckExecution,
}
impl CapturedAutomaticSelection {
    pub fn compute(
        self,
        cancellation: &Cancellation,
    ) -> Result<ComputedAutomaticSelection, ExecutionError> {
        let adoption = review::PreparedReviewAdoption::new(self.execution.compute(cancellation)?)?;
        Ok(ComputedAutomaticSelection {
            rules: adoption.rules().to_vec(),
            prepared: PreparedAutomaticSelection(Prepared::Pending(self.capture)),
            adoption: Some(adoption),
        })
    }
}
impl PreparedAutomaticSelection {
    /// Current policy projection for the saved candidate; this does not grant
    /// execution permission or make the candidate the selected translation.
    pub fn review_check(&self) -> Option<&crate::PreparedReviewCheck> {
        match &self.0 {
            Prepared::Pending(capture) => capture.check.as_ref(),
            _ => None,
        }
    }
    /// Only owned values are used here, with no SQLite connection or transaction.
    pub fn compute(
        self,
        cancellation: &Cancellation,
    ) -> Result<ComputedAutomaticSelection, ExecutionError> {
        let rules = match &self.0 {
            Prepared::Recorded(_) => Vec::new(),
            Prepared::Pending(_) if cancellation.is_requested() => {
                return Err(error(ErrorCode::Cancelled, "work-selection-checks"));
            }
            Prepared::Pending(capture)
                if capture.check.as_ref().is_some_and(|p| p.plan().is_some()) =>
            {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "review-plugin-evidence-required",
                ));
            }
            Prepared::Pending(_capture) => {
                #[cfg(any(test, feature = "execution-test-host"))]
                {
                    crate::review::check_rules(
                        &crate::review::CheckInput {
                            unit_id: _capture.request.unit_id,
                            locale: _capture.request.locale.clone(),
                            source_text: _capture.target.source_text.clone(),
                            translation_text: Some(_capture.text.clone()),
                        },
                        &_capture.terms,
                    )?
                }
                #[cfg(not(any(test, feature = "execution-test-host")))]
                {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "review-plugin-evidence-required",
                    ));
                }
            }
        };
        Ok(ComputedAutomaticSelection {
            prepared: self,
            rules,
            adoption: None,
        })
    }
}

fn recorded(
    c: &Connection,
    action: ExecutionId,
) -> Result<Option<AutomaticSelectionReceipt>, ExecutionError> {
    let row: Option<(Vec<u8>, String, Vec<u8>, String)> = c.query_row(
        "SELECT request,request_digest,receipt,receipt_digest FROM application_selection_actions WHERE action_id=?1",
        [action.to_string()], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(ledger::sql_error)?;
    row.map(|(request, digest, receipt, receipt_digest)| {
        let value: AutomaticSelectionReceipt = codec::decode(&receipt, MAX_INPUT_BYTES)?;
        if value.request.action_id != action
            || value.policy_version != POLICY_VERSION
            || request != encode(&value.request)?
            || digest != codec::digest(&request)
            || receipt_digest != codec::digest(&receipt)
        {
            return Err(error(ErrorCode::CorruptLedger, "work-selection-receipt"));
        }
        if let Some(evidence) = &value.evidence {
            review::validate_candidate_evidence(
                c,
                value.request.project_id,
                action,
                value.request.unit_id,
                &value.request.locale,
                &value.candidate_basis,
                &value.rules,
                evidence,
            )?;
            if value.validator_version != review::CURRENT_CHECK_VERSION {
                return Err(error(ErrorCode::CorruptLedger, "work-selection-validator"));
            }
            if value.blocked.is_none() {
                let (check, _) = review::check_by_action(c, value.request.project_id, action)?
                    .ok_or_else(|| error(ErrorCode::CorruptLedger, "work-selection-check"))?;
                let (selected, _) = translation::selection_by_action(c, action)?
                    .ok_or_else(|| error(ErrorCode::CorruptLedger, "work-selection-selected"))?;
                if Some(check.run_id) != value.check_run_id
                    || check.basis_evidence != value.candidate_basis
                    || check.evidence.as_ref() != Some(evidence)
                    || check.rules != value.rules
                    || value.selection.as_ref() != Some(&selected)
                {
                    return Err(error(
                        ErrorCode::CorruptLedger,
                        "work-selection-association",
                    ));
                }
            } else if value.selection.is_some() || value.check_run_id.is_some() {
                return Err(error(ErrorCode::CorruptLedger, "work-selection-blocked"));
            }
        } else if !cfg!(any(test, feature = "execution-test-host")) {
            return Err(error(ErrorCode::CorruptLedger, "work-selection-evidence"));
        }
        Ok(value)
    })
    .transpose()
}

/// A plan's own checked selections are allowed progress. A later manual or
/// other-plan selection is a changed basis and requires a new plan. This also
/// lets explicit continuation retain its original shared budget after progress.
pub(super) fn selection_matches_plan(
    c: &Connection,
    plan: &WorkPlan,
    unit: ExecutionId,
    selected: Option<ExecutionId>,
    maximum_generation: u64,
) -> Result<bool, ExecutionError> {
    let Some(basis) = plan
        .selection_basis
        .iter()
        .find(|basis| basis.unit_id == unit)
    else {
        return Ok(false);
    };
    if selected == basis.selection_id {
        return Ok(true);
    }
    let Some(selected) = selected else {
        return Ok(false);
    };
    let action: Option<String> = c.query_row(
        "SELECT action_id FROM application_selection_actions WHERE plan_id=?1 AND selection_id=?2",
        params![plan.plan_id.to_string(), selected.to_string()], |row|row.get(0),
    ).optional().map_err(ledger::sql_error)?;
    let Some(action) = action else {
        return Ok(false);
    };
    let receipt = recorded(c, ExecutionId::parse(&action)?)?
        .ok_or_else(|| error(ErrorCode::CorruptLedger, "work-selection-receipt"))?;
    Ok(receipt.request.project_id == plan.project_id
        && receipt.request.unit_id == unit
        && receipt.request.locale == plan.locale
        && receipt.request.lease.plan_id == plan.plan_id
        && receipt.request.lease.generation.get() > 0
        && receipt.request.lease.generation.get() <= maximum_generation
        && receipt.policy == plan.options.selection_policy
        && receipt.policy_version == POLICY_VERSION
        && receipt.validator_version == review::validator_version(receipt.evidence.as_ref())?
        && receipt.blocked.is_none()
        && receipt.selection.is_some_and(|value| {
            value.event_id == selected
                && value.unit_id == unit
                && value.locale == plan.locale
                && value.action_id == receipt.request.action_id
                && value.revision_id == receipt.request.revision_id
        }))
}

fn authority(
    c: &Connection,
    request: &AutomaticSelectionRequest,
) -> Result<control::StoredPlan, ExecutionError> {
    let stored = control::load(c, request.lease.plan_id)?;
    if stored.lease != request.lease
        || stored.state != WorkPlanState::Active
        || stored.expires_at <= control::now()?
    {
        return Err(error(ErrorCode::Cancelled, "work-plan-control"));
    }
    let effect = match stored.plan.options.selection_policy {
        SelectionPolicy::CandidatesOnly => {
            return Err(error(ErrorCode::Unauthorized, "work-selection-policy"));
        }
        SelectionPolicy::MissingOnly => AutomationEffect::SelectMissing,
        SelectionPolicy::ReplaceCapturedSelection => AutomationEffect::ReplaceCapturedSelection,
    };
    if stored.plan.project_id != request.project_id
        || stored.plan.locale != request.locale
        || !stored.effects.contains(&effect)
        || !stored.effects.contains(&AutomationEffect::RunChecks)
    {
        return Err(error(ErrorCode::Unauthorized, "work-selection-effect"));
    }
    Ok(stored)
}

fn capture(
    store: &ProjectStore,
    c: &Connection,
    request: &AutomaticSelectionRequest,
    selection_event: ExecutionId,
) -> Result<Capture, ExecutionError> {
    let stored = authority(c, request)?;
    let basis = stored
        .plan
        .selection_basis
        .iter()
        .find(|basis| basis.unit_id == request.unit_id)
        .ok_or_else(|| error(ErrorCode::Unauthorized, "work-selection-scope"))?;
    let target = review::target_in(c, request.project_id, request.unit_id, &request.locale)?;
    if !selection_matches_plan(
        c,
        &stored.plan,
        request.unit_id,
        target.selection_id,
        request.lease.generation.get(),
    )? || target.source_revision_id != basis.source_revision_id
        || target.native_key != basis.native_key
    {
        return Err(error(ErrorCode::DependencyConflict, "work-selection-basis"));
    }
    let row: Option<(String, String, String, String)> = c.query_row(
        "SELECT text,attempt_id,result_id,item_id FROM translation_revisions WHERE revision_id=?1 AND project_id=?2 AND unit_id=?3 AND locale=?4 AND source_revision_id=?5 AND origin_kind='ai'",
        params![request.revision_id.to_string(), request.project_id.to_string(), request.unit_id.to_string(),
            request.locale, basis.source_revision_id.to_string()], |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(ledger::sql_error)?;
    let (text, attempt, result, item_id) =
        row.ok_or_else(|| error(ErrorCode::Unauthorized, "work-selection-candidate"))?;
    let attempt = ExecutionId::parse(&attempt)?;
    let input = ledger::load_input(c, attempt)?;
    control::check_input(c, &input)?;
    let captured: i64 = c
        .query_row(
            "SELECT cancellation_revision FROM execution_attempts WHERE attempt_id=?1",
            [attempt.to_string()],
            |row| row.get(0),
        )
        .map_err(ledger::sql_error)?;
    if input.envelope().automation != Some(request.lease)
        || ledger::cancel_revision(c, input.envelope().task_id)?.get() != captured as u64
    {
        return Err(error(ErrorCode::Cancelled, "work-selection-cancelled"));
    }
    let result = ledger::load_result(c, &input, ExecutionId::parse(&result)?)?;
    let output = crate::ai::validate_output(&input, &result)?;
    let item = crate::ai::item_payload(&input, ExecutionId::parse(&item_id)?)?;
    if output.text != text
        || output.unit_id != request.unit_id
        || item.target_locale != request.locale
        || result.envelope().item_id.to_string() != item_id
    {
        return Err(error(ErrorCode::CorruptLedger, "work-selection-candidate"));
    }
    // Recheck actual shared resources, including previously empty queries. A
    // global snapshot/resource clock advancing elsewhere is not a conflict.
    let settings = crate::ai::settings(&input)?;
    let mut current = store
        .preview_ai(settings.config, &request.locale, &[request.unit_id])?
        .items
        .remove(0);
    current.source_snapshot_id = item.source_snapshot_id;
    current.resource_baseline = item.resource_baseline;
    if current != item {
        return Err(error(
            ErrorCode::DependencyConflict,
            "work-selection-resources",
        ));
    }
    if resources::revision_resources_changed(
        c,
        request.revision_id,
        request.unit_id,
        &request.locale,
        &target.source_text,
    )? {
        return Err(error(
            ErrorCode::DependencyConflict,
            "work-selection-resources",
        ));
    }
    let terms =
        resources::resolve_terms_in(c, request.project_id, request.unit_id, &request.locale)?;
    let check = review::prepare_candidate_in(
        c,
        request.project_id,
        request.action_id,
        &target,
        selection_event,
        request.revision_id,
        &text,
        &terms,
    )?;
    if check.plan().map(|plan| plan.binding())
        != store.work_plan_review_binding(&stored.plan)?.as_ref()
    {
        return Err(error(ErrorCode::DependencyConflict, "work-plan-checker"));
    }
    Ok(Capture {
        request: request.clone(),
        target,
        terms,
        text,
        policy: stored.plan.options.selection_policy,
        protection: control::protection(c, request.unit_id, &request.locale)?,
        selection_event,
        check: Some(check),
    })
}

impl ProjectStore {
    /// Historical policy evidence for a saved candidate, independent of the
    /// grant's current state. It cannot reselect or reactivate that grant.
    pub fn automatic_selection_for_candidate(
        &self,
        lease: AutomationLease,
        revision: ExecutionId,
    ) -> Result<Option<AutomaticSelectionReceipt>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "work-selection-read"))?;
        let action: Option<String> = c.query_row(
            "SELECT action_id FROM application_selection_actions WHERE plan_id=?1 AND revision_id=?2 ORDER BY rowid DESC LIMIT 1",
            params![lease.plan_id.to_string(), revision.to_string()], |row|row.get(0),
        ).optional().map_err(ledger::sql_error)?;
        let receipt = action
            .map(|id| recorded(c, ExecutionId::parse(&id)?))
            .transpose()?
            .flatten();
        if receipt.as_ref().is_some_and(|receipt| {
            receipt.request.lease != lease || receipt.request.revision_id != revision
        }) {
            return Err(error(ErrorCode::CorruptLedger, "work-selection-receipt"));
        }
        Ok(receipt)
    }

    /// Hosts must durably protect the entry before accepting an editable draft;
    /// the selection transaction then shares the same protection gate as saved
    /// manual work. Draft text is never needed by automation or stored here.
    pub fn prepare_automatic_selection(
        &self,
        request: &AutomaticSelectionRequest,
    ) -> Result<PreparedAutomaticSelection, ExecutionError> {
        if self.is_reconciling() {
            return Err(error(ErrorCode::OutcomeUnknown, "work-selection-session"));
        }
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "work-selection-read"))?;
        review::read_snapshot(c, |c| {
            if let Some(receipt) = recorded(c, request.action_id)? {
                if receipt.request != *request {
                    return Err(error(ErrorCode::ResultMismatch, "work-selection-action"));
                }
                return Ok(PreparedAutomaticSelection(Prepared::Recorded(receipt)));
            }
            Ok(PreparedAutomaticSelection(Prepared::Pending(capture(
                self,
                c,
                request,
                ExecutionId::new(),
            )?)))
        })
    }

    pub fn capture_automatic_selection_execution(
        &self,
        prepared: PreparedAutomaticSelection,
        attempt: ExecutionId,
        result: ExecutionId,
    ) -> Result<CapturedAutomaticSelection, ExecutionError> {
        let Prepared::Pending(mut capture) = prepared.0 else {
            return Err(error(ErrorCode::InvalidInput, "work-selection-recorded"));
        };
        let check = capture
            .check
            .take()
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "work-selection-check"))?;
        let execution = self.capture_review_check_execution(check, attempt, result)?;
        Ok(CapturedAutomaticSelection { capture, execution })
    }

    pub fn automatic_selection_receipt(
        &self,
        action: ExecutionId,
    ) -> Result<Option<AutomaticSelectionReceipt>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "work-selection-read"))?;
        recorded(c, action)
    }

    pub fn commit_automatic_selection(
        &mut self,
        computed: ComputedAutomaticSelection,
        cancellation: &Cancellation,
    ) -> Result<AutomaticSelectionReceipt, ExecutionError> {
        let capture = match computed.prepared.0 {
            Prepared::Pending(capture) => capture,
            Prepared::Recorded(receipt) => {
                return match self.automatic_selection_receipt(receipt.request.action_id)? {
                    Some(current) if current == receipt => Ok(current),
                    _ => Err(error(ErrorCode::CorruptLedger, "work-selection-receipt")),
                };
            }
        };
        let plugin_authority = self.plugin_authority.clone();
        let mut tx = self.execution_write()?;
        let request = &capture.request;
        if let Some(receipt) = recorded(&tx, request.action_id)? {
            return if receipt.request == *request {
                Ok(receipt)
            } else {
                Err(error(ErrorCode::ResultMismatch, "work-selection-action"))
            };
        }
        if cancellation.is_requested() {
            return Err(error(ErrorCode::Cancelled, "work-selection-checks"));
        }
        let current = self::capture(self, &tx, request, capture.selection_event)?;
        if current.target.basis != capture.target.basis
            || current.terms != capture.terms
            || current.protection != capture.protection
            || current.text != capture.text
        {
            return Err(error(
                ErrorCode::DependencyConflict,
                "work-selection-current",
            ));
        }
        if let Some(adoption) = &computed.adoption {
            adoption.recheck_authority_in(&tx, &plugin_authority, cancellation)?;
            if current
                .check
                .as_ref()
                .and_then(|p| p.plan())
                .map(|p| p.basis())
                != Some(adoption.evidence().qa_basis.as_str())
            {
                return Err(error(
                    ErrorCode::DependencyConflict,
                    "work-selection-qa-current",
                ));
            }
        } else if current.check.as_ref().is_some_and(|p| p.plan().is_some()) {
            return Err(error(
                ErrorCode::InvalidInput,
                "review-plugin-evidence-required",
            ));
        }
        let blocked = if current.protection.protected {
            Some(AutomaticSelectionBlock::Protected)
        } else if current.policy == SelectionPolicy::MissingOnly
            && current.target.selection_id.is_some()
        {
            Some(AutomaticSelectionBlock::AlreadySelected)
        } else if !checks_allow_selection(
            &computed.rules,
            computed.adoption.as_ref().map(|a| a.evidence()),
        ) {
            Some(AutomaticSelectionBlock::Checks)
        } else {
            None
        };
        let bytes = encode(request)?;
        let digest = codec::digest(&bytes);
        let mut candidate_basis = capture.target.basis_evidence;
        candidate_basis.revision_id = Some(request.revision_id);
        if let Some(adoption) = &computed.adoption {
            candidate_basis = adoption.candidate_basis().clone();
        }
        let mut receipt = AutomaticSelectionReceipt {
            request: request.clone(),
            policy_version: POLICY_VERSION.into(),
            policy: current.policy,
            protection_revision: current.protection.revision,
            candidate_basis,
            captured_selection_id: capture.target.selection_id,
            validator_version: review::validator_version(
                computed
                    .adoption
                    .as_ref()
                    .map(|adoption| adoption.evidence()),
            )?
            .into(),
            rules: computed.rules,
            evidence: computed.adoption.as_ref().map(|a| a.evidence().clone()),
            blocked,
            selection: None,
            check_run_id: None,
        };
        if receipt.blocked.is_none() {
            let prior = translation::current_selection(&tx, request.unit_id, &request.locale)?;
            let sequence = translation::check_expected(&prior, current.target.selection_id)?;
            let selected = translation::insert_reserved_selection(
                &tx,
                request.project_id,
                request.unit_id,
                &request.locale,
                request.revision_id,
                request.action_id,
                &digest,
                prior,
                sequence,
                capture.selection_event,
            )?;
            #[cfg(any(test, feature = "execution-test-host"))]
            let selected_target =
                review::target_in(&tx, request.project_id, request.unit_id, &request.locale)?;
            let check = if let Some(adoption) = &computed.adoption {
                adoption.save_in(&tx, &plugin_authority, cancellation)?
            } else {
                #[cfg(any(test, feature = "execution-test-host"))]
                {
                    review::record_check_in(
                        &tx,
                        request.project_id,
                        request.action_id,
                        &digest,
                        &selected_target,
                        &receipt.rules,
                        cancellation,
                    )?
                }
                #[cfg(not(any(test, feature = "execution-test-host")))]
                {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "review-plugin-evidence-required",
                    ));
                }
            };
            if check.rules != receipt.rules {
                return Err(error(ErrorCode::Cancelled, "work-selection-checks"));
            }
            receipt.selection = Some(selected);
            receipt.check_run_id = Some(check.run_id);
            tx.observer.add_scope(crate::ChangeScope::Translation);
            tx.observer.add_scope(crate::ChangeScope::Review);
        }
        let result = encode(&receipt)?;
        tx.execute(
            "INSERT INTO application_selection_actions VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                request.action_id.to_string(),
                request.lease.plan_id.to_string(),
                request.revision_id.to_string(),
                receipt
                    .selection
                    .as_ref()
                    .map(|selection| selection.event_id.to_string()),
                bytes,
                digest,
                result,
                codec::digest(&result)
            ],
        )
        .map_err(ledger::sql_error)?;
        if cancellation.is_requested() {
            return Err(error(ErrorCode::Cancelled, "work-selection-checks"));
        }
        tx.observer.add_scope(crate::ChangeScope::Project);
        #[cfg(test)]
        ledger::crash_hook("work-selection-before-commit");
        ledger::commit(tx)?;
        #[cfg(test)]
        ledger::crash_hook("work-selection-after-commit");
        Ok(receipt)
    }
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let mut statement = c
        .prepare(
            "SELECT action_id,plan_id,revision_id,selection_id FROM application_selection_actions",
        )
        .map_err(ledger::sql_error)?;
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(ledger::sql_error)?
    {
        let (id, plan, revision, selection) = row.map_err(ledger::sql_error)?;
        let receipt = recorded(c, ExecutionId::parse(&id)?)?
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "work-selection-receipt"))?;
        let request = &receipt.request;
        let stored = control::load(c, request.lease.plan_id)?;
        let basis = stored
            .plan
            .selection_basis
            .iter()
            .find(|basis| basis.unit_id == request.unit_id)
            .ok_or_else(|| error(ErrorCode::CorruptLedger, "work-selection-scope"))?;
        let valid_candidate: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM translation_revisions r JOIN application_executions e USING(attempt_id) WHERE r.revision_id=?1 AND r.unit_id=?2 AND r.locale=?3 AND r.source_revision_id=?4 AND r.origin_kind='ai' AND e.plan_id=?5 AND e.generation=?6)",
            params![revision, request.unit_id.to_string(), request.locale, basis.source_revision_id.to_string(),
                plan, request.lease.generation.get() as i64], |row|row.get(0)).map_err(ledger::sql_error)?;
        #[cfg(any(test, feature = "execution-test-host"))]
        if receipt.evidence.is_none() && !crate::review::complete_rules(&receipt.rules) {
            return Err(error(ErrorCode::CorruptLedger, "work-selection-receipt"));
        }
        if request.lease.plan_id.to_string() != plan
            || request.revision_id.to_string() != revision
            || request.project_id != stored.plan.project_id
            || request.locale != stored.plan.locale
            || request.lease.generation.get() == 0
            || request.lease.generation > stored.lease.generation
            || receipt.policy != stored.plan.options.selection_policy
            || receipt.policy == SelectionPolicy::CandidatesOnly
            || receipt.policy_version != POLICY_VERSION
            || receipt.validator_version != review::validator_version(receipt.evidence.as_ref())?
            || receipt.candidate_basis.source_revision_id != basis.source_revision_id
            || !selection_matches_plan(
                c,
                &stored.plan,
                request.unit_id,
                receipt.captured_selection_id,
                request.lease.generation.get(),
            )?
            || receipt.candidate_basis.revision_id != Some(request.revision_id)
            || !valid_candidate
            || receipt.selection.as_ref().map(|s| s.event_id.to_string()) != selection
            || receipt.blocked.is_some() == receipt.selection.is_some()
            || receipt.selection.is_some() != receipt.check_run_id.is_some()
        {
            return Err(error(ErrorCode::CorruptLedger, "work-selection-receipt"));
        }
        if let Some(selected) = &receipt.selection {
            let selected_row = translation::selection_by_action(c, request.action_id)?;
            let check = review::check_by_action(c, request.project_id, request.action_id)?;
            let digest = codec::digest(&encode(request)?);
            if !checks_allow_selection(&receipt.rules, receipt.evidence.as_ref())
                || selected.action_id != request.action_id
                || selected.revision_id != request.revision_id
                || selected.previous_event_id != receipt.captured_selection_id
                || selected_row != Some((selected.clone(), digest.clone()))
                || !check.is_some_and(|(check, check_digest)| {
                    check.run_id == receipt.check_run_id.unwrap()
                        && check.rules == receipt.rules
                        && if receipt.evidence.is_some() {
                            check.evidence == receipt.evidence
                                && check.basis_evidence == receipt.candidate_basis
                        } else {
                            check_digest == digest
                        }
                        && check.basis_evidence.selection_id == Some(selected.event_id)
                        && check.basis_evidence.revision_id == Some(selected.revision_id)
                })
            {
                return Err(error(ErrorCode::CorruptLedger, "work-selection-evidence"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execution::{ExecutionState, FixedInput, FixedResult, ResultEnvelope};
    use crate::persistence::review::tests::{fixture, translate};
    use crate::{AiAdoptionHandler, ProjectStore, SaveTranslationRevision};
    use std::fs;

    fn options(policy: SelectionPolicy) -> PlanOptions {
        let mut options = PlanOptions {
            selection_policy: policy,
            ..PlanOptions::default()
        };
        options
            .stages
            .iter_mut()
            .find(|stage| stage.stage == WorkStage::Checks)
            .unwrap()
            .mode = StageMode::Assisted;
        options
    }
    fn grant(
        store: &mut ProjectStore,
        units: &[ExecutionId],
        policy: SelectionPolicy,
    ) -> (WorkPlan, FixedInput) {
        let config = crate::ai::AiConfig {
            endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
            model: "synthetic-selection".into(),
            credential_env: String::new(),
            ..crate::ai::AiConfig::default()
        };
        let plan = store
            .prepare_work_plan(Some(config), "zh-CN", units, options(policy))
            .unwrap();
        let receipt = store
            .authorize_work_plan(
                &plan,
                &AuthorizeWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_digest: plan.digest.clone(),
                    confirmed: true,
                    effects: plan.options.authorization_effects().unwrap(),
                    expires_at: control::now().unwrap() + 600,
                },
            )
            .unwrap();
        let input = FixedInput::capture(receipt.input.unwrap()).unwrap();
        store.enqueue_execution(&input).unwrap();
        (plan, input)
    }
    fn candidate(
        store: &mut ProjectStore,
        input: &FixedInput,
        unit: ExecutionId,
        text: &str,
    ) -> ExecutionId {
        let item = input
            .envelope()
            .items
            .iter()
            .find(|item| item.scope.id == unit.to_string())
            .unwrap()
            .item_id;
        let dispatch = store
            .dispatch_execution_item(input.envelope().attempt_id, item)
            .unwrap();
        let result = FixedResult::capture(
            ResultEnvelope {
                plugin: None,
                project_id: input.envelope().project_id,
                attempt_id: input.envelope().attempt_id,
                item_id: item,
                result_id: ExecutionId::new(),
                supersedes: None,
                dispatch_token: dispatch.dispatch_token,
                capability_id: crate::ai::CAPABILITY.into(),
                capability_version: "1".into(),
                outcome: ExecutionState::Succeeded,
                output: Some(
                    serde_json::to_value(crate::ai::AiOutput {
                        unit_id: unit,
                        target_locale: "zh-CN".into(),
                        text: text.into(),
                        usage: None,
                        requests: 1,
                        usage_incomplete: true,
                    })
                    .unwrap(),
                ),
                diagnostic: None,
            },
            input,
            dispatch.dispatch_token,
        )
        .unwrap();
        store.save_execution_result(&result).unwrap();
        store
            .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
            .unwrap();
        let recovery_unit = input
            .envelope()
            .units
            .iter()
            .find(|unit| unit.item_ids.contains(&item))
            .unwrap()
            .unit_id;
        let action = store
            .prepare_adoption(
                input.envelope().attempt_id,
                recovery_unit,
                vec![result.envelope().result_id],
                serde_json::Value::Null,
            )
            .unwrap();
        let receipt = store.adopt_execution(&action, &AiAdoptionHandler).unwrap();
        ExecutionId::parse(&receipt.changes[0].id).unwrap()
    }
    fn request(
        input: &FixedInput,
        unit: ExecutionId,
        revision: ExecutionId,
    ) -> AutomaticSelectionRequest {
        AutomaticSelectionRequest {
            project_id: input.envelope().project_id,
            action_id: ExecutionId::new(),
            lease: input.envelope().automation.unwrap(),
            unit_id: unit,
            locale: "zh-CN".into(),
            revision_id: revision,
        }
    }
    fn release(store: &mut ProjectStore, project: ExecutionId, unit: ExecutionId) {
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        let protection = store.work_protection(unit, "zh-CN").unwrap();
        store
            .set_work_protection(&SetWorkProtection {
                action_id: ExecutionId::new(),
                project_id: project,
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                selection_id: target.selection_id,
                expected_revision: protection.revision,
                protected: false,
                confirmed_release: true,
            })
            .unwrap();
    }
    fn apply(
        store: &mut ProjectStore,
        request: &AutomaticSelectionRequest,
    ) -> AutomaticSelectionReceipt {
        let cancellation = Cancellation::default();
        let computed = store
            .prepare_automatic_selection(request)
            .unwrap()
            .compute(&cancellation)
            .unwrap();
        store
            .commit_automatic_selection(computed, &cancellation)
            .unwrap()
    }

    #[test]
    fn selection_crash_child() {
        let Ok(directory) = std::env::var("TSUMUGI_SELECTION_PROJECT") else {
            return;
        };
        let mut store = ProjectStore::open(directory).unwrap();
        let request: AutomaticSelectionRequest = serde_json::from_slice(
            &fs::read(std::env::var("TSUMUGI_SELECTION_REQUEST").unwrap()).unwrap(),
        )
        .unwrap();
        apply(&mut store, &request);
        panic!("owned helper did not reach the requested crash boundary");
    }

    #[test]
    fn subprocess_selection_commit_is_atomic_and_lost_ack_is_readable_after_pause() {
        for point in [
            "work-selection-before-commit",
            "work-selection-after-commit",
        ] {
            let (directory, mut store, project, units) = fixture();
            let (plan, input) = grant(&mut store, &[units[0]], SelectionPolicy::MissingOnly);
            let revision = candidate(&mut store, &input, units[0], "你好 {{name}}");
            let action = request(&input, units[0], revision);
            let path = store.directory().to_path_buf();
            let request_path = directory.path().join("selection-request.json");
            fs::write(&request_path, serde_json::to_vec(&action).unwrap()).unwrap();
            store.close().unwrap();
            let hook = directory.path().join("selection-hook");
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "persistence::application::selection::tests::selection_crash_child",
                    "--nocapture",
                ])
                .env("TSUMUGI_SELECTION_PROJECT", &path)
                .env("TSUMUGI_SELECTION_REQUEST", &request_path)
                .env("TSUMUGI_EXECUTION_CRASH", point)
                .env("TSUMUGI_EXECUTION_HOOK", &hook)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if std::time::Instant::now() >= deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("owned selection helper timed out");
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            };
            assert!(!status.success());
            assert_eq!(fs::read_to_string(&hook).unwrap(), point);
            let mut store = ProjectStore::open(&path).unwrap();
            let committed = point == "work-selection-after-commit";
            let count = i64::from(committed);
            for table in [
                "translation_selections",
                "review_checks",
                "application_selection_actions",
            ] {
                let actual: i64 = store
                    .connection()
                    .unwrap()
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })
                    .unwrap();
                assert_eq!(actual, count, "{point}: {table}");
            }
            let item = input.envelope().items[0].item_id;
            assert_eq!(
                store
                    .saved_ai_candidate(input.envelope().attempt_id, item)
                    .unwrap(),
                Some(revision)
            );
            let target = store.review_target(project, units[0], "zh-CN").unwrap();
            assert_eq!(target.revision_id, committed.then_some(revision));
            assert_eq!(target.current_check.is_some(), committed);
            assert!(target.current_decision.is_none());
            store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: plan.plan_id,
                    expected_generation: action.lease.generation,
                    command: WorkPlanCommand::Pause,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
            let before = fs::read(path.join("project.sqlite3")).unwrap();
            let receipt = store
                .automatic_selection_for_candidate(action.lease, revision)
                .unwrap();
            assert_eq!(receipt.is_some(), committed);
            assert_eq!(
                store.automatic_selection_receipt(action.action_id).unwrap(),
                receipt
            );
            let cancellation = Cancellation::default();
            if let Some(receipt) = receipt {
                assert_eq!(receipt.request, action);
                assert_eq!(receipt.selection.as_ref().unwrap().revision_id, revision);
                assert_eq!(
                    target.current_check.unwrap().run_id,
                    receipt.check_run_id.unwrap()
                );
                let computed = store
                    .prepare_automatic_selection(&action)
                    .unwrap()
                    .compute(&cancellation)
                    .unwrap();
                assert_eq!(
                    store
                        .commit_automatic_selection(computed, &cancellation)
                        .unwrap(),
                    receipt
                );
                let mut fresh = action.clone();
                fresh.action_id = ExecutionId::new();
                assert_eq!(
                    store.prepare_automatic_selection(&fresh).unwrap_err().code,
                    ErrorCode::Cancelled
                );
            } else {
                assert_eq!(
                    store.prepare_automatic_selection(&action).unwrap_err().code,
                    ErrorCode::Cancelled
                );
            }
            assert_eq!(
                store.work_plan_status(plan.plan_id).unwrap().state,
                WorkPlanState::Paused
            );
            assert_eq!(fs::read(path.join("project.sqlite3")).unwrap(), before);
            store.close().unwrap();
            ProjectStore::open(path).unwrap().close().unwrap();
        }
    }

    #[test]
    fn missing_selection_has_atomic_policy_and_current_checks_but_no_human_approval() {
        let (_temp, mut store, project, units) = fixture();
        let (_plan, input) = grant(&mut store, &units, SelectionPolicy::MissingOnly);
        let first = candidate(&mut store, &input, units[0], "你好 {{name}}");
        let second = candidate(&mut store, &input, units[1], "普通");
        let action = request(&input, units[0], first);
        let db = store.directory().join("project.sqlite3");
        let before = fs::read(&db).unwrap();
        let prepared = store.prepare_automatic_selection(&action).unwrap();
        assert_eq!(fs::read(&db).unwrap(), before);
        let independent = Connection::open(&db).unwrap();
        independent.execute_batch("BEGIN IMMEDIATE").unwrap();
        let cancellation = Cancellation::default();
        let computed = prepared.compute(&cancellation).unwrap();
        independent.execute_batch("ROLLBACK").unwrap();
        let receipt = store
            .commit_automatic_selection(computed, &cancellation)
            .unwrap();
        assert_eq!(receipt.policy_version, POLICY_VERSION);
        assert_eq!(receipt.blocked, None);
        assert_eq!(receipt.selection.as_ref().unwrap().revision_id, first);
        let target = store.review_target(project, units[0], "zh-CN").unwrap();
        assert_eq!(target.revision_id, Some(first));
        assert_eq!(
            target.current_check.unwrap().run_id,
            receipt.check_run_id.unwrap()
        );
        assert!(target.current_decision.is_none());
        assert!(
            !store
                .review_eligibility(project, &["zh-CN".into()])
                .unwrap()
                .ready
        );
        assert!(!store.work_protection(units[0], "zh-CN").unwrap().protected);
        let after = fs::read(&db).unwrap();
        assert_eq!(apply(&mut store, &action), receipt);
        assert_eq!(fs::read(&db).unwrap(), after);
        // Selecting one entry must not stale the untouched entries of the plan.
        let other = apply(&mut store, &request(&input, units[1], second));
        assert_eq!(other.selection.unwrap().revision_id, second);
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let mut reopened = ProjectStore::open(&directory).unwrap();
        assert_eq!(apply(&mut reopened, &action), receipt);
        assert!(
            reopened
                .review_target(project, units[0], "zh-CN")
                .unwrap()
                .current_decision
                .is_none()
        );
    }

    #[test]
    fn protected_entries_and_existing_selection_keep_candidates_and_mechanical_findings() {
        let (_temp, mut store, project, units) = fixture();
        translate(&mut store, project, units[0], "zh-CN", "人工 {{name}}");
        release(&mut store, project, units[0]);
        let (_plan, input) = grant(&mut store, &units, SelectionPolicy::MissingOnly);
        let first = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let already = apply(&mut store, &request(&input, units[0], first));
        assert_eq!(
            already.blocked,
            Some(AutomaticSelectionBlock::AlreadySelected)
        );
        assert!(already.selection.is_none());
        let prior = store
            .review_target(project, units[0], "zh-CN")
            .unwrap()
            .selection_id;
        assert_eq!(already.candidate_basis.selection_id, prior);

        let second = candidate(&mut store, &input, units[1], "");
        let target = store.review_target(project, units[1], "zh-CN").unwrap();
        store
            .set_work_protection(&SetWorkProtection {
                action_id: ExecutionId::new(),
                project_id: project,
                unit_id: units[1],
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                selection_id: None,
                expected_revision: store.work_protection(units[1], "zh-CN").unwrap().revision,
                protected: true,
                confirmed_release: false,
            })
            .unwrap();
        let protected = apply(&mut store, &request(&input, units[1], second));
        assert_eq!(protected.blocked, Some(AutomaticSelectionBlock::Protected));
        assert!(
            protected
                .rules
                .iter()
                .flat_map(|rule| &rule.findings)
                .any(|issue| issue.code == "empty")
        );
        assert!(
            store
                .review_target(project, units[1], "zh-CN")
                .unwrap()
                .selection_id
                .is_none()
        );
        assert!(
            store
                .translation_history(project, units[1], "zh-CN", 0, 10)
                .unwrap()
                .rows
                .iter()
                .any(|row| row.revision_id == second)
        );
        release(&mut store, project, units[1]);
        let rejected = apply(&mut store, &request(&input, units[1], second));
        assert_eq!(rejected.blocked, Some(AutomaticSelectionBlock::Checks));
        assert!(rejected.selection.is_none());
        assert!(
            store
                .review_target(project, units[1], "zh-CN")
                .unwrap()
                .current_check
                .is_none()
        );
    }

    #[test]
    fn explicit_replace_requires_release_and_never_transfers_human_approval() {
        let (_temp, mut store, project, units) = fixture();
        translate(&mut store, project, units[0], "zh-CN", "人工 {{name}}");
        let before = store.review_target(project, units[0], "zh-CN").unwrap();
        store
            .write_review(&crate::ReviewWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                expected_basis: before.basis,
                expected_decision_id: None,
                actor: "human-reviewer".into(),
                kind: crate::ReviewDecisionKind::Approve,
                reason: String::new(),
            })
            .unwrap();
        let (_plan, input) = grant(
            &mut store,
            &[units[0]],
            SelectionPolicy::ReplaceCapturedSelection,
        );
        let revision = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let action = request(&input, units[0], revision);
        assert_eq!(
            apply(&mut store, &action).blocked,
            Some(AutomaticSelectionBlock::Protected)
        );
        release(&mut store, project, units[0]);
        let selected = apply(&mut store, &request(&input, units[0], revision));
        assert_eq!(
            selected.selection.unwrap().previous_event_id,
            before.selection_id
        );
        let current = store.review_target(project, units[0], "zh-CN").unwrap();
        assert_eq!(current.revision_id, Some(revision));
        assert!(current.current_decision.is_none());
        let human_count: i64 = store
            .connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM review_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(human_count, 1);
        // Replaying the old blocked action cannot perform the now-permitted selection.
        assert_eq!(
            apply(&mut store, &action).blocked,
            Some(AutomaticSelectionBlock::Protected)
        );
    }

    #[test]
    fn late_manual_work_and_draft_protection_invalidate_prepared_automatic_selection() {
        let (_temp, mut store, project, units) = fixture();
        let (_plan, input) = grant(&mut store, &units, SelectionPolicy::MissingOnly);
        let revision = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let action = request(&input, units[0], revision);
        let cancel = Cancellation::default();
        let computed = store
            .prepare_automatic_selection(&action)
            .unwrap()
            .compute(&cancel)
            .unwrap();
        let target = store.review_target(project, units[0], "zh-CN").unwrap();
        store
            .set_work_protection(&SetWorkProtection {
                action_id: ExecutionId::new(),
                project_id: project,
                unit_id: units[0],
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                selection_id: None,
                expected_revision: store.work_protection(units[0], "zh-CN").unwrap().revision,
                protected: true,
                confirmed_release: false,
            })
            .unwrap();
        assert_eq!(
            store
                .commit_automatic_selection(computed, &cancel)
                .unwrap_err()
                .stage,
            "work-selection-current"
        );
        assert!(
            store
                .automatic_selection_receipt(action.action_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            apply(&mut store, &action).blocked,
            Some(AutomaticSelectionBlock::Protected)
        );
        let other = candidate(&mut store, &input, units[1], "自动");
        let action = request(&input, units[1], other);
        let computed = store
            .prepare_automatic_selection(&action)
            .unwrap()
            .compute(&cancel)
            .unwrap();
        let target = store.review_target(project, units[1], "zh-CN").unwrap();
        let saved = store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: units[1],
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: None,
                text: "较新的人工译文".into(),
            })
            .unwrap();
        assert_eq!(
            store
                .commit_automatic_selection(computed, &cancel)
                .unwrap_err()
                .stage,
            "work-selection-basis"
        );
        assert_eq!(
            store
                .review_target(project, units[1], "zh-CN")
                .unwrap()
                .selection_id,
            Some(saved.event_id)
        );
        assert!(
            store
                .translation_history(project, units[1], "zh-CN", 0, 10)
                .unwrap()
                .rows
                .iter()
                .any(|row| row.revision_id == other)
        );
    }

    #[test]
    fn revoked_generation_and_cancelled_checks_cannot_commit_and_old_receipts_remain_historical() {
        let (_temp, mut store, project, units) = fixture();
        let (plan, input) = grant(&mut store, &units, SelectionPolicy::MissingOnly);
        let first = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let old = request(&input, units[0], first);
        let selected = apply(&mut store, &old);
        translate(&mut store, project, units[0], "zh-CN", "新的人工 {{name}}");
        let newer = store
            .review_target(project, units[0], "zh-CN")
            .unwrap()
            .selection_id;
        let second = candidate(&mut store, &input, units[1], "自动");
        let action = request(&input, units[1], second);
        let cancel = Cancellation::default();
        let prepared = store.prepare_automatic_selection(&action).unwrap();
        cancel.request();
        assert_eq!(
            prepared.compute(&cancel).unwrap_err().code,
            ErrorCode::Cancelled
        );
        let cancel = Cancellation::default();
        let computed = store
            .prepare_automatic_selection(&action)
            .unwrap()
            .compute(&cancel)
            .unwrap();
        store
            .control_work_plan(&ControlWorkPlan {
                action_id: ExecutionId::new(),
                plan_id: plan.plan_id,
                expected_generation: input.envelope().automation.unwrap().generation,
                command: WorkPlanCommand::TakeOver,
                confirmed: false,
                expires_at: None,
            })
            .unwrap();
        assert_eq!(
            store
                .commit_automatic_selection(computed, &cancel)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(apply(&mut store, &old), selected);
        assert_eq!(
            store
                .review_target(project, units[0], "zh-CN")
                .unwrap()
                .selection_id,
            newer
        );
        assert!(
            store
                .automatic_selection_receipt(action.action_id)
                .unwrap()
                .is_none()
        );
        let mut new_identity = action.clone();
        new_identity.action_id = ExecutionId::new();
        assert_eq!(
            store
                .prepare_automatic_selection(&new_identity)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn selection_needs_exact_policy_effects_candidate_scope_and_current_resources() {
        let (_temp, mut store, project, units) = fixture();
        let mut invalid = options(SelectionPolicy::MissingOnly);
        invalid
            .stages
            .iter_mut()
            .find(|s| s.stage == WorkStage::Checks)
            .unwrap()
            .mode = StageMode::Manual;
        assert!(invalid.validate().is_err());
        let (plan, input) = grant(&mut store, &[units[0]], SelectionPolicy::MissingOnly);
        let revision = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let mut action = request(&input, units[1], revision);
        assert_eq!(
            store.prepare_automatic_selection(&action).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        action.unit_id = units[0];
        action.project_id = ExecutionId::new();
        assert_eq!(
            store.prepare_automatic_selection(&action).unwrap_err().code,
            ErrorCode::Unauthorized
        );
        action.project_id = project;
        let cancel = Cancellation::default();
        let computed = store
            .prepare_automatic_selection(&action)
            .unwrap()
            .compute(&cancel)
            .unwrap();
        store
            .save_context(&crate::SaveContext {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: units[0],
                locale: "zh-CN".into(),
                text: "Changed interpretation".into(),
                source_revision_id: plan.selection_basis[0].source_revision_id,
                expected_revision_id: None,
                reason: "Synthetic resource conflict".into(),
            })
            .unwrap();
        assert_eq!(
            store
                .commit_automatic_selection(computed, &cancel)
                .unwrap_err()
                .stage,
            "work-selection-resources"
        );
        assert_eq!(
            store
                .prepare_automatic_selection(&action)
                .unwrap_err()
                .stage,
            "work-selection-resources"
        );
        let mut insufficient = AuthorizeWorkPlan {
            action_id: ExecutionId::new(),
            plan_digest: plan.digest.clone(),
            confirmed: true,
            effects: vec![
                AutomationEffect::SaveCandidate,
                AutomationEffect::SelectMissing,
            ],
            expires_at: control::now().unwrap() + 600,
        };
        assert_eq!(
            store
                .authorize_work_plan(&plan, &insufficient)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
        insufficient.effects.push(AutomationEffect::Deliver);
        assert_eq!(
            store
                .authorize_work_plan(&plan, &insufficient)
                .unwrap_err()
                .code,
            ErrorCode::Unauthorized
        );
    }

    #[test]
    fn corrupt_policy_or_check_receipt_is_refused_without_resetting_the_database() {
        let (_temp, mut store, _project, units) = fixture();
        let (_plan, input) = grant(&mut store, &[units[0]], SelectionPolicy::MissingOnly);
        let revision = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let action = request(&input, units[0], revision);
        let receipt = apply(&mut store, &action);
        let directory = store.directory().to_path_buf();
        store.close().unwrap();
        let c = Connection::open(directory.join("project.sqlite3")).unwrap();
        let mut altered = receipt;
        altered.rules.pop();
        let bytes = encode(&altered).unwrap();
        c.execute("UPDATE application_selection_actions SET receipt=?2,receipt_digest=?3 WHERE action_id=?1",
            params![action.action_id.to_string(), bytes, codec::digest(&bytes)]).unwrap();
        drop(c);
        let before = fs::read(directory.join("project.sqlite3")).unwrap();
        assert!(ProjectStore::open(&directory).is_err());
        assert_eq!(fs::read(directory.join("project.sqlite3")).unwrap(), before);
    }

    #[test]
    fn changed_source_refuses_prepared_selection_and_keeps_the_saved_candidate() {
        let (_temp, mut store, _project, units) = fixture();
        let (_plan, input) = grant(&mut store, &[units[0]], SelectionPolicy::MissingOnly);
        let revision = candidate(&mut store, &input, units[0], "自动 {{name}}");
        let action = request(&input, units[0], revision);
        let cancel = Cancellation::default();
        let computed = store
            .prepare_automatic_selection(&action)
            .unwrap()
            .compute(&cancel)
            .unwrap();
        crate::persistence::review::tests::adopt_source(
            &mut store,
            br#"{"hello":"Changed {{name}}","plain":"Plain"}"#,
        );
        assert_eq!(
            store
                .commit_automatic_selection(computed, &cancel)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
        assert!(
            store
                .automatic_selection_receipt(action.action_id)
                .unwrap()
                .is_none()
        );
        let preserved: String = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT text FROM translation_revisions WHERE revision_id=?1",
                [revision.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, "自动 {{name}}");
    }

    #[test]
    fn renewed_plan_accepts_its_own_progress_but_refuses_new_manual_selection() {
        for policy in [
            SelectionPolicy::MissingOnly,
            SelectionPolicy::ReplaceCapturedSelection,
        ] {
            let (_temp, mut store, project, units) = fixture();
            let (plan, input) = grant(&mut store, &[units[0]], policy);
            let first = candidate(&mut store, &input, units[0], "第一稿 {{name}}");
            let prior = apply(&mut store, &request(&input, units[0], first))
                .selection
                .unwrap();
            let paused = store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: plan.plan_id,
                    expected_generation: input.envelope().automation.unwrap().generation,
                    command: WorkPlanCommand::Pause,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
            let resumed = store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: plan.plan_id,
                    expected_generation: paused.lease.generation,
                    command: WorkPlanCommand::Continue,
                    confirmed: true,
                    expires_at: Some(control::now().unwrap() + 600),
                })
                .unwrap();
            assert_eq!(resumed.parent_task, Some(input.envelope().task_id));
            let child = FixedInput::capture(resumed.input.unwrap()).unwrap();
            store
                .enqueue_execution_with_policy(
                    &child,
                    crate::execution::RecoveryPolicy::ExternalUnknown,
                    resumed.parent_task,
                )
                .unwrap();
            let second = candidate(&mut store, &child, units[0], "第二稿 {{name}}");
            let receipt = apply(&mut store, &request(&child, units[0], second));
            assert_eq!(receipt.candidate_basis.selection_id, Some(prior.event_id));
            if policy == SelectionPolicy::MissingOnly {
                assert_eq!(
                    receipt.blocked,
                    Some(AutomaticSelectionBlock::AlreadySelected)
                );
                assert_eq!(
                    store
                        .review_target(project, units[0], "zh-CN")
                        .unwrap()
                        .selection_id,
                    Some(prior.event_id)
                );
            } else {
                assert_eq!(
                    receipt.selection.as_ref().unwrap().previous_event_id,
                    Some(prior.event_id)
                );
            }
            let directory = store.directory().to_path_buf();
            store.close().unwrap();
            let mut store = ProjectStore::open(&directory).unwrap();
            assert_eq!(
                store
                    .automatic_selection_receipt(receipt.request.action_id)
                    .unwrap(),
                Some(receipt)
            );
            translate(&mut store, project, units[0], "zh-CN", "新的人工 {{name}}");
            let paused = store
                .control_work_plan(&ControlWorkPlan {
                    action_id: ExecutionId::new(),
                    plan_id: plan.plan_id,
                    expected_generation: child.envelope().automation.unwrap().generation,
                    command: WorkPlanCommand::Pause,
                    confirmed: false,
                    expires_at: None,
                })
                .unwrap();
            let resume = ControlWorkPlan {
                action_id: ExecutionId::new(),
                plan_id: plan.plan_id,
                expected_generation: paused.lease.generation,
                command: WorkPlanCommand::Continue,
                confirmed: true,
                expires_at: Some(control::now().unwrap() + 600),
            };
            assert_eq!(
                store.control_work_plan(&resume).unwrap_err().stage,
                "work-plan-selection"
            );
        }
    }
}
