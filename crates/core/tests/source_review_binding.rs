#![cfg(not(feature = "execution-test-host"))]
//! Normal Core persists the source's adopted domain QA selection. The synthetic
//! source producer/checker fixture proves SQLite/data behavior, not domain QA.
mod support;
use tsumugi_core::{ProjectStore, content::SourceSettings, execution::*};
use tsumugi_plugin_sdk as sdk;

#[test]
fn adopted_source_review_rules_and_runtime_survive_reopen_without_new_grants() {
    let (directory, store, _) = support::source_fixture();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let bound = store.source_review_binding(snapshot).unwrap().unwrap();
    assert_eq!(bound.declaration.rules.len(), 1);
    assert_eq!(
        bound.declaration.rules[0].rule.id,
        "example.review-semantics"
    );
    assert_eq!(bound.declaration.rules[0].rule.behavior_version, 1);
    assert_eq!(
        bound.checker.capability.provider.contribution_id,
        "review-check"
    );
    assert_eq!(
        bound.checker.capability.provider.package_digest,
        "a".repeat(64)
    );
    let sdk::ExecutionEnvironmentDescriptor::Captured(environment) = &bound.checker.environment
    else {
        panic!("captured Node fixture");
    };
    assert_eq!(environment.tool.tree_digest, "b".repeat(64));
    assert_eq!(environment.host.tree_digest, "c".repeat(64));
    let before = serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap();
    assert_eq!(
        store.source_review_binding(snapshot).unwrap(),
        Some(bound.clone())
    );
    assert_eq!(
        serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap(),
        before
    );
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    let reopened_before =
        serde_json::to_value(reopened.changes_since(Revision::new(0).unwrap())).unwrap();
    assert_ne!(reopened_before["epoch"], before["epoch"]);
    assert_eq!(
        reopened.source_review_binding(snapshot).unwrap(),
        Some(bound)
    );
    assert_eq!(
        serde_json::to_value(reopened.changes_since(Revision::new(0).unwrap())).unwrap(),
        reopened_before
    );
}

#[test]
fn normal_source_refuses_missing_or_substituted_review_binding_without_writes() {
    let (_directory, mut store, _) = support::source_fixture();
    let original = support::source_input(&store);
    let before = serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap();
    for scenario in 0..5 {
        let mut envelope = original.envelope().clone();
        envelope.attempt_id = ExecutionId::new();
        match scenario {
            0 => envelope.settings["review"] = serde_json::Value::Null,
            1 => {
                envelope.settings["review"]["checker"]["capability"]["provider"]["packageDigest"] =
                    serde_json::json!("d".repeat(64))
            }
            2 => envelope.settings["review"]["declaration"]["rules"] = serde_json::json!([]),
            3 => {
                envelope.settings["review"]["declaration"]["profile"]["behaviorVersion"] =
                    serde_json::json!(2)
            }
            _ => {
                envelope.settings["review"]["checker"]["environment"]["tool"]["treeDigest"] =
                    serde_json::json!("bad-digest")
            }
        }
        let input = FixedInput::capture(envelope).unwrap();
        assert!(
            SourceSettings::from_input(&input).is_err(),
            "case {scenario}"
        );
        assert!(store.enqueue_execution(&input).is_err(), "case {scenario}");
        assert_eq!(
            serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap(),
            before
        );
    }
}
