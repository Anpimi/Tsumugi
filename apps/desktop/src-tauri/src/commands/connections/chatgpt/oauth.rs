use super::*;
use openidconnect::{
    AccessTokenHash, AuthType, AuthUrl, AuthorizationCode, ClientId, CsrfToken,
    EndpointNotSet, EndpointSet, HttpRequest, HttpResponse, IssuerUrl, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl,
    RefreshToken, Scope, TokenResponse, TokenUrl,
    core::{CoreAuthenticationFlow, CoreClient, CoreIdTokenVerifier, CoreJsonWebKeySet,
        CoreJwsSigningAlgorithm, CoreTokenResponse, CoreTokenType},
};
use reqwest::{Url, blocking::Client};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
};

const ISSUER: &str = "https://auth.openai.com";
const AUTHORIZE: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
const JWKS: &str = "https://auth.openai.com/.well-known/jwks.json";
const RESOURCE: &str = "https://api.openai.com/v1";
const MODELS: &str = "https://api.openai.com/v1/models";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const SCOPES: &[&str] = &["profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const MAX_HTTP_BYTES: usize = 1024 * 1024;
const MAX_CALLBACK_BYTES: usize = 16 * 1024;
const MAX_TOKEN_REQUEST_BYTES: usize = 256 * 1024;

type OAuthClient = CoreClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

pub(super) struct PreparedLogin {
    pub(super) view: ChatGptLoginView,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) deadline: Instant,
    pub(super) selected: Option<Registration>,
    listener: TcpListener,
    redirect: String,
    state: CsrfToken,
    nonce: Nonce,
    verifier: PkceCodeVerifier,
}

pub(super) struct Callback {
    code: String,
    client_id: String,
}

pub(super) struct Grant {
    pub(super) client_id: String,
    pub(super) subject: String,
    pub(super) label: String,
    pub(super) credentials: Credentials,
}

pub(super) trait Remote: Send + Sync {
    fn login(&self, pending: &PreparedLogin, callback: Callback) -> Result<Grant, ChatGptAccountIssue>;
    fn refresh(&self, registration: &Registration) -> Result<Credentials, ExecutionError>;
    fn models(&self, access: &str) -> Result<Vec<ChatGptModelView>, ExecutionError>;
    fn revoke(&self, registration: &Registration) -> Result<(), ExecutionError>;
}

pub(super) struct OpenAi;

pub(super) fn prepare(host: ExecutionId, selected: Option<Registration>,
    id: ExecutionId, expires_at: u64) -> Result<PreparedLogin, ExecutionError>
{
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| failure(ErrorCode::DependencyConflict, "chatgpt-listener"))?;
    listener.set_nonblocking(true).map_err(|_| failure(ErrorCode::DependencyConflict, "chatgpt-listener"))?;
    let address = listener.local_addr().map_err(|_| failure(ErrorCode::DependencyConflict, "chatgpt-listener"))?;
    let redirect = format!("http://127.0.0.1:{}/auth/callback", address.port());
    let client_id = selected.as_ref().map(|record| record.client_id.as_str()).unwrap_or(DYNAMIC_CLIENT);
    let client = oauth_client(client_id, Some(&redirect))?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let mut request = client.authorize_url(CoreAuthenticationFlow::AuthorizationCode,
        CsrfToken::new_random, Nonce::new_random)
        .set_pkce_challenge(challenge)
        .add_extra_param("resource", RESOURCE)
        .add_extra_param("ext_agent_host_id", format!("urn:uuid:{host}"));
    for scope in SCOPES { request = request.add_scope(Scope::new((*scope).into())); }
    if selected.is_none() { request = request.add_extra_param("agent_name_hint", "Tsumugi"); }
    // ID/access/refresh tokens and account hints never enter the URL returned to
    // the frontend. Returning authorization can show OpenAI's account selector.
    let (url, state, nonce) = request.url();
    Ok(PreparedLogin {
        view: ChatGptLoginView { id, authorization_url: url.into(), expires_at },
        cancelled: Arc::new(AtomicBool::new(false)),
        deadline: Instant::now() + SESSION_LIFETIME,
        selected, listener, redirect, state, nonce, verifier,
    })
}

