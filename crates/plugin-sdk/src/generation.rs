//! Data-only access to the original, explicitly authorized work-plan generator.
//! Components propose source subsets; the Host retains configuration and authority.
use crate::{
    validation::{digest, encoded_limit, opaque_id, unique},
    *,
};
use serde::{Deserialize, Serialize};

pub const MAX_GENERATION_SERVICE_UNITS: usize = 100;
pub const MAX_GENERATION_SERVICE_INPUT_BYTES: usize = 16 * 1024;
/// Leaves one binding available for the generation service on the process channel.
pub const MAX_PREPARED_TOOL_SERVICE_CALLS: usize = MAX_SERVICE_BINDINGS - 1;
pub const MAX_GENERATION_COMPONENT_INPUT_BYTES: usize = 1 * 1024 * 1024;
pub const MAX_GENERATION_SERVICE_RECEIPT_BYTES: usize = 1024;
pub const MAX_GENERATION_SERVICE_ERROR_BYTES: usize = 1024;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
pub fn generation_service_contract() -> ContractRef {
    contract("tsumugi.work-plan-generation")
}
pub fn generation_service_input_contract() -> ContractRef {
    contract("tsumugi.work-plan-generation-input")
}
pub fn generation_component_input_contract() -> ContractRef {
    contract("tsumugi.generation-component-input")
}
pub fn generation_service_receipt_contract() -> ContractRef {
    contract("tsumugi.work-plan-generation-receipt")
}
pub fn generation_service_error_contract() -> ContractRef {
    contract("tsumugi.work-plan-generation-error")
}

/// The service can send captured text to the plan's original model destination.
/// Its External effect requires a separate ordinary component execution grant.
/// Checking this descriptor neither opens a plan scope nor authorizes a call.
pub fn validate_generation_service_binding(binding: &ServiceBinding) -> Result<(), ContractError> {
    binding.validate()?;
    if binding.contract != generation_service_contract()
        || binding.input_schema != generation_service_input_contract()
        || binding.output_schema != generation_service_receipt_contract()
        || binding.error_schema != generation_service_error_contract()
        || binding.effect != EffectKind::External
    {
        return Err(ContractError::at(
            ContractErrorCode::IncompatibleContract,
            "generation.service",
        ));
    }
    Ok(())
}

/// No model, text payload, destination, consent, lease or budget can be supplied.
/// The real Host derives input from the original plan and checks current scope.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct GenerationServiceInput {
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub task_id: String,
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub attempt_id: String,
    #[cfg_attr(feature = "schema", schemars(schema_with = "units_schema"))]
    pub unit_ids: Vec<String>,
}
impl GenerationServiceInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        opaque_id(&self.task_id, "generation.taskId")?;
        opaque_id(&self.attempt_id, "generation.attemptId")?;
        if self.unit_ids.is_empty() || self.unit_ids.len() > MAX_GENERATION_SERVICE_UNITS {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "generation.unitIds",
            ));
        }
        unique(self.unit_ids.iter(), "generation.unitIds")?;
        for id in &self.unit_ids {
            opaque_id(id, "generation.unitIds")?;
        }
        encoded_limit(self, MAX_GENERATION_SERVICE_INPUT_BYTES, "generation.input")
    }
}

/// One query payload selected from the original work plan. These identities
/// carry data only and do not grant permission to invoke the selected tool.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct PreparedToolServiceCall {
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub handle_id: String,
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub call_id: String,
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub tool_handle: String,
    pub input: EncodedPayload,
}

/// Data supplied to the generation component after the Host prepared its
/// read-only query inputs from the user's selected work plan.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct GenerationComponentInput {
    pub generation: GenerationServiceInput,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "prepared_tool_service_calls_schema")
    )]
    pub prepared_tools: Vec<PreparedToolServiceCall>,
}
impl GenerationComponentInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.generation.validate()?;
        if self.prepared_tools.len() > MAX_PREPARED_TOOL_SERVICE_CALLS {
            return Err(ContractError::at(
                ContractErrorCode::LimitExceeded,
                "generationComponent.preparedTools",
            ));
        }
        encoded_limit(
            self,
            MAX_GENERATION_COMPONENT_INPUT_BYTES,
            "generationComponent.input",
        )?;
        unique(
            self.prepared_tools
                .iter()
                .map(|call| call.handle_id.as_str()),
            "generationComponent.preparedTools.handleId",
        )?;
        unique(
            self.prepared_tools.iter().map(|call| call.call_id.as_str()),
            "generationComponent.preparedTools.callId",
        )?;
        unique(
            self.prepared_tools
                .iter()
                .map(|call| call.tool_handle.as_str()),
            "generationComponent.preparedTools.toolHandle",
        )?;
        for call in &self.prepared_tools {
            opaque_id(
                &call.handle_id,
                "generationComponent.preparedTools.handleId",
            )?;
            opaque_id(&call.call_id, "generationComponent.preparedTools.callId")?;
            opaque_id(
                &call.tool_handle,
                "generationComponent.preparedTools.toolHandle",
            )?;
            call.input.validate()?;
        }
        Ok(())
    }
}

