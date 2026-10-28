//! Read-only execution locations use original actions, inputs and budget roots.
use super::*;
use std::collections::{BTreeMap, BTreeSet};

type Association = (String, i64, String, String);

pub(super) fn prove_start(
    stored: &StoredPlan,
    action: ExecutionId,
    generation: Revision,
    input: &FixedInput,
    saved: &FixedInput,
    association: Option<Association>,
) -> Result<WorkPlanStartReceipt, ExecutionError> {
    if saved.bytes() != input.bytes() {
        return Err(err(ErrorCode::ResultMismatch, "work-plan-start-input"));
    }
    if association
        != Some((
            stored.plan.plan_id.to_string(),
            generation.get() as i64,
            "model".into(),
            stored.plan.execution_input()?.task_id.to_string(),
        ))
    {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-start-association"));
    }
    Ok(WorkPlanStartReceipt {
        project_id: stored.plan.project_id,
        plan_id: stored.plan.plan_id,
        action_id: action,
        expected_generation: generation,
        attempt_id: input.envelope().attempt_id,
        task_id: input.envelope().task_id,
    })
}

fn is_start(request: &Request) -> bool {
    matches!(request, Request::Authorize { .. })
        || matches!(request, Request::Control { request } if request.command == WorkPlanCommand::Continue)
}

struct Enqueued {
    association: Association,
    matched: bool,
}

