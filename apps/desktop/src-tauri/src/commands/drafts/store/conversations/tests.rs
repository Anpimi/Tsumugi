use super::*;
use tsumugi_core::application::{AppendProjectConversationMessage, CreateProjectConversation};

fn rev(value: u64) -> Revision {
    Revision::new(value).unwrap()
}
fn setup() -> (tempfile::TempDir, DraftStore, ConversationDraftWrite) {
    let directory = tempfile::tempdir().unwrap();
    let store = DraftStore::at(directory.path().join("drafts")).unwrap();
    let write = ConversationDraftWrite {
        key: ConversationDraftKey {
            project_id: ExecutionId::new(),
            conversation_id: ExecutionId::new(),
        },
        expected_revision: rev(0),
        writer_id: ExecutionId::new(),
        value: ConversationDraftValue {
            text: "  A e\u{301} 👩🏽‍💻 {{name}}  ".into(),
            edit_seq: rev(1),
            message_edit_seq: None,
            pending: None,
            proposal_edits: vec![],
        },
    };
    (directory, store, write)
}
fn pending(write: &ConversationDraftWrite) -> ConversationDraftPending {
    ConversationDraftPending::Append {
        request: AppendProjectConversationMessage {
            project_id: write.key.project_id,
            conversation_id: write.key.conversation_id,
            action_id: ExecutionId::new(),
            message_id: ExecutionId::new(),
            body: write.value.text.clone(),
        },
        submitted_seq: write.value.edit_seq,
    }
}

#[test]
fn conversation_draft_reads_do_not_create_and_pending_identity_survives_newer_input() {
    let (_directory, store, mut write) = setup();
    assert_eq!(
        store.read_conversation(&write.key).unwrap().revision,
        rev(0)
    );
    assert!(
        store
            .list_conversations(write.key.project_id, None, 100)
            .unwrap()
            .items
            .is_empty()
    );
    assert!(!store.directory.exists());
    write.value.pending = Some(pending(&write));
    let first = store.write_conversation(&write).unwrap();
    assert_eq!(store.write_conversation(&write).unwrap(), first);
    let original = write.value.pending.clone().unwrap();
    let mut newer = write.clone();
    newer.expected_revision = first.revision;
    newer.value.text = "New B kept during A".into();
    newer.value.edit_seq = rev(2);
    let second = store.write_conversation(&newer).unwrap();
    let reopened = DraftStore::at(store.directory.clone()).unwrap();
    assert_eq!(reopened.read_conversation(&write.key).unwrap(), second);
    let mut discard = newer.clone();
    discard.expected_revision = second.revision;
    discard.value.edit_seq = rev(3);
    discard.value.pending = None;
    assert_eq!(
        store.write_conversation(&discard).unwrap_err().stage,
        "drafts-pending"
    );
    assert_eq!(
        store
            .clear_conversation(&ConversationDraftClear {
                key: write.key.clone(),
                expected_revision: second.revision
            })
            .unwrap_err()
            .stage,
        "drafts-pending"
    );
    let mut changed = newer.clone();
    changed.expected_revision = second.revision;
    changed.value.edit_seq = rev(3);
    changed.value.pending = Some(pending(&changed));
    assert_eq!(
        store.write_conversation(&changed).unwrap_err().stage,
        "drafts-pending"
    );
    let resolved = ConversationDraftResolve {
        write: discard,
        pending: original,
    };
    let settled = store.resolve_conversation(&resolved).unwrap();
    assert_eq!(settled.value.as_ref().unwrap().text, newer.value.text);
    assert!(settled.value.as_ref().unwrap().pending.is_none());
    assert_eq!(
        store.resolve_conversation(&resolved).unwrap(),
        settled,
        "lost resolve ACK uses the same original writer/value"
    );
    assert_eq!(
        store.write_conversation(&newer).unwrap_err().stage,
        "drafts-revision"
    );
}

