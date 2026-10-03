use super::*;
use serde_json::json;
use std::sync::{Mutex, mpsc};

#[test]
fn decimal_wire_values_are_canonical_and_keep_their_distinct_bounds() {
    for number in [0, 9007199254740993, u64::MAX] {
        let value = UnsignedDecimal::from(number);
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(json, format!("\"{number}\""));
        assert_eq!(
            serde_json::from_str::<UnsignedDecimal>(&json)
                .unwrap()
                .get(),
            number
        );
    }
    for text in [
        "",
        "01",
        "-1",
        "+1",
        "1.0",
        "1e3",
        " 1",
        "18446744073709551616",
    ] {
        let json = serde_json::to_string(text).unwrap();
        assert!(
            serde_json::from_str::<UnsignedDecimal>(&json).is_err(),
            "{text}"
        );
        assert!(serde_json::from_str::<Revision>(&json).is_err(), "{text}");
    }
    assert!(serde_json::from_str::<UnsignedDecimal>("1").is_err());
    assert!(serde_json::from_str::<Revision>("1").is_err());
    assert_eq!(
        serde_json::from_str::<Revision>("\"9223372036854775807\"")
            .unwrap()
            .get(),
        i64::MAX as u64
    );
    assert!(serde_json::from_str::<Revision>("\"9223372036854775808\"").is_err());
}

fn input() -> FixedInput {
    let items = ["a", "b", "c"]
        .into_iter()
        .map(|id| {
            InputItem::new(
                Scope {
                    kind: "fixture".into(),
                    id: id.into(),
                    locale: Some("zh-CN".into()),
                },
                json!({ "text": id }),
                vec![Dependency {
                    kind: "fixture".into(),
                    id: id.into(),
                    expected_revision: Revision::new(1).unwrap(),
                }],
            )
        })
        .collect();
    FixedInput::capture(
        InputEnvelope::new(ProjectId::new_v4(), "fixture", "controlled", "1", items).unwrap(),
    )
    .unwrap()
}
fn result(input: &FixedInput, item: ExecutionId, token: ExecutionId) -> ResultEnvelope {
    ResultEnvelope {
        project_id: input.envelope().project_id,
        attempt_id: input.envelope().attempt_id,
        item_id: item,
        result_id: ExecutionId::new(),
        supersedes: None,
        dispatch_token: token,
        capability_id: "controlled".into(),
        capability_version: "1".into(),
        outcome: ExecutionState::Succeeded,
        output: Some(json!({ "text": "generated" })),
        diagnostic: None,
    }
}

#[test]
fn frozen_inputs_retain_bytes_and_retry_only_creates_a_new_attempt() {
    let fixed = input();
    let before = fixed.bytes().to_vec();
    let mut changed = fixed.envelope().clone();
    changed.items[0].payload = json!({"text": "new"});
    changed.attempt_id = ExecutionId::new();
    let newer = FixedInput::capture(changed).unwrap();
    assert_ne!(newer.digest(), fixed.digest());
    assert_eq!(fixed.bytes(), before);
    let retried = fixed.retry(&[fixed.envelope().items[1].item_id]).unwrap();
    assert_eq!(
        retried.envelope().previous_attempt_id,
        Some(fixed.envelope().attempt_id)
    );
    assert_eq!(
        retried.envelope().items,
        vec![fixed.envelope().items[1].clone()]
    );
    assert_ne!(retried.envelope().attempt_id, fixed.envelope().attempt_id);
    assert_eq!(
        FixedInput::restore(&before, fixed.digest())
            .unwrap()
            .bytes(),
        before
    );
    let mut corrupted = before;
    corrupted[0] = b' ';
    assert_eq!(
        FixedInput::restore(&corrupted, fixed.digest())
            .unwrap_err()
            .code,
        ErrorCode::CorruptLedger
    );
}