fn enqueue_association(
    c: &Connection,
    stored: &StoredPlan,
    attempt: ExecutionId,
) -> Result<Option<Enqueued>, ExecutionError> {
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE attempt_id=?1)",
            [attempt.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let association: Option<Association> = c.query_row("SELECT plan_id,generation,kind,root_task FROM application_executions WHERE attempt_id=?1", [attempt.to_string()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(sql)?;
    if !exists && association.is_none() {
        return Ok(None);
    }
    let association = association
        .filter(|(plan, generation, kind, root)| {
            exists
                && plan == &stored.plan.plan_id.to_string()
                && *generation > 0
                && *generation as u64 <= stored.lease.generation.get()
                && kind == "model"
                && stored
                    .plan
                    .input
                    .as_ref()
                    .is_some_and(|input| root == &input.task_id.to_string())
        })
        .ok_or_else(|| err(ErrorCode::CorruptLedger, "work-plan-start-association"))?;
    Ok(Some(Enqueued {
        association,
        matched: false,
    }))
}

#[derive(Clone, Copy)]
struct RequestedStart {
    action: ExecutionId,
    generation: Revision,
    attempt: ExecutionId,
}

struct History {
    last_start: Option<WorkPlanStartReceipt>,
    requested_start: Option<WorkPlanStartReceipt>,
}

fn history(
    c: &Connection,
    stored: &StoredPlan,
    requested: Option<RequestedStart>,
) -> Result<History, ExecutionError> {
    let mut generations = BTreeSet::new();
    let mut enqueued = BTreeMap::new();
    let mut latest: Option<WorkPlanStartReceipt> = None;
    let mut requested_start = None;
    let mut query = c.prepare("SELECT action_id,request,request_digest,receipt,receipt_digest FROM application_actions WHERE plan_id=?1").map_err(sql)?;
    let rows = query
        .query_map([stored.plan.plan_id.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (action, bytes, digest, receipt_bytes, receipt_digest) = row.map_err(sql)?;
        let request: Request = codec::decode(&bytes, MAX_INPUT_BYTES)?;
        let receipt: WorkPlanReceipt = codec::decode(&receipt_bytes, MAX_INPUT_BYTES)?;
        if request.action().to_string() != action
            || request.plan() != stored.plan.plan_id
            || codec::digest(&codec::encode(&request, MAX_INPUT_BYTES)?) != digest
            || codec::digest(&receipt_bytes) != receipt_digest
            || receipt.action_id != request.action()
            || receipt.lease.plan_id != stored.plan.plan_id
            || receipt.lease.generation.get() == 0
            || receipt.lease.generation > stored.lease.generation
        {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-run-action"));
        }
        validate_receipt(&request, &receipt, stored)?;
        let is_requested = requested.is_some_and(|target| target.action == request.action());
        if is_requested {
            let target = requested.unwrap();
            if receipt.lease.generation != target.generation
                || receipt.state != WorkPlanState::Active
                || receipt.input.as_ref().map(|input| input.attempt_id) != Some(target.attempt)
            {
                return Err(err(ErrorCode::ResultMismatch, "work-plan-start-request"));
            }
        }
        if !generations.insert(receipt.lease.generation.get()) {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-run-generation"));
        }
        if receipt.lease.generation == stored.lease.generation
            && (receipt.state != stored.state
                || receipt.cancellation_revision != stored.cancellation_revision)
        {
            return Err(err(ErrorCode::CorruptLedger, "work-plan-run-history"));
        }
        let Some(original) = receipt.input.as_ref() else {
            continue;
        };
        if !enqueued.contains_key(&original.attempt_id) {
            enqueued.insert(
                original.attempt_id,
                enqueue_association(c, stored, original.attempt_id)?,
            );
        }
        let Some(evidence) = enqueued.get_mut(&original.attempt_id).unwrap() else {
            continue;
        };
        // One attempt can be named by several unstarted generations. Its
        // enqueue association selects the original action whose bytes must match.
        if evidence.association.1 as u64 != receipt.lease.generation.get() {
            continue;
        }
        let input = FixedInput::capture(original.clone())?;
        let saved = ledger::load_input(c, original.attempt_id)?;
        let start = prove_start(
            stored,
            request.action(),
            receipt.lease.generation,
            &input,
            &saved,
            Some(evidence.association.clone()),
        )?;
        evidence.matched = true;
        if is_requested {
            requested_start = Some(start.clone());
        }
        if is_start(&request)
            && latest
                .as_ref()
                .is_none_or(|old| old.expected_generation < start.expected_generation)
        {
            latest = Some(start);
        }
    }
    if enqueued
        .values()
        .flatten()
        .any(|evidence| !evidence.matched)
        || ((!generations.is_empty() || stored.plan.input.is_some())
            && generations.len() as u64 != stored.lease.generation.get())
    {
        return Err(err(ErrorCode::CorruptLedger, "work-plan-run-history"));
    }
    Ok(History {
        last_start: latest,
        requested_start,
    })
}

fn scoped_plan(
    c: &Connection,
    project: ExecutionId,
    plan: ExecutionId,
) -> Result<StoredPlan, ExecutionError> {
    if super::super::super::read_metadata_from(c)
        .map_err(|_| err(ErrorCode::CorruptLedger, "work-plan-project"))?
        .project_id()
        .to_string()
        != project.to_string()
    {
        return Err(err(ErrorCode::Unauthorized, "work-plan-project"));
    }
    let stored = load(c, plan)?;
    if stored.plan.project_id != project {
        return Err(err(ErrorCode::Unauthorized, "work-plan-project"));
    }
    Ok(stored)
}

fn settlement<R>(
    stored: &StoredPlan,
    expected: Revision,
    receipt: Option<R>,
) -> WorkPlanRequestSettlement<R> {
    let outcome = match receipt {
        Some(receipt) => WorkPlanRequestOutcome::Recorded { receipt },
        None if stored.lease.generation > expected => WorkPlanRequestOutcome::FencedNotApplied,
        None => WorkPlanRequestOutcome::Pending,
    };
    WorkPlanRequestSettlement {
        project_id: stored.plan.project_id,
        plan_id: stored.plan.plan_id,
        lease: stored.lease,
        state: stored.state,
        outcome,
    }
}

impl ProjectStore {
    /// Observe an exact start. A later generation permanently prevents a missing
    /// old enqueue; expiry or a missing acknowledgement alone do not prove that.
    pub fn work_plan_start_settlement(
        &self,
        project: ExecutionId,
        plan: ExecutionId,
        action: ExecutionId,
        expected_generation: Revision,
        expected_attempt_id: ExecutionId,
    ) -> Result<WorkPlanRequestSettlement<WorkPlanStartReceipt>, ExecutionError> {
        if expected_generation.get() == 0 {
            return Err(err(ErrorCode::InvalidInput, "work-plan-start-generation"));
        }
        super::super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?,
            |c| {
                let stored = scoped_plan(c, project, plan)?;
                let action_plan: Option<String> = c.query_row(
                    "SELECT plan_id FROM application_actions WHERE action_id=?1",
                    [action.to_string()], |row| row.get(0),
                ).optional().map_err(sql)?;
                if action_plan.is_some_and(|id| id != plan.to_string()) {
                    return Err(err(ErrorCode::ResultMismatch, "work-plan-start-request"));
                }
                let read = history(c, &stored, Some(RequestedStart {
                    action,
                    generation: expected_generation,
                    attempt: expected_attempt_id,
                }))?;
                Ok(settlement(&stored, expected_generation, read.requested_start))
            },
        )
    }

    /// Observe only the durable Core transition. This never reconciles unknown
    /// execution, renews a lease, or installs Host-local execution consent.
    pub fn work_plan_control_settlement(
        &self,
        project: ExecutionId,
        request: &ControlWorkPlan,
    ) -> Result<WorkPlanRequestSettlement<WorkPlanReceipt>, ExecutionError> {
        super::super::super::review::read_snapshot(
            self.connection()
                .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?,
            |c| {
                let stored = scoped_plan(c, project, request.plan_id)?;
                let recorded = recorded_action_read(c, project, &Request::Control {
                    request: request.clone(),
                })?;
                history(c, &stored, None)?;
                Ok(settlement(&stored, request.expected_generation, recorded))
            },
        )
    }

    /// A historical observation. It never reconciles, enqueues or renews consent.
    pub fn read_work_plan_run(
        &self,
        project: ExecutionId,
        plan: ExecutionId,
    ) -> Result<WorkPlanRunView, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| err(ErrorCode::StorageFailed, "work-plan-read"))?;
        super::super::super::review::read_snapshot(connection, |c| {
            let stored = scoped_plan(c, project, plan)?;
            let root = stored.plan.input.as_ref().map(|input| input.task_id);
            let last_start = history(c, &stored, None)?.last_start;
            let budget = match root {
                Some(root) => super::super::super::ledger::provider::provider_budget_in(c, root)?,
                None => None,
            };
            Ok(WorkPlanRunView {
                project_id: project,
                plan_id: plan,
                plan_digest: stored.plan.digest,
                lease: stored.lease,
                state: stored.state,
                last_start,
                budget_root_task_id: root,
                budget,
            })
        })
    }
}

#[cfg(test)]
mod tests;
