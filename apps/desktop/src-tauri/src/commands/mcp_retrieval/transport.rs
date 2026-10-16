//! Bounded HTTP underneath the official MCP client. No project connection or
//! model credential is available to this transport.
use super::*;
use futures::{Stream, StreamExt, stream::BoxStream};
use reqwest::{
    Method, StatusCode,
    header::{HeaderName, HeaderValue},
};
use rmcp::{
    ClientHandler, RoleClient,
    model::*,
    service::{ClientCacheConfig, ClientLifecycleMode, ClientServiceExt, Peer},
    transport::{
        StreamableHttpClientTransport, common::client_side_sse::NeverRetry,
        streamable_http_client::*,
    },
};
use sse_stream::{Sse, SseStream};
use std::{
    borrow::Cow,
    collections::HashMap,
    pin::Pin,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    task::{Context, Poll},
    time::Instant,
};
use tokio::sync::watch;
#[cfg(test)]
mod transport_tests;

const MAX_HTTP_BYTES: usize = 512 * 1024;
const MAX_FRAME_BYTES: usize = 128 * 1024;
const MAX_FRAMES: usize = 128;

#[derive(Debug)]
pub(super) struct HttpError;
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("bounded MCP HTTP request failed")
    }
}
impl std::error::Error for HttpError {}
type HttpResult<T> = Result<T, StreamableHttpError<HttpError>>;
fn rejected() -> StreamableHttpError<HttpError> {
    StreamableHttpError::Client(HttpError)
}

pub(super) struct Control {
    deadline: Instant,
    gate: Mutex<bool>,
    signal: watch::Sender<bool>,
    bytes: AtomicUsize,
    frames: AtomicUsize,
    work: AtomicUsize,
    called: AtomicBool,
}
impl Control {
    pub(super) fn new(deadline: Instant) -> Arc<Self> {
        let (signal, _) = watch::channel(false);
        Arc::new(Self {
            deadline,
            gate: Mutex::new(false),
            signal,
            bytes: AtomicUsize::new(0),
            frames: AtomicUsize::new(0),
            work: AtomicUsize::new(0),
            called: AtomicBool::new(false),
        })
    }
    pub(super) fn close(&self) {
        *self.gate.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.signal.send_replace(true);
    }
    pub(super) fn closed(&self) -> bool {
        *self.gate.lock().unwrap_or_else(|p| p.into_inner()) || Instant::now() >= self.deadline
    }
    pub(super) fn drained(&self) -> bool {
        self.work.load(Ordering::Acquire) == 0
    }
    fn claim_call(&self) -> bool {
        // Stop and logical call admission have one linearization point. No
        // mutex is retained while the accepted external request is awaited.
        let closed = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        !*closed && Instant::now() < self.deadline && !self.called.swap(true, Ordering::AcqRel)
    }
    fn accept_result(&self, authorized: impl FnOnce() -> bool) -> bool {
        let mut closed = self.gate.lock().unwrap_or_else(|p| p.into_inner());
        let accepted = !*closed && Instant::now() < self.deadline && authorized();
        *closed = true;
        self.signal.send_replace(true);
        accepted
    }
    pub(super) fn work(self: &Arc<Self>) -> Work {
        self.work.fetch_add(1, Ordering::AcqRel);
        Work(self.clone())
    }
    async fn stopped(&self) {
        let mut signal = self.signal.subscribe();
        if *signal.borrow() {
            return;
        }
        tokio::select! { _ = signal.changed() => {}, _ = tokio::time::sleep_until(self.deadline.into()) => {} }
    }
    fn count(&self, bytes: usize) -> HttpResult<()> {
        if self
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes)
                    .filter(|total| *total <= MAX_HTTP_BYTES)
            })
            .is_err()
        {
            self.close();
            return Err(rejected());
        }
        Ok(())
    }
    fn frame(&self) -> HttpResult<()> {
        if self
            .frames
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used < MAX_FRAMES).then_some(used + 1)
            })
            .is_err()
        {
            self.close();
            return Err(rejected());
        }
        Ok(())
    }
    async fn until<T>(
        &self,
        work: impl std::future::Future<Output = HttpResult<T>>,
    ) -> HttpResult<T> {
        if self.closed() {
            return Err(rejected());
        }
        tokio::select! { biased; _ = self.stopped() => Err(rejected()), value = work => value }
    }
}
pub(in crate::commands) struct Work(Arc<Control>);
impl Drop for Work {
    fn drop(&mut self) {
        self.0.work.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) fn endpoint(value: &str) -> Result<String, CommandError> {
    tsumugi_core::application::validate_mcp_term_endpoint(value)
        .map_err(|e| execution::map_execution(e, CommandStage::ExecutionRead))?;
    Ok(value.to_owned())
}
pub(super) fn credential(reference: &Option<String>) -> Result<Option<String>, CommandError> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    if !reference.starts_with("TSUMUGI_MCP_CLIENT_")
        || reference.len() > 128
        || reference.len() == "TSUMUGI_MCP_CLIENT_".len()
        || !reference
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
    {
        return Err(failure(CommandErrorCode::PermissionDenied));
    }
    let value =
        std::env::var(reference).map_err(|_| failure(CommandErrorCode::PermissionDenied))?;
    if value.is_empty()
        || value.len() > 8192
        || HeaderValue::from_str(&format!("Bearer {value}")).is_err()
    {
        return Err(failure(CommandErrorCode::InvalidInput));
    }
    Ok(Some(value))
}