fn oauth_client(client_id: &str, redirect: Option<&str>) -> Result<OAuthClient, ExecutionError> {
    let client = CoreClient::new(ClientId::new(client_id.into()),
        IssuerUrl::new(ISSUER.into()).map_err(|_| invalid_response())?, CoreJsonWebKeySet::new(Vec::new()))
        .set_auth_uri(AuthUrl::new(AUTHORIZE.into()).map_err(|_| invalid_response())?)
        .set_token_uri(TokenUrl::new(TOKEN.into()).map_err(|_| invalid_response())?)
        .set_auth_type(AuthType::RequestBody);
    Ok(match redirect {
        Some(redirect) => client.set_redirect_uri(RedirectUrl::new(redirect.into()).map_err(|_| invalid_response())?),
        None => client,
    })
}

pub(super) fn wait_callback(pending: &PreparedLogin) -> Result<Callback, ChatGptAccountIssue> {
    let mut attempts = 0;
    while Instant::now() < pending.deadline && !pending.cancelled.load(Ordering::Acquire) {
        match pending.listener.accept() {
            Ok((mut stream, peer)) => {
                attempts += 1;
                if attempts > 128 { return Err(ChatGptAccountIssue::LoginFailed); }
                if !peer.ip().is_loopback() { continue; }
                let result = read_callback(&mut stream, pending);
                let accepted = result.is_ok();
                let _ = reply(&mut stream, accepted);
                match result {
                    Ok(callback) => return callback,
                    Err(_) => continue,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err(ChatGptAccountIssue::LoginFailed),
        }
    }
    Err(if pending.cancelled.load(Ordering::Acquire) { ChatGptAccountIssue::LoginCancelled }
        else { ChatGptAccountIssue::LoginExpired })
}

fn read_callback(stream: &mut TcpStream, pending: &PreparedLogin)
    -> Result<Result<Callback, ChatGptAccountIssue>, ExecutionError>
{
    stream.set_read_timeout(Some(Duration::from_millis(250))).map_err(|_| invalid_callback())?;
    stream.set_write_timeout(Some(Duration::from_millis(250))).map_err(|_| invalid_callback())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut request = Vec::new();
    loop {
        if request.len() >= MAX_CALLBACK_BYTES || Instant::now() >= deadline ||
            Instant::now() >= pending.deadline || pending.cancelled.load(Ordering::Acquire)
        { return Err(invalid_callback()); }
        let mut bytes = [0; 1024];
        let count = stream.read(&mut bytes).map_err(|_| invalid_callback())?;
        if count == 0 { return Err(invalid_callback()); }
        request.extend_from_slice(&bytes[..count]);
        if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") { break; }
    }
    parse_callback(&request, pending)
}

fn parse_callback(request: &[u8], pending: &PreparedLogin)
    -> Result<Result<Callback, ChatGptAccountIssue>, ExecutionError>
{
    if request.len() > MAX_CALLBACK_BYTES { return Err(invalid_callback()); }
    let text = std::str::from_utf8(request).map_err(|_| invalid_callback())?;
    let (header, body) = text.split_once("\r\n\r\n").ok_or_else(invalid_callback)?;
    if !body.is_empty() { return Err(invalid_callback()); }
    let mut lines = header.split("\r\n");
    let mut first = lines.next().ok_or_else(invalid_callback)?.split(' ');
    let (method, target, version) = (first.next(), first.next(), first.next());
    if method != Some("GET") || !matches!(version, Some("HTTP/1.1" | "HTTP/1.0")) || first.next().is_some() {
        return Err(invalid_callback());
    }
    let target = target.ok_or_else(invalid_callback)?;
    if !target.starts_with("/auth/callback?") || target.contains('#') { return Err(invalid_callback()); }
    let expected_host = pending.redirect.strip_prefix("http://").and_then(|value| value.split('/').next())
        .ok_or_else(invalid_callback)?;
    let mut found_host = false;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or_else(invalid_callback)?;
        if name.eq_ignore_ascii_case("host") {
            if found_host || value.trim() != expected_host { return Err(invalid_callback()); }
            found_host = true;
        }
        if name.eq_ignore_ascii_case("transfer-encoding") ||
            name.eq_ignore_ascii_case("content-length") && value.trim() != "0"
        { return Err(invalid_callback()); }
    }
    if !found_host { return Err(invalid_callback()); }
    let url = Url::parse(&format!("http://{expected_host}{target}")).map_err(|_| invalid_callback())?;
    if url.path() != "/auth/callback" { return Err(invalid_callback()); }
    let mut query = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if query.insert(key.into_owned(), value.into_owned()).is_some() { return Err(invalid_callback()); }
    }
    let returned_state = CsrfToken::new(query.remove("state").ok_or_else(invalid_callback)?);
    if returned_state != pending.state { return Err(invalid_callback()); }
    if let Some(error) = query.remove("error") {
        return Ok(Err(if error == "access_denied" { ChatGptAccountIssue::LoginCancelled }
            else { ChatGptAccountIssue::LoginFailed }));
    }
    let code = query.remove("code").filter(|value| storage::bounded_text(value, 8192))
        .ok_or_else(invalid_callback)?;
    let returned_client = query.remove("client_id");
    let client_id = match (&pending.selected, returned_client) {
        (Some(selected), None) => selected.client_id.clone(),
        (Some(selected), Some(client)) if client == selected.client_id => client,
        (None, Some(client)) if valid_client_id(&client) => client,
        _ => return Err(invalid_callback()),
    };
    Ok(Ok(Callback { code, client_id }))
}

