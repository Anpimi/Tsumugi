use tsumugi_plugin_sdk::*;
#[test]
fn framed_protocol_validates_exact_version_direction_data_and_duplicate_fields() {
    let cancellation = ProcessFrame::new(ProcessBody::Cancel {
        dispatch_id: "dispatch-a".into(),
    })
    .encode()
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&cancellation).unwrap()["body"]["data"],
        serde_json::json!({"dispatchId":"dispatch-a"})
    );
    let bytes = ProcessFrame::new(ProcessBody::Ping {
        nonce: "nonce-a".into(),
    })
    .encode()
    .unwrap();
    assert_eq!(
        parse_process_frame(&bytes).unwrap().body,
        ProcessBody::Ping {
            nonce: "nonce-a".into()
        }
    );
    for bytes in [br#"{"protocolVersion":2,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#.as_slice(),br#"{"protocolVersion":1,"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"nonce-a"}}}"#,br#"{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":"nonce-a","unknown":true}}}"#,br#"{"protocolVersion":1,"body":{"kind":"ping","data":{"nonce":""}}}"#] {
        assert!(parse_process_frame(bytes).is_err());
    }
    assert!(parse_process_frame(&vec![b'x'; MAX_EXCHANGE_BYTES + 1]).is_err());
}
#[test]
fn logical_package_paths_reject_traversal_and_nonportable_separators() {
    validate_package_path("packages/query/worker.mjs").unwrap();
    for path in [
        "../outside",
        "/outside",
        "a/../b",
        "a\\b",
        "C:outside",
        "a//b",
    ] {
        assert!(validate_package_path(path).is_err());
    }
}
