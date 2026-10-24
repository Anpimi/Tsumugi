//! The fixed MCP leaf uses the original query runner and ledger. Its transport
//! permission and its current member result-sharing proof have distinct lives.
use super::*;
use crate::commands::mcp_retrieval::member::Captured;
use tsumugi_core::application::{
    CapturedMemberMcpTermQuery, LookupCapturedTerms, member_mcp_term_query_tool,
};

pub(super) const TOOL: &str = "lookup_captured_terms";

#[derive(Clone)]
pub(super) struct Query {
    pub original: Captured,
    pub proof: CapturedMemberMcpTermQuery,
    pub dispatch: DispatchRequest,
    pub cancel_id: ExecutionId,
}

impl Query {
    pub(super) fn tool(&self) -> MemberTool {
        let tool = member_mcp_term_query_tool(self.proof.preview().request.unit_id);
        MemberTool {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
        }
    }
    fn arguments(&self, value: &Value) -> Result<(), ExecutionError> {
        let args: LookupCapturedTerms = serde_json::from_value(value.clone())
            .map_err(|_| fail(ErrorCode::InvalidInput, "member-mcp-arguments"))?;
        if args.unit_id != self.proof.preview().request.unit_id {
            return Err(fail(ErrorCode::Unauthorized, "member-mcp-unit"));
        }
        self.original.check().map_err(command_error)
    }
}

