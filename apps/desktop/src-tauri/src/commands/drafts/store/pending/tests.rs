use super::*;
use tsumugi_core::{SaveTranslationRevision, application::{AppendProjectConversationMessage, WorkPlanCommand}};

fn rev(value: u64) -> Revision { Revision::new(value).unwrap() }

fn setup() -> (tempfile::TempDir, DraftStore, DraftWrite) {
    let directory = tempfile::tempdir().unwrap();
    let store = DraftStore::at(directory.path().join("drafts")).unwrap();
    let key = DraftKey { project_id: ExecutionId::new(), unit_id: ExecutionId::new(), locale: "zh-CN".into() };
    let request = SaveTranslationRevision { reuse_origin: None, project_id: key.project_id, action_id: ExecutionId::new(),
        unit_id: key.unit_id, locale: key.locale.clone(), source_revision_id: ExecutionId::new(),
        expected_selection_id: None, text: "Original A".into() };
    let write = DraftWrite { key, expected_revision: rev(0), writer_id: ExecutionId::new(),
        value: DraftValue { reuse_origin: None, basis: DraftBasis { source_revision_id: request.source_revision_id,
            selection_id: None, revision_id: None, text: None }, text: "Newer unrelated B".into(),
            edit_seq: rev(2), pending: Some(DraftPending::Save { request, submitted_seq: rev(1) }), merge: None } };
    (directory, store, write)
}

fn conversation(project: ExecutionId) -> ConversationDraftWrite {
    let key = ConversationDraftKey { project_id: project, conversation_id: ExecutionId::new() };
    ConversationDraftWrite { key: key.clone(), expected_revision: rev(0), writer_id: ExecutionId::new(),
        value: ConversationDraftValue { text: "Newer message B".into(), edit_seq: rev(2), message_edit_seq: None,
            pending: Some(ConversationDraftPending::Append { request: AppendProjectConversationMessage {
                project_id: project, conversation_id: key.conversation_id, action_id: ExecutionId::new(),
                message_id: ExecutionId::new(), body: "Original message A".into() }, submitted_seq: rev(1) }),
            revocations: vec![], proposal_edits: vec![] } }
}

fn disk_format(store: &DraftStore) -> i64 {
    Connection::open(store.directory.join(DATABASE)).unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0)).unwrap()
}

#[test]
fn missing_pending_snapshot_is_complete_without_creating_a_profile() {
    let (_directory, store, write) = setup();
    let first = store.pending_snapshot(write.key.project_id, None).unwrap();
    assert!(first.complete && first.rows.is_empty());
    assert_eq!((first.format, first.scanned_heads, first.scanned_bytes), (None, 0, 0));
    assert_eq!(first, store.pending_snapshot(write.key.project_id, None).unwrap());
    assert!(!store.directory.exists());
    assert!(store.pending_snapshot(write.key.project_id, Some("ZH-cn")).is_err());
    assert!(!store.directory.exists());
}

#[test]
fn supported_formats_one_through_seven_are_read_without_upgrade() {
    for format in LEGACY_FORMAT..=FORMAT {
        let (_directory, store, write) = setup();
        store.write(&write).unwrap();
        let conv = conversation(write.key.project_id);
        let conv_head = store.write_conversation(&conv).unwrap();
        let connection = Connection::open(store.directory.join(DATABASE)).unwrap();
        if format < CONVERSATION_FORMAT {
            connection.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
        } else if format == CONVERSATION_FORMAT {
            connection.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
            connection.execute_batch(conversations::LEGACY_HEAD_SQL).unwrap();
            let payload = serde_json::to_vec(&conv_head).unwrap();
            connection.execute("INSERT INTO conversation_draft_heads VALUES(?1,?2,?3,?4,?5,?6)",
                params![conv.key.project_id.to_string(),conv.key.conversation_id.to_string(),1,2,1,payload]).unwrap();
        }
        connection.pragma_update(None, "user_version", format).unwrap();
        drop(connection);
        let before = store.read(&write.key).unwrap();
        let snapshot = store.pending_snapshot(write.key.project_id, None).unwrap();
        assert!(snapshot.complete, "format {format}");
        assert_eq!(snapshot.format, Some(format));
        assert_eq!(snapshot.rows.len(), if format < CONVERSATION_FORMAT { 1 } else { 2 });
        assert_eq!(store.read(&write.key).unwrap(), before);
        assert_eq!(disk_format(&store), format);
        assert_eq!(snapshot, store.pending_snapshot(write.key.project_id, None).unwrap());
    }
}

#[test]
fn pending_snapshot_isolates_projects_and_translation_languages() {
    let (_directory, store, write) = setup();
    store.write(&write).unwrap();
    let mut foreign_locale = write.clone();
    foreign_locale.key.locale = "ja".into();
    if let Some(DraftPending::Save { request, .. }) = &mut foreign_locale.value.pending {
        request.locale = "ja".into(); request.action_id = ExecutionId::new();
    }
    store.write(&foreign_locale).unwrap();
    let conv = conversation(write.key.project_id);
    store.write_conversation(&conv).unwrap();
    let foreign_project = ExecutionId::new();
    store.write_conversation(&conversation(foreign_project)).unwrap();
    let all = store.pending_snapshot(write.key.project_id, None).unwrap();
    assert_eq!(all.rows.len(), 3);
    let selected = store.pending_snapshot(write.key.project_id, Some("zh-CN")).unwrap();
    assert_eq!(selected.rows.len(), 2, "project-scoped conversation remains present");
    assert!(selected.rows.iter().all(|row| match &row.key {
        PendingJournalKey::Translation(key) => key.project_id == write.key.project_id && key.locale == "zh-CN",
        PendingJournalKey::Conversation(key) => key.project_id == write.key.project_id,
    }));
    assert_eq!(store.pending_snapshot(foreign_project, None).unwrap().rows.len(), 1);
    assert_ne!(all.basis, selected.basis);
}

