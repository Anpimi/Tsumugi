use super::*;
use crate::{
    ai::arena::{self, ArenaConfig},
    execution::{FixedResult, InputEnvelope},
    persistence::review::{
        self, ComputedReviewEvidence, PreparedReviewAdoption, PreparedReviewCheck,
    },
};
use serde::de::DeserializeOwned;

#[path = "validation.rs"]
mod validation;
pub(in crate::persistence) use validation::validate;

const TABLES: &[(&str, &str)] = &[
    (
        "context_strategy_facts",
        "CREATE TABLE context_strategy_facts (kind TEXT NOT NULL, fact_id TEXT NOT NULL, project_id TEXT NOT NULL, payload BLOB NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64), locale TEXT, association_id TEXT, member_id TEXT, PRIMARY KEY(kind,fact_id))",
    ),
    (
        "context_strategy_actions",
        "CREATE TABLE context_strategy_actions (action_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, request BLOB NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64), receipt BLOB)",
    ),
];

fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "strategy-record")
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    super::super::sql(error)
}
fn bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, ExecutionError> {
    codec::encode(value, MAX_INPUT_BYTES)
}
fn digest<T: Serialize>(value: &T) -> Result<String, ExecutionError> {
    Ok(codec::digest(&bytes(value)?))
}
fn project(c: &Connection, id: ExecutionId, locale: Option<&str>) -> Result<(), ExecutionError> {
    let metadata = crate::persistence::read_metadata_from(c).map_err(|_| corrupt())?;
    if metadata.project_id().to_string() != id.to_string()
        || locale.is_some_and(|locale| {
            !metadata
                .target_locales()
                .iter()
                .any(|l| l.as_str() == locale)
        })
    {
        return Err(fail(ErrorCode::DependencyConflict, "strategy-project"));
    }
    Ok(())
}
fn connection(store: &ProjectStore) -> Result<&Connection, ExecutionError> {
    store
        .connection()
        .map_err(|_| fail(ErrorCode::StorageFailed, "strategy-read"))
}
fn mutate<T>(
    store: &ProjectStore,
    operation: impl FnOnce(&Connection) -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    if store.is_reconciling() {
        return Err(fail(ErrorCode::OutcomeUnknown, "strategy-session"));
    }
    let c = connection(store)?;
    let tx =
        rusqlite::Transaction::new_unchecked(c, TransactionBehavior::Immediate).map_err(sql)?;
    let observer = store.changes.observe(&tx, crate::ChangeScope::Resources);
    let value = operation(&tx)?;
    observer.commit(tx).map_err(|_| {
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        fail(ErrorCode::OutcomeUnknown, "strategy-commit")
    })?;
    Ok(value)
}
fn put<T: Serialize>(
    c: &Connection,
    kind: &str,
    id: ExecutionId,
    project: ExecutionId,
    value: &T,
) -> Result<(), ExecutionError> {
    let payload = bytes(value)?;
    let value = serde_json::to_value(value).map_err(|_| corrupt())?;
    let locale = value.get("locale").and_then(|v| v.as_str());
    let request = value.get("request");
    let association = request
        .and_then(|v| v.get("evaluationId"))
        .and_then(|v| v.as_str());
    let member = request
        .and_then(|v| {
            v.get(if kind == "judgment" {
                "unitId"
            } else {
                "itemId"
            })
        })
        .and_then(|v| v.as_str());
    c.execute(
        "INSERT INTO context_strategy_facts VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            kind,
            id.to_string(),
            project.to_string(),
            payload,
            codec::digest(&payload),
            locale,
            association,
            member
        ],
    )
    .map_err(sql)?;
    Ok(())
}
fn get<T: DeserializeOwned>(
    c: &Connection,
    kind: &str,
    id: ExecutionId,
    project: ExecutionId,
) -> Result<T, ExecutionError> {
    let row: Option<(Vec<u8>,String)> = c.query_row("SELECT payload,digest FROM context_strategy_facts WHERE kind=?1 AND fact_id=?2 AND project_id=?3",params![kind,id.to_string(),project.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    let (payload, expected) =
        row.ok_or_else(|| fail(ErrorCode::InvalidInput, "strategy-missing"))?;
    if codec::digest(&payload) != expected {
        return Err(corrupt());
    }
    codec::decode(&payload, MAX_INPUT_BYTES)
}
fn page<T: DeserializeOwned>(
    c: &Connection,
    kind: &str,
    project_id: ExecutionId,
    locale: &str,
    offset: u32,
    limit: u32,
) -> Result<(Vec<T>, Option<u32>), ExecutionError> {
    project(c, project_id, Some(locale))?;
    if limit == 0 || limit > 50 {
        return Err(fail(ErrorCode::LimitExceeded, "strategy-page"));
    }
    let mut statement=c.prepare("SELECT fact_id FROM context_strategy_facts WHERE kind=?1 AND project_id=?2 AND locale=?3 ORDER BY rowid DESC LIMIT ?4 OFFSET ?5").map_err(sql)?;
    let mut ids = statement
        .query_map(
            params![kind, project_id.to_string(), locale, limit + 1, offset],
            |r| r.get::<_, String>(0),
        )
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    let next = if ids.len() > limit as usize {
        Some(
            offset
                .checked_add(limit)
                .ok_or_else(|| fail(ErrorCode::LimitExceeded, "strategy-page"))?,
        )
    } else {
        None
    };
    ids.truncate(limit as usize);
    Ok((
        ids.into_iter()
            .map(|id| get(c, kind, ExecutionId::parse(&id)?, project_id))
            .collect::<Result<_, _>>()?,
        next,
    ))
}
fn replay<T: Serialize>(
    c: &Connection,
    project: ExecutionId,
    action: ExecutionId,
    kind: &str,
    request: &T,
) -> Result<Option<StrategyActionReceipt>, ExecutionError> {
    let prior: Option<(String,String,Vec<u8>,String,Option<Vec<u8>>)> = c.query_row("SELECT project_id,kind,request,request_digest,receipt FROM context_strategy_actions WHERE action_id=?1",[action.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql)?;
    let Some((owner, prior_kind, prior, expected, receipt)) = prior else {
        return Ok(None);
    };
    if codec::digest(&prior) != expected {
        return Err(corrupt());
    }
    if owner != project.to_string() || prior_kind != kind || prior != bytes(request)? {
        return Err(fail(ErrorCode::ResultMismatch, "strategy-action"));
    }
    let receipt = decode_receipt(&receipt.ok_or_else(corrupt)?, project, action, kind, &prior)?;
    Ok(Some(receipt))
}
fn decode_receipt(
    payload: &[u8],
    project: ExecutionId,
    action: ExecutionId,
    kind: &str,
    request: &[u8],
) -> Result<StrategyActionReceipt, ExecutionError> {
    let value: StrategyActionReceipt = codec::decode(payload, MAX_INPUT_BYTES)?;
    let (k, p, a, original) = match &value {
        StrategyActionReceipt::Candidate { request, .. } => (
            "candidate",
            request.basis.project_id,
            request.action_id,
            bytes(request)?,
        ),
        StrategyActionReceipt::Suite { request, .. } => (
            "suite",
            request.project_id,
            request.action_id,
            bytes(request)?,
        ),
        StrategyActionReceipt::Evaluation { request, .. } => (
            "evaluation",
            request.project_id,
            request.action_id,
            bytes(request)?,
        ),
        StrategyActionReceipt::Check { receipt } => (
            "check",
            receipt.request.project_id,
            receipt.request.action_id,
            bytes(&receipt.request)?,
        ),
        StrategyActionReceipt::Judgment { judgment } => (
            "judgment",
            judgment.request.project_id,
            judgment.request.action_id,
            bytes(&judgment.request)?,
        ),
        StrategyActionReceipt::Promoted { request, .. } => (
            "promote",
            request.project_id,
            request.action_id,
            bytes(request)?,
        ),
        StrategyActionReceipt::Withdrawn { request, .. } => (
            "withdraw",
            request.project_id,
            request.action_id,
            bytes(request)?,
        ),
    };
    if (k, p, a) != (kind, project, action) || original != request {
        return Err(corrupt());
    }
    Ok(value)
}
fn record<T: Serialize>(
    c: &Connection,
    project: ExecutionId,
    action: ExecutionId,
    kind: &str,
    request: &T,
    receipt: Option<&StrategyActionReceipt>,
) -> Result<(), ExecutionError> {
    let request = bytes(request)?;
    let receipt = receipt.map(bytes).transpose()?;
    c.execute("INSERT INTO context_strategy_actions VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(action_id) DO UPDATE SET receipt=excluded.receipt WHERE context_strategy_actions.request=excluded.request AND context_strategy_actions.kind=excluded.kind AND context_strategy_actions.project_id=excluded.project_id", params![action.to_string(),project.to_string(),kind,request,codec::digest(&request),receipt]).map_err(sql)?;
    Ok(())
}
pub(in crate::persistence) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| name.to_string())
}
pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, statement) in TABLES {
        c.execute_batch(statement)?;
    }
    c.execute_batch("CREATE INDEX context_strategy_members ON context_strategy_facts(kind,project_id,association_id,member_id); CREATE INDEX context_strategy_locales ON context_strategy_facts(kind,project_id,locale);")?;
    Ok(())
}
fn evidence(
    c: &Connection,
    basis: &CorrectionTermBasis,
) -> Result<CorrectionTermEvidence, ExecutionError> {
    let value = super::super::correction::evidence_in(
        c,
        basis.project_id,
        basis.unit_id,
        &basis.locale,
        basis.after.selection_id,
    )?;
    if &value.basis != basis {
        return Err(fail(ErrorCode::ResultMismatch, "strategy-correction"));
    }
    Ok(value)
}
fn candidate_current(
    c: &Connection,
    candidate: &ContextStrategyCandidate,
) -> Result<(), ExecutionError> {
    if !evidence(c, &candidate.evidence.basis)?.current {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "strategy-correction-stale",
        ));
    }
    Ok(())
}
fn current_default(
    c: &Connection,
    project: ExecutionId,
    locale: &str,
) -> Result<Option<ContextStrategyDefaultRevision>, ExecutionError> {
    let id:Option<String>=c.query_row("SELECT fact_id FROM context_strategy_facts WHERE kind='default' AND project_id=?1 AND locale=?2 ORDER BY rowid DESC LIMIT 1",params![project.to_string(),locale],|r|r.get(0)).optional().map_err(sql)?;
    id.map(|id| get(c, "default", ExecutionId::parse(&id)?, project))
        .transpose()
}
pub(in crate::persistence) fn verify_config(
    store: &ProjectStore,
    config: &AiConfig,
    locale: &str,
) -> Result<(), ExecutionError> {
    verify_config_in(connection(store)?, config, locale)
}
fn verify_config_in(c: &Connection, config: &AiConfig, locale: &str) -> Result<(), ExecutionError> {
    let Some(reference) = &config.context_strategy else {
        return Ok(());
    };
    project(c, reference.project_id, None)?;
    let revision: ContextStrategyDefaultRevision =
        get(c, "default", reference.revision_id, reference.project_id)?;
    let candidate: ContextStrategyCandidate =
        get(c, "candidate", reference.candidate_id, reference.project_id)?;
    if revision.reference.as_ref() != Some(reference)
        || revision.locale != locale
        || candidate.locale != locale
        || candidate.source_context != config.source_context
    {
        return Err(fail(ErrorCode::ResultMismatch, "strategy-reference"));
    }
    Ok(())
}

