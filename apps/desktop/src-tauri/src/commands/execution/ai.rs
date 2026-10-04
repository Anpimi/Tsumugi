use super::ai_wire::{AiItemView, AiOutputView, AiPreviewView};
use super::*;
use tsumugi_core::ai::{AiConfig, AiPreview};
#[derive(Default)]
pub(super) struct AiSession {
    preview: Option<(AiPreview, FixedInput)>,
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
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiView {
    budget: Option<tsumugi_core::ProviderBudget>,
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
        round_trip!("responses", "prepared", AiPrepared);
        round_trip!("responses", "identity", ExecutionId);
        round_trip!("responses", "view", AiView);
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
                let preview = store
                    .preview_ai(request.config, &request.locale, &request.unit_ids)
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
pub async fn start_ai_translation(
    state: State<'_, AppState>,
    request: AiStartRequest,
) -> Result<ExecutionId, CommandError> {
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
                let (host, store) = active.execution_parts()?;
                let input = store.execution_input(request.attempt_id).map_err(map_ai)?;
                let settings = tsumugi_core::ai::settings(&input).map_err(map_ai)?;
                let detail = attempt_detail(host, store, request.attempt_id, 0, 100)?;
                let rows = detail
                    .items
                    .iter()
                    .map(|row| {
                        let item = tsumugi_core::ai::item_payload(&input, row.status.item_id)?;
                        let output = if let Some(id) = row.result_id {
                            let result = store.execution_result(request.attempt_id, id)?;
                            if result.envelope().outcome == ExecutionState::Succeeded {
                                Some(tsumugi_core::ai::validate_output(&input, &result)?)
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        Ok(AiRow {
                            item: item.into(),
                            item_id: row.status.item_id,
                            result_id: row.result_id,
                            output: output.map(Into::into),
                        })
                    })
                    .collect::<Result<Vec<_>, ExecutionError>>()
                    .map_err(map_ai)?;
                Ok(AiView {
                    budget: store.provider_budget(input.envelope().task_id).map_err(map_read)?,
                    config: settings.config,
                    recipe: settings.recipe,
                    detail,
                    rows,
                })
            },
        )
        .await
}
