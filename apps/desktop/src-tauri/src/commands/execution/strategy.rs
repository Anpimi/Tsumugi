//! Project-local strategy facts use the existing serialized project owner.
//! Only a live preparation can enqueue its original Arena input.
use super::ai_wire::ArenaPreviewView;
use super::*;
use crate::commands::connections;
use tsumugi_core::{
    CaptureContextStrategy, CaptureStrategyEvaluation, CaptureStrategySuite,
    ContextStrategyCandidate, ContextStrategyCandidatePage, ContextStrategyDefaultPage,
    ContextStrategyDefaultRevision, PromoteContextStrategy, StrategyCheckReceipt,
    StrategyEvaluation, StrategyEvaluationPage, StrategyEvaluationSlot, StrategyJudgment,
    StrategyJudgmentRequest, StrategySuiteUnit, WithdrawContextStrategy,
};

#[derive(Default)]
pub(super) struct StrategySession {
    prepared: Option<(ExecutionId, ExecutionId, String)>,
}
impl StrategySession {
    pub(super) fn stop(&mut self) {
        self.prepared = None;
    }
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CaptureRequest {
        capture: CaptureContextStrategy
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    CandidateRequest {
        candidate_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    LocaleRequest { locale: String }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PageRequest {
        locale: String,
        offset: u32,
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SuiteCaptureRequest {
        capture: CaptureStrategySuite
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    EvaluationPrepareRequest {
        capture: CaptureStrategyEvaluation
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    EvaluationRequest {
        evaluation_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    EvaluationStartRequest {
        evaluation_id: ExecutionId,
        attempt_id: ExecutionId,
        digest: String,
        confirmed: bool
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    JudgmentRequest {
        judgment: StrategyJudgmentRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    PromoteRequest {
        promotion: PromoteContextStrategy
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WithdrawRequest {
        withdrawal: WithdrawContextStrategy
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ActionRequest {
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    SaveCandidateRequest {
        evaluation_id: ExecutionId,
        item_id: ExecutionId,
        result_id: ExecutionId,
        action_id: ExecutionId
    }
);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct Prepared {
    pub evaluation: StrategyEvaluation,
    pub preview: ArenaPreviewView,
    pub attempt_id: ExecutionId,
    pub can_start: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategySuiteView {
    pub suite_id: ExecutionId,
    pub request: CaptureStrategySuite,
    pub candidate_id: ExecutionId,
    pub project_id: ExecutionId,
    pub locale: String,
    pub preview: ArenaPreviewView,
    pub units: Vec<StrategySuiteUnit>,
    pub digest: String,
}
impl TryFrom<tsumugi_core::StrategySuite> for StrategySuiteView {
    type Error = ExecutionError;
    fn try_from(suite: tsumugi_core::StrategySuite) -> Result<Self, Self::Error> {
        Ok(Self {
            suite_id: suite.suite_id,
            request: suite.request,
            candidate_id: suite.candidate_id,
            project_id: suite.project_id,
            locale: suite.locale,
            preview: suite.preview.try_into()?,
            units: suite.units,
            digest: suite.digest,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StrategyEvaluationView {
    pub evaluation: StrategyEvaluation,
    pub candidate: ContextStrategyCandidate,
    pub suite: StrategySuiteView,
    pub slots: Vec<StrategyEvaluationSlot>,
    pub checks: Vec<StrategyCheckReceipt>,
    pub judgments: Vec<StrategyJudgment>,
    pub current: bool,
}
impl TryFrom<tsumugi_core::StrategyEvaluationView> for StrategyEvaluationView {
    type Error = ExecutionError;
    fn try_from(view: tsumugi_core::StrategyEvaluationView) -> Result<Self, Self::Error> {
        Ok(Self {
            evaluation: view.evaluation,
            candidate: view.candidate,
            suite: view.suite.try_into()?,
            slots: view.slots,
            checks: view.checks,
            judgments: view.judgments,
            current: view.current,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum StrategyActionReceiptView {
    Candidate {
        request: CaptureContextStrategy,
        candidate: ContextStrategyCandidate,
    },
    Suite {
        request: CaptureStrategySuite,
        suite: StrategySuiteView,
    },
    Evaluation {
        request: CaptureStrategyEvaluation,
        evaluation: StrategyEvaluation,
    },
    Check {
        receipt: StrategyCheckReceipt,
    },
    Judgment {
        judgment: StrategyJudgment,
    },
    Promoted {
        request: PromoteContextStrategy,
        revision: ContextStrategyDefaultRevision,
    },
    Withdrawn {
        request: WithdrawContextStrategy,
        revision: ContextStrategyDefaultRevision,
    },
}
impl TryFrom<tsumugi_core::StrategyActionReceipt> for StrategyActionReceiptView {
    type Error = ExecutionError;
    fn try_from(receipt: tsumugi_core::StrategyActionReceipt) -> Result<Self, Self::Error> {
        use tsumugi_core::StrategyActionReceipt as Core;
        Ok(match receipt {
            Core::Candidate { request, candidate } => Self::Candidate { request, candidate },
            Core::Suite { request, suite } => Self::Suite {
                request,
                suite: suite.try_into()?,
            },
            Core::Evaluation {
                request,
                evaluation,
            } => Self::Evaluation {
                request,
                evaluation,
            },
            Core::Check { receipt } => Self::Check { receipt },
            Core::Judgment { judgment } => Self::Judgment { judgment },
            Core::Promoted { request, revision } => Self::Promoted { request, revision },
            Core::Withdrawn { request, revision } => Self::Withdrawn { request, revision },
        })
    }
}

fn project_matches(outer: ExecutionId, inner: ExecutionId) -> Result<(), CommandError> {
    if outer != inner {
        return Err(CommandError::invalid_input(
            CommandStage::ExecutionAdopt,
            Some("strategy-project"),
        ));
    }
    Ok(())
}

fn allow_strategy_action(
    host: &ExecutionHost,
    store: &ProjectStore,
    project_id: ExecutionId,
    action_id: ExecutionId,
) -> Result<(), CommandError> {
    // Completed actions are historical reads; only new work needs live mutation
    // admission. Core still compares the complete original typed request.
    if store
        .read_strategy_action(project_id, action_id)
        .map_err(map_read)?
        .is_none()
    {
        host.allow_mutation()?;
    }
    Ok(())
}

#[tauri::command]
pub async fn capture_context_strategy(
    state: State<'_, AppState>,
    request: CaptureRequest,
) -> Result<ContextStrategyCandidate, CommandError> {
    state
        .sessions
        .run(
            "capture_context_strategy",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                project_matches(request.project_id, request.capture.basis.project_id)?;
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                allow_strategy_action(host, store, request.project_id, request.capture.action_id)?;
                store
                    .capture_context_strategy(&request.capture)
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_context_strategy(
    state: State<'_, AppState>,
    request: CandidateRequest,
) -> Result<ContextStrategyCandidate, CommandError> {
    state
        .sessions
        .run(
            "read_context_strategy",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .read_context_strategy(request.project_id, request.candidate_id)
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn list_context_strategies(
    state: State<'_, AppState>,
    request: PageRequest,
) -> Result<ContextStrategyCandidatePage, CommandError> {
    state
        .sessions
        .run(
            "list_context_strategies",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_context_strategies(
                    request.project_id,
                    &request.locale,
                    request.offset,
                    request.limit,
                )
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn capture_strategy_suite(
    state: State<'_, AppState>,
    request: SuiteCaptureRequest,
) -> Result<StrategySuiteView, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "capture_strategy_suite",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                project_matches(request.project_id, request.capture.project_id)?;
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                allow_strategy_action(host, store, request.project_id, request.capture.action_id)?;
                if store
                    .read_strategy_action(request.project_id, request.capture.action_id)
                    .map_err(map_read)?
                    .is_none()
                {
                    connections::verify_configs(
                        connections.as_ref(),
                        std::slice::from_ref(&request.capture.config),
                    )?;
                }
                store
                    .capture_strategy_suite(&request.capture)
                    .map_err(map_adopt)?
                    .try_into()
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_strategy_evaluation(
    state: State<'_, AppState>,
    request: EvaluationPrepareRequest,
) -> Result<Prepared, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "prepare_strategy_evaluation",
            CommandStage::ExecutionRead,
            move |sessions| {
                project_matches(request.project_id, request.capture.project_id)?;
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                let recorded = store
                    .read_strategy_action(request.project_id, request.capture.action_id)
                    .map_err(map_read)?
                    .is_some();
                if !recorded {
                    host.allow_mutation()?;
                    let suite = store
                        .read_strategy_suite(request.project_id, request.capture.suite_id)
                        .map_err(map_read)?;
                    connections::verify_configs(
                        connections.as_ref(),
                        &suite.preview.config.variants,
                    )?;
                }
                let evaluation = store
                    .capture_strategy_evaluation(&request.capture)
                    .map_err(map_adopt)?;
                let input = store
                    .strategy_evaluation_input(request.project_id, evaluation.evaluation_id)
                    .map_err(map_read)?;
                let suite = store
                    .read_strategy_suite(request.project_id, evaluation.suite_id)
                    .map_err(map_read)?;
                let identity = (
                    evaluation.evaluation_id,
                    input.envelope().attempt_id,
                    input.digest().to_owned(),
                );
                // Reading a saved preparation after reopening does not recreate consent
                // or grant the new session authority to enqueue that old experiment.
                if !recorded {
                    store
                        .check_strategy_evaluation_current(
                            request.project_id,
                            evaluation.evaluation_id,
                        )
                        .map_err(map_read)?;
                    host.strategy.prepared = Some(identity.clone());
                }
                let can_start = host.strategy.prepared.as_ref() == Some(&identity);
                Ok(Prepared {
                    evaluation,
                    preview: suite.preview.try_into().map_err(map_read)?,
                    attempt_id: identity.1,
                    can_start,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn start_strategy_evaluation(
    state: State<'_, AppState>,
    request: EvaluationStartRequest,
) -> Result<ExecutionId, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "start_strategy_evaluation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                let evaluation = store
                    .read_strategy_evaluation(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                let input = store
                    .strategy_evaluation_input(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                if evaluation.attempt_id != request.attempt_id || input.digest() != request.digest {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "strategy-preview",
                    )));
                }
                // The original submitted input is the receipt. A historical read/retry
                // returns it without restoring runtime authority or issuing a request.
                match store.execution_input(request.attempt_id) {
                    Ok(saved) if saved.digest() == input.digest() => return Ok(request.attempt_id),
                    Ok(_) => {
                        return Err(map_read(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "strategy-preview",
                        )));
                    }
                    Err(error)
                        if error.code == ErrorCode::InvalidInput
                            && error.stage == "execution-storage" => {}
                    Err(error) => return Err(map_read(error)),
                }
                host.allow_mutation()?;
                if !request.confirmed {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "strategy-consent",
                    )));
                }
                if host.strategy.prepared.as_ref()
                    != Some(&(
                        request.evaluation_id,
                        request.attempt_id,
                        request.digest.clone(),
                    ))
                {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "strategy-preparation",
                    )));
                }
                store
                    .check_strategy_evaluation_current(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                let view = store
                    .strategy_evaluation_view(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                connections::verify_configs(
                    connections.as_ref(),
                    &view.suite.preview.config.variants,
                )?;
                host.runtime.submit(store, &input).map_err(map_read)?;
                Ok(request.attempt_id)
            },
        )
        .await
}

#[tauri::command]
pub async fn save_strategy_evaluation_candidate(
    state: State<'_, AppState>,
    request: SaveCandidateRequest,
) -> Result<AdoptionReceipt, CommandError> {
    state
        .sessions
        .run(
            "save_strategy_evaluation_candidate",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                let evaluation = store
                    .read_strategy_evaluation(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                let input = store
                    .strategy_evaluation_input(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                let mut execution_units = input
                    .envelope()
                    .units
                    .iter()
                    .filter(|unit| unit.item_ids.as_slice() == [request.item_id]);
                let execution_unit_id = execution_units
                    .next()
                    .map(|unit| unit.unit_id)
                    .ok_or_else(|| {
                        map_adopt(ExecutionError::new(
                            ErrorCode::ResultMismatch,
                            "strategy-candidate-unit",
                        ))
                    })?;
                if execution_units.next().is_some() {
                    return Err(map_adopt(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "strategy-candidate-unit",
                    )));
                }
                let result = store
                    .execution_result(evaluation.attempt_id, request.result_id)
                    .map_err(map_adopt)?;
                if result.envelope().item_id != request.item_id {
                    return Err(map_adopt(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "strategy-candidate-result",
                    )));
                }
                // The original Arena validator reads the payload to bind the
                // result to its source unit, independently of its adoption unit.
                tsumugi_core::ai::arena::validate_output(&input, &result).map_err(map_adopt)?;
                // The original adoption action owns both normal retries and uncertain
                // results. Its complete fixed request is checked before receipt reads.
                match store.adoption_action(request.action_id) {
                    Ok(action) => {
                        if action.project_id != request.project_id
                            || action.attempt_id != evaluation.attempt_id
                            || action.unit_id != execution_unit_id
                            || action.result_ids != vec![request.result_id]
                            || action.operation != tsumugi_core::ai::arena::OPERATION
                            || !action.parameters.is_null()
                        {
                            return Err(map_adopt(ExecutionError::new(
                                ErrorCode::DependencyConflict,
                                "strategy-candidate-action",
                            )));
                        }
                        if let Some(receipt) = store
                            .adoption_receipt(request.action_id)
                            .map_err(map_adopt)?
                        {
                            return Ok(receipt);
                        }
                    }
                    Err(error)
                        if error.code == ErrorCode::InvalidInput
                            && error.stage == "execution-storage" => {}
                    Err(error) => return Err(map_adopt(error)),
                }
                host.allow_mutation()?;
                store
                    .check_strategy_evaluation_current(request.project_id, request.evaluation_id)
                    .map_err(map_adopt)?;
                let action = store
                    .prepare_adoption_with_id(
                        request.action_id,
                        evaluation.attempt_id,
                        execution_unit_id,
                        vec![request.result_id],
                        serde_json::Value::Null,
                    )
                    .map_err(map_adopt)?;
                store
                    .adopt_execution(&action, &tsumugi_core::ArenaAdoptionHandler)
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_strategy_evaluation(
    state: State<'_, AppState>,
    request: EvaluationRequest,
) -> Result<StrategyEvaluationView, CommandError> {
    state
        .sessions
        .run(
            "read_strategy_evaluation",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .strategy_evaluation_view(request.project_id, request.evaluation_id)
                .map_err(map_read)?
                .try_into()
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_strategy_evaluation_start(
    state: State<'_, AppState>,
    request: EvaluationRequest,
) -> Result<Option<ExecutionId>, CommandError> {
    state
        .sessions
        .run(
            "read_strategy_evaluation_start",
            CommandStage::ExecutionRead,
            move |sessions| {
                let store = &authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store;
                let expected = store
                    .strategy_evaluation_input(request.project_id, request.evaluation_id)
                    .map_err(map_read)?;
                let attempt = expected.envelope().attempt_id;
                match store.execution_input(attempt) {
                    Ok(input) if input.digest() == expected.digest() => Ok(Some(attempt)),
                    Ok(_) => Err(map_read(ExecutionError::new(
                        ErrorCode::ResultMismatch,
                        "strategy-evaluation-input",
                    ))),
                    Err(error)
                        if error.code == ErrorCode::InvalidInput
                            && error.stage == "execution-storage" =>
                    {
                        Ok(None)
                    }
                    Err(error) => Err(map_read(error)),
                }
            },
        )
        .await
}

#[tauri::command]
pub async fn list_strategy_evaluations(
    state: State<'_, AppState>,
    request: PageRequest,
) -> Result<StrategyEvaluationPage, CommandError> {
    state
        .sessions
        .run(
            "list_strategy_evaluations",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_strategy_evaluations(
                    request.project_id,
                    &request.locale,
                    request.offset,
                    request.limit,
                )
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn record_strategy_judgment(
    state: State<'_, AppState>,
    request: JudgmentRequest,
) -> Result<StrategyJudgment, CommandError> {
    state
        .sessions
        .run(
            "record_strategy_judgment",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                project_matches(request.project_id, request.judgment.project_id)?;
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                allow_strategy_action(host, store, request.project_id, request.judgment.action_id)?;
                store
                    .record_strategy_judgment(&request.judgment)
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn promote_context_strategy(
    state: State<'_, AppState>,
    request: PromoteRequest,
) -> Result<ContextStrategyDefaultRevision, CommandError> {
    state
        .sessions
        .run(
            "promote_context_strategy",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                project_matches(request.project_id, request.promotion.project_id)?;
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                allow_strategy_action(
                    host,
                    store,
                    request.project_id,
                    request.promotion.action_id,
                )?;
                store
                    .promote_context_strategy(&request.promotion)
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn withdraw_context_strategy(
    state: State<'_, AppState>,
    request: WithdrawRequest,
) -> Result<ContextStrategyDefaultRevision, CommandError> {
    state
        .sessions
        .run(
            "withdraw_context_strategy",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                project_matches(request.project_id, request.withdrawal.project_id)?;
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                allow_strategy_action(
                    host,
                    store,
                    request.project_id,
                    request.withdrawal.action_id,
                )?;
                store
                    .withdraw_context_strategy(&request.withdrawal)
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_context_strategy_default(
    state: State<'_, AppState>,
    request: LocaleRequest,
) -> Result<Option<ContextStrategyDefaultRevision>, CommandError> {
    state
        .sessions
        .run(
            "read_context_strategy_default",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .read_context_strategy_default(request.project_id, &request.locale)
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn list_context_strategy_defaults(
    state: State<'_, AppState>,
    request: PageRequest,
) -> Result<ContextStrategyDefaultPage, CommandError> {
    state
        .sessions
        .run(
            "list_context_strategy_defaults",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_context_strategy_defaults(
                    request.project_id,
                    &request.locale,
                    request.offset,
                    request.limit,
                )
                .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_strategy_action(
    state: State<'_, AppState>,
    request: ActionRequest,
) -> Result<Option<StrategyActionReceiptView>, CommandError> {
    state
        .sessions
        .run(
            "read_strategy_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .read_strategy_action(request.project_id, request.action_id)
                .map_err(map_read)?
                .map(TryInto::try_into)
                .transpose()
                .map_err(map_read)
            },
        )
        .await
}
