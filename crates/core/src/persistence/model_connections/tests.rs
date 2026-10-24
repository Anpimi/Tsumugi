use super::*;
use crate::ai::AiConfig;
#[path = "config_tests.rs"]
mod config_tests;

fn connection(model: &str) -> AiConnection {
    AiConnection {
        endpoint: "https://example.test/v1/chat/completions".into(),
        model: model.into(),
        credential_env: "SYNTHETIC_KEY_REFERENCE".into(),
        token_field: "max_tokens".into(),
    }
}
fn setup() -> (tempfile::TempDir, ModelConnectionStore) {
    let temp = tempfile::tempdir().unwrap();
    let store = ModelConnectionStore::at(temp.path().join("models")).unwrap();
    (temp, store)
}
fn save(
    store: &ModelConnectionStore,
    id: ExecutionId,
    name: &str,
    model: &str,
) -> ModelConnectionChange {
    ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: store.snapshot().unwrap().basis().unwrap(),
        edit: ModelConnectionEdit::Save {
            profile_id: id,
            name: name.into(),
            connection: connection(model),
        },
    }
}
fn edit(store: &ModelConnectionStore, value: ModelConnectionEdit) -> ModelConnectionChange {
    ModelConnectionChange {
        action_id: ExecutionId::new(),
        expected: store.snapshot().unwrap().basis().unwrap(),
        edit: value,
    }
}

#[test]
fn missing_storage_reads_and_invalid_first_changes_leave_the_directory_absent() {
    let (temp, store) = setup();
    assert_eq!(store.snapshot().unwrap(), ModelConnectionSnapshot::empty());
    assert!(store.action(ExecutionId::new()).unwrap().is_none());
    assert!(!temp.path().join("models").exists());
    let mut invalid = save(&store, ExecutionId::new(), "Local", "model");
    if let ModelConnectionEdit::Save { connection, .. } = &mut invalid.edit {
        connection.endpoint = "https://user:secret@example.test/api?key=secret".into();
    }
    assert_eq!(store.change(&invalid).unwrap_err().stage, "ai-endpoint");
    let missing = edit(
        &store,
        ModelConnectionEdit::Archive {
            profile_id: ExecutionId::new(),
        },
    );
    assert!(store.change(&missing).is_err());
    assert!(!temp.path().join("models").exists());
}

#[test]
fn saved_connection_defaults_leave_invocation_budget_sharing_and_other_settings_intact() {
    let defaults = connection("Saved model");
    let mut invocation = AiConfig {
        max_items: 3,
        concurrency: 2,
        max_requests: 4,
        max_output_tokens: 37,
        max_retries: 2,
        timeout_seconds: 7,
        share_terms: true,
        share_context: true,
        ..AiConfig::default()
    };
    let prior = invocation.clone();
    defaults.apply(&mut invocation);
    assert_eq!(AiConnection::from_config(&invocation), defaults);
    assert_eq!(
        (
            invocation.max_items,
            invocation.concurrency,
            invocation.max_requests,
            invocation.max_output_tokens,
            invocation.max_retries,
            invocation.timeout_seconds,
            invocation.share_terms,
            invocation.share_context
        ),
        (
            prior.max_items,
            prior.concurrency,
            prior.max_requests,
            prior.max_output_tokens,
            prior.max_retries,
            prior.timeout_seconds,
            prior.share_terms,
            prior.share_context
        )
    );
    defaults.validate().unwrap();
}

#[test]
fn atomic_save_reopen_and_exact_action_replay_preserve_the_original_receipt() {
    let (temp, store) = setup();
    let first = ExecutionId::new();
    let request = save(&store, first, "Primary", "alpha");
    let receipt = store.change(&request).unwrap();
    assert_eq!(receipt.snapshot.revision.get(), 1);
    let second = save(&store, ExecutionId::new(), "Secondary", "beta");
    store.change(&second).unwrap();
    let reopened = ModelConnectionStore::at(temp.path().join("models")).unwrap();
    assert_eq!(reopened.change(&request).unwrap(), receipt);
    assert_eq!(reopened.action(request.action_id).unwrap(), Some(receipt));
    assert_eq!(reopened.snapshot().unwrap().revision.get(), 2);
    let mut changed = request.clone();
    if let ModelConnectionEdit::Save { name, .. } = &mut changed.edit {
        *name = "Wrong replay".into();
    }
    assert_eq!(
        reopened.change(&changed).unwrap_err().stage,
        "model-connections-action"
    );
    let db = Connection::open(temp.path().join("models").join(DATABASE)).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM connection_actions", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn independent_writers_refuse_stale_compare_and_swap_without_losing_saved_profiles() {
    let (temp, store) = setup();
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Primary", "alpha")).unwrap();
    let second = ModelConnectionStore::at(temp.path().join("models")).unwrap();
    let old = save(&second, id, "Stale edit", "stale");
    store
        .change(&save(&store, id, "New current", "current"))
        .unwrap();
    let before = second.snapshot().unwrap();
    assert_eq!(
        second.change(&old).unwrap_err().stage,
        "model-connections-basis"
    );
    assert_eq!(second.snapshot().unwrap(), before);
    assert!(second.action(old.action_id).unwrap().is_none());
}

