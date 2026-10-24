//! Model review uses the original task/runtime and explicit adoption boundary.
//! Its advisory evidence never becomes a mechanical QA or approval receipt.
use super::super::*;
use crate::commands::connections;
use tsumugi_core::ai::{
    AiConfig,
    semantic_review::{
        self as core_review, AiSemanticReviewRule, AiSemanticReviewRuleResult, AiSemanticReviewRun,
        AiSemanticReviewTarget, PreparedAiSemanticReview,
    },
};

#[derive(Default)]
pub(in crate::commands::execution) struct AiSemanticReviewSession {
    prepared: Option<PreparedAiSemanticReview>,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AiSemanticReviewPrepareRequest {
        config: AiConfig,
        targets: Vec<AiSemanticReviewTarget>,
        rules: Vec<AiSemanticReviewRule>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AiSemanticReviewStartRequest {
        attempt_id: ExecutionId,
        digest: String,
        confirmed: bool
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    AiSemanticReviewReadRequest {
        attempt_id: ExecutionId
    }
);

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewItemView {
    pub source: ai_wire::AiItemView,
    pub selection_id: ExecutionId,
    pub translation_revision_id: ExecutionId,
    pub translation_text: String,
    pub review_basis: tsumugi_core::ReviewBasis,
    pub basis: String,
}
impl From<core_review::AiSemanticReviewItem> for AiSemanticReviewItemView {
    fn from(value: core_review::AiSemanticReviewItem) -> Self {
        Self {
            source: value.source.into(),
            selection_id: value.selection_id,
            translation_revision_id: value.translation_revision_id,
            translation_text: value.translation_text,
            review_basis: value.review_basis,
            basis: value.basis,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewPreviewView {
    pub config: AiConfig,
    pub recipe: String,
    pub rules: Vec<AiSemanticReviewRule>,
    pub items: Vec<AiSemanticReviewItemView>,
    pub digest: String,
}
impl From<core_review::AiSemanticReviewPreview> for AiSemanticReviewPreviewView {
    fn from(value: core_review::AiSemanticReviewPreview) -> Self {
        Self {
            config: value.config,
            recipe: value.recipe,
            rules: value.rules,
            items: value.items.into_iter().map(Into::into).collect(),
            digest: value.digest,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewOutputView {
    pub unit_id: ExecutionId,
    pub target_locale: String,
    pub rules: Vec<AiSemanticReviewRuleResult>,
    pub usage: Option<ai_wire::AiUsageView>,
    pub requests: u32,
    pub usage_incomplete: bool,
}
impl From<core_review::AiSemanticReviewOutput> for AiSemanticReviewOutputView {
    fn from(value: core_review::AiSemanticReviewOutput) -> Self {
        Self {
            unit_id: value.unit_id,
            target_locale: value.target_locale,
            rules: value.rules,
            usage: value.usage.map(Into::into),
            requests: value.requests,
            usage_incomplete: value.usage_incomplete,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewRow {
    pub item_id: ExecutionId,
    pub item: AiSemanticReviewItemView,
    pub output: Option<AiSemanticReviewOutputView>,
    pub run: Option<AiSemanticReviewRun>,
    pub current: bool,
}
impl From<core_review::AiSemanticReviewItemView> for AiSemanticReviewRow {
    fn from(value: core_review::AiSemanticReviewItemView) -> Self {
        Self {
            item_id: value.item_id,
            item: value.item.into(),
            output: value.output.map(Into::into),
            run: value.run,
            current: value.current,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewPrepared {
    pub preview: AiSemanticReviewPreviewView,
    pub attempt_id: ExecutionId,
}
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewView {
    pub preview: AiSemanticReviewPreviewView,
    pub detail: AttemptDetail,
    pub rows: Vec<AiSemanticReviewRow>,
}
/// An original enqueue receipt; progress and adopted findings are separate reads.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewStartRead {
    pub project_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub task_id: ExecutionId,
    pub input_digest: String,
    pub preview: AiSemanticReviewPreviewView,
}

/// An absent task is an explicit successful ledger observation. Storage errors
/// are still errors, so a lost start response cannot silently clear its intent.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiSemanticReviewLookup {
    pub attempt_id: ExecutionId,
    pub view: Option<AiSemanticReviewView>,
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    #[test]
    fn semantic_review_wire_fixture_preserves_original_scope_provenance_and_decimal_counters() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/aiSemanticReviewCommands.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($group:literal, $name:literal, $kind:ty) => {
                let value: $kind = serde_json::from_value(fixture[$group][$name].clone()).unwrap();
                assert_eq!(
                    serde_json::to_value(value).unwrap(),
                    fixture[$group][$name],
                    $name
                );
            };
        }
        round_trip!("requests", "prepare", AiSemanticReviewPrepareRequest);
        round_trip!("requests", "start", AiSemanticReviewStartRequest);
        round_trip!("requests", "startAction", AiSemanticReviewStartRequest);
        round_trip!("responses", "startAction", Option<AiSemanticReviewStartRead>);
        round_trip!("requests", "read", AiSemanticReviewReadRequest);
        round_trip!("responses", "prepared", AiSemanticReviewPrepared);
        round_trip!("responses", "started", ExecutionId);
        round_trip!("responses", "absent", AiSemanticReviewLookup);
        round_trip!("responses", "view", AiSemanticReviewLookup);
        round_trip!("responses", "recorded", AiSemanticReviewLookup);
        let mut number = fixture["responses"]["view"].clone();
        number["view"]["rows"][0]["output"]["usage"]["promptTokens"] = serde_json::json!(1);
        assert!(serde_json::from_value::<AiSemanticReviewLookup>(number).is_err());
        let mut permission = fixture["responses"]["recorded"].clone();
        permission["view"]["rows"][0]["run"]["evidence"]["approved"] = serde_json::json!(true);
        assert!(serde_json::from_value::<AiSemanticReviewLookup>(permission).is_err());
    }
}

#[tauri::command]
pub async fn prepare_ai_semantic_review(
    state: State<'_, AppState>,
    request: AiSemanticReviewPrepareRequest,
) -> Result<AiSemanticReviewPrepared, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "prepare_ai_semantic_review",
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
                connections::verify_configs(
                    connections.as_ref(),
                    std::slice::from_ref(&request.config),
                )?;
                let prepared = store
                    .prepare_ai_semantic_review(request.config, &request.targets, &request.rules)
                    .map_err(map_read)?;
                let response = AiSemanticReviewPrepared {
                    preview: prepared.preview().clone().into(),
                    attempt_id: prepared.input().envelope().attempt_id,
                };
                host.semantic_review.prepared = Some(prepared);
                Ok(response)
            },
        )
        .await
}

#[tauri::command]
pub async fn start_ai_semantic_review(
    state: State<'_, AppState>,
    request: AiSemanticReviewStartRequest,
) -> Result<ExecutionId, CommandError> {
    let connections = connections::captured_store(&state);
    state
        .sessions
        .run(
            "start_ai_semantic_review",
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
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "ai-review-consent",
                    )));
                }
                if let Some(input) = store
                    .execution_input_if_present(request.attempt_id)
                    .map_err(map_read)?
                {
                    let preview = core_review::preview_from_input(&input).map_err(map_read)?;
                    if preview.digest != request.digest {
                        return Err(map_read(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "ai-review-preview",
                        )));
                    }
                    return Ok(request.attempt_id);
                }
                let prepared = host
                    .semantic_review
                    .prepared
                    .as_ref()
                    .filter(|prepared| {
                        prepared.input().envelope().attempt_id == request.attempt_id
                            && prepared.preview().digest == request.digest
                    })
                    .cloned()
                    .ok_or_else(|| {
                        map_read(ExecutionError::new(
                            ErrorCode::DependencyConflict,
                            "ai-review-preview",
                        ))
                    })?;
                store
                    .verify_ai_semantic_review(&prepared)
                    .map_err(map_read)?;
                connections::verify_configs(
                    connections.as_ref(),
                    std::slice::from_ref(&prepared.preview().config),
                )?;
                host.runtime
                    .submit(store, prepared.input())
                    .map_err(map_read)?;
                Ok(request.attempt_id)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_ai_semantic_review_start_action(
    state: State<'_, AppState>, request: AiSemanticReviewStartRequest,
) -> Result<Option<AiSemanticReviewStartRead>, CommandError> {
    state.sessions.run("read_ai_semantic_review_start_action",CommandStage::ExecutionRead,move |sessions| {
        let active=authorized(sessions,&request.session_token,request.project_id,CommandStage::ExecutionRead)?;
        // `confirmed` is temporary consent for the mutation. Reading cannot
        // attest to it, restore it or use it to submit work.
        active.store.ai_semantic_review_start_action_read(request.project_id,request.attempt_id,&request.digest)
            .map(|found|found.map(|saved|AiSemanticReviewStartRead {project_id:saved.project_id,
                attempt_id:saved.attempt_id,task_id:saved.task_id,input_digest:saved.input_digest,preview:saved.preview.into()}))
            .map_err(map_read)
    }).await
}

#[tauri::command]
pub async fn read_ai_semantic_review(
    state: State<'_, AppState>,
    request: AiSemanticReviewReadRequest,
) -> Result<AiSemanticReviewLookup, CommandError> {
    state
        .sessions
        .run(
            "read_ai_semantic_review",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                let Some(input) = store
                    .execution_input_if_present(request.attempt_id)
                    .map_err(map_read)?
                else {
                    return Ok(AiSemanticReviewLookup {
                        attempt_id: request.attempt_id,
                        view: None,
                    });
                };
                let preview = core_review::preview_from_input(&input).map_err(map_read)?;
                let detail = attempt_detail(host, store, request.attempt_id, 0, 100)?;
                if detail.items.len() != preview.items.len() {
                    return Err(map_read(ExecutionError::new(
                        ErrorCode::CorruptLedger,
                        "ai-review-coverage",
                    )));
                }
                let rows = detail
                    .items
                    .iter()
                    .map(|item| {
                        store
                            .read_ai_semantic_review_item(request.attempt_id, item.status.item_id)
                            .map(Into::into)
                            .map_err(map_read)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(AiSemanticReviewLookup {
                    attempt_id: request.attempt_id,
                    view: Some(AiSemanticReviewView {
                        preview: preview.into(),
                        detail,
                        rows,
                    }),
                })
            },
        )
        .await
}
