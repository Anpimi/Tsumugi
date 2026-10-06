use super::*;
use tsumugi_core::{
    SaveTranslationRevision, SelectTranslationRevision, TranslationAdoptionConfirmation,
    TranslationHistory, TranslationPreview, TranslationSaveReceipt, TranslationSelection,
};

// Retain the built-in importer only as an explicit test baseline.
#[cfg(any(test, feature = "execution-test-host"))]
mod legacy;
#[cfg(any(test, feature = "execution-test-host"))]
pub use legacy::*;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationFilesRequest {
        selection_id: ExecutionId
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] TranslationPreviewRequest {
    attempt_id: ExecutionId,
    after: u32,
    limit: u32,
    basis: Option<String>,
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationAdoptRequest {
        attempt_id: ExecutionId,
        item_id: ExecutionId,
        result_id: ExecutionId,
        action_id: ExecutionId,
        confirmation: TranslationAdoptionConfirmation,
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationHistoryRequest {
        unit_id: ExecutionId,
        locale: String,
        after_ordinal: Revision,
        limit: u32,
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] TranslationSaveRequest {
    action_id: ExecutionId,
    unit_id: ExecutionId,
    locale: String,
    source_revision_id: ExecutionId,
    expected_selection_id: Option<ExecutionId>,
    text: String,
});
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationActionRequest {
        action_id: ExecutionId,
        unit_id: ExecutionId,
        locale: String,
    }
);
request!(#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))] TranslationSelectRequest {
    action_id: ExecutionId,
    unit_id: ExecutionId,
    locale: String,
    source_revision_id: ExecutionId,
    expected_selection_id: Option<ExecutionId>,
    revision_id: ExecutionId,
});

#[tauri::command]
pub async fn read_translation_preview(
    state: State<'_, AppState>,
    request: TranslationPreviewRequest,
) -> Result<TranslationPreview, CommandError> {
    state
        .sessions
        .run(
            "read_translation_preview",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .translation_preview(
                    request.attempt_id,
                    request.after,
                    request.limit,
                    request.basis.as_deref(),
                )
                .map_err(map_source)
            },
        )
        .await
}

