//! The original Runtime owns live drainage and the first monotonic team ceiling.
use super::*;
use crate::application::*;
impl ExecutionRuntime {
    pub(super) fn prune_team_anchors(
        &mut self,
        store: &ProjectStore,
    ) -> Result<(), ExecutionError> {
        let mut remove = Vec::new();
        for (plan, deadline) in &self.team_deadlines {
            let status = store.work_plan_status(*plan)?;
            if (Instant::now() >= *deadline || status.state == WorkPlanState::Stopped)
                && self.team_recovery_state(store, *plan)?.producers_drained
            {
                remove.push(*plan);
            }
        }
        for plan in remove {
            self.team_deadlines.remove(&plan);
        }
        Ok(())
    }
    pub fn team_recovery_state(
        &self,
        store: &ProjectStore,
        plan: ExecutionId,
    ) -> Result<TeamRecoveryRuntimeState, ExecutionError> {
        let mut drained = true;
        for worker in &self.workers {
            if store.team_input_belongs(&worker.request.input, plan)? {
                drained = false;
                break;
            }
        }
        if drained {
            for worker in &self.retired {
                let input = store.execution_input(worker.attempt)?;
                if store.team_input_belongs(&input, plan)? {
                    drained = false;
                    break;
                }
            }
        }
        if drained {
            for attempt in store.queued_execution_attempts(self.initial_sequence)? {
                let input = store.execution_input(attempt)?;
                if store.team_input_belongs(&input, plan)? {
                    drained = false;
                    break;
                }
            }
        }
        Ok(TeamRecoveryRuntimeState {
            original_deadline_available: self.accepting
                && self
                    .team_deadlines
                    .get(&plan)
                    .is_some_and(|d| Instant::now() < *d),
            producers_drained: drained,
        })
    }
    pub fn prepare_team_recovery(
        &self,
        store: &ProjectStore,
        request: &PrepareTeamRecovery,
    ) -> Result<PreparedTeamRecovery, ExecutionError> {
        let state = self.team_recovery_state(store, request.plan_id)?;
        if !state.original_deadline_available {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "team-recovery-live-anchor",
            ));
        }
        if !state.producers_drained {
            return Err(ExecutionError::new(
                ErrorCode::Busy,
                "team-recovery-producers",
            ));
        }
        let capture = store.capture_team_recovery(request)?;
        Ok(PreparedTeamRecovery {
            capture,
            runtime_generation: self.generation(),
            deadline: *self.team_deadlines.get(&request.plan_id).ok_or_else(|| {
                ExecutionError::new(ErrorCode::Unauthorized, "team-recovery-live-anchor")
            })?,
        })
    }
    pub fn check_team_recovery(
        &self,
        store: &ProjectStore,
        prepared: &PreparedTeamRecovery,
    ) -> Result<(), ExecutionError> {
        let state = self.team_recovery_state(store, prepared.preview().plan_id)?;
        if self.generation() != prepared.runtime_generation
            || !state.original_deadline_available
            || self.team_deadlines.get(&prepared.preview().plan_id) != Some(&prepared.deadline)
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "team-recovery-live-anchor",
            ));
        }
        if !state.producers_drained {
            return Err(ExecutionError::new(
                ErrorCode::Busy,
                "team-recovery-producers",
            ));
        }
        store.check_team_recovery_capture(prepared)
    }
    pub fn authorize_team_recovery(
        &mut self,
        store: &mut ProjectStore,
        prepared: &PreparedTeamRecovery,
        authorization: &AuthorizeTeamRecovery,
    ) -> Result<TeamRecoveryReceipt, ExecutionError> {
        prepared.verify_digest(&authorization.digest)?;
        if let Some(receipt) =
            store.read_team_recovery_action(prepared.preview().project_id, authorization)?
        {
            return Ok(receipt);
        }
        self.check_team_recovery(store, prepared)?;
        store.commit_team_recovery(prepared, authorization)
    }
}
