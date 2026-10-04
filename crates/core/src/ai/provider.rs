//! Shared transport and dispatch services. Credentials are attached per request.
use super::{AiConfig, Usage, error};
use crate::execution::*;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Mutex,
        mpsc::{self, Receiver, SyncSender},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderProtocol {
    ChatCompletionsJson,
}

/// Read-only capability description for the configured compatibility profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderProfile {
    pub protocol: ProviderProtocol,
    pub output_token_field: String,
    pub context_tokens: Option<u32>,
    pub max_prompt_bytes: usize,
    pub max_response_bytes: usize,
    pub max_output_bytes: usize,
    pub requests_per_second: usize,
    pub remote_cancel: bool,
    pub outcome_query: bool,
}
impl ProviderProfile {
    pub fn compatible(config: &AiConfig) -> Result<Self, ExecutionError> {
        config.validate()?;
        Self::parameters(&config.token_field)
    }
    pub(crate) fn parameters(token_field: &str) -> Result<Self, ExecutionError> {
        if !["max_tokens", "max_completion_tokens"].contains(&token_field) {
            return Err(error(ErrorCode::InvalidInput, "ai-token-field"));
        }
        Ok(Self {
            protocol: ProviderProtocol::ChatCompletionsJson,
            output_token_field: token_field.to_owned(),
            context_tokens: None,
            max_prompt_bytes: 32768,
            max_response_bytes: 65536,
            max_output_bytes: 32768,
            requests_per_second: 2,
            remote_cancel: false,
            outcome_query: false,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct BudgetPort(SyncSender<BudgetEvent>);
pub(crate) enum BudgetEvent {
    Reserve {
        id: ExecutionId,
        limit: u32,
        reply: SyncSender<Result<(), ExecutionError>>,
    },
    Settle {
        id: ExecutionId,
        usage: Option<Usage>,
        reply: SyncSender<Result<(), ExecutionError>>,
    },
}
pub(crate) fn budget_channel() -> (BudgetPort, Receiver<BudgetEvent>) {
    let (tx, rx) = mpsc::sync_channel(2);
    (BudgetPort(tx), rx)
}
impl BudgetPort {
    fn exchange(
        &self,
        event: BudgetEvent,
        rx: Receiver<Result<(), ExecutionError>>,
        cancel: &Cancellation,
    ) -> Result<(), ExecutionError> {
        self.0
            .send(event)
            .map_err(|_| error(ErrorCode::OutcomeUnknown, "ai-budget-channel"))?;
        loop {
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(error(ErrorCode::OutcomeUnknown, "ai-budget-channel"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) if cancel.is_requested() => {
                    return Err(error(
                        ErrorCode::OutcomeUnknown,
                        "ai-cancelled-after-reservation",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    }
    pub(crate) fn reserve(
        &self,
        limit: u32,
        cancel: &Cancellation,
    ) -> Result<ExecutionId, ExecutionError> {
        let id = ExecutionId::new();
        let (reply, rx) = mpsc::sync_channel(1);
        self.exchange(BudgetEvent::Reserve { id, limit, reply }, rx, cancel)?;
        Ok(id)
    }
    pub(crate) fn settle(
        &self,
        id: ExecutionId,
        usage: Option<Usage>,
        cancel: &Cancellation,
    ) -> Result<(), ExecutionError> {
        let (reply, rx) = mpsc::sync_channel(1);
        self.exchange(BudgetEvent::Settle { id, usage, reply }, rx, cancel)
    }
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ConnectionKey {
    endpoint: String,
    timeout: u32,
    // Proxy environment is part of the connection configuration, never logged.
    proxies: Vec<Option<String>>,
}
#[derive(Default)]
pub struct ProviderService {
    clients: Mutex<BTreeMap<ConnectionKey, reqwest::blocking::Client>>,
    windows: Mutex<BTreeMap<String, VecDeque<Instant>>>,
}
impl ProviderService {
    pub(crate) fn client(
        &self,
        config: &AiConfig,
    ) -> Result<reqwest::blocking::Client, ExecutionError> {
        let key = ConnectionKey {
            endpoint: config.endpoint.clone(),
            timeout: config.timeout_seconds,
            proxies: [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "NO_PROXY",
                "no_proxy",
            ]
            .iter()
            .map(|k| std::env::var(k).ok())
            .collect(),
        };
        let mut clients = self
            .clients
            .lock()
            .map_err(|_| error(ErrorCode::Busy, "ai-client"))?;
        if let Some(client) = clients.get(&key) {
            return Ok(client.clone());
        }
        // Keep the session cache bounded. Eviction cannot revoke cloned in-flight clients.
        if clients.len() >= 32 {
            if let Some(key) = clients.keys().next().cloned() {
                clients.remove(&key);
            }
        }
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(config.timeout_seconds as u64))
            .build()
            .map_err(|_| error(ErrorCode::InvalidInput, "ai-client"))?;
        clients.insert(key, client.clone());
        Ok(client)
    }
    pub(crate) fn wait_rate(
        &self,
        config: &AiConfig,
        cancel: &Cancellation,
    ) -> Result<(), ExecutionError> {
        let profile = ProviderProfile::compatible(config)?;
        let url = reqwest::Url::parse(&config.endpoint)
            .map_err(|_| error(ErrorCode::InvalidInput, "ai-endpoint"))?;
        let origin = url.origin().ascii_serialization();
        loop {
            if cancel.is_requested() {
                return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
            }
            let delay = {
                let mut windows = self
                    .windows
                    .lock()
                    .map_err(|_| error(ErrorCode::Busy, "ai-rate-limit"))?;
                // Active windows last one second; expired provider identities do not accumulate.
                windows.retain(|_, calls| {
                    calls
                        .back()
                        .is_some_and(|t| t.elapsed() < Duration::from_secs(1))
                });
                let calls = windows.entry(origin.clone()).or_default();
                while calls
                    .front()
                    .is_some_and(|t| t.elapsed() >= Duration::from_secs(1))
                {
                    calls.pop_front();
                }
                if calls.len() < profile.requests_per_second {
                    calls.push_back(Instant::now());
                    return Ok(());
                }
                Duration::from_secs(1)
                    .saturating_sub(calls[0].elapsed())
                    .min(Duration::from_millis(25))
            };
            std::thread::sleep(delay);
        }
    }
    #[cfg(test)]
    pub(crate) fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }
}
pub(crate) fn retry_delay(
    retry: u32,
    retry_after: Option<&str>,
) -> Result<Duration, ExecutionError> {
    let requested = retry_after.and_then(|s| {
        s.trim()
            .parse::<u64>()
            .ok()
            .map(Duration::from_secs)
            .or_else(|| {
                httpdate::parse_http_date(s).ok().map(|date| {
                    date.duration_since(std::time::SystemTime::now())
                        .unwrap_or_default()
                })
            })
    });
    let jitter = u64::from(ExecutionId::new().to_string().as_bytes()[0]) % 100;
    let delay = requested.unwrap_or_else(|| Duration::from_millis((500 << retry.min(2)) + jitter));
    if delay > Duration::from_secs(5) {
        return Err(error(ErrorCode::LimitExceeded, "ai-retry-delay"));
    }
    Ok(delay)
}
pub(crate) fn wait_backoff(
    retry: u32,
    retry_after: Option<&str>,
    cancel: &Cancellation,
) -> Result<(), ExecutionError> {
    let end = Instant::now() + retry_delay(retry, retry_after)?;
    while Instant::now() < end {
        if cancel.is_requested() {
            return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
        }
        std::thread::sleep(
            end.saturating_duration_since(Instant::now())
                .min(Duration::from_millis(25)),
        );
    }
    Ok(())
}