#[tauri::command]
pub async fn prepare_translation_adoption(
    state: State<'_, AppState>,
    request: TranslationAdoptRequest,
) -> Result<AdoptionAction, CommandError> {
    state
        .sessions
        .run(
            "prepare_translation_adoption",
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
                let input = store
                    .execution_input(request.attempt_id)
                    .map_err(map_source)?;
                if input.envelope().operation != content::TRANSLATION_OPERATION {
                    return Err(stale());
                }
                let unit = input
                    .envelope()
                    .units
                    .iter()
                    .find(|unit| unit.item_ids == vec![request.item_id])
                    .ok_or_else(stale)?;
                store
                    .prepare_adoption_with_id(
                        request.action_id,
                        request.attempt_id,
                        unit.unit_id,
                        vec![request.result_id],
                        serde_json::to_value(request.confirmation).map_err(|_| stale())?,
                    )
                    .map_err(map_source)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_translation_history(
    state: State<'_, AppState>,
    request: TranslationHistoryRequest,
) -> Result<TranslationHistory, CommandError> {
    state
        .sessions
        .run(
            "read_translation_history",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .translation_history(
                    request.project_id,
                    request.unit_id,
                    &request.locale,
                    request.after_ordinal.get(),
                    request.limit,
                )
                .map_err(map_source)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_translation_action(
    state: State<'_, AppState>,
    request: TranslationActionRequest,
) -> Result<Option<TranslationSelection>, CommandError> {
    state
        .sessions
        .run(
            "read_translation_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?
                .store
                .translation_selection_by_action(
                    request.project_id,
                    request.unit_id,
                    &request.locale,
                    request.action_id,
                )
                .map_err(map_source)
            },
        )
        .await
}

#[tauri::command]
pub async fn save_translation_revision(
    state: State<'_, AppState>,
    request: TranslationSaveRequest,
) -> Result<TranslationSaveReceipt, CommandError> {
    state
        .sessions
        .run(
            "save_translation_revision",
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
                    .save_translation_edit(&SaveTranslationRevision {
                        project_id: request.project_id,
                        action_id: request.action_id,
                        unit_id: request.unit_id,
                        locale: request.locale,
                        source_revision_id: request.source_revision_id,
                        expected_selection_id: request.expected_selection_id,
                        text: request.text,
                    })
                    .map_err(map_adopt)
            },
        )
        .await
}

#[tauri::command]
pub async fn select_translation_revision(
    state: State<'_, AppState>,
    request: TranslationSelectRequest,
) -> Result<TranslationSelection, CommandError> {
    state
        .sessions
        .run(
            "select_translation_revision",
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
                    .select_translation_revision(&SelectTranslationRevision {
                        project_id: request.project_id,
                        action_id: request.action_id,
                        unit_id: request.unit_id,
                        locale: request.locale,
                        source_revision_id: request.source_revision_id,
                        expected_selection_id: request.expected_selection_id,
                        revision_id: request.revision_id,
                    })
                    .map_err(map_source)
            },
        )
        .await
}

#[cfg(test)]
mod contracts {
    use super::*;

    #[test]
    fn translation_command_fixture_round_trips_camel_case_requests() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/translation-commands.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($key:literal, $kind:ty) => {
                let decoded: $kind = serde_json::from_value(fixture[$key].clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), fixture[$key], $key);
            };
        }
        round_trip!("filesRequest", TranslationFilesRequest);
        round_trip!("capture", TranslationCaptureRequest);
        round_trip!("start", TranslationStartRequest);
        round_trip!("previewRequest", TranslationPreviewRequest);
        round_trip!("adopt", TranslationAdoptRequest);
        round_trip!("history", TranslationHistoryRequest);
        round_trip!("save", TranslationSaveRequest);
        round_trip!("actionRequest", TranslationActionRequest);
        round_trip!("select", TranslationSelectRequest);
        round_trip!("files", Vec<String>);
        round_trip!("preflight", TranslationPreflight);
        round_trip!("preview", TranslationPreview);
        round_trip!("prepared", AdoptionAction);
        round_trip!("historyResponse", TranslationHistory);
        round_trip!("receipt", TranslationSaveReceipt);
        round_trip!("selected", TranslationSelection);
        assert!(
            serde_json::from_value::<Option<TranslationSelection>>(serde_json::Value::Null)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            serde_json::to_value(
                ExecutionId::parse(fixture["start"]["attemptId"].as_str().unwrap()).unwrap()
            )
            .unwrap(),
            fixture["start"]["attemptId"]
        );
        for value in [
            serde_json::json!(9007199254740992u64),
            serde_json::json!("01"),
            serde_json::json!("9223372036854775808"),
            serde_json::json!("-1"),
        ] {
            let mut history = fixture["historyResponse"].clone();
            history["nextOrdinal"] = value;
            assert!(serde_json::from_value::<TranslationHistory>(history).is_err());
        }
        let mut omitted = fixture["save"].clone();
        omitted
            .as_object_mut()
            .unwrap()
            .remove("expectedSelectionId");
        let decoded: TranslationSaveRequest = serde_json::from_value(omitted).unwrap();
        assert_eq!(decoded.expected_selection_id, None);
        for origin in ["import", "manual", "ai"] {
            let decoded: tsumugi_core::TranslationOrigin =
                serde_json::from_value(serde_json::json!(origin)).unwrap();
            assert_eq!(
                serde_json::to_value(decoded).unwrap(),
                serde_json::json!(origin)
            );
        }
        let mut preview = fixture["preview"].clone();
        preview["rows"][0]["entry"]["valueByteRange"][1] = serde_json::json!(4294967296u64);
        assert!(serde_json::from_value::<TranslationPreview>(preview).is_err());
        let mut unknown = fixture["receipt"].clone();
        unknown["revision"]["originKind"] = serde_json::json!("plugin");
        assert!(serde_json::from_value::<TranslationSaveReceipt>(unknown).is_err());
        let mut unknown = fixture["adopt"].clone();
        unknown["confirmation"]["decision"] = serde_json::json!("overwrite");
        assert!(serde_json::from_value::<TranslationAdoptRequest>(unknown).is_err());
        let mut unknown = fixture["preview"].clone();
        unknown["rows"][0]["status"] = serde_json::json!("ready");
        assert!(serde_json::from_value::<TranslationPreview>(unknown).is_err());
        let mut unknown = fixture["save"].clone();
        unknown["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<TranslationSaveRequest>(unknown).is_err());
    }
}
