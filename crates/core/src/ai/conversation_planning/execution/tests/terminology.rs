use super::*;

fn terminology_fixture() -> (CapturedConversationPlanning, ConversationPlanningConsent) {
    let (mut capture, mut consent) = fixture(true, true);
    capture.request.purpose = Some(ConversationPlanningPurpose::Terminology);
    capture.preview.purpose = capture.request.purpose;
    capture.preview.version = 4;
    capture.preview.system = super::super::super::TERMINOLOGY_SYSTEM.into();
    let (input, length, brief) = super::super::super::prompt_for(
        capture.preview.purpose,
        &capture.preview.config,
        &capture.preview.scope,
        &capture.preview.selected_messages,
        &capture.ai_preview.as_ref().unwrap().items,
        &capture.preview.units,
    )
    .unwrap();
    capture.preview.input = input;
    capture.preview.byte_length = length;
    capture.preview.brief = brief;
    consent.preview_digest = capture.preview_digest().unwrap();
    (capture, consent)
}
fn proposal(capture: &CapturedConversationPlanning) -> ConversationPlanningModelOutput {
    ConversationPlanningModelOutput::TermProposal {
        summary: "Terminology for human comparison".into(),
        questions: vec![],
        entries: vec![crate::application::ConversationTermEntry {
            unit_id: capture.preview.units[0].unit_id,
            source: "Hello".into(),
            aliases: vec![],
            target: "你好 e\u{301} 👩🏽‍💻".into(),
            protected: false,
            reason: "Use one consistent greeting".into(),
        }],
    }
}
#[test]
fn terminology_profile_preserves_legacy_inputs_and_requires_its_own_exact_consent() {
    let (legacy, old_consent) = fixture(true, false);
    let old = fixed_input(&legacy, &old_consent).unwrap();
    let bytes = old.bytes().to_vec();
    let (capture, mut consent) = terminology_fixture();
    let input = fixed_input(&capture, &consent).unwrap();
    assert_eq!(input.envelope().capability_version, "3");
    assert_eq!(
        settings(&input).unwrap().recipe,
        super::super::super::TERMINOLOGY_RECIPE
    );
    assert_eq!(preview_from_input(&input).unwrap(), capture.preview);
    assert_eq!(
        serde_json::from_str::<Value>(&capture.preview.input).unwrap()["purpose"],
        "term-proposal"
    );
    assert_eq!(
        request_body(&input, consent.action_id).unwrap()["messages"][0]["content"],
        capture.preview.system
    );
    assert!(validate_model(&proposal(&capture), &capture.preview).is_ok());
    assert!(validate_model(&proposal(&capture), &legacy.preview).is_err());
    assert_eq!(preview_from_input(&old).unwrap(), legacy.preview);
    assert_eq!(old.bytes(), bytes);
    consent.preview_digest = old_consent.preview_digest;
    assert!(fixed_input(&capture, &consent).is_err());
    let mut wrong = input.envelope().clone();
    wrong.capability_version = "2".into();
    assert!(settings(&FixedInput::capture(wrong).unwrap()).is_err());
    let mut wrong = capture.clone();
    wrong.preview.system = super::super::super::KNOWLEDGE_SYSTEM.into();
    assert!(fixed_input(&wrong, &consent).is_err());
}
#[test]
fn terminology_output_rejects_invented_source_scope_and_invalid_or_oversized_entries() {
    let (capture, _) = terminology_fixture();
    for change in 0..9 {
        let mut value = proposal(&capture);
        let ConversationPlanningModelOutput::TermProposal { entries, .. } = &mut value else {
            unreachable!()
        };
        match change {
            0 => entries[0].unit_id = ExecutionId::new(),
            1 => entries[0].source = "Invented term".into(),
            2 => entries[0].target = " ".into(),
            3 => entries[0].reason = "bad\0reason".into(),
            4 => entries[0].aliases = vec!["duplicate".into(); 2],
            5 => entries[0].aliases = vec![entries[0].source.clone()],
            6 => {
                let duplicate = entries[0].clone();
                entries.push(duplicate);
            }
            7 => entries[0].target = "x".repeat(16385),
            8 => entries[0].source = "x".repeat(513),
            _ => unreachable!(),
        }
        assert!(
            validate_model(&value, &capture.preview).is_err(),
            "invalid variation {change}"
        );
    }
    let knowledge = ConversationPlanningModelOutput::KnowledgeProposal {
        summary: "Wrong purpose".into(),
        entries: vec![crate::application::ConversationKnowledgeEntry {
            kind: crate::ContextResourceKind::Style,
            name: "Style".into(),
            text: "Keep a greeting".into(),
            unit_ids: vec![capture.preview.units[0].unit_id],
        }],
        questions: vec![],
    };
    assert!(validate_model(&knowledge, &capture.preview).is_err());
    let mut oversized = proposal(&capture);
    let ConversationPlanningModelOutput::TermProposal { entries, .. } = &mut oversized else {
        unreachable!()
    };
    entries[0].reason = "x".repeat(16384);
    entries[0].target = "y".repeat(16384);
    let mut other = entries[0].clone();
    other.source = "{{name}}".into();
    entries.push(other);
    assert!(
        validate_model(&oversized, &capture.preview).is_err(),
        "the original record budget is atomic"
    );
}
