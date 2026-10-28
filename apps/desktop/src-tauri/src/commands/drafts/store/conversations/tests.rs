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
            pending: None,
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
