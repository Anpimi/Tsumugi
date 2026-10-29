use super::*;
use crate::commands::execution::work_plans::recovery::{
    WorkPlanTeamRecoveryPrepareOriginal, WorkPlanTeamRecoverySettlementOriginal,
};
use tsumugi_core::application::{
    AutomationLease, AuthorizeTeamRecovery, PrepareTeamRecovery, TeamDiscussionTarget,
    TeamEffectiveVersion, TeamExecutionMember, TeamHumanWork, TeamRecoveryReceipt, TeamWorkKind,
    WorkPlanState,
};

fn rev(value: u64) -> Revision { Revision::new(value).unwrap() }

fn fixture() -> (tempfile::TempDir, DraftStore, ConversationDraftWrite) {
    let directory = tempfile::tempdir().unwrap();
    let store = DraftStore::at(directory.path().join("drafts")).unwrap();
    let key = ConversationDraftKey { project_id: ExecutionId::new(), conversation_id: ExecutionId::new() };
    let lease = AutomationLease { plan_id: ExecutionId::new(), generation: rev(4) };
    let member = TeamExecutionMember {
        member_id: ExecutionId::new(), role_version_id: ExecutionId::new(),
        display_name: "Original member".into(), role: "Read the captured source".into(),
        config: tsumugi_core::ai::AiConfig::default(), unit_ids: vec![ExecutionId::new()],
        tool_handles: vec![ExecutionId::new()], kinds: vec![TeamWorkKind::Translation],
    };
    let request = WorkPlanTeamRecoveryPrepareOriginal {
        project_id: key.project_id, preparation_id: ExecutionId::new(),
        recovery: PrepareTeamRecovery {
            project_id: key.project_id, plan_id: lease.plan_id, expected_lease: lease,
            expected_effective_version: TeamEffectiveVersion {
                action_id: ExecutionId::new(), lease: AutomationLease { generation: rev(3), ..lease }, digest: "a".repeat(64),
            },
            members: vec![member.clone()],
            work: TeamHumanWork {
                work_id: ExecutionId::new(), member_id: member.member_id,
                target: TeamDiscussionTarget { unit_id: member.unit_ids[0], locale: "zh-CN".into(),
                    source_snapshot_id: ExecutionId::new(), source_revision_id: ExecutionId::new() },
                kind: TeamWorkKind::Translation, instructions: "Original recovery A {{name}} 中文".into(),
                post_ids: vec![ExecutionId::new()], prior_work: vec![],
            },
        },
    };
    let input = ConversationTeamRecoveryDraft {
        edit_seq: rev(1), next_key: 1,
        members: vec![ConversationTeamRecoveryMemberDraft {
            key: 0, original: Some(member.clone()), display_name: member.display_name, role: member.role,
            config: member.config, unit_ids: member.unit_ids,
            tool_handles: member.tool_handles.iter().map(ToString::to_string).collect(), kinds: member.kinds,
        }],
        recipient_key: Some(0), unit_id: Some(request.recovery.work.target.unit_id), kind: request.recovery.work.kind,
        instructions: request.recovery.work.instructions.clone(), post_ids: request.recovery.work.post_ids.clone(), prior_work: vec![],
    };
    let pending = ConversationDraftPending::TeamRecovery {
        conversation_id: key.conversation_id, request, authorization: None, submitted_seq: rev(1),
    };
    let write = ConversationDraftWrite {
        key, expected_revision: rev(0), writer_id: ExecutionId::new(),
        value: ConversationDraftValue { text: "Other unsent message".into(), edit_seq: rev(1), message_edit_seq: None,
            pending: Some(pending), revocations: vec![], proposal_edits: vec![],
            team_drafts: vec![ConversationTeamDraft { questions: vec![], plan_id: lease.plan_id, plan_digest: "a".repeat(64),
                guidance: None, publication: None, recovery: Some(input), recovery_recorded: None }],
        },
    };
    (directory, store, write)
}

fn authorize(write: &mut ConversationDraftWrite) -> ConversationTeamRecoveryRecorded {
    let Some(ConversationDraftPending::TeamRecovery { request, authorization, .. }) = &mut write.value.pending else { panic!("recovery pending") };
    let original = WorkPlanTeamRecoverySettlementOriginal {
        project_id: request.project_id, preparation_id: request.preparation_id, plan_id: request.recovery.plan_id,
        base_lease: request.recovery.expected_lease,
        recovery: AuthorizeTeamRecovery { action_id: ExecutionId::new(), digest: "b".repeat(64), confirmed: true, effects: vec![] },
        checker_executions: vec![], tool_execution: false, application_tool_executions: vec![],
    };
    let receipt = TeamRecoveryReceipt {
        action_id: original.recovery.action_id, base_lease: original.base_lease,
        effective_version: TeamEffectiveVersion { action_id: original.recovery.action_id,
            lease: AutomationLease { generation: rev(5), ..original.base_lease }, digest: original.recovery.digest.clone() },
        state: WorkPlanState::Active, cancellation_revision: rev(2), work_id: request.recovery.work.work_id,
        task_id: ExecutionId::new(), attempt_id: ExecutionId::new(), input_digest: "c".repeat(64),
    };
    *authorization = Some(original.clone());
    ConversationTeamRecoveryRecorded { request: request.clone(), authorization: original, receipt }
}

