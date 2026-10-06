use super::*;

#[test]
fn review_preflight_wire_preserves_checker_consent_and_original_action() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/reviewCommands.contract.json"
    ))
    .unwrap();
    let start: ReviewCheckStartRequest =
        serde_json::from_value(fixture["requests"]["check"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(start).unwrap(),
        fixture["requests"]["check"]
    );
    let view: ReviewCheckPreparation =
        serde_json::from_value(fixture["responses"]["prepareCheck"].clone()).unwrap();
    assert_eq!(
        serde_json::to_value(view).unwrap(),
        fixture["responses"]["prepareCheck"]
    );
    let mut forged = fixture["requests"]["check"].clone();
    forged["execution"]["renewGrant"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ReviewCheckStartRequest>(forged).is_err());
}

#[test]
fn review_native_environment_wire_is_strict_and_preserves_the_profile_owned_digest() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/reviewCommands.contract.json"
    ))
    .unwrap();
    let native: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/nativeRuntime.contract.json"
    ))
    .unwrap();
    let mut value = fixture["responses"]["prepareCheck"].clone();
    value["view"]["plugin"]["environment"] = native;
    value["view"]["plugin"]["environmentDigest"] =
        serde_json::json!("ba38dd6b1f63b641359cf711154563ce9d1616d4790f250e1718bb5c3f570ddd");
    let received: ReviewCheckPreparation = serde_json::from_value(value.clone()).unwrap();
    let ReviewCheckPreparation::Plugin { view } = &received else {
        panic!("plugin preparation");
    };
    view.plugin.environment.validate().unwrap();
    assert_eq!(
        view.plugin.environment.digest().unwrap(),
        view.plugin.environment_digest
    );
    assert_eq!(serde_json::to_value(received).unwrap(), value);
    for (key, extra) in [
        ("toolVersion", serde_json::json!("26.10.0")),
        ("authorization", serde_json::json!(true)),
    ] {
        let mut bad = value.clone();
        bad["view"]["plugin"]["environment"][key] = extra;
        assert!(serde_json::from_value::<ReviewCheckPreparation>(bad).is_err());
    }
}
