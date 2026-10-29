//! Original Source facts only. This reader never initializes the execution Host.
use super::*;
use crate::commands::drafts::{SourceDraftKey, SourceDraftObservation as Observation,
    SourceDraftPending as Pending, SourceDraftResolveTarget as Target, SourceDraftPreparationRef as Preparation};

pub(in crate::commands) fn observe(active: &ActiveSession, key: &SourceDraftKey, target: &Target) -> Result<Observation, ExecutionError> {
    let observed = observe_persistent(&active.store, key, target)?;
    if !matches!(observed, Observation::Pending) { return Ok(observed); }
    let Target::Primary { pending } = target else { return Ok(observed); };
    match pending {
        Pending::Capture { request, .. } => preparation(active, key, &Preparation::Capture { request: request.clone() }),
        Pending::PrepareCheck { request, .. } => preparation(active, key, &Preparation::PrepareCheck { request: request.clone() }),
        _ => Ok(observed),
    }
}

pub(in crate::commands) fn preparation(active: &ActiveSession, key: &SourceDraftKey, reference: &Preparation) -> Result<Observation, ExecutionError> {
    let host = active.execution.as_ref();
    match reference {
        Preparation::Capture { request } => {
            if request.project_id != key.project_id { return Err(ExecutionError::new(ErrorCode::Unauthorized, "source-drafts-project")); }
            if let Some(review) = host.and_then(|host| host.source.plugin.review.as_ref()) {
                let original = &review.request;
                if original.project_id == request.project_id && original.selection_id == request.selection_id
                    && original.source_language == request.source_language && original.attempt_id == request.attempt_id {
                    return Ok(Observation::Capture { view: review.view.clone() });
                }
            }
            Ok(if host.is_some_and(|host| host.source.is_active()) { Observation::Pending } else { Observation::PreparationExpired })
        }
        Preparation::PrepareCheck { request } => {
            if request.project_id != key.project_id { return Err(ExecutionError::new(ErrorCode::Unauthorized, "source-drafts-project")); }
            if let Some(review) = host.and_then(|host| host.source.plugin.check.as_ref()) {
                let original = &review.request;
                if original.project_id == request.project_id && original.source_attempt_id == request.source_attempt_id
                    && original.source_result_id == request.source_result_id && original.attempt_id == request.attempt_id && original.source == request.source {
                    return Ok(Observation::CheckPrepared { view: review.view.clone() });
                }
            }
            Ok(if host.is_some_and(|host| host.source.is_active()) { Observation::Pending } else { Observation::PreparationExpired })
        }
    }
}

/// The inbox uses this inside the existing Core read snapshot. An absent Host
/// cache never proves a persistent start or adoption did not happen.
pub(in crate::commands) fn observe_persistent(store: &ProjectStore, key: &SourceDraftKey, target: &Target) -> Result<Observation, ExecutionError> {
    let pending = match target {
        Target::Primary { pending } => {
            if pending.project_id() != key.project_id { return Err(ExecutionError::new(ErrorCode::Unauthorized, "source-drafts-project")); }
            pending
        }
        Target::HookStop { pending } => {
            let request = &pending.request;
            if request.project_id != key.project_id || request.stop.project_id != key.project_id {
                return Err(ExecutionError::new(ErrorCode::Unauthorized, "source-drafts-project"));
            }
            return store.source_hook_stop_request_observation(&request.stop).map(|proof| match proof {
                content::SourceHookStopObservation::Recorded { receipt } => Observation::HookStopped { receipt },
                content::SourceHookStopObservation::ConfirmedNotApplied { .. } => Observation::ConfirmedNotApplied,
                content::SourceHookStopObservation::Unknown => Observation::Pending,
            });
        }
    };
    match pending {
        Pending::Capture { .. } | Pending::PrepareCheck { .. } => Ok(Observation::Pending),
        Pending::CorrectLineage { request, .. } => {
            if request.correction.project_id != key.project_id { return Err(ExecutionError::new(ErrorCode::Unauthorized, "source-drafts-project")); }
            store.source_lineage_correction_request_observation(&request.correction).map(lineage_observation)
        }
        Pending::Start { request, .. } | Pending::StartCheck { request, .. } => {
            let operation = if matches!(pending, Pending::Start { .. }) { content::OPERATION } else { SOURCE_CHECK_OPERATION };
            store.source_plugin_start_request_observation(request.project_id, request.attempt_id, operation,
                &request.input_digest, request.grant_id, request.expires_at_ms.get(), request.unsandboxed_execution, &request.start_metadata)
                .map(start_observation)
        }
        Pending::FinishCheck { request, .. } => {
            if let Some(valid) = store.source_check_finish_request_observation(request.project_id, request.attempt_id, request.result_id)? {
                return Ok(Observation::CheckFinished { valid });
            }
            match store.capture_source_validation_publication(request.project_id, request.attempt_id, request.result_id) {
                Ok(_) => Ok(Observation::Pending),
                Err(error) if error.code == ErrorCode::Unauthorized && error.stage == "source-publication-revoked"
                    || error.code == ErrorCode::Cancelled && error.stage == "source-publication-cancelled" => Ok(Observation::ConfirmedNotApplied),
                Err(error) => Err(error),
            }
        }
        Pending::Adopt { request, unit_id, .. } => {
            let found = store.source_adoption_request_settlement_observation(request.project_id, request.attempt_id,
                request.action_id, *unit_id, request.result_id, &request.confirmation);
            match found {
                Ok(Some(value)) if value.receipt.is_some() => Ok(Observation::Adopted { value }),
                Ok(Some(value)) => Ok(Observation::AdoptionPrepared { value }),
                Ok(None) => Ok(Observation::Pending),
                Err(error) if error.code == ErrorCode::DependencyConflict && error.stage == "stale-preview" => Ok(Observation::ConfirmedNotApplied),
                Err(error) => Err(error),
            }
        }
    }
}

pub(in crate::commands) fn lineage_observation(observed: content::SourceLineageCorrectionObservation) -> Observation {
    match observed {
        content::SourceLineageCorrectionObservation::Recorded { receipt } => Observation::LineageCorrected { receipt },
        content::SourceLineageCorrectionObservation::ReceiptAbsent => Observation::Pending,
        content::SourceLineageCorrectionObservation::ConfirmedNotApplied => Observation::ConfirmedNotApplied,
    }
}

pub(in crate::commands) fn start_observation(proof: content::SourcePluginStartObservation) -> Observation {
    match proof {
        content::SourcePluginStartObservation::Started { proof } => Observation::Started { view: proof },
        content::SourcePluginStartObservation::ConfirmedNotApplied => Observation::ConfirmedNotApplied,
        content::SourcePluginStartObservation::Unknown => Observation::Pending,
    }
}
