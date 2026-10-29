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
            revocations: vec![],
            proposal_edits: vec![],
            team_drafts: vec![],
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
        target: ConversationDraftResolveTarget::Pending { pending: original },
        disposition: ConversationDraftDisposition::Recorded,
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
        value: DraftValue { reuse_origin: None,
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
    set_legacy_format(&c,format).unwrap();
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
                request: tsumugi_core::SaveTranslationRevision { reuse_origin: None,
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
    c.execute_batch("DROP TABLE IF EXISTS source_draft_heads; DROP TABLE IF EXISTS resource_draft_heads; INSERT INTO conversation_draft_heads SELECT * FROM conversation_draft_fixture_new; DROP TABLE conversation_draft_fixture_new; PRAGMA user_version=3; COMMIT").unwrap();
}

fn format_four(store: &DraftStore) {
    set_legacy_format(&Connection::open(store.directory.join(DATABASE))
        .unwrap(),ACTION_FORMAT)
        .unwrap();
}

fn running_pending(write: &ConversationDraftWrite, control: bool) -> ConversationDraftPending {
    if control {
        ConversationDraftPending::WorkPlanControl {
            conversation_id: write.key.conversation_id,
            request: WorkPlanControlOriginal {
                project_id: write.key.project_id,
                plan_id: ExecutionId::new(),
                action_id: ExecutionId::new(),
                expected_generation: rev(1),
                command: tsumugi_core::application::WorkPlanCommand::Continue,
                confirmed: true,
                checker_executions: vec![],
                tool_execution: true,
                application_tool_executions: vec![tsumugi_core::execution::ApplicationScopeBasis {
                    instance_id: ExecutionId::new(),
                    activation_generation: 1,
                }],
                expires_at: Some(tsumugi_core::execution::UnsignedDecimal::from(42u64)),
            },
            submitted_seq: write.value.edit_seq,
        }
    } else {
        ConversationDraftPending::WorkPlanStart {
            conversation_id: write.key.conversation_id,
            request: WorkPlanStartOriginal {
                project_id: write.key.project_id,
                plan_id: ExecutionId::new(),
                action_id: ExecutionId::new(),
                expected_generation: rev(1),
            },
            expected_attempt_id: ExecutionId::new(),
            submitted_seq: write.value.edit_seq,
        }
    }
}

fn revocation(write: &ConversationDraftWrite, plan: ExecutionId) -> ConversationDraftRevocation {
    ConversationDraftRevocation {
        request: WorkPlanRevocationOriginal {
            project_id: write.key.project_id,
            plan_id: plan,
            action_id: ExecutionId::new(),
            expected_generation: rev(1),
            command: WorkPlanRevocationCommand::Stop,
        },
        submitted_seq: write.value.edit_seq,
    }
}

#[test]
fn revocation_slots_preserve_primary_other_slots_and_newer_input() {
    let (_directory, store, mut write) = setup();
    let plan = ExecutionId::new();
    write.value.pending = Some(pending(&write));
    write.value.proposal_edits = vec![proposal_draft(1)];
    write.value.message_edit_seq = Some(rev(1));
    let primary = write.value.pending.clone().unwrap();
    write.value.revocations = vec![revocation(&write, plan), revocation(&write, plan)];
    let original = write.value.revocations[0].clone();
    let first = store.write_conversation(&write).unwrap();
    assert_eq!(store.write_conversation(&write).unwrap(), first);
    write.expected_revision = first.revision;
    write.value.edit_seq = rev(2);
    write.value.message_edit_seq = Some(rev(2));
    write.value.text = "Newer B while both controls and the primary remain unknown".into();
    write.value.revocations.push(revocation(&write, plan));
    let second = store.write_conversation(&write).unwrap();
    assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read_conversation(&write.key).unwrap(), second);
    assert!(store.list_conversations(write.key.project_id, None, 10).unwrap().items[0].has_pending);

    let mut changed = write.clone();
    changed.expected_revision = second.revision;
    changed.value.edit_seq = rev(3);
    changed.value.revocations.remove(0);
    assert_eq!(store.write_conversation(&changed).unwrap_err().stage, "drafts-pending");
    let mut replaced = changed.clone();
    replaced.value.revocations = write.value.revocations.clone();
    replaced.value.revocations[0].request.command = WorkPlanRevocationCommand::Pause;
    assert_eq!(store.write_conversation(&replaced).unwrap_err().stage, "drafts-pending");
    assert_eq!(store.clear_conversation(&ConversationDraftClear {
        key: write.key.clone(), expected_revision: second.revision,
    }).unwrap_err().stage, "drafts-pending");

    let resolve = ConversationDraftResolve {
        write: changed,
        target: ConversationDraftResolveTarget::Revocation { revocation: original },
        disposition: ConversationDraftDisposition::Recorded,
    };
    for alter in 0..5 {
        let mut wrong = resolve.clone();
        match alter {
            0 => wrong.write.value.text.clear(),
            1 => wrong.write.value.proposal_edits.clear(),
            2 => wrong.write.value.pending = None,
            3 => wrong.write.value.revocations.reverse(),
            _ => {
                let ConversationDraftResolveTarget::Revocation { revocation } = &mut wrong.target else { unreachable!() };
                revocation.request.command = WorkPlanRevocationCommand::Pause;
            }
        }
        assert_eq!(store.resolve_conversation(&wrong).unwrap_err().stage, "drafts-pending");
    }
    let third = store.resolve_conversation(&resolve).unwrap();
    assert_eq!(store.resolve_conversation(&resolve).unwrap(), third);
    assert_eq!(third.value, Some(resolve.write.value.clone()));
    let mut primary_resolve = ConversationDraftResolve {
        write: ConversationDraftWrite {
            expected_revision: third.revision,
            value: third.value.clone().unwrap(),
            ..write.clone()
        },
        target: ConversationDraftResolveTarget::Pending { pending: primary },
        disposition: ConversationDraftDisposition::Recorded,
    };
    primary_resolve.write.value.edit_seq = rev(4);
    primary_resolve.write.value.pending = None;
    let mut discarded = primary_resolve.clone();
    discarded.write.value.revocations.clear();
    assert_eq!(store.resolve_conversation(&discarded).unwrap_err().stage, "drafts-pending");
    let fourth = store.resolve_conversation(&primary_resolve).unwrap();
    assert_eq!(fourth.value.as_ref().unwrap().text, write.value.text);
    assert_eq!(fourth.value.as_ref().unwrap().revocations, resolve.write.value.revocations);
    assert!(store.list_conversations(write.key.project_id, None, 10).unwrap().items[0].has_pending);
    assert_eq!(store.clear_conversation(&ConversationDraftClear {
        key: write.key.clone(), expected_revision: fourth.revision,
    }).unwrap_err().stage, "drafts-pending");
}

