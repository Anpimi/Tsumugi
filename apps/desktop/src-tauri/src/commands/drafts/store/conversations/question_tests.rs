use super::*;
use crate::commands::execution::work_plans::questions::TeamQuestionResponseOriginal;
use tsumugi_core::application::{RespondTeamQuestion, TeamDiscussionPost, TeamQuestionEvent, TeamQuestionOption, TeamQuestionResponse};

fn rev(value: u64) -> Revision { Revision::new(value).unwrap() }
fn fixture() -> (tempfile::TempDir, DraftStore, ConversationDraftWrite) {
    let directory = tempfile::tempdir().unwrap();
    let store = DraftStore::at(directory.path().join("drafts")).unwrap();
    let json: serde_json::Value = serde_json::from_str(include_str!("../../../../../../test/fixtures/teamDiscussionCommands.contract.json")).unwrap();
    let mut question: TeamDiscussionPost = serde_json::from_value(json["responses"]["post"].clone()).unwrap();
    question.publication.kind = tsumugi_core::application::TeamDiscussionKind::HumanQuestion;
    question.publication.body = "Which original voice should {{name}} use?".into();
    question.publication.references.clear();
    let option = ExecutionId::new();
    question.publication.question = Some(TeamQuestionEvent::Open { options: vec![TeamQuestionOption {
        option_id: option, label: "Original formal voice".into() }] });
    let key = ConversationDraftKey { project_id: ExecutionId::new(), conversation_id: ExecutionId::new() };
    let input = ConversationTeamQuestionDraft { question_post_id: question.publication.post_id, edit_seq: rev(1),
        mode: ConversationTeamQuestionMode::Text, option_id: Some(option), body: "Original A {{name}} 中文".into(),
        dismiss_reason: "A separate unfinished dismissal reason".into() };
    let pending = ConversationDraftPending::TeamQuestionResponse { conversation_id: key.conversation_id,
        request: TeamQuestionResponseOriginal { project_id: key.project_id, plan_id: question.plan_id,
            response: RespondTeamQuestion { post_id: ExecutionId::new(), question_post_id: question.publication.post_id,
                response: TeamQuestionResponse::Text { body: input.body.clone() } } }, question: question.clone(), submitted_seq: rev(1) };
    let other = ConversationTeamQuestionDraft { question_post_id: ExecutionId::new(), ..input.clone() };
    let write = ConversationDraftWrite { key: key.clone(), expected_revision: rev(0), writer_id: ExecutionId::new(),
        value: ConversationDraftValue { text: "Independent unfinished composer".into(), edit_seq: rev(1), message_edit_seq: None,
            pending: Some(pending), proposal_edits: vec![], revocations: vec![ConversationDraftRevocation {
                submitted_seq: rev(1), request: WorkPlanRevocationOriginal { project_id: key.project_id,
                    plan_id: question.plan_id, action_id: ExecutionId::new(), expected_generation: rev(1), command: WorkPlanRevocationCommand::Stop } }],
            team_drafts: vec![ConversationTeamDraft { plan_id: question.plan_id, plan_digest: "a".repeat(64),
                questions: vec![input, other], guidance: Some(ConversationTeamGuidanceDraft { edit_seq: rev(1),
                    member_id: None, unit_id: None, body: "Independent guidance".into() }), publication: None,
                recovery: None, recovery_recorded: None }] } };
    (directory, store, write)
}

#[test]
fn local_question_input_allows_incomplete_modes_and_shares_existing_limits() {
    let (_directory, store, mut write) = fixture();
    write.value.pending = None;
    let input = &mut write.value.team_drafts[0].questions[0];
    input.mode = ConversationTeamQuestionMode::Choice; input.option_id = None; input.body.clear(); input.dismiss_reason.clear();
    let first = store.write_conversation(&write).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), first);
    let mut wrong = write.clone(); wrong.expected_revision = first.revision; wrong.value.edit_seq = rev(2);
    let duplicate = wrong.value.team_drafts[0].questions[0].clone();
    wrong.value.team_drafts[0].questions.push(duplicate);
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::InvalidInput);
    let mut wrong = write.clone(); wrong.expected_revision = first.revision; wrong.value.edit_seq = rev(2);
    let template = wrong.value.team_drafts[0].questions[0].clone();
    wrong.value.team_drafts[0].questions = (0..33).map(|_| ConversationTeamQuestionDraft { question_post_id: ExecutionId::new(), ..template.clone() }).collect();
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::LimitExceeded);
    write.expected_revision = first.revision; write.value.edit_seq = rev(2);
    write.value.team_drafts[0].questions[0].body = "x".repeat(MAX_CONVERSATION_DRAFT_RECORD_BYTES);
    assert_eq!(store.write_conversation(&write).unwrap_err().code, ErrorCode::LimitExceeded);
}

