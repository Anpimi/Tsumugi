//! A fixed query stays owned by the original live retrieval. A plan captures
//! its identity, never a replacement connection or a manual query consent.
use super::*;
use tsumugi_core::{application::WorkPlan, execution::Cancellation};

pub(super) struct Binding {
    plan_id: ExecutionId,
    digest: String,
    claimed: bool,
    stop: Cancellation,
}

impl Binding {
    pub(super) fn stop(&self) {
        self.stop.request();
    }
}
impl Drop for Binding {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
pub(in crate::commands) struct Captured {
    pub prepared: PreparedMcpTermQuery,
    pub connection: Arc<transport::Connection>,
    pub stop: Cancellation,
}

impl Captured {
    pub(in crate::commands) fn check(&self) -> Result<(), CommandError> {
        if self.stop.is_requested() {
            return Err(failure(CommandErrorCode::PermissionDenied));
        }
        Ok(())
    }
    pub(in crate::commands) fn close(&self) {
        self.connection.close();
    }
    pub(in crate::commands) fn drained(&self) -> bool {
        self.connection.drained()
    }
}

impl Retrievals {
    fn plan_intent(
        &mut self,
        token: &str,
        project: ExecutionId,
        plan: &WorkPlan,
    ) -> Result<Option<&mut Intent>, CommandError> {
        let Some(policy) = &plan.options.mcp_term_query else {
            return Ok(None);
        };
        let preview = policy.preview();
        let intent = self
            .current
            .as_mut()
            .filter(|intent| {
                intent.token == token
                    && intent.project == project
                    && intent.view.preview.as_ref() == Some(preview)
            })
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        if intent.control.closed()
            || !intent
                .connection
                .as_ref()
                .is_some_and(|connection| connection.live())
            || intent.view.phase != McpRetrievalPhase::Prepared
            || intent.view.consent.is_some()
            || intent.view.task.is_some()
            || intent.prepared.as_ref().map(|prepared| prepared.preview()) != Some(preview)
        {
            return Err(failure(CommandErrorCode::PermissionDenied));
        }
        Ok(Some(intent))
    }

    /// The final local preview can replace an unclaimed draft. It cannot replace
    /// a query whose original authorization may already have been accepted.
    pub(in crate::commands) fn bind_plan(
        &mut self,
        token: &str,
        project: ExecutionId,
        plan: &WorkPlan,
    ) -> Result<(), CommandError> {
        let Some(intent) = self.plan_intent(token, project, plan)? else {
            return Ok(());
        };
        if let Some(binding) = &intent.member_binding {
            if binding.plan_id == plan.plan_id && binding.digest == plan.digest {
                return Ok(());
            }
            if binding.claimed {
                return Err(failure(CommandErrorCode::Busy));
            }
            binding.stop();
        }
        intent.member_binding = Some(Binding {
            plan_id: plan.plan_id,
            digest: plan.digest.clone(),
            claimed: false,
            stop: Cancellation::default(),
        });
        Ok(())
    }

    /// Called in the original session owner before starting authorization IO.
    /// A failed or missing ACK never releases this claim or restores manual use.
    pub(in crate::commands) fn claim_plan(
        &mut self,
        token: &str,
        project: ExecutionId,
        plan: &WorkPlan,
    ) -> Result<(), CommandError> {
        let Some(intent) = self.plan_intent(token, project, plan)? else {
            return Ok(());
        };
        let binding = intent
            .member_binding
            .as_mut()
            .filter(|binding| {
                binding.plan_id == plan.plan_id
                    && binding.digest == plan.digest
                    && !binding.stop.is_requested()
            })
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        binding.claimed = true;
        Ok(())
    }

    pub(in crate::commands) fn capture_member(
        &self,
        token: &str,
        project: ExecutionId,
        plan: &WorkPlan,
    ) -> Result<Captured, CommandError> {
        let policy = plan
            .options
            .mcp_term_query
            .as_ref()
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        let intent = self
            .current
            .as_ref()
            .filter(|intent| {
                intent.token == token
                    && intent.project == project
                    && intent.view.preview.as_ref() == Some(policy.preview())
            })
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        let binding = intent
            .member_binding
            .as_ref()
            .filter(|binding| {
                binding.claimed
                    && binding.plan_id == plan.plan_id
                    && binding.digest == plan.digest
                    && !binding.stop.is_requested()
            })
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        let prepared = intent
            .prepared
            .clone()
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        let connection = intent
            .connection
            .clone()
            .filter(|connection| connection.live())
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        if intent.control.closed() || intent.view.task.is_some() || intent.view.consent.is_some() {
            return Err(failure(CommandErrorCode::PermissionDenied));
        }
        Ok(Captured {
            prepared,
            connection,
            stop: binding.stop.clone(),
        })
    }

    pub(in crate::commands) fn stop_plan(
        &mut self,
        token: &str,
        project: ExecutionId,
        plan: ExecutionId,
    ) {
        if let Some(intent) = self.current.as_mut().filter(|intent| {
            intent.token == token
                && intent.project == project
                && intent
                    .member_binding
                    .as_ref()
                    .is_some_and(|binding| binding.plan_id == plan)
        }) {
            intent.close();
        }
    }

    pub(in crate::commands) fn record_member_task(
        &mut self,
        token: &str,
        project: ExecutionId,
        plan: &WorkPlan,
        task: McpRetrievalTask,
    ) -> Result<(), CommandError> {
        let intent = self
            .current
            .as_mut()
            .filter(|intent| {
                intent.token == token
                    && intent.project == project
                    && intent.member_binding.as_ref().is_some_and(|binding| {
                        binding.claimed
                            && binding.plan_id == plan.plan_id
                            && binding.digest == plan.digest
                    })
            })
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?;
        let preview = plan
            .options
            .mcp_term_query
            .as_ref()
            .ok_or_else(|| failure(CommandErrorCode::PermissionDenied))?
            .preview();
        if task.task_id != preview.request.task_id
            || task.attempt_id != preview.request.attempt_id
            || task.input_digest != preview.input_digest
        {
            return Err(failure(CommandErrorCode::ResultMismatch));
        }
        intent.view.task = Some(task);
        intent.view.phase = McpRetrievalPhase::Enqueued;
        Ok(())
    }
}