/// The original ledger accepted these identities. A repeated call may already
/// be terminal; this acknowledgement does not claim queue or model completion.
/// It carries no grant, lease, credential or authorization renewal handle.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct GenerationServiceReceipt {
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub task_id: String,
    #[cfg_attr(feature = "schema", schemars(schema_with = "identity_schema"))]
    pub attempt_id: String,
    #[cfg_attr(feature = "schema", schemars(schema_with = "digest_schema"))]
    pub input_digest: String,
}
impl GenerationServiceReceipt {
    pub fn validate(&self) -> Result<(), ContractError> {
        opaque_id(&self.task_id, "generation.taskId")?;
        opaque_id(&self.attempt_id, "generation.attemptId")?;
        digest(&self.input_digest, "generation.inputDigest")?;
        encoded_limit(
            self,
            MAX_GENERATION_SERVICE_RECEIPT_BYTES,
            "generation.receipt",
        )
    }
    pub fn validate_against(&self, input: &GenerationServiceInput) -> Result<(), ContractError> {
        self.validate()?;
        input.validate()?;
        if self.task_id != input.task_id || self.attempt_id != input.attempt_id {
            return Err(ContractError::at(
                ContractErrorCode::ResultMismatch,
                "generation.receipt",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum GenerationServiceErrorCode {
    InvalidInput,
    Unavailable,
    PermissionDenied,
    Cancelled,
    LimitExceeded,
    Conflict,
    Busy,
    StorageFailed,
    OutcomeUnknown,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct GenerationServiceError {
    pub code: GenerationServiceErrorCode,
}
impl GenerationServiceError {
    pub fn validate(&self) -> Result<(), ContractError> {
        encoded_limit(self, MAX_GENERATION_SERVICE_ERROR_BYTES, "generation.error")
    }
}

macro_rules! receiver {
    ($parse:ident, $schema:ident, $ty:ty, $limit:ident) => {
        pub fn $parse(bytes: &[u8]) -> Result<$ty, ContractError> {
            if bytes.len() > $limit {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "generation",
                ));
            }
            let value: $ty = serde_json::from_slice(bytes)
                .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "generation"))?;
            value.validate()?;
            Ok(value)
        }
        #[cfg(feature = "schema")]
        pub fn $schema() -> schemars::Schema {
            schemars::schema_for!($ty)
        }
    };
}
receiver!(
    parse_generation_service_input,
    generation_service_input_schema,
    GenerationServiceInput,
    MAX_GENERATION_SERVICE_INPUT_BYTES
);
receiver!(
    parse_generation_component_input,
    generation_component_input_schema,
    GenerationComponentInput,
    MAX_GENERATION_COMPONENT_INPUT_BYTES
);
receiver!(
    parse_generation_service_receipt,
    generation_service_receipt_schema,
    GenerationServiceReceipt,
    MAX_GENERATION_SERVICE_RECEIPT_BYTES
);
receiver!(
    parse_generation_service_error,
    generation_service_error_schema,
    GenerationServiceError,
    MAX_GENERATION_SERVICE_ERROR_BYTES
);

#[cfg(feature = "schema")]
fn identity_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    // ASCII makes this byte bound exact. The quantified pattern also keeps the
    // generated standalone validator independent of Unicode-length helpers.
    schemars::json_schema!({"type":"string", "pattern":"^[A-Za-z0-9.\\-_:/]{1,128}$"})
}
#[cfg(feature = "schema")]
fn digest_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"string", "pattern":"^[a-f0-9]{64}$"})
}
#[cfg(feature = "schema")]
fn units_schema(generator: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"array", "minItems":1, "maxItems":MAX_GENERATION_SERVICE_UNITS, "uniqueItems":true, "items":identity_schema(generator)})
}
#[cfg(feature = "schema")]
fn prepared_tool_service_calls_schema(
    generator: &mut schemars::generate::SchemaGenerator,
) -> schemars::Schema {
    schemars::json_schema!({"type":"array", "maxItems":MAX_PREPARED_TOOL_SERVICE_CALLS,
        "items":generator.subschema_for::<PreparedToolServiceCall>()})
}
#[cfg(feature = "schema")]
pub fn generation_service_types_schema() -> schemars::Schema {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct GenerationServiceTypes {
        input: GenerationServiceInput,
        receipt: GenerationServiceReceipt,
        error: GenerationServiceError,
    }
    schemars::schema_for!(GenerationServiceTypes)
}