#[test]
fn conversation_pending_checks_scope_body_sequence_and_rejects_credentials() {
    let (_directory, store, mut write) = setup();
    write.value.pending = Some(pending(&write));
    let mut wrong = write.clone();
    if let Some(ConversationDraftPending::Append { request, .. }) = &mut wrong.value.pending {
        request.conversation_id = ExecutionId::new();
    }
    assert!(store.write_conversation(&wrong).is_err());
    wrong = write.clone();
    wrong.value.text.push('!');
    assert!(store.write_conversation(&wrong).is_err());
    wrong = write.clone();
    if let Some(ConversationDraftPending::Append { submitted_seq, .. }) = &mut wrong.value.pending {
        *submitted_seq = rev(2);
    }
    assert!(store.write_conversation(&wrong).is_err());
    let mut json = serde_json::to_value(&write).unwrap();
    json["value"]["pending"]["request"]["sessionToken"] = serde_json::json!("not-allowed");
    assert!(serde_json::from_value::<ConversationDraftWrite>(json).is_err());
    let create = ConversationDraftPending::Create {
        request: CreateProjectConversation {
            project_id: write.key.project_id,
            conversation_id: write.key.conversation_id,
            action_id: ExecutionId::new(),
            title: None,
        },
        submitted_seq: rev(1),
    };
    write.value.pending = Some(create);
    assert_eq!(
        store.write_conversation(&write).unwrap().value,
        Some(write.value)
    );
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
            basis: DraftBasis {
                source_revision_id: ExecutionId::new(),
                selection_id: None,
                revision_id: None,
                text: None,
            },
            text: "Retained translation".into(),
            edit_seq: rev(1),
            pending: None,
            merge: None,
        },
    }
}
fn legacy(store: &DraftStore, format: i64) {
    let c = Connection::open(store.directory.join(DATABASE)).unwrap();
    c.execute_batch("DROP TABLE conversation_draft_heads")
        .unwrap();
    c.pragma_update(None, "user_version", format).unwrap();
}

