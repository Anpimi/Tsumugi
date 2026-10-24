//! Source-owned, single-admission observation facts. Never an execution queue.
use super::*;
use rusqlite::OptionalExtension;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) const TABLES: &[(&str, &str)] = &[
    ("source_maintenance_hooks", "CREATE TABLE source_maintenance_hooks (
        source_action_id TEXT PRIMARY KEY NOT NULL REFERENCES adoption_receipts(action_id) DEFERRABLE INITIALLY DEFERRED,
        snapshot_id TEXT NOT NULL UNIQUE REFERENCES source_snapshots(snapshot_id),
        commit_epoch TEXT NOT NULL)"),
    ("source_maintenance_hook_actions", "CREATE TABLE source_maintenance_hook_actions (
        action_id TEXT PRIMARY KEY NOT NULL,
        source_action_id TEXT NOT NULL REFERENCES execution_actions(action_id),
        kind TEXT NOT NULL CHECK(kind IN ('claim','outcome','stop')),
        request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 4194304),
        receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 4194304),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
        UNIQUE(source_action_id,kind))"),
];

fn now_ms() -> Result<u64, ExecutionError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| u64::try_from(v.as_millis()).ok())
        .ok_or_else(|| failure(ErrorCode::InvalidInput, "source-hook-clock"))
}
pub(super) fn check_shape(a: &SourceMaintenanceHookActivation) -> Result<(), ExecutionError> {
    if a.policy_version != SOURCE_MAINTENANCE_HOOK_POLICY
        || a.after != 0
        || a.limit != 100
        || ExecutionId::parse(&a.session_epoch).is_err()
        || crate::Locale::parse(&a.locale).is_err()
        || crate::Locale::parse(&a.locale)
            .map(|v| v.as_str() != a.locale)
            .unwrap_or(true)
        || a.expires_at_ms == 0
        || a.expires_at_ms > i64::MAX as u64
    {
        return Err(failure(ErrorCode::InvalidInput, "source-hook-activation"));
    }
    Ok(())
}
fn activation(
    c: &Connection,
    project: ExecutionId,
    source: ExecutionId,
) -> Result<Option<SourceMaintenanceHookActivation>, ExecutionError> {
    let bytes: Option<Vec<u8>> = c
        .query_row(
            "SELECT request FROM execution_actions WHERE action_id=?1",
            [source.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let Some(bytes) = bytes else {
        return Ok(None);
    };
    let action: AdoptionAction = codec::decode(&bytes, MAX_INPUT_BYTES)?;
    if action.project_id != project || action.operation != OPERATION {
        return Err(failure(ErrorCode::Unauthorized, "source-hook-action"));
    }
    let confirmation: SourceConfirmation = from_value(&action.parameters)?;
    if let Some(a) = &confirmation.maintenance_hook {
        check_shape(a)?;
    }
    Ok(confirmation.maintenance_hook)
}
fn read_action<T: serde::de::DeserializeOwned>(
    c: &Connection,
    source: ExecutionId,
    kind: &str,
) -> Result<Option<T>, ExecutionError> {
    let saved:Option<(Vec<u8>,String)>=c.query_row("SELECT receipt,receipt_digest FROM source_maintenance_hook_actions WHERE source_action_id=?1 AND kind=?2",params![source.to_string(),kind],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql_error)?;
    saved
        .map(|(bytes, digest)| {
            if codec::digest(&bytes) != digest {
                return Err(corrupt());
            }
            codec::decode(&bytes, MAX_INPUT_BYTES)
        })
        .transpose()
}
fn insert_action<T: serde::Serialize, U: serde::Serialize>(
    c: &Connection,
    id: ExecutionId,
    source: ExecutionId,
    kind: &str,
    request: &T,
    receipt: &U,
) -> Result<(), ExecutionError> {
    let request = codec::encode(request, MAX_INPUT_BYTES)?;
    let receipt = codec::encode(receipt, MAX_INPUT_BYTES)?;
    c.execute(
        "INSERT INTO source_maintenance_hook_actions VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            id.to_string(),
            source.to_string(),
            kind,
            &request,
            &receipt,
            codec::digest(&request),
            codec::digest(&receipt)
        ],
    )
    .map_err(sql_error)?;
    Ok(())
}
fn cause(
    c: &Connection,
    project: ExecutionId,
    source: ExecutionId,
) -> Result<Option<SourceMaintenanceHookCause>, ExecutionError> {
    let snapshot: Option<String> = c
        .query_row(
            "SELECT snapshot_id FROM source_maintenance_hooks WHERE source_action_id=?1",
            [source.to_string()],
            |r| r.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let receipt = read_receipt(c, source)?.ok_or_else(corrupt)?;
    let (attempt,result):(String,String)=c.query_row("SELECT attempt_id,result_id FROM source_snapshots WHERE snapshot_id=?1 AND project_id=?2",params![snapshot,project.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?;
    if receipt.project_id != project
        || receipt.changes.len() != 1
        || receipt.changes[0].kind != "source-snapshot"
        || receipt.changes[0].id != snapshot
        || receipt.attempt_id.to_string() != attempt
    {
        return Err(corrupt());
    }
    let result = id(result)?;
    let input = load_input(c, id(attempt.clone())?)?;
    let saved = load_result(c, &input, result)?;
    Ok(Some(SourceMaintenanceHookCause {
        project_id: project,
        source_action_id: source,
        attempt_id: id(attempt)?,
        result_id: result,
        result_digest: saved.digest().into(),
        source_snapshot_id: id(snapshot)?,
        content_revision: receipt.changes[0].revision,
    }))
}
fn validate_outcome(r: &SourceMaintenanceHookOutcome) -> Result<(), ExecutionError> {
    if !matches!(
        r.phase,
        SourceMaintenanceHookPhase::Observed
            | SourceMaintenanceHookPhase::Failed
            | SourceMaintenanceHookPhase::Stopped
            | SourceMaintenanceHookPhase::Expired
            | SourceMaintenanceHookPhase::Superseded
    ) || (r.phase == SourceMaintenanceHookPhase::Failed) != r.error.is_some()
        || (r.phase == SourceMaintenanceHookPhase::Observed) != r.assessment.is_some()
    {
        return Err(corrupt());
    }
    check_shape(&r.activation)?;
    if let Some(v) = &r.assessment {
        v.validate()?;
        if v.project_id != r.cause.project_id
            || v.source_snapshot_id != r.cause.source_snapshot_id
            || v.locale != r.activation.locale
            || v.after != 0
            || v.limit != 100
        {
            return Err(corrupt());
        }
    }
    codec::encode(r, MAX_INPUT_BYTES)?;
    Ok(())
}

pub(super) fn check_available(
    tx: &AdoptionTransaction<'_>,
    confirmation: &SourceConfirmation,
) -> Result<(), ExecutionError> {
    if let Some(a) = &confirmation.maintenance_hook {
        check_shape(a)?;
        let available:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM project_metadata,json_each(target_locales_json) WHERE row_id=1 AND value=?1)",[&a.locale],|r|r.get(0))?;
        if !available {
            return Err(failure(ErrorCode::DependencyConflict, "source-hook-locale"));
        }
    }
    Ok(())
}
pub(super) fn record(
    tx: &AdoptionTransaction<'_>,
    action: &AdoptionAction,
    confirmation: &SourceConfirmation,
    change: &ChangeReference,
) -> Result<(), ExecutionError> {
    if confirmation.maintenance_hook.is_some() {
        // Store epoch is supplied by the actual transaction owner. The request
        // string is a witness, never the authority which can revive a session.
        tx.execute(
            "INSERT INTO source_maintenance_hooks VALUES (?1,?2,?3)",
            params![action.action_id.to_string(), change.id, tx.store_epoch()],
        )?;
    }
    Ok(())
}

/// Called only for a newly persisted original adoption request. Replays cannot
/// recreate this nonpersistent ceiling, including after reopening the Store.
pub(in crate::persistence) fn prepare_deadline(
    c: &Connection,
    action: &AdoptionAction,
    epoch: &str,
) -> Result<Option<Instant>, ExecutionError> {
    if action.operation != OPERATION {
        return Ok(None);
    }
    let Some(a) = activation(c, action.project_id, action.action_id)? else {
        return Ok(None);
    };
    check_shape(&a)?;
    let metadata = super::super::read_metadata_from(c).map_err(|_| corrupt())?;
    if !metadata
        .target_locales()
        .iter()
        .any(|l| l.as_str() == a.locale)
    {
        return Err(failure(ErrorCode::DependencyConflict, "source-hook-locale"));
    }
    let now = now_ms()?;
    if a.expires_at_ms > now.saturating_add(SOURCE_MAINTENANCE_HOOK_MAX_LIFETIME_MS) {
        return Err(failure(ErrorCode::InvalidInput, "source-hook-expiry"));
    }
    if a.session_epoch != epoch {
        return Err(failure(ErrorCode::Unauthorized, "source-hook-session"));
    }
    if a.expires_at_ms <= now {
        return Err(failure(ErrorCode::InvalidInput, "source-hook-expiry"));
    }
    Ok(Instant::now().checked_add(Duration::from_millis(a.expires_at_ms - now)))
}

impl ProjectStore {
    pub fn source_maintenance_hook_session(
        &self,
    ) -> Result<SourceMaintenanceHookSession, ExecutionError> {
        self.connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-hook-session"))?;
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "source-hook-session"));
        }
        Ok(SourceMaintenanceHookSession {
            policy_version: SOURCE_MAINTENANCE_HOOK_POLICY.into(),
            session_epoch: self.changes_since(Revision::new(0)?).epoch,
            default_lifetime_ms: 300_000,
            max_lifetime_ms: SOURCE_MAINTENANCE_HOOK_MAX_LIFETIME_MS,
            window_limit: 100,
        })
    }
    pub fn source_maintenance_hook(
        &self,
        project: ExecutionId,
        source: ExecutionId,
    ) -> Result<SourceMaintenanceHookRead, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-hook-read"))?;
        super::super::review::read_snapshot(c, |c| {
            if super::super::read_metadata_from(c)
                .map_err(|_| corrupt())?
                .project_id()
                .to_string()
                != project.to_string()
            {
                return Err(failure(ErrorCode::Unauthorized, "source-hook-project"));
            }
            let known: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM execution_actions WHERE action_id=?1)",
                    [source.to_string()],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            let view = self.source_maintenance_hook_view(project, source)?;
            let state = match &view {
                Some(v) if v.cause.is_some() => SourceMaintenanceHookReadState::Adopted,
                Some(_) => SourceMaintenanceHookReadState::Prepared,
                None if known => SourceMaintenanceHookReadState::NotEnabled,
                None => SourceMaintenanceHookReadState::ActionNotKnown,
            };
            Ok(SourceMaintenanceHookRead {
                source_action_id: source,
                state,
                view,
            })
        })
    }
    fn source_maintenance_hook_view(
        &self,
        project: ExecutionId,
        source: ExecutionId,
    ) -> Result<Option<SourceMaintenanceHookView>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-hook-read"))?;
        super::super::review::read_snapshot(c, |c| {
            if super::super::read_metadata_from(c)
                .map_err(|_| corrupt())?
                .project_id()
                .to_string()
                != project.to_string()
            {
                return Err(failure(ErrorCode::Unauthorized, "source-hook-project"));
            }
            let Some(a) = activation(c, project, source)? else {
                return Ok(None);
            };
            let cause = cause(c, project, source)?;
            let stop: Option<SourceMaintenanceHookStopReceipt> = read_action(c, source, "stop")?;
            let outcome: Option<SourceMaintenanceHookOutcome> = read_action(c, source, "outcome")?;
            if let Some(out) = &outcome {
                validate_outcome(out)?;
                if Some(&out.cause) != cause.as_ref() || out.activation != a {
                    return Err(corrupt());
                }
            }
            let claim: Option<(
                ExecutionId,
                SourceMaintenanceHookCause,
                SourceMaintenanceHookActivation,
            )> = read_action(c, source, "claim")?;
            let epoch = self.changes_since(Revision::new(0)?).epoch;
            let current = scope(c)?.current_snapshot;
            let phase = if stop.is_some() {
                SourceMaintenanceHookPhase::Stopped
            } else if let Some(o) = &outcome {
                o.phase
            } else if cause
                .as_ref()
                .is_some_and(|v| Some(v.source_snapshot_id) != current)
            {
                SourceMaintenanceHookPhase::Superseded
            } else if a.session_epoch != epoch {
                if claim.is_some() {
                    SourceMaintenanceHookPhase::Unknown
                } else {
                    SourceMaintenanceHookPhase::Interrupted
                }
            } else if a.expires_at_ms <= now_ms()?
                || self
                    .source_hook_deadlines
                    .get(&source)
                    .is_some_and(|v| *v <= Instant::now())
            {
                SourceMaintenanceHookPhase::Expired
            } else if !self.source_hook_deadlines.contains_key(&source) {
                if claim.is_some() {
                    SourceMaintenanceHookPhase::Unknown
                } else {
                    SourceMaintenanceHookPhase::Interrupted
                }
            } else if claim.is_some() {
                SourceMaintenanceHookPhase::Running
            } else if cause.is_some() {
                SourceMaintenanceHookPhase::Pending
            } else {
                SourceMaintenanceHookPhase::Prepared
            };
            let admission_closed = !matches!(
                phase,
                SourceMaintenanceHookPhase::Prepared
                    | SourceMaintenanceHookPhase::Pending
                    | SourceMaintenanceHookPhase::Running
            );
            Ok(Some(SourceMaintenanceHookView {
                source_action_id: source,
                activation: a,
                cause,
                phase,
                admission_closed,
                stop,
                outcome,
            }))
        })
    }
    pub fn stop_source_maintenance_hook(
        &mut self,
        request: &StopSourceMaintenanceHook,
    ) -> Result<SourceMaintenanceHookStopResult, ExecutionError> {
        if request.action_id == request.source_action_id {
            return Err(failure(
                ErrorCode::InvalidInput,
                "source-hook-stop-identity",
            ));
        }
        let tx = self.execution_write()?;
        if let Some((source,kind,bytes))=tx.query_row("SELECT source_action_id,kind,request FROM source_maintenance_hook_actions WHERE action_id=?1",[request.action_id.to_string()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Vec<u8>>(2)?))).optional().map_err(sql_error)? {
            if source!=request.source_action_id.to_string() || kind!="stop" || codec::decode::<StopSourceMaintenanceHook>(&bytes,MAX_INPUT_BYTES)?!=*request {return Err(failure(ErrorCode::ResultMismatch,"source-hook-action"))}
            let receipt=read_action(&tx,request.source_action_id,"stop")?.ok_or_else(corrupt)?;return Ok(SourceMaintenanceHookStopResult::Stopped{receipt});
        }
        let Some(a) = activation(&tx, request.project_id, request.source_action_id)? else {
            return Ok(SourceMaintenanceHookStopResult::NotKnown);
        };
        if a != request.activation {
            return Err(failure(ErrorCode::ResultMismatch, "source-hook-activation"));
        }
        if read_action::<SourceMaintenanceHookStopReceipt>(&tx, request.source_action_id, "stop")?
            .is_some()
        {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "source-hook-stopped",
            ));
        }
        let receipt = SourceMaintenanceHookStopReceipt {
            request: request.clone(),
            admission_closed: true,
        };
        insert_action(
            &tx,
            request.action_id,
            request.source_action_id,
            "stop",
            request,
            &receipt,
        )?;
        super::super::ledger::commit(tx)?;
        self.source_hook_deadlines.remove(&request.source_action_id);
        Ok(SourceMaintenanceHookStopResult::Stopped { receipt })
    }
    /// One candidate only. A wake-up is not the durable cause or authority.
    pub fn next_source_maintenance_hook(&self) -> Result<Option<ExecutionId>, ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-hook-read"))?;
        if self.source_hook_deadlines.is_empty() {
            return Ok(None);
        }
        let wanted = serde_json::to_string(&self.source_hook_deadlines.keys().collect::<Vec<_>>())
            .map_err(|_| corrupt())?;
        let mut q=c.prepare("SELECT h.source_action_id FROM source_maintenance_hooks h WHERE h.source_action_id IN (SELECT value FROM json_each(?1)) AND NOT EXISTS(SELECT 1 FROM source_maintenance_hook_actions x WHERE x.source_action_id=h.source_action_id) ORDER BY h.rowid LIMIT 1").map_err(sql_error)?;
        for row in q
            .query_map([wanted], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
        {
            let id = id(row.map_err(sql_error)?)?;
            if self.source_hook_deadlines.contains_key(&id) {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }
    pub fn claim_source_maintenance_hook(
        &mut self,
        project: ExecutionId,
        source: ExecutionId,
        run: ExecutionId,
    ) -> Result<Option<ClaimedSourceMaintenanceHook>, ExecutionError> {
        let epoch = self.source_maintenance_hook_session()?.session_epoch;
        let live = self
            .source_hook_deadlines
            .get(&source)
            .is_some_and(|v| *v > Instant::now());
        let admitted_session = self.source_hook_deadlines.contains_key(&source);
        let tx = self.execution_write()?;
        let Some(a) = activation(&tx, project, source)? else {
            return Ok(None);
        };
        let Some(cause) = cause(&tx, project, source)? else {
            return Ok(None);
        };
        if a.session_epoch != epoch || !admitted_session {
            return Ok(None);
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM source_maintenance_hook_actions WHERE source_action_id=?1)",[source.to_string()],|r|r.get::<_,bool>(0)).map_err(sql_error)? {return Ok(None)}
        let mut busy=tx.prepare("SELECT 1 FROM source_maintenance_hook_actions a JOIN execution_actions e ON e.action_id=a.source_action_id WHERE a.kind='claim' AND json_extract(CAST(e.request AS TEXT),'$.parameters.maintenanceHook.sessionEpoch')=?1 AND NOT EXISTS(SELECT 1 FROM source_maintenance_hook_actions b WHERE b.source_action_id=a.source_action_id AND b.kind='outcome') LIMIT 1").map_err(sql_error)?;
        if busy.exists([&epoch]).map_err(sql_error)? {
            return Err(failure(ErrorCode::Busy, "source-hook-running"));
        }
        drop(busy);
        // Expired or superseded observations are closed without running a new
        // assessment. They still consume their single logical admission.
        let receipt = (run, cause.clone(), a.clone());
        insert_action(&tx, run, source, "claim", &receipt, &receipt)?;
        super::super::ledger::commit(tx)?;
        let claim = ClaimedSourceMaintenanceHook {
            epoch: epoch.clone(),
            run_id: run,
            cause,
            activation: a,
        };
        if !live
            || claim.activation.session_epoch != epoch
            || claim.activation.expires_at_ms <= now_ms()?
        {
            let computed = ComputedSourceMaintenanceHook(
                SourceMaintenanceHookOutcome {
                    run_id: run,
                    cause: claim.cause,
                    activation: claim.activation,
                    phase: SourceMaintenanceHookPhase::Expired,
                    assessment: None,
                    error: None,
                },
                epoch,
            );
            self.finish_source_maintenance_hook(computed)?;
            return Ok(None);
        }
        Ok(Some(claim))
    }
    pub fn capture_source_maintenance_hook(
        &self,
        claim: ClaimedSourceMaintenanceHook,
    ) -> Result<CapturedSourceMaintenanceHook, ExecutionError> {
        self.check_source_hook_claim(&claim)?;
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-hook-read"))?;
        let closed = read_action::<SourceMaintenanceHookStopReceipt>(
            c,
            claim.cause.source_action_id,
            "stop",
        )?
        .is_some()
            || scope(c)?.current_snapshot != Some(claim.cause.source_snapshot_id)
            || deadline_expired(
                self.source_hook_deadlines
                    .get(&claim.cause.source_action_id)
                    .copied(),
                claim.activation.expires_at_ms,
                Instant::now(),
                now_ms()?,
            );
        if closed {
            return Ok(CapturedSourceMaintenanceHook {
                claim,
                assessment: Err(failure(ErrorCode::Cancelled, "source-hook-closed")),
            });
        }
        let assessment = self.capture_maintenance_assessment(
            claim.cause.project_id,
            claim.cause.source_snapshot_id,
            &claim.activation.locale,
            0,
            100,
        );
        Ok(CapturedSourceMaintenanceHook { claim, assessment })
    }
    fn check_source_hook_claim(
        &self,
        claim: &ClaimedSourceMaintenanceHook,
    ) -> Result<(), ExecutionError> {
        let c = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-hook-read"))?;
        let saved: Option<(
            ExecutionId,
            SourceMaintenanceHookCause,
            SourceMaintenanceHookActivation,
        )> = read_action(c, claim.cause.source_action_id, "claim")?;
        if self.changes_since(Revision::new(0)?).epoch != claim.epoch
            || saved != Some((claim.run_id, claim.cause.clone(), claim.activation.clone()))
        {
            return Err(failure(ErrorCode::Unauthorized, "source-hook-claim"));
        }
        Ok(())
    }
    pub fn finish_source_maintenance_hook(
        &mut self,
        computed: ComputedSourceMaintenanceHook,
    ) -> Result<SourceMaintenanceHookOutcome, ExecutionError> {
        let mut out = computed.0;
        let epoch = self.changes_since(Revision::new(0)?).epoch;
        let expired = deadline_expired(
            self.source_hook_deadlines
                .get(&out.cause.source_action_id)
                .copied(),
            out.activation.expires_at_ms,
            Instant::now(),
            now_ms()?,
        );
        let tx = self.execution_write()?;
        let source = out.cause.source_action_id;
        if let Some(saved) = read_action::<SourceMaintenanceHookOutcome>(&tx, source, "outcome")? {
            validate_outcome(&saved)?;
            if saved.run_id != out.run_id {
                return Err(failure(ErrorCode::ResultMismatch, "source-hook-run"));
            }
            return Ok(saved);
        }
        let saved: Option<(
            ExecutionId,
            SourceMaintenanceHookCause,
            SourceMaintenanceHookActivation,
        )> = read_action(&tx, source, "claim")?;
        if epoch != computed.1
            || saved != Some((out.run_id, out.cause.clone(), out.activation.clone()))
            || cause(&tx, out.cause.project_id, source)?.as_ref() != Some(&out.cause)
        {
            return Err(failure(ErrorCode::Unauthorized, "source-hook-claim"));
        }
        if read_action::<SourceMaintenanceHookStopReceipt>(&tx, source, "stop")?.is_some() {
            out.phase = SourceMaintenanceHookPhase::Stopped;
            out.assessment = None;
            out.error = None;
        } else if scope(&tx)?.current_snapshot != Some(out.cause.source_snapshot_id) {
            out.phase = SourceMaintenanceHookPhase::Superseded;
            out.assessment = None;
            out.error = None;
        } else if expired {
            out.phase = SourceMaintenanceHookPhase::Expired;
            out.assessment = None;
            out.error = None;
        }
        validate_outcome(&out)?;
        // The outcome action is deterministic per run, rather than a fresh retry.
        insert_action(&tx, ExecutionId::new(), source, "outcome", &out, &out)?;
        super::super::ledger::commit(tx)?;
        self.source_hook_deadlines.remove(&source);
        Ok(out)
    }
}

fn deadline_expired(
    deadline: Option<Instant>,
    expires: u64,
    monotonic: Instant,
    wall: u64,
) -> bool {
    deadline.is_none_or(|v| v <= monotonic) || expires <= wall
}

#[cfg(test)]
mod deadline_tests {
    use super::*;
    #[test]
    fn original_monotonic_ceiling_survives_wall_clock_rollback_and_missing_authority() {
        let start = Instant::now();
        let ceiling = start + Duration::from_secs(5);
        assert!(!deadline_expired(Some(ceiling), 10_000, start, 5_000));
        assert!(deadline_expired(
            Some(ceiling),
            10_000,
            start + Duration::from_secs(6),
            1_000
        ));
        assert!(deadline_expired(Some(ceiling), 10_000, start, 10_000));
        assert!(deadline_expired(None, 10_000, start, 1_000));
    }
}

pub(super) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    for (name, expected) in TABLES {
        let actual: String = c
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if actual != *expected {
            return Err(corrupt());
        }
    }
    let project = id(super::super::read_metadata_from(c)
        .map_err(|_| corrupt())?
        .project_id()
        .to_string())?;
    let mut admitted = std::collections::BTreeSet::new();
    let mut stopped = std::collections::BTreeSet::new();
    let mut q=c.prepare("SELECT action_id,source_action_id,kind,request,receipt,request_digest,receipt_digest FROM source_maintenance_hook_actions ORDER BY rowid").map_err(sql_error)?;
    for row in q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, Vec<u8>>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(sql_error)?
    {
        let (action, source, kind, request, receipt, rd, od) = row.map_err(sql_error)?;
        let source = id(source)?;
        let a = activation(c, project, source)?.ok_or_else(corrupt)?;
        if codec::digest(&request) != rd || codec::digest(&receipt) != od {
            return Err(corrupt());
        }
        match kind.as_str() {
            "stop" => {
                let r: SourceMaintenanceHookStopReceipt = codec::decode(&receipt, MAX_INPUT_BYTES)?;
                if r.request != codec::decode(&request, MAX_INPUT_BYTES)?
                    || r.request.action_id.to_string() != action
                    || r.request.source_action_id != source
                    || r.request.project_id != project
                    || r.request.activation != a
                    || !r.admission_closed
                {
                    return Err(corrupt());
                }
                stopped.insert(source);
            }
            "claim" => {
                let r: (
                    ExecutionId,
                    SourceMaintenanceHookCause,
                    SourceMaintenanceHookActivation,
                ) = codec::decode(&receipt, MAX_INPUT_BYTES)?;
                if stopped.contains(&source)
                    || !admitted.insert(source)
                    || request != receipt
                    || r.0.to_string() != action
                    || r.2 != a
                    || Some(r.1) != cause(c, project, source)?
                {
                    return Err(corrupt());
                }
            }
            "outcome" => {
                let r: SourceMaintenanceHookOutcome = codec::decode(&receipt, MAX_INPUT_BYTES)?;
                validate_outcome(&r)?;
                let claim: Option<(
                    ExecutionId,
                    SourceMaintenanceHookCause,
                    SourceMaintenanceHookActivation,
                )> = read_action(c, source, "claim")?;
                if !admitted.contains(&source)
                    || request != receipt
                    || claim != Some((r.run_id, r.cause.clone(), r.activation.clone()))
                    || r.activation != a
                    || Some(r.cause.clone()) != cause(c, project, source)?
                    || (stopped.contains(&source) && r.phase != SourceMaintenanceHookPhase::Stopped)
                {
                    return Err(corrupt());
                }
                if let Some(v) = r.assessment {
                    for row in &v.rows {
                        let valid:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id WHERE o.snapshot_id=?1 AND o.unit_id=?2 AND o.revision_id=?3 AND r.text=?4 AND o.native_key=?5)",params![v.source_snapshot_id.to_string(),row.unit_id.to_string(),row.source_revision_id.to_string(),row.source_text,row.native_key],|r|r.get(0)).map_err(sql_error)?;
                        if !valid {
                            return Err(corrupt());
                        }
                    }
                }
            }
            _ => return Err(corrupt()),
        }
    }
    let mut q = c
        .prepare("SELECT h.source_action_id,h.commit_epoch FROM source_maintenance_hooks h")
        .map_err(sql_error)?;
    for r in q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(sql_error)?
    {
        let (action, epoch) = r.map_err(sql_error)?;
        let action = id(action)?;
        if ExecutionId::parse(&epoch).is_err()
            || activation(c, project, action)?.is_none()
            || cause(c, project, action)?.is_none()
        {
            return Err(corrupt());
        }
    }
    let missing:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM execution_actions a JOIN adoption_receipts r ON r.action_id=a.action_id WHERE json_extract(CAST(a.request AS TEXT),'$.operation')='source-import' AND json_type(CAST(a.request AS TEXT),'$.parameters.maintenanceHook')='object' AND NOT EXISTS(SELECT 1 FROM source_maintenance_hooks h WHERE h.source_action_id=a.action_id))",[],|r|r.get(0)).map_err(sql_error)?;
    if missing {
        return Err(corrupt());
    }
    Ok(())
}
