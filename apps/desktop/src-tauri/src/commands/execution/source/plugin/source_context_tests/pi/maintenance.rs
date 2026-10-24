//! One installed Pi journey through two independently verified deliveries.
//! Only HTTP model content, the window transport and directory picker are fixtures.
use super::*;
use std::{collections::BTreeSet, sync::Arc};

const FIRST_TEXT: &str = "人工校正的问候 👩🏽‍💻 e\u{301}";
const SECOND_TEXT: &str = "接管后保留的人工校正 👩🏽‍💻 e\u{301}";
const NEIGHBOR_TEXT: &str = "保留的邻项 café 🧭";
const FIRST_TIME: &str = "00:01.000 --> 00:02.000";
const NEXT_TIME: &str = "00:01.000 --> 00:02.500";

fn target(fixture: &Fixture, unit: &Value) -> Value {
    fixture
        .ipc(
            "read_review_target",
            json!({"unitId":unit,"locale":"zh-CN"}),
        )
        .unwrap()
}

fn history(fixture: &Fixture, unit: &Value) -> Value {
    fixture
        .ipc(
            "read_translation_history",
            json!({"unitId":unit,"locale":"zh-CN",
            "afterOrdinal":"0","limit":100}),
        )
        .unwrap()
}

fn save_manual(fixture: &Fixture, unit: &Value, text: &str) -> Value {
    let before = target(fixture, unit);
    let request = json!({"unitId":unit,"locale":"zh-CN",
        "sourceRevisionId":before["sourceRevisionId"],
        "expectedSelectionId":before["selectionId"],"text":text,"actionId":ExecutionId::new()});
    let saved = fixture
        .ipc("save_translation_revision", request.clone())
        .unwrap();
    assert_eq!(
        fixture.ipc("save_translation_revision", request).unwrap(),
        saved
    );
    let current = target(fixture, unit);
    assert_eq!(current["translationText"], text);
    assert_eq!(current["revisionId"], saved["revision"]["revisionId"]);
    assert_eq!(current["selectionId"], saved["selection"]["eventId"]);
    assert_eq!(saved["revision"]["originKind"], "manual");
    saved
}

fn check_current(fixture: &Fixture, unit: &Value) -> Value {
    let before = target(fixture, unit);
    let intent = scoped(
        &fixture.context,
        json!({"unitId":unit,"locale":"zh-CN",
        "expectedBasis":before["basis"],"actionId":ExecutionId::new(),"advisoryChecks":[]}),
    );
    let review = call(&fixture.window, "prepare_review_checks", intent.clone()).unwrap();
    assert_eq!(review["kind"], "plugin");
    let checkers = review["view"]["checkers"].as_array().unwrap();
    assert_eq!(
        checkers.len(),
        1,
        "the installed domain checker is required"
    );
    let executions: Vec<Value> = checkers
        .iter()
        .map(|checker| consent(&fixture.context, checker))
        .collect();
    let checked = fixture
        .ipc(
            "run_review_checks",
            json!({"check":intent,"executions":executions}),
        )
        .unwrap();
    assert_eq!(checked["outcome"], "completed");
    let current = target(fixture, unit);
    let rules = current["currentCheck"]["rules"].as_array().unwrap();
    assert!(
        rules.iter().all(|rule| rule["status"] == "passed"),
        "{current}"
    );
    let actual: BTreeSet<_> = rules
        .iter()
        .map(|rule| rule["rule"].as_str().unwrap())
        .collect();
    assert_eq!(
        actual,
        BTreeSet::from([
            "required-translation",
            "terminology",
            "plugin:webvtt.payload",
            "plugin:webvtt.source-structure"
        ])
    );
    let decision = fixture.ipc("write_review_decision", json!({"decision":{
        "projectId":fixture.context["projectId"],"unitId":unit,"locale":"zh-CN",
        "expectedBasis":current["basis"],"expectedDecisionId":current["currentDecision"]["decisionId"],
        "actor":"Synthetic delivery reviewer","kind":"approve","reason":"",
        "actionId":ExecutionId::new()}})).unwrap();
    assert!(!decision["decisionId"].is_null());
    current["currentCheck"].clone()
}

