//! Internal application member channel; independent of the plugin Process protocol.
use crate::{
    ai::Usage,
    execution::{ExecutionError, ExecutionId},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL: u32 = 3;
pub const MAX_FRAME_BYTES: usize = tsumugi_plugin_sdk::MAX_PROCESS_FRAME_BYTES;
pub const MAX_SESSION_BYTES: usize = 64 * 1024 * 1024;

macro_rules! wire {
    ($item:item) => {
        #[derive(Clone, Debug, Serialize, Deserialize)]
        #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
        $item
    };
}
wire! {
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct MemberFrame {
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 3, max = 3)))]
        pub protocol_version: u32,
        pub session_id: ExecutionId,
        pub sequence: u32,
        pub body: MemberBody,
    }
}
wire! {
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct MemberProfile {
        pub endpoint: String,
        pub model: String,
        pub token_field: TokenField,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16384)))]
        pub max_output_tokens: u32,
        #[cfg_attr(feature = "wire-schema", schemars(range(min = 1)))]
        pub context_tokens: Option<u32>,
    }
}
wire! {
    pub enum TokenField { #[serde(rename = "max_tokens")] MaxTokens, #[serde(rename = "max_completion_tokens")] MaxCompletionTokens }
}
wire! {
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct MemberSharedView {
        pub view_id: ExecutionId,
        pub utf8: String,
    }
}
wire! {
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct MemberTool {
        pub name: String,
        pub description: String,
        pub parameters: Value,
    }
}
wire! {
    #[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
    pub enum MemberBody {
        Start { member_id: ExecutionId, work_item_id: ExecutionId, context_version: String, profile: MemberProfile,
            system_prompt: String, context: Value, input: String, tools: Vec<MemberTool>, max_turns: u32, timeout_ms: u32 },
        Ready,
        Request { request: u32, call: MemberCall },
        Reply { request: u32, reply: MemberReply },
        Guide { text: String },
        Close,
        Result { messages: Value, turn_limit_reached: bool },
        Closed,
        Fault { code: String },
    }
}
wire! {
    #[serde(tag = "method", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
    pub enum MemberCall {
        Prepare { messages: Value },
        Http { request_id: ExecutionId, endpoint: String, body: String },
        BeforeTool { request_id: ExecutionId, call_id: String, name: String, arguments: Value },
        ExecuteTool { request_id: ExecutionId, call_id: String, name: String, arguments: Value },
        AfterTool { request_id: ExecutionId, call_id: String, name: String, result: Value, is_error: bool },
        FinishTurn { request_id: ExecutionId, stop_reason: String },
        Event { request_id: Option<ExecutionId>, event: Value },
        Usage { request_id: ExecutionId, usage: Option<Usage> },
    }
}
wire! {
    #[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase", deny_unknown_fields)]
    pub enum MemberReply {
        Prepared { request_id: ExecutionId, shared_view: Option<MemberSharedView> },
        Http { request_id: ExecutionId, status: u16, content_type: Option<String>, body: String },
        ToolAdmission { block: bool, reason: Option<String> },
        ToolResult { content: Value, details: Value, is_error: bool },
        ToolFinalized { content: Option<Value>, is_error: Option<bool> },
        Turn { action: TurnAction },
        Recorded,
        Rejected { error: ExecutionError },
    }
}
wire! {
    #[serde(rename_all = "kebab-case")]
    pub enum TurnAction { Normal, End, Continue }
}

/// Decode at the process trust boundary with Core's existing duplicate-key and depth checks.
pub fn decode_frame(bytes: &[u8], limit: usize) -> Result<MemberFrame, ExecutionError> {
    let frame: MemberFrame = crate::execution::codec::decode(bytes, limit.min(MAX_FRAME_BYTES))?;
    if frame.protocol_version != PROTOCOL {
        return Err(ExecutionError::new(
            crate::execution::ErrorCode::InvalidInput,
            "member-protocol",
        ));
    }
    Ok(frame)
}
/// Bound serialization before allocating a complete outbound frame.
pub fn encode_frame(frame: &MemberFrame, limit: usize) -> Result<Vec<u8>, ExecutionError> {
    crate::execution::codec::encode(frame, limit.min(MAX_FRAME_BYTES))
}
