//! Typed planning uses the original provider, request budget and result ledger.
use super::*;
use crate::{
    ai::{Usage, provider::ProviderProfile},
    application::PlanOptions,
    execution::*,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ConversationPlanningModelOutput {
    Reply {
        summary: String,
        questions: Vec<String>,
    },
    Proposal {
        summary: String,
        unit_ids: Vec<ExecutionId>,
        options: PlanOptions,
        questions: Vec<String>,
    },
    KnowledgeProposal {
        summary: String,
        entries: Vec<crate::application::ConversationKnowledgeEntry>,
        questions: Vec<String>,
    },
    TermProposal {
        summary: String,
        entries: Vec<crate::application::ConversationTermEntry>,
        questions: Vec<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPlanningOutput {
    pub model: ConversationPlanningModelOutput,
    pub usage: Option<Usage>,
    pub requests: u32,
    pub usage_incomplete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub recipe: String,
    pub config: AiConfig,
    pub consent: ConversationPlanningConsent,
    /// Local provenance stays in the original ledger, outside the model prompt.
    #[serde(deserialize_with = "serde::Deserialize::deserialize")]
    pub material: Option<crate::ai::AiPreview>,
}

pub(crate) fn fixed_input(
    capture: &CapturedConversationPlanning,
    consent: &ConversationPlanningConsent,
) -> Result<FixedInput, ExecutionError> {
    let preview = capture.preview();
    let item = InputItem {
        item_id: consent.action_id,
        scope: Scope {
            kind: "project-conversation".into(),
            id: preview.conversation_id.to_string(),
            locale: match &preview.scope {
                ConversationPlanningScope::ConversationOnly {} => None,
                ConversationPlanningScope::Units { locale, .. } => Some(locale.clone()),
            },
        },
        payload: serde_json::to_value(preview)
            .map_err(|_| error(ErrorCode::InvalidInput, "conversation-planning-input"))?,
        dependencies: vec![],
    };
    let mut limits = ExecutionLimits::default();
    limits.timeout_ms = preview.config.timeout_seconds * 1000;
    let input = FixedInput::capture(InputEnvelope {
        version: 1,
        project_id: preview.project_id,
        task_id: consent.task_id,
        attempt_id: consent.attempt_id,
        previous_attempt_id: None,
        automation: None,
        plugin: None,
        operation: OPERATION.into(),
        capability_id: CAPABILITY.into(),
        capability_version: profile(preview.purpose).0.into(),
        settings: serde_json::to_value(Settings {
            recipe: profile(preview.purpose).1.into(),
            config: preview.config.clone(),
            consent: consent.clone(),
            material: capture.ai_preview.clone(),
        })
        .map_err(|_| error(ErrorCode::InvalidInput, "conversation-planning-input"))?,
        limits,
        items: vec![item],
        units: vec![AdoptionUnit {
            unit_id: consent.action_id,
            item_ids: vec![consent.action_id],
        }],
        reused_results: vec![],
    })?;
    settings(&input)?;
    request_body(&input, consent.action_id)?;
    Ok(input)
}

pub(crate) fn settings(input: &FixedInput) -> Result<Settings, ExecutionError> {
    let e = input.envelope();
    if e.operation != OPERATION
        || e.capability_id != CAPABILITY
        || !matches!(e.capability_version.as_str(), "1" | "2" | "3")
        || e.plugin.is_some()
        || e.automation.is_some()
        || e.previous_attempt_id.is_some()
        || !e.reused_results.is_empty()
        || e.items.len() != 1
        || e.units.len() != 1
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "conversation-planning-input",
        ));
    }
    let settings: Settings = codec::decode(
        &codec::encode(&e.settings, MAX_INPUT_BYTES)?,
        MAX_INPUT_BYTES,
    )?;
    let preview = payload(input)?;
    settings.config.validate()?;
    let consent = &settings.consent;
    let scope_locale = match &preview.scope {
        ConversationPlanningScope::ConversationOnly {} => None,
        ConversationPlanningScope::Units { locale, .. } => Some(locale.as_str()),
    };
    if settings.recipe != profile(preview.purpose).1
        || e.capability_version != profile(preview.purpose).0
        || settings.config != preview.config
        || settings.config.max_requests != 1
        || settings.config.max_retries != 0
        || settings.config.concurrency != 1
        || consent.action_id != consent.attempt_id
        || consent.attempt_id != e.attempt_id
        || consent.task_id != e.task_id
        || !consent.share_messages
        || consent.share_units != matches!(preview.scope, ConversationPlanningScope::Units { .. })
        || consent.preview_digest
            != codec::digest(&codec::encode(
                &preview,
                MAX_CONVERSATION_PLANNING_PREVIEW_BYTES,
            )?)
        || consent.expires_at_ms.get() == 0
        || e.items[0].item_id != consent.action_id
        || !e.items[0].dependencies.is_empty()
        || e.items[0].scope.kind != "project-conversation"
        || e.items[0].scope.id != preview.conversation_id.to_string()
        || e.items[0].scope.locale.as_deref() != scope_locale
        || preview.project_id != e.project_id
        || e.units[0].unit_id != consent.action_id
        || e.units[0].item_ids != vec![consent.action_id]
        || e.limits.timeout_ms != settings.config.timeout_seconds * 1000
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "conversation-planning-settings",
        ));
    }
    validate_preview(&preview)?;
    match (&preview.scope, &settings.material) {
        (ConversationPlanningScope::ConversationOnly {}, None) => {}
        (ConversationPlanningScope::Units { .. }, Some(material)) => {
            if material.config != settings.config
                || material.recipe != crate::ai::RECIPE
                || material.items.len() != preview.units.len()
                || material.digest != crate::ai::preview_digest(&material.config, &material.items)?
            {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "conversation-planning-provenance",
                ));
            }
            for (item, basis) in material.items.iter().zip(&preview.units) {
                crate::ai::validate_item_prompt(item, preview.project_id)?;
                crate::ai::validate_source_context(
                    &settings.config,
                    item,
                    Some(preview.project_id),
                )?;
                if item.unit_id != basis.unit_id
                    || item.source_snapshot_id != basis.source_snapshot_id
                    || item.source_revision_id != basis.source_revision_id
                    || item.context_resources != basis.context_resources
                {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "conversation-planning-provenance",
                    ));
                }
            }
            let (input, byte_length, brief) = super::prompt_for(
                preview.purpose,
                &settings.config,
                &preview.scope,
                &preview.selected_messages,
                &material.items,
                &preview.units,
            )?;
            if input != preview.input
                || byte_length != preview.byte_length
                || brief != preview.brief
            {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "conversation-planning-provenance",
                ));
            }
        }
        _ => {
            return Err(error(
                ErrorCode::InvalidInput,
                "conversation-planning-provenance",
            ));
        }
    }
    Ok(settings)
}