impl ProjectStore {
    pub fn read_strategy_action(
        &self,
        project_id: ExecutionId,
        action: ExecutionId,
    ) -> Result<Option<StrategyActionReceipt>, ExecutionError> {
        let c = connection(self)?;
        project(c, project_id, None)?;
        let value:Option<(String,Vec<u8>,String,Option<Vec<u8>>)>=c.query_row("SELECT kind,request,request_digest,receipt FROM context_strategy_actions WHERE action_id=?1 AND project_id=?2",params![action.to_string(),project_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
        let Some((kind, request, expected, receipt)) = value else {
            return Ok(None);
        };
        if codec::digest(&request) != expected {
            return Err(corrupt());
        }
        Ok(Some(decode_receipt(
            &receipt.ok_or_else(corrupt)?,
            project_id,
            action,
            &kind,
            &request,
        )?))
    }
    pub fn capture_context_strategy(
        &mut self,
        request: &CaptureContextStrategy,
    ) -> Result<ContextStrategyCandidate, ExecutionError> {
        if let Some(StrategyActionReceipt::Candidate { candidate, .. }) = replay(
            connection(self)?,
            request.basis.project_id,
            request.action_id,
            "candidate",
            request,
        )? {
            return Ok(candidate);
        }
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Candidate { candidate, .. }) = replay(
                c,
                request.basis.project_id,
                request.action_id,
                "candidate",
                request,
            )? {
                return Ok(candidate);
            }
            project(c, request.basis.project_id, Some(&request.basis.locale))?;
            request.source_context.validate()?;
            if !request.source_context.is_enabled() {
                return Err(fail(ErrorCode::InvalidInput, "strategy-selection"));
            }
            super::super::validate_text(&request.reason, false)?;
            super::super::validate_text(&request.exceptions, false)?;
            let origin = evidence(c, &request.basis)?;
            if !origin.current {
                return Err(fail(
                    ErrorCode::DependencyConflict,
                    "strategy-correction-stale",
                ));
            }
            let candidate = ContextStrategyCandidate {
                candidate_id: request.action_id,
                project_id: request.basis.project_id,
                locale: request.basis.locale.clone(),
                evidence: origin,
                source_context: request.source_context.clone(),
                reason: request.reason.clone(),
                exceptions: request.exceptions.clone(),
                digest: digest(request)?,
            };
            put(
                c,
                "candidate",
                candidate.candidate_id,
                candidate.project_id,
                &candidate,
            )?;
            record(
                c,
                candidate.project_id,
                request.action_id,
                "candidate",
                request,
                Some(&StrategyActionReceipt::Candidate {
                    request: request.clone(),
                    candidate: candidate.clone(),
                }),
            )?;
            Ok(candidate)
        })
    }
    pub fn read_context_strategy(
        &self,
        project_id: ExecutionId,
        id: ExecutionId,
    ) -> Result<ContextStrategyCandidate, ExecutionError> {
        let mut value: ContextStrategyCandidate =
            get(connection(self)?, "candidate", id, project_id)?;
        value.evidence.current = evidence(connection(self)?, &value.evidence.basis)?.current;
        Ok(value)
    }
    pub fn list_context_strategies(
        &self,
        project_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<ContextStrategyCandidatePage, ExecutionError> {
        let (mut rows, next_offset) = page::<ContextStrategyCandidate>(
            connection(self)?,
            "candidate",
            project_id,
            locale,
            offset,
            limit,
        )?;
        for value in &mut rows {
            value.evidence.current = evidence(connection(self)?, &value.evidence.basis)?.current;
        }
        Ok(ContextStrategyCandidatePage { rows, next_offset })
    }
    pub fn read_strategy_suite(
        &self,
        project_id: ExecutionId,
        id: ExecutionId,
    ) -> Result<StrategySuite, ExecutionError> {
        get(connection(self)?, "suite", id, project_id)
    }
    pub fn read_strategy_evaluation(
        &self,
        project_id: ExecutionId,
        id: ExecutionId,
    ) -> Result<StrategyEvaluation, ExecutionError> {
        get(connection(self)?, "evaluation", id, project_id)
    }
    pub fn read_context_strategy_default(
        &self,
        project_id: ExecutionId,
        locale: &str,
    ) -> Result<Option<ContextStrategyDefaultRevision>, ExecutionError> {
        project(connection(self)?, project_id, Some(locale))?;
        current_default(connection(self)?, project_id, locale)
    }
    pub fn list_context_strategy_defaults(
        &self,
        project_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<ContextStrategyDefaultPage, ExecutionError> {
        let (rows, next_offset) = page(
            connection(self)?,
            "default",
            project_id,
            locale,
            offset,
            limit,
        )?;
        Ok(ContextStrategyDefaultPage { rows, next_offset })
    }
    pub fn list_strategy_evaluations(
        &self,
        project_id: ExecutionId,
        locale: &str,
        offset: u32,
        limit: u32,
    ) -> Result<StrategyEvaluationPage, ExecutionError> {
        let (rows, next_offset) = page(
            connection(self)?,
            "evaluation",
            project_id,
            locale,
            offset,
            limit,
        )?;
        Ok(StrategyEvaluationPage { rows, next_offset })
    }

    pub fn capture_strategy_suite(
        &mut self,
        request: &CaptureStrategySuite,
    ) -> Result<StrategySuite, ExecutionError> {
        if let Some(StrategyActionReceipt::Suite { suite, .. }) = replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "suite",
            request,
        )? {
            return Ok(suite);
        }
        let candidate = self.read_context_strategy(request.project_id, request.candidate_id)?;
        project(
            connection(self)?,
            request.project_id,
            Some(&candidate.locale),
        )?;
        request.config.validate()?;
        let units: Vec<_> = request
            .calibration_unit_ids
            .iter()
            .chain(&request.holdout_unit_ids)
            .copied()
            .collect();
        if units.len() < 2
            || units.len() > 20
            || request.calibration_unit_ids.is_empty()
            || request.holdout_unit_ids.is_empty()
            || units.iter().collect::<BTreeSet<_>>().len() != units.len()
            || request
                .holdout_unit_ids
                .contains(&candidate.evidence.basis.unit_id)
            || request.config.context_strategy.is_some()
            || request.config.share_terms
            || request.config.share_context
            || request.config.source_context != SourceContextSelection::default()
        {
            return Err(fail(ErrorCode::InvalidInput, "strategy-suite-scope"));
        }
        candidate_current(connection(self)?, &candidate)?;
        let baseline = request.config.clone();
        let mut configured = baseline.clone();
        configured.source_context = candidate.source_context.clone();
        let config = ArenaConfig {
            variants: vec![baseline, configured],
            max_items: request.config.max_items,
            max_requests: request.config.max_requests,
            concurrency: request.config.concurrency,
            blind: true,
            parent_attempt_id: None,
        };
        let preview = self.preview_arena(config, &candidate.locale, &units)?;
        let mut frozen = Vec::new();
        for unit in &units {
            let target = self.review_target(request.project_id, *unit, &candidate.locale)?;
            let source_binding = self
                .source_review_binding(target.source_snapshot_id)?
                .ok_or_else(|| fail(ErrorCode::DependencyConflict, "strategy-review-required"))?;
            frozen.push(StrategySuiteUnit {
                unit_id: *unit,
                holdout: request.holdout_unit_ids.contains(unit),
                source_revision_id: target.source_revision_id,
                review_basis: target.basis_evidence,
                terms: self.resolve_terms(request.project_id, *unit, &candidate.locale)?,
                source_binding,
            });
        }
        let suite = StrategySuite {
            suite_id: request.action_id,
            request: request.clone(),
            candidate_id: candidate.candidate_id,
            project_id: request.project_id,
            locale: candidate.locale.clone(),
            digest: digest(&(request, &preview, &frozen))?,
            preview,
            units: frozen,
        };
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Suite { suite, .. }) =
                replay(c, request.project_id, request.action_id, "suite", request)?
            {
                return Ok(suite);
            }
            candidate_current(c, &candidate)?;
            suite_current(c, &suite)?;
            put(c, "suite", suite.suite_id, suite.project_id, &suite)?;
            record(
                c,
                suite.project_id,
                request.action_id,
                "suite",
                request,
                Some(&StrategyActionReceipt::Suite {
                    request: request.clone(),
                    suite: suite.clone(),
                }),
            )?;
            Ok(suite.clone())
        })
    }

    pub fn capture_strategy_evaluation(
        &mut self,
        request: &CaptureStrategyEvaluation,
    ) -> Result<StrategyEvaluation, ExecutionError> {
        if let Some(StrategyActionReceipt::Evaluation { evaluation, .. }) = replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "evaluation",
            request,
        )? {
            return Ok(evaluation);
        }
        let suite = self.read_strategy_suite(request.project_id, request.suite_id)?;
        if suite.candidate_id != request.candidate_id {
            return Err(fail(ErrorCode::ResultMismatch, "strategy-suite-candidate"));
        }
        self.check_strategy_suite_current(&suite)?;
        let input = suite
            .preview
            .fixed_input(self.metadata().map_err(|_| corrupt())?.project_id())?;
        let mut envelope = input.envelope().clone();
        let mut settings = arena::settings(&input)?;
        settings.strategy_evaluation = Some(StrategyEvaluationBinding {
            project_id: request.project_id,
            evaluation_id: request.action_id,
            candidate_id: request.candidate_id,
            suite_id: request.suite_id,
            suite_digest: suite.digest.clone(),
        });
        envelope.settings = serde_json::to_value(settings).map_err(|_| corrupt())?;
        let input = FixedInput::capture(envelope)?;
        arena::settings(&input)?;
        let evaluation = StrategyEvaluation {
            evaluation_id: request.action_id,
            request: request.clone(),
            project_id: request.project_id,
            candidate_id: request.candidate_id,
            suite_id: request.suite_id,
            locale: suite.locale.clone(),
            attempt_id: input.envelope().attempt_id,
            input_digest: input.digest().into(),
        };
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Evaluation { evaluation, .. }) = replay(
                c,
                request.project_id,
                request.action_id,
                "evaluation",
                request,
            )? {
                return Ok(evaluation);
            }
            suite_current(c, &suite)?;
            let candidate: ContextStrategyCandidate =
                get(c, "candidate", request.candidate_id, request.project_id)?;
            candidate_current(c, &candidate)?;
            put(
                c,
                "evaluation",
                evaluation.evaluation_id,
                request.project_id,
                &evaluation,
            )?;
            put(
                c,
                "evaluation-input",
                evaluation.evaluation_id,
                request.project_id,
                input.envelope(),
            )?;
            record(
                c,
                request.project_id,
                request.action_id,
                "evaluation",
                request,
                Some(&StrategyActionReceipt::Evaluation {
                    request: request.clone(),
                    evaluation: evaluation.clone(),
                }),
            )?;
            Ok(evaluation.clone())
        })
    }
    pub fn strategy_evaluation_input(
        &self,
        project_id: ExecutionId,
        id: ExecutionId,
    ) -> Result<FixedInput, ExecutionError> {
        evaluation_input(connection(self)?, project_id, id)
    }
    fn check_strategy_suite_current(&self, suite: &StrategySuite) -> Result<(), ExecutionError> {
        suite_current(connection(self)?, suite)
    }
    pub fn check_strategy_evaluation_current(
        &self,
        project_id: ExecutionId,
        id: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let evaluation = self.read_strategy_evaluation(project_id, id)?;
        let suite = self.read_strategy_suite(project_id, evaluation.suite_id)?;
        let candidate = self.read_context_strategy(project_id, evaluation.candidate_id)?;
        candidate_current(connection(self)?, &candidate)?;
        suite_current(connection(self)?, &suite)?;
        let input = self.strategy_evaluation_input(project_id, id)?;
        match self.execution_input(evaluation.attempt_id) {
            Ok(stored) if stored.bytes() != input.bytes() => {
                return Err(fail(ErrorCode::ResultMismatch, "strategy-evaluation-input"));
            }
            Ok(_) => {}
            Err(error)
                if error.code == ErrorCode::InvalidInput && error.stage == "execution-storage" => {}
            Err(error) => return Err(error),
        }
        Ok(())
    }
}

