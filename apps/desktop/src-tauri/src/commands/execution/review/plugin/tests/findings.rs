//! Uses the existing independent, real joint IPC fixture. No fabricated QA rows
//! or report metadata can authorize a finding disposition in this test.
use super::*;

#[test]
fn actual_advisory_finding_ipc_preserves_dispositions_and_current_rechecks_across_reopen() {
    review_phase("findings: start");
    with_joint_review_fixture(|fixture| {
        review_phase("findings: original dispositions and bounded history");
        let facts = record_dispositions(
            fixture.window,
            fixture.context,
            fixture.intent,
            fixture.checked,
        );
        let (context, intent) = reopen_joint_review_fixture(&fixture);
        review_phase("findings: recover original disposition receipts");
        assert_reopened(fixture.window, &context, &facts);
        let context = recheck_repairs(
            fixture.window,
            &context,
            &intent,
            fixture.checked,
            &facts,
            fixture.project_path,
        );
        review_phase("findings: close verified project");
        call(
            fixture.window,
            "close_project",
            Some(json!({"sessionToken":context["sessionToken"]})),
        )
        .unwrap();
    });
    review_phase("findings: complete");
}

fn read(window: &Window, context: &Value, intent: &Value, offset: u32, limit: u32) -> Value {
    call(window,"read_review_findings",Some(scoped(context,json!({"unitId":intent["unitId"],"locale":intent["locale"],"offset":offset,"limit":limit})))).unwrap()
}
fn request(
    context: &Value,
    intent: &Value,
    run: &Value,
    issue: &Value,
    previous: &Value,
    disposition: &str,
) -> Value {
    json!({"projectId":context["projectId"],"actionId":ExecutionId::new(),"unitId":intent["unitId"],"locale":intent["locale"],"expectedBasis":intent["expectedBasis"],"runId":run["runId"],"issueId":issue,"expectedDecisionId":previous,"disposition":disposition,"actor":"Synthetic finding reviewer","reason":"Exact advisory evidence reviewed"})
}
fn write(window: &Window, context: &Value, request: &Value) -> Result<Value, Value> {
    call(
        window,
        "write_review_finding",
        Some(scoped(context, json!({"finding":request}))),
    )
}
pub(super) fn record_dispositions(
    window: &Window,
    context: &Value,
    intent: &Value,
    run: &Value,
) -> Value {
    let initial = read(window, context, intent, 0, 20);
    assert_eq!(initial["findings"].as_array().unwrap().len(), 1);
    assert!(initial["findings"][0]["decision"].is_null());
    let issue = &initial["findings"][0]["finding"]["issueId"];
    let eligibility = call(
        window,
        "read_review_eligibility",
        Some(scoped(context, json!({"locales":["zh-CN"]}))),
    )
    .unwrap();
    let reject = request(context, intent, run, issue, &Value::Null, "rejected");
    let saved = write(window, context, &reject).unwrap();
    assert_eq!(
        write(window, context, &reject).unwrap(),
        saved,
        "exact original action is receipt-first and idempotent"
    );
    let mut mismatch = reject.clone();
    mismatch["reason"] = json!("Changed input using the old identity");
    assert_eq!(
        write(window, context, &mismatch).unwrap_err()["code"],
        "result-mismatch"
    );
    let stale = request(context, intent, run, issue, &Value::Null, "restored");
    assert_eq!(
        write(window, context, &stale).unwrap_err()["code"],
        "dependency-conflict"
    );
    let mut outside = reject.clone();
    outside["projectId"] = json!(ExecutionId::new());
    assert!(
        write(window, context, &outside).is_err(),
        "outer session cannot authorize another project"
    );
    let mut mandatory = request(
        context,
        intent,
        run,
        &json!("f".repeat(64)),
        &Value::Null,
        "rejected",
    );
    mandatory["reason"] = json!("A name cannot invent advisory authority");
    assert_eq!(
        write(window, context, &mandatory).unwrap_err()["code"],
        "permission-denied"
    );
    assert_eq!(
        call(
            window,
            "read_review_eligibility",
            Some(scoped(context, json!({"locales":["zh-CN"]})))
        )
        .unwrap(),
        eligibility
    );
    let restored = write(
        window,
        context,
        &request(
            context,
            intent,
            run,
            issue,
            &saved["decisionId"],
            "restored",
        ),
    )
    .unwrap();
    let repair = write(
        window,
        context,
        &request(
            context,
            intent,
            run,
            issue,
            &restored["decisionId"],
            "repair-requested",
        ),
    )
    .unwrap();
    let pending = read(window, context, intent, 0, 20);
    assert_eq!(pending["repairs"][0]["status"], "awaiting-current-recheck");
    assert!(pending["repairs"][0]["recheckRunId"].is_null());
    assert_eq!(
        pending["findings"][0]["finding"], initial["findings"][0]["finding"],
        "disposition never removes original findings"
    );
    // More than a page of real append-only actions. The older repair remains
    // reachable, including its supersession, without returning every chain.
    let mut previous = repair.clone();
    for index in 0..22 {
        previous = write(
            window,
            context,
            &request(
                context,
                intent,
                run,
                issue,
                &previous["decisionId"],
                if index % 2 == 0 {
                    "rejected"
                } else {
                    "restored"
                },
            ),
        )
        .unwrap();
    }
    let latest = write(
        window,
        context,
        &request(
            context,
            intent,
            run,
            issue,
            &previous["decisionId"],
            "rejected",
        ),
    )
    .unwrap();
    let first = read(window, context, intent, 0, 20);
    assert!(
        first["history"].as_array().unwrap().len() <= 20
            && first["findings"].as_array().unwrap().len() <= 20
            && first["repairs"].as_array().unwrap().len() <= 20
    );
    assert_eq!(first["nextOffset"], 20);
    let later = read(window, context, intent, 20, 20);
    assert!(
        later["history"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["decisionId"] == repair["decisionId"])
    );
    assert_eq!(
        later["repairs"][0]["decision"]["decisionId"],
        repair["decisionId"]
    );
    assert_eq!(later["repairs"][0]["status"], "superseded");
    assert!(later["nextOffset"].is_null());
    assert!(
        read(window, context, intent, 10001, 20)["history"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    json!({"first":saved,"latest":latest,"historyCount":26,"issue":issue,"checkRequest":intent,"checkRun":run})
}
pub(super) fn assert_reopened(window: &Window, context: &Value, facts: &Value) {
    let mut original=facts["checkRequest"].clone();
    original["sessionToken"]=context["sessionToken"].clone();original["projectId"]=context["projectId"].clone();
    let saved=call(window,"read_review_check_action",Some(original.clone())).unwrap();
    assert_eq!(saved["receipt"],facts["checkRun"]);
    assert_eq!(saved["request"]["actionId"],original["actionId"]);
    let selections=original["advisoryChecks"].as_array().unwrap();assert!(!selections.is_empty());
    for (selected,echo) in selections.iter().zip(saved["request"]["advisoryChecks"].as_array().unwrap()) {
        assert_eq!(*echo,json!({"plugin":selected["package"]["plugin"],"packageDigest":selected["package"]["packageDigest"],
            "resourceId":selected["resourceId"],"environmentDigest":selected["environmentDigest"],"rules":selected["rules"]}));
    }
    for field in ["environmentDigest","resourceId"] {
        let mut wrong=original.clone();wrong["advisoryChecks"][0][field]=json!("0".repeat(64));
        assert_eq!(call(window,"read_review_check_action",Some(wrong)).unwrap_err()["code"],"result-mismatch");
    }
    let mut wrong=original.clone();wrong["advisoryChecks"][0]["rules"]=json!([]);
    assert_eq!(call(window,"read_review_check_action",Some(wrong)).unwrap_err()["code"],"result-mismatch");

    for name in ["first", "latest"] {
        assert_eq!(
            call(
                window,
                "read_review_finding_action",
                Some(scoped(
                    context,
                    json!({"actionId":facts[name]["request"]["actionId"]})
                ))
            )
            .unwrap(),
            facts[name]
        );
    }
}
fn recheck(window: &Window, context: &Value, intent: &Value) -> Value {
    let prepared = super::currentness::prepare_with_store_retry(window, intent);
    let grants = prepared["view"]["checkers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| consent(context, slot))
        .collect::<Vec<_>>();
    call(
        window,
        "run_review_checks",
        Some(scoped(context, json!({"check":intent,"executions":grants}))),
    )
    .unwrap()
}
pub(super) fn recheck_repairs(
    window: &Window,
    context: &Value,
    intent: &Value,
    original: &Value,
    facts: &Value,
    project_path: &Path,
) -> Value {
    review_phase("findings: same complete evidence recheck");
    let mut repeat = intent.clone();
    repeat["actionId"] = json!(ExecutionId::new());
    let repeated = recheck(window, context, &repeat);
    assert_ne!(repeated["runId"], original["runId"]);
    let same = read(window, context, intent, 0, 20);
    assert_eq!(same["runId"], repeated["runId"]);
    assert_eq!(same["findings"][0]["finding"]["issueId"], facts["issue"]);
    assert_eq!(
        same["findings"][0]["decision"], facts["latest"],
        "same complete evidence associates the earlier human decision across runs"
    );
    let restored = write(
        window,
        context,
        &request(
            context,
            intent,
            &repeated,
            &facts["issue"],
            &facts["latest"]["decisionId"],
            "restored",
        ),
    )
    .unwrap();
    let repair = write(
        window,
        context,
        &request(
            context,
            intent,
            &repeated,
            &facts["issue"],
            &restored["decisionId"],
            "repair-requested",
        ),
    )
    .unwrap();
    assert_eq!(
        read(window, context, intent, 0, 20)["repairs"][0]["status"],
        "awaiting-current-recheck"
    );
    let target = call(
        window,
        "read_review_target",
        Some(scoped(
            context,
            json!({"unitId":intent["unitId"],"locale":intent["locale"]}),
        )),
    )
    .unwrap();
    call(window,"save_translation_revision",Some(scoped(context,json!({"unitId":intent["unitId"],"locale":intent["locale"],"sourceRevisionId":target["sourceRevisionId"],"expectedSelectionId":target["selectionId"],"text":"👩🏽‍💻 é 仍需修复 前提","actionId":ExecutionId::new()})))).unwrap();
    let edited = call(
        window,
        "read_review_target",
        Some(scoped(
            context,
            json!({"unitId":intent["unitId"],"locale":intent["locale"]}),
        )),
    )
    .unwrap();
    assert_ne!(edited["basis"], target["basis"]);
    assert_eq!(
        read(window, context, intent, 0, 20)["repairs"][0]["status"],
        "awaiting-current-recheck",
        "saving an edit cannot close the repair request"
    );
    assert_eq!(
        write(window, context, &facts["first"]["request"]).unwrap(),
        facts["first"],
        "old original action still recovers after basis changes"
    );
    let mut still_open = repeat.clone();
    still_open["actionId"] = json!(ExecutionId::new());
    still_open["expectedBasis"] = edited["basis"].clone();
    // The first edited translation still lacks the resource's preferred form.
    // Its new finding must not inherit the old rejection or be closed by a save.
    review_phase("findings: changed evidence recheck");
    recheck(window, context, &still_open);
    let recurring = read(window, context, &still_open, 0, 20);
    assert_eq!(recurring["repairs"][0]["status"], "current-rule-findings");
    assert_ne!(
        recurring["findings"][0]["finding"]["issueId"],
        facts["issue"]
    );
    assert!(
        recurring["findings"][0]["decision"].is_null(),
        "new evidence stays undecided, even with the same finding code"
    );
    let unfinished_save = json!({"unitId":intent["unitId"],"locale":intent["locale"],"sourceRevisionId":edited["sourceRevisionId"],"expectedSelectionId":edited["selectionId"],"text":"👩🏽‍💻 é 可靠性 前提","actionId":ExecutionId::new()});
    call(
        window,
        "save_translation_revision",
        Some(scoped(context, unfinished_save)),
    )
    .unwrap();
    let fixed_target = call(
        window,
        "read_review_target",
        Some(scoped(
            context,
            json!({"unitId":intent["unitId"],"locale":intent["locale"]}),
        )),
    )
    .unwrap();
    assert_eq!(
        read(window, context, intent, 0, 20)["repairs"][0]["status"],
        "awaiting-current-recheck"
    );
    let mut fixed = repeat.clone();
    fixed["actionId"] = json!(ExecutionId::new());
    fixed["expectedBasis"] = fixed_target["basis"].clone();
    review_phase("findings: repaired content recheck");
    let checked = recheck(window, context, &fixed);
    let current = read(window, context, &fixed, 0, 20);
    assert_eq!(
        current["repairs"][0]["decision"]["decisionId"],
        repair["decisionId"]
    );
    assert_eq!(current["repairs"][0]["recheckRunId"], checked["runId"]);
    assert_eq!(
        current["repairs"][0]["status"], "current-rule-clear",
        "only the actual current rule result closes this rule's repair work"
    );
    assert!(current["findings"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            window,
            "read_review_eligibility",
            Some(scoped(context, json!({"locales":["zh-CN"]})))
        )
        .unwrap()["ready"],
        false,
        "a repaired check does not approve a newly selected revision"
    );
    review_phase("findings: reopen final history and derived repair state");
    call(window, "quiesce_execution", Some(context.clone())).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while call(window, "execution_status", Some(context.clone())).unwrap()["active"] == true {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    call(
        window,
        "close_project",
        Some(json!({"sessionToken":context["sessionToken"]})),
    )
    .unwrap();
    let reopened = call(
        window,
        "open_project",
        Some(json!({"locator":project_path})),
    )
    .unwrap();
    let context = json!({"sessionToken":reopened["sessionToken"],"projectId":context["projectId"]});
    assert_reopened(window, &context, facts);
    assert_eq!(
        read(window, &context, &fixed, 0, 20),
        current,
        "finding history and derived repair state survive reopening"
    );
    context
}
