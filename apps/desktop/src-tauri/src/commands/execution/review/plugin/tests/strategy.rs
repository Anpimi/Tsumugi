//! Registered project commands, original Arena execution and independently
//! installed Review workers. The only model endpoint is this owned local server.
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

struct LocalProvider {
    endpoint: String,
    stopped: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl LocalProvider {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = requests.clone();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(600);
            while !stop.load(Ordering::SeqCst) {
                assert!(Instant::now() < deadline, "owned local provider deadline");
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("owned local provider: {error}"),
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let header = loop {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        break index + 4;
                    }
                    assert!(bytes.len() < 65536);
                };
                let headers = std::str::from_utf8(&bytes[..header]).unwrap();
                assert!(!headers.to_ascii_lowercase().contains("authorization:"));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse().unwrap())
                    })
                    .unwrap();
                assert!(length < 65536);
                while bytes.len() < header + length {
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let body: Value = serde_json::from_slice(&bytes[header..header + length]).unwrap();
                let item: Value =
                    serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                records.lock().unwrap().push(item.clone());
                let output = json!({"unitId":item["unitId"],"targetLocale":item["targetLocale"],"text":"合成译文"});
                let response = json!({"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":output.to_string()}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}).to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            }
        });
        Self {
            endpoint,
            stopped,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for LocalProvider {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn invocation(window: &Window, context: &Value, command: &str, fields: Value) -> Value {
    call(window, command, Some(scoped(context, fields))).unwrap()
}

#[test]
fn strategy_ipc_uses_original_arena_independent_qa_and_project_local_cas_history() {
    with_joint_review_fixture_units(3, |fixture| {
        let window = fixture.window;
        let context = fixture.context;
        let provider = LocalProvider::new();
        let page = invocation(
            window,
            context,
            "read_review_page",
            json!({"locale":"zh-CN","afterOrdinal":0,"limit":10}),
        );
        let rows = page["rows"].as_array().unwrap();
        let correction_unit = rows[0]["unitId"].clone();
        let calibration_unit = rows[1]["unitId"].clone();
        let holdout_unit = rows[2]["unitId"].clone();
        let target_fields = json!({"unitId":correction_unit,"locale":"zh-CN"});
        let before = invocation(window, context, "read_review_target", target_fields.clone());
        let corrected = invocation(
            window,
            context,
            "save_translation_revision",
            json!({
                "unitId":correction_unit,"locale":"zh-CN","sourceRevisionId":before["sourceRevisionId"],
                "expectedSelectionId":before["selectionId"],"text":"人工修正的前提","actionId":ExecutionId::new()
            }),
        );
        let evidence = invocation(
            window,
            context,
            "read_correction_term_basis",
            json!({
                "unitId":correction_unit,"locale":"zh-CN","afterSelectionId":corrected["selection"]["eventId"]
            }),
        );
        let selection = tsumugi_core::SourceContextSelection {
            neighbors: true,
            ..Default::default()
        };
        let capture = json!({"actionId":ExecutionId::new(),"basis":evidence["basis"],"sourceContext":selection,"reason":"Saved correction needs neighboring context","exceptions":"Do not infer names"});
        let candidate = invocation(
            window,
            context,
            "capture_context_strategy",
            json!({"capture":capture}),
        );
        assert_eq!(
            invocation(
                window,
                context,
                "capture_context_strategy",
                json!({"capture":capture})
            ),
            candidate
        );
        let mut foreign = scoped(context, json!({"capture":capture}));
        foreign["projectId"] = json!(ExecutionId::new());
        assert!(call(window, "capture_context_strategy", Some(foreign)).is_err());
        let mut stale_token = scoped(context, json!({"candidateId":candidate["candidateId"]}));
        stale_token["sessionToken"] = json!("stale-session");
        assert!(call(window, "read_context_strategy", Some(stale_token)).is_err());
        assert!(
            invocation(
                window,
                context,
                "read_context_strategy_default",
                json!({"locale":"zh-CN"})
            )
            .is_null()
        );

        let config = tsumugi_core::ai::AiConfig {
            endpoint: provider.endpoint.clone(),
            model: "owned-synthetic-provider".into(),
            credential_env: String::new(),
            max_items: 4,
            max_requests: 4,
            timeout_seconds: 5,
            ..Default::default()
        };
        let suite_capture = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"candidateId":candidate["candidateId"],"config":config,"calibrationUnitIds":[calibration_unit],"holdoutUnitIds":[holdout_unit]});
        let suite = invocation(
            window,
            context,
            "capture_strategy_suite",
            json!({"capture":suite_capture}),
        );
        assert_eq!(
            suite["preview"]["config"]["variants"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            suite["preview"]["config"]["variants"][0]["sourceContext"]["neighbors"],
            false
        );
        assert_eq!(
            suite["preview"]["config"]["variants"][1]["sourceContext"]["neighbors"],
            true
        );
        let prepare = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"candidateId":candidate["candidateId"],"suiteId":suite["suiteId"]});
        let prepared = invocation(
            window,
            context,
            "prepare_strategy_evaluation",
            json!({"capture":prepare}),
        );
        assert_eq!(prepared["canStart"], true);
        let evaluation = &prepared["evaluation"];
        let pending = invocation(
            window,
            context,
            "read_strategy_evaluation",
            json!({"evaluationId":evaluation["evaluationId"]}),
        );
        assert_eq!(pending["slots"].as_array().unwrap().len(), 4);
        assert!(
            pending["slots"]
                .as_array()
                .unwrap()
                .iter()
                .all(|slot| slot["resultId"].is_null())
        );
        assert!(
            invocation(
                window,
                context,
                "read_strategy_evaluation_start",
                json!({"evaluationId":evaluation["evaluationId"]})
            )
            .is_null()
        );
        let start = json!({"evaluationId":evaluation["evaluationId"],"attemptId":prepared["attemptId"],"digest":evaluation["inputDigest"],"confirmed":true});
        let mut denied = start.clone();
        denied["confirmed"] = json!(false);
        assert!(
            call(
                window,
                "start_strategy_evaluation",
                Some(scoped(context, denied))
            )
            .is_err()
        );
        let mut substituted = start.clone();
        substituted["digest"] = json!("f".repeat(64));
        assert!(
            call(
                window,
                "start_strategy_evaluation",
                Some(scoped(context, substituted))
            )
            .is_err()
        );
        let promotion = json!({"actionId":ExecutionId::new(),"projectId":context["projectId"],"evaluationId":evaluation["evaluationId"],"expectedRevisionId":null});
        assert!(
            call(
                window,
                "promote_context_strategy",
                Some(scoped(context, json!({"promotion":promotion})))
            )
            .is_err()
        );
        assert_eq!(
            invocation(window, context, "start_strategy_evaluation", start.clone()),
            prepared["attemptId"]
        );
        assert_eq!(
            invocation(
                window,
                context,
                "read_strategy_evaluation_start",
                json!({"evaluationId":evaluation["evaluationId"]})
            ),
            prepared["attemptId"]
        );
        assert_eq!(
            invocation(window, context, "start_strategy_evaluation", start.clone()),
            prepared["attemptId"]
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        let arena = loop {
            let view = invocation(
                window,
                context,
                "read_arena_translation",
                json!({"attemptId":prepared["attemptId"]}),
            );
            if view["detail"]["progress"]["succeeded"] == 4 {
                break view;
            }
            assert_eq!(view["detail"]["progress"]["failed"], 0, "{view}");
            assert!(Instant::now() < deadline, "{view}");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(arena["budget"]["dispatched"], 4);
        assert_eq!(arena["blind"], true);
        assert_eq!(arena["revealed"], false);
        assert!(arena["variants"].is_null());
        let completed = invocation(
            window,
            context,
            "read_strategy_evaluation",
            json!({"evaluationId":evaluation["evaluationId"]}),
        );
        let evaluation_slots = completed["slots"].as_array().unwrap();
        assert_eq!(evaluation_slots.len(), 4);
        assert_eq!(
            evaluation_slots
                .iter()
                .map(|slot| slot["itemId"].as_str().unwrap())
                .collect::<BTreeSet<_>>()
                .len(),
            4
        );
        assert_eq!(provider.requests.lock().unwrap().len(), 4);
        for item in provider.requests.lock().unwrap().iter() {
            assert_eq!(item["terms"], json!([]));
            assert!(item["context"].is_null());
        }
        let project_id: ExecutionId = serde_json::from_value(context["projectId"].clone()).unwrap();
        let attempt_id: ExecutionId =
            serde_json::from_value(prepared["attemptId"].clone()).unwrap();
        let old_input = fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                sessions
                    .active
                    .as_ref()
                    .unwrap()
                    .store
                    .execution_input(attempt_id)
                    .unwrap()
                    .bytes()
                    .to_vec()
            });
        let mut receipts = Vec::new();
        for row in arena["rows"].as_array().unwrap() {
            let item_id: ExecutionId = serde_json::from_value(row["itemId"].clone()).unwrap();
            let (original, execution_unit_id) =
                fixture
                    .app
                    .state::<AppState>()
                    .sessions
                    .with(move |sessions| {
                        let input = sessions
                            .active
                            .as_ref()
                            .unwrap()
                            .store
                            .execution_input(attempt_id)
                            .unwrap();
                        let units = input
                            .envelope()
                            .units
                            .iter()
                            .filter(|unit| unit.item_ids.as_slice() == [item_id])
                            .collect::<Vec<_>>();
                        assert_eq!(units.len(), 1);
                        (
                            tsumugi_core::ai::arena::item_payload(&input, item_id).unwrap(),
                            units[0].unit_id,
                        )
                    });
            let slot = evaluation_slots
                .iter()
                .find(|slot| slot["itemId"] == row["itemId"])
                .unwrap();
            assert_eq!(slot["unitId"], row["item"]["unitId"]);
            assert_eq!(slot["resultId"], row["resultId"]);
            assert_eq!(
                slot["slot"],
                json!(original.slot),
                "the fixed input owns baseline/candidate identity; the blind display label is independent"
            );
            let target_fields = json!({"unitId":row["item"]["unitId"],"locale":"zh-CN"});
            let target_before =
                invocation(window, context, "read_review_target", target_fields.clone());
            let saved_request = json!({"evaluationId":evaluation["evaluationId"],"itemId":row["itemId"],"resultId":row["resultId"],"actionId":ExecutionId::new()});
            let saved = invocation(
                window,
                context,
                "save_strategy_evaluation_candidate",
                saved_request.clone(),
            );
            assert_eq!(saved["unitId"], json!(execution_unit_id));
            assert_ne!(saved["unitId"], row["item"]["unitId"]);
            assert_eq!(
                invocation(
                    window,
                    context,
                    "save_strategy_evaluation_candidate",
                    saved_request.clone()
                ),
                saved
            );
            let other = arena["rows"]
                .as_array()
                .unwrap()
                .iter()
                .find(|other| {
                    other["item"]["unitId"] == row["item"]["unitId"]
                        && other["itemId"] != row["itemId"]
                })
                .unwrap();
            let mut substituted = saved_request.clone();
            substituted["itemId"] = other["itemId"].clone();
            assert!(
                call(
                    window,
                    "save_strategy_evaluation_candidate",
                    Some(scoped(context, substituted))
                )
                .is_err(),
                "receipt recovery binds the original item and result"
            );
            let check = scoped(
                context,
                json!({"check":{"actionId":ExecutionId::new(),"projectId":project_id,"evaluationId":evaluation["evaluationId"],"itemId":row["itemId"],"resultId":row["resultId"]}}),
            );
            let preview = call(
                window,
                "prepare_strategy_evaluation_checks",
                Some(check.clone()),
            )
            .unwrap();
            assert_eq!(preview["kind"], "plugin");
            let slots = preview["view"]["checkers"].as_array().unwrap();
            assert!(!slots.is_empty());
            let grants = slots
                .iter()
                .map(|slot| consent(context, slot))
                .collect::<Vec<_>>();
            let run = scoped(context, json!({"check":check,"executions":grants}));
            let mut missing = run.clone();
            missing["executions"] = json!([]);
            assert!(call(window, "run_strategy_evaluation_checks", Some(missing)).is_err());
            let checked = call(window, "run_strategy_evaluation_checks", Some(run)).unwrap();
            assert!(
                checked["rules"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|rule| rule["mandatory"] == true)
                    .all(|rule| rule["status"] == "passed"),
                "{checked}"
            );
            assert_eq!(
                invocation(window, context, "read_review_target", target_fields),
                target_before,
                "candidate QA cannot create selection, approval or current QA"
            );
            assert_eq!(checked["basis"]["selectionId"], Value::Null);
            assert_eq!(
                original.item.unit_id.to_string(),
                row["item"]["unitId"].as_str().unwrap()
            );
            receipts.push((check, checked, saved_request, saved));
        }
        assert!(
            call(
                window,
                "promote_context_strategy",
                Some(scoped(context, json!({"promotion":promotion})))
            )
            .is_err()
        );
        let judgment = json!({"actionId":ExecutionId::new(),"projectId":project_id,"evaluationId":evaluation["evaluationId"],"unitId":holdout_unit,"expectedJudgmentId":null,"preference":"candidate-preferred","notes":"Explicit synthetic human judgment for this fixed holdout","elapsedSeconds":null,"modifiedCharacters":null});
        let judged = invocation(
            window,
            context,
            "record_strategy_judgment",
            json!({"judgment":judgment}),
        );
        let holdout_result = |position: u32| {
            evaluation_slots
                .iter()
                .find(|slot| slot["unitId"] == holdout_unit && slot["slot"] == json!(position))
                .unwrap()["resultId"]
                .clone()
        };
        assert_eq!(judged["baselineResultId"], holdout_result(0));
        assert_eq!(judged["candidateResultId"], holdout_result(1));
        assert_eq!(
            invocation(
                window,
                context,
                "record_strategy_judgment",
                json!({"judgment":judgment})
            ),
            judged
        );
        let promoted = invocation(
            window,
            context,
            "promote_context_strategy",
            json!({"promotion":promotion}),
        );
        let mut cas = promotion.clone();
        cas["actionId"] = json!(ExecutionId::new());
        assert!(
            call(
                window,
                "promote_context_strategy",
                Some(scoped(context, json!({"promotion":cas})))
            )
            .is_err()
        );
        let withdrawal = json!({"actionId":ExecutionId::new(),"projectId":project_id,"locale":"zh-CN","expectedRevisionId":promoted["revisionId"]});
        let withdrawn = invocation(
            window,
            context,
            "withdraw_context_strategy",
            json!({"withdrawal":withdrawal}),
        );
        assert!(withdrawn["reference"].is_null());
        assert_eq!(
            invocation(
                window,
                context,
                "promote_context_strategy",
                json!({"promotion":promotion})
            ),
            promoted
        );
        assert_eq!(
            invocation(
                window,
                context,
                "read_context_strategy_default",
                json!({"locale":"zh-CN"})
            ),
            withdrawn
        );
        assert_eq!(
            invocation(
                window,
                context,
                "list_context_strategy_defaults",
                json!({"locale":"zh-CN","offset":0,"limit":50})
            )["rows"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        fixture
            .app
            .state::<AppState>()
            .sessions
            .with(move |sessions| {
                assert_eq!(
                    sessions
                        .active
                        .as_ref()
                        .unwrap()
                        .store
                        .execution_input(attempt_id)
                        .unwrap()
                        .bytes(),
                    old_input
                )
            });

        let unopened_capture = json!({"actionId":ExecutionId::new(),"projectId":project_id,"candidateId":candidate["candidateId"],"suiteId":suite["suiteId"]});
        let unopened = invocation(
            window,
            context,
            "prepare_strategy_evaluation",
            json!({"capture":unopened_capture}),
        );
        let calibration_target = invocation(
            window,
            context,
            "read_review_target",
            json!({"unitId":calibration_unit,"locale":"zh-CN"}),
        );
        invocation(
            window,
            context,
            "save_translation_revision",
            json!({
                "unitId":calibration_unit,"locale":"zh-CN","sourceRevisionId":calibration_target["sourceRevisionId"],
                "expectedSelectionId":calibration_target["selectionId"],"text":"New saved human work after the frozen suite","actionId":ExecutionId::new()
            }),
        );
        assert!(call(window, "start_strategy_evaluation", Some(scoped(context, json!({"evaluationId":unopened["evaluation"]["evaluationId"],"attemptId":unopened["attemptId"],"digest":unopened["evaluation"]["inputDigest"],"confirmed":true})))).is_err(), "a live preview still rejects changed suite evidence");
        assert_eq!(
            invocation(window, context, "start_strategy_evaluation", start.clone()),
            prepared["attemptId"],
            "the original submitted action remains readable after evidence changes"
        );
        invocation(window, context, "quiesce_execution", json!({}));
        call(
            window,
            "close_project",
            Some(json!({"sessionToken":context["sessionToken"]})),
        )
        .unwrap();
        let reopened = call(
            window,
            "open_project",
            Some(json!({"locator":fixture.project_path})),
        )
        .unwrap();
        let current = json!({"sessionToken":reopened["sessionToken"],"projectId":project_id});
        assert_eq!(
            invocation(
                window,
                &current,
                "read_context_strategy",
                json!({"candidateId":candidate["candidateId"]})
            ),
            candidate
        );
        let history = invocation(
            window,
            &current,
            "read_strategy_evaluation",
            json!({"evaluationId":evaluation["evaluationId"]}),
        );
        assert_eq!(history["checks"].as_array().unwrap().len(), 4);
        assert_eq!(history["judgments"].as_array().unwrap().len(), 1);
        assert_eq!(history["slots"], completed["slots"]);
        assert_eq!(history["current"], false);
        assert_eq!(
            invocation(
                window,
                &current,
                "prepare_strategy_evaluation",
                json!({"capture":unopened_capture})
            )["canStart"],
            false
        );
        assert!(call(window, "start_strategy_evaluation", Some(scoped(&current, json!({"evaluationId":unopened["evaluation"]["evaluationId"],"attemptId":unopened["attemptId"],"digest":unopened["evaluation"]["inputDigest"],"confirmed":true})))).is_err());
        for (mut check, receipt, saved_request, saved) in receipts {
            check["sessionToken"] = current["sessionToken"].clone();
            assert_eq!(
                call(
                    window,
                    "prepare_strategy_evaluation_checks",
                    Some(check.clone())
                )
                .unwrap(),
                json!({"kind":"recorded","receipt":receipt})
            );
            assert_eq!(
                invocation(
                    window,
                    &current,
                    "run_strategy_evaluation_checks",
                    json!({"check":check,"executions":[]})
                ),
                receipt
            );
            assert_eq!(
                invocation(
                    window,
                    &current,
                    "save_strategy_evaluation_candidate",
                    saved_request
                ),
                saved
            );
        }
        assert_eq!(
            provider.requests.lock().unwrap().len(),
            4,
            "reopening and receipt recovery cannot issue model requests"
        );
    });
}
