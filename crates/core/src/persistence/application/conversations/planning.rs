//! Consistent, bounded captures for future explicitly authorized planning.
use super::*;
use crate::{
    ai::{AiPreview, conversation_planning},
    application::WorkProtection,
};
use std::collections::BTreeSet;

fn preview_in(
    store: &ProjectStore,
    c: &Connection,
    request: &PrepareConversationPlanning,
) -> Result<(ConversationPlanningPreview, Option<AiPreview>), ExecutionError> {
    owned(c, request.project_id)?;
    conversation(c, request.project_id, request.conversation_id)?;
    request.config.validate()?;
    if request.config.max_requests != 1
        || request.config.max_retries != 0
        || request.config.concurrency != 1
    {
        return Err(fail(
            ErrorCode::LimitExceeded,
            "conversation-planning-limits",
        ));
    }
    if request.selected_message_ids.is_empty()
        || request.selected_message_ids.len() > MAX_CONVERSATION_PLANNING_MESSAGES
        || request
            .selected_message_ids
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != request.selected_message_ids.len()
    {
        return Err(fail(
            ErrorCode::InvalidInput,
            "conversation-planning-messages",
        ));
    }
    let mut messages = Vec::with_capacity(request.selected_message_ids.len());
    for id in &request.selected_message_ids {
        let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM application_conversation_messages WHERE message_id=?1)", [id.to_string()], |r|r.get(0)).map_err(sql)?;
        if !exists {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-planning-message",
            ));
        }
        let value = message(c, request.project_id, *id)?;
        if value.conversation_id != request.conversation_id {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-planning-message",
            ));
        }
        messages.push(value);
    }
    messages.sort_by_key(|message| message.ordinal);
    let (units, ai_preview) = match &request.scope {
        ConversationPlanningScope::ConversationOnly {} => (Vec::new(), None),
        ConversationPlanningScope::Units { locale, unit_ids } => {
            let parsed = crate::Locale::parse(locale)
                .map_err(|_| fail(ErrorCode::InvalidInput, "conversation-planning-locale"))?;
            let metadata = read_metadata_from(c).map_err(|_| corrupt())?;
            if parsed.as_str() != locale || !metadata.target_locales().contains(&parsed) {
                return Err(fail(
                    ErrorCode::DependencyConflict,
                    "conversation-planning-locale",
                ));
            }
            if unit_ids.is_empty()
                || unit_ids.len() > request.config.max_items.min(100) as usize
                || unit_ids.iter().collect::<BTreeSet<_>>().len() != unit_ids.len()
            {
                return Err(fail(ErrorCode::InvalidInput, "conversation-planning-units"));
            }
            let targets =
                crate::persistence::review::targets_in(c, request.project_id, unit_ids, locale)?;
            let protections =
                super::super::protection_summaries(c, request.project_id, unit_ids, locale)?;
            // preview_ai joins this outer read transaction rather than taking a
            // second snapshot. Existing strategy and disclosure checks stay owned there.
            let preview = store.preview_ai(request.config.clone(), locale, unit_ids)?;
            let units = targets
                .iter()
                .zip(&preview.items)
                .map(|(target, item)| {
                    if target.unit_id != item.unit_id
                        || target.source_revision_id != item.source_revision_id
                        || target.source_snapshot_id != item.source_snapshot_id
                    {
                        return Err(fail(
                            ErrorCode::DependencyConflict,
                            "conversation-planning-source",
                        ));
                    }
                    let protection: WorkProtection = protections
                        .get(&target.unit_id)
                        .cloned()
                        .ok_or_else(corrupt)?;
                    Ok(ConversationPlanningUnitBasis {
                        unit_id: target.unit_id,
                        source_snapshot_id: target.source_snapshot_id,
                        source_revision_id: target.source_revision_id,
                        selection_id: target.selection_id,
                        translation_revision_id: target.revision_id,
                        protection,
                        shared_term_revision_ids: item
                            .terms
                            .iter()
                            .map(|term| term.revision_id)
                            .collect(),
                        shared_context_revision_id: item
                            .context
                            .as_ref()
                            .map(|context| context.revision_id),
                    })
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?;
            (units, Some(preview))
        }
    };
    let items = ai_preview
        .as_ref()
        .map_or(&[][..], |preview| preview.items.as_slice());
    let (input, byte_length, brief) =
        conversation_planning::prompt(&request.config, &request.scope, &messages, items, &units)?;
    let preview = ConversationPlanningPreview {
        version: CONVERSATION_PLANNING_PREVIEW_VERSION,
        project_id: request.project_id,
        conversation_id: request.conversation_id,
        config: request.config.clone(),
        scope: request.scope.clone(),
        selected_messages: messages,
        units,
        system: conversation_planning::SYSTEM.into(),
        input,
        byte_length,
        brief,
    };
    codec::encode(&preview, MAX_CONVERSATION_PLANNING_PREVIEW_BYTES)?;
    Ok((preview, ai_preview))
}

impl ProjectStore {
    /// Capture exactly the caller's selected messages and content, with no
    /// execution, permission, identity allocation or persistent mutation.
    pub fn prepare_conversation_planning(
        &self,
        request: &PrepareConversationPlanning,
    ) -> Result<CapturedConversationPlanning, ExecutionError> {
        if self.is_reconciling() {
            return Err(fail(
                ErrorCode::OutcomeUnknown,
                "conversation-planning-session",
            ));
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-planning-session"))?;
        let (preview, ai_preview) = read_snapshot(c, |c| preview_in(self, c, request))?;
        Ok(CapturedConversationPlanning {
            epoch: self.changes_since(Revision::new(0)?).epoch,
            request: request.clone(),
            preview,
            ai_preview,
        })
    }

    /// Check the same opened Store and relevant current facts without refreshing
    /// the original witness. Unselected new messages and unrelated edits do not
    /// extend its materials or invalidate it via a global change counter.
    pub fn validate_conversation_planning(
        &self,
        capture: &CapturedConversationPlanning,
    ) -> Result<(), ExecutionError> {
        if self.is_reconciling() || self.changes_since(Revision::new(0)?).epoch != capture.epoch {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-planning-session",
            ));
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-planning-session"))?;
        let (current, current_ai) = read_snapshot(c, |c| preview_in(self, c, &capture.request))?;
        // Source-context identities and shared manual decisions remain local
        // evidence even when their provider-facing text is unchanged. The
        // unrelated global resource change counter is deliberately excluded.
        let shared_evidence = |preview: &Option<AiPreview>| {
            preview.as_ref().map(|preview| {
                preview
                    .items
                    .iter()
                    .map(|item| {
                        let manual = match &item.project_context {
                            crate::ProjectFactCapture::Selected { decisions, .. }
                                if preview.config.share_context =>
                            {
                                decisions
                                    .iter()
                                    .filter(|decision| {
                                        matches!(
                                            decision.request.disposition,
                                            crate::ContextFactDisposition::Replace { .. }
                                        )
                                    })
                                    .cloned()
                                    .collect::<Vec<_>>()
                            }
                            _ => Vec::new(),
                        };
                        (item.source_context.clone(), manual)
                    })
                    .collect::<Vec<_>>()
            })
        };
        if current != capture.preview
            || shared_evidence(&current_ai) != shared_evidence(&capture.ai_preview)
        {
            return Err(fail(
                ErrorCode::DependencyConflict,
                "conversation-planning-current",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
