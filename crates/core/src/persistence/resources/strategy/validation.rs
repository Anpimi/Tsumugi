//! Reopening validates immutable associations, without requiring old captures
//! to remain the current project source, judgment or default.
use super::*;

pub(in crate::persistence) fn validate(c: &Connection) -> rusqlite::Result<()> {
    for (name, expected) in TABLES {
        let actual: String = c.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )?;
        if actual != *expected {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    validate_records(c).map_err(|_| rusqlite::Error::InvalidQuery)
}

fn validate_records(c: &Connection) -> Result<(), ExecutionError> {
    let mut facts=c.prepare("SELECT kind,fact_id,project_id,payload,digest,locale,association_id,member_id FROM context_strategy_facts ORDER BY rowid").map_err(sql)?;
    for row in facts
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(sql)?
    {
        let (kind, id, owner, payload, expected, locale, association, member) = row.map_err(sql)?;
        let id = ExecutionId::parse(&id)?;
        let owner = ExecutionId::parse(&owner)?;
        project(c, owner, None)?;
        if codec::digest(&payload) != expected {
            return Err(corrupt());
        }
        let value: serde_json::Value = codec::decode(&payload, MAX_INPUT_BYTES)?;
        let request = value.get("request");
        if locale.as_deref() != value.get("locale").and_then(|v| v.as_str())
            || association.as_deref()
                != request
                    .and_then(|v| v.get("evaluationId"))
                    .and_then(|v| v.as_str())
            || member.as_deref()
                != request
                    .and_then(|v| {
                        v.get(if kind == "judgment" {
                            "unitId"
                        } else {
                            "itemId"
                        })
                    })
                    .and_then(|v| v.as_str())
        {
            return Err(corrupt());
        }
        let action_kind = match kind.as_str() {
            "candidate" => "candidate",
            "suite" => "suite",
            "evaluation" | "evaluation-input" => "evaluation",
            "check" | "check-capture" => "check",
            "judgment" => "judgment",
            "qualification" => "promote",
            "default" => {
                let revision: ContextStrategyDefaultRevision =
                    codec::decode(&payload, MAX_INPUT_BYTES)?;
                if revision.reference.is_some() {
                    "promote"
                } else {
                    "withdraw"
                }
            }
            _ => return Err(corrupt()),
        };
        let linked:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM context_strategy_actions WHERE action_id=?1 AND project_id=?2 AND kind=?3)",params![id.to_string(),owner.to_string(),action_kind],|r|r.get(0)).map_err(sql)?;
        if !linked {
            return Err(corrupt());
        }
    }
    let mut actions=c.prepare("SELECT action_id,project_id,kind,request,request_digest,receipt FROM context_strategy_actions ORDER BY rowid").map_err(sql)?;
    let mut defaults: BTreeMap<String, ExecutionId> = BTreeMap::new();
    let mut judgments: BTreeMap<(ExecutionId, ExecutionId), ExecutionId> = BTreeMap::new();
    for row in actions
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<Vec<u8>>>(5)?,
            ))
        })
        .map_err(sql)?
    {
        let (id, owner, kind, request, expected, receipt) = row.map_err(sql)?;
        let id = ExecutionId::parse(&id)?;
        let owner = ExecutionId::parse(&owner)?;
        project(c, owner, None)?;
        if codec::digest(&request) != expected {
            return Err(corrupt());
        }
        let receipt: Option<StrategyActionReceipt> = receipt
            .map(|p| codec::decode(&p, MAX_INPUT_BYTES))
            .transpose()?;
        validate_action(
            c,
            id,
            owner,
            &kind,
            request,
            receipt,
            &mut defaults,
            &mut judgments,
        )?;
    }
    Ok(())
}

