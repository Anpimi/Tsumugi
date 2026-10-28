use super::ai_wire::{AiConfig, AiItemView, AiOutputView, AiPreviewView, ProviderBudget};
use super::*;
use crate::commands::connections;
use tsumugi_core::ai::AiPreview;
mod automation;
pub(super) use automation::PreparedTracking;
#[cfg(test)]
pub(super) use automation::commit_candidate;
pub use automation::{EffectPhase, EffectView};
#[cfg(test)]
mod candidate_effect_tests;
#[derive(Default)]
pub(super) struct AiSession {
    preview: Option<(AiPreview, FixedInput)>,
    automation: automation::Automation,
}
impl AiSession {
    pub(super) fn stop_package(
        &mut self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) {
        self.automation.stop_package(package);
    }
    pub(super) fn package_active(
        &self,
        package: &crate::commands::plugins::PluginPackageRequest,
    ) -> bool {
        self.automation.package_active(package)
    }
    #[cfg(test)]
    pub(super) fn pause_check_computation(&mut self, probe: review::ComputeProbe) {
        self.automation.compute_probe = Some(probe);
    }
    pub(super) fn track(
        &mut self,
        store: &ProjectStore,
        input: &FixedInput,
        consent: Option<work_plans::CheckerConsent>,
    ) -> Result<(), ExecutionError> {
        self.automation.track(store, input, consent)
    }
    pub(super) fn prepare_service_tracking(
        &mut self,
        store: &ProjectStore,
        prepared: &tsumugi_core::application::PreparedWorkPlanServiceGeneration,
        consent: Option<work_plans::CheckerConsent>,
    ) -> Result<PreparedTracking<'_>, ExecutionError> {
        self.automation
            .prepare_service_tracking(store, prepared, consent)
    }
    pub(super) fn tick(&mut self, store: &mut ProjectStore, runtime: &mut ExecutionRuntime) {
        self.automation.tick(store, runtime);
    }
    pub(super) fn release_terminal_service_origins(
        &mut self,
        store: &ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<(), ExecutionError> {
        self.automation
            .release_terminal_service_origins(store, runtime)
    }
    pub(super) fn prepare_runtime_tick(
        &mut self,
        store: &mut ProjectStore,
        runtime: &mut ExecutionRuntime,
    ) -> Result<Option<work_plans::CheckerConsent>, CommandError> {
        self.automation.prepare_runtime_tick(store, runtime)
    }
    pub(super) fn active(&self) -> bool {
        self.automation.active()
    }
    pub(super) fn plan_active(&self, plan: ExecutionId) -> bool {
        self.automation.plan_active(plan)
    }
    pub(super) fn stop(&mut self) {
        self.automation.stop();
    }
}
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] AiPreviewRequest {config:AiConfig,locale:String,unit_ids:Vec<ExecutionId>});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AiStartRequest {
        attempt_id: ExecutionId,
        digest: String,
        confirmed: bool
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AiReadRequest {
        attempt_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AiEffectRetryRequest {
        attempt_id: ExecutionId,
        item_id: ExecutionId
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] AiCandidateEffectRequest {
    unit_id: ExecutionId,
    locale: String,
    revision_id: ExecutionId,
});

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiCandidateEffectView {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub revision_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
    pub task_id: ExecutionId,
    pub plan_id: Option<ExecutionId>,
    pub plan_generation: Option<Revision>,
    pub current_result: bool,
    /// A matching producer is retained in this session, not an execution grant.
    pub retained: bool,
    pub effect: Option<EffectView>,
}

fn effect_projection(receipt: Option<tsumugi_core::application::AutomaticSelectionReceipt>, live: Option<EffectView>) -> Option<EffectView> {
    receipt.map(|receipt| EffectView { phase:automation::phase_for(&receipt),action_id:Some(receipt.request.action_id),
        receipt:Some(receipt),error:None,retryable:false }).or(live)
}

#[tauri::command]
pub async fn read_ai_candidate_effect(state: State<'_,AppState>, request: AiCandidateEffectRequest) -> Result<AiCandidateEffectView,CommandError> {
    state.sessions.run("read_ai_candidate_effect",CommandStage::ExecutionRead,move |sessions| {
        let active = authorized(sessions,&request.session_token,request.project_id,CommandStage::ExecutionRead)?;
        let value = active.store.saved_ai_candidate_effect(request.project_id,request.unit_id,&request.locale,request.revision_id).map_err(map_read)?;
        // Observing history never constructs a runtime, retains consent or ticks a producer.
        let live = match active.execution.as_ref() { Some(host) => host.ai.automation.view_for_candidate(&value).map_err(map_read)?, None => None };
        let retained = live.is_some();
        let effect = effect_projection(value.receipt,live);
        let view = AiCandidateEffectView { project_id:value.project_id,unit_id:value.unit_id,locale:value.locale,revision_id:value.revision_id,
            source_snapshot_id:value.source_snapshot_id,source_revision_id:value.source_revision_id,attempt_id:value.attempt_id,item_id:value.item_id,
            result_id:value.result_id,task_id:value.task_id,plan_id:value.lease.map(|lease| lease.plan_id),plan_generation:value.lease.map(|lease| lease.generation),
            current_result:value.current_result,retained,effect };
        if serde_json::to_vec(&view).map_err(|_| map_read(ExecutionError::new(ErrorCode::CorruptLedger,"ai-candidate-effect-encoding")))?.len() > tsumugi_core::content::MAX_CONTENT_PAGE_BYTES {
            return Err(map_read(ExecutionError::new(ErrorCode::LimitExceeded,"ai-candidate-effect-bytes")));
        }
        Ok(view)
    }).await
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPrepared {
    preview: AiPreviewView,
    attempt_id: ExecutionId,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRow {
    item: AiItemView,
    item_id: ExecutionId,
    result_id: Option<ExecutionId>,
    output: Option<AiOutputView>,
    saved_revision_id: Option<ExecutionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    candidate_decision: Option<tsumugi_core::CandidateDecision>,
    automation: Option<EffectView>,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiView {
    plan_id: Option<ExecutionId>,
    plan_generation: Option<Revision>,
    budget: Option<ProviderBudget>,
    config: AiConfig,
    recipe: String,
    detail: AttemptDetail,
    rows: Vec<AiRow>,
}
fn map_ai(e: ExecutionError) -> CommandError {
    let result = map_read(e);
    result
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    #[test]
    fn ai_wire_fixture_matches_actual_rust_requests_and_responses() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/aiCommands.contract.json"
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
        round_trip!("requests", "preview", AiPreviewRequest);
        round_trip!("requests", "start", AiStartRequest);
        round_trip!("requests", "read", AiReadRequest);
        round_trip!("requests", "effectRetry", AiEffectRetryRequest);
        round_trip!("responses", "prepared", AiPrepared);
        round_trip!("responses", "identity", ExecutionId);
        round_trip!("responses", "view", AiView);
        round_trip!("responses", "automaticView", AiView);
        round_trip!("requests", "automaticRead", AiReadRequest);
        round_trip!("responses", "effectRetry", bool);
        let mut value = fixture["responses"]["view"].clone();
        value["rows"][0]["output"]["usage"]["promptTokens"] = serde_json::json!(1);
        assert!(serde_json::from_value::<AiView>(value).is_err());
        let mut value = fixture["responses"]["prepared"].clone();
        value["preview"]["items"][0]["resourceBaseline"] =
            serde_json::json!("18446744073709551616");
        assert!(serde_json::from_value::<AiPrepared>(value).is_err());
    }
}
#[tauri::command]
pub async fn preview_ai_translation(
    state: State<'_, AppState>,
    request: AiPreviewRequest,
) -> Result<AiPrepared, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "preview_ai_translation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                connections::verify_configs(connections.as_ref(), std::slice::from_ref(&request.config))?;
                let preview = store
                    .preview_ai(request.config.into(), &request.locale, &request.unit_ids)
                    .map_err(map_ai)?;
                let input = preview
                    .fixed_input(
                        store
                            .metadata()
                            .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRead))?
                            .project_id(),
                    )
                    .map_err(map_ai)?;
                let attempt_id = input.envelope().attempt_id;
                host.ai.preview = Some((preview.clone(), input));
                Ok(AiPrepared {
                    preview: preview.into(),
                    attempt_id,
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn read_ai_start_action(
    state: State<'_, AppState>, request: AiStartRequest,
) -> Result<Option<tsumugi_core::ai::AiStartReceipt>, CommandError> {
    state.sessions.run("read_ai_start_action", CommandStage::ExecutionRead, move |sessions| {
        authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?
            .store.ai_start_action_read(request.project_id, request.attempt_id, &request.digest, request.confirmed)
            .map_err(map_read)
    }).await
}
#[tauri::command]
pub async fn start_ai_translation(
    state: State<'_, AppState>,
    request: AiStartRequest,
) -> Result<ExecutionId, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "start_ai_translation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                if !request.confirmed {
                    return Err(map_ai(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "ai-consent",
                    )));
                }
                // A lost start response must be reconciled against the durable identity;
                // never create another input or silently send the same work twice.
                let existing = match store.execution_input(request.attempt_id) {
                    Ok(input) => Some(input),
                    Err(e)
                        if e.code == ErrorCode::InvalidInput && e.stage == "execution-storage" =>
                    {
                        None
                    }
                    Err(e) => return Err(map_ai(e)),
                };
                if let Some(input) = existing {
                    let config = tsumugi_core::ai::settings(&input).map_err(map_ai)?.config;
                    let items = input
                        .envelope()
                        .items
                        .iter()
                        .map(|i| tsumugi_core::ai::item_payload(&input, i.item_id))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(map_ai)?;
                    let digest =
                        tsumugi_core::ai::preview_digest(&config, &items).map_err(map_ai)?;
                    if digest == request.digest {
                        return Ok(request.attempt_id);
                    }
                    return Err(map_ai(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "ai-preview",
                    )));
                }
                let (preview, input) = host
                    .ai
                    .preview
                    .as_ref()
                    .filter(|(p, i)| {
                        p.digest == request.digest && i.envelope().attempt_id == request.attempt_id
                    })
                    .cloned()
                    .ok_or_else(|| {
                        map_ai(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "ai-preview",
                        ))
                    })?;
                let current = store
                    .preview_ai(
                        preview.config.clone(),
                        &preview.items[0].target_locale,
                        &preview.items.iter().map(|i| i.unit_id).collect::<Vec<_>>(),
                    )
                    .map_err(map_ai)?;
                if current.digest != preview.digest {
                    return Err(map_ai(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "ai-preview",
                    )));
                }
                connections::verify_configs(connections.as_ref(), std::slice::from_ref(&preview.config))?;
                host.runtime.submit(store, &input).map_err(map_ai)?;
                Ok(request.attempt_id)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_ai_translation(
    state: State<'_, AppState>,
    request: AiReadRequest,
) -> Result<AiView, CommandError> {
    state
        .sessions
        .run(
            "read_ai_translation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let store = &active.store;
                let running = active.execution.as_ref()
                    .is_some_and(|host| host.runtime.is_active(request.attempt_id));
                let input = store.execution_input(request.attempt_id).map_err(map_ai)?;
                let settings = tsumugi_core::ai::settings(&input).map_err(map_ai)?;
                let detail = attempt_detail_read(store, request.attempt_id, running, 0, 100)?;
                let rows = detail
                    .items
                    .iter()
                    .map(|row| {
                        let item = tsumugi_core::ai::item_payload(&input, row.status.item_id)?;
                        let output = if let Some(id) = row.result_id {
                            let result = store.execution_result(request.attempt_id, id)?;
                            if result.envelope().outcome == ExecutionState::Succeeded
                                && row.status.validation == ValidationState::Valid
                            {
                                Some(tsumugi_core::ai::validate_output(&input, &result)?)
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        let saved_revision_id =
                            store.saved_ai_candidate(request.attempt_id, row.status.item_id)?;
                        let candidate_decision = saved_revision_id.map(|revision| store.translation_candidate_decision(request.project_id,revision)).transpose()?.flatten();
                        let receipt = match (input.envelope().automation, saved_revision_id) {
                            (Some(lease), Some(revision)) => {
                                store.automatic_selection_for_candidate(lease, revision)?
                            }
                            _ => None,
                        };
                        let live = if receipt.is_none() {
                            active.execution.as_ref().and_then(|host| {
                                host.ai.automation.view(request.attempt_id, row.status.item_id)
                            })
                        } else { None };
                        let automation = if let Some(view) = effect_projection(receipt, live) {
                            Some(view)
                        } else if let Some(lease) = input.envelope().automation {
                            let plan = store.work_plan(lease.plan_id)?;
                            let checks = plan
                                .options
                                .requests(tsumugi_core::application::AutomationEffect::RunChecks);
                            let selection = plan.options.selection_policy
                                != tsumugi_core::application::SelectionPolicy::CandidatesOnly;
                            (checks || selection || saved_revision_id.is_some()).then_some(
                                EffectView {
                                    // Reopening can display the saved candidate,
                                    // but cannot reconstruct an unfinished checker
                                    // session or claim that its QA was recorded.
                                    phase: if checks || selection {
                                        EffectPhase::Cancelled
                                    } else {
                                        EffectPhase::Saved
                                    },
                                    action_id: None,
                                    receipt: None,
                                    error: None,
                                    retryable: false,
                                },
                            )
                        } else {
                            None
                        };
                        Ok(AiRow {
                            item: item.into(),
                            item_id: row.status.item_id,
                            result_id: row.result_id,
                            output: output.map(Into::into),
                            saved_revision_id,
                            candidate_decision,
                            automation,
                        })
                    })
                    .collect::<Result<Vec<_>, ExecutionError>>()
                    .map_err(map_ai)?;
                // Continued attempts share the original plan's charged budget;
                // a child-only summary would hide prior requests and unknowns.
                let budget_owner = match input.envelope().automation {
                    Some(lease) => {
                        store
                            .work_plan(lease.plan_id)
                            .map_err(map_read)?
                            .execution_input()
                            .map_err(map_read)?
                            .task_id
                    }
                    None => input.envelope().task_id,
                };
                Ok(AiView {
                    plan_id: input.envelope().automation.map(|lease| lease.plan_id),
                    plan_generation: input.envelope().automation.map(|lease| lease.generation),
                    budget: store.provider_budget(budget_owner).map_err(map_read)?.map(Into::into),
                    config: settings.config,
                    recipe: settings.recipe,
                    detail,
                    rows,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn retry_work_plan_effect(
    state: State<'_, AppState>,
    request: AiEffectRetryRequest,
) -> Result<bool, CommandError> {
    state
        .sessions
        .run(
            "retry_work_plan_effect",
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
                host.ai
                    .automation
                    .retry(store, request.attempt_id, request.item_id)
                    .map_err(map_adopt)?;
                Ok(true)
            },
        )
        .await
}