#[test]
fn recovery_local_input_keeps_incomplete_values_and_uses_existing_quota() {
    let (_directory, store, mut write) = fixture();
    write.value.pending = None;
    let input = write.value.team_drafts[0].recovery.as_mut().unwrap();
    input.members[0].display_name.clear(); input.members[0].role.clear(); input.members[0].kinds.clear();
    input.members[0].unit_ids.clear(); input.members[0].tool_handles = vec!["Unselected handle".into()];
    input.members[0].config.endpoint.clear(); input.members[0].config.max_requests = 0;
    input.recipient_key = None; input.unit_id = None; input.instructions.clear();
    let first = store.write_conversation(&write).unwrap();
    write.expected_revision = first.revision; write.value.edit_seq = rev(2);
    write.value.team_drafts[0].recovery.as_mut().unwrap().members.clear();
    let second = store.write_conversation(&write).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), second);
    write.expected_revision = second.revision; write.value.edit_seq = rev(3);
    write.value.team_drafts[0].recovery.as_mut().unwrap().instructions = "x".repeat(MAX_CONVERSATION_DRAFT_RECORD_BYTES);
    assert_eq!(store.write_conversation(&write).unwrap_err().code, ErrorCode::LimitExceeded);
}

#[test]
fn recovery_pending_matches_same_sequence_and_rejects_secret_or_index_fields() {
    let (_directory, store, write) = fixture();
    let mut wrong = write.clone(); wrong.value.team_drafts[0].recovery.as_mut().unwrap().instructions.push('!');
    assert_eq!(store.write_conversation(&wrong).unwrap_err().stage, "conversation-drafts-team-recovery");
    wrong = write.clone(); wrong.value.team_drafts[0].recovery.as_mut().unwrap().members[0].tool_handles.clear();
    assert!(store.write_conversation(&wrong).is_err());
    wrong = write.clone();
    if let Some(ConversationDraftPending::TeamRecovery { request, .. }) = &mut wrong.value.pending {
        request.recovery.members[0].role_version_id = ExecutionId::new();
    }
    assert!(store.write_conversation(&wrong).is_err(), "unchanged member keeps original role version");
    wrong = write.clone();
    wrong.value.team_drafts[0].recovery.as_mut().unwrap().members[0].role = "Changed role".into();
    if let Some(ConversationDraftPending::TeamRecovery { request, .. }) = &mut wrong.value.pending {
        request.recovery.members[0].role = "Changed role".into();
    }
    assert!(store.write_conversation(&wrong).is_err(), "changed member needs a new role version");
    if let Some(ConversationDraftPending::TeamRecovery { request, .. }) = &mut wrong.value.pending {
        request.recovery.members[0].role_version_id = ExecutionId::new();
    }
    assert!(validate_value(&wrong.key, &wrong.value).is_ok());
    for field in ["sessionToken", "consent", "runtimePermission"] {
        let mut json = serde_json::to_value(&write).unwrap();
        json["value"]["pending"]["request"][field] = serde_json::json!("forbidden");
        assert!(serde_json::from_value::<ConversationDraftWrite>(json).is_err());
    }
    let mut json = serde_json::to_value(&write).unwrap();
    json["value"]["teamDrafts"][0]["recovery"]["members"][0]["toolRowIds"] = serde_json::json!([0]);
    assert!(serde_json::from_value::<ConversationDraftWrite>(json).is_err());
    assert!(store.write_conversation(&write).is_ok());
}

