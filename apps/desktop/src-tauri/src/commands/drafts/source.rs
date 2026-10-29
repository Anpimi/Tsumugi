//! Local source input is recoverable; native selection and execution consent are not.
use super::*;
use tsumugi_core::execution::{AdoptionActionRead, PluginStartActionRead};
use super::super::execution::source::plugin::{PluginSourcePreflight, SourceCheckReview};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceDraftObservation {
    Pending,
    Capture { view: PluginSourcePreflight },
    PreparationExpired,
    Started { view: PluginStartActionRead },
    CheckPrepared { view: SourceCheckReview },
    CheckFinished { valid: bool },
    AdoptionPrepared { value: AdoptionActionRead },
    Adopted { value: AdoptionActionRead },
    HookStopped { receipt: tsumugi_core::content::SourceMaintenanceHookStopReceipt },
    ConfirmedNotApplied,
}
impl SourceDraftObservation {
    pub(in crate::commands) fn disposition(&self) -> Option<SourceDraftDisposition> {
        match self {
            Self::Pending | Self::AdoptionPrepared { .. } => None,
            Self::PreparationExpired => Some(SourceDraftDisposition::PreparationExpired),
            Self::ConfirmedNotApplied => Some(SourceDraftDisposition::ConfirmedNotApplied),
            _ => Some(SourceDraftDisposition::Recorded),
        }
    }
}
macro_rules! request {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
        pub struct $name { pub session_token: String, $(pub $field: $ty,)* }
    };
}
request!(SourceDraftReadRequest { key: SourceDraftKey });
request!(SourceDraftWriteRequest { write: SourceDraftWrite });
request!(SourceDraftClearRequest { clear: SourceDraftClear });
request!(SourceDraftResolveRequest { resolve: SourceDraftResolve });
request!(SourceDraftObserveRequest { key: SourceDraftKey, target: SourceDraftResolveTarget });
request!(SourceDraftPreparationRequest { key: SourceDraftKey, reference: SourceDraftPreparationRef });
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceDraftObserved { pub target: SourceDraftResolveTarget, pub observation: SourceDraftObservation }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceDraftPrepared { pub reference: SourceDraftPreparationRef, pub observation: SourceDraftObservation }

