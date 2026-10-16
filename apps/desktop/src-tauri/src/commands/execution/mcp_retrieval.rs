//! A single non-plugin adapter in the existing execution runtime. Only sealed
//! calls captured by the current desktop session can reach a transport.
use super::*;
use crate::commands::mcp_retrieval::{
    McpRetrievalTask,
    transport::{Connection, Work},
};
use tsumugi_core::application::{
    MCP_TERM_QUERY_CAPABILITY, MCP_TERM_QUERY_PROFILE, McpTermQueryPermit, PreparedMcpTermQuery,
};

pub(in crate::commands) struct Call {
    pub prepared: PreparedMcpTermQuery,
    pub permit: McpTermQueryPermit,
    pub connection: Arc<Connection>,
    _work: Work,
}
impl Call {
    pub(in crate::commands) fn new(
        prepared: PreparedMcpTermQuery,
        permit: McpTermQueryPermit,
        connection: Arc<Connection>,
    ) -> Self {
        let work = connection.work();
        Self {
            prepared,
            permit,
            connection,
            _work: work,
        }
    }
}
impl Drop for Call {
    fn drop(&mut self) {
        self.permit.revoke();
        self.connection.close();
    }
}
#[derive(Default)]
pub(in crate::commands) struct McpRunner {
    calls: Mutex<BTreeMap<ExecutionId, Call>>,
}
impl McpRunner {
    fn install(&self, call: Call) -> Result<(), CommandError> {
        let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
        if !calls.is_empty() {
            return Err(CommandError::simple(
                CommandErrorCode::Busy,
                CommandStage::ExecutionRecover,
            ));
        }
        calls.insert(call.prepared.input().envelope().attempt_id, call);
        Ok(())
    }
    fn remove(&self, attempt: ExecutionId) {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&attempt);
    }
    pub(super) fn reap(
        &self,
        store: &ProjectStore,
        runtime: &ExecutionRuntime,
    ) -> Result<(), ExecutionError> {
        let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
        let mut retired = Vec::new();
        for attempt in calls.keys() {
            if !runtime.has_owned_attempt_work(*attempt)
                && store
                    .execution_attempt(*attempt, true)?
                    .items
                    .iter()
                    .all(|item| {
                        !matches!(
                            item.execution,
                            ExecutionState::Queued | ExecutionState::Dispatched
                        )
                    })
            {
                retired.push(*attempt);
            }
        }
        // Only a terminal original ledger fact can retire an undispatched
        // call. Stop alone neither cancels its Task nor proves non-enqueue.
        for attempt in retired {
            calls.remove(&attempt);
        }
        Ok(())
    }
}
impl Runner for McpRunner {
    fn capability_id(&self) -> &str {
        MCP_TERM_QUERY_CAPABILITY
    }
    fn capability_version(&self) -> &str {
        MCP_TERM_QUERY_PROFILE
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancel: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let call = self
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&request.input.envelope().attempt_id)
            .ok_or_else(|| ExecutionError::new(ErrorCode::Unauthorized, "mcp-query-call"))?;
        call.permit.check_input(&request.input)?;
        let work = call.connection.work();
        let outcome = tauri::async_runtime::block_on(async {
            if cancel.is_requested() {
                return Err(CommandError::simple(
                    CommandErrorCode::Cancelled,
                    CommandStage::ExecutionRecover,
                ));
            }
            // The original runtime's cancellation is an atomic signal. Observe
            // it without a database poll or a second execution scheduler.
            let cancelled = async {
                while !cancel.is_requested() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            call.permit
                .check_input(&request.input)
                .map_err(map_recover)?;
            tokio::select! { biased;
                _ = cancelled => Err(CommandError::unknown(CommandStage::ExecutionRecover)),
                _ = tokio::time::sleep_until(call.permit.deadline().into()) => Err(CommandError::unknown(CommandStage::ExecutionRecover)),
                value = call.connection.call(&call.prepared.preview().request.tool, call.prepared.preview().arguments.clone()) => value,
            }
        });
        // A reply does not restore a withdrawn or expired original permit.
        // The external effect may already have happened, so discard late data
        // as Unknown rather than claiming a safe failure or accepting success.
        let outcome = if outcome.is_ok()
            && !call.connection.accept_result(|| {
                !cancel.is_requested() && call.permit.check_input(&request.input).is_ok()
            }) {
            Err(CommandError::unknown(CommandStage::ExecutionRecover))
        } else {
            outcome
        };
        call.connection.close();
        let (mut state, mut output, mut diagnostic) = match outcome {
            Ok(output) => (ExecutionState::Succeeded, Some(output), None),
            Err(error) => (
                if error.code == CommandErrorCode::OutcomeUnknown {
                    ExecutionState::Unknown
                } else {
                    ExecutionState::Failed
                },
                None,
                Some(Diagnostic {
                    code: "mcp-query-transport".into(),
                    retry_safe: false,
                }),
            ),
        };
        let envelope = |state, output, diagnostic| ResultEnvelope {
            plugin: None,
            project_id: request.input.envelope().project_id,
            attempt_id: request.input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: MCP_TERM_QUERY_CAPABILITY.into(),
            capability_version: MCP_TERM_QUERY_PROFILE.into(),
            outcome: state,
            output,
            diagnostic,
        };
        let result = FixedResult::capture(
            envelope(state, output.clone(), diagnostic.clone()),
            &request.input,
            request.dispatch_token,
        )?;
        let result = if state == ExecutionState::Succeeded
            && tsumugi_core::validate_mcp_term_query_result(&request.input, &result).is_err()
        {
            state = ExecutionState::Failed;
            output = None;
            diagnostic = Some(Diagnostic {
                code: "mcp-query-output".into(),
                retry_safe: false,
            });
            FixedResult::capture(
                envelope(state, output, diagnostic),
                &request.input,
                request.dispatch_token,
            )?
        } else {
            result
        };
        let result = results.send(result);
        drop(work);
        result
    }
}
pub(in crate::commands) fn start(
    active: &mut ActiveSession,
    call: Call,
) -> Result<McpRetrievalTask, CommandError> {
    let prepared = call.prepared.clone();
    let permit = call.permit.clone();
    let input = prepared.input();
    let task = McpRetrievalTask {
        task_id: input.envelope().task_id,
        attempt_id: input.envelope().attempt_id,
        input_digest: input.digest().into(),
    };
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    host.mcp_runner
        .reap(store, &host.runtime)
        .map_err(map_recover)?;
    host.mcp_runner.install(call)?;
    if let Err(error) = host
        .runtime
        .submit_mcp_term_query(store, &prepared, &permit)
    {
        host.mcp_runner.remove(task.attempt_id);
        return Err(map_recover(error));
    }
    Ok(task)
}
pub(in crate::commands) fn owned(active: &ActiveSession, attempt: ExecutionId) -> bool {
    active
        .execution
        .as_ref()
        .is_some_and(|host| host.runtime.has_owned_attempt_work(attempt))
        || active
            .store
            .execution_attempt(attempt, true)
            .map_or(true, |view| {
                view.items.iter().any(|item| {
                    matches!(
                        item.execution,
                        ExecutionState::Queued | ExecutionState::Dispatched
                    )
                })
            })
}
