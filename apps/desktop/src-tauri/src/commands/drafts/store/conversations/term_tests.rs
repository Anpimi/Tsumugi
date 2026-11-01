use super::*;
use tsumugi_core::application::{ConversationTermEntry, ReviseConversationProposal};

fn rev(value: u64) -> Revision {
    Revision::new(value).unwrap()
}
fn setup() -> (tempfile::TempDir, DraftStore, ConversationDraftWrite) {
    let directory = tempfile::tempdir().unwrap();
    let store = DraftStore::at(directory.path().join("drafts")).unwrap();
    let key = ConversationDraftKey {
        project_id: ExecutionId::new(),
        conversation_id: ExecutionId::new(),
    };
    let write = ConversationDraftWrite {
        key,
        expected_revision: rev(0),
        writer_id: ExecutionId::new(),
        value: ConversationDraftValue {
            text: "Independent composer".into(),
            edit_seq: rev(1),
            message_edit_seq: None,
            pending: None,
            proposal_edits: vec![],
            revocations: vec![],
            team_drafts: vec![],
        },
    };
    (directory, store, write)
}
fn content(target: &str) -> ConversationPlanningModelOutput {
    ConversationPlanningModelOutput::TermProposal {
        summary: "Unfinished terminology".into(),
        questions: vec![],
        entries: vec![ConversationTermEntry {
            unit_id: ExecutionId::new(),
            source: "Synthetic source".into(),
            aliases: vec![],
            target: target.into(),
            protected: false,
            reason: "Human review".into(),
        }],
    }
}
fn term_write(write: &mut ConversationDraftWrite) {
    let draft = ConversationProposalDraft {
        proposal_id: ExecutionId::new(),
        expected_revision_id: ExecutionId::new(),
        edit_seq: rev(1),
        content: content("Submitted A"),
    };
    write.value.pending = Some(ConversationDraftPending::ProposalRevision {
        request: ReviseConversationProposal {
            project_id: write.key.project_id,
            conversation_id: write.key.conversation_id,
            action_id: ExecutionId::new(),
            proposal_id: draft.proposal_id,
            revision_id: ExecutionId::new(),
            expected_revision_id: draft.expected_revision_id,
            content: draft.content.clone(),
        },
        submitted_seq: rev(1),
    });
    write.value.proposal_edits.push(draft);
}
fn translation(project: ExecutionId) -> DraftWrite {
    DraftWrite {
        key: DraftKey {
            project_id: project,
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
        },
        expected_revision: rev(0),
        writer_id: ExecutionId::new(),
        value: DraftValue {
            reuse_origin: None,
            basis: DraftBasis {
                source_revision_id: ExecutionId::new(),
                selection_id: None,
                revision_id: None,
                text: None,
            },
            text: "Independent translation".into(),
            edit_seq: rev(1),
            pending: None,
            merge: None,
        },
    }
}
fn format(path: &std::path::Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}

#[test]
fn term_pending_a_and_newer_b_survive_reopen() {
    let (_directory, store, mut write) = setup();
    term_write(&mut write);
    let original = write.value.pending.clone();
    let first = store.write_conversation(&write).unwrap();
    write.expected_revision = first.revision;
    write.value.edit_seq = rev(2);
    write.value.proposal_edits[0].edit_seq = rev(2);
    if let ConversationPlanningModelOutput::TermProposal { entries, .. } =
        &mut write.value.proposal_edits[0].content
    {
        entries[0].target = "Newer B é 👩🏽‍💻".into();
    } else {
        unreachable!()
    }
    let newer = store.write_conversation(&write).unwrap();
    let reopened = DraftStore::at(store.directory.clone()).unwrap();
    assert_eq!(reopened.read_conversation(&write.key).unwrap(), newer);
    assert_eq!(newer.value.as_ref().unwrap().pending, original);
    assert_eq!(
        newer.value.as_ref().unwrap().proposal_edits,
        write.value.proposal_edits
    );
    assert_eq!(format(&store.directory.join(DATABASE)), 18);
}

#[test]
fn format_seventeen_reads_without_rewrite_and_upgrades_only_on_successful_write() {
    let (_directory, store, mut write) = setup();
    let original = store.write_conversation(&write).unwrap();
    let path = store.directory.join(DATABASE);
    set_legacy_format(&Connection::open(&path).unwrap(), 17).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), original);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    write.value.edit_seq = rev(2);
    write.value.text = "Newer B".into();
    assert_eq!(
        store.write_conversation(&write).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    assert_eq!(format(&path), 17);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    write.expected_revision = original.revision;
    term_write(&mut write);
    let updated = store.write_conversation(&write).unwrap();
    assert_eq!(format(&path), 18);
    assert_eq!(
        DraftStore::at(store.directory.clone())
            .unwrap()
            .read_conversation(&write.key)
            .unwrap(),
        updated
    );
}

#[test]
fn old_header_rejects_term_edits_and_pending_even_from_another_writer() {
    for editor in [false, true] {
        let (_directory, store, mut write) = setup();
        term_write(&mut write);
        if !editor {
            write.value.proposal_edits.clear();
        } else {
            write.value.pending = None;
        }
        store.write_conversation(&write).unwrap();
        let path = store.directory.join(DATABASE);
        set_legacy_format(&Connection::open(&path).unwrap(), 17).unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(
            store.read_conversation(&write.key).unwrap_err().code,
            ErrorCode::CorruptLedger
        );
        assert_eq!(
            store
                .write(&translation(write.key.project_id))
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
        assert_eq!(format(&path), 17);
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