#[test]
fn formats_one_and_two_upgrade_only_with_success_and_keep_translation_heads() {
    for format in [LEGACY_FORMAT, MERGE_FORMAT] {
        let (_directory, store, write) = setup();
        let old = translation(write.key.project_id);
        let head = store.write(&old).unwrap();
        let tombstone = DraftKey {
            unit_id: ExecutionId::new(),
            ..old.key.clone()
        };
        let cleared = store
            .clear(&DraftClear {
                key: tombstone.clone(),
                expected_revision: rev(0),
            })
            .unwrap();
        legacy(&store, format);
        let path = store.directory.join(DATABASE);
        let before = fs::read(&path).unwrap();
        assert!(store.read_conversation(&write.key).unwrap().value.is_none());
        assert!(
            store
                .list_conversations(write.key.project_id, None, 100)
                .unwrap()
                .items
                .is_empty()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        let mut invalid = write.clone();
        invalid.expected_revision = rev(9);
        assert!(store.write_conversation(&invalid).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let blocker = Connection::open(&path).unwrap();
        blocker
            .execute_batch("BEGIN; SELECT * FROM draft_heads;")
            .unwrap();
        assert_eq!(
            store.write_conversation(&write).unwrap_err().code,
            ErrorCode::OutcomeUnknown
        );
        blocker.execute_batch("ROLLBACK").unwrap();
        assert_eq!(store.read(&old.key).unwrap(), head);
        assert_eq!(store.read(&tombstone).unwrap(), cleared);
        assert_eq!(
            blocker
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            format
        );
        store.write_conversation(&write).unwrap();
        assert_eq!(
            blocker
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            FORMAT
        );
        assert_eq!(store.read(&old.key).unwrap(), head);
        assert_eq!(store.read(&tombstone).unwrap(), cleared);
        let mut next = old.clone();
        next.expected_revision = head.revision;
        next.value.text = "Translation still writable".into();
        next.value.edit_seq = rev(2);
        store.write(&next).unwrap();
        assert_eq!(
            store.read_conversation(&write.key).unwrap().value,
            Some(write.value)
        );
    }
}

#[test]
fn shared_quotas_count_both_domains_and_tombstone_pages_keep_the_cursor() {
    let (_directory, mut store, mut write) = setup();
    write.key.conversation_id = ExecutionId::parse("ffffffff-ffff-4fff-8fff-ffffffffffff").unwrap();
    let old = translation(write.key.project_id);
    store.write(&old).unwrap();
    store.limits.project_records = 2;
    store.write_conversation(&write).unwrap();
    let mut extra = write.clone();
    extra.key.conversation_id = ExecutionId::new();
    assert_eq!(
        store.write_conversation(&extra).unwrap_err().stage,
        "drafts-capacity"
    );
    let mut other = old.clone();
    other.key.unit_id = ExecutionId::new();
    assert_eq!(store.write(&other).unwrap_err().stage, "drafts-capacity");
    store.limits.project_records = 10;
    write.key.conversation_id = ExecutionId::parse("00000000-0000-4000-8000-000000000001").unwrap();
    let cleared = store
        .clear_conversation(&ConversationDraftClear {
            key: write.key.clone(),
            expected_revision: rev(0),
        })
        .unwrap();
    let page = store
        .list_conversations(write.key.project_id, None, 1)
        .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(page.next, Some(write.key.clone()));
    let more = store
        .list_conversations(write.key.project_id, page.next.as_ref(), 100)
        .unwrap();
    assert_eq!(more.items.len(), 1);
    assert_eq!(
        store.write_conversation(&write).unwrap_err().stage,
        "drafts-revision"
    );
    assert_eq!(store.read_conversation(&write.key).unwrap(), cleared);
    let c = Connection::open(store.directory.join(DATABASE)).unwrap();
    c.execute(
        "UPDATE conversation_draft_heads SET has_pending=1 WHERE conversation_id=?1",
        [more.items[0].key.conversation_id.to_string()],
    )
    .unwrap();
    assert!(
        store
            .list_conversations(write.key.project_id, None, 100)
            .is_err()
    );
}

#[test]
fn corrupt_legacy_input_is_preserved_and_blocks_upgrade() {
    let (_directory, store, write) = setup();
    let old = translation(write.key.project_id);
    store.write(&old).unwrap();
    legacy(&store, MERGE_FORMAT);
    let path = store.directory.join(DATABASE);
    let c = Connection::open(&path).unwrap();
    c.execute("UPDATE draft_heads SET payload=?1", [b"{}".as_slice()])
        .unwrap();
    drop(c);
    let before = fs::read(&path).unwrap();
    assert_eq!(
        store.write_conversation(&write).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn interrupted_format_upgrades_preserve_original_pending_and_new_head_atomically() {
    for format in [LEGACY_FORMAT, MERGE_FORMAT] {
        for stage in [
            "conversation-upgrade-before-ddl",
            "conversation-upgrade-after-ddl",
            "write-before-commit",
            "write-after-commit",
        ] {
            let (directory, store, write) = setup();
            let mut old = translation(write.key.project_id);
            old.value.pending = Some(DraftPending::Save {
                request: tsumugi_core::SaveTranslationRevision {
                    project_id: old.key.project_id,
                    action_id: ExecutionId::new(),
                    unit_id: old.key.unit_id,
                    locale: old.key.locale.clone(),
                    source_revision_id: old.value.basis.source_revision_id,
                    expected_selection_id: None,
                    text: old.value.text.clone(),
                },
                submitted_seq: old.value.edit_seq,
            });
            let first = store.write(&old).unwrap();
            legacy(&store, format);
            let mut next = old.clone();
            next.expected_revision = first.revision;
            next.value.text = "Newer B retained with original A".into();
            next.value.edit_seq = rev(2);
            super::super::tests::crash_child(directory.path(), &store, &next, stage);
            let recovered = store.read(&old.key).unwrap();
            if stage == "write-after-commit" {
                assert_eq!(recovered.value, Some(next.value));
            } else {
                assert_eq!(recovered, first);
            }
            let c = Connection::open(store.directory.join(DATABASE)).unwrap();
            assert_eq!(
                c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                    .unwrap(),
                if stage == "write-after-commit" {
                    FORMAT
                } else {
                    format
                }
            );
            assert!(store.read_conversation(&write.key).unwrap().value.is_none());
        }
    }
}

fn format_three(store: &DraftStore) {
    let c = Connection::open(store.directory.join(DATABASE)).unwrap();
    c.execute_batch("BEGIN IMMEDIATE; ALTER TABLE conversation_draft_heads RENAME TO conversation_draft_fixture_new").unwrap();
    c.execute_batch(LEGACY_HEAD_SQL).unwrap();
    c.execute_batch("INSERT INTO conversation_draft_heads SELECT * FROM conversation_draft_fixture_new; DROP TABLE conversation_draft_fixture_new; PRAGMA user_version=3; COMMIT").unwrap();
}

fn format_four(store: &DraftStore) {
    Connection::open(store.directory.join(DATABASE))
        .unwrap()
        .pragma_update(None, "user_version", ACTION_FORMAT)
        .unwrap();
}

fn proposal_draft(seq: u64) -> ConversationProposalDraft {
    ConversationProposalDraft {
        proposal_id: ExecutionId::new(),
        expected_revision_id: ExecutionId::new(),
        edit_seq: rev(seq),
        content: ConversationPlanningModelOutput::Proposal {
            summary: String::new(),
            unit_ids: vec![],
            options: tsumugi_core::application::PlanOptions::default(),
            questions: vec![],
        },
    }
}

fn revision_pending(write: &ConversationDraftWrite) -> ConversationDraftPending {
    let draft = &write.value.proposal_edits[0];
    ConversationDraftPending::ProposalRevision {
        request: tsumugi_core::application::ReviseConversationProposal {
            project_id: write.key.project_id,
            conversation_id: write.key.conversation_id,
            action_id: ExecutionId::new(),
            proposal_id: draft.proposal_id,
            revision_id: ExecutionId::new(),
            expected_revision_id: draft.expected_revision_id,
            content: draft.content.clone(),
        },
        submitted_seq: draft.edit_seq,
    }
}

#[test]
fn proposal_edits_do_not_advance_message_identity_or_allow_forged_append_text() {
    let (_directory, store, mut write) = setup();
    write.value.pending = Some(pending(&write));
    let first = store.write_conversation(&write).unwrap();
    let original = write.value.pending.clone().unwrap();
    let mut proposal_only = write.clone();
    proposal_only.expected_revision = first.revision;
    proposal_only.value.edit_seq = rev(2);
    proposal_only.value.message_edit_seq = Some(rev(1));
    proposal_only.value.proposal_edits = vec![proposal_draft(2)];
    let mut wrong = proposal_only.clone();
    wrong.value.text = "Forged text at the original message sequence".into();
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-message"
    );
    wrong = proposal_only.clone();
    let Some(ConversationDraftPending::Append { request, .. }) = &mut wrong.value.pending else {
        unreachable!()
    };
    request.body = "Forged frozen message body".into();
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-message"
    );
    wrong = proposal_only.clone();
    wrong.value.message_edit_seq = Some(rev(3));
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-message-sequence"
    );
    wrong.value.message_edit_seq = Some(rev(0));
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-message"
    );
    let second = store.write_conversation(&proposal_only).unwrap();
    let mut resolve = ConversationDraftResolve {
        write: proposal_only,
        pending: original,
    };
    resolve.write.expected_revision = second.revision;
    resolve.write.value.edit_seq = rev(3);
    resolve.write.value.pending = None;
    resolve.write.value.text.clear();
    assert_eq!(
        store.resolve_conversation(&resolve).unwrap_err().stage,
        "conversation-drafts-message"
    );
    resolve.write.value.message_edit_seq = Some(rev(3));
    let settled = store.resolve_conversation(&resolve).unwrap();
    assert_eq!(settled.value, Some(resolve.write.value.clone()));
    assert!(settled.value.as_ref().unwrap().text.is_empty());
    assert_eq!(
        settled.value.as_ref().unwrap().proposal_edits,
        second.value.unwrap().proposal_edits
    );
}

