use crate::{validation::opaque_id, *};
use serde::{Deserialize, Serialize};

/// A captured declaration for one capability on one actual component channel.
/// Echoing this structure is a handshake claim, never a grant or source proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProcessActivation {
    pub provider: ProviderBinding,
    pub capability: CapabilityDeclaration,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ProcessBody {
    Activate(ProcessActivation),
    Ready(ProcessActivation),
    Invoke(InvocationRequest),
    Result(InvocationResult),
    Cancel { dispatch_id: String },
    Cancelled { dispatch_id: String },
    Close { provider: ProviderBinding },
    Closed { provider: ProviderBinding },
    Ping { nonce: String },
    Pong { nonce: String },
}

/// Wire representation: a four-byte big-endian length followed by exactly that
/// many JSON bytes. Stdout is reserved for frames; stderr is a separate bounded
/// diagnostic stream. Hosts must also enforce direction, state and deadlines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProcessFrame {
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::process_protocol_schema")
    )]
    pub protocol_version: u32,
    pub body: ProcessBody,
}
impl ProcessFrame {
    pub fn new(body: ProcessBody) -> Self {
        Self {
            protocol_version: PROCESS_PROTOCOL,
            body,
        }
    }
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol_version != PROCESS_PROTOCOL {
            return Err(ContractError::at(
                ContractErrorCode::UnsupportedProtocol,
                "process.protocolVersion",
            ));
        }
        match &self.body {
            ProcessBody::Activate(a) | ProcessBody::Ready(a) => {
                a.provider.validate()?;
                a.capability.validate(&a.capability.permissions)
            }
            ProcessBody::Invoke(request) => request.validate(),
            ProcessBody::Result(result) => result.validate(),
            ProcessBody::Cancel { dispatch_id } | ProcessBody::Cancelled { dispatch_id } => {
                opaque_id(dispatch_id, "process.dispatchId")
            }
            ProcessBody::Close { provider } | ProcessBody::Closed { provider } => {
                provider.validate()
            }
            ProcessBody::Ping { nonce } | ProcessBody::Pong { nonce } => {
                opaque_id(nonce, "process.nonce")
            }
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>, ContractError> {
        self.validate()?;
        let bytes = serde_json::to_vec(self)
            .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "process"))?;
        if bytes.len() > MAX_EXCHANGE_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "process",
            ));
        }
        Ok(bytes)
    }
}
pub fn parse_process_frame(bytes: &[u8]) -> Result<ProcessFrame, ContractError> {
    if bytes.is_empty() || bytes.len() > MAX_EXCHANGE_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "process",
        ));
    }
    let frame: ProcessFrame = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "process"))?;
    frame.validate()?;
    Ok(frame)
}