#[test]
fn revocation_slots_reject_duplicate_scope_authority_and_capacity() {
    let (_directory, store, mut write) = setup();
    let plan = ExecutionId::new();
    write.value.revocations = (0..32).map(|_| revocation(&write, plan)).collect();
    let mut invalid = write.clone();
    invalid.value.revocations.push(revocation(&write, plan));
    assert_eq!(store.write_conversation(&invalid).unwrap_err().code, ErrorCode::LimitExceeded);
    for alter in 0..5 {
        let mut invalid = write.clone();
        match alter {
            0 => invalid.value.revocations[1] = invalid.value.revocations[0].clone(),
            1 => invalid.value.revocations[0].request.project_id = ExecutionId::new(),
            2 => invalid.value.revocations[0].request.expected_generation = rev(0),
            3 => invalid.value.revocations[0].submitted_seq = rev(2),
            _ => {
                let primary = pending(&invalid);
                invalid.value.revocations[0].request.action_id = pending_action(&primary);
                invalid.value.pending = Some(primary);
            }
        }
        assert_eq!(store.write_conversation(&invalid).unwrap_err().code, ErrorCode::InvalidInput);
    }
    for field in ["sessionToken", "confirmed", "checkerExecutions", "toolExecution", "applicationToolExecutions", "expiresAt"] {
        let mut encoded = serde_json::to_value(&write).unwrap();
        encoded["value"]["revocations"][0]["request"][field] = serde_json::json!(true);
        assert!(serde_json::from_value::<ConversationDraftWrite>(encoded).is_err());
    }
    let mut encoded = serde_json::to_value(&write).unwrap();
    encoded["value"]["revocations"][0]["request"]["command"] = serde_json::json!("continue");
    assert!(serde_json::from_value::<ConversationDraftWrite>(encoded).is_err());
    let first = store.write_conversation(&write).unwrap();
    assert!(first.value.as_ref().unwrap().pending.is_none());
    assert!(store.list_conversations(write.key.project_id, None, 10).unwrap().items[0].has_pending);
    assert_eq!(store.clear_conversation(&ConversationDraftClear {
        key: write.key.clone(), expected_revision: first.revision,
    }).unwrap_err().stage, "drafts-pending");
}