#[test]
fn profile_references_ignore_other_profile_changes_but_refuse_edited_archived_and_restored_versions()
 {
    let (_temp, store) = setup();
    let id = ExecutionId::new();
    let initial = store
        .change(&save(&store, id, "Primary", "alpha"))
        .unwrap()
        .snapshot;
    let reference = initial.reference(id).unwrap();
    let original_config = store.resolve(&reference).unwrap();
    store
        .change(&save(&store, ExecutionId::new(), "Other", "beta"))
        .unwrap();
    assert_eq!(store.resolve(&reference).unwrap(), original_config);
    store
        .change(&edit(
            &store,
            ModelConnectionEdit::Archive { profile_id: id },
        ))
        .unwrap();
    assert_eq!(
        store.resolve(&reference).unwrap_err().stage,
        "model-connection-unavailable"
    );
    let restored = store
        .change(&edit(
            &store,
            ModelConnectionEdit::Restore { profile_id: id },
        ))
        .unwrap()
        .snapshot;
    assert!(store.resolve(&reference).is_err());
    assert_eq!(
        store.resolve(&restored.reference(id).unwrap()).unwrap(),
        original_config
    );
    let fresh_ref = restored.reference(id).unwrap();
    store
        .change(&save(&store, id, "Primary", "changed-model"))
        .unwrap();
    assert_eq!(
        store.resolve(&fresh_ref).unwrap_err().stage,
        "model-connection-changed"
    );
    assert_eq!(original_config.model, "alpha"); // A captured operation is not rewritten.
}

#[test]
fn conflicting_active_names_do_not_commit_and_archived_name_reuse_does_not_allow_implicit_restore()
{
    let (_temp, store) = setup();
    let first = ExecutionId::new();
    store
        .change(&save(&store, first, "Shared name", "alpha"))
        .unwrap();
    let duplicate = save(&store, ExecutionId::new(), "Shared name", "beta");
    let before = store.snapshot().unwrap();
    assert_eq!(
        store.change(&duplicate).unwrap_err().stage,
        "model-connection-name-duplicate"
    );
    assert_eq!(store.snapshot().unwrap(), before);
    assert!(store.action(duplicate.action_id).unwrap().is_none());
    store
        .change(&edit(
            &store,
            ModelConnectionEdit::Archive { profile_id: first },
        ))
        .unwrap();
    store
        .change(&save(&store, ExecutionId::new(), "Shared name", "beta"))
        .unwrap();
    let restore = edit(&store, ModelConnectionEdit::Restore { profile_id: first });
    let before = store.snapshot().unwrap();
    assert_eq!(
        store.change(&restore).unwrap_err().stage,
        "model-connection-name-duplicate"
    );
    assert_eq!(store.snapshot().unwrap(), before);
}

#[test]
fn current_store_identity_is_part_of_snapshot_and_profile_references() {
    let (_temp, first) = setup();
    let (_other, second) = setup();
    let id = ExecutionId::new();
    let first_snapshot = first
        .change(&save(&first, id, "Primary", "alpha"))
        .unwrap()
        .snapshot;
    second
        .change(&save(&second, id, "Primary", "alpha"))
        .unwrap();
    assert!(
        second
            .resolve(&first_snapshot.reference(id).unwrap())
            .is_err()
    );
    let mut request = save(&second, id, "New", "beta");
    request.expected = first_snapshot.basis().unwrap();
    assert!(second.change(&request).is_err());
}