#[test]
fn decoding_rejects_duplicates_unknown_fields_invalid_ids_and_excessive_depth() {
    let fixed = input();
    let bytes = fixed.bytes();
    let mut duplicate = b"{\"version\":1,".to_vec();
    duplicate.extend_from_slice(&bytes[1..]);
    assert!(FixedInput::restore(&duplicate, &codec::digest(&duplicate)).is_err());
    let mut nested = b"{\"settings\":{\"x\":1,\"x\":2},".to_vec();
    nested.extend_from_slice(&bytes[1..]);
    assert!(FixedInput::restore(&nested, &codec::digest(&nested)).is_err());
    let mut value: Value = serde_json::from_slice(bytes).unwrap();
    value["unexpected"] = json!(1);
    let unknown = serde_json::to_vec(&value).unwrap();
    assert!(FixedInput::restore(&unknown, &codec::digest(&unknown)).is_err());
    assert!(ExecutionId::parse("00000000-0000-0000-0000-000000000000").is_err());
    assert!(Revision::try_from("01".to_string()).is_err());
    assert_eq!(
        serde_json::to_string(&Revision::new(9_007_199_254_740_993).unwrap()).unwrap(),
        "\"9007199254740993\""
    );
    let mut deep = Value::Null;
    for _ in 0..MAX_DEPTH + 1 {
        deep = json!([deep]);
    }
    let mut draft = fixed.envelope().clone();
    draft.settings = deep;
    assert_eq!(
        FixedInput::capture(draft).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
}

#[test]
fn item_and_unit_coverage_is_exact_and_limits_are_enforced() {
    let fixed = input();
    let mut draft = fixed.envelope().clone();
    draft.items.push(draft.items[0].clone());
    assert!(FixedInput::capture(draft).is_err());
    let mut draft = fixed.envelope().clone();
    draft.units[0].item_ids.push(draft.items[1].item_id);
    assert!(FixedInput::capture(draft).is_err());
    let mut draft = fixed.envelope().clone();
    draft.units = vec![AdoptionUnit::new(
        draft.items.iter().map(|item| item.item_id).collect(),
    )];
    let grouped = FixedInput::capture(draft).unwrap();
    assert!(
        grouped
            .retry(&[grouped.envelope().items[0].item_id])
            .is_err()
    );
    let mut draft = fixed.envelope().clone();
    draft.settings = Value::String("x".repeat(MAX_INPUT_BYTES));
    assert_eq!(
        FixedInput::capture(draft).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    let mut draft = fixed.envelope().clone();
    draft.limits.timeout_ms = 60_001;
    assert!(FixedInput::capture(draft).is_err());
}

#[test]
fn bounded_json_encoding_reports_the_public_limit_reason() {
    let error = codec::encode(&json!({"value": "too large"}), 8).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "limit-exceeded");
}

#[test]
fn result_limits_keep_the_small_default_and_allow_the_bounded_cap() {
    let fixed = input();
    assert_eq!(
        fixed.envelope().limits.max_result_bytes as usize,
        DEFAULT_RESULT_BYTES
    );
    let mut envelope = fixed.envelope().clone();
    envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
    assert!(FixedInput::capture(envelope).is_ok());
    assert_eq!(MAX_RESULT_BYTES, 2 * 1024 * 1024);
}

#[test]
fn result_identity_and_capability_checks_preserve_original_evidence() {
    let fixed = input();
    let token = ExecutionId::new();
    let envelope = result(&fixed, fixed.envelope().items[0].item_id, token);
    let first = FixedResult::capture(envelope.clone(), &fixed, token).unwrap();
    let same = FixedResult::receive(first.bytes(), &fixed, token).unwrap();
    assert!(same.is_duplicate_of(&first).unwrap());
    let mut changed = envelope.clone();
    changed.output = Some(json!("different"));
    assert_eq!(
        FixedResult::capture(changed, &fixed, token)
            .unwrap()
            .is_duplicate_of(&first)
            .unwrap_err()
            .code,
        ErrorCode::ResultMismatch
    );
    for field in ["capabilityVersion", "attemptId", "itemId", "projectId"] {
        let mut value = serde_json::to_value(&envelope).unwrap();
        value[field] = json!(if field == "capabilityVersion" {
            "2".to_string()
        } else {
            ExecutionId::new().to_string()
        });
        assert!(FixedResult::receive(&serde_json::to_vec(&value).unwrap(), &fixed, token).is_err());
    }
    let mut oversized = envelope;
    oversized.output = Some(json!("x".repeat(MAX_RESULT_BYTES)));
    assert_eq!(
        FixedResult::capture(oversized, &fixed, token)
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(first.envelope().output, Some(json!({"text":"generated"})));
}

#[test]
fn terminal_state_transitions_and_recovery_do_not_confuse_adoption_with_generation() {
    assert!(
        ExecutionState::Queued
            .transition(ExecutionState::Succeeded)
            .is_err()
    );
    assert!(
        ExecutionState::CancelledBeforeDispatch
            .transition(ExecutionState::Succeeded)
            .is_err()
    );
    assert_eq!(
        ExecutionState::Unknown
            .transition(ExecutionState::Succeeded)
            .unwrap(),
        ExecutionState::Succeeded
    );
    let mut item = ItemStatus {
        item_id: ExecutionId::new(),
        execution: ExecutionState::Succeeded,
        validation: ValidationState::Valid,
        adoption: AdoptionState::Unapplied,
        cancellation_requested: true,
        retry_safe: false,
        diagnostic: None,
    };
    assert_eq!(item.recovery_actions(), vec![RecoveryAction::AdoptResult]);
    assert_eq!(Progress::from_items(&[item.clone()]).adopted, 0);
    item.adoption = AdoptionState::Committed;
    assert_eq!(item.recovery_actions(), vec![RecoveryAction::ViewReceipt]);
    assert_eq!(Progress::from_items(&[item.clone()]).adopted, 1);
    item.adoption = AdoptionState::Unapplied;
    item.execution = ExecutionState::Unknown;
    assert_eq!(item.recovery_actions(), vec![RecoveryAction::QueryOutcome]);
}

struct ControlledRunner {
    reached: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl Runner for ControlledRunner {
    fn capability_id(&self) -> &str {
        "controlled"
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        _cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        self.reached.send(()).unwrap();
        self.release.lock().unwrap().recv().unwrap();
        // Deliberately ignore cancellation to model a late external response.
        results.send(FixedResult::capture(
            result(&request.input, request.item_id, request.dispatch_token),
            &request.input,
            request.dispatch_token,
        )?)
    }
}

#[test]
fn controlled_runner_can_return_late_without_adopting_or_accessing_storage() {
    let fixed = input();
    let request = DispatchRequest {
        item_id: fixed.envelope().items[0].item_id,
        input: fixed.clone(),
        dispatch_token: ExecutionId::new(),
    };
    let (reached_tx, reached_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let runner = ControlledRunner {
        reached: reached_tx,
        release: Mutex::new(release_rx),
    };
    assert!(matches!(
        runner.query(&request).unwrap(),
        QueryOutcome::Unavailable
    ));
    let cancellation = Cancellation::default();
    let signal = cancellation.clone();
    let (sender, receiver) = result_channel();
    let thread = std::thread::spawn(move || runner.run(request, signal, sender));
    reached_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    cancellation.request();
    release_tx.send(()).unwrap();
    let output = receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    thread.join().unwrap().unwrap();
    assert_eq!(output.envelope().outcome, ExecutionState::Succeeded);
    assert!(cancellation.is_requested());
    // The producer's only observable effect is an immutable output message.
    assert_eq!(fixed.envelope().items.len(), 3);
}

#[test]
fn adoption_identity_binds_exact_unit_results_and_frozen_dependencies() {
    let fixed = input();
    let token = ExecutionId::new();
    let output = FixedResult::capture(
        result(&fixed, fixed.envelope().items[0].item_id, token),
        &fixed,
        token,
    )
    .unwrap();
    let unit = fixed
        .envelope()
        .units
        .iter()
        .find(|u| u.item_ids == vec![output.envelope().item_id])
        .unwrap();
    let mut action = AdoptionAction {
        project_id: fixed.envelope().project_id,
        attempt_id: fixed.envelope().attempt_id,
        action_id: ExecutionId::new(),
        unit_id: unit.unit_id,
        operation: "fixture".into(),
        result_ids: vec![output.envelope().result_id],
        cancellation_revision: Revision::new(0).unwrap(),
        parameters: Value::Null,
    };
    let digest = action.digest(&fixed, &[output.clone()]).unwrap();
    action.parameters = json!({"different":true});
    assert_ne!(digest, action.digest(&fixed, &[output.clone()]).unwrap());
    action.result_ids.push(output.envelope().result_id);
    assert!(action.validate(&fixed, &[output]).is_err());
}

struct FixtureHandler;
impl AdoptionHandler for FixtureHandler {
    fn operation(&self) -> &str {
        "fixture"
    }
    fn prepare(
        &self,
        input: &FixedInput,
        _action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        let input = input.clone();
        let results = results.to_vec();
        Ok(Box::new(move |tx| {
            let mut changes = Vec::new();
            for result in &results {
                let item = input.item(result.envelope().item_id)?;
                let revision: i64 = tx.query_row(
                    "SELECT revision FROM fixture_targets WHERE id = ?1",
                    [&item.scope.id],
                    |row| row.get(0),
                )?;
                if revision != item.dependencies[0].expected_revision.get() as i64 {
                    return Err(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "fixture",
                    ));
                }
                tx.execute("UPDATE fixture_targets SET revision = revision + 1, value = 'applied' WHERE id = ?1", [&item.scope.id])?;
                changes.push(ChangeReference {
                    kind: "fixture".into(),
                    id: item.scope.id.clone(),
                    revision: Revision::new((revision + 1) as u64)?,
                });
            }
            Ok(changes)
        }))
    }
}

#[test]
fn handler_checks_only_relevant_dependencies_within_the_owners_transaction() {
    let mut connection = rusqlite::Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE fixture_targets(id TEXT PRIMARY KEY, revision INTEGER, value TEXT); INSERT INTO fixture_targets VALUES ('a',1,'original'),('b',1,'original'),('c',1,'original');").unwrap();
    let fixed = input();
    let item = fixed
        .envelope()
        .items
        .iter()
        .find(|item| item.scope.id == "a")
        .unwrap();
    let token = ExecutionId::new();
    let output = FixedResult::capture(result(&fixed, item.item_id, token), &fixed, token).unwrap();
    let unit = fixed
        .envelope()
        .units
        .iter()
        .find(|u| u.item_ids == vec![item.item_id])
        .unwrap();
    let action = AdoptionAction {
        project_id: fixed.envelope().project_id,
        attempt_id: fixed.envelope().attempt_id,
        action_id: ExecutionId::new(),
        unit_id: unit.unit_id,
        operation: "fixture".into(),
        result_ids: vec![output.envelope().result_id],
        cancellation_revision: Revision::new(0).unwrap(),
        parameters: Value::Null,
    };
    connection
        .execute("UPDATE fixture_targets SET revision = 2 WHERE id = 'b'", [])
        .unwrap();
    let mutation = FixtureHandler
        .prepare(&fixed, &action, &[output.clone()])
        .unwrap();
    let tx = connection.transaction().unwrap();
    let changes = mutation(&AdoptionTransaction::new(&tx)).unwrap();
    assert_eq!(changes[0].revision.get(), 2);
    tx.rollback().unwrap();
    let value: String = connection
        .query_row(
            "SELECT value FROM fixture_targets WHERE id = 'a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(value, "original");
    connection
        .execute("UPDATE fixture_targets SET revision = 2 WHERE id = 'a'", [])
        .unwrap();
    let mutation = FixtureHandler.prepare(&fixed, &action, &[output]).unwrap();
    let tx = connection.transaction().unwrap();
    assert_eq!(
        mutation(&AdoptionTransaction::new(&tx)).unwrap_err().code,
        ErrorCode::DependencyConflict
    );
    tx.rollback().unwrap();
}