#[test]
fn newer_message_sequence_preserves_b_and_edit_back_to_a_through_append_receipt() {
    for change_back in [false, true] {
        let (_directory, store, mut write) = setup();
        write.value.message_edit_seq = Some(rev(1));
        write.value.pending = Some(pending(&write));
        let first = store.write_conversation(&write).unwrap();
        let original = write.value.pending.clone().unwrap();
        let mut newer = write.clone();
        newer.expected_revision = first.revision;
        newer.value.edit_seq = rev(2);
        newer.value.message_edit_seq = Some(rev(2));
        newer.value.text = "Newer message B".into();
        let mut current = store.write_conversation(&newer).unwrap();
        if change_back {
            newer.expected_revision = current.revision;
            newer.value.edit_seq = rev(3);
            newer.value.message_edit_seq = Some(rev(3));
            newer.value.text = write.value.text.clone();
            current = store.write_conversation(&newer).unwrap();
        }
        newer.expected_revision = current.revision;
        newer.value.edit_seq = rev(4);
        newer.value.proposal_edits = vec![proposal_draft(4)];
        let with_proposal = store.write_conversation(&newer).unwrap();
        let mut resolve = ConversationDraftResolve {
            write: newer,
            pending: original,
        };
        resolve.write.expected_revision = with_proposal.revision;
        resolve.write.value.edit_seq = rev(5);
        resolve.write.value.pending = None;
        let settled = store.resolve_conversation(&resolve).unwrap();
        assert_eq!(settled.value, Some(resolve.write.value.clone()));
        assert_eq!(
            settled.value.as_ref().unwrap().message_edit_seq,
            Some(rev(if change_back { 3 } else { 2 }))
        );
        assert_eq!(store.resolve_conversation(&resolve).unwrap(), settled);
    }
}

