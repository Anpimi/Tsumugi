//! Explicit team work shares the existing Pi process and approved tool owner.
use super::*;
use tsumugi_core::{
    ai::team::{TeamWorkExecutor, TeamWorkSeed},
    application::TeamWorkOutput,
};

impl Owner {
    fn capture_team(
        &self,
        sessions: &mut SessionManager,
        request: &DispatchRequest,
    ) -> Result<CapturedScope, CommandError> {
        let (host, store) = self.original(sessions)?;
        host.allow_mutation()?;
        request.check_service_dispatch().map_err(map_recover)?;
        let author = store
            .capture_team_work_author(request)
            .map_err(map_recover)?;
        let scope = author.scope().clone();
        let tools = effective_tools(store, &scope)?;
        let consent = if tools.is_empty() {
            None
        } else {
            let consent = broker::current_consent(host, store, &scope)?;
            if store
                .capture_work_plan_agent_guidance(&scope)
                .map_err(map_recover)?
                .tools()
                != tools
            {
                return Err(map_recover(fail(ErrorCode::Unauthorized, "member-tools")));
            }
            Some(consent)
        };
        let mut revisions = BTreeSet::new();
        for tool in &tools {
            if tool.binding.capability.declaration.effect != sdk::EffectKind::ReadOnly
                || tool.binding.declaration.query.is_none()
            {
                return Err(map_recover(fail(ErrorCode::Unauthorized, "member-tool")));
            }
            revisions.insert(tool.settings_revision);
        }
        if revisions.len() > 1 {
            return Err(map_recover(fail(
                ErrorCode::DependencyConflict,
                "member-tool-revision",
            )));
        }
        let plan = store
            .work_plan(scope.lease().plan_id)
            .map_err(map_recover)?;
        Ok(CapturedScope {
            scope_id: scope.caller_id(),
            scope,
            consent,
            tools,
            tool_revision: revisions.into_iter().next(),
            team_author: Some(author),
            team_policy: plan.options.team_discussions,
            team_work: true,
        })
    }
}

impl MemberFactory {
    async fn run_team(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        service: Arc<ProviderService>,
    ) -> Result<TeamWorkOutput, ExecutionError> {
        let seed = TeamWorkSeed::capture(&request)?;
        let owner = self.owner.clone();
        let selected = request.clone();
        let captured = self
            .owner
            .context
            .callback
            .submit(
                "member.team.capture",
                CommandStage::ExecutionRecover,
                move |sessions| owner.capture_team(sessions, &selected),
            )
            .map_err(command_error)?
            .await
            .map_err(command_error)?;
        let output = self
            .run_process(
                request,
                cancellation,
                service,
                captured,
                MemberPrompt {
                    config: seed.config(),
                    item: seed.item(),
                    member_id: seed.binding().member_id(),
                    system: seed.system(),
                    input: seed.input(),
                },
            )
            .await?;
        seed.validate_output(
            &assistant_text(&output.messages)?,
            output.usage,
            output.requests,
            output.incomplete,
        )
    }
}

impl TeamWorkExecutor for MemberFactory {
    fn execute(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        service: Arc<ProviderService>,
    ) -> Result<TeamWorkOutput, ExecutionError> {
        self.executor_runtime()?
            .block_on(self.run_team(request, cancellation, service))
    }
}
