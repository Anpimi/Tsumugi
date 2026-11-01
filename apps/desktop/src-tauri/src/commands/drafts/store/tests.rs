use super::*;
use std::{
    process::{Command, Stdio},
    sync::{Arc, Barrier},
};
use tsumugi_core::{SaveTranslationRevision, SelectTranslationRevision};

fn revision(value: u64) -> Revision {
    Revision::new(value).unwrap()
}

#[test]
fn reuse_origin_and_the_exact_pending_survive_newer_input_only_in_format_nine() {
    let (_directory, store, mut write) = setup();
    let origin = tsumugi_core::TranslationReuseOrigin {
        target_source_snapshot_id: ExecutionId::new(), target_unit_id: write.key.unit_id,
        target_source_revision_id: write.value.basis.source_revision_id, target_selection_id: None,
        donor_unit_id: ExecutionId::new(), donor_source_revision_id: ExecutionId::new(),
        donor_translation_revision_id: ExecutionId::new(), donor_basis: "a".repeat(64),
    };
    write.value.reuse_origin = Some(origin.clone());
    write.value.pending = Some(DraftPending::Save { request: SaveTranslationRevision {
        project_id: write.key.project_id, action_id: ExecutionId::new(), unit_id: write.key.unit_id,
        locale: write.key.locale.clone(), source_revision_id: write.value.basis.source_revision_id,
        expected_selection_id: None, text: write.value.text.clone(), reuse_origin: Some(origin.clone()),
    }, submitted_seq: write.value.edit_seq });
    let first = store.write(&write).unwrap();
    let mut newer = write.clone(); newer.expected_revision = first.revision;
    newer.value.edit_seq = revision(2); newer.value.text = "New B {{name}} é 👩🏽‍💻".into();
    let saved = store.write(&newer).unwrap();
    let path = store.directory.join(DATABASE);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(DraftStore::at(store.directory.clone()).unwrap().read(&write.key).unwrap(), saved);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(saved.value.as_ref().unwrap().pending, write.value.pending);
    assert_eq!(saved.value.as_ref().unwrap().reuse_origin, Some(origin));
    let mut wrong = newer.clone(); wrong.expected_revision = saved.revision; wrong.value.edit_seq = revision(3);
    wrong.value.reuse_origin.as_mut().unwrap().target_unit_id = ExecutionId::new();
    assert_eq!(store.write(&wrong).unwrap_err().code, ErrorCode::InvalidInput);
    assert_eq!(store.read(&write.key).unwrap(), saved);
    set_legacy_format(&Connection::open(&path).unwrap(),KNOWLEDGE_PROPOSAL_FORMAT).unwrap();
    let old = fs::read(&path).unwrap();
    assert_eq!(store.read(&write.key).unwrap_err().code, ErrorCode::CorruptLedger);
    assert_eq!(store.list(write.key.project_id, None, 100).unwrap_err().code, ErrorCode::CorruptLedger);
    assert_eq!(fs::read(&path).unwrap(), old);
}
fn setup() -> (tempfile::TempDir, DraftStore, DraftWrite) {
    let temp = tempfile::tempdir().unwrap();
    let store = DraftStore::at(temp.path().join("drafts")).unwrap();
    let request = DraftWrite {
        key: DraftKey {
            project_id: ExecutionId::new(),
            unit_id: ExecutionId::new(),
            locale: "zh-Hans".into(),
        },
        expected_revision: revision(0),
        writer_id: ExecutionId::new(),
        value: DraftValue { reuse_origin: None,
            basis: DraftBasis {
                source_revision_id: ExecutionId::new(),
                selection_id: None,
                revision_id: None,
                text: None,
            },
            text: "Unconfirmed A".into(),
            edit_seq: revision(1),
            pending: None,
            merge: None,
        },
    };
    (temp, store, request)
}
fn pending(request: &DraftWrite) -> DraftPending {
    DraftPending::Save {
        request: SaveTranslationRevision { reuse_origin: None,
            project_id: request.key.project_id,
            action_id: ExecutionId::new(),
            unit_id: request.key.unit_id,
            locale: request.key.locale.clone(),
            source_revision_id: request.value.basis.source_revision_id,
            expected_selection_id: request.value.basis.selection_id,
            text: request.value.text.clone(),
        },
        submitted_seq: request.value.edit_seq,
    }
}

#[test]
fn draft_read_many_keeps_v1_pending_tombstones_and_absent_heads_without_migration() {
    let (_directory,store,mut request) = setup();
    let missing = ExecutionId::new();
    let empty = store.read_many(request.key.project_id,&request.key.locale,&[request.key.unit_id,missing]).unwrap();
    assert!(empty.iter().all(|head| head.value.is_none() && head.revision == revision(0)));
    assert!(!store.directory.exists());
    request.value.pending = Some(pending(&request));
    let original = store.write(&request).unwrap();
    let mut tombstone = request.key.clone(); tombstone.unit_id = ExecutionId::new();
    let cleared = store.clear(&DraftClear { key:tombstone.clone(),expected_revision:revision(0) }).unwrap();
    let connection = Connection::open(store.directory.join(DATABASE)).unwrap();
    connection.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
    set_legacy_format(&connection,LEGACY_FORMAT).unwrap(); drop(connection);
    let heads = store.read_many(request.key.project_id,&request.key.locale,&[tombstone.unit_id,request.key.unit_id,missing]).unwrap();
    assert_eq!(heads[0],cleared); assert_eq!(heads[1],original); assert_eq!(heads[2],empty[1]);
    assert_eq!(disk_format(&store),LEGACY_FORMAT);
    assert!(store.read_many(request.key.project_id,&request.key.locale,&[missing,missing]).is_err());
    assert!(store.read_many(request.key.project_id,"ZH-hans",&[missing]).is_err());
    assert!(store.read_many(request.key.project_id,&request.key.locale,&[]).is_err());
    let mut stale = request.clone(); stale.expected_revision = revision(0);
    stale.value.text = "Changed input with a stale CAS".into(); stale.value.edit_seq = revision(2);
    assert!(store.write(&stale).is_err()); assert_eq!(disk_format(&store),LEGACY_FORMAT);
}
fn replace(request: &DraftWrite, head: &DraftHead, text: &str) -> DraftWrite {
    let mut next = request.clone();
    next.expected_revision = head.revision;
    next.value.text = text.into();
    next.value.edit_seq = head.value.as_ref().unwrap().edit_seq.next().unwrap();
    next
}

