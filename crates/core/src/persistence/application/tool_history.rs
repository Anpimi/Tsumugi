//! Pure navigation from a verified team work to its original delegated tools.
use super::{ProjectStore, control, coordination, tools};
use crate::{ai, application::*, execution::*};
use rusqlite::{Connection, params};

fn invalid(stage: &str) -> ExecutionError {
    ExecutionError::new(ErrorCode::Unauthorized, stage)
}
fn corrupt() -> ExecutionError {
    ExecutionError::new(ErrorCode::CorruptLedger, "team-tool-history-facts")
}
fn sql(_: rusqlite::Error) -> ExecutionError {
    ExecutionError::new(ErrorCode::StorageFailed, "team-tool-history-read")
}

impl ProjectStore {
    pub fn read_team_work_tools(
        &self,
        request: &ReadTeamWorkTools,
    ) -> Result<TeamWorkToolHistory, ExecutionError> {
        if !(1..=16).contains(&request.limit) {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "team-tool-history-page",
            ));
        }
        let c = self
            .connection()
            .map_err(|_| sql(rusqlite::Error::InvalidQuery))?;
        super::super::review::read_snapshot(c, |c| self.team_work_tools_in(c, request))
    }
    fn team_work_tools_in(
        &self,
        c: &Connection,
        request: &ReadTeamWorkTools,
    ) -> Result<TeamWorkToolHistory, ExecutionError> {
        let metadata = super::super::read_metadata_from(c).map_err(|_| corrupt())?;
        if metadata.project_id().to_string() != request.project_id.to_string() {
            return Err(invalid("team-tool-history-project"));
        }
        let work = super::super::ledger::load_input(c, request.work.attempt_id)?;
        if work.envelope().operation != ai::team::OPERATION
            || work.envelope().project_id != request.project_id
            || work.envelope().task_id != request.work.task_id
            || work.digest() != request.work.input_digest
        {
            return Err(invalid("team-tool-history-work"));
        }
        coordination::validate_model_input(c, &work)?;
        let binding = ai::team::settings(&work)?.binding;
        let scope = binding.scope();
        if scope.lease.plan_id != request.plan_id {
            return Err(invalid("team-tool-history-plan"));
        }
        let plan = control::load(c, request.plan_id)?.plan;
        let max = plan.tools.as_ref().map_or(0, |tools| tools.max_invocations);
        let after = request.after.map_or(0, |sequence| sequence.get());
        // Tool admissions have an existing cumulative hard bound. Filter the
        // original caller before applying the requested page size.
        let mut q=c.prepare("SELECT x.delegation,a.attempt_id,a.sequence FROM application_executions x JOIN execution_attempts a USING(attempt_id) WHERE x.plan_id=?1 AND x.kind='tool' ORDER BY a.sequence LIMIT ?2").map_err(sql)?;
        let mut scanned = 0u32;
        let mut attempts = Vec::new();
        for row in q
            .query_map(params![request.plan_id.to_string(), max + 1], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(sql)?
        {
            let (bytes, attempt, sequence) = row.map_err(sql)?;
            scanned += 1;
            if scanned > max {
                return Err(corrupt());
            }
            let delegation: WorkPlanToolDelegation =
                codec::decode(&bytes, MAX_AGENT_DELEGATION_BYTES)?;
            let input = super::super::ledger::load_input(c, ExecutionId::parse(&attempt)?)?;
            tools::validate_tool_input(c, &input, &delegation)?;
            if delegation.lease != scope.lease || delegation.caller_id != scope.caller_id {
                continue;
            }
            if delegation.root_task != scope.root_task
                || delegation.delegation != scope.delegation
                || delegation.caller != "work-plan-agent"
            {
                return Err(corrupt());
            }
            let sequence = u64::try_from(sequence).map_err(|_| corrupt())?;
            if sequence <= after {
                continue;
            }
            let selected = plan
                .tools
                .as_ref()
                .and_then(|tools| {
                    tools
                        .entries
                        .iter()
                        .find(|tool| tool.handle == delegation.tool_handle)
                })
                .ok_or_else(corrupt)?;
            let mut unit_ids = input
                .envelope()
                .items
                .iter()
                .map(|item| ExecutionId::parse(&item.scope.id))
                .collect::<Result<Vec<_>, _>>()?;
            unit_ids.sort();
            unit_ids.dedup();
            let summary = self.execution_attempt(input.envelope().attempt_id, false)?;
            let stored_result_items=c.query_row("SELECT COUNT(*) FROM execution_items WHERE attempt_id=?1 AND current_result_id IS NOT NULL",[attempt],|row|row.get(0)).map_err(sql)?;
            attempts.push(TeamWorkToolAttempt {
                sequence: Revision::new(sequence)?,
                reference: TeamWorkReference {
                    task_id: input.envelope().task_id,
                    attempt_id: input.envelope().attempt_id,
                    input_digest: input.digest().into(),
                },
                tool_handle: selected.handle,
                name: selected.binding.declaration.title.clone(),
                unit_ids,
                progress: summary.progress,
                stored_result_items,
            });
            if attempts.len() > request.limit as usize {
                break;
            }
        }
        let more = attempts.len() > request.limit as usize;
        attempts.truncate(request.limit as usize);
        let next_after = more.then(|| attempts.last().unwrap().sequence);
        let page = TeamWorkToolHistory {
            project_id: request.project_id,
            plan_id: request.plan_id,
            work: request.work.clone(),
            attempts,
            next_after,
        };
        page.check_encoded_bound()?;
        Ok(page)
    }
}