#[test]
fn one_snapshot_expands_independent_slots_and_counts_tombstones() {
    let (_directory, store, write) = setup();
    let head = store.write(&write).unwrap();
    let mut conv = conversation(write.key.project_id);
    for command in [WorkPlanRevocationCommand::Pause, WorkPlanRevocationCommand::Stop] {
        conv.value.revocations.push(ConversationDraftRevocation { request: WorkPlanRevocationOriginal {
            project_id: write.key.project_id, plan_id: ExecutionId::new(), action_id: ExecutionId::new(),
            expected_generation: rev(1), command }, submitted_seq: rev(2) });
    }
    let conv_head = store.write_conversation(&conv).unwrap();
    let tombstone = DraftKey { unit_id: ExecutionId::new(), ..write.key.clone() };
    store.clear(&DraftClear { key: tombstone, expected_revision: rev(0) }).unwrap();
    let snapshot = store.pending_snapshot(write.key.project_id, None).unwrap();
    assert!(snapshot.complete);
    assert_eq!((snapshot.scanned_heads, snapshot.rows.len()), (3, 4));
    assert_eq!(snapshot.rows[0].slot, PendingJournalSlot::Translation(write.value.pending.clone().unwrap()));
    assert_eq!(snapshot.rows[0].head_revision, head.revision);
    assert_eq!(snapshot.rows[0].writer_id, write.writer_id);
    assert_eq!(snapshot.rows[0].slot.submitted_seq(), rev(1));
    let conversation_rows = snapshot.rows.iter().filter(|row| matches!(row.key, PendingJournalKey::Conversation(_))).collect::<Vec<_>>();
    assert_eq!(conversation_rows.len(), 3);
    assert!(conversation_rows.iter().all(|row| row.head_revision == conv_head.revision && row.edit_seq == rev(2)));
    assert_eq!(conversation_rows[0].slot, PendingJournalSlot::Conversation(conv.value.pending.clone().unwrap()));
    for (row, original) in conversation_rows.iter().skip(1).zip(&conv.value.revocations) {
        assert_eq!(row.slot, PendingJournalSlot::Revocation(original.clone()));
        assert_eq!(row.slot.action_id(), original.request.action_id);
        let command: WorkPlanCommand = original.request.command.into();
        assert!(matches!(command, WorkPlanCommand::Pause | WorkPlanCommand::Stop));
    }
    assert_eq!(store.read_conversation(&conv.key).unwrap(), conv_head);
    assert_eq!(store.read(&write.key).unwrap(), head);
    let returned = serde_json::to_string(&snapshot.rows).unwrap();
    assert!(returned.contains("Original A") && returned.contains("Original message A"));
    assert!(!returned.contains("Newer unrelated B") && !returned.contains("Newer message B"));
}

#[test]
fn snapshot_limits_never_turn_an_unscanned_tail_into_complete_zero() {
    let (_directory, store, write) = setup();
    store.write(&write).unwrap();
    let mut conv = conversation(write.key.project_id);
    conv.value.revocations.push(ConversationDraftRevocation { request: WorkPlanRevocationOriginal {
        project_id: write.key.project_id, plan_id: ExecutionId::new(), action_id: ExecutionId::new(),
        expected_generation: rev(1), command: WorkPlanRevocationCommand::TakeOver }, submitted_seq: rev(2) });
    store.write_conversation(&conv).unwrap();
    for (limits, reason, known) in [
        (SnapshotLimits { heads: 0, ..SnapshotLimits::default() }, PendingSnapshotLimit::Heads, 0),
        (SnapshotLimits { heads: 1, ..SnapshotLimits::default() }, PendingSnapshotLimit::Heads, 1),
        (SnapshotLimits { bytes: 1, ..SnapshotLimits::default() }, PendingSnapshotLimit::Bytes, 0),
        (SnapshotLimits { actions: 2, ..SnapshotLimits::default() }, PendingSnapshotLimit::Actions, 2),
    ] {
        let snapshot = store.pending_snapshot_with_limits(write.key.project_id, None, limits).unwrap();
        assert!(!snapshot.complete);
        assert_eq!(snapshot.limit, Some(reason));
        assert_eq!(snapshot.rows.len(), known);
    }
    let full = store.pending_snapshot(write.key.project_id, None).unwrap();
    assert!(full.complete);
    assert_eq!(full.rows.len(), 3);
}

#[test]
fn pending_snapshot_rejects_summary_payload_disagreement_instead_of_hiding_it() {
    let (_directory, store, write) = setup();
    store.write(&write).unwrap();
    let connection = Connection::open(store.directory.join(DATABASE)).unwrap();
    connection.execute("UPDATE draft_heads SET has_pending=0 WHERE project_id=?1",
        [write.key.project_id.to_string()]).unwrap();
    drop(connection);
    assert_eq!(store.pending_snapshot(write.key.project_id, None).unwrap_err().code, ErrorCode::CorruptLedger);
    assert!(store.pending_snapshot(ExecutionId::new(), None).unwrap().complete);
    assert_eq!(disk_format(&store), FORMAT);
}
