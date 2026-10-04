use super::ai_wire::{AiItemView, AiOutputView, ArenaPreviewView, index};
use super::*;
use tsumugi_core::{
    ComparisonRequest, ComparisonSummary, ComparisonView, MergeBasis, SaveTranslationRevision,
    TranslationSelection, ai::arena::*,
};

#[derive(Default)]
pub(super) struct ArenaSession {
    preview: Option<(ArenaPreview, FixedInput)>,
}
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] PreviewRequest { config:ArenaConfig, locale:String, unit_ids:Vec<ExecutionId> });
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    StartRequest {
        attempt_id: ExecutionId,
        digest: String,
        confirmed: bool
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ReadRequest {
        attempt_id: ExecutionId
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] ComparisonCommand { action_id:ExecutionId, unit_id:ExecutionId, locale:String, revision_ids:Vec<ExecutionId>, blind:bool });
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    ComparisonRead {
        comparison_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    RevealRequest {
        comparison_id: ExecutionId,
        action_id: ExecutionId
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] MergeRequest { action_id:ExecutionId, unit_id:ExecutionId, locale:String, source_revision_id:ExecutionId, expected_selection_id:Option<ExecutionId>, text:String, merge:MergeBasis });

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepared {
    preview: ArenaPreviewView,
    attempt_id: ExecutionId,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    item: AiItemView,
    item_id: ExecutionId,
    source_order: u32,
    label: u32,
    result_id: Option<ExecutionId>,
    output: Option<AiOutputView>,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    budget: Option<tsumugi_core::ProviderBudget>,
    detail: AttemptDetail,
    rows: Vec<Row>,
    variants: Option<Vec<tsumugi_core::ai::AiConfig>>,
    blind: bool,
    revealed: bool,
    different_inputs: bool,
    repeated_sampling: bool,
    parent_attempt_id: Option<ExecutionId>,
}
fn mapped(e: ExecutionError) -> CommandError {
    let e = map_read(e);
    e
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    #[test]
    fn arena_wire_fixture_matches_actual_rust_requests_and_responses() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/arenaCommands.contract.json"
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
        round_trip!("requests", "preview", PreviewRequest);
        round_trip!("requests", "start", StartRequest);
        round_trip!("requests", "read", ReadRequest);
        round_trip!("requests", "compare", ComparisonCommand);
        round_trip!("requests", "comparison", ComparisonRead);
        round_trip!("requests", "session", SessionRequest);
        round_trip!("requests", "reveal", RevealRequest);
        round_trip!("requests", "merge", MergeRequest);
        round_trip!("responses", "prepared", Prepared);
        round_trip!("responses", "identity", ExecutionId);
        round_trip!("responses", "view", View);
        round_trip!("responses", "comparison", ComparisonView);
        round_trip!("responses", "comparisons", Vec<ComparisonSummary>);
        round_trip!("responses", "reveal", ());
        round_trip!("responses", "selection", TranslationSelection);
        let mut value = fixture["responses"]["comparison"].clone();
        value["rows"][0]["originKind"] = serde_json::json!("best");
        assert!(serde_json::from_value::<ComparisonView>(value).is_err());
        let mut value = fixture["responses"]["view"].clone();
        value["rows"][0]["sourceOrder"] = serde_json::json!(4294967296u64);
        assert!(serde_json::from_value::<View>(value).is_err());
    }
}