#[test]
fn recovery_authorization_appends_once_without_replacing_original_or_newer_input() {
    let (_directory, store, mut write) = fixture();
    let mut premature = write.clone(); authorize(&mut premature);
    assert_eq!(store.write_conversation(&premature).unwrap_err().stage, "drafts-pending");
    let first = store.write_conversation(&write).unwrap();
    write.expected_revision = first.revision; write.value.edit_seq = rev(2);
    let input = write.value.team_drafts[0].recovery.as_mut().unwrap(); input.edit_seq = rev(2); input.instructions = "Newer B".into();
    write.value.text = "Newer composer B".into();
    let second = store.write_conversation(&write).unwrap();
    write.expected_revision = second.revision; write.value.edit_seq = rev(3);
    let record = authorize(&mut write);
    let third = store.write_conversation(&write).unwrap();
    assert_eq!(store.write_conversation(&write).unwrap(), third, "same authorization ACK retry is idempotent");
    let snapshot = store.pending_snapshot(write.key.project_id, None).unwrap();
    assert_eq!(snapshot.rows.len(), 1); assert_eq!(snapshot.rows[0].slot.action_id(), record.receipt.action_id);
    assert_eq!(snapshot.rows[0].slot.submitted_seq(), rev(1));
    for change in 0..4 {
        let mut wrong = write.clone(); wrong.expected_revision = third.revision; wrong.value.edit_seq = rev(4);
        let Some(ConversationDraftPending::TeamRecovery { request, authorization, submitted_seq, .. }) = &mut wrong.value.pending else { unreachable!() };
        match change {
            0 => *authorization = None,
            1 => authorization.as_mut().unwrap().tool_execution = true,
            2 => request.preparation_id = ExecutionId::new(),
            _ => *submitted_seq = rev(2),
        }
        assert!(store.write_conversation(&wrong).is_err());
    }
    write.expected_revision = third.revision; write.value.edit_seq = rev(4);
    write.value.team_drafts[0].recovery_recorded = Some(record);
    let fourth = store.write_conversation(&write).unwrap();
    let pending = write.value.pending.take().unwrap();
    write.expected_revision = fourth.revision; write.value.edit_seq = rev(5);
    let resolve = ConversationDraftResolve { write, target: ConversationDraftResolveTarget::Pending { pending }, disposition: ConversationDraftDisposition::Recorded };
    let mut wrong = resolve.clone(); wrong.write.value.team_drafts[0].recovery.as_mut().unwrap().instructions.clear();
    assert_eq!(store.resolve_conversation(&wrong).unwrap_err().stage, "drafts-pending");
    let mut wrong = resolve.clone(); wrong.write.value.team_drafts[0].recovery_recorded = None;
    assert_eq!(store.resolve_conversation(&wrong).unwrap_err().stage, "drafts-pending");
    let settled = store.resolve_conversation(&resolve).unwrap();
    assert_eq!(settled.value.as_ref().unwrap().team_drafts[0].recovery.as_ref().unwrap().instructions, "Newer B");
    assert_eq!(settled.value.as_ref().unwrap().text, "Newer composer B");
    assert_eq!(store.resolve_conversation(&resolve).unwrap(), settled);
}

#[test]
fn recovery_record_checks_complete_receipt_identity_without_restoring_permission() {
    let (_directory, store, mut write) = fixture();
    let record = authorize(&mut write); write.value.pending = None;
    write.value.team_drafts[0].recovery_recorded = Some(record);
    for change in 0..7 {
        let mut wrong = write.clone();
        let record = wrong.value.team_drafts[0].recovery_recorded.as_mut().unwrap();
        match change {
            0 => record.authorization.preparation_id = ExecutionId::new(),
            1 => record.authorization.project_id = ExecutionId::new(),
            2 => record.receipt.base_lease.generation = rev(3),
            3 => record.receipt.effective_version.lease.generation = rev(6),
            4 => record.receipt.effective_version.digest = "d".repeat(64),
            5 => record.receipt.work_id = ExecutionId::new(),
            _ => record.receipt.action_id = ExecutionId::new(),
        }
        assert!(store.write_conversation(&wrong).is_err());
    }
    assert_eq!(store.write_conversation(&write).unwrap().value, Some(write.value));
}

#[test]
fn formats_one_through_thirteen_upgrade_only_with_successful_write() {
    for format in LEGACY_FORMAT..TEAM_RECOVERY_FORMAT {
        let (_directory, store, mut write) = fixture();
        write.value.pending = None; write.value.team_drafts.clear();
        let first = store.write_conversation(&write).unwrap();
        let path = store.directory.join(DATABASE); let connection = Connection::open(path).unwrap();
        if format < CONVERSATION_FORMAT {
            connection.execute_batch("DELETE FROM conversation_draft_heads; DROP TABLE conversation_draft_heads").unwrap();
        } else if format == CONVERSATION_FORMAT {
            connection.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
            connection.execute_batch(LEGACY_HEAD_SQL).unwrap();
            connection.execute("INSERT INTO conversation_draft_heads VALUES(?1,?2,?3,?4,?5,?6)",
                params![write.key.project_id.to_string(), write.key.conversation_id.to_string(), 1, 1, 0, serde_json::to_vec(&first).unwrap()]).unwrap();
        }
        set_legacy_format(&connection, format).unwrap();
        let before = store.read_conversation(&write.key).unwrap();
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), format);
        let mut wrong = write.clone(); wrong.expected_revision = rev(99);
        assert!(store.write_conversation(&wrong).is_err());
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), format);
        assert_eq!(store.write_conversation(&write).unwrap().value, Some(write.value));
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), FORMAT);
        if format >= CONVERSATION_FORMAT { assert_eq!(before, first); }
    }
}

#[test]
fn format_thirteen_rejects_recovery_payload_without_changing_header() {
    for recorded in [false, true] {
        let (_directory, store, mut write) = fixture();
        if recorded {
            let record = authorize(&mut write); write.value.pending = None;
            write.value.team_drafts[0].recovery = None;
            write.value.team_drafts[0].recovery_recorded = Some(record);
        }
        store.write_conversation(&write).unwrap();
        let connection = Connection::open(store.directory.join(DATABASE)).unwrap();
        set_legacy_format(&connection, TEAM_DRAFT_FORMAT).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(store.write_conversation(&write).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), TEAM_DRAFT_FORMAT);
    }
}