#[test]
fn earlier_formats_reject_revocation_slots_without_writes() {
    let (_directory, store, mut write) = setup();
    write.value.revocations = vec![revocation(&write, ExecutionId::new())];
    store.write_conversation(&write).unwrap();
    let path = store.directory.join(DATABASE);
    for format in [ACTION_FORMAT, PROPOSAL_FORMAT, RUN_FORMAT] {
        set_legacy_format(&Connection::open(&path).unwrap(),format).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(store.list_conversations(write.key.project_id, None, 10).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(store.write(&translation(write.key.project_id)).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn running_original_requests_keep_scope_sticky_identity_and_newer_inputs() {
    for control in [false, true] {
        let (_directory, store, mut write) = setup();
        write.value.message_edit_seq = Some(rev(1));
        write.value.proposal_edits = vec![proposal_draft(1)];
        write.value.pending = Some(running_pending(&write, control));
        let mut wrong = write.clone();
        match wrong.value.pending.as_mut().unwrap() {
            ConversationDraftPending::WorkPlanStart {
                conversation_id, ..
            }
            | ConversationDraftPending::WorkPlanControl {
                conversation_id, ..
            } => *conversation_id = ExecutionId::new(),
            _ => unreachable!(),
        }
        assert_eq!(
            store.write_conversation(&wrong).unwrap_err().stage,
            "conversation-drafts-pending"
        );
        wrong = write.clone();
        match wrong.value.pending.as_mut().unwrap() {
            ConversationDraftPending::WorkPlanStart { submitted_seq, .. }
            | ConversationDraftPending::WorkPlanControl { submitted_seq, .. } => {
                *submitted_seq = rev(2)
            }
            _ => unreachable!(),
        }
        assert_eq!(
            store.write_conversation(&wrong).unwrap_err().stage,
            "conversation-drafts-pending"
        );
        let mut json = serde_json::to_value(&write).unwrap();
        json["value"]["pending"]["request"]["sessionToken"] = serde_json::json!("not-storable");
        assert!(serde_json::from_value::<ConversationDraftWrite>(json).is_err());
        let mut json = serde_json::to_value(&write).unwrap();
        json["value"]["pending"]["permit"] = serde_json::json!("not-storable");
        assert!(serde_json::from_value::<ConversationDraftWrite>(json).is_err());
        let first = store.write_conversation(&write).unwrap();
        assert_eq!(store.write_conversation(&write).unwrap(), first);
        assert_eq!(
            DraftStore::at(store.directory.clone())
                .unwrap()
                .read_conversation(&write.key)
                .unwrap(),
            first
        );
        let original = write.value.pending.clone().unwrap();
        let mut newer = write.clone();
        newer.expected_revision = first.revision;
        newer.value.edit_seq = rev(2);
        newer.value.message_edit_seq = Some(rev(2));
        newer.value.text = "Newer message B while the original run action is pending".into();
        let second = store.write_conversation(&newer).unwrap();
        newer.expected_revision = second.revision;
        newer.value.edit_seq = rev(3);
        let mut replaced = newer.clone();
        replaced.value.pending = Some(running_pending(&replaced, control));
        assert_eq!(
            store.write_conversation(&replaced).unwrap_err().stage,
            "drafts-pending"
        );
        newer.value.pending = None;
        assert_eq!(
            store.write_conversation(&newer).unwrap_err().stage,
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
        let resolve = ConversationDraftResolve {
            write: newer,
            target: ConversationDraftResolveTarget::Pending { pending: original },
            disposition: ConversationDraftDisposition::Recorded,
        };
        let settled = store.resolve_conversation(&resolve).unwrap();
        assert_eq!(settled.value, Some(resolve.write.value.clone()));
        assert_eq!(store.resolve_conversation(&resolve).unwrap(), settled);
        assert_eq!(
            store.write_conversation(&write).unwrap_err().stage,
            "drafts-revision"
        );
    }
}

#[test]
fn formats_four_to_six_read_without_writes_and_upgrade_without_rewriting_heads() {
    for (format, control) in [(ACTION_FORMAT, false), (PROPOSAL_FORMAT, false), (RUN_FORMAT, false), (RUN_FORMAT, true)] {
        let (_directory, store, mut write) = setup();
        if format == RUN_FORMAT {
            write.value.pending = Some(running_pending(&write, control));
        } else if format == PROPOSAL_FORMAT {
            write.value.proposal_edits = vec![proposal_draft(1)];
            write.value.message_edit_seq = Some(rev(1));
            write.value.pending = Some(revision_pending(&write));
        } else {
            write.value.pending = Some(pending(&write));
        }
        let first = store.write_conversation(&write).unwrap();
        let translation = translation(write.key.project_id);
        let translated = store.write(&translation).unwrap();
        let path = store.directory.join(DATABASE);
        let c = Connection::open(&path).unwrap();
        set_legacy_format(&c,format).unwrap();
        let payloads = || {
            c.prepare("SELECT payload FROM conversation_draft_heads UNION ALL SELECT payload FROM draft_heads").unwrap().query_map([], |row| row.get::<_, Vec<u8>>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        let roots = || {
            c.prepare("SELECT name,rootpage FROM sqlite_master WHERE type='table' ORDER BY name")
                .unwrap()
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        let original = payloads();
        let root_pages = roots();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap(), first);
        assert_eq!(
            store
                .list_conversations(write.key.project_id, None, 50)
                .unwrap()
                .items
                .len(),
            1
        );
        assert_eq!(store.read(&translation.key).unwrap(), translated);
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let mut invalid = write.clone();
        invalid.expected_revision = rev(9);
        assert!(store.write_conversation(&invalid).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(store.write_conversation(&write).unwrap(), first);
        assert_eq!(payloads(), original);
        let upgraded_roots = roots();
        assert_eq!(upgraded_roots.iter().filter(|(name, _)| root_pages.iter().any(|(original, _)| original == name)).cloned().collect::<Vec<_>>(), root_pages);
        assert_eq!(upgraded_roots.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
            ["conversation_draft_heads", "draft_heads", "resource_draft_heads", "source_draft_heads"]);
        assert_eq!(
            c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            FORMAT
        );
    }
}

#[test]
fn format_six_upgrade_abort_keeps_complete_original_or_committed_records() {
    for stage in [
        "conversation-upgrade-before-ddl",
        "conversation-upgrade-after-ddl",
        "write-before-commit",
        "write-after-commit",
    ] {
        let (directory, store, mut write) = setup();
        write.value.proposal_edits = vec![proposal_draft(1)];
        write.value.message_edit_seq = Some(rev(1));
        write.value.pending = Some(running_pending(&write, true));
        let conversation = store.write_conversation(&write).unwrap();
        let old = translation(write.key.project_id);
        let first = store.write(&old).unwrap();
        set_legacy_format(&Connection::open(store.directory.join(DATABASE))
            .unwrap(),RUN_FORMAT)
            .unwrap();
        let mut next = old.clone();
        next.expected_revision = first.revision;
        next.value.edit_seq = rev(2);
        next.value.text = "Translation alongside retained proposal input".into();
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
                RUN_FORMAT
            }
        );
    }
}

#[test]
fn older_formats_reject_running_requests_without_rewriting_the_journal() {
    for format in [CONVERSATION_FORMAT, ACTION_FORMAT, PROPOSAL_FORMAT] {
        for control in [false, true] {
            let (_directory, store, mut write) = setup();
            let mut head = store.write_conversation(&write).unwrap();
            if format == CONVERSATION_FORMAT {
                format_three(&store);
            }
            let path = store.directory.join(DATABASE);
            let c = Connection::open(&path).unwrap();
            set_legacy_format(&c,format).unwrap();
            head.value.as_mut().unwrap().pending = Some(running_pending(&write, control));
            c.execute(
                "UPDATE conversation_draft_heads SET payload=?1,has_pending=1",
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

#[test]
fn format_seven_reads_keep_revocations_and_upgrade_only_with_a_successful_write() {
    let (_directory, store, mut write) = setup();
    write.value.pending = Some(pending(&write));
    write.value.revocations.push(revocation(&write, ExecutionId::new()));
    let saved = store.write_conversation(&write).unwrap();
    let path = store.directory.join(DATABASE);
    set_legacy_format(&Connection::open(&path).unwrap(),REVOCATION_FORMAT).unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), saved);
    assert_eq!(fs::read(&path).unwrap(), before, "a pure read cannot upgrade an older journal");
    let mut newer = write.clone(); newer.value.edit_seq = rev(2); newer.value.text = "Newer B 👩🏽‍💻 {{name}}".into();
    assert_eq!(store.write_conversation(&newer).unwrap_err().code, ErrorCode::DependencyConflict);
    assert_eq!(fs::read(&path).unwrap(), before, "a rejected CAS leaves the original format intact");
    newer.expected_revision = saved.revision;
    let updated = store.write_conversation(&newer).unwrap();
    assert_eq!(updated.value.as_ref().unwrap().pending, write.value.pending);
    assert_eq!(updated.value.as_ref().unwrap().revocations, write.value.revocations);
    assert_eq!(updated.value.as_ref().unwrap().text, newer.value.text);
    assert_eq!(Connection::open(&path).unwrap().pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), FORMAT);
    assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read_conversation(&write.key).unwrap(), updated);
}

#[test]
fn unfinished_knowledge_edits_and_the_original_pending_survive_from_format_eight() {
    for keep_editor in [true, false] {
        let (_directory, store, mut write) = setup();
        let mut draft = proposal_draft(1);
        draft.content = ConversationPlanningModelOutput::KnowledgeProposal {
            summary: String::new(), questions: vec![String::new()], entries: vec![tsumugi_core::application::ConversationKnowledgeEntry {
                kind: tsumugi_core::ContextResourceKind::Character, name: String::new(), text: "Unfinished input é 👩🏽‍💻".into(), unit_ids: vec![],
            }],
        };
        write.value.pending = Some(ConversationDraftPending::ProposalRevision {
            request: tsumugi_core::application::ReviseConversationProposal {
                project_id: write.key.project_id, conversation_id: write.key.conversation_id, action_id: ExecutionId::new(),
                proposal_id: draft.proposal_id, revision_id: ExecutionId::new(), expected_revision_id: draft.expected_revision_id, content: draft.content.clone(),
            }, submitted_seq: rev(1),
        });
        if keep_editor { write.value.proposal_edits.push(draft); }
        let saved = store.write_conversation(&write).unwrap();
        assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read_conversation(&write.key).unwrap(), saved);
        let path = store.directory.join(DATABASE);
        set_legacy_format(&Connection::open(&path).unwrap(),REVOCATION_FORMAT).unwrap();
        let original = fs::read(&path).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(store.list_conversations(write.key.project_id, None, 50).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(fs::read(&path).unwrap(), original, "a mismatched record version is rejected without rewriting input");
    }
}

#[test]
fn format_eight_knowledge_requests_are_readable_and_upgrade_only_with_a_successful_write() {
    let (_directory, store, mut write) = setup();
    let mut draft = proposal_draft(1);
    draft.content = ConversationPlanningModelOutput::KnowledgeProposal {
        summary: String::new(), questions: vec![String::new()],
        entries: vec![tsumugi_core::application::ConversationKnowledgeEntry {
            kind: tsumugi_core::ContextResourceKind::Style, name: String::new(),
            text: "Unfinished knowledge é 👩🏽‍💻".into(), unit_ids: vec![],
        }],
    };
    write.value.pending = Some(ConversationDraftPending::ProposalRevision {
        request: tsumugi_core::application::ReviseConversationProposal {
            project_id: write.key.project_id, conversation_id: write.key.conversation_id,
            action_id: ExecutionId::new(), proposal_id: draft.proposal_id, revision_id: ExecutionId::new(),
            expected_revision_id: draft.expected_revision_id, content: draft.content.clone(),
        }, submitted_seq: rev(1),
    });
    write.value.proposal_edits.push(draft);
    let saved = store.write_conversation(&write).unwrap();
    let path = store.directory.join(DATABASE);
    set_legacy_format(&Connection::open(&path).unwrap(),KNOWLEDGE_PROPOSAL_FORMAT).unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(store.read_conversation(&write.key).unwrap(), saved);
    assert_eq!(fs::read(&path).unwrap(), before);
    write.value.edit_seq = rev(2); write.value.text = "Newer independent message B".into();
    assert_eq!(store.write_conversation(&write).unwrap_err().code, ErrorCode::DependencyConflict);
    assert_eq!(fs::read(&path).unwrap(), before);
    write.expected_revision = saved.revision;
    let upgraded = store.write_conversation(&write).unwrap();
    assert_eq!(upgraded.value.as_ref().unwrap().pending, write.value.pending);
    assert_eq!(upgraded.value.as_ref().unwrap().proposal_edits, write.value.proposal_edits);
    assert_eq!(upgraded.value.as_ref().unwrap().text, write.value.text);
    assert_eq!(Connection::open(&path).unwrap().pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), FORMAT);
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
        target: ConversationDraftResolveTarget::Pending { pending: original },
        disposition: ConversationDraftDisposition::Recorded,
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
            target: ConversationDraftResolveTarget::Pending { pending: original },
            disposition: ConversationDraftDisposition::Recorded,
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
        target: ConversationDraftResolveTarget::Pending { pending: original },
        disposition: ConversationDraftDisposition::Recorded,
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

fn team_pending_fixture(write: &mut ConversationDraftWrite, publication: bool) -> ConversationDraftPending {
    use tsumugi_core::application::{AutomationLease, PublishTeamDiscussion, SendHumanTeamMessage, TeamDiscussionKind, TeamDiscussionTarget};
    let plan_id = ExecutionId::new();
    let member_id = ExecutionId::new();
    let target = TeamDiscussionTarget { unit_id: ExecutionId::new(), locale: "zh-CN".into(),
        source_snapshot_id: ExecutionId::new(), source_revision_id: ExecutionId::new() };
    let body = "  Original A e\u{301} 👩🏽‍💻 {{name}}  ".to_string();
    let reply_to = Some(ExecutionId::new());
    write.value.team_drafts.push(ConversationTeamDraft { plan_id, plan_digest: "a".repeat(64), recovery: None, recovery_recorded: None,
        guidance: Some(ConversationTeamGuidanceDraft { edit_seq: rev(1), member_id: Some(member_id), unit_id: Some(target.unit_id),
            body: if publication { "Other unsent guidance".into() } else { body.clone() } }),
        publication: Some(ConversationTeamPublicationDraft { edit_seq: rev(1), unit_id: Some(target.unit_id), reply_to,
            body: if publication { body.clone() } else { "Other unsent discussion".into() } }) });
    let lease = AutomationLease { plan_id, generation: rev(2) };
    if publication {
        ConversationDraftPending::TeamPublication { conversation_id: write.key.conversation_id, target_name: "Captured entry {{name}} 中文".into(),
            request: TeamPublicationOriginal { project_id: write.key.project_id, lease,
                publication: PublishTeamDiscussion { post_id: ExecutionId::new(), target, kind: TeamDiscussionKind::Note,
                    body, references: vec![], reply_to, supersedes: None } }, submitted_seq: rev(1) }
    } else {
        ConversationDraftPending::TeamMessage { conversation_id: write.key.conversation_id, target_name: "Captured entry {{name}} 中文".into(),
            request: TeamMessageOriginal { project_id: write.key.project_id, lease,
                message: SendHumanTeamMessage { message_id: ExecutionId::new(), recipient_member_id: member_id,
                    expected_recipient_role_version_id: ExecutionId::new(), target, body } },
            destination: ConversationTeamDestination { name: "Captured member".into(), role: "Read the saved source".into(),
                endpoint: "http://127.0.0.1:9/v1/chat/completions".into(), model: "synthetic-destination".into() }, submitted_seq: rev(1) }
    }
}

#[test]
fn team_drafts_keep_incomplete_input_with_bounded_unique_plans_and_shared_quotas() {
    let (_directory, mut store, mut write) = setup();
    let _ = team_pending_fixture(&mut write, false);
    let draft = &mut write.value.team_drafts[0];
    draft.guidance.as_mut().unwrap().member_id = None;
    draft.guidance.as_mut().unwrap().unit_id = None;
    draft.guidance.as_mut().unwrap().body.clear();
    draft.publication.as_mut().unwrap().unit_id = None;
    draft.publication.as_mut().unwrap().body = "  ".into();
    let mut wrong = write.clone(); wrong.value.team_drafts.push(wrong.value.team_drafts[0].clone());
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::InvalidInput);
    wrong = write.clone(); wrong.value.team_drafts[0].guidance.as_mut().unwrap().edit_seq = rev(2);
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::InvalidInput);
    wrong = write.clone(); wrong.value.team_drafts[0].publication.as_mut().unwrap().edit_seq = rev(2);
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::InvalidInput);
    wrong = write.clone(); wrong.value.team_drafts[0].plan_digest = "invalid".into();
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::InvalidInput);
    wrong = write.clone(); wrong.value.team_drafts[0].guidance.as_mut().unwrap().body = "x".repeat(MAX_CONVERSATION_DRAFT_RECORD_BYTES);
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::LimitExceeded);
    let template = write.value.team_drafts[0].clone();
    write.value.team_drafts = (0..32).map(|_| ConversationTeamDraft { plan_id: ExecutionId::new(), ..template.clone() }).collect();
    write.value.team_drafts[0].publication.as_mut().unwrap().body = "x".repeat(8193);
    wrong = write.clone(); wrong.value.team_drafts.push(ConversationTeamDraft { plan_id: ExecutionId::new(), ..template });
    assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::LimitExceeded);
    let head = store.write_conversation(&write).unwrap();
    assert_eq!(head.value.as_ref().unwrap().team_drafts[0].publication.as_ref().unwrap().body.len(), 8193,
        "unfinished input may exceed the send limit and must remain editable");
    assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read_conversation(&write.key).unwrap(), head);
    store.limits.project_bytes = 1;
    write.expected_revision = head.revision; write.value.edit_seq = rev(2); write.value.text.push('B');
    assert_eq!(store.write_conversation(&write).unwrap_err().code, ErrorCode::LimitExceeded);
    assert_eq!(store.read_conversation(&write.key).unwrap(), head);
}