#[tauri::command]
pub async fn preview_arena_translation(
    state: State<'_, AppState>,
    request: PreviewRequest,
) -> Result<Prepared, CommandError> {
    state
        .sessions
        .run(
            "preview_arena_translation",
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
                    .preview_arena(request.config, &request.locale, &request.unit_ids)
                    .map_err(mapped)?;
                let input = preview
                    .fixed_input(
                        store
                            .metadata()
                            .map_err(|e| map_persistence_error(e, CommandStage::ExecutionRead))?
                            .project_id(),
                    )
                    .map_err(mapped)?;
                let attempt_id = input.envelope().attempt_id;
                host.arena.preview = Some((preview.clone(), input));
                Ok(Prepared {
                    preview: preview.try_into().map_err(mapped)?,
                    attempt_id,
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn start_arena_translation(
    state: State<'_, AppState>,
    request: StartRequest,
) -> Result<ExecutionId, CommandError> {
    state
        .sessions
        .run(
            "start_arena_translation",
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
                    return Err(mapped(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "arena-consent",
                    )));
                }
                match store.execution_input(request.attempt_id) {
                    Ok(input) => {
                        if settings(&input).map_err(mapped)?.preview_digest == request.digest {
                            return Ok(request.attempt_id);
                        }
                        return Err(mapped(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "arena-preview",
                        )));
                    }
                    Err(e)
                        if e.code == ErrorCode::InvalidInput && e.stage == "execution-storage" => {}
                    Err(e) => return Err(mapped(e)),
                }
                let (preview, input) = host
                    .arena
                    .preview
                    .as_ref()
                    .filter(|(p, i)| {
                        p.digest == request.digest && i.envelope().attempt_id == request.attempt_id
                    })
                    .cloned()
                    .ok_or_else(|| {
                        mapped(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "arena-preview",
                        ))
                    })?;
                let units = preview
                    .items
                    .iter()
                    .filter(|p| p.slot == 0)
                    .map(|p| p.item.unit_id)
                    .collect::<Vec<_>>();
                let current = store
                    .preview_arena(
                        preview.config.clone(),
                        &preview.items[0].item.target_locale,
                        &units,
                    )
                    .map_err(mapped)?;
                if current.digest != preview.digest {
                    return Err(mapped(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "arena-preview",
                    )));
                }
                host.runtime.submit(store, &input).map_err(mapped)?;
                Ok(request.attempt_id)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_arena_translation(
    state: State<'_, AppState>,
    request: ReadRequest,
) -> Result<View, CommandError> {
    state
        .sessions
        .run(
            "read_arena_translation",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                let input = store.execution_input(request.attempt_id).map_err(mapped)?;
                let s = settings(&input).map_err(mapped)?;
                let detail = attempt_detail(host, store, request.attempt_id, 0, 100)?;
                let revealed = !s.config.blind
                    || store
                        .arena_revealed(request.project_id, request.attempt_id)
                        .map_err(mapped)?;
                let mut rows = Vec::new();
                for row in &detail.items {
                    let p = item_payload(&input, row.status.item_id).map_err(mapped)?;
                    let output = if let Some(id) = row.result_id {
                        let result = store
                            .execution_result(request.attempt_id, id)
                            .map_err(mapped)?;
                        if result.envelope().outcome == ExecutionState::Succeeded {
                            Some(validate_output(&input, &result).map_err(mapped)?)
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    rows.push(Row {
                        item: p.item.into(),
                        item_id: row.status.item_id,
                        source_order: index(p.source_order).map_err(mapped)?,
                        label: index(
                            s.display_order
                                .iter()
                                .position(|slot| *slot == p.slot)
                                .ok_or_else(|| {
                                    mapped(ExecutionError::new(
                                        ErrorCode::CorruptLedger,
                                        "arena-order",
                                    ))
                                })?,
                        )
                        .map_err(mapped)?,
                        result_id: row.result_id,
                        output: output.map(Into::into),
                    });
                }
                rows.sort_by_key(|r| (r.source_order, r.label));
                let first = &s.config.variants[0];
                let different_inputs = s.config.variants.iter().any(|c| {
                    c.share_context != first.share_context
                        || c.share_terms != first.share_terms
                        || c.max_output_tokens != first.max_output_tokens
                        || c.token_field != first.token_field
                        || c.max_retries != first.max_retries
                        || c.timeout_seconds != first.timeout_seconds
                });
                let repeated_sampling = s
                    .config
                    .variants
                    .iter()
                    .enumerate()
                    .any(|(i, c)| s.config.variants[..i].iter().any(|p| p == c));
                let variants = if revealed {
                    Some(
                        s.display_order
                            .iter()
                            .map(|slot| s.config.variants[*slot].clone())
                            .collect(),
                    )
                } else {
                    None
                };
                Ok(View {
                    budget: store.provider_budget(input.envelope().task_id).map_err(map_read)?,
                    detail,
                    rows,
                    variants,
                    blind: s.config.blind,
                    revealed,
                    different_inputs,
                    repeated_sampling,
                    parent_attempt_id: s.config.parent_attempt_id,
                })
            },
        )
        .await
}
#[tauri::command]
pub async fn create_arena_comparison(
    state: State<'_, AppState>,
    request: ComparisonCommand,
) -> Result<ComparisonView, CommandError> {
    state
        .sessions
        .run(
            "create_arena_comparison",
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
                    .create_comparison(&ComparisonRequest {
                        project_id: request.project_id,
                        action_id: request.action_id,
                        unit_id: request.unit_id,
                        locale: request.locale,
                        revision_ids: request.revision_ids,
                        blind: request.blind,
                    })
                    .map_err(mapped)
            },
        )
        .await
}
#[tauri::command]
pub async fn read_arena_comparison(
    state: State<'_, AppState>,
    request: ComparisonRead,
) -> Result<ComparisonView, CommandError> {
    state
        .sessions
        .run(
            "read_arena_comparison",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .read_comparison(request.project_id, request.comparison_id)
                .map_err(mapped)
            },
        )
        .await
}
#[tauri::command]
pub async fn list_arena_comparisons(
    state: State<'_, AppState>,
    request: SessionRequest,
) -> Result<Vec<ComparisonSummary>, CommandError> {
    state
        .sessions
        .run(
            "list_arena_comparisons",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .list_comparisons(request.project_id)
                .map_err(mapped)
            },
        )
        .await
}
#[tauri::command]
pub async fn reveal_arena_identity(
    state: State<'_, AppState>,
    request: RevealRequest,
) -> Result<(), CommandError> {
    state
        .sessions
        .run(
            "reveal_arena_identity",
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
                    .reveal_arena(request.project_id, request.comparison_id, request.action_id)
                    .map_err(mapped)
            },
        )
        .await
}
#[tauri::command]
pub async fn save_arena_merge(
    state: State<'_, AppState>,
    request: MergeRequest,
) -> Result<TranslationSelection, CommandError> {
    state
        .sessions
        .run(
            "save_arena_merge",
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
                    .save_merged_translation(
                        &SaveTranslationRevision {
                            project_id: request.project_id,
                            action_id: request.action_id,
                            unit_id: request.unit_id,
                            locale: request.locale,
                            source_revision_id: request.source_revision_id,
                            expected_selection_id: request.expected_selection_id,
                            text: request.text,
                        },
                        &request.merge,
                    )
                    .map_err(mapped)
            },
        )
        .await
}
