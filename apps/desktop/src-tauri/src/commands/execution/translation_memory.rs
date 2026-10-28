//! Translation memory reads the original project revisions and grants no writes.
use super::*;
use tsumugi_core::{PrepareTranslationMemoryReuse, TranslationMemoryEntry, TranslationMemoryFilter,
    TranslationMemoryPage, TranslationMemoryReusePreview};
#[cfg(all(test, target_os = "macos"))]
#[path = "translation_memory_tests.rs"]
mod tests;

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationMemoryPageRequest {
        filter: TranslationMemoryFilter,
        cursor: Option<String>,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 100)))]
        limit: u32
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationMemoryEntryRequest { unit_id: ExecutionId, locale: String, revision_id: ExecutionId }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationMemoryReuseRequest { reuse: PrepareTranslationMemoryReuse }
);

#[tauri::command]
pub async fn list_translation_memory(state: State<'_, AppState>, request: TranslationMemoryPageRequest) -> Result<TranslationMemoryPage, CommandError> {
    state.sessions.run("list_translation_memory", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        active.store.list_translation_memory(request.project_id, &request.filter, request.cursor.as_deref(), request.limit)
            .map_err(|error| map_execution(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn read_translation_memory_entry(state: State<'_, AppState>, request: TranslationMemoryEntryRequest) -> Result<TranslationMemoryEntry, CommandError> {
    state.sessions.run("read_translation_memory_entry", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        active.store.translation_memory_entry(request.project_id, request.unit_id, &request.locale, request.revision_id)
            .map_err(|error| map_execution(error, CommandStage::ExecutionRead))
    }).await
}

#[tauri::command]
pub async fn prepare_translation_memory_reuse(state: State<'_, AppState>, request: TranslationMemoryReuseRequest) -> Result<TranslationMemoryReusePreview, CommandError> {
    state.sessions.run("prepare_translation_memory_reuse", CommandStage::ExecutionRead, move |sessions| {
        let active = authorized(sessions, &request.session_token, request.project_id, CommandStage::ExecutionRead)?;
        if request.reuse.project_id != request.project_id {
            return Err(map_execution(ExecutionError::new(ErrorCode::Unauthorized, "translation-memory-project"), CommandStage::ExecutionRead));
        }
        active.store.prepare_translation_memory_reuse(&request.reuse)
            .map_err(|error| map_execution(error, CommandStage::ExecutionRead))
    }).await
}