// Reopen and explicit original-action recovery share the same historical rules.
fn validate_action(
    c: &Connection,
    id: ExecutionId,
    owner: ExecutionId,
    kind: &str,
    request: Vec<u8>,
    receipt: Option<StrategyActionReceipt>,
    defaults: &mut BTreeMap<String, ExecutionId>,
    judgments: &mut BTreeMap<(ExecutionId, ExecutionId), ExecutionId>,
) -> Result<(), ExecutionError> {
    match (kind, receipt) {
        (
            "candidate",
            Some(StrategyActionReceipt::Candidate {
                request: r,
                candidate,
            }),
        ) => {
            if bytes(&r)? != request
                || r.action_id != id
                || r.basis.project_id != owner
                || get::<ContextStrategyCandidate>(c, "candidate", id, owner)? != candidate
            {
                return Err(corrupt());
            }
            validate_candidate(c, &r, &candidate)?;
        }
        ("suite", Some(StrategyActionReceipt::Suite { request: r, suite })) => {
            if bytes(&r)? != request
                || r.action_id != id
                || r.project_id != owner
                || suite.request != r
                || get::<StrategySuite>(c, "suite", id, owner)? != suite
            {
                return Err(corrupt());
            }
            validate_suite(c, &suite)?;
        }
        (
            "evaluation",
            Some(StrategyActionReceipt::Evaluation {
                request: r,
                evaluation,
            }),
        ) => {
            if bytes(&r)? != request
                || r.action_id != id
                || r.project_id != owner
                || evaluation.request != r
                || evaluation.evaluation_id != id
                || evaluation.project_id != owner
                || evaluation.candidate_id != r.candidate_id
                || evaluation.suite_id != r.suite_id
                || get::<StrategyEvaluation>(c, "evaluation", id, owner)? != evaluation
            {
                return Err(corrupt());
            }
            let suite: StrategySuite = get(c, "suite", r.suite_id, owner)?;
            if suite.candidate_id != r.candidate_id || suite.locale != evaluation.locale {
                return Err(corrupt());
            }
            evaluation_input(c, owner, id)?;
        }
        ("check", value) => {
            let r: StrategyCheckRequest = codec::decode(&request, MAX_INPUT_BYTES)?;
            if r.action_id != id || r.project_id != owner {
                return Err(corrupt());
            }
            let capture: CheckCapture = get(c, "check-capture", id, owner)?;
            if capture.request != r {
                return Err(corrupt());
            }
            validate_capture(c, &capture)?;
            match value {
                Some(StrategyActionReceipt::Check { receipt }) => {
                    if receipt.request != r
                        || get::<StrategyCheckReceipt>(c, "check", id, owner)? != receipt
                    {
                        return Err(corrupt());
                    }
                    validate_check(c, &receipt)?;
                }
                _ => return Err(corrupt()),
            }
        }
        ("judgment", Some(StrategyActionReceipt::Judgment { judgment })) => {
            let r = &judgment.request;
            if bytes(r)? != request
                || r.action_id != id
                || r.project_id != owner
                || judgment.judgment_id != id
                || get::<StrategyJudgment>(c, "judgment", id, owner)? != judgment
                || judgments.get(&(r.evaluation_id, r.unit_id)).copied() != r.expected_judgment_id
            {
                return Err(corrupt());
            }
            validate_judgment(c, &judgment)?;
            judgments.insert((r.evaluation_id, r.unit_id), id);
        }
        (
            "promote",
            Some(StrategyActionReceipt::Promoted {
                request: r,
                revision,
            }),
        ) => {
            if bytes(&r)? != request
                || r.action_id != id
                || r.project_id != owner
                || revision.action_id != id
                || revision.revision_id != id
                || revision.project_id != owner
                || revision.previous_revision_id != r.expected_revision_id
                || defaults.get(&revision.locale).copied() != r.expected_revision_id
                || get::<ContextStrategyDefaultRevision>(c, "default", id, owner)? != revision
            {
                return Err(corrupt());
            }
            let evaluation: StrategyEvaluation = get(c, "evaluation", r.evaluation_id, owner)?;
            let suite: StrategySuite = get(c, "suite", evaluation.suite_id, owner)?;
            if revision.locale != suite.locale
                || revision.evaluation_id != Some(r.evaluation_id)
                || revision.reference
                    != Some(ContextStrategyReference {
                        project_id: owner,
                        revision_id: id,
                        candidate_id: evaluation.candidate_id,
                    })
            {
                return Err(corrupt());
            }
            let qualification: Qualification = get(c, "qualification", id, owner)?;
            validate_qualification(c, &evaluation, &suite, &qualification)?;
            defaults.insert(revision.locale, id);
        }
        (
            "withdraw",
            Some(StrategyActionReceipt::Withdrawn {
                request: r,
                revision,
            }),
        ) => {
            if bytes(&r)? != request
                || r.action_id != id
                || r.project_id != owner
                || revision.action_id != id
                || revision.revision_id != id
                || revision.project_id != owner
                || revision.locale != r.locale
                || revision.previous_revision_id != r.expected_revision_id
                || defaults.get(&r.locale).copied() != r.expected_revision_id
                || revision.reference.is_some()
                || revision.evaluation_id.is_some()
                || get::<ContextStrategyDefaultRevision>(c, "default", id, owner)? != revision
            {
                return Err(corrupt());
            }
            let prior: ContextStrategyDefaultRevision = get(
                c,
                "default",
                r.expected_revision_id.ok_or_else(corrupt)?,
                owner,
            )?;
            if prior.reference.is_none() {
                return Err(corrupt());
            }
            defaults.insert(r.locale, id);
        }
        _ => return Err(corrupt()),
    }
    Ok(())
}