async fn journal<T: Send + 'static>(state: &AppState, token: String, project: ExecutionId,
    operation: impl FnOnce(DraftStore) -> Result<T, ExecutionError> + Send + 'static) -> Result<T, CommandError> {
    authorize(state, token.clone(), project, None).await?;
    let drafts = store(state)?;
    let result = state.io.run(CommandStage::DraftStorage, move || operation(drafts).map_err(map_error)).await?;
    authorize(state, token, project, None).await?;
    Ok(result)
}
#[tauri::command]
pub async fn read_local_source_draft(state: State<'_, AppState>, request: SourceDraftReadRequest) -> Result<SourceDraftHead, CommandError> {
    journal(&state, request.session_token, request.key.project_id, move |drafts| drafts.read_source(&request.key)).await
}
#[tauri::command]
pub async fn write_local_source_draft(state: State<'_, AppState>, request: SourceDraftWriteRequest) -> Result<SourceDraftHead, CommandError> {
    journal(&state, request.session_token, request.write.key.project_id, move |drafts| drafts.write_source(&request.write)).await
}
#[tauri::command]
pub async fn clear_local_source_draft(state: State<'_, AppState>, request: SourceDraftClearRequest) -> Result<SourceDraftHead, CommandError> {
    journal(&state, request.session_token, request.clear.key.project_id, move |drafts| drafts.clear_source(&request.clear)).await
}
#[tauri::command]
pub async fn observe_local_source_action(state: State<'_, AppState>, request: SourceDraftObserveRequest) -> Result<SourceDraftObserved, CommandError> {
    state.sessions.run("observe_local_source_action", CommandStage::DraftStorage, move |sessions| {
        let active = super::super::execution::authorized(sessions, &request.session_token, request.key.project_id, CommandStage::DraftStorage)?;
        let observation = super::super::execution::source::plugin::observations::observe(active, &request.key, &request.target).map_err(map_error)?;
        Ok(SourceDraftObserved { target: request.target, observation })
    }).await
}
#[tauri::command]
pub async fn read_local_source_preparation(state: State<'_, AppState>, request: SourceDraftPreparationRequest) -> Result<SourceDraftPrepared, CommandError> {
    state.sessions.run("read_local_source_preparation", CommandStage::DraftStorage, move |sessions| {
        let active = super::super::execution::authorized(sessions, &request.session_token, request.key.project_id, CommandStage::DraftStorage)?;
        let observation = super::super::execution::source::plugin::observations::preparation(active, &request.key, &request.reference).map_err(map_error)?;
        Ok(SourceDraftPrepared { reference: request.reference, observation })
    }).await
}
#[tauri::command]
pub async fn resolve_local_source_draft(state: State<'_, AppState>, request: SourceDraftResolveRequest) -> Result<SourceDraftHead, CommandError> {
    let preview = request.resolve.clone();
    journal(&state, request.session_token.clone(), preview.write.key.project_id,
        move |drafts| drafts.check_source_resolution(&preview)).await?;
    let original = request.clone();
    state.sessions.run("resolve_local_source_draft", CommandStage::DraftStorage, move |sessions| {
        let key = &original.resolve.write.key;
        let hook_drained = match &original.resolve.target {
            SourceDraftResolveTarget::HookStop { pending } => sessions.source_hooks.drained(pending.request.stop.source_action_id),
            _ => true,
        };
        let active = super::super::execution::authorized(sessions, &original.session_token, key.project_id, CommandStage::DraftStorage)?;
        let observe = |active: &super::super::ActiveSession| super::super::execution::source::plugin::observations::observe(active, key, &original.resolve.target).map_err(map_error);
        let mut observed = observe(active)?;
        if matches!(observed, SourceDraftObservation::Pending) && original.resolve.disposition == SourceDraftDisposition::ConfirmedNotApplied {
            if let SourceDraftResolveTarget::Primary { pending } = &original.resolve.target {
                if let SourceDraftPending::Start { request, .. } | SourceDraftPending::StartCheck { request, .. } = pending {
                    let operation = if matches!(pending, SourceDraftPending::Start { .. }) { tsumugi_core::content::OPERATION } else { tsumugi_core::execution::SOURCE_CHECK_OPERATION };
                    let proof = active.store.cancel_source_start_request(request.project_id, request.attempt_id, operation,
                        &request.input_digest, request.grant_id, request.expires_at_ms.get(), request.unsandboxed_execution, &request.start_metadata).map_err(map_error)?;
                    observed = super::super::execution::source::plugin::observations::start_observation(proof);
                }
            }
        }
        let disposition = observed.disposition().ok_or_else(|| map_error(ExecutionError::new(ErrorCode::OutcomeUnknown, "source-drafts-pending")))?;
        if disposition != original.resolve.disposition {
            return Err(map_error(ExecutionError::new(ErrorCode::ResultMismatch, "source-drafts-disposition")));
        }
        if disposition == SourceDraftDisposition::ConfirmedNotApplied && !hook_drained {
            return Err(map_error(ExecutionError::new(ErrorCode::OutcomeUnknown, "source-drafts-hook-draining")));
        }
        // This is an explicit settlement of an already proven durable action.
        // Pure discovery and expired preparation never reconcile the project.
        if matches!(observed, SourceDraftObservation::Started { .. } | SourceDraftObservation::CheckFinished { .. }
            | SourceDraftObservation::Adopted { .. } | SourceDraftObservation::HookStopped { .. }) && active.store.is_reconciling() {
            active.store.reconcile_execution().map_err(map_error)?;
            if observe(active)?.disposition() != Some(disposition) {
                return Err(map_error(ExecutionError::new(ErrorCode::OutcomeUnknown, "source-drafts-pending")));
            }
        }
        Ok(())
    }).await?;
    journal(&state, request.session_token, request.resolve.write.key.project_id, move |drafts| drafts.resolve_source(&request.resolve)).await
}

#[cfg(test)]
mod tests;