#[test]
fn proposal_drafts_keep_unfinished_multiple_inputs_and_enforce_structural_identity() {
    let (_directory, store, mut write) = setup();
    let mut draft = proposal_draft(1);
    if let ConversationPlanningModelOutput::Proposal {
        options, questions, ..
    } = &mut draft.content
    {
        options.stages.clear();
        questions.push(" ".into());
        questions.push("unfinished".repeat(8000));
    }
    write.value.proposal_edits = vec![draft, proposal_draft(1)];
    let original_text = write.value.text.clone();
    let first = store.write_conversation(&write).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), first);
    assert_eq!(first.value.as_ref().unwrap().text, original_text);
    assert_eq!(store.write_conversation(&write).unwrap(), first);
    let mut next = write.clone();
    next.expected_revision = first.revision;
    next.value.edit_seq = rev(2);
    next.value.proposal_edits[0].edit_seq = rev(2);
    next.value.proposal_edits[0].content = proposal_draft(2).content;
    let mut wrong = next.clone();
    wrong.value.proposal_edits[1].proposal_id = wrong.value.proposal_edits[0].proposal_id;
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-proposal"
    );
    wrong = next.clone();
    wrong.value.proposal_edits[0].edit_seq = rev(3);
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-proposal"
    );
    wrong = next.clone();
    wrong.value.proposal_edits[0].content = ConversationPlanningModelOutput::Reply {
        summary: "Reply input is not editable as a proposal".into(),
        questions: vec![],
    };
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-proposal"
    );
    wrong = next.clone();
    wrong.expected_revision = rev(0);
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "drafts-revision"
    );
    wrong = next.clone();
    wrong.value.edit_seq = rev(1);
    wrong.value.proposal_edits[0].edit_seq = rev(1);
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "drafts-edit-sequence"
    );
    let second = store.write_conversation(&next).unwrap();
    assert_eq!(second.value, Some(next.value.clone()));
    assert_eq!(
        DraftStore::at(store.directory.clone())
            .unwrap()
            .read_conversation(&write.key)
            .unwrap(),
        second
    );
    let mut too_large = next;
    too_large.expected_revision = second.revision;
    too_large.value.edit_seq = rev(3);
    if let ConversationPlanningModelOutput::Proposal { summary, .. } =
        &mut too_large.value.proposal_edits[0].content
    {
        *summary = "x".repeat(MAX_CONVERSATION_DRAFT_RECORD_BYTES);
    }
    assert_eq!(
        store.write_conversation(&too_large).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(store.read_conversation(&write.key).unwrap(), second);
}