fn source_binding(
    c: &Connection,
    snapshot: ExecutionId,
) -> Result<SourceReviewBinding, ExecutionError> {
    let (_, (input, _, _, _)) = crate::persistence::content::snapshot_rows(c, snapshot, true)?;
    crate::content::SourceSettings::from_input(&input)?
        .review
        .ok_or_else(|| fail(ErrorCode::DependencyConflict, "strategy-review-required"))
}
fn suite_current(c: &Connection, suite: &StrategySuite) -> Result<(), ExecutionError> {
    project(c, suite.project_id, Some(&suite.locale))?;
    let baseline: i64 = c
        .query_row(
            "SELECT COALESCE(MAX(rowid),0) FROM resource_changes",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let baseline = u64::try_from(baseline).map_err(|_| corrupt())?;
    if suite
        .preview
        .items
        .iter()
        .any(|p| p.item.resource_baseline != baseline)
    {
        return Err(fail(ErrorCode::DependencyConflict, "strategy-suite-stale"));
    }
    for unit in &suite.units {
        let target = review::target_in(c, suite.project_id, unit.unit_id, &suite.locale)?;
        if target.basis_evidence != unit.review_basis
            || source_binding(c, target.source_snapshot_id)? != unit.source_binding
            || super::super::resolve_terms_in(c, suite.project_id, unit.unit_id, &suite.locale)?
                != unit.terms
        {
            return Err(fail(ErrorCode::DependencyConflict, "strategy-suite-stale"));
        }
    }
    Ok(())
}
fn evaluation_input(
    c: &Connection,
    project: ExecutionId,
    id: ExecutionId,
) -> Result<FixedInput, ExecutionError> {
    let evaluation: StrategyEvaluation = get(c, "evaluation", id, project)?;
    let suite: StrategySuite = get(c, "suite", evaluation.suite_id, project)?;
    let envelope: InputEnvelope = get(c, "evaluation-input", id, project)?;
    let input = FixedInput::capture(envelope)?;
    let settings = arena::settings(&input)?;
    let expected = StrategyEvaluationBinding {
        project_id: project,
        evaluation_id: id,
        candidate_id: evaluation.candidate_id,
        suite_id: evaluation.suite_id,
        suite_digest: suite.digest.clone(),
    };
    if settings.strategy_evaluation.as_ref() != Some(&expected)
        || input.digest() != evaluation.input_digest
        || input.envelope().attempt_id != evaluation.attempt_id
        || settings.config != suite.preview.config
        || input.envelope().items.len() != suite.preview.items.len()
    {
        return Err(corrupt());
    }
    for (raw, expected) in input.envelope().items.iter().zip(&suite.preview.items) {
        if arena::item_payload(&input, raw.item_id)? != *expected {
            return Err(corrupt());
        }
    }
    Ok(input)
}

/// Permanent provenance is checked on every original ledger load. Current
/// defaults are intentionally irrelevant to an already captured input.
pub(in crate::persistence) fn verify_input_binding(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let owner = input.envelope().project_id;
    match input.envelope().operation.as_str() {
        crate::ai::OPERATION => {
            let config = crate::ai::settings(input)?.config;
            for item in &input.envelope().items {
                let payload = crate::ai::item_payload(input, item.item_id)?;
                if config
                    .context_strategy
                    .as_ref()
                    .is_some_and(|r| r.project_id != owner)
                {
                    return Err(fail(ErrorCode::ResultMismatch, "strategy-reference"));
                }
                verify_config_in(c, &config, &payload.target_locale)?;
            }
        }
        arena::OPERATION => {
            let settings = arena::settings(input)?;
            for item in &input.envelope().items {
                let payload = arena::item_payload(input, item.item_id)?;
                let config = settings.config.request_config(payload.slot)?;
                if config
                    .context_strategy
                    .as_ref()
                    .is_some_and(|r| r.project_id != owner)
                {
                    return Err(fail(ErrorCode::ResultMismatch, "strategy-reference"));
                }
                verify_config_in(c, &config, &payload.item.target_locale)?;
            }
            if let Some(binding) = settings.strategy_evaluation {
                let expected = evaluation_input(c, owner, binding.evaluation_id)?;
                if input.bytes() != expected.bytes() {
                    return Err(fail(ErrorCode::ResultMismatch, "strategy-evaluation-input"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Only a newly admitted experiment must still match its proposal and frozen
/// suite. Receipt-first recovery of an accepted attempt keeps its old input.
pub(in crate::persistence) fn verify_admission(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    if input.envelope().operation == arena::OPERATION {
        if let Some(binding) = arena::settings(input)?.strategy_evaluation {
            let evaluation: StrategyEvaluation =
                get(c, "evaluation", binding.evaluation_id, binding.project_id)?;
            let suite: StrategySuite = get(c, "suite", evaluation.suite_id, binding.project_id)?;
            let candidate: ContextStrategyCandidate =
                get(c, "candidate", evaluation.candidate_id, binding.project_id)?;
            candidate_current(c, &candidate)?;
            suite_current(c, &suite)?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckCapture {
    request: StrategyCheckRequest,
    revision_id: ExecutionId,
    basis: ReviewBasis,
    qa_basis: String,
    required_checks: tsumugi_plugin_sdk::RequiredCheckSet,
}
fn result_for(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    item: ExecutionId,
    result: ExecutionId,
) -> Result<(FixedInput, FixedResult, crate::ai::arena::ArenaItem), ExecutionError> {
    result_record(c, evaluation, item, result, true)
}
fn result_record(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    item: ExecutionId,
    result: ExecutionId,
    current: bool,
) -> Result<(FixedInput, FixedResult, crate::ai::arena::ArenaItem), ExecutionError> {
    let input = evaluation_input(c, evaluation.project_id, evaluation.evaluation_id)?;
    let accepted = crate::persistence::ledger::load_input(c, evaluation.attempt_id)?;
    if accepted.bytes() != input.bytes() {
        return Err(fail(ErrorCode::ResultMismatch, "strategy-evaluation-input"));
    }
    if current {
        let current: Option<String> = c
            .query_row(
                "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![evaluation.attempt_id.to_string(), item.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if current.as_deref() != Some(result.to_string().as_str()) {
            return Err(fail(ErrorCode::ResultMismatch, "strategy-result"));
        }
    }
    let actual = crate::persistence::ledger::load_result(c, &input, result)?;
    if actual.envelope().item_id != item
        || actual.envelope().outcome != crate::execution::ExecutionState::Succeeded
    {
        return Err(fail(ErrorCode::OutputInvalid, "strategy-result"));
    }
    arena::validate_output(&input, &actual)?;
    let payload = arena::item_payload(&input, item)?;
    Ok((input, actual, payload))
}
fn candidate_revision(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    item: ExecutionId,
    result: ExecutionId,
) -> Result<(ExecutionId, String), ExecutionError> {
    candidate_revision_record(c, evaluation, item, result, true)
}
fn candidate_revision_record(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    item: ExecutionId,
    result: ExecutionId,
    current: bool,
) -> Result<(ExecutionId, String), ExecutionError> {
    let (_, actual, payload) = result_record(c, evaluation, item, result, current)?;
    let output = arena::validate_output(
        &evaluation_input(c, evaluation.project_id, evaluation.evaluation_id)?,
        &actual,
    )?;
    let row:Option<(String,String)>=c.query_row("SELECT revision_id,text FROM translation_revisions WHERE project_id=?1 AND attempt_id=?2 AND item_id=?3 AND result_id=?4 AND unit_id=?5 AND locale=?6 AND origin_kind='ai' ORDER BY ordinal LIMIT 1",params![evaluation.project_id.to_string(),evaluation.attempt_id.to_string(),item.to_string(),result.to_string(),payload.item.unit_id.to_string(),payload.item.target_locale],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql)?;
    let (id, text) = row.ok_or_else(|| {
        fail(
            ErrorCode::DependencyConflict,
            "strategy-candidate-not-saved",
        )
    })?;
    if text != output.text {
        return Err(corrupt());
    }
    Ok((ExecutionId::parse(&id)?, text))
}
fn suite_unit<'a>(
    suite: &'a StrategySuite,
    payload: &arena::ArenaItem,
) -> Result<&'a StrategySuiteUnit, ExecutionError> {
    suite
        .units
        .iter()
        .find(|unit| unit.unit_id == payload.item.unit_id)
        .ok_or_else(corrupt)
}
fn latest_checks(
    c: &Connection,
    project_id: ExecutionId,
    evaluation: ExecutionId,
) -> Result<Vec<StrategyCheckReceipt>, ExecutionError> {
    // A suite has at most forty inputs. Historical check actions remain
    // individually addressable; its current view keeps one proof per input.
    latest_members(c, "check", project_id, evaluation, 40)
}
fn latest_judgments(
    c: &Connection,
    project_id: ExecutionId,
    evaluation: ExecutionId,
) -> Result<Vec<StrategyJudgment>, ExecutionError> {
    latest_members(c, "judgment", project_id, evaluation, 20)
}
fn latest_members<T: DeserializeOwned>(
    c: &Connection,
    kind: &str,
    project: ExecutionId,
    evaluation: ExecutionId,
    bound: usize,
) -> Result<Vec<T>, ExecutionError> {
    let limit = i64::try_from(bound + 1).map_err(|_| corrupt())?;
    let mut statement=c.prepare("SELECT fact_id FROM context_strategy_facts WHERE rowid IN (SELECT MAX(rowid) FROM context_strategy_facts WHERE kind=?1 AND project_id=?2 AND association_id=?3 GROUP BY member_id) ORDER BY member_id LIMIT ?4").map_err(sql)?;
    let ids = statement
        .query_map(
            params![kind, project.to_string(), evaluation.to_string(), limit],
            |r| r.get::<_, String>(0),
        )
        .map_err(sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql)?;
    if ids.len() > bound {
        return Err(corrupt());
    }
    ids.into_iter()
        .map(|id| get(c, kind, ExecutionId::parse(&id)?, project))
        .collect()
}
fn unit_results(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    unit: ExecutionId,
) -> Result<(ExecutionId, ExecutionId), ExecutionError> {
    let input = evaluation_input(c, evaluation.project_id, evaluation.evaluation_id)?;
    let mut results = [None, None];
    for raw in &input.envelope().items {
        let payload = arena::item_payload(&input, raw.item_id)?;
        if payload.item.unit_id != unit {
            continue;
        }
        let result: Option<String> = c
            .query_row(
                "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![evaluation.attempt_id.to_string(), raw.item_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let result = ExecutionId::parse(
            &result
                .ok_or_else(|| fail(ErrorCode::DependencyConflict, "strategy-result-pending"))?,
        )?;
        result_for(c, evaluation, raw.item_id, result)?;
        results[payload.slot] = Some(result);
    }
    Ok((
        results[0].ok_or_else(|| fail(ErrorCode::InvalidInput, "strategy-judgment-unit"))?,
        results[1].ok_or_else(corrupt)?,
    ))
}
fn slots(
    c: &Connection,
    evaluation: &StrategyEvaluation,
) -> Result<Vec<StrategyEvaluationSlot>, ExecutionError> {
    let input = evaluation_input(c, evaluation.project_id, evaluation.evaluation_id)?;
    let mut slots = Vec::with_capacity(input.envelope().items.len());
    for raw in &input.envelope().items {
        let payload = arena::item_payload(&input, raw.item_id)?;
        let result: Option<Option<String>> = c
            .query_row(
                "SELECT current_result_id FROM execution_items WHERE attempt_id=?1 AND item_id=?2",
                params![evaluation.attempt_id.to_string(), raw.item_id.to_string()],
                |r| r.get(0),
            )
            .optional()
            .map_err(sql)?;
        let result_id = result
            .flatten()
            .map(|id| ExecutionId::parse(&id))
            .transpose()?;
        if let Some(id) = result_id {
            if crate::persistence::ledger::load_result(c, &input, id)?
                .envelope()
                .item_id
                != raw.item_id
            {
                return Err(corrupt());
            }
        }
        slots.push(StrategyEvaluationSlot {
            item_id: raw.item_id,
            unit_id: payload.item.unit_id,
            slot: payload.slot as u32,
            result_id,
        });
    }
    Ok(slots)
}
fn prepare_check_in(
    c: &Connection,
    request: &StrategyCheckRequest,
) -> Result<(PreparedReviewCheck, CheckCapture), ExecutionError> {
    let evaluation: StrategyEvaluation =
        get(c, "evaluation", request.evaluation_id, request.project_id)?;
    let suite: StrategySuite = get(c, "suite", evaluation.suite_id, request.project_id)?;
    let candidate: ContextStrategyCandidate =
        get(c, "candidate", evaluation.candidate_id, request.project_id)?;
    candidate_current(c, &candidate)?;
    suite_current(c, &suite)?;
    let (_, _, payload) = result_for(c, &evaluation, request.item_id, request.result_id)?;
    let unit = suite_unit(&suite, &payload)?;
    let (revision, text) = candidate_revision(c, &evaluation, request.item_id, request.result_id)?;
    let target = review::target_in(c, request.project_id, unit.unit_id, &suite.locale)?;
    let prepared = review::prepare_candidate_in(
        c,
        request.project_id,
        request.action_id,
        &target,
        None,
        revision,
        &text,
        &unit.terms,
        &[],
    )?;
    let plan = prepared
        .plan()
        .ok_or_else(|| fail(ErrorCode::DependencyConflict, "strategy-review-required"))?;
    if plan.binding() != &unit.source_binding {
        return Err(fail(ErrorCode::ResultMismatch, "strategy-check-policy"));
    }
    let mut basis = unit.review_basis.clone();
    basis.selection_id = None;
    basis.revision_id = Some(revision);
    let capture = CheckCapture {
        request: request.clone(),
        revision_id: revision,
        basis,
        qa_basis: plan.basis().into(),
        required_checks: plan.fixed_checks().set().clone(),
    };
    Ok((prepared, capture))
}

impl ProjectStore {
    /// Capture the exact saved Arena candidate through the original Review
    /// policy owner. This never selects it or records current QA.
    pub fn prepare_strategy_evaluation_check(
        &self,
        request: &StrategyCheckRequest,
    ) -> Result<PreparedReviewCheck, ExecutionError> {
        if replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "check",
            request,
        )?
        .is_some()
        {
            return Err(fail(ErrorCode::ResultMismatch, "strategy-check-recorded"));
        }
        Ok(prepare_check_in(connection(self)?, request)?.0)
    }
    pub fn commit_strategy_evaluation_check(
        &mut self,
        request: &StrategyCheckRequest,
        computed: ComputedReviewEvidence,
        cancellation: &Cancellation,
    ) -> Result<StrategyCheckReceipt, ExecutionError> {
        if let Some(StrategyActionReceipt::Check { receipt }) = replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "check",
            request,
        )? {
            return Ok(receipt);
        }
        if computed.project_id() != request.project_id || computed.action_id() != request.action_id
        {
            return Err(fail(
                ErrorCode::ResultMismatch,
                "strategy-check-computation",
            ));
        }
        let adoption = PreparedReviewAdoption::new(computed)?;
        let authority = self.plugin_authority.clone();
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Check { receipt }) =
                replay(c, request.project_id, request.action_id, "check", request)?
            {
                return Ok(receipt);
            }
            let (_, capture) = prepare_check_in(c, request)?;
            if adoption.candidate_basis() != &capture.basis
                || adoption.evidence().qa_basis != capture.qa_basis
                || adoption.evidence().required_checks != capture.required_checks
                || !adoption.evidence().advisory_checks.is_empty()
            {
                return Err(fail(
                    ErrorCode::ResultMismatch,
                    "strategy-check-computation",
                ));
            }
            let receipt = StrategyCheckReceipt {
                request: request.clone(),
                revision_id: capture.revision_id,
                basis: capture.basis.clone(),
                rules: adoption.rules().to_vec(),
                evidence: adoption.evidence().clone(),
            };
            let evaluation: StrategyEvaluation =
                get(c, "evaluation", request.evaluation_id, request.project_id)?;
            let suite: StrategySuite = get(c, "suite", evaluation.suite_id, request.project_id)?;
            suite_current(c, &suite)?;
            let (_, _, payload) = result_for(c, &evaluation, request.item_id, request.result_id)?;
            let unit = suite_unit(&suite, &payload)?;
            if receipt.evidence.source_binding != unit.source_binding {
                return Err(fail(ErrorCode::ResultMismatch, "strategy-check-policy"));
            }
            if candidate_revision(c, &evaluation, request.item_id, request.result_id)?.0
                != receipt.revision_id
            {
                return Err(corrupt());
            }
            adoption.recheck_authority_in(c, &authority, cancellation)?;
            review::validate_candidate_evidence(
                c,
                request.project_id,
                request.action_id,
                unit.unit_id,
                &suite.locale,
                &receipt.basis,
                &receipt.rules,
                &receipt.evidence,
            )?;
            put(
                c,
                "check-capture",
                request.action_id,
                request.project_id,
                &capture,
            )?;
            put(c, "check", request.action_id, request.project_id, &receipt)?;
            record(
                c,
                request.project_id,
                request.action_id,
                "check",
                request,
                Some(&StrategyActionReceipt::Check {
                    receipt: receipt.clone(),
                }),
            )?;
            Ok(receipt.clone())
        })
    }
    pub fn record_strategy_judgment(
        &mut self,
        request: &StrategyJudgmentRequest,
    ) -> Result<StrategyJudgment, ExecutionError> {
        if let Some(StrategyActionReceipt::Judgment { judgment }) = replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "judgment",
            request,
        )? {
            return Ok(judgment);
        }
        super::super::validate_text(&request.notes, false)?;
        if request.elapsed_seconds.is_some_and(|n| n > 31_536_000)
            || request.modified_characters.is_some_and(|n| n > 10_000_000)
        {
            return Err(fail(ErrorCode::LimitExceeded, "strategy-human-report"));
        }
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Judgment { judgment }) = replay(
                c,
                request.project_id,
                request.action_id,
                "judgment",
                request,
            )? {
                return Ok(judgment);
            }
            let evaluation: StrategyEvaluation =
                get(c, "evaluation", request.evaluation_id, request.project_id)?;
            let suite: StrategySuite = get(c, "suite", evaluation.suite_id, request.project_id)?;
            suite_current(c, &suite)?;
            if !suite
                .units
                .iter()
                .any(|unit| unit.unit_id == request.unit_id && unit.holdout)
            {
                return Err(fail(ErrorCode::InvalidInput, "strategy-holdout"));
            }
            let prior = latest_judgments(c, request.project_id, request.evaluation_id)?
                .into_iter()
                .find(|j| j.request.unit_id == request.unit_id);
            if prior.as_ref().map(|v| v.judgment_id) != request.expected_judgment_id {
                return Err(fail(
                    ErrorCode::DependencyConflict,
                    "strategy-judgment-current",
                ));
            }
            let (baseline_result_id, candidate_result_id) =
                unit_results(c, &evaluation, request.unit_id)?;
            let judgment = StrategyJudgment {
                judgment_id: request.action_id,
                request: request.clone(),
                baseline_result_id,
                candidate_result_id,
            };
            put(
                c,
                "judgment",
                request.action_id,
                request.project_id,
                &judgment,
            )?;
            record(
                c,
                request.project_id,
                request.action_id,
                "judgment",
                request,
                Some(&StrategyActionReceipt::Judgment {
                    judgment: judgment.clone(),
                }),
            )?;
            Ok(judgment)
        })
    }
    pub fn strategy_evaluation_view(
        &self,
        project_id: ExecutionId,
        id: ExecutionId,
    ) -> Result<StrategyEvaluationView, ExecutionError> {
        let evaluation = self.read_strategy_evaluation(project_id, id)?;
        let candidate = self.read_context_strategy(project_id, evaluation.candidate_id)?;
        let suite = self.read_strategy_suite(project_id, evaluation.suite_id)?;
        let current = match self.check_strategy_evaluation_current(project_id, id) {
            Ok(()) => true,
            Err(error) if error.code == ErrorCode::DependencyConflict => false,
            Err(error) => return Err(error),
        };
        let slots = slots(connection(self)?, &evaluation)?;
        Ok(StrategyEvaluationView {
            evaluation,
            candidate,
            suite,
            checks: latest_checks(connection(self)?, project_id, id)?,
            judgments: latest_judgments(connection(self)?, project_id, id)?,
            slots,
            current,
        })
    }
    pub fn promote_context_strategy(
        &mut self,
        request: &PromoteContextStrategy,
    ) -> Result<ContextStrategyDefaultRevision, ExecutionError> {
        if let Some(StrategyActionReceipt::Promoted { revision, .. }) = replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "promote",
            request,
        )? {
            return Ok(revision);
        }
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Promoted { revision, .. }) =
                replay(c, request.project_id, request.action_id, "promote", request)?
            {
                return Ok(revision);
            }
            let evaluation: StrategyEvaluation =
                get(c, "evaluation", request.evaluation_id, request.project_id)?;
            let suite: StrategySuite = get(c, "suite", evaluation.suite_id, request.project_id)?;
            let candidate: ContextStrategyCandidate =
                get(c, "candidate", evaluation.candidate_id, request.project_id)?;
            candidate_current(c, &candidate)?;
            suite_current(c, &suite)?;
            let qualification = promotion_evidence(c, &evaluation, &suite)?;
            if current_default(c, request.project_id, &suite.locale)?
                .as_ref()
                .map(|v| v.revision_id)
                != request.expected_revision_id
            {
                return Err(fail(
                    ErrorCode::DependencyConflict,
                    "strategy-default-current",
                ));
            }
            let revision = ContextStrategyDefaultRevision {
                revision_id: request.action_id,
                action_id: request.action_id,
                project_id: request.project_id,
                locale: suite.locale.clone(),
                previous_revision_id: request.expected_revision_id,
                reference: Some(ContextStrategyReference {
                    project_id: request.project_id,
                    revision_id: request.action_id,
                    candidate_id: candidate.candidate_id,
                }),
                evaluation_id: Some(evaluation.evaluation_id),
            };
            put(
                c,
                "default",
                revision.revision_id,
                request.project_id,
                &revision,
            )?;
            put(
                c,
                "qualification",
                revision.revision_id,
                request.project_id,
                &qualification,
            )?;
            record(
                c,
                request.project_id,
                request.action_id,
                "promote",
                request,
                Some(&StrategyActionReceipt::Promoted {
                    request: request.clone(),
                    revision: revision.clone(),
                }),
            )?;
            Ok(revision)
        })
    }
    pub fn withdraw_context_strategy(
        &mut self,
        request: &WithdrawContextStrategy,
    ) -> Result<ContextStrategyDefaultRevision, ExecutionError> {
        if let Some(StrategyActionReceipt::Withdrawn { revision, .. }) = replay(
            connection(self)?,
            request.project_id,
            request.action_id,
            "withdraw",
            request,
        )? {
            return Ok(revision);
        }
        mutate(self, |c| {
            if let Some(StrategyActionReceipt::Withdrawn { revision, .. }) = replay(
                c,
                request.project_id,
                request.action_id,
                "withdraw",
                request,
            )? {
                return Ok(revision);
            }
            project(c, request.project_id, Some(&request.locale))?;
            let current = current_default(c, request.project_id, &request.locale)?;
            if current.as_ref().map(|v| v.revision_id) != request.expected_revision_id {
                return Err(fail(
                    ErrorCode::DependencyConflict,
                    "strategy-default-current",
                ));
            }
            if current
                .as_ref()
                .and_then(|v| v.reference.as_ref())
                .is_none()
            {
                return Err(fail(ErrorCode::InvalidInput, "strategy-no-default"));
            }
            let revision = ContextStrategyDefaultRevision {
                revision_id: request.action_id,
                action_id: request.action_id,
                project_id: request.project_id,
                locale: request.locale.clone(),
                previous_revision_id: request.expected_revision_id,
                reference: None,
                evaluation_id: None,
            };
            put(
                c,
                "default",
                revision.revision_id,
                request.project_id,
                &revision,
            )?;
            record(
                c,
                request.project_id,
                request.action_id,
                "withdraw",
                request,
                Some(&StrategyActionReceipt::Withdrawn {
                    request: request.clone(),
                    revision: revision.clone(),
                }),
            )?;
            Ok(revision)
        })
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Qualification {
    checks: Vec<ExecutionId>,
    judgments: Vec<ExecutionId>,
}
fn promotion_evidence(
    c: &Connection,
    evaluation: &StrategyEvaluation,
    suite: &StrategySuite,
) -> Result<Qualification, ExecutionError> {
    let input = evaluation_input(c, evaluation.project_id, evaluation.evaluation_id)?;
    let checks = latest_checks(c, evaluation.project_id, evaluation.evaluation_id)?;
    for raw in &input.envelope().items {
        let check = checks
            .iter()
            .find(|check| check.request.item_id == raw.item_id)
            .ok_or_else(|| fail(ErrorCode::DependencyConflict, "strategy-checks-incomplete"))?;
        let (_, _, payload) = result_for(c, evaluation, raw.item_id, check.request.result_id)?;
        let unit = suite_unit(suite, &payload)?;
        if check.evidence.source_binding != unit.source_binding
            || !review::candidate_checks_clean(&check.rules, &check.evidence)
        {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "strategy-checks-blocked",
            ));
        }
        review::validate_candidate_evidence(
            c,
            evaluation.project_id,
            check.request.action_id,
            unit.unit_id,
            &suite.locale,
            &check.basis,
            &check.rules,
            &check.evidence,
        )?;
    }
    let judgments = latest_judgments(c, evaluation.project_id, evaluation.evaluation_id)?;
    let mut preferred = false;
    for unit in suite.units.iter().filter(|u| u.holdout) {
        let judgment = judgments
            .iter()
            .find(|j| j.request.unit_id == unit.unit_id)
            .ok_or_else(|| {
                fail(
                    ErrorCode::DependencyConflict,
                    "strategy-judgments-incomplete",
                )
            })?;
        let results = unit_results(c, evaluation, unit.unit_id)?;
        if results != (judgment.baseline_result_id, judgment.candidate_result_id)
            || judgment.request.preference == StrategyPreference::BaselinePreferred
        {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "strategy-judgment-blocked",
            ));
        }
        preferred |= judgment.request.preference == StrategyPreference::CandidatePreferred;
    }
    if !preferred {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "strategy-no-improvement",
        ));
    }
    Ok(Qualification {
        checks: checks.iter().map(|r| r.request.action_id).collect(),
        judgments: judgments.iter().map(|j| j.judgment_id).collect(),
    })
}