pub(super) fn validate_saved_action(
    c: &Connection,
    owner: ExecutionId,
    id: ExecutionId,
    kind: &str,
    request: Vec<u8>,
    receipt: StrategyActionReceipt,
) -> Result<(), ExecutionError> {
    let mut defaults = BTreeMap::new();
    let mut judgments = BTreeMap::new();
    let previous = |fact_kind: &str,
                    locale: Option<&str>,
                    association: Option<String>,
                    member: Option<String>|
     -> Result<Option<ExecutionId>, ExecutionError> {
        let value:Option<String>=c.query_row("SELECT fact_id FROM context_strategy_facts
            WHERE kind=?1 AND project_id=?2 AND (?3 IS NULL OR locale=?3)
            AND (?4 IS NULL OR association_id=?4) AND (?5 IS NULL OR member_id=?5)
            AND rowid<(SELECT rowid FROM context_strategy_facts WHERE kind=?1 AND project_id=?2 AND fact_id=?6)
            ORDER BY rowid DESC LIMIT 1",params![fact_kind,owner.to_string(),locale,association,member,id.to_string()],|r|r.get(0)).optional().map_err(sql)?;
        value.map(|value| ExecutionId::parse(&value)).transpose()
    };
    match &receipt {
        StrategyActionReceipt::Promoted { revision, .. }
        | StrategyActionReceipt::Withdrawn { revision, .. } => {
            if let Some(prior) = previous("default", Some(&revision.locale), None, None)? {
                defaults.insert(revision.locale.clone(), prior);
            }
        }
        StrategyActionReceipt::Judgment { judgment } => {
            let r = &judgment.request;
            if let Some(prior) = previous(
                "judgment",
                None,
                Some(r.evaluation_id.to_string()),
                Some(r.unit_id.to_string()),
            )? {
                judgments.insert((r.evaluation_id, r.unit_id), prior);
            }
        }
        _ => {}
    }
    validate_action(
        c,
        id,
        owner,
        kind,
        request,
        Some(receipt),
        &mut defaults,
        &mut judgments,
    )
}

fn validate_candidate(
    c: &Connection,
    request: &CaptureContextStrategy,
    value: &ContextStrategyCandidate,
) -> Result<(), ExecutionError> {
    request.source_context.validate()?;
    super::super::super::validate_text(&request.reason, false)?;
    super::super::super::validate_text(&request.exceptions, false)?;
    let mut original = evidence(c, &request.basis)?;
    original.current = true;
    if !request.source_context.is_enabled()
        || value.candidate_id != request.action_id
        || value.project_id != request.basis.project_id
        || value.locale != request.basis.locale
        || value.evidence != original
        || value.source_context != request.source_context
        || value.reason != request.reason
        || value.exceptions != request.exceptions
        || value.digest != digest(request)?
    {
        return Err(corrupt());
    }
    Ok(())
}

fn validate_suite(c: &Connection, suite: &StrategySuite) -> Result<(), ExecutionError> {
    let r = &suite.request;
    let candidate: ContextStrategyCandidate = get(c, "candidate", r.candidate_id, r.project_id)?;
    let ids: Vec<_> = r
        .calibration_unit_ids
        .iter()
        .chain(&r.holdout_unit_ids)
        .copied()
        .collect();
    if !(2..=20).contains(&ids.len())
        || r.calibration_unit_ids.is_empty()
        || r.holdout_unit_ids.is_empty()
        || ids.iter().collect::<BTreeSet<_>>().len() != ids.len()
        || r.holdout_unit_ids
            .contains(&candidate.evidence.basis.unit_id)
        || r.config.context_strategy.is_some()
        || r.config.share_context
        || r.config.share_terms
        || r.config.source_context != SourceContextSelection::default()
        || suite.suite_id != r.action_id
        || suite.project_id != r.project_id
        || suite.candidate_id != r.candidate_id
        || suite.locale != candidate.locale
        || suite.units.len() != ids.len()
        || suite.digest != digest(&(r, &suite.preview, &suite.units))?
    {
        return Err(corrupt());
    }
    let mut candidate_config = r.config.clone();
    candidate_config.source_context = candidate.source_context;
    let expected = ArenaConfig {
        variants: vec![r.config.clone(), candidate_config],
        max_items: r.config.max_items,
        max_requests: r.config.max_requests,
        concurrency: r.config.concurrency,
        blind: true,
        parent_attempt_id: None,
    };
    if suite.preview.config != expected
        || suite.preview.items.len() != ids.len() * 2
        || suite.preview.digest != arena::digest(&suite.preview.config, &suite.preview.items)?
    {
        return Err(corrupt());
    }
    let metadata = crate::persistence::read_metadata_from(c).map_err(|_| corrupt())?;
    suite.preview.fixed_input(metadata.project_id())?;
    for (index, unit) in suite.units.iter().enumerate() {
        let payload = &suite.preview.items[index * 2].item;
        if unit.unit_id != ids[index]
            || unit.holdout != r.holdout_unit_ids.contains(&unit.unit_id)
            || payload.unit_id != unit.unit_id
            || payload.target_locale != suite.locale
            || unit.source_revision_id != payload.source_revision_id
            || unit.review_basis.source_revision_id != payload.source_revision_id
            || unit.review_basis.source_snapshot_id != payload.source_snapshot_id
            || unit.terms.unit_id != unit.unit_id
            || unit.terms.locale != suite.locale
            || unit.terms.source_revision_id != payload.source_revision_id
            || source_binding(c, payload.source_snapshot_id)? != unit.source_binding
        {
            return Err(corrupt());
        }
        let source:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id JOIN source_units u ON u.unit_id=o.unit_id WHERE o.snapshot_id=?1 AND o.unit_id=?2 AND o.revision_id=?3 AND r.text=?4 AND u.project_id=?5)",params![payload.source_snapshot_id.to_string(),unit.unit_id.to_string(),payload.source_revision_id.to_string(),payload.source_text,suite.project_id.to_string()],|r|r.get(0)).map_err(sql)?;
        if !source {
            return Err(corrupt());
        }
        for term in unit
            .terms
            .entries
            .iter()
            .flat_map(|entry| entry.selected.iter().chain(&entry.conflicting))
        {
            let stored =
                super::super::super::term_by_revision(c, suite.project_id, term.revision_id)?
                    .ok_or_else(corrupt)?;
            if stored != *term {
                return Err(corrupt());
            }
        }
    }
    Ok(())
}