fn stored_artifact(fixture: &Fixture, release: &Value) -> Vec<u8> {
    let release: ExecutionId = serde_json::from_value(release.clone()).unwrap();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .store
                .release_artifact_by_path(release, "zh-CN", "zh-CN.vtt")
                .unwrap()
                .1
        })
}

fn export(fixture: &Fixture, release: &Value, name: &str, expected: &[u8]) -> Value {
    let directory = fixture.directory.path().join(name);
    std::fs::create_dir(&directory).unwrap();
    let selection = ExecutionId::new();
    let selected = Arc::new(capture::Selection::authorize(directory.clone()).unwrap());
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            sessions
                .active
                .as_mut()
                .unwrap()
                .execution_parts()
                .unwrap()
                .0
                .release
                .select_for_test(selection, selected);
        });
    let preview = fixture
        .ipc(
            "preview_delivery",
            json!({"releaseId":release,"selectionId":selection}),
        )
        .unwrap();
    assert_eq!(
        std::fs::read_dir(&directory).unwrap().count(),
        0,
        "preview is read-only"
    );
    let request = json!({"releaseId":release,"selectionId":selection,"previewId":preview["previewId"],
        "actionId":ExecutionId::new(),"overwriteConflicts":false});
    let receipt = fixture.ipc("export_release", request.clone()).unwrap();
    assert_eq!(receipt["state"], "succeeded");
    assert_eq!(fixture.ipc("export_release", request).unwrap(), receipt);
    assert_eq!(
        std::fs::read(directory.join("zh-CN.vtt")).unwrap(),
        expected
    );
    receipt
}

fn delivery(fixture: &Fixture, units: &[Value], expected: &[u8], name: &str) -> Value {
    let qa: Vec<Value> = units
        .iter()
        .map(|unit| check_current(fixture, unit))
        .collect();
    let eligibility = fixture
        .ipc("read_review_eligibility", json!({"locales":["zh-CN"]}))
        .unwrap();
    assert_eq!(eligibility["ready"], true, "{eligibility}");
    let build_choice = json!({"package":fixture.source_choice.package,"resourceId":"build-profile",
        "environmentDigest":fixture.source_choice.environment_digest});
    let before = fixture.ipc("list_releases", json!({})).unwrap();
    let preflight = fixture
        .ipc(
            "prepare_plugin_build",
            json!({"attemptId":ExecutionId::new(),
        "build":build_choice,"expectedEligibilityBasis":eligibility["basis"],
        "choices":[{"locale":"zh-CN","outputPaths":["zh-CN.vtt"],"configuration":[]}]}),
        )
        .unwrap();
    let build_consent = consent(&fixture.context, &preflight);
    let built = call(&fixture.window, "start_plugin_build", build_consent.clone()).unwrap();
    let result = completed_result(&fixture.window, &fixture.context, &built);
    let detail = fixture
        .ipc(
            "read_execution_attempt",
            json!({"attemptId":built,"offset":0,"limit":10}),
        )
        .unwrap();
    let adoption = fixture
        .ipc(
            "prepare_execution_adoption",
            json!({"attemptId":built,
        "unitId":detail["recovery"]["units"][0]["unitId"],"resultIds":[result],
        "actionId":ExecutionId::new()}),
        )
        .unwrap();
    let action = json!({"actionId":adoption["actionId"]});
    assert!(
        fixture.ipc("adopt_execution", action.clone()).is_err(),
        "a successful builder cannot bypass independent artifact proof"
    );
    let artifact = fixture
        .ipc(
            "prepare_artifact_check",
            json!({"buildAttemptId":built,
        "buildResultId":result,"attemptId":ExecutionId::new(),"build":build_choice}),
        )
        .unwrap();
    let artifact_consent = consent(&fixture.context, &artifact);
    let mut borrowed = artifact_consent.clone();
    borrowed["grantId"] = build_consent["grantId"].clone();
    assert!(
        call(&fixture.window, "start_artifact_check", borrowed).is_err(),
        "independent checker requires its own exact grant"
    );
    let checked = call(&fixture.window, "start_artifact_check", artifact_consent).unwrap();
    assert_ne!(checked, built);
    let checked_result = completed_result(&fixture.window, &fixture.context, &checked);
    let proof = fixture
        .ipc(
            "finish_artifact_check",
            json!({"attemptId":checked,"resultId":checked_result}),
        )
        .unwrap();
    let receipt = fixture.ipc("adopt_execution", action.clone()).unwrap();
    assert_eq!(fixture.ipc("adopt_execution", action).unwrap(), receipt);
    let after = fixture.ipc("list_releases", json!({})).unwrap();
    assert_eq!(
        after.as_array().unwrap().len(),
        before.as_array().unwrap().len() + 1
    );
    let release = after
        .as_array()
        .unwrap()
        .iter()
        .find(|release| {
            !before
                .as_array()
                .unwrap()
                .iter()
                .any(|old| old["releaseId"] == release["releaseId"])
        })
        .unwrap()
        .clone();
    assert_eq!(stored_artifact(fixture, &release["releaseId"]), expected);
    let exported = export(fixture, &release["releaseId"], name, expected);
    json!({"release":release,"buildAttemptId":built,"buildResultId":result,
        "checkerAttemptId":checked,"checkerResultId":checked_result,"proof":proof,
        "adoption":receipt,"qa":qa,"delivery":exported})
}

