use crate::{
    validation::{digest, name, opaque_id},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Maximum frozen callable membership of one component process. The complete
/// encoded activation still has the independent process-frame byte ceiling.
pub const MAX_PROCESS_CAPABILITIES: usize = 128;

/// One actual component instance, independent of a selected contribution.
/// This is a claimed wire principal, not a grant or proof of package provenance.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ComponentInstanceBinding {
    pub plugin: PluginIdentity,
    pub component_id: String,
    pub package_digest: String,
    pub instance_id: String,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub activation_generation: u32,
}
impl ComponentInstanceBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.plugin.validate()?;
        name(&self.component_id, "instance.componentId")?;
        digest(&self.package_digest, "instance.packageDigest")?;
        opaque_id(&self.instance_id, "instance.instanceId")?;
        if self.activation_generation == 0 {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "instance.activationGeneration",
            ));
        }
        Ok(())
    }

    /// Construct a syntactically valid call binding. This does not establish
    /// roster membership; use `ProcessActivation::provider` for that check.
    pub fn provider(&self, contribution_id: &str) -> Result<ProviderBinding, ContractError> {
        self.validate()?;
        let provider = ProviderBinding {
            plugin: self.plugin.clone(),
            component_id: self.component_id.clone(),
            contribution_id: contribution_id.into(),
            package_digest: self.package_digest.clone(),
            instance_id: self.instance_id.clone(),
            activation_generation: self.activation_generation,
        };
        provider.validate()?;
        Ok(provider)
    }

    /// Compare only the component principal, without proving membership,
    /// authority, scope, a deadline or permission to accept an invocation.
    pub fn matches_provider(&self, provider: &ProviderBinding) -> bool {
        self == &provider.instance()
    }
}

/// One callable declaration in the Host-captured component roster.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProcessCapability {
    pub contribution_id: String,
    pub capability: CapabilityDeclaration,
}
impl ProcessCapability {
    pub fn validate(&self) -> Result<(), ContractError> {
        name(
            &self.contribution_id,
            "activation.capabilities.contributionId",
        )?;
        self.capability.validate(&self.capability.permissions)
    }
}

/// A frozen declaration roster for one actual component channel. A Ready
/// receiver must compare the complete value to its original Activate. Echoing
/// it is a handshake claim, never a grant or source proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ProcessActivation {
    pub instance: ComponentInstanceBinding,
    #[cfg_attr(feature = "schema", schemars(schema_with = "capabilities_schema"))]
    pub capabilities: Vec<ProcessCapability>,
    /// Host-selected project services, resolved before component activation.
    pub services: Vec<ServiceBinding>,
}
impl ProcessActivation {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.instance.validate()?;
        if self.capabilities.is_empty() || self.capabilities.len() > MAX_PROCESS_CAPABILITIES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "activation.capabilities",
            ));
        }
        let mut ids = BTreeSet::new();
        for member in &self.capabilities {
            member.validate()?;
            if !ids.insert(&member.contribution_id) {
                return Err(ContractError::at(
                    ContractErrorCode::DuplicateIdentity,
                    "activation.capabilities",
                ));
            }
        }
        validate_service_bindings(&self.services)
    }

    /// Look up the exact captured member. Validation and runtime authority are
    /// separate; this never selects an arbitrary first member as a substitute.
    pub fn capability(&self, contribution_id: &str) -> Option<&ProcessCapability> {
        self.capabilities
            .iter()
            .find(|member| member.contribution_id == contribution_id)
    }

    /// Validate the roster and derive the full binding of an exact member.
    /// This authenticates neither the channel nor permission to invoke it.
    pub fn provider(&self, contribution_id: &str) -> Result<ProviderBinding, ContractError> {
        self.validate()?;
        if self.capability(contribution_id).is_none() {
            return Err(ContractError::at(
                ContractErrorCode::IncompatibleContract,
                "activation.capabilities.contributionId",
            ));
        }
        self.instance.provider(contribution_id)
    }
}

#[cfg(feature = "schema")]
fn capabilities_schema(generator: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "array", "minItems": 1,
        "maxItems": MAX_PROCESS_CAPABILITIES,
        "items": generator.subschema_for::<ProcessCapability>() })
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
    ServiceRequest(ServiceRequest),
    ServiceResponse(ServiceResponse),
    Cancel { dispatch_id: String },
    Cancelled { dispatch_id: String },
    Close { instance: ComponentInstanceBinding },
    Closed { instance: ComponentInstanceBinding },
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
            ProcessBody::Activate(a) | ProcessBody::Ready(a) => a.validate(),
            ProcessBody::Invoke(request) => request.validate(),
            ProcessBody::Result(result) => result.validate(),
            ProcessBody::ServiceRequest(request) => request.validate(),
            ProcessBody::ServiceResponse(response) => response.validate(),
            ProcessBody::Cancel { dispatch_id } | ProcessBody::Cancelled { dispatch_id } => {
                opaque_id(dispatch_id, "process.dispatchId")
            }
            ProcessBody::Close { instance } | ProcessBody::Closed { instance } => {
                instance.validate()
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
        if bytes.len() > MAX_PROCESS_FRAME_BYTES {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "process",
            ));
        }
        Ok(bytes)
    }
}
pub fn parse_process_frame(bytes: &[u8]) -> Result<ProcessFrame, ContractError> {
    if bytes.is_empty() || bytes.len() > MAX_PROCESS_FRAME_BYTES {
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
