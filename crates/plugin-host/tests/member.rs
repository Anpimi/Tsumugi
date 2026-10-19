#![cfg(all(
    any(target_os = "macos", target_os = "linux"),
    feature = "core-adapter",
    feature = "member-conformance"
))]
//! Actual owned Node/Pi process conformance. The handler below is deliberately
//! synthetic: this file does not establish Core ledger or domain Worker behavior.
use serde_json::{Value, json};
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::Notify;
use tsumugi_core::{
    ai::{
        Usage,
        member_wire::{
            MemberBody, MemberCall, MemberFrame, MemberProfile, MemberReply, MemberTool, PROTOCOL,
            TokenField, TurnAction,
        },
    },
    execution::{Cancellation, ErrorCode, ExecutionError, ExecutionId},
};
use tsumugi_plugin_host::{
    HostError, HostLimits,
    member::{
        CapturedMemberArtifact, MemberArtifactManifest, MemberHandler, MemberLaunchOptions,
        run_member,
    },
};

#[path = "support/runtime.rs"]
mod runtime_fixture;

const ENDPOINT: &str = "http://127.0.0.1:9/v1/chat/completions";
const TOOL_TEXT: &str = "Captured reference: preserve the original speaker; use 你好.";

fn manifest() -> MemberArtifactManifest {
    MemberArtifactManifest {
        format: "tsumugi-member-runtime".into(),
        version: 1,
        protocol_version: PROTOCOL,
        entrypoint: "worker.mjs".into(),
    }
}
fn artifact() -> CapturedMemberArtifact {
    static ARTIFACT: OnceLock<CapturedMemberArtifact> = OnceLock::new();
    ARTIFACT
        .get_or_init(|| {
            let path = PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_MEMBER_ARTIFACT")
                    .expect("built member artifact required when member-conformance is enabled"),
            );
            assert!(
                path.is_absolute(),
                "member artifact must be an explicit absolute path"
            );
            CapturedMemberArtifact::capture_directory(&path, &manifest(), || true).unwrap()
        })
        .clone()
}
fn start() -> MemberFrame {
    MemberFrame {
        protocol_version: PROTOCOL,
        session_id: ExecutionId::new(),
        sequence: 0,
        body: MemberBody::Start {
            member_id: ExecutionId::new(),
            work_item_id: ExecutionId::new(),
            context_version: "captured-source-1".into(),
            profile: MemberProfile {
                endpoint: ENDPOINT.into(),
                model: "synthetic-model".into(),
                token_field: TokenField::MaxTokens,
                max_output_tokens: 100,
                context_tokens: Some(8192),
            },
            system_prompt: "Translate only the supplied captured source.".into(),
            context: json!([{ "role":"user", "content":"Captured reference revision 1", "timestamp":1 }]),
            input: "Translate original 👩🏽‍💻".into(),
            tools: vec![MemberTool {
                name: "query_reference".into(),
                description: "Read the original captured reference.".into(),
                parameters: json!({"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}),
            }],
            max_turns: 4,
            timeout_ms: 10_000,
        },
    }
}
fn options(cancel: Cancellation) -> MemberLaunchOptions {
    MemberLaunchOptions {
        allow_unsandboxed_execution: true,
        cancellation: cancel,
        limits: HostLimits {
            cleanup_timeout_ms: 1000,
            stop_timeout_ms: 1000,
            ..HostLimits::default()
        },
    }
}

fn sse(tool: bool, known_usage: bool) -> String {
    let delta = if tool {
        json!({"role":"assistant","tool_calls":[{"index":0,"id":"query-1","type":"function","function":{"name":"query_reference","arguments":"{\"query\":\"original 👩🏽‍💻\"}"}}]})
    } else {
        json!({"role":"assistant","content":"{\"candidate\":\"你好\"}"})
    };
    let mut chunks = vec![
        json!({"id":"synthetic-completion","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),
        json!({"id":"synthetic-completion","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":if tool {"tool_calls"} else {"stop"}}]}),
    ];
    if known_usage {
        chunks.push(json!({"id":"synthetic-completion","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}));
    }
    chunks
        .into_iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect::<String>()
        + "data: [DONE]\n\n"
}

#[derive(Default)]
struct Trace {
    prepares: Vec<(ExecutionId, Value)>,
    http: Vec<(ExecutionId, Value)>,
    tools: Vec<(ExecutionId, String, Value)>,
    usage: Vec<(ExecutionId, Option<Usage>)>,
    events: Vec<Value>,
    order: Vec<&'static str>,
    drained: bool,
}
struct SyntheticHandler {
    stop: Cancellation,
    trace: Arc<Mutex<Trace>>,
    pending_http: Option<Arc<Notify>>,
}
impl SyntheticHandler {
    fn new() -> Self {
        Self {
            stop: Cancellation::default(),
            trace: Arc::new(Mutex::new(Trace::default())),
            pending_http: None,
        }
    }
}
impl MemberHandler for SyntheticHandler {
    fn cancellation(&self) -> Cancellation {
        self.stop.clone()
    }
    fn handle(
        &mut self,
        call: MemberCall,
    ) -> Pin<Box<dyn Future<Output = Result<MemberReply, ExecutionError>> + Send + '_>> {
        Box::pin(async move {
            Ok(match call {
                MemberCall::Prepare { messages } => {
                    let request_id = ExecutionId::new();
                    let mut trace = self.trace.lock().unwrap();
                    trace.order.push("prepare");
                    trace.prepares.push((request_id, messages));
                    MemberReply::Prepared { request_id, shared_view: None }
                }
                MemberCall::Http {
                    request_id,
                    endpoint,
                    body,
                } => {
                    assert_eq!(endpoint, ENDPOINT);
                    let count = {
                        let mut trace = self.trace.lock().unwrap();
                        assert_eq!(trace.prepares.last().unwrap().0, request_id);
                        trace
                            .http
                            .push((request_id, serde_json::from_str(&body).unwrap()));
                        trace.order.push("http");
                        trace.http.len()
                    };
                    if let Some(entered) = &self.pending_http {
                        entered.notify_one();
                        while !self.stop.is_requested() {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                        // Acknowledging cancellation is deliberately later than
                        // seeing it, so the test distinguishes request from drain.
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        self.trace.lock().unwrap().drained = true;
                        return Err(ExecutionError::new(
                            ErrorCode::Cancelled,
                            "synthetic-member-http",
                        ));
                    }
                    MemberReply::Http {
                        request_id,
                        status: 200,
                        content_type: Some("text/event-stream".into()),
                        body: sse(count == 1, count == 1),
                    }
                }
                MemberCall::BeforeTool {
                    request_id,
                    call_id,
                    name,
                    arguments,
                } => {
                    assert_eq!(name, "query_reference");
                    assert_eq!(call_id, "query-1");
                    assert_eq!(arguments, json!({"query":"original 👩🏽‍💻"}));
                    let mut trace = self.trace.lock().unwrap();
                    assert_eq!(request_id, trace.prepares[0].0);
                    trace.order.push("before");
                    MemberReply::ToolAdmission {
                        block: false,
                        reason: None,
                    }
                }
                MemberCall::ExecuteTool {
                    request_id,
                    call_id,
                    name,
                    arguments,
                } => {
                    assert_eq!(name, "query_reference");
                    let mut trace = self.trace.lock().unwrap();
                    trace.order.push("execute");
                    trace.tools.push((request_id, call_id, arguments));
                    MemberReply::ToolResult {
                        content: json!([{"type":"text","text":TOOL_TEXT}]),
                        details: json!({"reference":"captured-1"}),
                        is_error: false,
                    }
                }
                MemberCall::AfterTool {
                    request_id,
                    call_id,
                    name,
                    result,
                    is_error,
                } => {
                    let mut trace = self.trace.lock().unwrap();
                    assert_eq!(request_id, trace.tools[0].0);
                    assert_eq!(call_id, trace.tools[0].1);
                    assert_eq!(name, "query_reference");
                    assert!(!is_error);
                    assert_eq!(result["content"][0]["text"], TOOL_TEXT);
                    trace.order.push("after");
                    MemberReply::ToolFinalized {
                        content: None,
                        is_error: None,
                    }
                }
                MemberCall::FinishTurn { request_id, .. } => {
                    let mut trace = self.trace.lock().unwrap();
                    assert_eq!(request_id, trace.prepares.last().unwrap().0);
                    trace.order.push("finish");
                    MemberReply::Turn {
                        action: TurnAction::Normal,
                    }
                }
                MemberCall::Usage { request_id, usage } => {
                    self.trace.lock().unwrap().usage.push((request_id, usage));
                    MemberReply::Recorded
                }
                MemberCall::Event { request_id, event } => {
                    let mut trace = self.trace.lock().unwrap();
                    if let Some(id) = request_id {
                        assert!(trace.prepares.iter().any(|(known, _)| *known == id));
                    }
                    trace.events.push(event);
                    MemberReply::Recorded
                }
            })
        })
    }
}

fn empty_stage(stage: &std::path::Path) {
    assert_eq!(
        std::fs::read_dir(stage).unwrap().count(),
        0,
        "only the owned, reaped instance should have been removed"
    );
}
fn no_waitable_child(pid: u32) {
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

#[tokio::test(flavor = "current_thread")]
async fn actual_member_process_preserves_tool_pairs_and_unknown_usage_and_reaps() {
    let runtime = runtime_fixture::approved_runtime();
    let artifact = artifact();
    let stage = tempfile::tempdir().unwrap();
    let mut handler = SyntheticHandler::new();
    let receipt = run_member(
        &artifact,
        &runtime,
        stage.path(),
        start(),
        options(Cancellation::default()),
        &mut handler,
        Arc::new(|| true),
    )
    .await
    .unwrap();
    assert_ne!(receipt.child_pid, std::process::id());
    assert!(receipt.child_pid > 1);
    assert!(receipt.termination.cooperative_acknowledgement);
    assert!(receipt.termination.direct_child_reaped);
    assert_eq!(receipt.termination.exit_code, Some(0));
    no_waitable_child(receipt.child_pid);
    empty_stage(stage.path());
    assert!(!receipt.turn_limit_reached);
    let trace = handler.trace.lock().unwrap();
    assert_eq!(trace.http.len(), 2);
    assert_eq!(trace.prepares.len(), 2);
    assert_eq!(trace.tools.len(), 1);
    assert_ne!(trace.http[0].0, trace.http[1].0);
    assert_eq!(trace.tools[0].0, trace.http[0].0);
    assert_eq!(trace.tools[0].2, json!({"query":"original 👩🏽‍💻"}));
    for (_, body) in &trace.http {
        assert_eq!(body["model"], "synthetic-model");
        assert_eq!(body["stream"], true);
        assert_eq!(body["max_tokens"], 100);
        assert!(
            body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "user"
                    && message["content"] == "Translate original 👩🏽‍💻")
        );
    }
    let second = trace.http[1].1["messages"].as_array().unwrap();
    let assistant = second
        .iter()
        .find(|message| message["role"] == "assistant" && message["tool_calls"].is_array())
        .unwrap();
    let tool = second
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap();
    assert_eq!(assistant["tool_calls"][0]["id"], tool["tool_call_id"]);
    assert!(tool["content"].as_str().unwrap().contains(TOOL_TEXT));
    assert!(
        trace.prepares[1]
            .1
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "toolResult" && message["toolCallId"] == "query-1")
    );
    assert_eq!(
        trace.usage,
        vec![
            (
                trace.http[0].0,
                Some(Usage {
                    prompt_tokens: 0,
                    completion_tokens: 0
                })
            ),
            (trace.http[1].0, None)
        ]
    );
    assert_eq!(trace.events.last().unwrap()["type"], "agent_end");
    assert_eq!(
        receipt.messages.as_array().unwrap().last().unwrap()["stopReason"],
        "stop"
    );
    let before = trace
        .order
        .iter()
        .position(|call| *call == "before")
        .unwrap();
    let execute = trace
        .order
        .iter()
        .position(|call| *call == "execute")
        .unwrap();
    let after = trace
        .order
        .iter()
        .position(|call| *call == "after")
        .unwrap();
    assert!(before < execute && execute < after);
}

#[tokio::test(flavor = "current_thread")]
async fn original_cancel_stops_and_drains_pending_handler_before_removing_stage() {
    let runtime = runtime_fixture::approved_runtime();
    let artifact = artifact();
    let stage = tempfile::tempdir().unwrap();
    let entered = Arc::new(Notify::new());
    let mut handler = SyntheticHandler::new();
    handler.pending_http = Some(entered.clone());
    let original = Cancellation::default();
    let signal = original.clone();
    let mut cancellation = tokio::spawn(async move {
        entered.notified().await;
        signal.request();
    });
    let result = run_member(
        &artifact,
        &runtime,
        stage.path(),
        start(),
        options(original.clone()),
        &mut handler,
        Arc::new(|| true),
    )
    .await;
    let cancel_observed = tokio::time::timeout(Duration::from_secs(1), &mut cancellation).await;
    if cancel_observed.is_err() {
        cancellation.abort();
    }
    cancel_observed
        .expect("member did not reach the expected controlled HTTP boundary")
        .unwrap();
    assert!(matches!(result, Err(HostError::Cancelled)));
    assert!(original.is_requested());
    assert!(handler.stop.is_requested());
    assert!(handler.trace.lock().unwrap().drained);
    assert_eq!(handler.trace.lock().unwrap().http.len(), 1);
    empty_stage(stage.path());
}

#[tokio::test(flavor = "current_thread")]
async fn revoked_authority_refuses_capture_and_launch_without_a_child_or_handler_call() {
    let runtime = runtime_fixture::approved_runtime();
    let artifact = artifact();
    let stage = tempfile::tempdir().unwrap();
    let absent = stage.path().join("never-read");
    assert!(matches!(
        CapturedMemberArtifact::capture_directory(&absent, &manifest(), || false),
        Err(HostError::AuthorityRevoked)
    ));
    let mut handler = SyntheticHandler::new();
    let result = run_member(
        &artifact,
        &runtime,
        stage.path(),
        start(),
        options(Cancellation::default()),
        &mut handler,
        Arc::new(|| false),
    )
    .await;
    assert!(matches!(result, Err(HostError::AuthorityRevoked)));
    assert!(handler.trace.lock().unwrap().prepares.is_empty());
    assert!(handler.trace.lock().unwrap().events.is_empty());
    empty_stage(stage.path());
}

#[tokio::test(flavor = "current_thread")]
async fn unsupported_member_artifact_protocol_is_rejected_before_launch() {
    let runtime = runtime_fixture::approved_runtime();
    let _ = artifact();
    let source = PathBuf::from(std::env::var_os("TSUMUGI_TEST_MEMBER_ARTIFACT").unwrap());
    let fixture = tempfile::tempdir().unwrap();
    let mut expected = manifest();
    expected.protocol_version = PROTOCOL.checked_add(1).unwrap();
    std::fs::write(
        fixture.path().join("manifest.json"),
        serde_json::to_vec(&expected).unwrap(),
    )
    .unwrap();
    // Keep the real, self-contained worker bytes. Only the independently
    // expected manifest protocol changes; no replacement application is run.
    std::fs::copy(source.join("worker.mjs"), fixture.path().join("worker.mjs")).unwrap();
    let captured =
        CapturedMemberArtifact::capture_directory(fixture.path(), &expected, || true).unwrap();
    let stage = tempfile::tempdir().unwrap();
    let mut handler = SyntheticHandler::new();
    let result = run_member(
        &captured,
        &runtime,
        stage.path(),
        start(),
        options(Cancellation::default()),
        &mut handler,
        Arc::new(|| true),
    )
    .await;
    assert!(matches!(result, Err(HostError::InvalidContract)));
    empty_stage(stage.path());
    assert!(handler.trace.lock().unwrap().prepares.is_empty());
    assert!(handler.trace.lock().unwrap().events.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn changed_session_or_sequence_is_rejected_and_the_original_child_is_reaped() {
    let runtime = runtime_fixture::approved_runtime();
    // Require the production bundle fixture even though these two negative
    // handshakes intentionally execute a smaller synthetic application entry.
    let _ = artifact();
    for mismatch in ["session", "sequence"] {
        let fixture = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        std::fs::write(
            fixture.path().join("manifest.json"),
            serde_json::to_vec(&manifest()).unwrap(),
        )
        .unwrap();
        let worker = r#"import {writeFileSync} from 'node:fs';
let bytes=Buffer.alloc(0);let sent=false;
process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(sent||bytes.length<4||bytes.length<4+bytes.readUInt32BE(0))return;sent=true;
const input=JSON.parse(bytes.subarray(4,4+bytes.readUInt32BE(0)).toString('utf8'));writeFileSync(input.body.input,String(process.pid));
const body={protocolVersion:1,sessionId:input.sessionId,sequence:0,body:{kind:'ready'}};
if(MISMATCH==='session')body.sessionId='a3260d1d-7a88-4bda-89e8-2c117320ce12';else body.sequence=1;
const output=Buffer.from(JSON.stringify(body));const header=Buffer.alloc(4);header.writeUInt32BE(output.length);process.stdout.write(Buffer.concat([header,output]));});
setInterval(()=>{},1000);"#.replace("MISMATCH", &format!("'{mismatch}'"));
        std::fs::write(fixture.path().join("worker.mjs"), worker).unwrap();
        let captured =
            CapturedMemberArtifact::capture_directory(fixture.path(), &manifest(), || true)
                .unwrap();
        let pid_path = fixture.path().join("owned-child.pid");
        let mut input = start();
        if let MemberBody::Start { input, .. } = &mut input.body {
            *input = pid_path.to_str().unwrap().into();
        }
        let mut handler = SyntheticHandler::new();
        let result = run_member(
            &captured,
            &runtime,
            stage.path(),
            input,
            options(Cancellation::default()),
            &mut handler,
            Arc::new(|| true),
        )
        .await;
        assert!(matches!(result, Err(HostError::RequestMismatch)));
        let pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert_ne!(pid, std::process::id());
        no_waitable_child(pid);
        empty_stage(stage.path());
        assert!(handler.trace.lock().unwrap().events.is_empty());
    }
}