#[test]
fn question_pending_freezes_the_exact_request_and_selected_input_without_erasing_other_modes() {
    let (_directory, store, write) = fixture();
    for change in 0..4 {
        let mut wrong = write.clone();
        let input = &mut wrong.value.team_drafts[0].questions[0];
        match change {
            0 => input.body.push('!'),
            1 => input.mode = ConversationTeamQuestionMode::Choice,
            2 => input.edit_seq = rev(0),
            _ => input.question_post_id = ExecutionId::new(),
        }
        assert!(store.write_conversation(&wrong).is_err());
    }
    let first = store.write_conversation(&write).unwrap();
    assert_eq!(store.write_conversation(&write).unwrap(), first);
    let snapshot = store.pending_snapshot(write.key.project_id, None).unwrap();
    let slot = snapshot.rows.iter().find(|row| matches!(row.slot, super::super::pending::PendingJournalSlot::Conversation(_))).unwrap();
    let Some(ConversationDraftPending::TeamQuestionResponse { request, .. }) = &write.value.pending else { unreachable!() };
    assert_eq!(slot.slot.action_id(), request.response.post_id); assert_eq!(slot.slot.submitted_seq(), rev(1));
    for change in 0..4 {
        let mut wrong = write.clone(); wrong.expected_revision = first.revision; wrong.value.edit_seq = rev(2);
        let Some(ConversationDraftPending::TeamQuestionResponse { request, question, submitted_seq, .. }) = &mut wrong.value.pending else { unreachable!() };
        match change {
            0 => request.response.post_id = ExecutionId::new(),
            1 => question.publication.body.push('!'),
            2 => *submitted_seq = rev(0),
            _ => request.response.response = TeamQuestionResponse::Dismiss { reason: "Changed original".into() },
        }
        assert!(store.write_conversation(&wrong).is_err());
    }
    for field in ["sessionToken", "permit", "lease", "consent"] {
        let mut json = serde_json::to_value(&write).unwrap(); json["value"]["pending"]["request"][field] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<ConversationDraftWrite>(json).is_err());
    }
    let (_directory, choice_store, mut choice) = fixture();
    choice.value.team_drafts[0].questions[0].mode = ConversationTeamQuestionMode::Choice;
    let selected = choice.value.team_drafts[0].questions[0].option_id.unwrap();
    let Some(ConversationDraftPending::TeamQuestionResponse { request, .. }) = &mut choice.value.pending else { unreachable!() };
    request.response.response = TeamQuestionResponse::Choice { option_id: selected };
    assert!(choice_store.write_conversation(&choice).is_ok(), "unselected text and dismissal drafts survive choice submission");
    let (_directory, dismissal_store, mut dismissal) = fixture();
    let reason = dismissal.value.team_drafts[0].questions[0].dismiss_reason.clone();
    let Some(ConversationDraftPending::TeamQuestionResponse { request, .. }) = &mut dismissal.value.pending else { unreachable!() };
    request.response.response = TeamQuestionResponse::Dismiss { reason };
    let mut wrong = dismissal.clone(); wrong.value.team_drafts[0].questions[0].dismiss_reason.push('!');
    assert!(dismissal_store.write_conversation(&wrong).is_err());
    assert!(dismissal_store.write_conversation(&dismissal).is_ok(), "unselected answer input survives dismissal submission");
}

