//! Installed caption time facts reach Pi only through explicitly shared input.
use super::*;

fn time_projection(time: &str) -> Value {
    json!({"facts":[{"kind":"time","text":time,"origin":{"kind":"extracted"}}],
        "neighbors":[{"text":NEIGHBOR,"directions":["after"]}]})
}

fn assert_caption_context(
    fixture: &Fixture,
    scope: &Value,
    row: &Value,
    page: &Value,
    raw: &str,
    time: &str,
) {
    assert_eq!(page["scope"]["sourceSnapshotId"], scope["currentSnapshot"]);
    assert_eq!(page["scope"]["unitId"], row["unitId"]);
    assert_eq!(page["scope"]["sourceRevisionId"], row["sourceRevisionId"]);
    let (observed_scope, source) = content(&fixture.window, &fixture.context);
    assert_eq!(observed_scope, *scope);
    let artifacts = source["coverage"].as_array().unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["logicalPath"], "source.vtt");
    assert_time_fact(page, raw, time, &artifacts[0]["artifactId"]);
    let byte_start = raw.find(time).unwrap();
    assert!(
        raw[..byte_start].chars().count() < byte_start,
        "the literal time reference must use UTF-8 bytes after a Unicode prefix"
    );
    let next = source["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| candidate["occurrence"]["text"] == NEIGHBOR)
        .unwrap();
    let adjacent = neighbor(page);
    assert_eq!(adjacent["unitId"], next["unitId"]);
    assert_eq!(adjacent["sourceRevisionId"], next["sourceRevisionId"]);
    assert_eq!(adjacent["text"], NEIGHBOR);
    assert_eq!(adjacent["adjacentTo"].as_array().unwrap().len(), 1);
    assert_eq!(
        adjacent["adjacentTo"][0]["occurrenceId"],
        row["occurrenceId"]
    );
    assert_eq!(adjacent["adjacentTo"][0]["direction"], "after");
}

fn assert_caption_privacy(http: &Http, plan: &Value, page: &Value) {
    assert_private_basis_absent(http, plan, page);
    assert!(!http.raw.contains("source.vtt"));
}