fn validate_capture(c: &Connection, capture: &CheckCapture) -> Result<(), ExecutionError> {
    let r = &capture.request;
    let evaluation: StrategyEvaluation = get(c, "evaluation", r.evaluation_id, r.project_id)?;
    let suite: StrategySuite = get(c, "suite", evaluation.suite_id, r.project_id)?;
    let (_, _, payload) = result_record(c, &evaluation, r.item_id, r.result_id, false)?;
    let unit = suite_unit(&suite, &payload)?;
    let (revision, text) =
        candidate_revision_record(c, &evaluation, r.item_id, r.result_id, false)?;
    let mut basis = unit.review_basis.clone();
    basis.selection_id = None;
    basis.revision_id = Some(revision);
    if capture.revision_id != revision || capture.basis != basis {
        return Err(corrupt());
    }
    // Recreate the original policy capture over its original source, resources
    // and unselected text. No mutable current selection participates here.
    let target = review::ReviewTarget {
        unit_id: unit.unit_id,
        locale: suite.locale.clone(),
        native_key: String::new(),
        source_snapshot_id: basis.source_snapshot_id,
        source_revision_id: basis.source_revision_id,
        source_text: payload.item.source_text,
        selection_id: None,
        revision_id: Some(revision),
        translation_text: Some(text.clone()),
        basis: String::new(),
        basis_evidence: basis,
        term_conflict: false,
        current_decision: None,
        current_check: None,
        current_fallback: None,
        current_waivers: Vec::new(),
    };
    let prepared = review::prepare_candidate_in(
        c,
        r.project_id,
        r.action_id,
        &target,
        None,
        revision,
        &text,
        &unit.terms,
        &[],
    )?;
    let plan = prepared.plan().ok_or_else(corrupt)?;
    if plan.binding() != &unit.source_binding
        || plan.basis() != capture.qa_basis
        || plan.fixed_checks().set() != &capture.required_checks
    {
        return Err(corrupt());
    }
    Ok(())
}