fn idle(fixture: &Fixture) {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let status = fixture.ipc("execution_status", json!({})).unwrap();
        if status["active"] == false && status["quiescing"] == false {
            return;
        }
        assert!(
            Instant::now() < until,
            "owned producers did not drain: {status}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
#[ignore = "requires independently captured WebVTT/runtime/member artifacts"]
fn installed_pi_first_delivery_and_upstream_maintenance_keep_human_work_and_both_releases() {
    let original = format!(
        "WEBVTT\n\nCueA\n{FIRST_TIME}\n{SOURCE}\n\nCueB\n00:03.000 --> 00:04.000\n{NEIGHBOR}\n\n"
    );
    let mut fixture = Fixture::for_webvtt(&original);
    let peer = Peer::new();
    let (scope, row, _) = fixture.current();
    let (_, contents) = content(&fixture.window, &fixture.context);
    let unchanged = contents["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["occurrence"]["text"] == NEIGHBOR)
        .unwrap()
        .clone();
    let units = vec![row["unitId"].clone(), unchanged["unitId"].clone()];

    let first_plan = fixture.prepare(&peer, true, false);
    let (_, first_generation, shared, http) = fixture.start(&peer, &first_plan);
    assert_eq!(shared["sourceContext"]["facts"][0]["text"], FIRST_TIME);
    let first_capture = fixture.capture(&first_generation, &http);
    http.finish("Pi suggested greeting requiring a human correction");
    fixture.terminal(&first_generation["attemptId"]);
    fixture.saved_candidate(&first_generation["attemptId"]);
    let first_candidate = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":first_generation["attemptId"]}),
        )
        .unwrap();
    assert!(first_candidate["rows"][0]["savedRevisionId"].is_string());
    assert!(
        target(&fixture, &row["unitId"])["selectionId"].is_null(),
        "model completion does not select or approve its candidate"
    );
    let first_manual = save_manual(&fixture, &row["unitId"], FIRST_TEXT);
    let neighbor_manual = save_manual(&fixture, &unchanged["unitId"], NEIGHBOR_TEXT);
    let first_expected = original
        .replace(SOURCE, FIRST_TEXT)
        .replace(NEIGHBOR, NEIGHBOR_TEXT)
        .into_bytes();
    let first_delivery = delivery(&fixture, &units, &first_expected, "first-delivery");
    let first_release = first_delivery["release"]["releaseId"].clone();
    assert_eq!(
        history(&fixture, &row["unitId"])["rows"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    peer.empty();
    idle(&fixture);

    // Re-extract and independently check changed upstream material. Only CueA's
    // timing changes; CueB's text, revision and selected human work must survive.
    let updated = original.replace(FIRST_TIME, NEXT_TIME);
    std::fs::write(fixture.source_directory.join("source.vtt"), &updated).unwrap();
    let (attempt, result, _) = fixture.checked_source();
    let comparison = fixture
        .ipc(
            "read_source_comparison",
            json!({"attemptId":attempt,"resultId":result,
        "base":scope["currentSnapshot"],"filter":"","after":0,"limit":10}),
        )
        .unwrap();
    assert_eq!(comparison["changed"], 1);
    assert_eq!(comparison["unchanged"], 1);
    let change = comparison["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["kind"] == "changed")
        .unwrap();
    assert_eq!(change["old"]["unitId"], row["unitId"]);
    let mut confirmation = comparison["confirmation"].clone();
    confirmation["actor"] = json!("Synthetic maintenance reviewer");
    confirmation["lineage"] = json!([{"newOrdinal":change["new"]["ordinal"],
        "oldOccurrenceId":change["old"]["occurrenceId"],"decision":"continue",
        "reason":"The same explicit cue received an upstream timing correction"}]);
    adopt(
        &fixture.window,
        &fixture.context,
        &attempt,
        &result,
        confirmation,
    );
    let (next_scope, next_row, _) = fixture.current();
    assert_ne!(scope["currentSnapshot"], next_scope["currentSnapshot"]);
    assert_eq!(next_row["unitId"], row["unitId"]);
    assert_ne!(next_row["sourceRevisionId"], row["sourceRevisionId"]);
    let neighbor_target = target(&fixture, &unchanged["unitId"]);
    assert_eq!(
        neighbor_target["sourceRevisionId"],
        unchanged["sourceRevisionId"]
    );
    assert_eq!(
        neighbor_target["revisionId"],
        neighbor_manual["revision"]["revisionId"]
    );
    assert_eq!(
        neighbor_target["selectionId"],
        neighbor_manual["selection"]["eventId"]
    );
    assert_eq!(neighbor_target["translationText"], NEIGHBOR_TEXT);
    let assessment = fixture
        .ipc(
            "read_maintenance_assessment",
            json!({"snapshotId":next_scope["currentSnapshot"],
        "locale":"zh-CN","after":0,"limit":100}),
        )
        .unwrap();
    assert_eq!(assessment["rows"].as_array().unwrap().len(), 2);
    assert_eq!(
        assessment["sourceSnapshotId"],
        next_scope["currentSnapshot"]
    );
    assert_eq!(stored_artifact(&fixture, &first_release), first_expected);

    // The new plan has the current source. Its actual Pi request is held while
    // the user takes over precisely this one-unit scope, then saves the repair.
    let second_plan = fixture.prepare(&peer, true, false);
    let (agent, second_generation, shared, mut http) = fixture.start(&peer, &second_plan);
    assert_eq!(shared["sourceContext"]["facts"][0]["text"], NEXT_TIME);
    let second_capture = fixture.capture(&second_generation, &http);
    let live = fixture
        .ipc(
            "read_work_plan_status",
            json!({"planId":second_plan["planId"]}),
        )
        .unwrap();
    let takeover_request = json!({"actionId":ExecutionId::new(),"planId":second_plan["planId"],
        "expectedGeneration":live["lease"]["generation"],"command":"take-over",
        "confirmed":false,"checkerExecutions":[],"toolExecution":false,
        "applicationToolExecutions":[],"expiresAt":null});
    let taken = fixture
        .ipc("control_work_plan", takeover_request.clone())
        .unwrap();
    assert_eq!(taken["state"], "taken-over");
    assert_eq!(
        fixture.ipc("control_work_plan", takeover_request).unwrap(),
        taken
    );
    let repaired = save_manual(&fixture, &row["unitId"], SECOND_TEXT);
    assert_ne!(
        repaired["revision"]["revisionId"],
        first_manual["revision"]["revisionId"]
    );
    // Cancellation must close the physical socket. A late remote response is
    // not an adoption capability, whether the peer can still buffer its write.
    let late = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 14\r\nConnection: close\r\n\r\ndata: [DONE]\n\n";
    match http.socket.write_all(late) {
        Ok(()) => {}
        Err(error) => assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
            ),
            "{error}"
        ),
    }
    let mut byte = [0];
    assert_eq!(
        http.socket.read(&mut byte).unwrap_or_else(|error| {
            assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
            0
        }),
        0,
        "the cancelled physical Pi request must be disconnected"
    );
    drop(http);
    idle(&fixture);
    let stopped = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":second_generation["attemptId"]}),
        )
        .unwrap();
    assert!(stopped["rows"][0]["savedRevisionId"].is_null(), "{stopped}");
    assert_eq!(stopped["rows"][0]["automation"]["retryable"], false);
    assert!(fixture.ipc("prepare_work_plan_agent_generation", json!({"scopeId":agent["scopeId"],
        "generation":{"taskId":ExecutionId::new(),"attemptId":ExecutionId::new(),"unitIds":[row["unitId"]]}})).is_err());
    peer.empty();
    assert_eq!(
        target(&fixture, &row["unitId"])["revisionId"],
        repaired["revision"]["revisionId"]
    );
    assert_eq!(
        target(&fixture, &unchanged["unitId"])["selectionId"],
        neighbor_manual["selection"]["eventId"]
    );
    let second_expected = updated
        .replace(SOURCE, SECOND_TEXT)
        .replace(NEIGHBOR, NEIGHBOR_TEXT)
        .into_bytes();
    let second_delivery = delivery(&fixture, &units, &second_expected, "second-delivery");
    let second_release = second_delivery["release"]["releaseId"].clone();
    assert_ne!(first_release, second_release);
    assert_ne!(
        first_delivery["buildAttemptId"],
        second_delivery["buildAttemptId"]
    );
    assert_ne!(
        first_delivery["checkerAttemptId"],
        second_delivery["checkerAttemptId"]
    );
    assert_eq!(stored_artifact(&fixture, &first_release), first_expected);
    assert_eq!(
        std::fs::read(fixture.directory.path().join("first-delivery/zh-CN.vtt")).unwrap(),
        first_expected
    );
    let releases = fixture.ipc("list_releases", json!({})).unwrap();
    let saved_history = history(&fixture, &row["unitId"]);
    assert!(
        saved_history["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|revision| revision["revisionId"] == first_manual["revision"]["revisionId"])
    );

    fixture.ipc("quiesce_execution", json!({})).unwrap();
    idle(&fixture);
    call(
        &fixture.window,
        "close_project",
        json!({"sessionToken":fixture.context["sessionToken"]}),
    )
    .unwrap();
    let opened = call(
        &fixture.window,
        "open_project",
        json!({"locator":fixture.directory.path().join("project")}),
    )
    .unwrap();
    fixture.context =
        json!({"sessionToken":opened["sessionToken"],"projectId":opened["metadata"]["projectId"]});
    assert_eq!(fixture.ipc("list_releases", json!({})).unwrap(), releases);
    assert_eq!(history(&fixture, &row["unitId"]), saved_history);
    assert_eq!(
        fixture.captures(&first_generation["attemptId"]),
        vec![first_capture]
    );
    assert_eq!(
        fixture.captures(&second_generation["attemptId"]),
        vec![second_capture]
    );
    assert_eq!(
        target(&fixture, &row["unitId"])["revisionId"],
        repaired["revision"]["revisionId"]
    );
    assert_eq!(
        target(&fixture, &unchanged["unitId"])["selectionId"],
        neighbor_manual["selection"]["eventId"]
    );
    assert_eq!(stored_artifact(&fixture, &first_release), first_expected);
    assert_eq!(stored_artifact(&fixture, &second_release), second_expected);
    export(
        &fixture,
        &first_release,
        "reopened-first-delivery",
        &first_expected,
    );
    export(
        &fixture,
        &second_release,
        "reopened-second-delivery",
        &second_expected,
    );
    peer.empty();
    eprintln!(
        "two-delivery evidence: {}",
        json!({"first":first_delivery,"second":second_delivery,
        "firstSnapshot":scope["currentSnapshot"],"secondSnapshot":next_scope["currentSnapshot"],
        "firstPi":first_generation,"secondPi":second_generation,"takeOver":taken})
    );
}
