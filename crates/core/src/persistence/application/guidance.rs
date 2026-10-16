//! Static guidance observes the original tool grant, without preparing an input
//! or consulting current source material. Package content stays a Host concern.
use super::{ProjectStore, control};
use crate::{application::*, execution::*};

fn denied() -> ExecutionError {
    ExecutionError::new(ErrorCode::Unauthorized, "work-plan-guidance-scope")
}

impl ProjectStore {
    pub fn capture_work_plan_agent_guidance(
        &self,
        scope: &WorkPlanAgentScope,
    ) -> Result<CapturedWorkPlanToolGuidance, ExecutionError> {
        let connection = self.connection().map_err(|_| {
            ExecutionError::new(ErrorCode::StorageFailed, "work-plan-guidance-read")
        })?;
        super::super::review::read_snapshot(connection, |_| {
            self.check_work_plan_agent_scope(scope)?;
            let stored = control::load(connection, scope.lease.plan_id)?;
            if !stored.effects.contains(&AutomationEffect::QueryTools) {
                return Err(denied());
            }
            let tools = stored.plan.tools.ok_or_else(denied)?;
            Ok(CapturedWorkPlanToolGuidance {
                scope: scope.clone(),
                tools: tools
                    .entries
                    .into_iter()
                    .filter(|tool| {
                        scope
                            .delegation
                            .as_ref()
                            .is_none_or(|subset| subset.tool_handles.contains(&tool.handle))
                    })
                    .collect(),
            })
        })
    }

    /// Recheck after bounded package IO. A different caller, even under the same
    /// lease, cannot reuse this observation as its own scope witness.
    pub fn check_work_plan_agent_guidance(
        &self,
        scope: &WorkPlanAgentScope,
        captured: &CapturedWorkPlanToolGuidance,
    ) -> Result<(), ExecutionError> {
        if *scope != captured.scope {
            return Err(denied());
        }
        let current = self.capture_work_plan_agent_guidance(scope)?;
        if current.tools != captured.tools {
            return Err(denied());
        }
        Ok(())
    }
}