#[test]
#[ignore = "requires independently captured WebVTT/runtime/member artifacts"]
fn installed_webvtt_source_context_pi_defaults_share_time_and_keep_history_after_timing_change() {
    let first_time = "00:01.000 --> 00:02.000";
    let second_time = "00:03.000 --> 00:04.000";
    let next_time = "00:01.000 --> 00:02.500";
    let original = format!(
        "\u{feff}WEBVTT captured captions\r\n\r\nNOTE 原始注记 🧵 e\u{301}\r\nLiteral evidence only\r\n\r\nSTYLE\r\n::cue {{ color: lime; }}\r\n\r\nREGION\r\nid:main\r\nwidth:50%\r\n\r\nCueA\r\n{first_time} align:start region:main\r\n{SOURCE}\r\n\r\nCueB\r\n{second_time}\r\n{NEIGHBOR}\r\n"
    );
    let mut fixture = Fixture::for_webvtt(&original);
    let (scope, row, page) = fixture.current();
    assert_caption_context(&fixture, &scope, &row, &page, &original, first_time);
    let peer = Peer::new();

    let off = fixture.prepare_config(fixture.default_config(&peer));
    assert_eq!(
        off["preview"]["config"]["sourceContext"],
        json!({"extracted":false,"inferred":false,"neighbors":false,
            "maxBytes":16384,"maxItems":128})
    );
    assert_eq!(off["preview"]["config"]["shareContext"], false);
    let (_, off_generation, shared, http) = fixture.start(&peer, &off);
    assert_eq!(shared["sourceText"], SOURCE);
    assert!(shared.get("sourceContext").is_none());
    assert!(shared.get("manualContextFacts").is_none());
    assert_eq!(shared["context"], Value::Null);
    assert!(!http.raw.contains(first_time));
    assert!(!http.raw.contains(second_time));
    assert!(!http.raw.contains(NEIGHBOR));
    assert_caption_privacy(&http, &off, &page);
    let off_capture = fixture.capture(&off_generation, &http);
    http.finish("Pi caption candidate without shared time");
    fixture.terminal(&off_generation["attemptId"]);
    fixture.saved_candidate(&off_generation["attemptId"]);

    let selected = fixture.prepare(&peer, true, false);
    assert_eq!(
        selected["preview"]["items"][0]["sourceContext"]["kind"],
        "selected"
    );
    assert_eq!(
        selected["preview"]["config"]["sourceContext"],
        json!({"extracted":true,"inferred":false,"neighbors":true,
            "maxBytes":16384,"maxItems":128})
    );
    assert_eq!(selected["preview"]["config"]["shareContext"], false);
    let (agent, generation, shared, http) = fixture.start(&peer, &selected);
    // Fixture::start also compares this physical Pi user message with the root
    // request. This expected projection is authored from the literal captions.
    assert_eq!(shared["sourceText"], SOURCE);
    assert_eq!(shared["sourceContext"], time_projection(first_time));
    assert!(shared.get("manualContextFacts").is_none());
    assert_eq!(shared["context"], Value::Null);
    assert_caption_privacy(&http, &selected, &page);
    let original_capture = fixture.capture(&generation, &http);
    http.finish("Pi caption candidate with the original time 🧶");
    fixture.terminal(&generation["attemptId"]);
    fixture.saved_candidate(&generation["attemptId"]);
    let original_view = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":generation["attemptId"]}),
        )
        .unwrap();
    let original_result = original_view["rows"][0].clone();
    assert_eq!(
        original_result["output"]["text"],
        "Pi caption candidate with the original time 🧶"
    );
    assert_eq!(
        original_result["item"]["sourceRevisionId"],
        row["sourceRevisionId"]
    );
    assert!(!original_result["savedRevisionId"].is_null());

    let updated = original.replace(first_time, next_time);
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
    let changes = comparison["rows"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    let changed = changes
        .iter()
        .find(|change| change["kind"] == "changed")
        .unwrap();
    assert_eq!(changed["old"]["unitId"], row["unitId"]);
    assert_eq!(changed["new"]["ordinal"], 0);
    assert_eq!(
        changes
            .iter()
            .filter(|change| change["kind"] == "unchanged")
            .count(),
        1
    );
    let mut confirmation = comparison["confirmation"].clone();
    confirmation["actor"] = json!("Synthetic caption reviewer");
    confirmation["lineage"] = json!([{
        "newOrdinal":changed["new"]["ordinal"],"oldOccurrenceId":changed["old"]["occurrenceId"],
        "decision":"continue","reason":"Continue the explicit cue identity after its timing changes"
    }]);
    adopt(
        &fixture.window,
        &fixture.context,
        &attempt,
        &result,
        confirmation,
    );
    let (next_scope, next_row, next_page) = fixture.current();
    assert_ne!(next_scope["currentSnapshot"], scope["currentSnapshot"]);
    assert_eq!(next_row["unitId"], row["unitId"]);
    assert_ne!(next_row["sourceRevisionId"], row["sourceRevisionId"]);
    assert_caption_context(
        &fixture,
        &next_scope,
        &next_row,
        &next_page,
        &updated,
        next_time,
    );
    assert_eq!(neighbor(&next_page)["unitId"], neighbor(&page)["unitId"]);
    assert_eq!(
        neighbor(&next_page)["sourceRevisionId"],
        neighbor(&page)["sourceRevisionId"]
    );
    let stale_context = call(
        &fixture.window,
        "read_source_context",
        context_request(&fixture.context, &scope, &row),
    )
    .unwrap_err();
    assert_eq!(stale_context["reason"], "source-context-snapshot");
    let rejected = fixture
        .ipc(
            "prepare_work_plan_agent_generation",
            json!({"scopeId":agent["scopeId"],"generation":{"taskId":ExecutionId::new(),
                "attemptId":ExecutionId::new(),"unitIds":[row["unitId"]]}}),
        )
        .unwrap_err();
    assert_eq!(rejected["code"], "dependency-conflict");
    assert_eq!(rejected["reason"], "work-plan-evidence");
    assert_eq!(
        fixture.captures(&generation["attemptId"]),
        vec![original_capture.clone()]
    );
    peer.empty();

    let fresh = fixture.prepare(&peer, true, false);
    let (_, fresh_generation, shared, http) = fixture.start(&peer, &fresh);
    assert_eq!(shared["sourceText"], SOURCE);
    assert_eq!(shared["sourceContext"], time_projection(next_time));
    assert!(shared.get("manualContextFacts").is_none());
    assert_eq!(shared["context"], Value::Null);
    assert!(!http.raw.contains(first_time));
    assert_caption_privacy(&http, &fresh, &next_page);
    let fresh_capture = fixture.capture(&fresh_generation, &http);
    http.finish("Pi caption candidate with the updated time 🧶");
    fixture.terminal(&fresh_generation["attemptId"]);
    fixture.saved_candidate(&fresh_generation["attemptId"]);
    let fresh_view = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":fresh_generation["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        fresh_view["rows"][0]["output"]["text"],
        "Pi caption candidate with the updated time 🧶"
    );
    assert_eq!(
        fresh_view["rows"][0]["item"]["sourceRevisionId"],
        next_row["sourceRevisionId"]
    );
    assert_ne!(
        fresh_view["rows"][0]["savedRevisionId"],
        original_result["savedRevisionId"]
    );
    peer.empty();

    // Terminal output does not prove producer drain. Close only after the
    // public execution owner has confirmed both inactivity and quiescence.
    fixture.ipc("quiesce_execution", json!({})).unwrap();
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let status = fixture.ipc("execution_status", json!({})).unwrap();
        if status["active"] == false && status["quiescing"] == false {
            break;
        }
        assert!(
            Instant::now() < until,
            "caption producers did not drain: {status}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    call(
        &fixture.window,
        "close_project",
        json!({"sessionToken":fixture.context["sessionToken"]}),
    )
    .unwrap();
    let reopened = call(
        &fixture.window,
        "open_project",
        json!({"locator":fixture.directory.path().join("project")}),
    )
    .unwrap();
    fixture.context = json!({"sessionToken":reopened["sessionToken"],"projectId":reopened["metadata"]["projectId"]});
    let (reopened_scope, reopened_row, reopened_page) = fixture.current();
    assert_eq!(reopened_scope, next_scope);
    assert_eq!(reopened_row, next_row);
    assert_eq!(reopened_page, next_page);
    assert_caption_context(
        &fixture,
        &reopened_scope,
        &reopened_row,
        &reopened_page,
        &updated,
        next_time,
    );
    for (captured_generation, capture) in [
        (&off_generation, off_capture),
        (&generation, original_capture),
        (&fresh_generation, fresh_capture),
    ] {
        assert_eq!(
            fixture.captures(&captured_generation["attemptId"]),
            vec![capture]
        );
    }
    let retained = fixture
        .ipc(
            "read_ai_translation",
            json!({"attemptId":generation["attemptId"]}),
        )
        .unwrap();
    assert_eq!(retained["rows"][0]["item"], original_result["item"]);
    assert_eq!(retained["rows"][0]["output"], original_result["output"]);
    assert_eq!(retained["rows"][0]["resultId"], original_result["resultId"]);
    assert_eq!(
        retained["rows"][0]["savedRevisionId"],
        original_result["savedRevisionId"]
    );
    peer.empty();
}