#[test]
fn team_pending_rejects_wrong_scope_same_sequence_input_and_restored_authority() {
    for publication in [false, true] {
        let (_directory, store, mut write) = setup();
        let original = team_pending_fixture(&mut write, publication); write.value.pending = Some(original.clone());
        let nested = if publication { "publication" } else { "message" };
        for field in ["body", "unit", "scope", "plan", "lease", "conversation", "recipient-or-reply"] {
            let mut encoded = serde_json::to_value(&write).unwrap();
            let pending = &mut encoded["value"]["pending"];
            match field {
                "body" => pending["request"][nested]["body"] = serde_json::json!("Different body at the same sequence"),
                "unit" => pending["request"][nested]["target"]["unitId"] = serde_json::json!(ExecutionId::new()),
                "scope" => pending["request"]["projectId"] = serde_json::json!(ExecutionId::new()),
                "plan" => pending["request"]["lease"]["planId"] = serde_json::json!(ExecutionId::new()),
                "lease" => pending["request"]["lease"]["generation"] = serde_json::json!("0"),
                "conversation" => pending["conversationId"] = serde_json::json!(ExecutionId::new()),
                _ if publication => pending["request"][nested]["replyTo"] = serde_json::json!(ExecutionId::new()),
                _ => pending["request"][nested]["recipientMemberId"] = serde_json::json!(ExecutionId::new()),
            }
            let wrong: ConversationDraftWrite = serde_json::from_value(encoded).unwrap();
            assert!(store.write_conversation(&wrong).is_err(), "{field}");
        }
        for field in ["sessionToken", "actor", "confirmed", "consent", "retryAllowed", "permit"] {
            let mut encoded = serde_json::to_value(&write).unwrap();
            encoded["value"]["pending"]["request"][field] = serde_json::json!(true);
            assert!(serde_json::from_value::<ConversationDraftWrite>(encoded).is_err(), "{field}");
            let mut encoded = serde_json::to_value(&write).unwrap();
            encoded["value"]["teamDrafts"][0][if publication { "publication" } else { "guidance" }][field] = serde_json::json!(true);
            assert!(serde_json::from_value::<ConversationDraftWrite>(encoded).is_err(), "{field}");
            if !publication {
                let mut encoded = serde_json::to_value(&write).unwrap(); encoded["value"]["pending"]["destination"][field] = serde_json::json!(true);
                assert!(serde_json::from_value::<ConversationDraftWrite>(encoded).is_err(), "{field}");
            }
        }
        if !publication {
            for (field, limit) in [("name", 128), ("endpoint", 2048), ("model", 128), ("role", 8192)] {
                let mut encoded = serde_json::to_value(&write).unwrap(); encoded["value"]["pending"]["destination"][field] = serde_json::json!("x".repeat(limit + 1));
                let wrong: ConversationDraftWrite = serde_json::from_value(encoded).unwrap();
                assert_eq!(store.write_conversation(&wrong).unwrap_err().code, ErrorCode::InvalidInput, "{field}");
            }
        }
        let mut wrong = write.clone(); wrong.value.team_drafts.clear();
        assert!(store.write_conversation(&wrong).is_err());
        let mut overlapping = revocation(&write, ExecutionId::new()); overlapping.request.action_id = pending_action(&original);
        wrong = write.clone(); wrong.value.revocations.push(overlapping);
        assert_eq!(store.write_conversation(&wrong).unwrap_err().stage, "conversation-drafts-revocations");
        let head = store.write_conversation(&write).unwrap();
        assert!(store.list_conversations(write.key.project_id, None, 10).unwrap().items[0].has_pending);
        let snapshot = store.pending_snapshot(write.key.project_id, None).unwrap();
        assert_eq!(snapshot.rows[0].slot.action_id(), pending_action(&original));
        assert_eq!(snapshot.rows[0].slot.submitted_seq(), rev(1));
        assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read_conversation(&write.key).unwrap(), head);
    }
}