fn reply(stream: &mut TcpStream, accepted: bool) -> std::io::Result<()> {
    let status = if accepted { "200 OK" } else { "400 Bad Request" };
    let body = if accepted { "Return to Tsumugi to check sign-in status." }
        else { "This callback was not accepted. Return to Tsumugi." };
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len())
}

impl Remote for OpenAi {
    fn login(&self, pending: &PreparedLogin, callback: Callback) -> Result<Grant, ChatGptAccountIssue> {
        let result = (|| {
            let http = http_client()?;
            let client = oauth_client(&callback.client_id, Some(&pending.redirect))?;
            let timing = Cell::new(None);
            let transport = |request| token_http(&http, request, &timing);
            let response = client.exchange_code(AuthorizationCode::new(callback.code))
                .set_pkce_verifier(PkceCodeVerifier::new(pending.verifier.secret().to_owned()))
                .add_extra_param("resource", RESOURCE)
                .request(&transport).map_err(|_| invalid_response())?;
            let discovery = discover(&http)?;
            let jwks = fetch_jwks(&http)?;
            let (subject, label) = verify_identity(&response, &callback.client_id,
                pending.nonce.secret(), true, jwks, discovery.id_token_signing_alg_values_supported)?;
            let credentials = credentials(&response, ExecutionId::new(), pending.nonce.secret(), None,
                timing.get())?;
            Ok(Grant { client_id: callback.client_id, subject, label, credentials })
        })();
        result.map_err(|_: ExecutionError| ChatGptAccountIssue::LoginFailed)
    }

