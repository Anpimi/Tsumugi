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