#[test]
fn recorded_clears_only_its_matching_question_and_never_newer_input_or_unrelated_slots() {
    for newer in [false, true] {
        for disposition in [ConversationDraftDisposition::Recorded, ConversationDraftDisposition::FencedNotApplied] {
            let (_directory, store, mut write) = fixture();
            let first = store.write_conversation(&write).unwrap();
            write.expected_revision = first.revision; write.value.edit_seq = rev(2);
            if newer {
                let input = &mut write.value.team_drafts[0].questions[0]; input.edit_seq = rev(2); input.body = "Newer B answer".into();
            }
            let second = store.write_conversation(&write).unwrap();
            let previous = write.value.clone();
            let pending = write.value.pending.take().unwrap();
            write.expected_revision = second.revision; write.value.edit_seq = rev(3);
            if disposition == ConversationDraftDisposition::Recorded && !newer { write.value.team_drafts[0].questions.remove(0); }
            let resolve = ConversationDraftResolve { write, target: ConversationDraftResolveTarget::Pending { pending }, disposition };
            for change in 0..3 {
                let mut wrong = resolve.clone();
                match change {
                    0 => wrong.write.value.text.clear(),
                    1 => wrong.write.value.revocations.clear(),
                    _ => wrong.write.value.team_drafts[0].questions.last_mut().unwrap().body.clear(),
                }
                assert_eq!(store.resolve_conversation(&wrong).unwrap_err().code, ErrorCode::DependencyConflict);
            }
            let settled = store.resolve_conversation(&resolve).unwrap();
            assert_eq!(store.resolve_conversation(&resolve).unwrap(), settled);
            let value = settled.value.as_ref().unwrap();
            assert_eq!(value.text, previous.text); assert_eq!(value.revocations, previous.revocations);
            assert_eq!(value.team_drafts[0].guidance, previous.team_drafts[0].guidance);
            if newer || disposition == ConversationDraftDisposition::FencedNotApplied {
                assert_eq!(value.team_drafts, previous.team_drafts);
            } else { assert_eq!(value.team_drafts[0].questions, previous.team_drafts[0].questions[1..]); }
        }
    }
}

#[test]
fn formats_one_through_fourteen_upgrade_atomically_on_successful_question_write() {
    for format in LEGACY_FORMAT..TEAM_QUESTION_FORMAT {
        let (_directory, store, mut write) = fixture();
        write.value.pending = None; write.value.revocations.clear(); write.value.team_drafts.clear();
        let first = store.write_conversation(&write).unwrap();
        let connection = Connection::open(store.directory.join(DATABASE)).unwrap();
        if format < CONVERSATION_FORMAT { connection.execute_batch("DROP TABLE conversation_draft_heads").unwrap(); }
        else if format == CONVERSATION_FORMAT {
            connection.execute_batch("DROP TABLE conversation_draft_heads").unwrap(); connection.execute_batch(LEGACY_HEAD_SQL).unwrap();
            connection.execute("INSERT INTO conversation_draft_heads VALUES(?1,?2,?3,?4,?5,?6)",
                params![write.key.project_id.to_string(), write.key.conversation_id.to_string(), 1, 1, 0, serde_json::to_vec(&first).unwrap()]).unwrap();
        }
        set_legacy_format(&connection, format).unwrap();
        let before = store.read_conversation(&write.key).unwrap();
        let mut wrong = write.clone(); wrong.expected_revision = rev(99);
        assert!(store.write_conversation(&wrong).is_err());
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), format);
        write.expected_revision = before.revision; write.value.edit_seq = rev(2);
        let (_, _, original) = fixture(); write.value.team_drafts = original.value.team_drafts;
        let result = store.write_conversation(&write).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap(), result);
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), TEAM_QUESTION_FORMAT);
    }
}

#[test]
fn an_old_header_cannot_carry_question_input_or_a_question_pending_variant() {
    for pending in [false, true] {
        let (_directory, store, mut write) = fixture();
        if !pending { write.value.pending = None; }
        store.write_conversation(&write).unwrap();
        let connection = Connection::open(store.directory.join(DATABASE)).unwrap();
        set_legacy_format(&connection, TEAM_RECOVERY_FORMAT).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(store.write_conversation(&write).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), TEAM_RECOVERY_FORMAT);
    }
}
