#![cfg(not(feature = "execution-test-host"))]
//! Default Core rejects the former built-in build contract before persistence.
mod support;
use support::source_fixture;
use tsumugi_core::execution::*;

#[test]
fn production_build_rejects_complete_built_in_input_without_writes() {
    let (_directory, mut store, rows) = source_fixture();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let bundle = store.source_bundle(snapshot).unwrap();
    // This independently captured former wire shape requires no legacy Rust
    // builder. Its source files and occurrences are complete and exact.
    let item = InputItem::new(
        Scope {
            kind: "locale-artifact".into(),
            id: "i18n/zh.json".into(),
            locale: Some("zh-CN".into()),
        },
        serde_json::json!(0),
        vec![],
    );
    let mut envelope = InputEnvelope::new(
        store.metadata().unwrap().project_id(),
        "locale-build",
        "stardew-smapi.locale-build",
        "1",
        vec![item],
    )
    .unwrap();
    envelope.units = vec![AdoptionUnit::new(
        envelope.items.iter().map(|i| i.item_id).collect(),
    )];
    envelope.settings = serde_json::json!({
        "version":1,"projectId":envelope.project_id,"sourceSnapshotId":snapshot,
        "policyVersion":"balanced-1","eligibilityBasis":"0".repeat(64),
        "pluginId":"stardew-smapi","pluginVersion":"0.1.0",
        "builderVersion":"smapi-locale-build-1","validatorVersion":"smapi-locale-artifact-1",
        "sourceFiles":bundle.files.iter().map(|f| serde_json::json!({"logicalPath":f.logical_path,"sha256":f.sha256})).collect::<Vec<_>>(),
        "locales":[{"locale":"zh-CN","fileName":"i18n/zh.json","entries":rows.iter().map(|row| serde_json::json!({
            "ordinal":row.occurrence.ordinal,"unitId":row.unit_id.unwrap(),"sourceRevisionId":row.source_revision_id.unwrap(),
            "nativeKey":row.occurrence.key,"sourceText":row.occurrence.text,"value":row.occurrence.text,
            "selectionId":null,"revisionId":null,"fallbackId":ExecutionId::new(),"decisionId":null,
            "checkId":ExecutionId::new(),"waiverIds":[]
        })).collect::<Vec<_>>()}]
    });
    let input = FixedInput::capture(envelope).unwrap();
    let zero = Revision::new(0).unwrap();
    let before = serde_json::to_value(store.changes_since(zero)).unwrap();
    let error = store.enqueue_execution(&input).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidInput);
    assert_eq!(error.stage, "build-plugin-required");
    assert_eq!(
        serde_json::to_value(store.changes_since(zero)).unwrap(),
        before
    );
    assert_eq!(
        store
            .execution_input(input.envelope().attempt_id)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}
