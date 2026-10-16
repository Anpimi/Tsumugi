//! One local, read-only observation of a committed source adoption.
use super::*;
use crate::application::MaintenanceAssessment;

pub const SOURCE_MAINTENANCE_HOOK_POLICY: &str = "source-maintenance-notice-1";
pub const SOURCE_MAINTENANCE_HOOK_MAX_LIFETIME_MS: u64 = 600_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookSession {
    pub policy_version: String,
    pub session_epoch: String,
    pub default_lifetime_ms: u64,
    pub max_lifetime_ms: u64,
    pub window_limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookActivation {
    pub policy_version: String,
    pub session_epoch: String,
    pub locale: String,
    pub after: u32,
    pub limit: u32,
    pub expires_at_ms: u64,
}

pub fn required_maintenance_hook<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SourceMaintenanceHookActivation>, D::Error> {
    Option::deserialize(deserializer)
}
#[cfg(feature = "wire-schema")]
pub fn maintenance_hook_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SourceMaintenanceHookActivation> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookCause {
    pub project_id: ExecutionId,
    pub source_action_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
    pub result_digest: String,
    pub source_snapshot_id: ExecutionId,
    pub content_revision: Revision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceMaintenanceHookPhase {
    Prepared,
    Pending,
    Running,
    Observed,
    Failed,
    Stopped,
    Expired,
    Superseded,
    Interrupted,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookOutcome {
    pub run_id: ExecutionId,
    pub cause: SourceMaintenanceHookCause,
    pub activation: SourceMaintenanceHookActivation,
    pub phase: SourceMaintenanceHookPhase,
    #[serde(deserialize_with = "required_assessment")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "assessment_schema"))]
    pub assessment: Option<MaintenanceAssessment>,
    #[serde(deserialize_with = "required_error")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "error_schema"))]
    pub error: Option<ExecutionError>,
}
fn required_assessment<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<MaintenanceAssessment>, D::Error> {
    Option::deserialize(d)
}
fn required_error<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<ExecutionError>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn assessment_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<MaintenanceAssessment> as schemars::JsonSchema>::json_schema(g)
}
#[cfg(feature = "wire-schema")]
fn error_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<ExecutionError> as schemars::JsonSchema>::json_schema(g)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct StopSourceMaintenanceHook {
    pub project_id: ExecutionId,
    pub source_action_id: ExecutionId,
    pub action_id: ExecutionId,
    pub activation: SourceMaintenanceHookActivation,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookStopReceipt {
    pub request: StopSourceMaintenanceHook,
    pub admission_closed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceMaintenanceHookStopResult {
    NotKnown,
    Stopped {
        receipt: SourceMaintenanceHookStopReceipt,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookView {
    pub source_action_id: ExecutionId,
    pub activation: SourceMaintenanceHookActivation,
    #[serde(deserialize_with = "required_cause")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "cause_schema"))]
    pub cause: Option<SourceMaintenanceHookCause>,
    pub phase: SourceMaintenanceHookPhase,
    pub admission_closed: bool,
    #[serde(deserialize_with = "required_stop")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "stop_schema"))]
    pub stop: Option<SourceMaintenanceHookStopReceipt>,
    #[serde(deserialize_with = "required_outcome")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "outcome_schema"))]
    pub outcome: Option<SourceMaintenanceHookOutcome>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceMaintenanceHookReadState {
    ActionNotKnown,
    NotEnabled,
    Prepared,
    Adopted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceMaintenanceHookRead {
    pub source_action_id: ExecutionId,
    pub state: SourceMaintenanceHookReadState,
    #[serde(deserialize_with = "required_view")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "view_schema"))]
    pub view: Option<SourceMaintenanceHookView>,
}
fn required_view<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<SourceMaintenanceHookView>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn view_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SourceMaintenanceHookView> as schemars::JsonSchema>::json_schema(g)
}
fn required_cause<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<SourceMaintenanceHookCause>, D::Error> {
    Option::deserialize(d)
}
fn required_stop<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<SourceMaintenanceHookStopReceipt>, D::Error> {
    Option::deserialize(d)
}
fn required_outcome<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<SourceMaintenanceHookOutcome>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn cause_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SourceMaintenanceHookCause> as schemars::JsonSchema>::json_schema(g)
}
#[cfg(feature = "wire-schema")]
fn stop_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SourceMaintenanceHookStopReceipt> as schemars::JsonSchema>::json_schema(g)
}
#[cfg(feature = "wire-schema")]
fn outcome_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SourceMaintenanceHookOutcome> as schemars::JsonSchema>::json_schema(g)
}

/// Only the originating Store can admit, capture and finish an observation.
#[derive(Clone, Debug)]
pub struct ClaimedSourceMaintenanceHook {
    pub(crate) epoch: String,
    pub(crate) run_id: ExecutionId,
    pub(crate) cause: SourceMaintenanceHookCause,
    pub(crate) activation: SourceMaintenanceHookActivation,
}
impl ClaimedSourceMaintenanceHook {
    pub fn source_action_id(&self) -> ExecutionId {
        self.cause.source_action_id
    }
    pub fn run_id(&self) -> ExecutionId {
        self.run_id
    }
    pub fn failed(self, error: ExecutionError) -> ComputedSourceMaintenanceHook {
        ComputedSourceMaintenanceHook(
            SourceMaintenanceHookOutcome {
                run_id: self.run_id,
                cause: self.cause,
                activation: self.activation,
                phase: SourceMaintenanceHookPhase::Failed,
                assessment: None,
                error: Some(error),
            },
            self.epoch,
        )
    }
}
#[derive(Clone, Debug)]
pub struct CapturedSourceMaintenanceHook {
    pub(crate) claim: ClaimedSourceMaintenanceHook,
    pub(crate) assessment:
        Result<crate::persistence::CapturedMaintenanceAssessment, ExecutionError>,
}
#[derive(Clone, Debug)]
pub struct ComputedSourceMaintenanceHook(
    pub(crate) SourceMaintenanceHookOutcome,
    pub(crate) String,
);
impl CapturedSourceMaintenanceHook {
    pub fn failed(mut self, error: ExecutionError) -> ComputedSourceMaintenanceHook {
        self.assessment = Err(error);
        self.evaluate()
    }
    /// Pure bounded computation; no Store, runtime, grant or external IO.
    pub fn evaluate(self) -> ComputedSourceMaintenanceHook {
        let (phase, assessment, error) = match self.assessment.and_then(|capture| {
            let value = capture.evaluate()?;
            value.validate()?;
            codec::encode(&value, MAX_INPUT_BYTES)?;
            Ok(value)
        }) {
            Ok(value) => (SourceMaintenanceHookPhase::Observed, Some(value), None),
            Err(error) => (SourceMaintenanceHookPhase::Failed, None, Some(error)),
        };
        let mut outcome = SourceMaintenanceHookOutcome {
            run_id: self.claim.run_id,
            cause: self.claim.cause,
            activation: self.claim.activation,
            phase,
            assessment,
            error,
        };
        if let Err(error) = codec::encode(&outcome, MAX_INPUT_BYTES) {
            outcome.phase = SourceMaintenanceHookPhase::Failed;
            outcome.assessment = None;
            outcome.error = Some(error);
        }
        ComputedSourceMaintenanceHook(outcome, self.claim.epoch)
    }
}
