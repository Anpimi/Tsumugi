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
    Connection::open(&path).unwrap().pragma_update(None, "user_version", KNOWLEDGE_PROPOSAL_FORMAT).unwrap();
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
    connection.pragma_update(None,"user_version",LEGACY_FORMAT).unwrap(); drop(connection);
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
    database
        .pragma_update(None, "user_version", LEGACY_FORMAT)
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
    blocker
        .pragma_update(None, "user_version", LEGACY_FORMAT)
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
    blocker
        .pragma_update(None, "user_version", LEGACY_FORMAT)
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
