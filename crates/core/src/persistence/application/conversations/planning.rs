//! Bounded planning captures and explicit permission in the original execution ledger.
use super::*;
use crate::{
    ai::{AiPreview, conversation_planning},
    application::WorkProtection,
};
use std::collections::BTreeSet;
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

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
    /// Prepare authority locally. Only the original enqueue transaction records
    /// this human action; this value alone has no scheduled or durable effect.
    pub fn authorize_conversation_planning(
        &self,
        capture: &CapturedConversationPlanning,
        consent: &ConversationPlanningConsent,
    ) -> Result<PreparedConversationPlanning, ExecutionError> {
        self.validate_conversation_planning(capture)?;
        if consent.action_id != consent.attempt_id
            || !consent.share_messages
            || consent.share_units
                != matches!(
                    &capture.preview.scope,
                    ConversationPlanningScope::Units { .. }
                )
            || consent.preview_digest != capture.preview_digest()?
        {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-planning-consent",
            ));
        }
        let wall = crate::execution::plugin_authority::plugin_now_ms()?;
        let remaining = consent
            .expires_at_ms
            .get()
            .checked_sub(wall)
            .filter(|remaining| {
                *remaining > 0
                    && *remaining
                        <= u64::from(capture.preview.config.timeout_seconds.min(120)) * 1000
            })
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "conversation-planning-expiry"))?;
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(remaining))
            .ok_or_else(|| fail(ErrorCode::InvalidInput, "conversation-planning-expiry"))?;
        let input = conversation_planning::fixed_input(capture, consent)?;
        let permit = ConversationPlanningPermit {
            capture: capture.clone(),
            input: input.clone(),
            deadline,
            expires_at_ms: consent.expires_at_ms.get(),
            active: Arc::new(AtomicBool::new(true)),
            store_live: self.mcp_query_liveness.clone(),
            store_unknown: self.execution_unknown.clone(),
            authority_revision: self.planning_authority_revision.clone(),
            issued_revision: self
                .planning_authority_revision
                .load(std::sync::atomic::Ordering::Acquire),
            runtime: Arc::default(),
        };
        Ok(PreparedConversationPlanning {
            capture: capture.clone(),
            consent: consent.clone(),
            input,
            permit,
        })
    }

    pub(crate) fn check_prepared_conversation_planning(
        &self,
        prepared: &PreparedConversationPlanning,
    ) -> Result<(), ExecutionError> {
        if !self
            .conversation_planning_permits
            .contains_key(&prepared.input.envelope().attempt_id)
            && self
                .conversation_planning_permits
                .values()
                .filter(|permit| permit.check_input(&permit.input).is_ok())
                .count()
                >= 128
        {
            return Err(fail(
                ErrorCode::LimitExceeded,
                "conversation-planning-permits",
            ));
        }
        self.validate_conversation_planning(&prepared.capture)?;
        prepared.permit.check_input(prepared.input())?;
        if prepared.input.bytes()
            != conversation_planning::fixed_input(&prepared.capture, &prepared.consent)?.bytes()
            || prepared.permit.capture.epoch != prepared.capture.epoch
        {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-planning-preparation",
            ));
        }
        Ok(())
    }

    pub(crate) fn install_conversation_planning(
        &mut self,
        prepared: &PreparedConversationPlanning,
    ) -> Result<(), ExecutionError> {
        self.conversation_planning_permits
            .retain(|_, permit| permit.check_input(&permit.input).is_ok());
        if self.conversation_planning_permits.len() >= 128 {
            return Err(fail(
                ErrorCode::LimitExceeded,
                "conversation-planning-permits",
            ));
        }
        prepared.permit.check_dispatch(prepared.input())?;
        self.conversation_planning_permits.insert(
            prepared.input.envelope().attempt_id,
            prepared.permit.clone(),
        );
        Ok(())
    }

    pub(crate) fn check_conversation_planning_input(
        &self,
        input: &crate::execution::FixedInput,
    ) -> Result<(), ExecutionError> {
        if input.envelope().operation != conversation_planning::OPERATION
            && input.envelope().capability_id != conversation_planning::CAPABILITY
        {
            return Ok(());
        }
        let permit = self
            .conversation_planning_permits
            .get(&input.envelope().attempt_id)
            .ok_or_else(|| fail(ErrorCode::Unauthorized, "conversation-planning-permit"))?;
        let checked = permit
            .check_dispatch(input)
            .and_then(|_| self.validate_conversation_planning(&permit.capture));
        if checked.is_err() {
            permit.revoke();
        }
        checked.map_err(|mut error| {
            if error.code == ErrorCode::DependencyConflict {
                error.code = ErrorCode::Unauthorized;
            }
            error
        })
    }

    pub(crate) fn conversation_planning_permit(
        &self,
        input: &crate::execution::FixedInput,
    ) -> Result<Option<ConversationPlanningPermit>, ExecutionError> {
        if input.envelope().operation != conversation_planning::OPERATION
            && input.envelope().capability_id != conversation_planning::CAPABILITY
        {
            return Ok(None);
        }
        self.check_conversation_planning_input(input)?;
        Ok(self
            .conversation_planning_permits
            .get(&input.envelope().attempt_id)
            .cloned())
    }

    pub(crate) fn revoke_conversation_planning(&self, task: Option<ExecutionId>) {
        for permit in self
            .conversation_planning_permits
            .values()
            .filter(|permit| task.is_none_or(|task| permit.input.envelope().task_id == task))
        {
            permit.revoke();
        }
    }

    /// Read only the original immutable input. No live permit is installed and
    /// current source edits do not rewrite or invalidate historical evidence.
    pub fn conversation_planning_receipt(
        &self,
        request: &ReadConversationPlanningAction,
    ) -> Result<Option<ConversationPlanningReceipt>, ExecutionError> {
        if request.consent.action_id != request.consent.attempt_id
            || !request.consent.share_messages
            || request.consent.expires_at_ms.get() == 0
            || tsumugi_plugin_sdk::validate_package_digest(&request.consent.preview_digest).is_err()
        {
            return Err(fail(
                ErrorCode::InvalidInput,
                "conversation-planning-action",
            ));
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-planning-action"))?;
        read_snapshot(c, |c| {
            owned(c, request.project_id)?;
            conversation(c, request.project_id, request.conversation_id)?;
            let Some(input) = self.execution_input_if_present(request.consent.attempt_id)? else {
                return Ok(None);
            };
            if input.envelope().operation != conversation_planning::OPERATION
                || input.envelope().capability_id != conversation_planning::CAPABILITY
            {
                return Err(fail(
                    ErrorCode::ResultMismatch,
                    "conversation-planning-action",
                ));
            }
            let settings = conversation_planning::settings(&input)?;
            let preview: ConversationPlanningPreview =
                serde_json::from_value(input.envelope().items[0].payload.clone())
                    .map_err(|_| fail(ErrorCode::CorruptLedger, "conversation-planning-action"))?;
            if input.envelope().project_id != request.project_id
                || preview.conversation_id != request.conversation_id
                || settings.consent != request.consent
            {
                return Err(fail(
                    ErrorCode::ResultMismatch,
                    "conversation-planning-action",
                ));
            }
            if self.execution_recovery_policy(request.consent.attempt_id)?
                != crate::execution::RecoveryPolicy::ExternalUnknown
            {
                return Err(fail(
                    ErrorCode::CorruptLedger,
                    "conversation-planning-action",
                ));
            }
            Ok(Some(ConversationPlanningReceipt {
                project_id: request.project_id,
                conversation_id: request.conversation_id,
                consent: request.consent.clone(),
                input_digest: input.digest().into(),
            }))
        })
    }

    pub fn recover_conversation_planning(
        &self,
        request: &ReadConversationPlanningAction,
    ) -> Result<ConversationPlanningRecovery, ExecutionError> {
        let outcome = match self.conversation_planning_receipt(request) {
            Ok(Some(receipt)) => {
                crate::application::ConversationActionOutcome::Recorded { receipt }
            }
            Ok(None) => crate::application::ConversationActionOutcome::Pending {
                replay: crate::application::ConversationActionReplay::Blocked,
            },
            Err(error) if error.code == ErrorCode::ResultMismatch => {
                return Ok(ConversationPlanningRecovery {
                    request: request.clone(),
                    outcome: crate::application::ConversationActionOutcome::Mismatch {},
                });
            }
            Err(error) => return Err(error),
        };
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(ConversationPlanningRecovery {
            request: request.clone(),
            outcome,
        })
    }

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
