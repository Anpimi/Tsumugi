use super::*;
use crate::application::{
    ConversationAuthor, ConversationPlanningUnitBasis, ProjectConversationMessage, SelectionPolicy,
    StageMode, WorkProtection, WorkStage,
};

fn fixture(
    with_units: bool,
    protected: bool,
) -> (CapturedConversationPlanning, ConversationPlanningConsent) {
    let project_id = ExecutionId::new();
    let conversation_id = ExecutionId::new();
    let config = AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-planner".into(),
        credential_env: String::new(),
        max_requests: 1,
        ..Default::default()
    };
    let messages = vec![ProjectConversationMessage {
        project_id,
        conversation_id,
        message_id: ExecutionId::new(),
        ordinal: Revision::new(1).unwrap(),
        author: ConversationAuthor::Human,
        body: "  保留 é 👩🏽‍💻\r\n{{name}}  ".into(),
    }];
    let id = ExecutionId::new();
    let scope = if with_units {
        ConversationPlanningScope::Units {
            locale: "zh-CN".into(),
            unit_ids: vec![id],
        }
    } else {
        ConversationPlanningScope::ConversationOnly {}
    };
    let bases = if with_units {
        vec![ConversationPlanningUnitBasis {
            unit_id: id,
            source_snapshot_id: ExecutionId::new(),
            source_revision_id: ExecutionId::new(),
            selection_id: None,
            translation_revision_id: None,
            protection: WorkProtection {
                unit_id: id,
                locale: "zh-CN".into(),
                revision: Revision::new(0).unwrap(),
                protected,
            },
            shared_term_revision_ids: vec![],
            shared_context_revision_id: None,
            context_resources: None,
        }]
    } else {
        vec![]
    };
    let items = bases
        .iter()
        .map(|basis| crate::ai::AiItem {
            unit_id: id,
            source_revision_id: basis.source_revision_id,
            source_snapshot_id: basis.source_snapshot_id,
            native_key: "greeting".into(),
            source_locale: "en".into(),
            source_text: "Hello {{name}}".into(),
            target_locale: "zh-CN".into(),
            terms: vec![],
            context: None,
            context_resources: None,
            source_context: crate::SourceContextCapture::NotSelected,
            project_context: crate::ProjectFactCapture::NotSelected,
            omissions: vec![],
            resource_baseline: 0,
        })
        .collect::<Vec<_>>();
    let (input, byte_length, brief) =
        super::super::prompt(&config, &scope, &messages, &items, &bases).unwrap();
    let preview = ConversationPlanningPreview {
        version: CONVERSATION_PLANNING_PREVIEW_VERSION,
        project_id,
        conversation_id,
        config: config.clone(),
        scope: scope.clone(),
        selected_messages: messages.clone(),
        units: bases,
        system: SYSTEM.into(),
        input,
        byte_length,
        brief,
    };
    let ai_preview = if with_units {
        Some(crate::ai::AiPreview {
            config: config.clone(),
            recipe: crate::ai::RECIPE.into(),
            digest: crate::ai::preview_digest(&config, &items).unwrap(),
            items,
        })
    } else {
        None
    };
    let capture = CapturedConversationPlanning {
        epoch: "synthetic-output-fixture".into(),
        request: PrepareConversationPlanning {
            project_id,
            conversation_id,
            config,
            scope,
            selected_message_ids: messages.iter().map(|message| message.message_id).collect(),
        },
        preview,
        ai_preview,
    };
    let action_id = ExecutionId::new();
    // A historical input must still be readable after its consent expires.
    let consent = ConversationPlanningConsent {
        action_id,
        task_id: ExecutionId::new(),
        attempt_id: action_id,
        preview_digest: capture.preview_digest().unwrap(),
        expires_at_ms: 1u64.into(),
        share_messages: true,
        share_units: with_units,
    };
    (capture, consent)
}
fn reply() -> ConversationPlanningModelOutput {
    ConversationPlanningModelOutput::Reply {
        summary: "先确定目标语言。".into(),
        questions: vec!["这次要处理哪些条目？".into()],
    }
}
fn result(
    input: &FixedInput,
    model: ConversationPlanningModelOutput,
    requests: u32,
) -> FixedResult {
    let token = ExecutionId::new();
    FixedResult::capture(
        ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: input.envelope().items[0].item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: token,
            capability_id: CAPABILITY.into(),
            capability_version: "1".into(),
            plugin: None,
            outcome: ExecutionState::Succeeded,
            output: Some(json!(ConversationPlanningOutput {
                model,
                usage: None,
                requests,
                usage_incomplete: true
            })),
            diagnostic: None,
        },
        input,
        token,
    )
    .unwrap()
}