#[test]
fn team_settlement_clears_only_recorded_a_and_retains_b_other_drafts_and_revocations() {
    for publication in [false, true] {
        for newer in [false, true] {
            for disposition in [ConversationDraftDisposition::Recorded, ConversationDraftDisposition::FencedNotApplied] {
                let (_directory, store, mut write) = setup();
                let original = team_pending_fixture(&mut write, publication); write.value.pending = Some(original.clone());
                write.value.message_edit_seq = Some(rev(1)); write.value.proposal_edits.push(proposal_draft(1));
                write.value.revocations.push(revocation(&write, ExecutionId::new()));
                let mut other = write.value.team_drafts[0].clone(); other.plan_id = ExecutionId::new(); write.value.team_drafts.push(other);
                let first = store.write_conversation(&write).unwrap();
                write.expected_revision = first.revision;
                if newer {
                    write.value.edit_seq = rev(2);
                    if publication { let input = write.value.team_drafts[0].publication.as_mut().unwrap(); input.body = "Newer discussion B".into(); input.edit_seq = rev(2); }
                    else { let input = write.value.team_drafts[0].guidance.as_mut().unwrap(); input.body = "Newer guidance B".into(); input.edit_seq = rev(2); }
                    write.expected_revision = store.write_conversation(&write).unwrap().revision;
                }
                let retained = write.value.clone();
                let mut resolved = write.clone(); resolved.value.pending = None; resolved.value.edit_seq = rev(3);
                if disposition == ConversationDraftDisposition::Recorded && !newer {
                    if publication { let input = resolved.value.team_drafts[0].publication.as_mut().unwrap(); input.body.clear(); input.edit_seq = rev(3); }
                    else { let input = resolved.value.team_drafts[0].guidance.as_mut().unwrap(); input.body.clear(); input.edit_seq = rev(3); }
                }
                let resolve = ConversationDraftResolve { write: resolved, target: ConversationDraftResolveTarget::Pending { pending: original }, disposition };
                let mut wrong = resolve.clone(); wrong.write.value.text = "Must not overwrite the other composer".into();
                assert_eq!(store.resolve_conversation(&wrong).unwrap_err().stage, "drafts-pending");
                if newer || disposition == ConversationDraftDisposition::FencedNotApplied {
                    let mut wrong = resolve.clone();
                    if publication { let input = wrong.write.value.team_drafts[0].publication.as_mut().unwrap(); input.body.clear(); input.edit_seq = rev(3); }
                    else { let input = wrong.write.value.team_drafts[0].guidance.as_mut().unwrap(); input.body.clear(); input.edit_seq = rev(3); }
                    assert_eq!(store.resolve_conversation(&wrong).unwrap_err().stage, "drafts-pending");
                }
                let settled = store.resolve_conversation(&resolve).unwrap();
                assert_eq!(settled.value, Some(resolve.write.value.clone()));
                assert_eq!(settled.value.as_ref().unwrap().revocations, retained.revocations);
                assert_eq!(store.resolve_conversation(&resolve).unwrap(), settled, "lost settlement ACK is idempotent");
                assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read_conversation(&write.key).unwrap(), settled);
            }
        }
    }
}

