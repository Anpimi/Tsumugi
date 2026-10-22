//! Pi's serialized request crosses the original Core dispatch/budget boundary.
use super::*;
use serde::{Deserialize, Serialize};
use crate::application::{
    CapturedTeamDiscussionView, CapturedTeamWorkView, TeamDiscussionView, TeamWorkRequestView,
};

// SSE framing is larger than the final model output. Bound its carrier bytes
// separately; the existing execution output/profile still limits decoded text.
const MAX_MEMBER_RESPONSE_BYTES: usize = crate::execution::MAX_RESULT_BYTES;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRequestCapture {
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_view: Option<TeamDiscussionView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_work_view: Option<TeamWorkRequestView>,
}
impl ProviderRequestCapture {
    pub(crate) fn validate(&self, config: &AiConfig) -> Result<(), ExecutionError> {
        let profile = ProviderProfile::compatible(config)?;
        let value: serde_json::Value =
            codec::decode(self.body.as_bytes(), profile.max_prompt_bytes)?;
        let messages = if config.is_chatgpt_subscription() {
            let allowed = ["model", "input", "stream", "store", "tools"];
            if !value.as_object().is_some_and(|fields| fields.keys().all(|key| allowed.contains(&key.as_str())))
                || value["model"] != config.model || value["stream"] != true || value["store"] != false {
                return Err(error(ErrorCode::ResultMismatch, "member-model-profile"));
            }
            value["input"].as_array()
        } else {
            let other_field = if config.token_field == "max_tokens" { "max_completion_tokens" } else { "max_tokens" };
            if value["model"] != config.model || value["stream"] != true
                || value[&config.token_field].as_u64() != Some(config.max_output_tokens.into())
                || value.get(other_field).is_some() {
                return Err(error(ErrorCode::ResultMismatch, "member-model-profile"));
            }
            value["messages"].as_array()
        }.filter(|messages| !messages.is_empty())
            .ok_or_else(|| error(ErrorCode::ResultMismatch, "member-model-profile"))?;
        if config.is_chatgpt_subscription() {
            let valid_tools = value.get("tools").is_none_or(|tools| tools.as_array().is_some_and(|namespaces| {
                namespaces.len() == 1 && namespaces[0]["type"] == "namespace"
                    && namespaces[0]["name"] == "tsumugi"
                    && namespaces[0]["tools"].as_array().is_some_and(|tools| !tools.is_empty()
                        && tools.iter().all(|tool| tool["type"] == "function" || tool["type"] == "custom"))
            }));
            if messages.iter().any(|message| message["role"] == "system") || !valid_tools {
                return Err(error(ErrorCode::ResultMismatch, "member-model-profile"));
            }
        }
        if self.team_view.is_some() && self.team_work_view.is_some() {
            return Err(error(ErrorCode::ResultMismatch, "member-shared-view"));
        }
        let shared = self.team_view.as_ref().map(serde_json::to_string)
            .or_else(|| self.team_work_view.as_ref().map(serde_json::to_string))
            .transpose().map_err(|_| error(ErrorCode::InvalidInput, "member-shared-view"))?;
        if let Some(utf8) = shared {
            // The exact Core projection is an explicit user-data message in
            // this physical request, not a replaceable identifier from Node.
            let count = messages.iter().filter(|message| {
                message["role"] == "user" && (message["content"] == utf8
                    || message["content"] == serde_json::json!([{"type":"input_text","text":utf8}]))
            }).count();
            if count != 1 {
                return Err(error(ErrorCode::ResultMismatch, "member-shared-view"));
            }
        }
        Ok(())
    }
    pub(crate) fn validate_completion(&self, prompt: &CompletionPrompt) -> Result<(), ExecutionError> {
        let value: serde_json::Value = codec::decode(self.body.as_bytes(), 32768)?;
        let expected = serde_json::json!([
            {"role":"developer","content":prompt.system},
            {"role":"user","content":[{"type":"input_text","text":prompt.input}]}
        ]);
        if self.team_view.is_some() || self.team_work_view.is_some()
            || value["input"] != expected || value.get("tools").is_some() {
            return Err(error(ErrorCode::ResultMismatch, "ai-completion-prompt"));
        }
        Ok(())
    }

}