#[test]
fn planning_input_is_deterministic_and_preserves_exact_material_without_becoming_a_translation() {
    let (capture, consent) = fixture(true, false);
    let input = fixed_input(&capture, &consent).unwrap();
    assert_eq!(
        input.bytes(),
        fixed_input(&capture, &consent).unwrap().bytes()
    );
    assert_eq!(preview_from_input(&input).unwrap(), *capture.preview());
    assert_eq!(input.envelope().items[0].scope.kind, "project-conversation");
    assert!(input.envelope().automation.is_none());
    assert!(crate::ai::settings(&input).is_err());
    let body = request_body(&input, consent.action_id).unwrap();
    assert_eq!(body["messages"][0]["content"], capture.preview().system);
    assert_eq!(body["messages"][1]["content"], capture.preview().input);
    assert_eq!(
        body["max_tokens"],
        capture.preview().config.max_output_tokens
    );
    assert!(request_body(&input, ExecutionId::new()).is_err());
    assert!(validate_output(&input, &result(&input, reply(), 1)).is_ok());
}

#[test]
fn planning_rejects_forged_material_configuration_and_consent_even_before_dispatch() {
    let (capture, consent) = fixture(true, false);
    let valid = fixed_input(&capture, &consent).unwrap();
    for field in ["scope", "config", "consent", "body", "brief", "capability"] {
        let mut envelope = valid.envelope().clone();
        match field {
            "scope" => envelope.items[0].scope.kind = "translation-unit".into(),
            "config" => envelope.settings["config"]["maxRequests"] = 2.into(),
            "consent" => envelope.settings["consent"]["shareUnits"] = false.into(),
            "body" => envelope.items[0].payload["input"] = "Different materials".into(),
            "brief" => envelope.items[0].payload["brief"]["messages"] = 2.into(),
            _ => envelope.capability_id = crate::ai::CAPABILITY.into(),
        }
        let changed = FixedInput::capture(envelope).unwrap();
        assert!(settings(&changed).is_err(), "accepted changed {field}");
    }
}

#[test]
fn planning_proposals_keep_the_captured_scope_and_human_protection() {
    let (capture, consent) = fixture(true, true);
    let input = fixed_input(&capture, &consent).unwrap();
    let id = capture.preview().units[0].unit_id;
    let proposal = ConversationPlanningModelOutput::Proposal {
        summary: "先生成候选，保留人工译文。".into(),
        unit_ids: vec![id],
        options: PlanOptions::default(),
        questions: vec![],
    };
    assert!(validate_output(&input, &result(&input, proposal.clone(), 1)).is_ok());
    for ids in [vec![], vec![id, id], vec![ExecutionId::new()]] {
        let mut changed = proposal.clone();
        if let ConversationPlanningModelOutput::Proposal { unit_ids, .. } = &mut changed {
            *unit_ids = ids;
        }
        assert!(validate_output(&input, &result(&input, changed, 1)).is_err());
    }
    let mut changed = proposal.clone();
    if let ConversationPlanningModelOutput::Proposal { options, .. } = &mut changed {
        options.selection_policy = SelectionPolicy::MissingOnly;
        options
            .stages
            .iter_mut()
            .find(|choice| choice.stage == WorkStage::Checks)
            .unwrap()
            .mode = StageMode::Assisted;
    }
    assert!(validate_output(&input, &result(&input, changed, 1)).is_err());
    let (conversation, consent) = fixture(false, false);
    let input = fixed_input(&conversation, &consent).unwrap();
    assert!(validate_output(&input, &result(&input, proposal, 1)).is_err());
}

#[test]
fn planning_requires_complete_bounded_output_and_one_request_accounting() {
    let (capture, consent) = fixture(false, false);
    let input = fixed_input(&capture, &consent).unwrap();
    assert!(validate_output(&input, &result(&input, reply(), 0)).is_err());
    assert!(validate_output(&input, &result(&input, reply(), 2)).is_err());
    for model in [
        ConversationPlanningModelOutput::Reply {
            summary: " ".into(),
            questions: vec![],
        },
        ConversationPlanningModelOutput::Reply {
            summary: "Reply".into(),
            questions: vec!["Question".into(); 9],
        },
    ] {
        assert!(validate_output(&input, &result(&input, model, 1)).is_err());
    }
    let injected = json!({"kind":"reply","summary":"Ready","questions":[],"authorized":true});
    assert!(serde_json::from_value::<ConversationPlanningModelOutput>(injected).is_err());
    let mut malformed = result(&input, reply(), 1).envelope().clone();
    malformed.output.as_mut().unwrap()["usageIncomplete"] = false.into();
    let checked =
        FixedResult::capture(malformed.clone(), &input, malformed.dispatch_token).unwrap();
    assert!(validate_output(&input, &checked).is_err());
    let mut foreign = input.envelope().clone();
    foreign.project_id = ExecutionId::new();
    let foreign = FixedInput::capture(foreign).unwrap();
    assert!(validate_output(&input, &result(&foreign, reply(), 1)).is_err());
}
