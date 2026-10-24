use super::*;
use serde_json::json;

#[test]
fn human_tool_recovery_never_extends_either_original_deadline() {
    let now = now_ms().unwrap();
    let mut intent = HumanToolIntent {
        application_leases: BTreeMap::new(),
        fingerprint: vec![],
        generation: ExecutionId::new(),
        wall_deadline_ms: now + 600_000,
        deadline: Instant::now() + Duration::from_secs(30),
    };
    let recovered_expiry = intent.expiry().unwrap();
    assert!(recovered_expiry <= now_ms().unwrap() + 30_000);
    assert!(recovered_expiry <= intent.wall_deadline_ms);
    intent.deadline = Instant::now() - Duration::from_secs(1);
    assert!(intent.expiry().is_err());
    intent.deadline = Instant::now() + Duration::from_secs(30);
    intent.wall_deadline_ms = now_ms().unwrap() - 1;
    assert!(intent.expiry().is_err());
}

#[test]
fn selectors_and_agent_queries_have_no_payload_or_authorizer_port() {
    let selector = json!({"package":{"plugin":{"publisher":"org.example","id":"terms","version":"0.1.0"},"packageDigest":"a".repeat(64)},"resourceId":"query","environmentDigest":"b".repeat(64)});
    let selection = json!({"maxInvocations":2,"entries":[{"handle":ExecutionId::new(),"tool":selector,"target":"zh-CN","selections":["terms"]}]});
    assert!(serde_json::from_value::<WorkPlanToolSelection>(selection.clone()).is_ok());
    for field in [
        "binding",
        "environment",
        "origin",
        "payload",
        "caller",
        "permission",
        "expiresAt",
    ] {
        let mut forged = selection.clone();
        forged["entries"][0][field] = json!(true);
        assert!(
            serde_json::from_value::<WorkPlanToolSelection>(forged).is_err(),
            "{field}"
        );
    }
    let prepare = json!({"sessionToken":"synthetic-session","projectId":ExecutionId::new(),"scopeId":ExecutionId::new(),"tool":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"toolHandle":ExecutionId::new(),"unitIds":[ExecutionId::new()]}});
    let mut start = prepare.clone();
    start["inputDigest"] = json!("c".repeat(64));
    assert!(serde_json::from_value::<WorkPlanAgentToolPrepareRequest>(prepare.clone()).is_ok());
    assert!(serde_json::from_value::<WorkPlanAgentToolStartRequest>(start.clone()).is_ok());
    for field in [
        "text",
        "payload",
        "caller",
        "callerId",
        "permission",
        "confirmed",
        "grantId",
        "expiresAtMs",
        "lease",
        "binding",
    ] {
        for nested in [false, true] {
            let mut forged = prepare.clone();
            if nested {
                forged["tool"][field] = json!(true);
            } else {
                forged[field] = json!(true);
            }
            assert!(
                serde_json::from_value::<WorkPlanAgentToolPrepareRequest>(forged).is_err(),
                "{field}"
            );
            let mut forged = start.clone();
            if nested {
                forged["tool"][field] = json!(true);
            } else {
                forged[field] = json!(true);
            }
            assert!(
                serde_json::from_value::<WorkPlanAgentToolStartRequest>(forged).is_err(),
                "{field}"
            );
        }
    }
}