#[derive(Clone)]
struct BoundedHttp {
    client: reqwest::Client,
    endpoint: String,
    control: Arc<Control>,
    // Keep the SDK worker itself in the drain barrier, including a cancelled
    // discovery before RunningService has been returned to its caller.
    _work: Arc<Work>,
}
impl BoundedHttp {
    fn request(
        &self,
        method: Method,
        uri: &str,
        auth: Option<String>,
        session: Option<Arc<str>>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<reqwest::RequestBuilder> {
        // No server response, retry or SDK callback can introduce a new address,
        // ambient proxy or caller-controlled credential header.
        if self.control.closed() || uri != self.endpoint {
            return Err(rejected());
        }
        let mut request = self.client.request(method, uri);
        for (name, value) in headers {
            // The SDK pins the negotiated protocol on subsequent POSTs. It
            // cannot inject credentials, a destination, or arbitrary headers.
            if !matches!(
                name.as_str(),
                "mcp-protocol-version" | "mcp-method" | "mcp-name"
            ) {
                return Err(rejected());
            }
            request = request.header(name, value);
        }
        if let Some(token) = auth {
            request = request.bearer_auth(token);
        }
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session.as_ref());
        }
        Ok(request)
    }
    fn headers(&self, response: &reqwest::Response) -> HttpResult<()> {
        let size = response
            .headers()
            .iter()
            .try_fold(0usize, |size, (name, value)| {
                size.checked_add(name.as_str().len() + value.len() + 4)
            })
            .ok_or_else(rejected)?;
        if size > 32 * 1024 {
            self.control.close();
            return Err(rejected());
        }
        self.control.count(size)
    }
    async fn send(&self, builder: reqwest::RequestBuilder) -> HttpResult<reqwest::Response> {
        let request = builder.build().map_err(|_| rejected())?;
        let size = request
            .headers()
            .iter()
            .try_fold(request.url().as_str().len(), |size, (name, value)| {
                size.checked_add(name.as_str().len() + value.len() + 4)
            })
            .ok_or_else(rejected)?;
        self.control.count(size)?;
        let response = self
            .control
            .until(async { self.client.execute(request).await.map_err(|_| rejected()) })
            .await?;
        self.headers(&response)?;
        Ok(response)
    }
    async fn body(&self, response: reqwest::Response) -> HttpResult<Vec<u8>> {
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = self
            .control
            .until(async { stream.next().await.transpose().map_err(|_| rejected()) })
            .await?
        {
            self.control.count(chunk.len())?;
            if bytes.len().saturating_add(chunk.len()) > MAX_FRAME_BYTES {
                self.control.close();
                return Err(rejected());
            }
            bytes.extend_from_slice(&chunk);
        }
        self.control.frame()?;
        Ok(bytes)
    }
    async fn post(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        event_limit: usize,
    ) -> HttpResult<StreamableHttpPostResponse> {
        let _work = self.control.work();
        let encoded = serde_json::to_vec(&message).map_err(|_| rejected())?;
        if encoded.len() > MAX_FRAME_BYTES {
            return Err(rejected());
        }
        self.control.count(encoded.len())?;
        let request = self
            .request(Method::POST, &uri, auth, session.clone(), headers)?
            .header("Accept", "application/json, text/event-stream")
            .header("Content-Type", "application/json")
            .body(encoded);
        let response = self.send(request).await?;
        let status = response.status();
        let kind = response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let session_id = response
            .headers()
            .get("Mcp-Session-Id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if status == StatusCode::NOT_FOUND && session.is_some() {
            let _ = self.body(response).await?;
            return Err(StreamableHttpError::SessionExpired);
        }
        if !status.is_success() {
            let _ = self.body(response).await?;
            return Err(rejected());
        }
        if status == StatusCode::ACCEPTED || status == StatusCode::NO_CONTENT {
            let _ = self.body(response).await?;
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if kind
            .as_deref()
            .is_some_and(|v| v.split(';').next() == Some("text/event-stream"))
        {
            let stream = SseStream::from_bytes_stream(EventBytes {
                inner: Box::pin(response.bytes_stream()),
                control: self.control.clone(),
                _work: self.control.work(),
                event_bytes: 0,
                line_bytes: 0,
                event_limit: event_limit.min(MAX_FRAME_BYTES),
                failed: false,
            });
            return Ok(StreamableHttpPostResponse::Sse(stream.boxed(), session_id));
        }
        let bytes = self.body(response).await?;
        if !kind
            .as_deref()
            .is_some_and(|v| v.split(';').next() == Some("application/json"))
        {
            return Err(rejected());
        }
        if bytes.is_empty() && !matches!(message, ClientJsonRpcMessage::Request(_)) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let parsed =
            serde_json::from_slice::<ServerJsonRpcMessage>(&bytes).map_err(|_| rejected())?;
        Ok(StreamableHttpPostResponse::Json(parsed, session_id))
    }
}
struct EventBytes {
    inner: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>>,
    control: Arc<Control>,
    _work: Work,
    event_bytes: usize,
    line_bytes: usize,
    event_limit: usize,
    failed: bool,
}
impl Stream for EventBytes {
    type Item = Result<bytes::Bytes, HttpError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.failed || self.control.closed() {
            return Poll::Ready(None);
        }
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                let accepted = self.control.count(bytes.len()).is_ok()
                    && bytes.iter().all(|byte| {
                        self.event_bytes += 1;
                        if self.event_bytes > self.event_limit {
                            return false;
                        }
                        if *byte == b'\n' {
                            if self.line_bytes == 0 {
                                self.event_bytes = 0;
                                if self.control.frame().is_err() {
                                    return false;
                                }
                            }
                            self.line_bytes = 0;
                        } else if *byte != b'\r' {
                            self.line_bytes += 1;
                        }
                        true
                    });
                if !accepted {
                    self.failed = true;
                    self.control.close();
                    return Poll::Ready(Some(Err(HttpError)));
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(_))) => {
                self.failed = true;
                Poll::Ready(Some(Err(HttpError)))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}