#[test]
fn external_valid_payload_edits_without_revision_changes_still_conflict_with_the_captured_basis() {
    let (temp, store) = setup();
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Primary", "alpha")).unwrap();
    let pending = save(&store, id, "Pending", "beta");
    let mut tampered = store.snapshot().unwrap();
    tampered.profiles[0].connection.model = "Outside writer".into();
    let payload = encoded(&tampered).unwrap();
    let db = Connection::open(temp.path().join("models").join(DATABASE)).unwrap();
    db.execute(
        "UPDATE connection_state SET payload=?1,digest=?2",
        params![payload, codec::digest(&payload)],
    )
    .unwrap();
    drop(db);
    assert_eq!(
        store.change(&pending).unwrap_err().stage,
        "model-connections-basis"
    );
    assert_eq!(store.snapshot().unwrap(), tampered);
}

#[test]
fn unsupported_format_and_corrupt_receipt_are_not_repaired_or_treated_as_missing_actions() {
    let (temp, store) = setup();
    let request = save(&store, ExecutionId::new(), "Primary", "alpha");
    store.change(&request).unwrap();
    let path = temp.path().join("models").join(DATABASE);
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", FORMAT + 1).unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        store.snapshot().unwrap_err().stage,
        "model-connections-version"
    );
    assert!(store.change(&request).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "user_version", FORMAT).unwrap();
    db.execute(
        "UPDATE connection_actions SET payload=x'7B7D' WHERE action_id=?1",
        [request.action_id.to_string()],
    )
    .unwrap();
    drop(db);
    assert!(store.action(request.action_id).is_err());
    assert!(store.change(&request).is_err());
}

#[test]
fn write_transaction_failure_rolls_back_profile_and_receipt_together() {
    let (temp, store) = setup();
    let first = ExecutionId::new();
    store
        .change(&save(&store, first, "Primary", "alpha"))
        .unwrap();
    let before = store.snapshot().unwrap();
    let update = save(&store, first, "Updated", "beta");
    let mut db = Connection::open(temp.path().join("models").join(DATABASE)).unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let after = apply(&before, &update).unwrap();
    let receipt = ModelConnectionReceipt {
        action_id: update.action_id,
        request_digest: digest(&update).unwrap(),
        snapshot: after,
    };
    write_result(&tx, &receipt).unwrap(); // Simulated interruption before commit.
    drop(tx);
    drop(db);
    assert_eq!(store.snapshot().unwrap(), before);
    assert!(store.action(update.action_id).unwrap().is_none());
    store.change(&update).unwrap();
}

#[test]
fn busy_writer_is_reported_without_waiting_or_recording_an_action() {
    let (temp, store) = setup();
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Primary", "alpha")).unwrap();
    let pending = save(&store, id, "Next", "beta");
    let mut db = Connection::open(temp.path().join("models").join(DATABASE)).unwrap();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let start = std::time::Instant::now();
    assert_eq!(store.change(&pending).unwrap_err().code, ErrorCode::Busy);
    assert!(start.elapsed() < Duration::from_secs(1));
    drop(tx);
    drop(db);
    assert!(store.action(pending.action_id).unwrap().is_none());
}

#[test]
fn profile_capacity_is_explicit_and_keeps_existing_archived_history() {
    let (_temp, store) = setup();
    for n in 0..MAX_CONNECTION_PROFILES {
        store
            .change(&save(
                &store,
                ExecutionId::new(),
                &format!("Connection {n}"),
                "alpha",
            ))
            .unwrap();
    }
    let before = store.snapshot().unwrap();
    let over = save(&store, ExecutionId::new(), "Overflow", "alpha");
    assert_eq!(
        store.change(&over).unwrap_err().stage,
        "model-connections-capacity"
    );
    assert_eq!(store.snapshot().unwrap(), before);
    let first = before.profiles[0].id;
    store
        .change(&edit(
            &store,
            ModelConnectionEdit::Archive { profile_id: first },
        ))
        .unwrap();
    assert_eq!(
        store.snapshot().unwrap().profiles.len(),
        MAX_CONNECTION_PROFILES
    );
}

#[cfg(unix)]
#[test]
fn database_and_directory_symlinks_and_writable_hardlink_aliases_are_refused() {
    use std::os::unix::fs::symlink;
    let (temp, store) = setup();
    let id = ExecutionId::new();
    let request = save(&store, id, "Primary", "alpha");
    store.change(&request).unwrap();
    let alias_dir = temp.path().join("alias-directory");
    symlink(temp.path().join("models"), &alias_dir).unwrap();
    assert!(
        ModelConnectionStore::at(alias_dir)
            .unwrap()
            .snapshot()
            .is_err()
    );
    let other_dir = temp.path().join("alias-file");
    fs::create_dir(&other_dir).unwrap();
    symlink(
        temp.path().join("models").join(DATABASE),
        other_dir.join(DATABASE),
    )
    .unwrap();
    assert!(
        ModelConnectionStore::at(&other_dir)
            .unwrap()
            .snapshot()
            .is_err()
    );
    fs::remove_file(other_dir.join(DATABASE)).unwrap();
    fs::hard_link(
        temp.path().join("models").join(DATABASE),
        other_dir.join(DATABASE),
    )
    .unwrap();
    let writer = ModelConnectionStore::at(&other_dir).unwrap();
    let pending = save(&writer, id, "Wrong alias", "beta");
    assert_eq!(
        writer.change(&pending).unwrap_err().stage,
        "model-connections-file"
    );
    assert_eq!(store.snapshot().unwrap().profiles[0].name, "Primary");
}