#[test]
fn team_settlement_preserves_the_implicit_composer_sequence() {
    for publication in [false, true] {
        for disposition in [ConversationDraftDisposition::Recorded, ConversationDraftDisposition::FencedNotApplied] {
            let (_directory, store, mut write) = setup();
            let pending = team_pending_fixture(&mut write, publication);
            write.value.pending = Some(pending.clone());
            write.value.message_edit_seq = None;
            let previous = write.value.edit_seq;
            write.expected_revision = store.write_conversation(&write).unwrap().revision;
            write.value.pending = None;
            write.value.edit_seq = rev(2);
            write.value.message_edit_seq = Some(previous);
            if disposition == ConversationDraftDisposition::Recorded {
                if publication {
                    let draft = write.value.team_drafts[0].publication.as_mut().unwrap();
                    draft.body.clear(); draft.edit_seq = rev(2);
                } else {
                    let draft = write.value.team_drafts[0].guidance.as_mut().unwrap();
                    draft.body.clear(); draft.edit_seq = rev(2);
                }
            }
            let resolve = ConversationDraftResolve { write, target: ConversationDraftResolveTarget::Pending { pending }, disposition };
            let mut changed = resolve.clone(); changed.write.value.message_edit_seq = Some(rev(2));
            assert_eq!(store.resolve_conversation(&changed).unwrap_err().stage, "drafts-pending");
            assert_eq!(store.resolve_conversation(&resolve).unwrap().value, Some(resolve.write.value));
        }
    }
}