    fn refresh(&self, registration: &Registration) -> Result<Credentials, ExecutionError> {
        let previous = registration.credentials.as_ref().ok_or_else(unauthorized)?;
        if previous.earliest_refresh_at.is_some_and(|at| now_ms().is_ok_and(|now| now < at)) {
            return Err(failure(ErrorCode::Busy, "chatgpt-refresh-not-ready"));
        }
        let http = http_client()?;
        let client = oauth_client(&registration.client_id, None)?;
        let timing = Cell::new(None);
        let transport = |request| token_http(&http, request, &timing);
        let response = client.exchange_refresh_token(&RefreshToken::new(previous.refresh_token.clone()))
            .add_extra_param("resource", RESOURCE)
            .request(&transport).map_err(|_| unauthorized())?;
        if response.id_token().is_some() {
            let discovery = discover(&http)?;
            let (subject, _) = verify_identity(&response, &registration.client_id,
                &previous.nonce, false, fetch_jwks(&http)?, discovery.id_token_signing_alg_values_supported)?;
            if subject != registration.subject { return Err(unauthorized()); }
        }
        credentials(&response, previous.account, &previous.nonce, Some(previous), timing.get())
    }

    fn models(&self, access: &str) -> Result<Vec<ChatGptModelView>, ExecutionError> {
        let http = http_client()?;
        let response = http.get(MODELS).bearer_auth(access).send().map_err(|_| network_error())?;
        if response.status() != reqwest::StatusCode::OK { return Err(network_error()); }
        let bytes = read_json(response)?;
        parse_models(&bytes)
    }