fn merge_origin() -> DraftMergeOrigin {
    DraftMergeOrigin {
        comparison_id: ExecutionId::new(),
        contributors: vec![ExecutionId::new(), ExecutionId::new()],
        expected_basis: "a".repeat(64),
    }
}
fn merge_pending(request: &DraftWrite) -> DraftPending {
    let origin = request.value.merge.as_ref().unwrap();
    DraftPending::Merge {
        request: SaveTranslationRevision { reuse_origin: None,
            project_id: request.key.project_id,
            action_id: ExecutionId::new(),
            unit_id: request.key.unit_id,
            locale: request.key.locale.clone(),
            source_revision_id: request.value.basis.source_revision_id,
            expected_selection_id: request.value.basis.selection_id,
            text: request.value.text.clone(),
        },
        merge: tsumugi_core::MergeBasis {
            contributors: origin.contributors.clone(),
            expected_basis: origin.expected_basis.clone(),
        },
        submitted_seq: request.value.edit_seq,
    }
}
fn disk_format(store: &DraftStore) -> i64 {
    Connection::open(store.directory.join(DATABASE))
        .unwrap()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

#[test]
fn merge_draft_and_original_pending_preserve_contributors_unicode_and_newer_input() {
    let (_temp, store, mut request) = setup();
    request.value.merge = Some(merge_origin());
    request.value.text = "Merge A {{name}}\r\ne\u{301} 👩🏽‍💻".into();
    request.value.pending = Some(merge_pending(&request));
    request.value.text = "Newer B <b>日本語</b>".into();
    request.value.edit_seq = revision(2);
    let saved = store.write(&request).unwrap();
    assert_eq!(disk_format(&store), FORMAT);
    let reopened = DraftStore::at(store.directory.clone()).unwrap();
    assert_eq!(reopened.read(&request.key).unwrap(), saved);
    assert_eq!(
        reopened.write(&request).unwrap(),
        saved,
        "the exact original journal write remains idempotent"
    );
    assert_eq!(
        reopened
            .list(request.key.project_id, None, 1)
            .unwrap()
            .items[0]
            .has_pending,
        true
    );
    assert_eq!(
        reopened
            .clear(&DraftClear {
                key: request.key.clone(),
                expected_revision: saved.revision
            })
            .unwrap_err()
            .stage,
        "drafts-pending"
    );
    let DraftPending::Merge {
        request: original,
        merge,
        submitted_seq,
    } = request.value.pending.as_ref().unwrap()
    else {
        panic!("expected merge")
    };
    assert_eq!(original.text, "Merge A {{name}}\r\ne\u{301} 👩🏽‍💻");
    assert_eq!(
        merge.contributors,
        request.value.merge.as_ref().unwrap().contributors
    );
    assert_eq!(*submitted_seq, revision(1));
    let mut empty = request.clone();
    empty.key.unit_id = ExecutionId::new();
    empty.value.pending = None;
    empty.value.text.clear();
    assert_eq!(store.write(&empty).unwrap().value.unwrap().text, "");
}

#[test]
fn merge_journal_rejects_lost_or_changed_origin_scope_sequence_and_same_seq_text() {
    let (_temp, store, mut request) = setup();
    request.value.merge = Some(merge_origin());
    request.value.pending = Some(merge_pending(&request));
    for kind in [
        "missing-origin",
        "duplicate",
        "one",
        "five",
        "basis",
        "contributors",
        "scope",
        "source",
        "selection",
        "sequence",
        "text",
        "save",
    ] {
        let mut wrong = request.clone();
        if kind == "missing-origin" {
            wrong.value.merge = None;
        }
        if kind == "save" {
            wrong.value.pending = Some(pending(&wrong));
        }
        if let Some(origin) = &mut wrong.value.merge {
            if kind == "duplicate" {
                origin.contributors[1] = origin.contributors[0];
            }
            if kind == "one" {
                origin.contributors.truncate(1);
            }
            if kind == "five" {
                origin
                    .contributors
                    .extend((0..3).map(|_| ExecutionId::new()));
            }
            if kind == "basis" {
                origin.expected_basis = "not-a-basis".into();
            }
            if kind == "contributors" {
                origin.contributors.reverse();
            }
        }
        if let Some(DraftPending::Merge {
            request: original,
            submitted_seq,
            ..
        }) = &mut wrong.value.pending
        {
            if kind == "scope" {
                original.unit_id = ExecutionId::new();
            }
            if kind == "source" {
                original.source_revision_id = ExecutionId::new();
            }
            if kind == "selection" {
                original.expected_selection_id = Some(ExecutionId::new());
            }
            if kind == "sequence" {
                *submitted_seq = revision(2);
            }
            if kind == "text" {
                original.text.push('X');
            }
        }
        assert_eq!(
            store.write(&wrong).unwrap_err().code,
            ErrorCode::InvalidInput,
            "{kind}"
        );
    }
    assert!(!store.directory.exists());
}

#[test]
fn legacy_draft_reads_and_failed_cas_do_not_upgrade_then_a_valid_write_keeps_all_old_heads() {
    let (_temp, store, mut request) = setup();
    request.value.pending = Some(pending(&request));
    let pending_head = store.write(&request).unwrap();
    let mut plain = request.clone();
    plain.key.unit_id = ExecutionId::new();
    plain.value.pending = None;
    let plain_head = store.write(&plain).unwrap();
    let mut selected = plain.clone();
    selected.key.unit_id = ExecutionId::new();
    selected.value.pending = Some(DraftPending::Selection {
        request: SelectTranslationRevision {
            project_id: selected.key.project_id,
            action_id: ExecutionId::new(),
            unit_id: selected.key.unit_id,
            locale: selected.key.locale.clone(),
            source_revision_id: selected.value.basis.source_revision_id,
            expected_selection_id: None,
            revision_id: ExecutionId::new(),
        },
        submitted_seq: selected.value.edit_seq,
        text: selected.value.text.clone(),
    });
    let selection_head = store.write(&selected).unwrap();
    let mut tombstone = request.key.clone();
    tombstone.unit_id = ExecutionId::new();
    let cleared = store
        .clear(&DraftClear {
            key: tombstone.clone(),
            expected_revision: revision(0),
        })
        .unwrap();
    let path = store.directory.join(DATABASE);
    let database = Connection::open(&path).unwrap();
    database.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
    set_legacy_format(&database,LEGACY_FORMAT)
        .unwrap();
    drop(database);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(store.read(&request.key).unwrap(), pending_head);
    assert_eq!(store.read(&tombstone).unwrap(), cleared);
    assert_eq!(
        store
            .list(request.key.project_id, None, 100)
            .unwrap()
            .items
            .len(),
        3
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes,
        "queries cannot rewrite legacy storage"
    );
    let mut stale = plain.clone();
    stale.value.text = "stale write".into();
    assert_eq!(store.write(&stale).unwrap_err().stage, "drafts-revision");
    assert_eq!(disk_format(&store), LEGACY_FORMAT);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let mut merged = request.clone();
    merged.key.unit_id = ExecutionId::new();
    merged.value.pending = None;
    merged.value.merge = Some(merge_origin());
    store.write(&merged).unwrap();
    assert_eq!(
        disk_format(&store),
        FORMAT,
        "old clients reject the new format before decoding payloads"
    );
    assert_eq!(store.read(&request.key).unwrap(), pending_head);
    assert_eq!(store.read(&plain.key).unwrap(), plain_head);
    assert_eq!(store.read(&selected.key).unwrap(), selection_head);
    assert_eq!(store.read(&tombstone).unwrap(), cleared);
}

#[test]
fn legacy_upgrade_is_rolled_back_with_a_commit_failure_and_new_shapes_are_not_valid_v1() {
    let (_temp, store, request) = setup();
    let head = store.write(&request).unwrap();
    let path = store.directory.join(DATABASE);
    let blocker = Connection::open(&path).unwrap();
    blocker.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
    set_legacy_format(&blocker,LEGACY_FORMAT)
        .unwrap();
    blocker
        .execute_batch("BEGIN; SELECT * FROM draft_heads;")
        .unwrap();
    let mut next = replace(&request, &head, "Merge after legacy");
    next.value.merge = Some(merge_origin());
    assert_eq!(
        store.write(&next).unwrap_err().code,
        ErrorCode::OutcomeUnknown
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(disk_format(&store), LEGACY_FORMAT);
    assert_eq!(store.read(&request.key).unwrap(), head);
    let merged = store.write(&next).unwrap();
    assert_eq!(disk_format(&store), FORMAT);
    blocker.execute_batch("DROP TABLE conversation_draft_heads").unwrap();
    set_legacy_format(&blocker,LEGACY_FORMAT)
        .unwrap();
    assert_eq!(
        store.read(&merged.key).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert_eq!(disk_format(&store), LEGACY_FORMAT);
}

#[test]
fn missing_reads_lists_and_invalid_first_writes_do_not_create_storage() {
    let (_temp, store, mut request) = setup();
    assert_eq!(store.read(&request.key).unwrap(), empty_head(&request.key));
    assert!(
        store
            .list(request.key.project_id, None, 100)
            .unwrap()
            .items
            .is_empty()
    );
    request.value.pending = Some(pending(&request));
    if let Some(DraftPending::Save { request, .. }) = &mut request.value.pending {
        request.project_id = ExecutionId::new();
    }
    assert_eq!(
        store.write(&request).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert!(!store.directory.exists());
}

#[test]
fn clearing_before_the_first_write_prevents_its_late_resurrection() {
    let (_temp, store, request) = setup();
    let cleared = store
        .clear(&DraftClear {
            key: request.key.clone(),
            expected_revision: revision(0),
        })
        .unwrap();
    assert_eq!(cleared.revision.get(), 1);
    assert!(cleared.value.is_none());
    assert_eq!(store.write(&request).unwrap_err().stage, "drafts-revision");
    assert_eq!(store.read(&request.key).unwrap(), cleared);
}

#[test]
fn newer_b_survives_old_a_acknowledgements_and_clear_requests() {
    let (_temp, store, request) = setup();
    let a = store.write(&request).unwrap();
    assert_eq!(store.write(&request).unwrap(), a);
    let newer = replace(&request, &a, "New B");
    let b = store.write(&newer).unwrap();
    assert_eq!(store.write(&request).unwrap_err().stage, "drafts-revision");
    assert_eq!(
        store
            .clear(&DraftClear {
                key: request.key.clone(),
                expected_revision: a.revision
            })
            .unwrap_err()
            .stage,
        "drafts-revision"
    );
    assert_eq!(store.read(&request.key).unwrap(), b);
    let cleared = store
        .clear(&DraftClear {
            key: request.key.clone(),
            expected_revision: b.revision,
        })
        .unwrap();
    assert!(cleared.value.is_none());
    assert_eq!(cleared.revision.get(), 3);
    assert!(store.write(&newer).is_err());
    assert_eq!(store.read(&request.key).unwrap(), cleared);
    assert!(
        store
            .list(request.key.project_id, None, 10)
            .unwrap()
            .items
            .is_empty()
    );
}

#[test]
fn pending_a_and_current_b_reopen_exactly_and_require_reconciliation_before_clear() {
    let (_temp, store, mut request) = setup();
    request.value.pending = Some(pending(&request));
    request.value.text = "B typed while A was pending".into();
    request.value.edit_seq = revision(2);
    let saved = store.write(&request).unwrap();
    let reopened = DraftStore::at(store.directory.clone()).unwrap();
    assert_eq!(reopened.read(&request.key).unwrap(), saved);
    assert_eq!(
        reopened
            .clear(&DraftClear {
                key: request.key.clone(),
                expected_revision: saved.revision
            })
            .unwrap_err()
            .stage,
        "drafts-pending"
    );
    // Resolving A changes the original basis/pending at the same editing seq.
    request.expected_revision = saved.revision;
    request.value.pending = None;
    request.value.basis.selection_id = Some(ExecutionId::new());
    request.value.basis.revision_id = Some(ExecutionId::new());
    request.value.basis.text = Some(String::new());
    let reconciled = reopened.write(&request).unwrap();
    assert_eq!(
        reconciled.value.as_ref().unwrap().text,
        "B typed while A was pending"
    );
    assert_eq!(
        reconciled.value.as_ref().unwrap().basis.text.as_deref(),
        Some("")
    );
    assert_eq!(reconciled.value.as_ref().unwrap().edit_seq.get(), 2);
    assert!(
        reopened
            .clear(&DraftClear {
                key: request.key.clone(),
                expected_revision: saved.revision
            })
            .is_err()
    );
    let mut selection = request.clone();
    selection.expected_revision = reconciled.revision;
    selection.value.text = String::new();
    selection.value.edit_seq = revision(3);
    selection.value.pending = Some(DraftPending::Selection {
        request: SelectTranslationRevision {
            project_id: request.key.project_id,
            action_id: ExecutionId::new(),
            unit_id: request.key.unit_id,
            locale: request.key.locale.clone(),
            source_revision_id: request.value.basis.source_revision_id,
            expected_selection_id: request.value.basis.selection_id,
            revision_id: ExecutionId::new(),
        },
        submitted_seq: revision(2),
        text: String::new(),
    });
    let selected = reopened.write(&selection).unwrap();
    assert_eq!(
        DraftStore::at(store.directory.clone())
            .unwrap()
            .read(&request.key)
            .unwrap(),
        selected
    );
}

#[test]
fn edit_sequence_is_local_to_the_writer_but_cas_always_protects_the_head() {
    let (_temp, store, mut request) = setup();
    request.value.edit_seq = revision(8);
    let a = store.write(&request).unwrap();
    request.expected_revision = a.revision;
    request.value.edit_seq = revision(7);
    assert_eq!(
        store.write(&request).unwrap_err().stage,
        "drafts-edit-sequence"
    );
    request.writer_id = ExecutionId::new();
    request.value.edit_seq = revision(1);
    assert_eq!(
        store.write(&request).unwrap().value.unwrap().edit_seq.get(),
        1
    );
}

#[test]
fn independent_store_instances_compete_without_merging_or_losing_a_winner() {
    let (_temp, store, request) = setup();
    let initial = store.write(&request).unwrap();
    let left = replace(&request, &initial, "left");
    let mut right = replace(&request, &initial, "right");
    right.writer_id = ExecutionId::new();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [left.clone(), right.clone()]
        .into_iter()
        .map(|request| {
            let store = DraftStore::at(store.directory.clone()).unwrap();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.write(&request)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let current = store.read(&request.key).unwrap();
    let loser = if current.value.as_ref().unwrap().text == "left" {
        &right
    } else {
        &left
    };
    assert_eq!(store.write(loser).unwrap_err().stage, "drafts-revision");
    assert_eq!(store.read(&request.key).unwrap(), current);
}

#[test]
fn racing_first_initialization_publishes_only_one_supported_database() {
    let (_temp, store, request) = setup();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let mut request = request.clone();
            request.writer_id = ExecutionId::new();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.write(&request)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(store.read(&request.key).unwrap().revision.get(), 1);
}

#[test]
fn summaries_paginate_by_locale_then_unit_without_input_or_tombstones() {
    let (_temp, store, request) = setup();
    let mut expected = Vec::new();
    for locale in ["zh-Hans", "fr", "de"] {
        for _ in 0..3 {
            let mut next = request.clone();
            next.key.locale = locale.into();
            next.key.unit_id = ExecutionId::new();
            store.write(&next).unwrap();
            expected.push(next.key);
        }
    }
    expected.sort_by(|a, b| (&a.locale, a.unit_id).cmp(&(&b.locale, b.unit_id)));
    let first = store.list(request.key.project_id, None, 4).unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|item| item.key.clone())
            .collect::<Vec<_>>(),
        expected[..4]
    );
    let second = store
        .list(request.key.project_id, first.next.as_ref(), 4)
        .unwrap();
    let third = store
        .list(request.key.project_id, second.next.as_ref(), 4)
        .unwrap();
    assert_eq!(third.items[0].key, expected[8]);
    assert!(third.next.is_none());
    assert!(
        !serde_json::to_string(&first)
            .unwrap()
            .contains(&request.value.text)
    );
    assert!(store.list(request.key.project_id, None, 0).is_err());
    assert!(store.list(request.key.project_id, None, 101).is_err());
    let mut foreign = expected[0].clone();
    foreign.project_id = ExecutionId::new();
    assert!(
        store
            .list(request.key.project_id, Some(&foreign), 1)
            .is_err()
    );
}

#[test]
fn byte_and_record_quotas_include_tombstones_and_never_evict_inputs() {
    let (_temp, mut store, request) = setup();
    let current = store.write(&request).unwrap();
    let current_bytes = encode(&current).unwrap().len();
    store.limits.project_bytes = current_bytes;
    let larger = replace(&request, &current, &"B".repeat(1024));
    assert_eq!(store.write(&larger).unwrap_err().stage, "drafts-capacity");
    store.limits = Limits::default();
    store.limits.total_bytes = current_bytes;
    assert_eq!(store.write(&larger).unwrap_err().stage, "drafts-capacity");
    store.limits = Limits::default();
    store.limits.project_records = 1;
    let cleared = store
        .clear(&DraftClear {
            key: request.key.clone(),
            expected_revision: current.revision,
        })
        .unwrap();
    let mut another = request.clone();
    another.key.unit_id = ExecutionId::new();
    assert_eq!(store.write(&another).unwrap_err().stage, "drafts-capacity");
    store.limits = Limits::default();
    store.limits.total_records = 1;
    another.key.project_id = ExecutionId::new();
    assert_eq!(store.write(&another).unwrap_err().stage, "drafts-capacity");
    assert_eq!(store.read(&request.key).unwrap(), cleared);
    store.limits = Limits::default();
    let mut oversized = request.clone();
    oversized.expected_revision = cleared.revision;
    oversized.value.text = "x".repeat(MAX_DRAFT_RECORD_BYTES);
    assert_eq!(
        store.write(&oversized).unwrap_err().stage,
        "drafts-record-size"
    );
    assert_eq!(store.read(&request.key).unwrap(), cleared);
}

#[test]
fn a_real_sqlite_commit_lock_failure_preserves_the_previous_committed_head() {
    let (_temp, store, request) = setup();
    let current = store.write(&request).unwrap();
    let blocker = Connection::open(store.directory.join(DATABASE)).unwrap();
    blocker
        .execute_batch("BEGIN; SELECT * FROM draft_heads;")
        .unwrap();
    let failure = store
        .write(&replace(&request, &current, "not committed"))
        .unwrap_err();
    assert_eq!(failure.stage, "drafts-commit");
    assert_eq!(failure.code, ErrorCode::OutcomeUnknown);
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(store.read(&request.key).unwrap(), current);
}

#[test]
fn a_real_sqlite_full_failure_preserves_the_previous_committed_head() {
    struct ResetPageLimit;
    impl Drop for ResetPageLimit {
        fn drop(&mut self) {
            SQLITE_PAGE_LIMIT.with(|limit| limit.set(false));
        }
    }
    let (_temp, store, request) = setup();
    let current = store.write(&request).unwrap();
    let larger = replace(&request, &current, &"B".repeat(128 * 1024));
    SQLITE_PAGE_LIMIT.with(|limit| limit.set(true));
    let reset = ResetPageLimit;
    let failure = store.write(&larger).unwrap_err();
    assert_eq!(failure.stage, "drafts-storage");
    assert_eq!(failure.code, ErrorCode::StorageFailed);
    drop(reset);
    assert_eq!(store.read(&request.key).unwrap(), current);
}

#[test]
fn malformed_or_unknown_storage_is_preserved_without_recreation() {
    let (_temp, store, request) = setup();
    store.write(&request).unwrap();
    let path = store.directory.join(DATABASE);
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", 999).unwrap();
    drop(db);
    let unknown = fs::read(&path).unwrap();
    assert_eq!(
        store.read(&request.key).unwrap_err().stage,
        "drafts-schema-version"
    );
    assert!(store.write(&request).is_err());
    assert_eq!(fs::read(&path).unwrap(), unknown);
    fs::write(&path, b"unsupported synthetic database contents").unwrap();
    let corrupt = fs::read(&path).unwrap();
    assert_eq!(
        store.read(&request.key).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert!(store.write(&request).is_err());
    assert_eq!(fs::read(&path).unwrap(), corrupt);
}

#[test]
fn canonical_payload_and_summary_metadata_disagreement_are_rejected() {
    let (_temp, store, request) = setup();
    store.write(&request).unwrap();
    let db = Connection::open(store.directory.join(DATABASE)).unwrap();
    db.execute("UPDATE draft_heads SET revision=9", []).unwrap();
    assert_eq!(
        store.read(&request.key).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
}

#[test]
fn list_rejects_pending_payloads_hidden_by_corrupt_summary_columns() {
    for update in [
        "UPDATE draft_heads SET has_pending=0",
        "UPDATE draft_heads SET edit_seq=NULL,source_revision_id=NULL,has_pending=0",
    ] {
        let (_temp, store, mut request) = setup();
        request.value.pending = Some(pending(&request));
        store.write(&request).unwrap();
        let db = Connection::open(store.directory.join(DATABASE)).unwrap();
        db.execute(update, []).unwrap();
        assert_eq!(
            store
                .list(request.key.project_id, None, 10)
                .unwrap_err()
                .code,
            ErrorCode::CorruptLedger
        );
        assert_eq!(
            store.read(&request.key).unwrap_err().code,
            ErrorCode::CorruptLedger
        );
        assert_eq!(
            store.write(&request).unwrap_err().code,
            ErrorCode::CorruptLedger
        );
    }
}

#[test]
fn list_continues_after_empty_tombstone_pages_until_the_pending_head() {
    let (_temp, store, request) = setup();
    for locale in ["de", "en", "fr"] {
        let mut next = request.clone();
        next.key.locale = locale.into();
        if locale == "fr" {
            next.value.pending = Some(pending(&next));
            store.write(&next).unwrap();
        } else {
            store
                .clear(&DraftClear {
                    key: next.key,
                    expected_revision: revision(0),
                })
                .unwrap();
        }
    }
    let first = store.list(request.key.project_id, None, 1).unwrap();
    assert!(first.items.is_empty());
    assert_eq!(first.next.as_ref().unwrap().locale, "de");
    let second = store
        .list(request.key.project_id, first.next.as_ref(), 1)
        .unwrap();
    assert!(second.items.is_empty());
    assert_eq!(second.next.as_ref().unwrap().locale, "en");
    let third = store
        .list(request.key.project_id, second.next.as_ref(), 1)
        .unwrap();
    assert_eq!(third.items.len(), 1);
    assert_eq!(third.items[0].key.locale, "fr");
    assert!(third.items[0].has_pending);
    assert!(third.next.is_none());
}

#[cfg(unix)]
#[test]
fn linked_roots_database_and_journal_files_are_rejected_on_reads_and_writes() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (temp, store, request) = setup();
    store.write(&request).unwrap();
    assert_eq!(
        fs::metadata(&store.directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.directory.join(DATABASE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    symlink(&store.directory, temp.path().join("alias")).unwrap();
    assert!(
        DraftStore::at(temp.path().join("alias"))
            .unwrap()
            .read(&request.key)
            .is_err()
    );
    let backup = temp.path().join("database-backup");
    fs::rename(store.directory.join(DATABASE), &backup).unwrap();
    symlink(&backup, store.directory.join(DATABASE)).unwrap();
    assert!(store.read(&request.key).is_err());
    assert!(store.write(&request).is_err());
    fs::remove_file(store.directory.join(DATABASE)).unwrap();
    fs::hard_link(&backup, store.directory.join(DATABASE)).unwrap();
    assert!(store.read(&request.key).is_err());
    assert!(store.write(&request).is_err());
    fs::remove_file(store.directory.join(DATABASE)).unwrap();
    fs::rename(&backup, store.directory.join(DATABASE)).unwrap();
    symlink(
        store.directory.join(DATABASE),
        store.directory.join(format!("{DATABASE}-journal")),
    )
    .unwrap();
    assert!(store.read(&request.key).is_err());
    assert!(store.write(&request).is_err());
}

#[test]
fn process_interruptions_leave_an_unpublished_initialization_or_the_committed_head() {
    for stage in [
        "initialize-before-commit",
        "initialize-after-commit",
        "initialize-before-publish",
        "initialize-after-publish",
    ] {
        let (temp, store, request) = setup();
        crash_child(temp.path(), &store, &request, stage);
        let read = store.read(&request.key).unwrap();
        if stage == "initialize-after-publish" {
            assert_eq!(read.value.as_ref(), Some(&request.value));
            assert_eq!(store.write(&request).unwrap(), read);
        } else {
            assert_eq!(read, empty_head(&request.key));
            assert!(!store.directory.join(DATABASE).exists());
            assert_eq!(
                store.write(&request).unwrap().value.as_ref(),
                Some(&request.value)
            );
        }
    }
}

#[test]
fn interrupted_existing_transactions_recover_old_or_new_input_with_original_pending() {
    for stage in ["write-before-commit", "write-after-commit"] {
        let (temp, store, request) = setup();
        let current = store.write(&request).unwrap();
        let mut next = replace(&request, &current, "B after A");
        next.value.pending = Some(pending(&request));
        crash_child(temp.path(), &store, &next, stage);
        if stage == "write-before-commit" {
            let journal = store.directory.join(format!("{DATABASE}-journal"));
            assert!(fs::metadata(&journal).unwrap().len() > 512);
            assert_eq!(store.read(&request.key).unwrap(), current);
            assert!(
                !journal.exists(),
                "existing-file read physically rolls back SQLite only"
            );
        } else {
            let recovered = store.read(&request.key).unwrap();
            assert_eq!(recovered.value.as_ref(), Some(&next.value));
            assert_eq!(store.write(&next).unwrap(), recovered);
        }
    }
}

#[test]
fn format_seventeen_cross_domain_upgrade_is_atomic_and_preserves_pending() {
    // Format 17 already had all five tables. Keep its DDL fixed rather than
    // downgrading the header of a database created by the current initializer.
    const SCHEMA: &[&str] = &[
        "CREATE TABLE draft_heads (project_id TEXT NOT NULL, locale TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, source_revision_id TEXT, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=262144), PRIMARY KEY(project_id,locale,unit_id), CHECK((edit_seq IS NULL AND source_revision_id IS NULL AND has_pending=0) OR (edit_seq>=0 AND source_revision_id IS NOT NULL)))",
        "CREATE TABLE conversation_draft_heads (project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=4456448), PRIMARY KEY(project_id,conversation_id), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))",
        "CREATE TABLE resource_draft_heads (project_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=4456448), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))",
        "CREATE TABLE source_draft_heads (project_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=8650752), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))",
        "CREATE TABLE strategy_draft_heads (project_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=4456448), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))",
    ];
    fn rows(connection: &Connection) -> Vec<(&'static str, Vec<(i64, Vec<u8>)>)> {
        ["draft_heads", "conversation_draft_heads", "resource_draft_heads", "source_draft_heads", "strategy_draft_heads"]
            .into_iter().map(|table| {
                let mut query = connection.prepare(&format!("SELECT rowid,payload FROM {table} ORDER BY rowid")).unwrap();
                let values = query.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
                    .collect::<std::result::Result<Vec<_>, _>>().unwrap();
                (table, values)
            }).collect()
    }
    for stage in ["conversation-upgrade-before-ddl", "conversation-upgrade-after-ddl", "write-before-commit", "write-after-commit"] {
        let (directory, store, mut translation) = setup();
        let project = translation.key.project_id;
        translation.value.pending = Some(pending(&translation));
        translation.value.text = "Newer translation B {{name}}\r\ne\u{301} 👩🏽‍💻".into();
        translation.value.edit_seq = revision(2);
        let translation_head = DraftHead { key: translation.key.clone(), revision: revision(2),
            writer_id: Some(translation.writer_id), value: Some(translation.value.clone()) };
        let mut tombstone = empty_head(&DraftKey { project_id: project, locale: translation.key.locale.clone(), unit_id: ExecutionId::new() });
        tombstone.revision = revision(4);
        let conversation_key = ConversationDraftKey { project_id: project, conversation_id: ExecutionId::new() };
        let conversation = ConversationDraftHead { key: conversation_key.clone(), revision: revision(3), writer_id: Some(ExecutionId::new()),
            value: Some(ConversationDraftValue { text: "Newer composer B e\u{301} 👩🏽‍💻".into(), edit_seq: revision(2), message_edit_seq: None,
                pending: Some(ConversationDraftPending::Append { request: tsumugi_core::application::AppendProjectConversationMessage {
                    project_id: project, conversation_id: conversation_key.conversation_id, action_id: ExecutionId::new(),
                    message_id: ExecutionId::new(), body: "Submitted composer A".into() }, submitted_seq: revision(1) }),
                proposal_edits: vec![], revocations: vec![], team_drafts: vec![] }) };
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/resourceDraftCommands.contract.json"))).unwrap();
        let mut resource_write: ResourceDraftWrite = serde_json::from_value(fixture["requests"]["write"]["write"].clone()).unwrap();
        resource_write.key.project_id = project;
        let capture = ExecutionId::new();
        resource_write.value.preview_capture_id = Some(capture);
        resource_write.value.proposal_edit_draft = Some(ResourceProposalEditDraft { capture_id: capture, entry_id: "term".into(), locale: "zh-CN".into(),
            expected_revision_id: None, source: "Original source".into(), current_target: None, original_target: "Original proposal".into(),
            target: "Newer proposal B e\u{301} 👩🏽‍💻".into(), edit_seq: revision(3) });
        resource_write.value.pending = Some(ResourceDraftPending::Decision { request: tsumugi_core::ResourceDecision {
            project_id: project, action_id: ExecutionId::new(), capture_id: capture, entry_id: "term".into(), expected_revision_id: None,
            decision: tsumugi_core::ResourceDecisionKind::Adopt, edited_target: Some("Submitted target A".into()) },
            locale: "zh-CN".into(), submitted_seq: revision(2) });
        let resource = ResourceDraftHead { key: resource_write.key.clone(), revision: revision(5), writer_id: Some(resource_write.writer_id),
            value: Some(resource_write.value.clone()) };
        let source = SourceDraftHead { key: SourceDraftKey { project_id: project }, revision: revision(6), writer_id: Some(ExecutionId::new()),
            value: Some(SourceDraftValue {
                edit_seq: revision(2), mapping_seq: revision(2), domain: "Newer source B e\u{301} 👩🏽‍💻".into(), source: None,
                source_language: "en-US".into(), declared: true, selection_label: None, updating: false,
                attempt_id: None, check_attempt_id: None, capture_request: None, check_prepare_request: None,
                comparison_ref: None, lineage: vec![], actor: "Synthetic editor".into(), filter: "Newer filter B".into(),
                applied_filter: String::new(), manual_ordinal: None, historical_query: String::new(), preview_after: 0,
                comparison_after: 0, historical_search: None, receipt_ref: None, picker_uncertain: false,
                hook: SourceDraftHook { locale: "zh-CN".into(), enabled_intent: true, source_action_id: None },
                pending: Some(SourceDraftPending::Capture { request: SourceDraftCaptureRequest { project_id: project,
                    selection_id: ExecutionId::new(), source_language: "en-US".into(), attempt_id: ExecutionId::new() },
                    submitted_seq: revision(1), submitted_mapping_seq: revision(1) }),
                hook_stop: None, correction: None,
            }) };
        let strategy = StrategyDraftHead { key: StrategyDraftKey { project_id: project }, revision: revision(7), writer_id: Some(ExecutionId::new()),
            value: Some(StrategyDraftValue {
                journal_seq: revision(4), edit_seq: revision(2), locale: "zh-CN".into(), correction_unit: String::new(),
                number_drafts: Default::default(), evidence: None, source_context: Default::default(),
                reason: "Newer strategy B e\u{301} 👩🏽‍💻".into(), exceptions: "Unfinished exceptions B".into(),
                config: tsumugi_core::ai::AiConfig::default(), roles: Default::default(), candidate: None, suite: None,
                evaluation_id: None, judgments: Default::default(), candidate_edit_seq: revision(1), candidate_saved_seq: revision(0),
                suite_edit_seq: revision(0), suite_saved_seq: revision(0),
                pending: Some(StrategyDraftPending::Withdraw { request: StrategyWithdrawOriginal { project_id: project,
                    withdrawal: tsumugi_core::WithdrawContextStrategy { action_id: ExecutionId::new(), project_id: project,
                        locale: "zh-CN".into(), expected_revision_id: None } }, edit_seq: revision(1), submitted_seq: revision(1) }),
            }) };

        fs::create_dir_all(&store.directory).unwrap();
        let path = store.directory.join(DATABASE);
        let mut connection = Connection::open(&path).unwrap();
        let tx = connection.transaction().unwrap();
        for ddl in SCHEMA { tx.execute_batch(ddl).unwrap(); }
        tx.pragma_update(None, "application_id", APPLICATION_ID).unwrap();
        tx.pragma_update(None, "user_version", 17).unwrap();
        tx.execute("INSERT INTO draft_heads(rowid,project_id,locale,unit_id,revision,edit_seq,source_revision_id,has_pending,payload) VALUES(11,?1,?2,?3,?4,?5,?6,1,?7)",
            params![project.to_string(), translation.key.locale, translation.key.unit_id.to_string(), translation_head.revision.get() as i64,
                translation.value.edit_seq.get() as i64, translation.value.basis.source_revision_id.to_string(), encode(&translation_head).unwrap()]).unwrap();
        tx.execute("INSERT INTO draft_heads(rowid,project_id,locale,unit_id,revision,edit_seq,source_revision_id,has_pending,payload) VALUES(17,?1,?2,?3,?4,NULL,NULL,0,?5)",
            params![project.to_string(), tombstone.key.locale, tombstone.key.unit_id.to_string(), tombstone.revision.get() as i64, encode(&tombstone).unwrap()]).unwrap();
        tx.execute("INSERT INTO conversation_draft_heads(rowid,project_id,conversation_id,revision,edit_seq,has_pending,payload) VALUES(29,?1,?2,?3,?4,1,?5)",
            params![project.to_string(), conversation.key.conversation_id.to_string(), conversation.revision.get() as i64,
                conversation.value.as_ref().unwrap().edit_seq.get() as i64, serde_json::to_vec(&conversation).unwrap()]).unwrap();
        for (table, rowid, head_revision, seq, bytes) in [
            ("resource_draft_heads", 43, resource.revision, resource.value.as_ref().unwrap().edit_seq, serde_json::to_vec(&resource).unwrap()),
            ("source_draft_heads", 67, source.revision, source.value.as_ref().unwrap().edit_seq, serde_json::to_vec(&source).unwrap()),
            ("strategy_draft_heads", 89, strategy.revision, strategy.value.as_ref().unwrap().journal_seq, serde_json::to_vec(&strategy).unwrap()),
        ] {
            tx.execute(&format!("INSERT INTO {table}(rowid,project_id,revision,edit_seq,has_pending,payload) VALUES(?1,?2,?3,?4,1,?5)"),
                params![rowid, project.to_string(), head_revision.get() as i64, seq.get() as i64, bytes]).unwrap();
        }
        tx.commit().unwrap();
        let original_rows = rows(&connection);
        drop(connection);

        // Every legacy record is decoded before invoking the interrupted writer.
        assert_eq!(store.read(&translation.key).unwrap(), translation_head);
        assert_eq!(store.read(&tombstone.key).unwrap(), tombstone);
        assert_eq!(store.read_conversation(&conversation.key).unwrap(), conversation);
        assert_eq!(store.read_resource(&resource.key).unwrap(), resource);
        assert_eq!(store.read_source(&source.key).unwrap(), source);
        assert_eq!(store.read_strategy(&strategy.key).unwrap(), strategy);
        let original_pending = store.pending_snapshot(project, None).unwrap();
        assert!(original_pending.complete);
        assert_eq!(original_pending.scanned_heads, 6);
        assert_eq!(original_pending.rows.len(), 5);
        assert_eq!(disk_format(&store), 17, "reads must preserve the legacy format");
        assert_eq!(rows(&Connection::open(&path).unwrap()), original_rows);

        let next = replace(&translation, &translation_head, "Newest translation C e\u{301} 👩🏽‍💻");
        crash_child(directory.path(), &store, &next, stage);
        let committed = stage == "write-after-commit";
        let expected = if committed { DraftHead { key: next.key.clone(), revision: revision(3), writer_id: Some(next.writer_id), value: Some(next.value.clone()) } }
            else { translation_head.clone() };
        let reopened = DraftStore::at(store.directory.clone()).unwrap();
        assert_eq!(reopened.read(&translation.key).unwrap(), expected);
        assert_eq!(reopened.read(&tombstone.key).unwrap(), tombstone);
        assert_eq!(reopened.read_conversation(&conversation.key).unwrap(), conversation);
        assert_eq!(reopened.read_resource(&resource.key).unwrap(), resource);
        assert_eq!(reopened.read_source(&source.key).unwrap(), source);
        assert_eq!(reopened.read_strategy(&strategy.key).unwrap(), strategy);
        let restored_pending = reopened.pending_snapshot(project, None).unwrap();
        assert!(restored_pending.complete);
        assert_eq!(restored_pending.scanned_heads, original_pending.scanned_heads);
        assert_eq!(restored_pending.rows.len(), original_pending.rows.len());
        for original in &original_pending.rows {
            let restored = restored_pending.rows.iter().find(|row| row.key == original.key).unwrap();
            assert_eq!(restored.slot, original.slot, "the exact original A request must survive");
            assert_eq!(restored.writer_id, original.writer_id);
            assert_eq!(restored.head_revision, if matches!(original.key, PendingJournalKey::Translation(_)) { expected.revision } else { original.head_revision });
        }

        // A different writer with an old revision cannot replace any recovered B.
        let mut stale_translation = translation.clone(); stale_translation.writer_id = ExecutionId::new();
        let stale_conversation = ConversationDraftWrite { key: conversation.key.clone(), expected_revision: revision(0), writer_id: ExecutionId::new(), value: conversation.value.clone().unwrap() };
        let mut stale_resource = resource_write.clone(); stale_resource.writer_id = ExecutionId::new();
        let stale_source = SourceDraftWrite { key: source.key.clone(), expected_revision: revision(0), writer_id: ExecutionId::new(), value: source.value.clone().unwrap() };
        let stale_strategy = StrategyDraftWrite { key: strategy.key.clone(), expected_revision: revision(0), writer_id: ExecutionId::new(), value: strategy.value.clone().unwrap() };
        for failure in [reopened.write(&stale_translation).unwrap_err(), reopened.write_conversation(&stale_conversation).unwrap_err(),
            reopened.write_resource(&stale_resource).unwrap_err(), reopened.write_source(&stale_source).unwrap_err(), reopened.write_strategy(&stale_strategy).unwrap_err()] {
            assert_eq!(failure.stage, "drafts-revision");
        }
        for failure in [reopened.clear(&DraftClear { key: translation.key.clone(), expected_revision: expected.revision }).unwrap_err(),
            reopened.clear_conversation(&ConversationDraftClear { key: conversation.key.clone(), expected_revision: conversation.revision }).unwrap_err(),
            reopened.clear_resource(&ResourceDraftClear { key: resource.key.clone(), expected_revision: resource.revision }).unwrap_err(),
            reopened.clear_source(&SourceDraftClear { key: source.key.clone(), expected_revision: source.revision }).unwrap_err(),
            reopened.clear_strategy(&StrategyDraftClear { key: strategy.key.clone(), expected_revision: strategy.revision }).unwrap_err()] {
            assert_eq!(failure.stage, "drafts-pending");
        }
        let mut expected_rows = original_rows;
        expected_rows[0].1.iter_mut().find(|row| row.0 == 11).unwrap().1 = encode(&expected).unwrap();
        assert_eq!(rows(&Connection::open(&path).unwrap()), expected_rows, "all rowids and unrelated payloads must remain intact");
        assert_eq!(disk_format(&reopened), if committed { FORMAT } else { 17 });
    }
}

pub(super) fn crash_child(control: &Path, store: &DraftStore, request: &DraftWrite, stage: &str) {
    let input = control.join("child-request.json");
    fs::write(&input, serde_json::to_vec(request).unwrap()).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "commands::drafts::store::tests::draft_store_crash_child",
            "--ignored",
            "--nocapture",
        ])
        .env("TSUMUGI_DRAFT_STORE_CRASH_CHILD", &store.directory)
        .env("TSUMUGI_DRAFT_STORE_CRASH_REQUEST", input)
        .env("TSUMUGI_DRAFT_STORE_CRASH_STAGE", stage)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert_eq!(status.code(), Some(91), "crash hook must actually execute");
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("owned crash child timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "isolated child invoked by draft storage crash regressions"]
fn draft_store_crash_child() {
    let directory =
        std::env::var_os("TSUMUGI_DRAFT_STORE_CRASH_CHILD").expect("isolated child directory");
    let input =
        std::env::var_os("TSUMUGI_DRAFT_STORE_CRASH_REQUEST").expect("isolated child request");
    let request: DraftWrite = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    DraftStore::at(PathBuf::from(directory))
        .unwrap()
        .write(&request)
        .unwrap();
    panic!("selected crash stage was not reached");
}