/// Buffered SSE bytes. Pi remains the only provider-protocol parser.
pub struct MemberHttpResponse {
    pub request_id: ExecutionId,
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}
struct ActiveRequest {
    id: ExecutionId,
    response: bool,
    issued: bool,
    team_view: Option<TeamDiscussionView>,
    team_work_view: Option<TeamWorkRequestView>,
}

/// One bounded member's physical requests share the original dispatch and budget.
pub struct MemberProviderSession {
    service: std::sync::Arc<ProviderService>,
    dispatch: DispatchRequest,
    cancellation: Cancellation,
    config: AiConfig,
    budget_limit: u32,
    requests: u32,
    team_work: bool,
    completion_prompt: Option<CompletionPrompt>,
    active: Option<ActiveRequest>,
}
impl MemberProviderSession {
    pub fn new(
        service: std::sync::Arc<ProviderService>,
        dispatch: DispatchRequest,
        cancellation: Cancellation,
    ) -> Result<Self, ExecutionError> {
        let settings = crate::ai::settings(&dispatch.input)?;
        if settings.agent.is_none() || dispatch.provider.is_none() {
            return Err(error(ErrorCode::Unauthorized, "member-dispatch"));
        }
        dispatch.check_service_dispatch()?;
        Ok(Self {
            service,
            dispatch,
            cancellation,
            budget_limit: settings.config.max_requests,
            config: settings.config,
            requests: 0,
            team_work: false,
            completion_prompt: None,
            active: None,
        })
    }
    /// Team work has an explicitly captured member connection and a separate
    /// root budget ceiling. It cannot enter through the old Agent binding.
    pub fn new_team(
        service: std::sync::Arc<ProviderService>,
        dispatch: DispatchRequest,
        cancellation: Cancellation,
    ) -> Result<Self, ExecutionError> {
        let settings = crate::ai::team::settings(&dispatch.input)?;
        if dispatch.provider.is_none() {
            return Err(error(ErrorCode::Unauthorized, "member-dispatch"));
        }
        dispatch.check_service_dispatch()?;
        let budget_limit = if settings.binding.is_root() {
            settings.root_request_limit
        } else {
            settings.config.max_requests
        };
        Ok(Self {
            service, dispatch, cancellation, config: settings.config,
            budget_limit, requests: 0, team_work: true, completion_prompt: None, active: None,
        })
    }
    /// A fixed completion retains the original dispatch, without a fabricated
    /// member lease. Its prompt is immutable and no tools are authorized.
    pub fn new_completion(service: std::sync::Arc<ProviderService>, dispatch: DispatchRequest,
        cancellation: Cancellation, config: AiConfig, prompt: CompletionPrompt) -> Result<Self, ExecutionError> {
        config.validate()?;
        if !config.is_chatgpt_subscription() || dispatch.provider.is_none() {
            return Err(error(ErrorCode::Unauthorized, "ai-completion-dispatch"));
        }
        dispatch.check_service_dispatch()?;
        Ok(Self { service, dispatch, cancellation, budget_limit: config.max_requests,
            config, requests: 0, team_work: false, completion_prompt: Some(prompt), active: None })
    }
    pub fn prepare(&mut self) -> Result<ExecutionId, ExecutionError> {
        self.prepare_with_view(None)
    }
    /// Only the Core-owned snapshot can supply a request's discussion basis.
    /// A subsequent HTTP call carries bytes and this original identity only.
    pub fn prepare_with_view(
        &mut self,
        view: Option<CapturedTeamDiscussionView>,
    ) -> Result<ExecutionId, ExecutionError> {
        if self.team_work {
            return Err(error(ErrorCode::Unauthorized, "team-work-view-required"));
        }
        self.prepare_captured(view.map(|view| view.view().clone()), None)
    }
    pub fn prepare_with_team_view(
        &mut self,
        view: CapturedTeamWorkView,
    ) -> Result<ExecutionId, ExecutionError> {
        if !self.team_work {
            return Err(error(ErrorCode::Unauthorized, "member-team-work-view"));
        }
        self.prepare_captured(None, Some(view.view().clone()))
    }
    fn prepare_captured(
        &mut self,
        team_view: Option<TeamDiscussionView>,
        team_work_view: Option<TeamWorkRequestView>,
    ) -> Result<ExecutionId, ExecutionError> {
        self.dispatch.check_service_dispatch()?;
        if self.completion_prompt.is_some() && (self.requests != 0 || team_view.is_some() || team_work_view.is_some()) {
            return Err(error(ErrorCode::LimitExceeded, "ai-completion-request-limit"));
        }
        if self.cancellation.is_requested() {
            return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
        }
        if self.active.as_ref().is_some_and(|active| !active.response) {
            return Err(error(
                ErrorCode::OutcomeUnknown,
                "member-request-unresolved",
            ));
        }
        let id = ExecutionId::new();
        self.active = Some(ActiveRequest {
            id,
            response: false,
            issued: false,
            team_view,
            team_work_view,
        });
        Ok(id)
    }
    pub fn exchange(
        &mut self,
        request_id: ExecutionId,
        body: String,
    ) -> Result<MemberHttpResponse, ExecutionError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|active| active.id == request_id && !active.response && !active.issued)
        {
            return Err(error(ErrorCode::ResultMismatch, "member-request-identity"));
        }
        let capture = ProviderRequestCapture {
            body,
            team_view: self.active.as_ref().unwrap().team_view.clone(),
            team_work_view: self.active.as_ref().unwrap().team_work_view.clone(),
        };
        capture.validate(&self.config)?;
        if let Some(prompt) = &self.completion_prompt { capture.validate_completion(prompt)?; }
        if self.requests >= self.config.max_requests {
            return Err(error(ErrorCode::LimitExceeded, "member-request-limit"));
        }
        let key = self.service.credential(&self.config)?;
        self.dispatch.check_service_dispatch()?;
        self.service.wait_rate(&self.config, &self.cancellation)?;
        let budget = self
            .dispatch
            .provider
            .as_ref()
            .ok_or_else(|| error(ErrorCode::Unauthorized, "ai-budget-host"))?;
        self.active.as_mut().unwrap().issued = true;
        self.requests += 1;
        // The host's original identity and exact bytes are durable before HTTP.
        budget.reserve_captured(
            request_id,
            self.budget_limit,
            capture.clone(),
            &self.cancellation,
        )?;
        let response = self.service.exchange(
            &self.dispatch,
            &self.cancellation,
            &self.config,
            key.as_deref(),
            capture.body.into_bytes(),
            MAX_MEMBER_RESPONSE_BYTES,
        )?;
        budget.settle(request_id, None, &self.cancellation)?;
        if response.body.len() > MAX_MEMBER_RESPONSE_BYTES {
            return Err(error(ErrorCode::OutputInvalid, "ai-response"));
        }
        self.active.as_mut().unwrap().response = true;
        if self.config.is_chatgpt_subscription() && !response.status.is_success() {
            return Err(match response.status.as_u16() {
                401 | 403 => error(ErrorCode::Unauthorized, "ai-auth"),
                429 => error(ErrorCode::LimitExceeded, "ai-subscription-quota"),
                503 => error(ErrorCode::OutputInvalid, "ai-unavailable"),
                _ => error(ErrorCode::OutputInvalid, "ai-http"),
            });
        }
        Ok(MemberHttpResponse {
            request_id,
            status: response.status.as_u16(),
            content_type: response.content_type,
            body: response.body,
        })
    }
    /// Only positively observed usage may replace unknown occupancy.
    pub fn settle_usage(
        &self,
        request_id: ExecutionId,
        usage: Option<Usage>,
    ) -> Result<(), ExecutionError> {
        if !self
            .active
            .as_ref()
            .is_some_and(|active| active.id == request_id && active.response)
        {
            return Err(error(ErrorCode::ResultMismatch, "member-request-identity"));
        }
        if usage.as_ref().is_some_and(|usage| {
            usage.prompt_tokens > i64::MAX as u64
                || usage.completion_tokens > i64::MAX as u64
                || self.config.output_tokens_exceeded(usage.completion_tokens, 1)
                || usage.validate().is_err()
        }) {
            return Err(error(ErrorCode::OutputInvalid, "member-usage"));
        }
        self.dispatch
            .provider
            .as_ref()
            .ok_or_else(|| error(ErrorCode::Unauthorized, "ai-budget-host"))?
            .settle(request_id, usage, &self.cancellation)
    }
}