fn validate_check(c: &Connection, check: &StrategyCheckReceipt) -> Result<(), ExecutionError> {
    let r = &check.request;
    let capture: CheckCapture = get(c, "check-capture", r.action_id, r.project_id)?;
    let evaluation: StrategyEvaluation = get(c, "evaluation", r.evaluation_id, r.project_id)?;
    let suite: StrategySuite = get(c, "suite", evaluation.suite_id, r.project_id)?;
    let (_, _, payload) = result_record(c, &evaluation, r.item_id, r.result_id, false)?;
    let unit = suite_unit(&suite, &payload)?;
    if check.revision_id != capture.revision_id
        || check.basis != capture.basis
        || check.evidence.qa_basis != capture.qa_basis
        || check.evidence.required_checks != capture.required_checks
        || check.evidence.source_binding != unit.source_binding
        || !check.evidence.advisory_checks.is_empty()
    {
        return Err(corrupt());
    }
    review::validate_candidate_evidence(
        c,
        r.project_id,
        r.action_id,
        unit.unit_id,
        &suite.locale,
        &check.basis,
        &check.rules,
        &check.evidence,
    )
}

fn validate_judgment(c: &Connection, judgment: &StrategyJudgment) -> Result<(), ExecutionError> {
    let r = &judgment.request;
    super::super::super::validate_text(&r.notes, false)?;
    if r.elapsed_seconds.is_some_and(|n| n > 31_536_000)
        || r.modified_characters.is_some_and(|n| n > 10_000_000)
    {
        return Err(corrupt());
    }
    let evaluation: StrategyEvaluation = get(c, "evaluation", r.evaluation_id, r.project_id)?;
    let suite: StrategySuite = get(c, "suite", evaluation.suite_id, r.project_id)?;
    if !suite
        .units
        .iter()
        .any(|u| u.holdout && u.unit_id == r.unit_id)
    {
        return Err(corrupt());
    }
    let input = evaluation_input(c, r.project_id, r.evaluation_id)?;
    for (slot, result) in [
        (0, judgment.baseline_result_id),
        (1, judgment.candidate_result_id),
    ] {
        let actual = crate::persistence::ledger::load_result(c, &input, result)?;
        let (_, _, payload) =
            result_record(c, &evaluation, actual.envelope().item_id, result, false)?;
        if payload.slot != slot || payload.item.unit_id != r.unit_id {
            return Err(corrupt());
        }
    }
    Ok(())
}

fn validate_qualification(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    suite: &StrategySuite,
    value: &Qualification,
) -> Result<(), ExecutionError> {
    let input = evaluation_input(c, evaluation.project_id, evaluation.evaluation_id)?;
    let mut items = BTreeSet::new();
    let mut units = BTreeSet::new();
    let mut preferred = false;
    for id in &value.checks {
        let check: StrategyCheckReceipt = get(c, "check", *id, evaluation.project_id)?;
        if check.request.evaluation_id != evaluation.evaluation_id
            || !items.insert(check.request.item_id)
            || !review::candidate_checks_clean(&check.rules, &check.evidence)
        {
            return Err(corrupt());
        }
        validate_check(c, &check)?;
    }
    if items != input.envelope().items.iter().map(|i| i.item_id).collect() {
        return Err(corrupt());
    }
    for id in &value.judgments {
        let judgment: StrategyJudgment = get(c, "judgment", *id, evaluation.project_id)?;
        if judgment.request.evaluation_id != evaluation.evaluation_id
            || !units.insert(judgment.request.unit_id)
            || judgment.request.preference == StrategyPreference::BaselinePreferred
        {
            return Err(corrupt());
        }
        validate_judgment(c, &judgment)?;
        // The human comparison and mandatory checks must cover the same two
        // immutable outputs, even after the original Arena has newer results.
        for result in [judgment.baseline_result_id, judgment.candidate_result_id] {
            let matched = value.checks.iter().any(|id| {
                get::<StrategyCheckReceipt>(c, "check", *id, evaluation.project_id)
                    .is_ok_and(|check| check.request.result_id == result)
            });
            if !matched {
                return Err(corrupt());
            }
        }
        preferred |= judgment.request.preference == StrategyPreference::CandidatePreferred;
    }
    if !preferred
        || units
            != suite
                .units
                .iter()
                .filter(|u| u.holdout)
                .map(|u| u.unit_id)
                .collect()
    {
        return Err(corrupt());
    }
    Ok(())
}