impl Handler {
    pub(super) fn mcp_tool(&self, name: &str, arguments: &Value) -> Result<bool, ExecutionError> {
        if name != TOOL {
            return Ok(false);
        }
        self.captured
            .mcp
            .as_ref()
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "member-mcp-policy"))?
            .arguments(arguments)?;
        Ok(true)
    }

    pub(super) async fn execute_mcp(&mut self) -> Result<MemberReply, ExecutionError> {
        let owner = self.owner.clone();
        let captured = self.captured.clone();
        let request = self.request.clone();
        let query = captured
            .mcp
            .clone()
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "member-mcp-policy"))?;
        let cancellation = self.cancellation.clone();
        let local_stop = self.local_stop.clone();
        let settings_stop = self.settings_stop.clone();
        let max_bytes = self.max_prompt_bytes;
        self.pending_provider = false;
        self.pending = Some(tokio::spawn(async move {
            let selected = request.clone();
            let checking = captured.clone();
            let binding = query.clone();
            let submitting = owner.clone();
            owner
                .context
                .callback
                .submit(
                    "member.mcp.start",
                    CommandStage::ExecutionRecover,
                    move |sessions| {
                        submitting.check_scope(sessions, &checking)?;
                        binding.original.check()?;
                        let (_, store) = submitting.original(sessions)?;
                        let plan = store
                            .work_plan(checking.scope.lease().plan_id)
                            .map_err(map_recover)?;
                        let preview = binding.proof.preview();
                        let task = if store
                            .execution_input_if_present(preview.request.attempt_id)
                            .map_err(map_recover)?
                            .is_some()
                        {
                            // Same accepted action: validate its exact association and
                            // read/wait its original result without minting another
                            // transport permit or installing a second Call.
                            store
                                .read_member_mcp_term_query_result(&selected, &binding.proof)
                                .map_err(map_recover)?;
                            crate::commands::mcp_retrieval::McpRetrievalTask {
                                task_id: preview.request.task_id,
                                attempt_id: preview.request.attempt_id,
                                input_digest: preview.input_digest.clone(),
                            }
                        } else {
                            let prepared = store
                                .prepare_member_mcp_term_query(
                                    &selected,
                                    &binding.proof,
                                    &binding.original.prepared,
                                )
                                .map_err(map_recover)?;
                            let active = authorized(
                                sessions,
                                &submitting.token,
                                submitting.project,
                                CommandStage::ExecutionRecover,
                            )?;
                            crate::commands::execution::mcp_retrieval::start_member(
                                active,
                                &prepared,
                                binding.original.connection.clone(),
                            )?
                        };
                        // Admission is already durable. Failure to project its view is
                        // uncertain, never grounds for issuing another query identity.
                        sessions
                            .mcp_retrieval
                            .record_member_task(&submitting.token, submitting.project, &plan, task)
                            .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))
                    },
                )
                .map_err(command_error)?
                .await
                .map_err(command_error)?;
            loop {
                if cancellation.is_requested()
                    || local_stop.is_requested()
                    || settings_stop.is_requested()
                    || Instant::now() >= query.proof.deadline()
                {
                    return Err(fail(ErrorCode::Cancelled, "member-mcp-cancelled"));
                }
                request.check_service_dispatch()?;
                query.original.check().map_err(command_error)?;
                let owner = owner.clone();
                let checking = captured.clone();
                let selected = request.clone();
                let checking_query = query.clone();
                let transport_drained = query.original.drained();
                let result = owner
                    .context
                    .callback
                    .clone()
                    .submit(
                        "member.mcp.read",
                        CommandStage::ExecutionRead,
                        move |sessions| {
                            owner.check_scope(sessions, &checking)?;
                            checking_query.original.check()?;
                            let (host, store) = owner.original(sessions)?;
                            let attempt = checking_query.proof.preview().request.attempt_id;
                            if host.runtime.has_owned_attempt_work(attempt) || !transport_drained {
                                return Ok(None);
                            }
                            store
                                .read_member_mcp_term_query_result(&selected, &checking_query.proof)
                                .map_err(map_read)
                        },
                    )
                    .map_err(command_error)?
                    .await
                    .map_err(command_error)?;
                if let Some(result) = result {
                    let text = serde_json::to_string(&result)
                        .map_err(|_| fail(ErrorCode::OutputInvalid, "member-mcp-result"))?;
                    if text.len() > max_bytes {
                        return Err(fail(ErrorCode::LimitExceeded, "member-mcp-result"));
                    }
                    return Ok(MemberReply::ToolResult {
                        content: json!([{"type":"text","text":text}]),
                        details: json!({"taskId":query.proof.preview().request.task_id,
                            "attemptId":query.proof.preview().request.attempt_id}),
                        is_error: false,
                    });
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }));
        let result = self.pending.as_mut().expect("pending query").await;
        self.pending.take();
        result.map_err(|_| {
            let error = fail(ErrorCode::OutcomeUnknown, "member-mcp-operation");
            self.join_failure.get_or_insert_with(|| error.clone());
            error
        })?
    }

    pub(super) async fn drain_mcp(&self) -> Result<(), ExecutionError> {
        let Some(query) = &self.captured.mcp else {
            return Ok(());
        };
        query.original.close();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let owner = self.owner.clone();
            let checking_query = query.clone();
            let pending = self
                .owner
                .context
                .callback
                .submit(
                    "member.mcp.drain",
                    CommandStage::ExecutionCancel,
                    move |sessions| {
                        let (host, store) = owner.original(sessions)?;
                        let attempt = checking_query.proof.preview().request.attempt_id;
                        let mut pending = host.runtime.has_owned_attempt_work(attempt);
                        if store
                            .execution_input_if_present(attempt)
                            .map_err(map_read)?
                            .is_some()
                        {
                            let detail =
                                store.execution_attempt(attempt, false).map_err(map_read)?;
                            pending |= detail.items.iter().any(|item| {
                                matches!(
                                    item.execution,
                                    ExecutionState::Queued | ExecutionState::Dispatched
                                )
                            });
                            if pending {
                                host.runtime
                                    .cancel(
                                        store,
                                        checking_query.proof.preview().request.task_id,
                                        checking_query.cancel_id,
                                    )
                                    .map_err(map_recover)?;
                            }
                        }
                        Ok(pending)
                    },
                )
                .map_err(command_error)?
                .await
                .map_err(command_error)?;
            if !pending && query.original.drained() {
                return Ok(());
            }
            if Instant::now() >= until {
                return Err(fail(ErrorCode::OutcomeUnknown, "member-mcp-drain"));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