impl StreamableHttpClient for BoundedHttp {
    type Error = HttpError;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<StreamableHttpPostResponse> {
        self.post(uri, message, session, auth, headers, MAX_FRAME_BYTES)
            .await
    }
    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> HttpResult<StreamableHttpPostResponse> {
        self.post(uri, message, session, auth, headers, limit).await
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<()> {
        let _work = self.control.work();
        let request = self.request(Method::DELETE, &uri, auth, Some(session), headers)?;
        let response = self.send(request).await?;
        let status = response.status();
        let _ = self.body(response).await?;
        if status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED {
            Ok(())
        } else {
            Err(rejected())
        }
    }
    async fn get_stream(
        &self,
        _uri: Arc<str>,
        _session: Option<Arc<str>>,
        _event: Option<String>,
        _auth: Option<String>,
        _headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<BoxStream<'static, Result<Sse, SseError>>> {
        // This one-shot profile accepts SSE only as the response to its exact
        // POST. It has no subscription, server-initiated channel or reconnect.
        Err(StreamableHttpError::ServerDoesNotSupportSse)
    }
}

struct RetrievalClient;
impl ClientHandler for RetrievalClient {
    fn list_roots(
        &self,
        _: rmcp::service::RequestContext<RoleClient>,
    ) -> impl std::future::Future<Output = Result<ListRootsResult, ErrorData>> + Send + '_ {
        std::future::ready(Err(ErrorData::method_not_found::<ListRootsRequestMethod>()))
    }
}
pub(in crate::commands) struct Connection {
    control: Arc<Control>,
    peer: Peer<RoleClient>,
}
impl Connection {
    pub(in crate::commands) fn close(&self) {
        self.control.close();
    }
    pub(in crate::commands) fn work(&self) -> Work {
        self.control.work()
    }
    pub(in crate::commands) fn accept_result(&self, authorized: impl FnOnce() -> bool) -> bool {
        self.control.accept_result(authorized)
    }
    pub(super) fn live(&self) -> bool {
        !self.control.closed() && !self.peer.is_transport_closed()
    }
    pub(in crate::commands) async fn call(
        &self,
        tool: &McpTermTool,
        arguments: tsumugi_core::application::McpTermQueryArguments,
    ) -> Result<serde_json::Value, CommandError> {
        let _work = self.control.work();
        if self.peer.is_transport_closed() || !self.control.claim_call() {
            return Err(failure(CommandErrorCode::PermissionDenied));
        }
        let arguments = serde_json::to_value(arguments)
            .map_err(|_| failure(CommandErrorCode::InvalidInput))?
            .as_object()
            .cloned()
            .ok_or_else(|| failure(CommandErrorCode::InvalidInput))?;
        let request = CallToolRequestParams::new(tool.tool_name.clone()).with_arguments(arguments);
        let value = self
            .control
            .until(async {
                self.peer
                    .call_tool_once(request)
                    .await
                    .map_err(|_| rejected())
            })
            .await
            .map_err(|_| failure(CommandErrorCode::OutcomeUnknown))?;
        if self.control.closed() {
            return Err(failure(CommandErrorCode::OutcomeUnknown));
        }
        match value {
            CallToolResponse::Complete(value) if value.is_error != Some(true) => {
                let structured = value
                    .structured_content
                    .ok_or_else(|| failure(CommandErrorCode::OutputInvalid))?;
                if serde_json::to_vec(&structured)
                    .map_err(|_| failure(CommandErrorCode::OutputInvalid))?
                    .len()
                    > tsumugi_core::application::MAX_MCP_TERM_RESULT_BYTES
                {
                    return Err(failure(CommandErrorCode::LimitExceeded));
                }
                Ok(structured)
            }
            CallToolResponse::Complete(_) => Err(failure(CommandErrorCode::OutputInvalid)),
            // A task or interactive continuation is not a terminal failure of
            // the external operation. This profile never follows it or retries.
            _ => Err(failure(CommandErrorCode::OutcomeUnknown)),
        }
    }
}
pub(super) async fn discover(
    discovery: McpRetrievalDiscovery,
    control: Arc<Control>,
) -> Result<(Arc<Connection>, Vec<McpTermTool>), CommandError> {
    let _work = control.work();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .pool_max_idle_per_host(0)
        .http1_max_headers(64)
        .http1_only()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| failure(CommandErrorCode::InvalidInput))?;
    let http = BoundedHttp {
        client,
        endpoint: discovery.endpoint.clone(),
        control: control.clone(),
        _work: Arc::new(control.work()),
    };
    let mut config = StreamableHttpClientTransportConfig::with_uri(discovery.endpoint.clone())
        .max_concurrent_requests(1)
        .max_sse_event_size(MAX_FRAME_BYTES)
        .reinit_on_expired_session(false);
    config.retry_config = Arc::new(NeverRetry::default());
    config.channel_buffer_capacity = 4;
    config.auth_header = credential(&discovery.credential_env)?;
    let transport = StreamableHttpClientTransport::with_client(http, config);
    let mut service = control
        .until(async {
            RetrievalClient
                .serve_with_lifecycle(
                    transport,
                    ClientLifecycleMode::Discover {
                        preferred_versions: vec![ProtocolVersion::LATEST],
                    },
                )
                .await
                .map_err(|_| rejected())
        })
        .await
        .map_err(|_| failure(CommandErrorCode::OutcomeUnknown))?;
    let peer = service.peer().clone();
    peer.set_response_cache_config(ClientCacheConfig::disabled())
        .await;
    let catalog = control
        .until(async { peer.list_tools(None).await.map_err(|_| rejected()) })
        .await;
    let result = (|| {
        let catalog = catalog.map_err(|_| failure(CommandErrorCode::OutcomeUnknown))?;
        if catalog.tools.len() > 32
            || catalog.next_cursor.is_some()
            || serde_json::to_vec(&catalog)
                .map_err(|_| failure(CommandErrorCode::OutputInvalid))?
                .len()
                > 128 * 1024
        {
            return Err(failure(CommandErrorCode::LimitExceeded));
        }
        let info = peer
            .peer_info()
            .ok_or_else(|| failure(CommandErrorCode::OutputInvalid))?;
        let server = info
            .server_info
            .as_ref()
            .ok_or_else(|| failure(CommandErrorCode::OutputInvalid))?;
        let mut tools = Vec::new();
        let mut names = std::collections::BTreeSet::new();
        for tool in catalog.tools {
            if !names.insert(tool.name.clone()) {
                return Err(failure(CommandErrorCode::OutputInvalid));
            }
            let Some(output) = tool.output_schema else {
                continue;
            };
            let tool = McpTermTool {
                discovery_id: discovery.identity.action_id,
                discovery_generation: discovery.identity.generation,
                discovery_expires_at_ms: discovery.expires_at_ms,
                endpoint: discovery.endpoint.clone(),
                credential_env: discovery.credential_env.clone(),
                server_name: server.name.clone(),
                server_version: server.version.clone(),
                protocol_version: info.protocol_version.to_string(),
                tool_name: tool.name.into_owned(),
                description: tool.description.map(Cow::into_owned),
                profile_version: tsumugi_core::application::MCP_TERM_QUERY_PROFILE.into(),
                input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
                output_schema: serde_json::Value::Object((*output).clone()),
            };
            if tool.validate().is_ok() {
                tools.push(tool);
            }
        }
        Ok(tools)
    })();
    match result {
        Ok(tools) if !control.closed() => {
            let owner = control.clone();
            let work = control.work();
            tauri::async_runtime::spawn(async move {
                let _work = work;
                owner.stopped().await;
                owner.close();
                let _ = service.close().await;
            });
            Ok((Arc::new(Connection { control, peer }), tools))
        }
        Ok(_) => {
            control.close();
            let _ = service.close().await;
            Err(failure(CommandErrorCode::OutcomeUnknown))
        }
        Err(error) => {
            control.close();
            let _ = service.close().await;
            Err(error)
        }
    }
}
