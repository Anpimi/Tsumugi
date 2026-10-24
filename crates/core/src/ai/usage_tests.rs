use super::*;

fn usage(prompt: u64, completion: u64, details: [Option<u64>; 3]) -> Usage {
    Usage {
        prompt_tokens: prompt,
        completion_tokens: completion,
        cache_read_tokens: details[0].map(UnsignedDecimal::from),
        cache_write_tokens: details[1].map(UnsignedDecimal::from),
        reasoning_tokens: details[2].map(UnsignedDecimal::from),
    }
}

fn details(value: &Usage) -> [Option<u64>; 3] {
    [
        value.cache_read_tokens.map(UnsignedDecimal::get),
        value.cache_write_tokens.map(UnsignedDecimal::get),
        value.reasoning_tokens.map(UnsignedDecimal::get),
    ]
}

fn request_usage(store: &ProjectStore, id: ExecutionId) -> Option<Vec<u8>> {
    rusqlite::Connection::open_with_flags(
        store.directory().join("project.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
    .query_row(
        "SELECT usage FROM execution_provider_requests WHERE request_id=?1",
        [id.to_string()],
        |row| row.get(0),
    )
    .unwrap()
}

#[test]
fn usage_details_original_ledger_preserves_partial_reports_and_ancestry() {
    let (temp, mut store, rows) = source_project();
    let mut configuration = config("http://127.0.0.1:9/v1/chat/completions".into());
    configuration.max_requests = 7;
    let preview = store
        .preview_ai(configuration, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap();
    let project = store.metadata().unwrap().project_id();
    let root = preview.fixed_input(project).unwrap();
    let child = preview.fixed_input(project).unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register_with_policy(
            Arc::new(AiRunner::default()),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();
    runtime.submit(&mut store, &root).unwrap();
    runtime
        .submit_child(&mut store, &child, root.envelope().task_id)
        .unwrap();
    let root_dispatch = store
        .dispatch_execution_item(root.envelope().attempt_id, root.envelope().items[0].item_id)
        .unwrap();
    let child_dispatch = store
        .dispatch_execution_item(
            child.envelope().attempt_id,
            child.envelope().items[0].item_id,
        )
        .unwrap();
    let ids = [
        ExecutionId::new(),
        ExecutionId::new(),
        ExecutionId::new(),
        ExecutionId::new(),
    ];
    let zero = usage(10, 4, [Some(0), Some(0), Some(0)]);
    let partial = usage(8, 3, [None, Some(2), Some(1)]);
    let missing = usage(2, 1, [None; 3]);
    for (request, id, report) in [
        (&root_dispatch, ids[0], Some(zero.clone())),
        (&child_dispatch, ids[1], Some(partial.clone())),
        (&child_dispatch, ids[2], None),
        (&child_dispatch, ids[3], Some(missing)),
    ] {
        store.reserve_provider_request(request, id, 7).unwrap();
        if report.is_none() {
            let before = store.provider_budget(root.envelope().task_id).unwrap();
            for invalid in [
                usage(10, 4, [Some(11), None, None]),
                usage(10, 4, [None, Some(11), None]),
                usage(10, 4, [None, None, Some(5)]),
            ] {
                assert_eq!(
                    store
                        .settle_provider_request(request, id, Some(invalid))
                        .unwrap_err()
                        .code,
                    ErrorCode::OutputInvalid
                );
                assert_eq!(
                    store.provider_budget(root.envelope().task_id).unwrap(),
                    before
                );
                assert_eq!(request_usage(&store, id), None);
            }
        }
        store.settle_provider_request(request, id, report).unwrap();
    }
    let budget = store
        .provider_budget(root.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            budget.limit,
            budget.dispatched,
            budget.legacy_held,
            budget.unresolved,
            budget.usage_unknown
        ),
        (7, 4, 0, 0, 1)
    );
    assert_eq!(
        (&*budget.prompt_tokens, &*budget.completion_tokens),
        ("20", "8")
    );
    assert_eq!(
        (
            &*budget.cache_read.tokens,
            budget.cache_read.unknown_requests
        ),
        ("0", 3)
    );
    assert_eq!(
        (
            &*budget.cache_write.tokens,
            budget.cache_write.unknown_requests
        ),
        ("2", 2)
    );
    assert_eq!(
        (&*budget.reasoning.tokens, budget.reasoning.unknown_requests),
        ("1", 2)
    );
    let child_budget = store
        .provider_budget(child.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (child_budget.dispatched, child_budget.usage_unknown),
        (3, 1)
    );
    assert_eq!(
        (
            &*child_budget.prompt_tokens,
            &*child_budget.completion_tokens
        ),
        ("10", "4")
    );
    assert_eq!(child_budget.cache_read.unknown_requests, 3);
    assert_eq!(
        codec::decode::<Usage>(&request_usage(&store, ids[0]).unwrap(), 1024).unwrap(),
        zero
    );
    assert_eq!(
        codec::decode::<Usage>(&request_usage(&store, ids[1]).unwrap(), 1024).unwrap(),
        partial
    );

    // An exact receipt is idempotent; neither an absent nor conflicting receipt merges fields.
    store
        .settle_provider_request(&root_dispatch, ids[0], Some(zero.clone()))
        .unwrap();
    store
        .settle_provider_request(&root_dispatch, ids[0], None)
        .unwrap();
    for changed in [
        usage(10, 4, [Some(1), Some(0), Some(0)]),
        usage(10, 4, [None, Some(0), Some(0)]),
    ] {
        let error = store
            .settle_provider_request(&root_dispatch, ids[0], Some(changed))
            .unwrap_err();
        assert_eq!(
            (error.code, error.stage.as_str()),
            (ErrorCode::ResultMismatch, "provider-usage-conflict")
        );
    }
    assert_eq!(
        store
            .provider_budget(root.envelope().task_id)
            .unwrap()
            .unwrap(),
        budget
    );
    assert_eq!(
        codec::decode::<Usage>(&request_usage(&store, ids[0]).unwrap(), 1024).unwrap(),
        zero
    );

    // A valid original-request sum can exceed u64 without narrowing or wrapping.
    for _ in 0..3 {
        let id = ExecutionId::new();
        let report = usage(
            i64::MAX as u64,
            6,
            [Some(i64::MAX as u64), Some(i64::MAX as u64), Some(6)],
        );
        store
            .reserve_provider_request(&root_dispatch, id, 7)
            .unwrap();
        store
            .settle_provider_request(&root_dispatch, id, Some(report))
            .unwrap();
    }
    let budget = store
        .provider_budget(root.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(budget.dispatched, 7);
    assert_eq!(budget.prompt_tokens, "27670116110564327441");
    assert_eq!(budget.cache_read.tokens, "27670116110564327421");
    assert_eq!(budget.cache_write.tokens, "27670116110564327423");
    assert_eq!(
        (
            budget.cache_read.unknown_requests,
            budget.cache_write.unknown_requests,
            budget.reasoning.unknown_requests
        ),
        (3, 2, 2)
    );
    assert_eq!(
        (&*budget.completion_tokens, &*budget.reasoning.tokens),
        ("26", "19")
    );

    // Corrupt durable detail values are rejected by both historical validation and projection.
    let saved = request_usage(&store, ids[0]).unwrap();
    let corrupt = codec::encode(&usage(10, 4, [Some(11), None, None]), 1024).unwrap();
    let connection = rusqlite::Connection::open(store.directory().join("project.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE execution_provider_requests SET usage=?1 WHERE request_id=?2",
            rusqlite::params![corrupt, ids[0].to_string()],
        )
        .unwrap();
    assert!(store.provider_budget(root.envelope().task_id).is_err());
    drop(connection);
    drop(runtime);
    store.close().unwrap();
    assert!(ProjectStore::open(temp.path().join("project")).is_err());
    let connection =
        rusqlite::Connection::open(temp.path().join("project/project.sqlite3")).unwrap();
    connection
        .execute(
            "UPDATE execution_provider_requests SET usage=?1 WHERE request_id=?2",
            rusqlite::params![saved, ids[0].to_string()],
        )
        .unwrap();
    drop(connection);
    let reopened = ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(
        reopened
            .provider_budget(root.envelope().task_id)
            .unwrap()
            .unwrap(),
        budget
    );
    assert_eq!(
        reopened
            .provider_budget(child.envelope().task_id)
            .unwrap()
            .unwrap(),
        child_budget
    );
    assert_eq!(
        codec::decode::<Usage>(&request_usage(&reopened, ids[1]).unwrap(), 1024).unwrap(),
        partial
    );
}

#[test]
fn usage_details_json_reports_are_strict_nullable_subsets() {
    let base = json!({"prompt_tokens":10,"completion_tokens":6});
    assert_eq!(details(&reported_usage(&base, 10).unwrap()), [None; 3]);
    for (report, expected) in [
        (
            json!({"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":10},"completion_tokens_details":{"reasoning_tokens":0}}),
            [Some(0), Some(10), Some(0)],
        ),
        (
            json!({"prompt_tokens_details":{"cached_tokens":10,"cache_write_tokens":10},"completion_tokens_details":{"reasoning_tokens":6}}),
            [Some(10), Some(10), Some(6)],
        ),
        (
            json!({"prompt_tokens_details":{"cached_tokens":null},"prompt_cache_hit_tokens":2,"cached_tokens":3}),
            [Some(2), None, None],
        ),
        (
            json!({"prompt_cache_hit_tokens":null,"cached_tokens":3}),
            [Some(3), None, None],
        ),
        (
            json!({"prompt_tokens_details":{"cached_tokens":"0","cache_write_tokens":-1},"prompt_cache_hit_tokens":2,"completion_tokens_details":{"reasoning_tokens":1.5}}),
            [None; 3],
        ),
        (
            json!({"prompt_tokens_details":{"cached_tokens":11,"cache_write_tokens":11},"completion_tokens_details":{"reasoning_tokens":7}}),
            [None; 3],
        ),
        (
            json!({"cache_creation_input_tokens":2,"cache_read_input_tokens":2,"reasoning_tokens":2}),
            [None; 3],
        ),
    ] {
        let mut value = base.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(report.as_object().unwrap().clone());
        let parsed = reported_usage(&value, 10).unwrap();
        assert_eq!((parsed.prompt_tokens, parsed.completion_tokens), (10, 6));
        assert_eq!(details(&parsed), expected);
        parsed.validate().unwrap();
    }
    for invalid in [json!(-1), json!(1.5), json!("10"), Value::Null] {
        let mut value = base.clone();
        value["prompt_tokens"] = invalid;
        assert!(reported_usage(&value, 10).is_none());
    }
    assert!(reported_usage(&json!({"prompt_tokens":10,"completion_tokens":11}), 10).is_none());
    let exact = usage(u64::MAX, u64::MAX, [Some(u64::MAX); 3]);
    let encoded = serde_json::to_value(&exact).unwrap();
    assert_eq!(encoded["cacheReadTokens"], u64::MAX.to_string());
    assert_eq!(
        serde_json::from_value::<Usage>(encoded.clone()).unwrap(),
        exact
    );
    for field in ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] {
        let mut absent = encoded.clone();
        absent.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Usage>(absent).is_err());
        for invalid in [
            json!(0),
            json!(-1),
            json!(0.5),
            json!("00"),
            json!("-1"),
            json!("1.0"),
            json!("18446744073709551616"),
        ] {
            let mut value = encoded.clone();
            value[field] = invalid;
            assert!(serde_json::from_value::<Usage>(value).is_err());
        }
    }
    let unknown = usage(0, 0, [None; 3]);
    assert!(serde_json::to_value(&unknown).unwrap()["cacheReadTokens"].is_null());
    assert!(exact.validate_aggregate(true).is_err());
    unknown.validate_aggregate(true).unwrap();
    let frame = crate::ai::member_wire::MemberFrame {
        protocol_version: crate::ai::member_wire::PROTOCOL,
        session_id: ExecutionId::new(),
        sequence: 0,
        body: crate::ai::member_wire::MemberBody::Request {
            request: 1,
            call: crate::ai::member_wire::MemberCall::Usage {
                request_id: ExecutionId::new(),
                usage: Some(exact),
            },
        },
    };
    let bytes = crate::ai::member_wire::encode_frame(&frame, 4096).unwrap();
    crate::ai::member_wire::decode_frame(&bytes, 4096).unwrap();
    let mut old: Value = serde_json::from_slice(&bytes).unwrap();
    old["protocolVersion"] = json!(2);
    assert!(
        crate::ai::member_wire::decode_frame(&serde_json::to_vec(&old).unwrap(), 4096).is_err()
    );
}

#[test]
fn usage_details_retry_retains_request_report_without_claiming_complete_output() {
    let (_temp, mut store, rows) = source_project();
    let (url, calls, wire) = server("usage-retry");
    let mut configuration = config(url);
    configuration.max_retries = 1;
    let input = store
        .preview_ai(configuration, "zh-CN", &[rows[0].unit_id.unwrap()])
        .unwrap()
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime
        .register_with_policy(
            Arc::new(AiRunner::default()),
            RecoveryPolicy::ExternalUnknown,
        )
        .unwrap();
    runtime.submit(&mut store, &input).unwrap();
    drain(&mut runtime, &mut store, input.envelope().attempt_id);
    let result = store
        .execution_current_result(
            input.envelope().attempt_id,
            input.envelope().items[0].item_id,
        )
        .unwrap()
        .unwrap();
    let output = super::super::validate_output(
        &input,
        &store
            .execution_result(input.envelope().attempt_id, result)
            .unwrap(),
    )
    .unwrap();
    assert_eq!((output.requests, output.usage_incomplete), (2, true));
    let usage = output.usage.unwrap();
    assert_eq!((usage.prompt_tokens, usage.completion_tokens), (40, 10));
    assert_eq!(details(&usage), [None; 3]);
    let budget = store
        .provider_budget(input.envelope().task_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (budget.dispatched, budget.usage_unknown, budget.unresolved),
        (2, 1, 0)
    );
    assert_eq!(
        (
            &*budget.cache_read.tokens,
            budget.cache_read.unknown_requests
        ),
        ("0", 1)
    );
    assert_eq!(
        (
            &*budget.cache_write.tokens,
            budget.cache_write.unknown_requests
        ),
        ("7", 1)
    );
    assert_eq!(
        (&*budget.reasoning.tokens, budget.reasoning.unknown_requests),
        ("3", 1)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(wire.join().unwrap().len(), 2);
}