#[test]
fn proposal_pending_matches_submitted_edit_and_retains_newer_edits_on_resolve() {
    let (_directory, store, mut write) = setup();
    write.value.proposal_edits = vec![proposal_draft(1), proposal_draft(1)];
    write.value.pending = Some(revision_pending(&write));
    let mut wrong = write.clone();
    wrong.value.proposal_edits[0].expected_revision_id = ExecutionId::new();
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-proposal-pending"
    );
    wrong = write.clone();
    if let ConversationPlanningModelOutput::Proposal { summary, .. } =
        &mut wrong.value.proposal_edits[0].content
    {
        *summary = "Changed after freezing without a new edit sequence".into();
    }
    assert_eq!(
        store.write_conversation(&wrong).unwrap_err().stage,
        "conversation-drafts-proposal-pending"
    );
    let first = store.write_conversation(&write).unwrap();
    let original = write.value.pending.clone().unwrap();
    let ConversationDraftPending::ProposalRevision { request, .. } = &original else {
        unreachable!()
    };
    let acknowledged_revision = request.revision_id;
    let mut newer = write.clone();
    newer.expected_revision = first.revision;
    newer.value.edit_seq = rev(2);
    newer.value.proposal_edits[0].edit_seq = rev(2);
    if let ConversationPlanningModelOutput::Proposal { summary, .. } =
        &mut newer.value.proposal_edits[0].content
    {
        *summary = "Newer B retained while A is pending".into();
    }
    let second = store.write_conversation(&newer).unwrap();
    let mut resolve = ConversationDraftResolve {
        write: newer,
        pending: original,
    };
    resolve.write.expected_revision = second.revision;
    resolve.write.value.edit_seq = rev(3);
    resolve.write.value.pending = None;
    resolve.write.value.proposal_edits[0].expected_revision_id = acknowledged_revision;
    assert_eq!(
        store.write_conversation(&resolve.write).unwrap_err().stage,
        "drafts-pending"
    );
    let settled = store.resolve_conversation(&resolve).unwrap();
    assert_eq!(settled.value, Some(resolve.write.value.clone()));
    assert_eq!(settled.value.as_ref().unwrap().text, write.value.text);
    assert_eq!(
        settled.value.as_ref().unwrap().proposal_edits[1],
        write.value.proposal_edits[1]
    );
    assert_eq!(store.resolve_conversation(&resolve).unwrap(), settled);
    assert_eq!(
        store.write_conversation(&write).unwrap_err().stage,
        "drafts-revision"
    );
}