    fn revoke(&self, registration: &Registration) -> Result<(), ExecutionError> {
        let Some(credentials) = &registration.credentials else { return Ok(()); };
        let http = http_client()?;
        let endpoint = discover(&http)?.revocation_endpoint.ok_or_else(network_error)?;
        let endpoint = Url::parse(&endpoint).map_err(|_| network_error())?;
        if endpoint.scheme() != "https" || endpoint.host_str() != Some("auth.openai.com") ||
            endpoint.port_or_known_default() != Some(443) || !endpoint.username().is_empty() ||
            endpoint.password().is_some() || endpoint.query().is_some() || endpoint.fragment().is_some()
        { return Err(network_error()); }
        // Revocation is idempotent (including an already-invalid token), so a
        // bounded retry is safe after network uncertainty or service failure.
        for attempt in 0..2 {
            let response = http.post(endpoint.clone()).form(&[
                ("token", credentials.refresh_token.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", registration.client_id.as_str()),
            ]).send();
            let response = match response {
                Ok(response) => response,
                Err(_) if attempt == 0 => {
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
                Err(_) => return Err(network_error()),
            };
            if response.status() == reqwest::StatusCode::OK { return Ok(()); }
            if !response.status().is_server_error() || attempt == 1 { return Err(network_error()); }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(network_error())
    }
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
    id_token_signing_alg_values_supported: Vec<CoreJwsSigningAlgorithm>,
}

fn discover(http: &Client) -> Result<Discovery, ExecutionError> {
    let response = http.get(DISCOVERY).send().map_err(|_| network_error())?;
    if response.status() != reqwest::StatusCode::OK { return Err(network_error()); }
    let discovery: Discovery = serde_json::from_slice(&read_json(response)?).map_err(|_| invalid_response())?;
    if discovery.issuer != ISSUER || discovery.authorization_endpoint != AUTHORIZE ||
        discovery.token_endpoint != TOKEN || discovery.jwks_uri != JWKS ||
        discovery.id_token_signing_alg_values_supported.len() > 16
    { return Err(invalid_response()); }
    Ok(discovery)
}

fn fetch_jwks(http: &Client) -> Result<CoreJsonWebKeySet, ExecutionError> {
    let response = http.get(JWKS).send().map_err(|_| network_error())?;
    if response.status() != reqwest::StatusCode::OK { return Err(network_error()); }
    let keys: CoreJsonWebKeySet = serde_json::from_slice(&read_json(response)?).map_err(|_| invalid_response())?;
    if keys.keys().is_empty() || keys.keys().len() > 32 { return Err(invalid_response()); }
    Ok(keys)
}

fn verify_identity(response: &CoreTokenResponse, client_id: &str, nonce: &str,
    require_nonce: bool, keys: CoreJsonWebKeySet, algorithms: Vec<CoreJwsSigningAlgorithm>)
    -> Result<(String, String), ExecutionError>
{
    let algorithms: Vec<_> = algorithms.into_iter().filter(|algorithm| !matches!(algorithm,
        CoreJwsSigningAlgorithm::None | CoreJwsSigningAlgorithm::HmacSha256 |
        CoreJwsSigningAlgorithm::HmacSha384 | CoreJwsSigningAlgorithm::HmacSha512)).collect();
    if algorithms.is_empty() { return Err(unauthorized()); }
    let verifier = CoreIdTokenVerifier::new_public_client(ClientId::new(client_id.into()),
        IssuerUrl::new(ISSUER.into()).map_err(|_| unauthorized())?, keys)
        .set_allowed_algs(algorithms);
    let id_token = response.id_token().ok_or_else(unauthorized)?;
    let expected_nonce = Nonce::new(nonce.into());
    let claims = if require_nonce {
        id_token.claims(&verifier, &expected_nonce)
    } else {
        id_token.claims(&verifier, |actual: Option<&Nonce>| {
            // OIDC refresh responses may omit nonce. If present it must match
            // the nonce of the original, already validated authorization.
            if actual.is_none_or(|actual| actual == &expected_nonce) { Ok(()) }
            else { Err("refresh nonce mismatch".into()) }
        })
    }.map_err(|_| unauthorized())?;
    if !storage::bounded_text(claims.subject().as_str(), 1024) ||
        claims.issue_time().timestamp_millis() > now_ms()? as i64 + 5_000
    { return Err(unauthorized()); }
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(response.access_token(),
            id_token.signing_alg().map_err(|_| unauthorized())?,
            id_token.signing_key(&verifier).map_err(|_| unauthorized())?)
            .map_err(|_| unauthorized())?;
        if actual != *expected { return Err(unauthorized()); }
    }
    let label = claims.email().map(|email| email.as_str())
        .filter(|email| storage::bounded_text(email, 320))
        .unwrap_or("ChatGPT account").to_owned();
    Ok((claims.subject().as_str().to_owned(), label))
}

fn credentials(response: &CoreTokenResponse, account: ExecutionId, nonce: &str,
    previous: Option<&Credentials>, earliest_refresh_at: Option<u64>) -> Result<Credentials, ExecutionError>
{
    let access_token = response.access_token().secret();
    // The documented flow rotates a refresh token on every successful grant.
    // Do not retain a potentially consumed previous refresh token.
    let refresh_token = response.refresh_token().map(|value| value.secret()).ok_or_else(unauthorized)?;
    let id_token = response.id_token().map(ToString::to_string)
        .or_else(|| previous.map(|value| value.id_token.clone())).ok_or_else(unauthorized)?;
    let scopes = response.scopes().map(|scopes| scopes.iter().map(|scope| scope.as_str().to_owned()).collect())
        .or_else(|| previous.map(|value| value.scopes.clone())).ok_or_else(unauthorized)?;
    let lifetime = response.expires_in().filter(|value| !value.is_zero() && value.as_secs() <= 86_400)
        .ok_or_else(unauthorized)?;
    if response.token_type() != &CoreTokenType::Bearer || !valid_token(access_token) ||
        !valid_token(refresh_token) || !valid_token(&id_token) || !has_inference_scopes(&scopes)
    { return Err(unauthorized()); }
    let expires_at = now_ms()?.checked_add(lifetime.as_millis() as u64).ok_or_else(unauthorized)?;
    if earliest_refresh_at.is_some_and(|at| at > expires_at) { return Err(unauthorized()); }
    Ok(Credentials {
        account, access_token: access_token.clone(), refresh_token: refresh_token.clone(),
        id_token, nonce: nonce.into(), scopes, expires_at, earliest_refresh_at,
    })
}

fn http_client() -> Result<Client, ExecutionError> {
    Client::builder().redirect(reqwest::redirect::Policy::none()).https_only(true).no_proxy()
        .connect_timeout(Duration::from_secs(8)).timeout(Duration::from_secs(20))
        .build().map_err(|_| network_error())
}

#[derive(Debug)]
struct TransportError;
impl std::fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ChatGPT authentication transport failed")
    }
}
impl std::error::Error for TransportError {}

