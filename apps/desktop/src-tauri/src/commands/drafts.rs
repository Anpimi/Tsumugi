//! Application-local input recovery, separate from project business mutations.
mod store;
mod types;
mod conversation;
mod settlement;
pub(super) use settlement::observe_conversation_target;

pub(super) use store::{DraftStore, PendingActionRef, PendingJournalKey, PendingJournalSlot, PendingSnapshot};
pub use types::*;
pub use conversation::*;

use super::{AppState, CommandError, CommandErrorCode, CommandStage, ProjectStore};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;
use tsumugi_core::execution::{ErrorCode, ExecutionError, ExecutionId};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftReadRequest {
    pub session_token: String,
    pub key: DraftKey,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftReadManyRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub locale: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 50)))]
    pub unit_ids: Vec<ExecutionId>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftWriteRequest {
    pub session_token: String,
    pub write: DraftWrite,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftClearRequest {
    pub session_token: String,
    pub clear: DraftClear,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftListRequest {
    pub session_token: String,
    pub project_id: ExecutionId,
    pub after: Option<DraftKey>,
    pub limit: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DraftUnavailableReason {
    SourceMissing,
    LocaleRemoved,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum DraftCurrent {
    Current { basis: DraftBasis, native_key: String, source_text: String },
    Unavailable { reason: DraftUnavailableReason },
}

/// The journal and project have separate owners. Current basis is observed
/// after reading the journal; it is never an authority to skip Core admission.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftReadView {
    pub head: DraftHead,
    pub current: DraftCurrent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DraftReadMany {
    pub items: Vec<DraftReadView>,
    /// Consumed requested members; continue with the remaining identities.
    pub next_after: Option<u32>,
}

pub(super) fn configure(
    state: &AppState,
    application_directory: &Path,
) -> Result<(), CommandError> {
    state
        .local_drafts
        .set(DraftStore::at(application_directory.join("drafts")).map_err(map_error)?)
        .map_err(|_| {
            CommandError::simple(CommandErrorCode::StorageFailed, CommandStage::DraftStorage)
        })
}

fn store(state: &AppState) -> Result<DraftStore, CommandError> {
    state.local_drafts.get().cloned().ok_or_else(|| {
        CommandError::simple(CommandErrorCode::StorageFailed, CommandStage::DraftStorage)
    })
}

fn map_error(error: ExecutionError) -> CommandError {
    let corrupt = error.code == ErrorCode::CorruptLedger;
    let unsupported = error.stage == "drafts-schema-version";
    let mut mapped = super::execution::map_execution(error, CommandStage::DraftStorage);
    if corrupt {
        mapped.code = CommandErrorCode::StorageFailed;
    }
    if unsupported {
        mapped.code = CommandErrorCode::UnsupportedSchema;
    }
    mapped
}

fn validate_target(store: &ProjectStore, key: &DraftKey) -> Result<(), CommandError> {
    // This existing owner checks historical unit ownership and canonical locale,
    // including inputs retained after a source or target-language removal.
    store
        .translation_history(key.project_id, key.unit_id, &key.locale, 0, 1)
        .map(|_| ())
        .map_err(map_error)
}

fn current_basis(store: &ProjectStore, key: &DraftKey) -> Result<DraftCurrent, CommandError> {
    let metadata = store
        .metadata()
        .map_err(|failure| super::map_persistence_error(failure, CommandStage::DraftStorage))?;
    if !metadata
        .target_locales()
        .iter()
        .any(|locale| locale.as_str() == key.locale)
    {
        return Ok(DraftCurrent::Unavailable {
            reason: DraftUnavailableReason::LocaleRemoved,
        });
    }
    match store.review_target(key.project_id, key.unit_id, &key.locale) {
        Ok(target) => Ok(DraftCurrent::Current {
            native_key: target.native_key,
            source_text: target.source_text,
            basis: DraftBasis {
                source_revision_id: target.source_revision_id,
                selection_id: target.selection_id,
                revision_id: target.revision_id,
                text: target.translation_text,
            },
        }),
        Err(failure)
            if failure.code == ErrorCode::DependencyConflict && failure.stage == "review-unit" =>
        {
            Ok(DraftCurrent::Unavailable {
                reason: DraftUnavailableReason::SourceMissing,
            })
        }
        Err(failure) => Err(map_error(failure)),
    }
}

async fn authorize(
    state: &AppState,
    token: String,
    project: ExecutionId,
    key: Option<DraftKey>,
) -> Result<(), CommandError> {
    state
        .sessions
        .run(
            "local_drafts.authorize",
            CommandStage::DraftStorage,
            move |sessions| {
                let active = super::execution::authorized(
                    sessions,
                    &token,
                    project,
                    CommandStage::DraftStorage,
                )?;
                if let Some(key) = key {
                    validate_target(&active.store, &key)?;
                }
                Ok(())
            },
        )
        .await
}

#[tauri::command]
pub async fn read_local_drafts(
    state: State<'_, AppState>, request: DraftReadManyRequest,
) -> Result<DraftReadMany, CommandError> {
    if request.unit_ids.is_empty() || request.unit_ids.len() > 50
        || request.unit_ids.iter().collect::<std::collections::BTreeSet<_>>().len() != request.unit_ids.len() {
        return Err(map_error(ExecutionError::new(ErrorCode::InvalidInput,"drafts-read-many")));
    }
    authorize(&state,request.session_token.clone(),request.project_id,None).await?;
    let drafts = store(&state)?;
    let initial = request.clone();
    let heads = state.io.run(CommandStage::DraftStorage, move || drafts.read_many(initial.project_id,&initial.locale,&initial.unit_ids).map_err(map_error)).await?;
    state.sessions.run("read_local_drafts.finish",CommandStage::DraftStorage,move |sessions| {
        let active = super::execution::authorized(sessions,&request.session_token,request.project_id,CommandStage::DraftStorage)?;
        let targets = active.store.review_targets(request.project_id,&request.unit_ids,&request.locale).map_err(map_error)?;
        if heads.len() != targets.len() { return Err(map_error(ExecutionError::new(ErrorCode::CorruptLedger,"drafts-read-many"))); }
        let mut page = DraftReadMany { items: Vec::new(), next_after: None };
        let fits = |page: &DraftReadMany| -> Result<bool,CommandError> {
            serde_json::to_vec(page).map(|bytes| bytes.len() <= store::MAX_DRAFT_RECORD_BYTES)
                .map_err(|_| map_error(ExecutionError::new(ErrorCode::CorruptLedger,"drafts-read-many-encoding")))
        };
        for (index,(head,target)) in heads.into_iter().zip(targets).enumerate() {
            if head.key.project_id != request.project_id || head.key.locale != request.locale || head.key.unit_id != request.unit_ids[index] || target.unit_id != head.key.unit_id {
                return Err(map_error(ExecutionError::new(ErrorCode::CorruptLedger,"drafts-read-many")));
            }
            page.items.push(DraftReadView { head, current: DraftCurrent::Current { native_key: target.native_key, source_text: target.source_text,
                basis: DraftBasis { source_revision_id: target.source_revision_id, selection_id: target.selection_id, revision_id: target.revision_id, text: target.translation_text } } });
            page.next_after = (index + 1 < request.unit_ids.len()).then_some((index+1) as u32);
            if !fits(&page)? {
                page.items.pop();
                if page.items.is_empty() { return Err(map_error(ExecutionError::new(ErrorCode::LimitExceeded,"drafts-read-many-bytes"))); }
                page.next_after = Some(index as u32); break;
            }
        }
        if !fits(&page)? { return Err(map_error(ExecutionError::new(ErrorCode::LimitExceeded,"drafts-read-many-bytes"))); }
        Ok(page)
    }).await
}

#[tauri::command]
pub async fn read_local_draft(
    state: State<'_, AppState>,
    request: DraftReadRequest,
) -> Result<DraftReadView, CommandError> {
    authorize(
        &state,
        request.session_token.clone(),
        request.key.project_id,
        Some(request.key.clone()),
    )
    .await?;
    let drafts = store(&state)?;
    let key = request.key.clone();
    let head = state
        .io
        .run(CommandStage::DraftStorage, move || {
            drafts.read(&key).map_err(map_error)
        })
        .await?;
    state
        .sessions
        .run(
            "read_local_draft.finish",
            CommandStage::DraftStorage,
            move |sessions| {
                let active = super::execution::authorized(
                    sessions,
                    &request.session_token,
                    request.key.project_id,
                    CommandStage::DraftStorage,
                )?;
                Ok(DraftReadView {
                    head,
                    current: current_basis(&active.store, &request.key)?,
                })
            },
        )
        .await
}

#[tauri::command]
pub async fn write_local_draft(
    state: State<'_, AppState>,
    request: DraftWriteRequest,
) -> Result<DraftHead, CommandError> {
    let key = request.write.key.clone();
    authorize(
        &state,
        request.session_token.clone(),
        key.project_id,
        Some(key.clone()),
    )
    .await?;
    let drafts = store(&state)?;
    let head = state
        .io
        .run(CommandStage::DraftStorage, move || {
            drafts.write(&request.write).map_err(map_error)
        })
        .await?;
    authorize(&state, request.session_token, key.project_id, None).await?;
    Ok(head)
}

#[tauri::command]
pub async fn clear_local_draft(
    state: State<'_, AppState>,
    request: DraftClearRequest,
) -> Result<DraftHead, CommandError> {
    let key = request.clear.key.clone();
    authorize(
        &state,
        request.session_token.clone(),
        key.project_id,
        Some(key.clone()),
    )
    .await?;
    let drafts = store(&state)?;
    let head = state
        .io
        .run(CommandStage::DraftStorage, move || {
            drafts.clear(&request.clear).map_err(map_error)
        })
        .await?;
    authorize(&state, request.session_token, key.project_id, None).await?;
    Ok(head)
}

#[tauri::command]
pub async fn list_local_drafts(
    state: State<'_, AppState>,
    request: DraftListRequest,
) -> Result<DraftPage, CommandError> {
    authorize(
        &state,
        request.session_token.clone(),
        request.project_id,
        None,
    )
    .await?;
    let drafts = store(&state)?;
    let page = state
        .io
        .run(CommandStage::DraftStorage, move || {
            drafts
                .list(request.project_id, request.after.as_ref(), request.limit)
                .map_err(map_error)
        })
        .await?;
    authorize(&state, request.session_token, request.project_id, None).await?;
    Ok(page)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod read_many_tests;