#[test]
fn format_four_read_and_ack_upgrade_preserve_payload_bytes_and_both_domains() {
    let (_directory, store, mut write) = setup();
    write.value.proposal_edits = vec![proposal_draft(1)];
    write.value.pending = Some(revision_pending(&write));
    write.value.proposal_edits.clear();
    let first = store.write_conversation(&write).unwrap();
    let old = translation(write.key.project_id);
    let translated = store.write(&old).unwrap();
    format_four(&store);
    let path = store.directory.join(DATABASE);
    let bytes = fs::read(&path).unwrap();
    let c = Connection::open(&path).unwrap();
    let payloads = || {
        c.prepare("SELECT payload FROM conversation_draft_heads UNION ALL SELECT payload FROM draft_heads").unwrap().query_map([], |row| row.get::<_, Vec<u8>>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
    };
    let original = payloads();
    assert!(original.iter().all(|payload| {
        let json = String::from_utf8_lossy(payload);
        !json.contains("proposalEdits") && !json.contains("messageEditSeq")
    }));
    let value = first.value.as_ref().unwrap();
    assert!(value.proposal_edits.is_empty() && value.message_edit_seq.is_none());
    assert_eq!(store.read_conversation(&write.key).unwrap(), first);
    assert_eq!(store.read(&old.key).unwrap(), translated);
    assert_eq!(
        store
            .list_conversations(write.key.project_id, None, 50)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let mut invalid = write.clone();
    invalid.expected_revision = rev(9);
    assert!(store.write_conversation(&invalid).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(store.write_conversation(&write).unwrap(), first);
    assert_eq!(payloads(), original);
    assert_eq!(store.read(&old.key).unwrap(), translated);
    assert_eq!(
        c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        FORMAT
    );
}

#[test]
fn format_four_upgrade_is_atomic_without_rebuilding_existing_tables() {
    for stage in [
        "conversation-upgrade-before-ddl",
        "conversation-upgrade-after-ddl",
        "write-before-commit",
        "write-after-commit",
    ] {
        let (directory, store, mut write) = setup();
        write.value.pending = Some(pending(&write));
        let conversation = store.write_conversation(&write).unwrap();
        let old = translation(write.key.project_id);
        let first = store.write(&old).unwrap();
        format_four(&store);
        let mut next = old.clone();
        next.expected_revision = first.revision;
        next.value.text = "New translation retained alongside original pending".into();
        next.value.edit_seq = rev(2);
        super::super::tests::crash_child(directory.path(), &store, &next, stage);
        assert_eq!(store.read_conversation(&write.key).unwrap(), conversation);
        assert_eq!(
            store.read(&old.key).unwrap().value,
            if stage == "write-after-commit" {
                Some(next.value)
            } else {
                first.value
            }
        );
        assert_eq!(
            Connection::open(store.directory.join(DATABASE))
                .unwrap()
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            if stage == "write-after-commit" {
                FORMAT
            } else {
                ACTION_FORMAT
            }
        );
    }
}

#[test]
fn older_formats_reject_new_input_fields_before_any_write() {
    for format in [CONVERSATION_FORMAT, ACTION_FORMAT] {
        for proposal in [true, false] {
            let (_directory, store, mut write) = setup();
            let mut head = store.write_conversation(&write).unwrap();
            if format == CONVERSATION_FORMAT {
                format_three(&store);
            } else {
                format_four(&store);
            }
            if proposal {
                head.value.as_mut().unwrap().proposal_edits = vec![proposal_draft(1)];
            } else {
                head.value.as_mut().unwrap().message_edit_seq = Some(rev(1));
            }
            let path = store.directory.join(DATABASE);
            let c = Connection::open(&path).unwrap();
            c.execute(
                "UPDATE conversation_draft_heads SET payload=?1",
                [serde_json::to_vec(&head).unwrap()],
            )
            .unwrap();
            drop(c);
            let bytes = fs::read(&path).unwrap();
            assert_eq!(
                store.read_conversation(&write.key).unwrap_err().code,
                ErrorCode::CorruptLedger
            );
            assert_eq!(
                store
                    .list_conversations(write.key.project_id, None, 50)
                    .unwrap_err()
                    .code,
                ErrorCode::CorruptLedger
            );
            assert_eq!(
                store
                    .write(&translation(write.key.project_id))
                    .unwrap_err()
                    .code,
                ErrorCode::CorruptLedger
            );
            write.expected_revision = rev(1);
            write.value.edit_seq = rev(2);
            assert_eq!(
                store.write_conversation(&write).unwrap_err().code,
                ErrorCode::CorruptLedger
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
}

#[test]
fn format_three_reads_do_not_upgrade_and_write_preserves_both_domains_and_pending() {
    let (_directory, store, mut write) = setup();
    write.value.pending = Some(pending(&write));
    let first = store.write_conversation(&write).unwrap();
    let translation = translation(write.key.project_id);
    let translated = store.write(&translation).unwrap();
    format_three(&store);
    let path = store.directory.join(DATABASE);
    let before = fs::read(&path).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), first);
    assert_eq!(
        store
            .list_conversations(write.key.project_id, None, 50)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    // Even an exact acknowledgement retry upgrades atomically and keeps old bytes.
    assert_eq!(store.write_conversation(&write).unwrap(), first);
    assert_eq!(store.read(&translation.key).unwrap(), translated);
    assert_eq!(store.read_conversation(&write.key).unwrap(), first);
    assert_eq!(
        Connection::open(path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        FORMAT
    );
}

#[test]
fn format_three_rebuild_is_atomic_at_rename_copy_and_commit_boundaries() {
    for stage in [
        "conversation-upgrade-after-rename",
        "conversation-upgrade-after-copy",
        "write-before-commit",
        "write-after-commit",
    ] {
        let (directory, store, mut write) = setup();
        write.value.pending = Some(pending(&write));
        let conversation = store.write_conversation(&write).unwrap();
        let old = translation(write.key.project_id);
        let first = store.write(&old).unwrap();
        format_three(&store);
        let mut next = old.clone();
        next.expected_revision = first.revision;
        next.value.text = "New translation input alongside retained conversation".into();
        next.value.edit_seq = rev(2);
        super::super::tests::crash_child(directory.path(), &store, &next, stage);
        assert_eq!(store.read_conversation(&write.key).unwrap(), conversation);
        let restored = store.read(&old.key).unwrap();
        assert_eq!(
            restored.value,
            if stage == "write-after-commit" {
                Some(next.value)
            } else {
                first.value
            }
        );
        let c = Connection::open(store.directory.join(DATABASE)).unwrap();
        assert_eq!(
            c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            if stage == "write-after-commit" {
                FORMAT
            } else {
                CONVERSATION_FORMAT
            }
        );
    }
}

#[test]
fn large_formal_confirmation_keeps_the_complete_request_and_original_translation_limit() {
    use tsumugi_core::{
        application::{
            AuthorizeConversationProposalWorkPlan, AutomationEffect, ConversationProposalRef,
        },
        execution::{ApplicationScopeBasis, UnsignedDecimal},
    };
    let (_directory, store, mut write) = setup();
    let request = AuthorizeConversationProposalWorkPlan {
        action_id: ExecutionId::new(),
        proposal: ConversationProposalRef {
            project_id: write.key.project_id,
            conversation_id: write.key.conversation_id,
            proposal_id: ExecutionId::new(),
            revision_id: ExecutionId::new(),
        },
        plan_id: ExecutionId::new(),
        plan_digest: "a".repeat(64),
        confirmed: true,
        effects: vec![AutomationEffect::SaveCandidate],
        expires_at: UnsignedDecimal::from(1u64),
        checker_executions: vec![],
        tool_execution: true,
        application_tool_executions: (0..5000)
            .map(|_| ApplicationScopeBasis {
                instance_id: ExecutionId::new(),
                activation_generation: 1,
            })
            .collect(),
    };
    let original = serde_json::to_vec(&request).unwrap();
    assert!(original.len() > MAX_DRAFT_RECORD_BYTES);
    write.value.pending = Some(ConversationDraftPending::ProposalWorkPlan {
        request: request.clone(),
        submitted_seq: write.value.edit_seq,
    });
    let saved = store.write_conversation(&write).unwrap();
    format_four(&store);
    let path = store.directory.join(DATABASE);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), saved);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(store.write_conversation(&write).unwrap(), saved);
    assert_eq!(
        Connection::open(&path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        FORMAT
    );
    let mut oversized = write.clone();
    let Some(ConversationDraftPending::ProposalWorkPlan { request, .. }) =
        &mut oversized.value.pending
    else {
        unreachable!()
    };
    let basis = ApplicationScopeBasis {
        instance_id: ExecutionId::new(),
        activation_generation: 1,
    };
    let count =
        tsumugi_core::execution::MAX_INPUT_BYTES / serde_json::to_vec(&basis).unwrap().len() + 1;
    request.application_tool_executions.resize(count, basis);
    assert!(serde_json::to_vec(request).unwrap().len() > tsumugi_core::execution::MAX_INPUT_BYTES);
    assert_eq!(
        store.write_conversation(&oversized).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(store.read_conversation(&write.key).unwrap(), saved);
    let Some(ConversationDraftPending::ProposalWorkPlan {
        request: recovered, ..
    }) = saved.value.unwrap().pending
    else {
        panic!("confirmation identity lost")
    };
    assert_eq!(serde_json::to_vec(&recovered).unwrap(), original);
    let mut translation = translation(write.key.project_id);
    translation.value.text = "x".repeat(MAX_DRAFT_RECORD_BYTES);
    assert_eq!(
        store.write(&translation).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    let mut changed = write.clone();
    changed.expected_revision = rev(1);
    changed.value.edit_seq = rev(2);
    changed.value.pending = None;
    assert_eq!(
        store.write_conversation(&changed).unwrap_err().stage,
        "drafts-pending"
    );
}

#[test]
fn format_three_rejects_new_action_payloads_without_rewriting_either_domain() {
    let (_directory, store, mut write) = setup();
    write.value.pending = Some(pending(&write));
    let mut head = store.write_conversation(&write).unwrap();
    format_three(&store);
    let action = ExecutionId::new();
    let injected = serde_json::json!({"kind":"planning","preparationId":ExecutionId::new(),"submittedSeq":"1","request":{"projectId":write.key.project_id,"conversationId":write.key.conversation_id,"consent":{"actionId":action,"attemptId":action,"taskId":ExecutionId::new(),"previewDigest":"a".repeat(64),"expiresAtMs":"1","shareMessages":true,"shareUnits":false}}});
    head.value.as_mut().unwrap().pending = Some(serde_json::from_value(injected).unwrap());
    let path = store.directory.join(DATABASE);
    let c = Connection::open(&path).unwrap();
    c.execute(
        "UPDATE conversation_draft_heads SET payload=?1",
        [serde_json::to_vec(&head).unwrap()],
    )
    .unwrap();
    drop(c);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        store.read_conversation(&write.key).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(
        store
            .list_conversations(write.key.project_id, None, 50)
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(
        store
            .write(&translation(write.key.project_id))
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
