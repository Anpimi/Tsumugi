use super::*;
use crate::persistence::ledger::input_storage::{CHUNK_BYTES, MAX_STORED_INPUT_BYTES};

fn large_input(store: &ProjectStore) -> FixedInput {
    let mut envelope = fixture_input(store, false).envelope().clone();
    let material: String = (0..40_000)
        .map(|index| format!("{index:05}🧵line-{index:05};"))
        .collect();
    envelope.settings = json!({"material": material});
    FixedInput::capture(envelope).unwrap()
}

#[test]
fn continuation_receipt_chunks_and_attempt_share_one_transaction_and_reopen_exactly() {
    let _schema = TestSchema::enable();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = store(&path);
    install_targets(&store);
    let original = large_input(&store);
    store.enqueue_read_only_execution(&original).unwrap();
    let action = crate::execution::test_continuation_action(
        &store,
        original.envelope().attempt_id,
        &[original.envelope().items[0].item_id],
    );
    let next = store
        .execution_retry_input(action.source_attempt_id, &action.item_ids)
        .unwrap();
    assert!(next.bytes().len() > MAX_STORED_INPUT_BYTES);
    let counts = |store: &ProjectStore| {
        [
            "execution_input_chunks",
            "execution_attempts",
            "execution_items",
            "execution_continuations",
        ]
        .map(|table| {
            store
                .execution_connection()
                .unwrap()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        })
    };
    let before_counts = counts(&store);
    let before_state = store
        .execution_attempt(action.source_attempt_id, false)
        .unwrap();
    store.execution_connection().unwrap().execute_batch(
        "CREATE TRIGGER fail_continuation BEFORE INSERT ON execution_continuations BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;"
    ).unwrap();
    assert!(
        store
            .enqueue_continuation(&action, &next, RecoveryPolicy::ReadOnly)
            .is_err()
    );
    assert_eq!(counts(&store), before_counts);
    assert_eq!(
        serde_json::to_value(
            store
                .execution_attempt(action.source_attempt_id, false)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(before_state).unwrap()
    );
    assert!(
        store
            .execution_input_if_present(next.envelope().attempt_id)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .execution_continuation(action.action_id)
            .unwrap()
            .is_none()
    );
    store
        .execution_connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_continuation")
        .unwrap();
    let receipt = store
        .enqueue_continuation(&action, &next, RecoveryPolicy::ReadOnly)
        .unwrap();
    let stored = metadata(store.execution_connection().unwrap(), &next);
    assert_eq!(
        stored["rawBytes"].as_u64().unwrap(),
        next.bytes().len() as u64
    );
    assert!(stored["chunks"].as_array().unwrap().len() > 1);
    assert_eq!(
        store.execution_input(receipt.attempt_id).unwrap().bytes(),
        next.bytes()
    );
    let committed_counts = counts(&store);
    store.close().unwrap();
    let mut reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(
        reopened.execution_continuation(action.action_id).unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        reopened
            .enqueue_continuation(&action, &next, RecoveryPolicy::ReadOnly)
            .unwrap(),
        receipt
    );
    assert_eq!(counts(&reopened), committed_counts);
    assert_eq!(
        reopened
            .execution_input(action.source_attempt_id)
            .unwrap()
            .bytes(),
        original.bytes()
    );
    assert_eq!(
        reopened
            .execution_input(receipt.attempt_id)
            .unwrap()
            .bytes(),
        next.bytes()
    );
}

fn metadata(connection: &Connection, input: &FixedInput) -> serde_json::Value {
    let bytes: Vec<u8> = connection
        .query_row(
            "SELECT input FROM execution_attempts WHERE attempt_id=?1",
            [input.envelope().attempt_id.to_string()],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn exact_frames_share_chunks_and_preserve_distinct_identities_after_reopen() {
    let _schema = TestSchema::enable();
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    let mut store = store(&path);
    install_targets(&store);
    let first = large_input(&store);
    let second = large_input(&store);
    for input in [&first, &second] {
        store.enqueue_execution(input).unwrap();
        assert_eq!(
            store
                .execution_input(input.envelope().attempt_id)
                .unwrap()
                .bytes(),
            input.bytes()
        );
    }
    let connection = store.execution_connection().unwrap();
    let first_manifest = metadata(connection, &first);
    let second_manifest = metadata(connection, &second);
    let chunks = |value: &serde_json::Value| {
        value["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<std::collections::BTreeSet<_>>()
    };
    assert!(
        chunks(&first_manifest)
            .intersection(&chunks(&second_manifest))
            .count()
            > 20
    );
    let bytes: i64 = connection
        .query_row(
            "SELECT SUM(length(bytes)) FROM execution_input_chunks",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let references: i64 = connection
        .query_row(
            "SELECT SUM(length(input)) FROM execution_attempts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    // Two distinct frames require one shared body plus their unique edge
    // chunks and references, so a strict half-size bound would be impossible.
    assert!((bytes as usize) < first.bytes().len() + 4 * CHUNK_BYTES);
    assert!((bytes + references) as usize * 5 < (first.bytes().len() + second.bytes().len()) * 3);
    println!(
        "LEDGER_CHUNK_STORAGE {}",
        json!({"logicalBytes":first.bytes().len()+second.bytes().len(),"chunkBytes":bytes,"referenceBytes":references})
    );
    assert_ne!(first.envelope().attempt_id, second.envelope().attempt_id);
    store.close().unwrap();
    let reopened = ProjectStore::open(&path).unwrap();
    for input in [&first, &second] {
        let restored = reopened
            .execution_input(input.envelope().attempt_id)
            .unwrap();
        assert_eq!(restored.bytes(), input.bytes());
        assert_eq!(restored.digest(), input.digest());
    }
}

#[test]
fn binary_chunks_preserve_split_unicode_and_exact_maximum_raw_frame() {
    let _schema = TestSchema::enable();
    let temp = tempfile::tempdir().unwrap();
    let mut store = store(&temp.path().join("project"));
    install_targets(&store);
    let original = fixture_input(&store, false);
    let mut envelope = original.envelope().clone();
    envelope.settings = json!({"material": "🧵"});
    let sample = FixedInput::capture(envelope.clone()).unwrap();
    let start = sample
        .bytes()
        .windows(4)
        .position(|bytes| bytes == "🧵".as_bytes())
        .unwrap();
    let padding = (CHUNK_BYTES - 1 + CHUNK_BYTES - start % CHUNK_BYTES) % CHUNK_BYTES;
    envelope.settings = json!({"material": format!("{}🧵tail", "x".repeat(padding))});
    let sample = FixedInput::capture(envelope).unwrap();
    let split = sample
        .bytes()
        .windows(4)
        .position(|bytes| bytes == "🧵".as_bytes())
        .unwrap();
    assert_eq!(split % CHUNK_BYTES, CHUNK_BYTES - 1);
    let mut raw = sample.bytes().to_vec();
    raw.extend_from_slice(b" \n\t");
    let input = FixedInput::restore(&raw, &codec::digest(&raw)).unwrap();
    store.enqueue_execution(&input).unwrap();
    assert_eq!(
        store
            .execution_input(input.envelope().attempt_id)
            .unwrap()
            .bytes(),
        raw
    );
    let mut maximum = fixture_input(&store, false).bytes().to_vec();
    maximum.resize(MAX_INPUT_BYTES, b' ');
    let maximum_input = FixedInput::restore(&maximum, &codec::digest(&maximum)).unwrap();
    store.enqueue_execution(&maximum_input).unwrap();
    assert_eq!(
        store
            .execution_input(maximum_input.envelope().attempt_id)
            .unwrap()
            .bytes(),
        maximum
    );
    maximum.push(b' ');
    assert_eq!(
        FixedInput::restore(&maximum, &codec::digest(&maximum))
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
}

#[test]
fn damaged_chunks_or_references_fail_all_read_paths_and_idempotent_enqueue_without_writes() {
    let _schema = TestSchema::enable();
    for damage in [
        "missing",
        "bytes",
        "oversized-chunk",
        "format",
        "length",
        "order",
        "missing-part",
        "reference",
        "extra",
        "duplicate-key",
        "whitespace",
        "malformed",
        "oversized-reference",
        "text-reference",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("project");
        let mut store = store(&path);
        install_targets(&store);
        let input = large_input(&store);
        store.enqueue_execution(&input).unwrap();
        let result = produce(&mut store, &input, input.envelope().items[0].item_id);
        store.save_execution_result(&result).unwrap();
        let c = store.execution_connection().unwrap();
        load_input_cached(c, input.envelope().attempt_id).unwrap();
        let mut manifest = metadata(c, &input);
        let first = manifest["chunks"][0].as_str().unwrap().to_owned();
        match damage {
            "missing" => {
                c.execute(
                    "DELETE FROM execution_input_chunks WHERE digest=?1",
                    [&first],
                )
                .unwrap();
            }
            "bytes" => {
                c.execute("UPDATE execution_input_chunks SET bytes=zeroblob(length(bytes)) WHERE digest=?1", [&first]).unwrap();
            }
            "oversized-chunk" => {
                c.pragma_update(None, "ignore_check_constraints", true)
                    .unwrap();
                c.execute(
                    "UPDATE execution_input_chunks SET bytes=zeroblob(?2) WHERE digest=?1",
                    params![first, (CHUNK_BYTES + 1) as i64],
                )
                .unwrap();
            }
            _ => {
                match damage {
                    "format" => manifest["format"] = json!(2),
                    "length" => manifest["rawBytes"] = json!(input.bytes().len() + 1),
                    "order" => manifest["chunks"].as_array_mut().unwrap().reverse(),
                    "missing-part" => {
                        manifest["chunks"].as_array_mut().unwrap().pop();
                    }
                    "reference" => manifest["chunks"][0] = json!("Z".repeat(64)),
                    "extra" => manifest["unexpected"] = json!(true),
                    _ => {}
                }
                let extra = if damage == "extra" {
                    ",\"unexpected\":true"
                } else {
                    ""
                };
                let mut bytes = format!(
                    "{{\"format\":{},\"rawBytes\":{},\"chunks\":{}{extra}}}",
                    manifest["format"], manifest["rawBytes"], manifest["chunks"]
                )
                .into_bytes();
                // Canonical order is owned by the storage encoder, not Value's
                // object ordering. Start with the actual persisted reference.
                if [
                    "duplicate-key",
                    "whitespace",
                    "malformed",
                    "oversized-reference",
                    "text-reference",
                ]
                .contains(&damage)
                {
                    bytes = c
                        .query_row(
                            "SELECT input FROM execution_attempts WHERE attempt_id=?1",
                            [input.envelope().attempt_id.to_string()],
                            |r| r.get(0),
                        )
                        .unwrap();
                }
                match damage {
                    "duplicate-key" => bytes
                        .splice(1..1, b"\"format\":1,".iter().copied())
                        .for_each(drop),
                    "whitespace" => bytes.push(b' '),
                    "malformed" => bytes[0] = b'!',
                    "oversized-reference" => {
                        bytes.resize(MAX_STORED_INPUT_BYTES + 1, b' ');
                        c.pragma_update(None, "ignore_check_constraints", true)
                            .unwrap();
                    }
                    "text-reference" => {
                        c.pragma_update(None, "ignore_check_constraints", true)
                            .unwrap();
                    }
                    _ => {}
                }
                if damage == "text-reference" {
                    c.execute(
                        "UPDATE execution_attempts SET input=CAST(?2 AS TEXT) WHERE attempt_id=?1",
                        params![input.envelope().attempt_id.to_string(), bytes],
                    )
                    .unwrap();
                } else {
                    c.execute(
                        "UPDATE execution_attempts SET input=?2 WHERE attempt_id=?1",
                        params![input.envelope().attempt_id.to_string(), bytes],
                    )
                    .unwrap();
                }
            }
        }
        let before = std::fs::read(path.join("project.sqlite3")).unwrap();
        let pairs = [(input.envelope().attempt_id, result.envelope().result_id)];
        for error in [
            load_input(c, input.envelope().attempt_id).unwrap_err(),
            load_input_cached(c, input.envelope().attempt_id).unwrap_err(),
            check_stored_input(c, &input).unwrap_err(),
            visit_result_pairs(c, &pairs, |_| Ok(())).unwrap_err(),
        ] {
            assert_eq!(error.code, ErrorCode::CorruptLedger, "{damage}: {error:?}");
        }
        assert_eq!(
            store.enqueue_execution(&input).unwrap_err().code,
            ErrorCode::CorruptLedger,
            "{damage}"
        );
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
        store.close().unwrap();
        assert_eq!(
            ProjectStore::open(&path).unwrap_err().code(),
            PersistenceErrorCode::CorruptProject,
            "{damage}"
        );
        assert_eq!(std::fs::read(path.join("project.sqlite3")).unwrap(), before);
    }
}

#[test]
fn enqueue_failure_rolls_back_chunks_attempt_and_items_in_the_original_transaction() {
    let _schema = TestSchema::enable();
    let temp = tempfile::tempdir().unwrap();
    let mut store = store(&temp.path().join("project"));
    install_targets(&store);
    let input = large_input(&store);
    store.execution_connection().unwrap().execute_batch("CREATE TRIGGER fail_input_items BEFORE INSERT ON execution_items BEGIN SELECT RAISE(ABORT,'synthetic enqueue failure'); END;").unwrap();
    assert!(store.enqueue_execution(&input).is_err());
    for table in [
        "execution_input_chunks",
        "execution_tasks",
        "execution_attempts",
        "execution_items",
    ] {
        let count: i64 = store
            .execution_connection()
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table} must share the enqueue rollback");
    }
    store
        .execution_connection()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_input_items")
        .unwrap();
    store.enqueue_execution(&input).unwrap();
    assert_eq!(
        store
            .execution_input(input.envelope().attempt_id)
            .unwrap()
            .bytes(),
        input.bytes()
    );
}

#[test]
fn conflicting_shared_chunk_is_rejected_and_sql_storage_limits_are_enforced() {
    let _schema = TestSchema::enable();
    let temp = tempfile::tempdir().unwrap();
    let mut store = store(&temp.path().join("project"));
    install_targets(&store);
    let input = large_input(&store);
    let bytes = &input.bytes()[..CHUNK_BYTES];
    let digest = codec::digest(bytes);
    let c = store.execution_connection().unwrap();
    c.execute(
        "INSERT INTO execution_input_chunks VALUES (?1,?2)",
        params![digest, vec![b'!'; CHUNK_BYTES]],
    )
    .unwrap();
    for invalid in [Vec::<u8>::new(), vec![0_u8; CHUNK_BYTES + 1]] {
        assert!(
            c.execute(
                "INSERT INTO execution_input_chunks VALUES (?1,?2)",
                params!["0".repeat(64), invalid]
            )
            .is_err()
        );
    }
    assert!(
        c.execute(
            "INSERT INTO execution_input_chunks VALUES (?1,'text')",
            ["0".repeat(64)]
        )
        .is_err()
    );
    assert_eq!(
        store.enqueue_execution(&input).unwrap_err().code,
        ErrorCode::CorruptLedger
    );
    assert!(store.execution_input(input.envelope().attempt_id).is_err());
    assert_eq!(
        store
            .execution_connection()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM execution_input_chunks", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
