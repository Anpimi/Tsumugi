//! Synthetic AI output saved through the ordinary work-plan/ledger/adoption
//! owners. No model or network call is made; domain QA is executed separately.
use tsumugi_core::{AiAdoptionHandler, ProjectStore, application::*, execution::*};

pub fn candidate_request(
    store: &mut ProjectStore,
    unit: ExecutionId,
    text: &str,
    policy: SelectionPolicy,
) -> AutomaticSelectionRequest {
    candidate_request_with_advisory(store, unit, text, policy, &[])
}

pub fn candidate_request_with_advisory(
    store: &mut ProjectStore,
    unit: ExecutionId,
    text: &str,
    policy: SelectionPolicy,
    advisory_checks: &[tsumugi_core::AdvisoryReviewCheck],
) -> AutomaticSelectionRequest {
    let mut options = PlanOptions {
        selection_policy: policy,
        advisory_checks: advisory_checks.to_vec(),
        ..PlanOptions::default()
    };
    options
        .stages
        .iter_mut()
        .find(|s| s.stage == WorkStage::Checks)
        .unwrap()
        .mode = StageMode::Assisted;
    let config = tsumugi_core::ai::AiConfig {
        endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
        model: "synthetic-selection".into(),
        credential_env: String::new(),
        ..Default::default()
    };
    let plan = store
        .prepare_work_plan(Some(config), "zh-CN", &[unit], options)
        .unwrap();
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 600;
    let grant = store
        .authorize_work_plan(
            &plan,
            &AuthorizeWorkPlan {
                action_id: ExecutionId::new(),
                plan_digest: plan.digest.clone(),
                confirmed: true,
                effects: plan.authorization_effects().unwrap(),
                expires_at,
            },
        )
        .unwrap();
    let input = FixedInput::capture(grant.input.unwrap()).unwrap();
    store.enqueue_execution(&input).unwrap();
    let item = input
        .envelope()
        .items
        .iter()
        .find(|item| item.scope.id == unit.to_string())
        .unwrap()
        .item_id;
    let dispatch = store
        .dispatch_execution_item(input.envelope().attempt_id, item)
        .unwrap();
    let result = FixedResult::capture(
        ResultEnvelope {
            plugin: None,
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: item,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: dispatch.dispatch_token,
            capability_id: tsumugi_core::ai::CAPABILITY.into(),
            capability_version: "1".into(),
            outcome: ExecutionState::Succeeded,
            output: Some(
                serde_json::to_value(tsumugi_core::ai::AiOutput {
                    unit_id: unit,
                    target_locale: "zh-CN".into(),
                    text: text.into(),
                    usage: None,
                    requests: 1,
                    usage_incomplete: true,
                })
                .unwrap(),
            ),
            diagnostic: None,
        },
        &input,
        dispatch.dispatch_token,
    )
    .unwrap();
    store.save_execution_result(&result).unwrap();
    store
        .validate_execution_result(input.envelope().attempt_id, result.envelope().result_id)
        .unwrap();
    let recovery_unit = input
        .envelope()
        .units
        .iter()
        .find(|u| u.item_ids.contains(&item))
        .unwrap()
        .unit_id;
    let action = store
        .prepare_adoption(
            input.envelope().attempt_id,
            recovery_unit,
            vec![result.envelope().result_id],
            serde_json::Value::Null,
        )
        .unwrap();
    let receipt = store.adopt_execution(&action, &AiAdoptionHandler).unwrap();
    AutomaticSelectionRequest {
        project_id: input.envelope().project_id,
        action_id: ExecutionId::new(),
        lease: input.envelope().automation.unwrap(),
        unit_id: unit,
        locale: "zh-CN".into(),
        revision_id: ExecutionId::parse(&receipt.changes[0].id).unwrap(),
    }
}