#[test]
fn read_snapshots_leave_database_bytes_and_all_files_unchanged() {
    let (temp, store) = setup();
    let id = ExecutionId::new();
    let request = save(&store, id, "Primary", "alpha");
    let receipt = store.change(&request).unwrap();
    let directory = temp.path().join("models");
    let before: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_os_string(),
                fs::read(&path).unwrap(),
            )
        })
        .collect();
    let reference = receipt.snapshot.reference(id).unwrap();
    assert_eq!(
        store.action(request.action_id).unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(store.snapshot().unwrap(), receipt.snapshot);
    store.resolve(&reference).unwrap();
    let after: Vec<_> = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            (
                path.file_name().unwrap().to_os_string(),
                fs::read(&path).unwrap(),
            )
        })
        .collect();
    assert_eq!(before, after);
}

#[cfg(unix)]
#[test]
fn trusted_platform_ancestor_aliases_do_not_disable_no_follow_database_checks() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let canonical = fs::canonicalize(temp.path()).unwrap();
    let alias = canonical.join("platform-alias");
    let actual = canonical.join("actual-parent");
    fs::create_dir(&actual).unwrap();
    symlink(&actual, &alias).unwrap();
    let store = ModelConnectionStore::at(alias.join("models")).unwrap();
    let request = save(&store, ExecutionId::new(), "Primary", "alpha");
    let receipt = store.change(&request).unwrap();
    assert_eq!(store.snapshot().unwrap(), receipt.snapshot);
    assert_eq!(store.action(request.action_id).unwrap(), Some(receipt));
    assert!(!actual.join("models").is_symlink());
}

#[test]
fn unexpected_schema_and_oversized_documents_are_refused_without_repair() {
    let (temp, store) = setup();
    let request = save(&store, ExecutionId::new(), "Primary", "alpha");
    store.change(&request).unwrap();
    let path = temp.path().join("models").join(DATABASE);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE sqliteXextra (value TEXT)")
        .unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        store.snapshot().unwrap_err().stage,
        "model-connections-schema"
    );
    assert!(store.change(&request).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE sqliteXextra").unwrap();
    db.execute(
        "UPDATE connection_state SET payload=zeroblob(?1)",
        [MAX_DOCUMENT_BYTES as i64 + 1],
    )
    .unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        store.snapshot().unwrap_err().stage,
        "model-connections-document"
    );
    assert!(store.action(request.action_id).is_err());
    assert!(store.change(&request).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn simultaneous_first_writes_publish_one_complete_store_and_replay_one_exact_action() {
    use std::sync::{Arc, Barrier};
    for same_action in [true, false] {
        let (_temp, store) = setup();
        let first = save(&store, ExecutionId::new(), "Primary", "alpha");
        let second = if same_action {
            first.clone()
        } else {
            save(&store, ExecutionId::new(), "Other", "beta")
        };
        let barrier = Arc::new(Barrier::new(2));
        let run = |request: ModelConnectionChange| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.change(&request)
            })
        };
        let a = run(first.clone());
        let b = run(second.clone());
        let a = a.join().unwrap();
        let b = b.join().unwrap();
        if same_action {
            assert_eq!(a.as_ref().unwrap(), b.as_ref().unwrap());
        } else {
            assert_ne!(a.is_ok(), b.is_ok());
            let failure = a.as_ref().err().or(b.as_ref().err()).unwrap();
            assert_eq!(failure.stage, "model-connections-basis");
        }
        let receipt = a.ok().or(b.ok()).unwrap();
        assert_eq!(store.snapshot().unwrap(), receipt.snapshot);
        assert_eq!(store.snapshot().unwrap().profiles.len(), 1);
        assert_eq!(store.action(receipt.action_id).unwrap(), Some(receipt));
        assert_eq!(store.snapshot().unwrap().revision.get(), 1);
    }
}
