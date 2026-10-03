use super::*;

#[cfg(test)]
mod contracts {
    use super::*;

    #[test]
    fn review_wire_fixture_matches_actual_rust_requests_and_responses() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/reviewCommands.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($group:literal, $key:literal, $kind:ty) => {
                let value: $kind = serde_json::from_value(fixture[$group][$key].clone()).unwrap();
                assert_eq!(
                    serde_json::to_value(value).unwrap(),
                    fixture[$group][$key],
                    $key
                );
            };
        }
        round_trip!("requests", "page", ReviewPageRequest);
        round_trip!("requests", "target", ReviewTargetRequest);
        round_trip!("requests", "summary", ReviewSummaryPageRequest);
        round_trip!("requests", "neighbor", ReviewNeighborRequest);
        round_trip!("requests", "scope", ReviewScopeRequest);
        round_trip!("requests", "history", ReviewHistoryRequest);
        round_trip!("requests", "decision", ReviewWriteRequest);
        round_trip!("requests", "check", ReviewCheckRequest);
        round_trip!("requests", "cancelCheck", ReviewCancelCheckRequest);
        round_trip!("requests", "waiver", WaiverRequest);
        round_trip!("requests", "fallback", FallbackRequest);
        round_trip!("requests", "work", ReviewWorkRequest);
        round_trip!("requests", "eligibility", EligibilityRequest);
        round_trip!("responses", "page", ReviewPage);
        round_trip!("responses", "target", ReviewTarget);
        round_trip!("responses", "summary", ReviewSummaryPage);
        round_trip!("responses", "neighbor", ReviewNeighbor);
        round_trip!("responses", "scope", ReviewScopeCapture);
        round_trip!("responses", "history", ReviewHistoryPage);
        round_trip!("responses", "decision", ReviewDecision);
        round_trip!("responses", "check", CheckRun);
        round_trip!("responses", "cancelCheck", bool);
        round_trip!("responses", "waiver", Waiver);
        round_trip!("responses", "fallback", FallbackDecision);
        round_trip!("responses", "work", WorkPage);
        round_trip!("responses", "eligibility", Eligibility);
        round_trip!("responses", "editor", ReviewEditorSnapshot);
        let mut optional = fixture["requests"]["decision"].clone();
        optional["decision"]
            .as_object_mut()
            .unwrap()
            .remove("expectedDecisionId");
        assert!(
            serde_json::from_value::<ReviewWriteRequest>(optional)
                .unwrap()
                .decision
                .expected_decision_id
                .is_none()
        );
        let mut missing = fixture["responses"]["target"].clone();
        missing.as_object_mut().unwrap().remove("basisEvidence");
        assert!(serde_json::from_value::<ReviewTarget>(missing).is_err());
        let mut unknown = fixture["responses"]["check"].clone();
        unknown["outcome"] = serde_json::json!("passed");
        assert!(serde_json::from_value::<CheckRun>(unknown).is_err());
        let mut unknown = fixture["requests"]["decision"].clone();
        unknown["decision"]["kind"] = serde_json::json!("accept-all");
        assert!(serde_json::from_value::<ReviewWriteRequest>(unknown).is_err());
        let mut overflow = fixture["requests"]["neighbor"].clone();
        overflow["direction"] = serde_json::json!(-2147483649i64);
        assert!(serde_json::from_value::<ReviewNeighborRequest>(overflow).is_err());
        let mut overflow = fixture["responses"]["summary"].clone();
        overflow["total"] = serde_json::json!(4294967296u64);
        assert!(serde_json::from_value::<ReviewSummaryPage>(overflow).is_err());
    }
}
use tsumugi_core::{
    CheckRun, Eligibility, FallbackDecision, FallbackWrite, ReviewDecision, ReviewEditorSnapshot,
    ReviewHistoryPage, ReviewNeighbor, ReviewPage, ReviewScopeCapture, ReviewSummaryPage,
    ReviewTarget, ReviewWrite, Waiver, WaiverWrite, WorkPage,
};