#[test]
fn formats_eleven_and_twelve_upgrade_atomically_and_reject_team_data_under_old_headers() {
    for format in [SOURCE_FORMAT, SOURCE_ACTION_FORMAT] {
        let (_directory, store, mut write) = setup();
        let first = store.write_conversation(&write).unwrap();
        let saved_translation = translation(write.key.project_id); let translation_head = store.write(&saved_translation).unwrap();
        let path = store.directory.join(DATABASE); let c = Connection::open(&path).unwrap(); set_legacy_format(&c, format).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap(), first);
        assert_eq!(c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), format);
        let mut wrong = write.clone(); wrong.expected_revision = rev(99); assert!(store.write_conversation(&wrong).is_err());
        assert_eq!(c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), format);
        assert_eq!(store.write_conversation(&write).unwrap(), first, "same-value ACK retry upgrades in the transaction");
        assert_eq!(c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), FORMAT);
        assert_eq!(store.read(&saved_translation.key).unwrap(), translation_head);
        write.expected_revision = first.revision; write.value.edit_seq = rev(2); let _ = team_pending_fixture(&mut write, false);
        store.write_conversation(&write).unwrap();
        set_legacy_format(&c, format).unwrap();
        let before = fs::read(&path).unwrap();
        assert_eq!(store.read_conversation(&write.key).unwrap_err().code, ErrorCode::CorruptLedger);
        let mut later = saved_translation.clone(); later.expected_revision = translation_head.revision; later.value.edit_seq = rev(2); later.value.text.push('B');
        assert_eq!(store.write(&later).unwrap_err().code, ErrorCode::CorruptLedger);
        assert_eq!(c.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), format);
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