fn token_http(http: &Client, request: HttpRequest, timing: &Cell<Option<u64>>)
    -> Result<HttpResponse, TransportError>
{
    if request.uri().to_string() != TOKEN || request.method() != openidconnect::http::Method::POST ||
        request.body().len() > MAX_TOKEN_REQUEST_BYTES
    { return Err(TransportError); }
    let (parts, body) = request.into_parts();
    let response = http.request(parts.method, TOKEN).headers(parts.headers).body(body)
        .send().map_err(|_| TransportError)?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = read_json(response).map_err(|_| TransportError)?;
    if status == reqwest::StatusCode::OK {
        #[derive(Deserialize)]
        struct Timing { earliest_refresh_at: Option<u64> }
        let parsed: Timing = serde_json::from_slice(&bytes).map_err(|_| TransportError)?;
        timing.set(parsed.earliest_refresh_at.map(|seconds|
            seconds.checked_mul(1000).ok_or(TransportError)).transpose()?);
    }
    let mut response = HttpResponse::new(bytes);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}

fn read_json(response: reqwest::blocking::Response) -> Result<Vec<u8>, ExecutionError> {
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).and_then(|value| value.split(';').next());
    if content_type != Some("application/json") ||
        response.content_length().is_some_and(|size| size > MAX_HTTP_BYTES as u64)
    { return Err(invalid_response()); }
    let mut bytes = Vec::new();
    response.take(MAX_HTTP_BYTES as u64 + 1).read_to_end(&mut bytes).map_err(|_| network_error())?;
    if bytes.len() > MAX_HTTP_BYTES { return Err(invalid_response()); }
    Ok(bytes)
}

fn parse_models(bytes: &[u8]) -> Result<Vec<ChatGptModelView>, ExecutionError> {
    #[derive(Deserialize)]
    struct Catalog { models: Vec<Model> }
    #[derive(Deserialize)]
    struct Model { slug: String, display_name: String, visibility: String }
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|_| invalid_response())?;
    if catalog.models.len() > 1024 { return Err(invalid_response()); }
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for model in catalog.models.into_iter().filter(|model| model.visibility == "list") {
        if !storage::bounded_text(&model.slug, 256) || !storage::bounded_text(&model.display_name, 320) ||
            !seen.insert(model.slug.clone())
        { return Err(invalid_response()); }
        models.push(ChatGptModelView { id: model.slug, label: model.display_name });
    }
    Ok(models)
}

pub(super) fn valid_client_id(value: &str) -> bool {
    value != DYNAMIC_CLIENT && storage::bounded_text(value, 256) &&
        value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
pub(super) fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 * 1024 && value.bytes().all(|byte| byte.is_ascii_graphic())
}
pub(super) fn has_inference_scopes(scopes: &[String]) -> bool {
    ["chatgpt.tokens.use.direct", "resource.invoke", "offline_access"].iter()
        .all(|required| scopes.iter().any(|scope| scope == required))
}
fn invalid_callback() -> ExecutionError { failure(ErrorCode::InvalidInput, "chatgpt-callback") }
fn invalid_response() -> ExecutionError { failure(ErrorCode::OutputInvalid, "chatgpt-auth-response") }
fn network_error() -> ExecutionError { failure(ErrorCode::DependencyConflict, "chatgpt-account-network") }

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(super) fn synthetic_callback() -> Callback {
    Callback { code: "synthetic-code".into(), client_id: "oaiapp_synthetic".into() }
}