request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ReviewPageRequest {
    locale: String,
    query: Option<String>,
    after_ordinal: u32,
    limit: u32
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewTargetRequest {
        unit_id: ExecutionId,
        locale: String
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ReviewSummaryPageRequest {
    locale: String,
    query: String,
    scope_id: Option<ExecutionId>,
    after_ordinal: u32,
    limit: u32
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewNeighborRequest {
        locale: String,
        scope_id: ExecutionId,
        unit_id: ExecutionId,
        direction: i32
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ReviewScopeRequest {
    locale: String,
    scope_id: ExecutionId,
    excluded: Vec<ExecutionId>
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewHistoryRequest {
        unit_id: ExecutionId,
        locale: String,
        offset: u32,
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewWriteRequest {
        decision: ReviewWrite
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewCheckRequest {
        unit_id: ExecutionId,
        locale: String,
        expected_basis: String,
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewCancelCheckRequest {
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WaiverRequest {
        waiver: WaiverWrite
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    FallbackRequest {
        fallback: FallbackWrite
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReviewWorkRequest {
        locale: String,
        offset: u32,
        limit: u32
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] EligibilityRequest { locales: Vec<String> });

fn mapped(error: ExecutionError, stage: CommandStage) -> CommandError {
    let result = map_execution(error, stage);
    result
}

#[tauri::command]
pub async fn read_review_summary_page(
    state: State<'_, AppState>,
    request: ReviewSummaryPageRequest,
) -> Result<ReviewSummaryPage, CommandError> {
    state
        .sessions
        .run(
            "read_review_summary_page",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .review_summary_page(
                        request.project_id,
                        &request.locale,
                        request.after_ordinal,
                        request.limit,
                        &request.query,
                        request.scope_id,
                    )
                    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_editor_snapshot(
    state: State<'_, AppState>,
    request: ReviewTargetRequest,
) -> Result<ReviewEditorSnapshot, CommandError> {
    state
        .sessions
        .run(
            "read_review_editor_snapshot",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .review_editor_snapshot(request.project_id, request.unit_id, &request.locale)
                .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_neighbor(
    state: State<'_, AppState>,
    request: ReviewNeighborRequest,
) -> Result<ReviewNeighbor, CommandError> {
    state
        .sessions
        .run(
            "read_review_neighbor",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .review_neighbor(
                    request.project_id,
                    &request.locale,
                    request.scope_id,
                    request.unit_id,
                    request.direction,
                )
                .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn capture_review_scope(
    state: State<'_, AppState>,
    request: ReviewScopeRequest,
) -> Result<ReviewScopeCapture, CommandError> {
    state
        .sessions
        .run(
            "capture_review_scope",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .review_scope_capture(
                    request.project_id,
                    &request.locale,
                    request.scope_id,
                    &request.excluded,
                )
                .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_page(
    state: State<'_, AppState>,
    request: ReviewPageRequest,
) -> Result<ReviewPage, CommandError> {
    state
        .sessions
        .run(
            "read_review_page",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                #[cfg(feature = "execution-test-host")]
                test_support::source_fixture_hook(&mut active.store, "review-page")
                    .map_err(map_read)?;
                active
                    .store
                    .review_page_filtered(
                        request.project_id,
                        &request.locale,
                        request.after_ordinal,
                        request.limit,
                        request.query.as_deref().unwrap_or(""),
                    )
                    .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_target(
    state: State<'_, AppState>,
    request: ReviewTargetRequest,
) -> Result<ReviewTarget, CommandError> {
    state
        .sessions
        .run(
            "read_review_target",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .review_target(request.project_id, request.unit_id, &request.locale)
                .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_history(
    state: State<'_, AppState>,
    request: ReviewHistoryRequest,
) -> Result<ReviewHistoryPage, CommandError> {
    state
        .sessions
        .run(
            "read_review_history",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
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
            },
        )
        .await
}

#[tauri::command]
pub async fn write_review_decision(
    state: State<'_, AppState>,
    request: ReviewWriteRequest,
) -> Result<ReviewDecision, CommandError> {
    state
        .sessions
        .run(
            "write_review_decision",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                if request.decision.project_id != request.project_id {
                    return Err(CommandError::invalid_input(
                        CommandStage::ExecutionAdopt,
                        Some("review-project"),
                    ));
                }
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .write_review(&request.decision)
                    .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

enum CheckCapture {
    Recorded(CheckRun),
    Prepared(tsumugi_core::PreparedReviewCheck),
}

#[cfg(test)]
pub(crate) struct ComputeProbe {
    pub action: ExecutionId,
    pub reached: std::sync::mpsc::Sender<()>,
    pub release: std::sync::mpsc::Receiver<()>,
}

struct ReviewCheckRegistration {
    registry: ReviewCheckRegistry,
    action: ExecutionId,
}
impl Drop for ReviewCheckRegistration {
    fn drop(&mut self) {
        self.registry
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&self.action);
    }
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
    // The registration lives with accepted work, even if its IPC waiter goes away.
    let registration = ReviewCheckRegistration {
        registry: running_checks,
        action: request.action_id,
    };
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let initial_cancellation = cancellation.clone();
    let captured = lease.submit(
        "run_review_checks.capture",
        CommandStage::ExecutionAdopt,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionAdopt,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            #[cfg(feature = "execution-test-host")]
            test_support::source_fixture_hook(store, "review-check").map_err(map_adopt)?;
            // Cancellation already requested at admission needs no computation.
            // Record it in command order, preserving its existing receipt semantics.
            if initial_cancellation.is_requested() {
                return store
                    .run_review_checks_with_cancel(
                        initial.project_id,
                        initial.unit_id,
                        &initial.locale,
                        &initial.expected_basis,
                        initial.action_id,
                        &initial_cancellation,
                    )
                    .map(CheckCapture::Recorded)
                    .map_err(|error| mapped(error, CommandStage::ExecutionAdopt));
            }
            store
                .prepare_review_check(
                    initial.project_id,
                    initial.unit_id,
                    &initial.locale,
                    &initial.expected_basis,
                    initial.action_id,
                )
                .map(CheckCapture::Prepared)
                .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
        },
    )?;
    let computation = state.io.clone();
    #[cfg(test)]
    let probe = {
        let mut pending = state.review_compute_probe.lock().unwrap();
        if pending
            .as_ref()
            .is_some_and(|probe| probe.action == request.action_id)
        {
            pending.take()
        } else {
            None
        }
    };
    // Once capture is accepted, completion and cancellation registration belong
    // to this continuation, not to the lifetime of the invoking webview waiter.
    tauri::async_runtime::spawn(async move {
        let _registration = registration;
        let prepared = match captured.await? {
            CheckCapture::Recorded(run) => return Ok(run),
            CheckCapture::Prepared(prepared) => prepared,
        };
        let compute_cancellation = cancellation.clone();
        let computed = computation
            .run(CommandStage::ExecutionAdopt, move || {
                #[cfg(test)]
                if let Some(probe) = probe {
                    probe.reached.send(()).unwrap();
                    probe
                        .release
                        .recv_timeout(std::time::Duration::from_secs(10))
                        .unwrap();
                }
                Ok(prepared.compute(&compute_cancellation))
            })
            .await?;
        lease
            .run(
                "run_review_checks.commit",
                CommandStage::ExecutionAdopt,
                move |sessions| {
                    let active = authorized(
                        sessions,
                        &request.session_token,
                        request.project_id,
                        CommandStage::ExecutionAdopt,
                    )?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    store
                        .commit_review_check(computed, &cancellation)
                        .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
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
pub async fn waive_review_issue(
    state: State<'_, AppState>,
    request: WaiverRequest,
) -> Result<Waiver, CommandError> {
    state
        .sessions
        .run(
            "waive_review_issue",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                if request.waiver.project_id != request.project_id {
                    return Err(CommandError::invalid_input(
                        CommandStage::ExecutionAdopt,
                        Some("review-project"),
                    ));
                }
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .waive_review_issue(&request.waiver)
                    .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

#[tauri::command]
pub async fn allow_source_fallback(
    state: State<'_, AppState>,
    request: FallbackRequest,
) -> Result<FallbackDecision, CommandError> {
    state
        .sessions
        .run(
            "allow_source_fallback",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                if request.fallback.project_id != request.project_id {
                    return Err(CommandError::invalid_input(
                        CommandStage::ExecutionAdopt,
                        Some("review-project"),
                    ));
                }
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .allow_source_fallback(&request.fallback)
                    .map_err(|error| mapped(error, CommandStage::ExecutionAdopt))
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_work(
    state: State<'_, AppState>,
    request: ReviewWorkRequest,
) -> Result<WorkPage, CommandError> {
    state
        .sessions
        .run(
            "read_review_work",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
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
            },
        )
        .await
}

#[tauri::command]
pub async fn read_review_eligibility(
    state: State<'_, AppState>,
    request: EligibilityRequest,
) -> Result<Eligibility, CommandError> {
    state
        .sessions
        .run(
            "read_review_eligibility",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .review_eligibility(request.project_id, &request.locales)
                .map_err(|error| mapped(error, CommandStage::ExecutionRead))
            },
        )
        .await
}