fn payload(input: &FixedInput) -> Result<ConversationPlanningPreview, ExecutionError> {
    let item = input
        .envelope()
        .items
        .first()
        .ok_or_else(|| error(ErrorCode::InvalidInput, "conversation-planning-item"))?;
    codec::decode(
        &codec::encode(&item.payload, MAX_CONVERSATION_PLANNING_PREVIEW_BYTES)?,
        MAX_CONVERSATION_PLANNING_PREVIEW_BYTES,
    )
}

pub fn preview_from_input(
    input: &FixedInput,
) -> Result<ConversationPlanningPreview, ExecutionError> {
    settings(input)?;
    payload(input)
}

pub fn consent_from_input(
    input: &FixedInput,
) -> Result<ConversationPlanningConsent, ExecutionError> {
    Ok(settings(input)?.consent)
}

fn validate_preview(preview: &ConversationPlanningPreview) -> Result<(), ExecutionError> {
    let invalid = || error(ErrorCode::InvalidInput, "conversation-planning-material");
    if preview.version != profile(preview.purpose).3
        || preview.system != profile(preview.purpose).2
        || preview.purpose.is_some()
            && matches!(
                preview.scope,
                ConversationPlanningScope::ConversationOnly {}
            )
        || preview.selected_messages.is_empty()
        || preview.selected_messages.len() > MAX_CONVERSATION_PLANNING_MESSAGES
        || preview
            .selected_messages
            .iter()
            .map(|v| v.message_id)
            .collect::<BTreeSet<_>>()
            .len()
            != preview.selected_messages.len()
        || preview
            .selected_messages
            .iter()
            .enumerate()
            .any(|(index, message)| {
                message.project_id != preview.project_id
                    || message.conversation_id != preview.conversation_id
                    || message.ordinal.get() == 0
                    || index > 0 && message.ordinal <= preview.selected_messages[index - 1].ordinal
            })
    {
        return Err(invalid());
    }
    let projected: Value = codec::decode(
        preview.input.as_bytes(),
        ProviderProfile::compatible(&preview.config)?.max_prompt_bytes,
    )?;
    let expected_messages = json!(
        preview
            .selected_messages
            .iter()
            .map(|message| json!({"author":message.author,"body":message.body}))
            .collect::<Vec<_>>()
    );
    let units = projected["units"].as_array().ok_or_else(invalid)?;
    let expected_scope = match &preview.scope {
        ConversationPlanningScope::ConversationOnly {} => {
            if !preview.units.is_empty() || !units.is_empty() {
                return Err(invalid());
            }
            json!({"kind":"conversation-only"})
        }
        ConversationPlanningScope::Units { locale, unit_ids } => {
            if unit_ids.is_empty()
                || unit_ids.len() > preview.config.max_items.min(100) as usize
                || unit_ids.iter().collect::<BTreeSet<_>>().len() != unit_ids.len()
                || units.len() != unit_ids.len()
                || preview.units.len() != unit_ids.len()
                || units
                    .iter()
                    .zip(&preview.units)
                    .enumerate()
                    .any(|(index, (unit, basis))| {
                        basis.unit_id != unit_ids[index]
                            || basis.protection.unit_id != basis.unit_id
                            || basis.protection.locale != *locale
                            || unit["unitId"] != json!(basis.unit_id)
                            || unit["targetLocale"] != *locale
                            || unit["humanProtected"] != basis.protection.protected
                    })
            {
                return Err(invalid());
            }
            json!({"kind":"units","targetLocale":locale})
        }
    };
    if projected["purpose"] != super::purpose_name(preview.purpose)
        || projected["scope"] != expected_scope
        || projected["messages"] != expected_messages
        || preview.byte_length as usize
            != codec::encode(
                &json!({"system":preview.system,"input":preview.input}),
                ProviderProfile::compatible(&preview.config)?.max_prompt_bytes,
            )?
            .len()
        || preview.brief != super::brief_for(&projected)
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn request_body(input: &FixedInput, item: ExecutionId) -> Result<Value, ExecutionError> {
    let settings = settings(input)?;
    if item != settings.consent.action_id {
        return Err(error(
            ErrorCode::ResultMismatch,
            "conversation-planning-item",
        ));
    }
    let preview = payload(input)?;
    let profile = ProviderProfile::compatible(&settings.config)?;
    let mut body = json!({"model":settings.config.model,"stream":false,"messages":[{"role":"system","content":preview.system},{"role":"user","content":preview.input}]});
    if !settings.config.is_chatgpt_subscription() {
        body[&profile.output_token_field] = settings.config.max_output_tokens.into();
    }
    codec::encode(&body, profile.max_prompt_bytes)?;
    Ok(body)
}

pub(crate) fn validate_model(
    model: &ConversationPlanningModelOutput,
    preview: &ConversationPlanningPreview,
) -> Result<(), ExecutionError> {
    let invalid = || error(ErrorCode::OutputInvalid, "conversation-planning-output");
    codec::encode(
        model,
        ProviderProfile::compatible(&preview.config)?.max_output_bytes,
    )
    .map_err(|_| invalid())?;
    let (summary, questions) = match model {
        ConversationPlanningModelOutput::Reply { summary, questions } => (summary, questions),
        ConversationPlanningModelOutput::Proposal {
            summary,
            questions,
            unit_ids,
            options,
        } => {
            if preview.purpose.is_some() {
                return Err(invalid());
            }
            let ConversationPlanningScope::Units {
                unit_ids: allowed, ..
            } = &preview.scope
            else {
                return Err(invalid());
            };
            if unit_ids.is_empty()
                || unit_ids.len() > allowed.len()
                || unit_ids.iter().collect::<BTreeSet<_>>().len() != unit_ids.len()
                || unit_ids.iter().any(|id| !allowed.contains(id))
            {
                return Err(invalid());
            }
            options.authorization_effects().map_err(|_| invalid())?;
            if preview
                .units
                .iter()
                .any(|unit| unit.protection.protected && unit_ids.contains(&unit.unit_id))
                && options.selection_policy != crate::application::SelectionPolicy::CandidatesOnly
            {
                return Err(invalid());
            }
            (summary, questions)
        }
        ConversationPlanningModelOutput::KnowledgeProposal {
            summary,
            entries,
            questions,
        } => {
            if preview.purpose != Some(ConversationPlanningPurpose::Knowledge) {
                return Err(invalid());
            }
            validate_proposal_draft_content(model).map_err(|_| invalid())?;
            // Reserve space for the immutable proposal identity and provenance
            // inside its existing 64 KiB record, rather than truncating later.
            codec::encode(model, 60 * 1024).map_err(|_| invalid())?;
            let ConversationPlanningScope::Units {
                unit_ids: allowed, ..
            } = &preview.scope
            else {
                return Err(invalid());
            };
            if entries
                .iter()
                .any(|e| e.unit_ids.iter().any(|id| !allowed.contains(id)))
            {
                return Err(invalid());
            }
            (summary, questions)
        }
        ConversationPlanningModelOutput::TermProposal { summary, entries, questions } => {
            if preview.purpose != Some(ConversationPlanningPurpose::Terminology) {
                return Err(invalid());
            }
            validate_proposal_draft_content(model).map_err(|_| invalid())?;
            codec::encode(model, 60 * 1024).map_err(|_| invalid())?;
            let ConversationPlanningScope::Units { unit_ids: allowed, .. } = &preview.scope else { return Err(invalid()); };
            let material: Value = codec::decode(preview.input.as_bytes(), MAX_CONVERSATION_PLANNING_PREVIEW_BYTES)?;
            for entry in entries {
                if !allowed.contains(&entry.unit_id) || !material["units"].as_array().is_some_and(|units| units.iter().any(|unit|
                    unit["unitId"] == json!(entry.unit_id) && unit["sourceText"].as_str().is_some_and(|text| text.contains(&entry.source)))) {
                    return Err(invalid());
                }
            }
            (summary, questions)
        }
    };
    if summary.trim().is_empty()
        || summary.len() > 8192
        || questions.len() > 8
        || questions
            .iter()
            .any(|q| q.trim().is_empty() || q.len() > 2048)
    {
        return Err(invalid());
    }
    Ok(())
}

/// Structural draft validation never grants a scope or replaces the checked
/// model/result/proposal owner validation against its original frozen input.
pub fn validate_proposal_draft_content(
    value: &ConversationPlanningModelOutput,
) -> Result<(), ExecutionError> {
    let invalid = || error(ErrorCode::InvalidInput, "conversation-proposal-draft");
    codec::encode(value, 65536).map_err(|_| invalid())?;
    let (summary, questions) = match value {
        ConversationPlanningModelOutput::Reply { .. } => return Err(invalid()),
        ConversationPlanningModelOutput::Proposal {
            summary,
            questions,
            unit_ids,
            options,
        } => {
            if unit_ids.is_empty()
                || unit_ids.len() > 100
                || unit_ids.iter().collect::<BTreeSet<_>>().len() != unit_ids.len()
            {
                return Err(invalid());
            }
            options.authorization_effects().map_err(|_| invalid())?;
            (summary, questions)
        }
        ConversationPlanningModelOutput::KnowledgeProposal {
            summary,
            questions,
            entries,
        } => {
            if entries.is_empty()
                || entries.len() > 16
                || entries.iter().any(|e| {
                    e.name.trim().is_empty()
                        || e.name.len() > 512
                        || e.text.trim().is_empty()
                        || e.text.len() > 16384
                        || e.name.contains('\0')
                        || e.text.contains('\0')
                        || e.unit_ids.is_empty()
                        || e.unit_ids.len() > 100
                        || e.unit_ids.iter().collect::<BTreeSet<_>>().len() != e.unit_ids.len()
                })
            {
                return Err(invalid());
            }
            (summary, questions)
        }
        ConversationPlanningModelOutput::TermProposal { summary, entries, questions } => {
            let valid_text = |text: &str, max: usize| !text.trim().is_empty() && text.len() <= max && !text.contains('\0');
            if entries.is_empty() || entries.len() > 16
                || entries.iter().map(|entry| (entry.unit_id, &entry.source)).collect::<BTreeSet<_>>().len() != entries.len()
                || entries.iter().any(|entry| !valid_text(&entry.source, 512) || !valid_text(&entry.target, 16384)
                    || !valid_text(&entry.reason, 16384) || entry.aliases.len() > 16
                    || entry.aliases.iter().collect::<BTreeSet<_>>().len() != entry.aliases.len()
                    || entry.aliases.iter().any(|alias| !valid_text(alias, 512) || alias == &entry.source)) {
                return Err(invalid());
            }
            (summary, questions)
        }
    };
    if summary.trim().is_empty()
        || summary.len() > 8192
        || questions.len() > 8
        || questions
            .iter()
            .any(|q| q.trim().is_empty() || q.len() > 2048)
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn validate_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<ConversationPlanningOutput, ExecutionError> {
    let result = FixedResult::receive(result.bytes(), input, result.envelope().dispatch_token)?;
    let settings = settings(input)?;
    if result.envelope().item_id != settings.consent.action_id
        || result.envelope().outcome != ExecutionState::Succeeded
    {
        return Err(error(
            ErrorCode::ResultMismatch,
            "conversation-planning-result",
        ));
    }
    let output: ConversationPlanningOutput =
        codec::decode(&codec::encode(&result.envelope().output, 65536)?, 65536)?;
    validate_model(&output.model, &payload(input)?)?;
    validate_usage(&output, &settings.config)?;
    Ok(output)
}

#[cfg(test)]
mod tests;
fn validate_usage(
    output: &ConversationPlanningOutput,
    config: &AiConfig,
) -> Result<(), ExecutionError> {
    if output.requests != 1
        || output.usage.is_none() && !output.usage_incomplete
        || output.usage.as_ref().is_some_and(|usage| {
            usage.prompt_tokens > i64::MAX as u64
                || config.output_tokens_exceeded(usage.completion_tokens, 1)
                || usage.validate_aggregate(output.usage_incomplete).is_err()
        })
    {
        return Err(error(
            ErrorCode::OutputInvalid,
            "conversation-planning-usage",
        ));
    }
    Ok(())
}

pub struct ConversationPlanningRunner {
    service: Arc<super::super::provider::ProviderService>,
    version: &'static str,
}
impl ConversationPlanningRunner {
    pub fn with_service(service: Arc<super::super::provider::ProviderService>) -> Self {
        Self {
            service,
            version: "1",
        }
    }
    pub fn with_knowledge_service(service: Arc<super::super::provider::ProviderService>) -> Self {
        Self {
            service,
            version: "2",
        }
    }
    pub fn with_terminology_service(service: Arc<super::super::provider::ProviderService>) -> Self {
        Self { service, version: "3" }
    }
}
impl Runner for ConversationPlanningRunner {
    fn capability_id(&self) -> &str {
        CAPABILITY
    }
    fn capability_version(&self) -> &str {
        self.version
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancel: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let outcome = (|| {
            let settings = settings(&request.input)?;
            request.check_service_dispatch()?;
            let completion = super::super::execute_completion(
                &self.service,
                &request,
                &cancel,
                &settings.config,
                request_body(&request.input, request.item_id)?,
            )?;
            let model = codec::decode(
                completion.content.as_bytes(),
                ProviderProfile::compatible(&settings.config)?.max_output_bytes,
            )
            .map_err(|_| error(ErrorCode::OutputInvalid, "conversation-planning-output"))?;
            let output = ConversationPlanningOutput {
                model,
                usage: completion.usage,
                requests: completion.requests,
                usage_incomplete: completion.usage_incomplete,
            };
            validate_model(&output.model, &payload(&request.input)?)?;
            validate_usage(&output, &settings.config)?;
            Ok(output)
        })();
        super::super::send_outcome(request, results, outcome)
    }
}
