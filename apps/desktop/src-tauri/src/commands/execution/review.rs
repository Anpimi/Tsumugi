use super::*;
use tsumugi_core::{
    CheckRun, Eligibility, FallbackDecision, FallbackWrite, ReviewDecision, ReviewHistoryPage,
    ReviewPage, ReviewTarget, ReviewWrite, Waiver, WaiverWrite, WorkPage,
};

request!(ReviewPageRequest {
    locale: String,
    after_ordinal: u32,
    limit: u32
});
request!(ReviewTargetRequest {
    unit_id: ExecutionId,
    locale: String
});
request!(ReviewHistoryRequest {
    unit_id: ExecutionId,
    locale: String,
    offset: u32,
    limit: u32
});
request!(ReviewWriteRequest {
    decision: ReviewWrite
});
request!(ReviewCheckRequest {
    unit_id: ExecutionId,
    locale: String,
    expected_basis: String,
    action_id: ExecutionId
});
request!(ReviewCancelCheckRequest {
    action_id: ExecutionId
});
request!(WaiverRequest {
    waiver: WaiverWrite
});
request!(FallbackRequest {
    fallback: FallbackWrite
});
request!(ReviewWorkRequest {
    locale: String,
    offset: u32,
    limit: u32
});
request!(EligibilityRequest { locales: Vec<String> });

fn mapped(error: ExecutionError, stage: CommandStage) -> CommandError {
    let reason = error.stage.clone();
    let mut result = map_execution(error, stage);
    result.field = Some(reason);
    result
}

#[tauri::command]
pub fn read_review_page(
    state: State<'_, AppState>,
    request: ReviewPageRequest,
) -> Result<ReviewPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .review_page(
        request.project_id,
        &request.locale,
        request.after_ordinal,
        request.limit,
    )
    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn read_review_target(
    state: State<'_, AppState>,
    request: ReviewTargetRequest,
) -> Result<ReviewTarget, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .review_target(request.project_id, request.unit_id, &request.locale)
    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn read_review_history(
    state: State<'_, AppState>,
    request: ReviewHistoryRequest,
) -> Result<ReviewHistoryPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .review_history(
        request.project_id,
        request.unit_id,
        &request.locale,
        request.offset,
        request.limit,
    )
    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn write_review_decision(
    state: State<'_, AppState>,
    request: ReviewWriteRequest,
) -> Result<ReviewDecision, CommandError> {
    if request.decision.project_id != request.project_id {
        return Err(CommandError::invalid_input(
            CommandStage::ExecutionAdopt,
            Some("review-project"),
        ));
    }
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .write_review(&request.decision)
        .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub async fn run_review_checks(
    state: State<'_, AppState>,
    request: ReviewCheckRequest,
) -> Result<CheckRun, CommandError> {
    let cancellation = Cancellation::default();
    let running_checks = Arc::clone(&state.review_check_cancellations);
    {
        let mut running = running_checks
            .lock()
            .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?;
        if running.contains_key(&request.action_id) {
            return Err(CommandError::simple(
                CommandErrorCode::Busy,
                CommandStage::ExecutionAdopt,
            ));
        }
        running.insert(
            request.action_id,
            (
                request.session_token.clone(),
                request.project_id,
                cancellation.clone(),
            ),
        );
    }
    // Keep the desktop event loop free to deliver cancel_review_checks while
    // this synchronous store operation holds the project session lock.
    let sessions = Arc::clone(&state.sessions);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = sessions.lock().map_err(|_| {
            CommandError::simple(CommandErrorCode::Busy, CommandStage::ExecutionAdopt)
        })?;
        let active = authorized(
            &mut sessions,
            &request.session_token,
            request.project_id,
            CommandStage::ExecutionAdopt,
        )?;
        let (host, store) = active.execution_parts()?;
        host.allow_mutation()?;
        store
            .run_review_checks_with_cancel(
                request.project_id,
                request.unit_id,
                &request.locale,
                &request.expected_basis,
                request.action_id,
                &cancellation,
            )
            .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
    })
    .await;
    running_checks
        .lock()
        .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
        .remove(&request.action_id);
    outcome.map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
}

#[tauri::command]
pub fn cancel_review_checks(
    state: State<'_, AppState>,
    request: ReviewCancelCheckRequest,
) -> Result<bool, CommandError> {
    let running = state
        .review_check_cancellations
        .lock()
        .map_err(|_| CommandError::unknown(CommandStage::ExecutionCancel))?;
    let Some((session, project, cancellation)) = running.get(&request.action_id) else {
        return Ok(false);
    };
    if session != &request.session_token || *project != request.project_id {
        return Err(CommandError::simple(
            CommandErrorCode::SessionInvalid,
            CommandStage::ExecutionCancel,
        ));
    }
    cancellation.request();
    Ok(true)
}

#[tauri::command]
pub fn waive_review_issue(
    state: State<'_, AppState>,
    request: WaiverRequest,
) -> Result<Waiver, CommandError> {
    if request.waiver.project_id != request.project_id {
        return Err(CommandError::invalid_input(
            CommandStage::ExecutionAdopt,
            Some("review-project"),
        ));
    }
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .waive_review_issue(&request.waiver)
        .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub fn allow_source_fallback(
    state: State<'_, AppState>,
    request: FallbackRequest,
) -> Result<FallbackDecision, CommandError> {
    if request.fallback.project_id != request.project_id {
        return Err(CommandError::invalid_input(
            CommandStage::ExecutionAdopt,
            Some("review-project"),
        ));
    }
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionAdopt)?;
    let active = authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionAdopt,
    )?;
    let (host, store) = active.execution_parts()?;
    host.allow_mutation()?;
    store
        .allow_source_fallback(&request.fallback)
        .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
}

#[tauri::command]
pub fn read_review_work(
    state: State<'_, AppState>,
    request: ReviewWorkRequest,
) -> Result<WorkPage, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .review_work_page(
        request.project_id,
        &request.locale,
        request.offset,
        request.limit,
    )
    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
}

#[tauri::command]
pub fn read_review_eligibility(
    state: State<'_, AppState>,
    request: EligibilityRequest,
) -> Result<Eligibility, CommandError> {
    let mut sessions = lock_sessions(&state, CommandStage::ExecutionRead)?;
    authorized(
        &mut sessions,
        &request.session_token,
        request.project_id,
        CommandStage::ExecutionRead,
    )?
    .store
    .review_eligibility(request.project_id, &request.locales)
    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
}
