//! Fixed execution inputs, immutable result evidence and checked adoption contracts.
//!
//! Generating a result never grants permission to apply it. Persistence and the
//! active project session must check these associations again at every mutation.

pub(crate) mod codec;
mod runner;
mod runtime;
#[cfg(feature = "execution-test-host")]
pub mod test_support;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeSet, fmt, sync::Arc};
use uuid::Uuid;

use crate::{Locale, ProjectId};
pub use runner::*;
pub use runtime::{ExecutionRuntime, OutcomeQuery};

pub const MAX_ITEMS: usize = 2000;
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const DEFAULT_RESULT_BYTES: usize = 256 * 1024;
pub const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ATTEMPT_RESULT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DIAGNOSTIC_BYTES: usize = 4096;
pub const MAX_DEPTH: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    InvalidInput,
    LimitExceeded,
    ResultMismatch,
    OutputInvalid,
    DependencyConflict,
    Cancelled,
    OutcomeUnknown,
    Unauthorized,
    Busy,
    StorageFailed,
    CorruptLedger,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionError {
    pub code: ErrorCode,
    pub stage: String,
    pub item_ids: Vec<ExecutionId>,
}

impl ExecutionError {
    pub fn new(code: ErrorCode, stage: &str) -> Self {
        Self {
            code,
            stage: stage.into(),
            item_ids: Vec::new(),
        }
    }
    pub fn for_item(mut self, id: ExecutionId) -> Self {
        self.item_ids.push(id);
        self
    }
}
impl fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} during {}", self.code, self.stage)
    }
}
impl std::error::Error for ExecutionError {}

/// Core-generated identity, with a strict UUIDv4 wire representation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ExecutionId(Uuid);
impl ExecutionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
    pub fn parse(raw: &str) -> Result<Self, ExecutionError> {
        let uuid = Uuid::parse_str(raw)
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "identity"))?;
        if uuid.get_version_num() != 4 || uuid.get_variant() != uuid::Variant::RFC4122 {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "identity"));
        }
        Ok(Self(uuid))
    }
}
impl Default for ExecutionId {
    fn default() -> Self {
        Self::new()
    }
}
impl TryFrom<String> for ExecutionId {
    type Error = ExecutionError;
    fn try_from(v: String) -> Result<Self, Self::Error> {
        Self::parse(&v)
    }
}
impl From<ExecutionId> for String {
    fn from(v: ExecutionId) -> Self {
        v.to_string()
    }
}
impl fmt::Display for ExecutionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// Decimal strings on the wire prevent JavaScript precision loss.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Revision(u64);
impl Revision {
    pub fn new(value: u64) -> Result<Self, ExecutionError> {
        if value > i64::MAX as u64 {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "revision"));
        }
        Ok(Self(value))
    }
    pub fn get(self) -> u64 {
        self.0
    }
    pub fn next(self) -> Result<Self, ExecutionError> {
        Self::new(
            self.0
                .checked_add(1)
                .ok_or_else(|| ExecutionError::new(ErrorCode::LimitExceeded, "revision"))?,
        )
    }
}
impl TryFrom<String> for Revision {
    type Error = ExecutionError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parsed = value
            .parse::<u64>()
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "revision"))?;
        if parsed.to_string() != value {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "revision"));
        }
        Self::new(parsed)
    }
}
impl From<Revision> for String {
    fn from(v: Revision) -> Self {
        v.0.to_string()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub kind: String,
    pub id: String,
    pub locale: Option<String>,
}
impl Scope {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        label(&self.kind)?;
        label(&self.id)?;
        if let Some(locale) = &self.locale {
            let parsed = Locale::parse(locale)
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "scope"))?;
            if parsed.as_str() != locale {
                return Err(ExecutionError::new(ErrorCode::InvalidInput, "scope"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dependency {
    pub kind: String,
    pub id: String,
    pub expected_revision: Revision,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputItem {
    pub item_id: ExecutionId,
    pub scope: Scope,
    pub payload: Value,
    pub dependencies: Vec<Dependency>,
}
impl InputItem {
    pub fn new(scope: Scope, payload: Value, dependencies: Vec<Dependency>) -> Self {
        Self {
            item_id: ExecutionId::new(),
            scope,
            payload,
            dependencies,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionUnit {
    pub unit_id: ExecutionId,
    pub item_ids: Vec<ExecutionId>,
}
impl AdoptionUnit {
    pub fn new(item_ids: Vec<ExecutionId>) -> Self {
        Self {
            unit_id: ExecutionId::new(),
            item_ids,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionLimits {
    pub timeout_ms: u32,
    pub cancel_wait_ms: u32,
    pub max_result_bytes: u32,
    pub max_attempt_result_bytes: u32,
}
impl Default for ExecutionLimits {
    fn default() -> Self {
        Self {
            timeout_ms: 60_000,
            cancel_wait_ms: 5_000,
            max_result_bytes: DEFAULT_RESULT_BYTES as u32,
            max_attempt_result_bytes: MAX_ATTEMPT_RESULT_BYTES as u32,
        }
    }
}
impl ExecutionLimits {
    fn validate(&self, max_timeout_ms: u32) -> Result<(), ExecutionError> {
        if self.timeout_ms == 0
            || self.timeout_ms > max_timeout_ms
            || self.cancel_wait_ms > 5_000
            || self.max_result_bytes == 0
            || self.max_result_bytes as usize > MAX_RESULT_BYTES
            || self.max_attempt_result_bytes < self.max_result_bytes
            || self.max_attempt_result_bytes as usize > MAX_ATTEMPT_RESULT_BYTES
        {
            return Err(ExecutionError::new(ErrorCode::LimitExceeded, "limits"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputEnvelope {
    pub version: u32,
    pub project_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub previous_attempt_id: Option<ExecutionId>,
    pub operation: String,
    pub capability_id: String,
    pub capability_version: String,
    pub settings: Value,
    pub limits: ExecutionLimits,
    pub items: Vec<InputItem>,
    pub units: Vec<AdoptionUnit>,
    pub reused_results: Vec<ReusedResult>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReusedResult {
    pub item_id: ExecutionId,
    pub source_attempt_id: ExecutionId,
    pub result_id: ExecutionId,
}

impl InputEnvelope {
    pub fn new(
        project: ProjectId,
        operation: &str,
        capability_id: &str,
        capability_version: &str,
        items: Vec<InputItem>,
    ) -> Result<Self, ExecutionError> {
        let units = items
            .iter()
            .map(|item| AdoptionUnit::new(vec![item.item_id]))
            .collect();
        Ok(Self {
            version: 1,
            project_id: ExecutionId::parse(&project.to_string())?,
            task_id: ExecutionId::new(),
            attempt_id: ExecutionId::new(),
            previous_attempt_id: None,
            operation: operation.into(),
            capability_id: capability_id.into(),
            capability_version: capability_version.into(),
            settings: Value::Null,
            limits: ExecutionLimits::default(),
            items,
            units,
            reused_results: Vec::new(),
        })
    }

    fn normalize(&mut self) {
        self.reused_results.sort_by_key(|result| result.item_id);
        self.items.sort_by_key(|item| item.item_id);
        for item in &mut self.items {
            item.dependencies.sort();
        }
        self.units.sort_by_key(|unit| unit.unit_id);
        for unit in &mut self.units {
            unit.item_ids.sort();
        }
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.version != 1 || self.previous_attempt_id == Some(self.attempt_id) {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "input"));
        }
        label(&self.operation)?;
        label(&self.capability_id)?;
        label(&self.capability_version)?;
        self.limits.validate(
            if matches!(
                self.operation.as_str(),
                crate::ai::OPERATION | crate::ai::arena::OPERATION
            ) {
                600_000
            } else {
                60_000
            },
        )?;
        if self.items.is_empty()
            || self.items.len() > MAX_ITEMS
            || self.units.is_empty()
            || self.units.len() > MAX_ITEMS
        {
            return Err(ExecutionError::new(ErrorCode::LimitExceeded, "items"));
        }
        let mut items = BTreeSet::new();
        for item in &self.items {
            if !items.insert(item.item_id) {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "duplicate-item",
                ));
            }
            item.scope.validate()?;
            let mut dependencies = BTreeSet::new();
            for dependency in &item.dependencies {
                label(&dependency.kind)?;
                label(&dependency.id)?;
                if !dependencies.insert((&dependency.kind, &dependency.id)) {
                    return Err(ExecutionError::new(
                        ErrorCode::InvalidInput,
                        "duplicate-dependency",
                    ));
                }
            }
        }
        let mut covered = BTreeSet::new();
        let mut units = BTreeSet::new();
        for unit in &self.units {
            if unit.item_ids.is_empty() || !units.insert(unit.unit_id) {
                return Err(ExecutionError::new(ErrorCode::InvalidInput, "unit"));
            }
            for item in &unit.item_ids {
                if !items.contains(item) || !covered.insert(*item) {
                    return Err(ExecutionError::new(
                        ErrorCode::InvalidInput,
                        "unit-coverage",
                    ));
                }
            }
        }
        if covered != items {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "unit-coverage",
            ));
        }
        let mut reused = BTreeSet::new();
        for result in &self.reused_results {
            if self.previous_attempt_id.is_none()
                || result.source_attempt_id == self.attempt_id
                || !items.contains(&result.item_id)
                || !reused.insert(result.item_id)
            {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "reused-result",
                ));
            }
        }
        if reused.len() == items.len() {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "empty-retry"));
        }
        let value = serde_json::to_value(self)
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "input"))?;
        codec::validate_depth(&value, 0)
    }
}

/// Owned immutable bytes survive changes to the caller's request and are reused
/// on restart without reserializing into a potentially different representation.
#[derive(Clone, Debug)]
pub struct FixedInput {
    envelope: Arc<InputEnvelope>,
    bytes: Arc<[u8]>,
    digest: String,
}
impl FixedInput {
    pub fn capture(mut envelope: InputEnvelope) -> Result<Self, ExecutionError> {
        codec::validate_depth(&envelope.settings, 1)?;
        for item in &envelope.items {
            codec::validate_depth(&item.payload, 3)?;
        }
        envelope.normalize();
        let bytes = codec::encode(&envelope, MAX_INPUT_BYTES)?;
        Self::restore(&bytes, &codec::digest(&bytes))
    }
    pub fn restore(bytes: &[u8], expected_digest: &str) -> Result<Self, ExecutionError> {
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(ExecutionError::new(ErrorCode::LimitExceeded, "input"));
        }
        let digest = codec::digest(bytes);
        if digest != expected_digest {
            return Err(ExecutionError::new(
                ErrorCode::CorruptLedger,
                "input-digest",
            ));
        }
        let envelope: InputEnvelope = codec::decode(bytes, MAX_INPUT_BYTES)?;
        envelope.validate()?;
        Ok(Self {
            envelope: Arc::new(envelope),
            bytes: Arc::from(bytes),
            digest,
        })
    }
    pub fn envelope(&self) -> &InputEnvelope {
        &self.envelope
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn item(&self, id: ExecutionId) -> Result<&InputItem, ExecutionError> {
        self.envelope
            .items
            .binary_search_by_key(&id, |item| item.item_id)
            .ok()
            .and_then(|index| self.envelope.items.get(index))
            .or_else(|| self.envelope.items.iter().find(|item| item.item_id == id))
            .ok_or_else(|| ExecutionError::new(ErrorCode::ResultMismatch, "item").for_item(id))
    }
    pub fn retry(&self, item_ids: &[ExecutionId]) -> Result<Self, ExecutionError> {
        self.retry_with_reused(item_ids, Vec::new())
    }
    pub(crate) fn retry_with_reused(
        &self,
        item_ids: &[ExecutionId],
        reused_results: Vec<ReusedResult>,
    ) -> Result<Self, ExecutionError> {
        let selected: BTreeSet<_> = item_ids.iter().copied().collect();
        if selected.len() != item_ids.len()
            || selected.is_empty()
            || selected.iter().any(|id| self.item(*id).is_err())
        {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "retry-scope"));
        }
        let mut next = self.envelope().clone();
        next.reused_results = reused_results;
        let mut included = selected.clone();
        for reused in &next.reused_results {
            if !included.insert(reused.item_id) {
                return Err(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "retry-overlap",
                ));
            }
        }
        next.previous_attempt_id = Some(next.attempt_id);
        next.attempt_id = ExecutionId::new();
        next.items.retain(|item| included.contains(&item.item_id));
        next.units
            .retain(|unit| unit.item_ids.iter().any(|item| selected.contains(item)));
        // A retry cannot silently split an operation's consistency unit.
        if next
            .units
            .iter()
            .any(|unit| unit.item_ids.iter().any(|item| !included.contains(item)))
        {
            return Err(ExecutionError::new(ErrorCode::InvalidInput, "retry-unit"));
        }
        Self::capture(next)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionState {
    Queued,
    Dispatched,
    Succeeded,
    Failed,
    CancelledBeforeDispatch,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ValidationState {
    Absent,
    Pending,
    Valid,
    Invalid,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AdoptionState {
    Unapplied,
    Committed,
    Conflict,
    Rejected,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryAction {
    ResumeUndispatched,
    RetrySafeFailure,
    ValidateOutput,
    AdoptResult,
    QueryOutcome,
    ViewReceipt,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemStatus {
    pub item_id: ExecutionId,
    pub execution: ExecutionState,
    pub validation: ValidationState,
    pub adoption: AdoptionState,
    pub cancellation_requested: bool,
    pub retry_safe: bool,
    pub diagnostic: Option<String>,
}
impl ItemStatus {
    /// These are possible actions, not a reusable authorization grant.
    pub fn recovery_actions(&self) -> Vec<RecoveryAction> {
        if self.adoption == AdoptionState::Committed {
            return vec![RecoveryAction::ViewReceipt];
        }
        match (self.execution, self.validation) {
            (ExecutionState::Queued | ExecutionState::CancelledBeforeDispatch, _) => {
                vec![RecoveryAction::ResumeUndispatched]
            }
            (ExecutionState::Failed, _) if self.retry_safe => {
                vec![RecoveryAction::RetrySafeFailure]
            }
            (ExecutionState::Unknown, _) => vec![RecoveryAction::QueryOutcome],
            (ExecutionState::Succeeded, ValidationState::Pending) => {
                vec![RecoveryAction::ValidateOutput]
            }
            (ExecutionState::Succeeded, ValidationState::Valid) => {
                vec![RecoveryAction::AdoptResult]
            }
            _ => Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub total: u32,
    pub queued: u32,
    pub running: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub unknown: u32,
    pub adopted: u32,
}
impl Progress {
    pub fn from_items(items: &[ItemStatus]) -> Self {
        let mut progress = Self::default();
        for item in items {
            progress.total += 1;
            match item.execution {
                ExecutionState::Queued => progress.queued += 1,
                ExecutionState::Dispatched => progress.running += 1,
                ExecutionState::Succeeded => progress.succeeded += 1,
                ExecutionState::Failed => progress.failed += 1,
                ExecutionState::CancelledBeforeDispatch => progress.cancelled += 1,
                ExecutionState::Unknown => progress.unknown += 1,
            }
            if item.adoption == AdoptionState::Committed {
                progress.adopted += 1;
            }
        }
        progress
    }
}

impl ExecutionState {
    pub fn transition(self, next: Self) -> Result<Self, ExecutionError> {
        use ExecutionState::*;
        if self == next
            || matches!(
                (self, next),
                (Queued, Dispatched | CancelledBeforeDispatch)
                    | (Dispatched, Succeeded | Failed | Unknown)
                    | (Unknown, Succeeded | Failed)
            )
        {
            Ok(next)
        } else {
            Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "state-transition",
            ))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Diagnostic {
    pub code: String,
    pub retry_safe: bool,
}
impl Diagnostic {
    fn validate(&self) -> Result<(), ExecutionError> {
        label(&self.code)?;
        codec::encode(self, MAX_DIAGNOSTIC_BYTES).map(|_| ())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultEnvelope {
    pub project_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
    pub supersedes: Option<ExecutionId>,
    pub dispatch_token: ExecutionId,
    pub capability_id: String,
    pub capability_version: String,
    pub outcome: ExecutionState,
    pub output: Option<Value>,
    pub diagnostic: Option<Diagnostic>,
}
impl ResultEnvelope {
    fn validate(
        &self,
        input: &FixedInput,
        dispatch_token: ExecutionId,
    ) -> Result<(), ExecutionError> {
        let expected = input.envelope();
        if self.project_id != expected.project_id
            || self.attempt_id != expected.attempt_id
            || self.dispatch_token != dispatch_token
            || self.capability_id != expected.capability_id
            || self.capability_version != expected.capability_version
            || self.supersedes == Some(self.result_id)
        {
            return Err(
                ExecutionError::new(ErrorCode::ResultMismatch, "result").for_item(self.item_id)
            );
        }
        input.item(self.item_id)?;
        if !matches!(
            self.outcome,
            ExecutionState::Succeeded | ExecutionState::Failed | ExecutionState::Unknown
        ) || (self.outcome == ExecutionState::Succeeded) != self.output.is_some()
            || (self.outcome != ExecutionState::Succeeded && self.diagnostic.is_none())
        {
            return Err(
                ExecutionError::new(ErrorCode::OutputInvalid, "result").for_item(self.item_id)
            );
        }
        if let Some(diagnostic) = &self.diagnostic {
            diagnostic.validate()?;
            if diagnostic.retry_safe && self.outcome != ExecutionState::Failed {
                return Err(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "retry-evidence",
                ));
            }
        }
        codec::validate_depth(
            &serde_json::to_value(self)
                .map_err(|_| ExecutionError::new(ErrorCode::OutputInvalid, "result"))?,
            0,
        )
    }
}

#[derive(Clone, Debug)]
pub struct FixedResult {
    envelope: Arc<ResultEnvelope>,
    bytes: Arc<[u8]>,
    digest: String,
}
impl FixedResult {
    pub fn capture(
        envelope: ResultEnvelope,
        input: &FixedInput,
        token: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        let bytes = codec::encode(&envelope, input.envelope().limits.max_result_bytes as usize)?;
        Self::receive(&bytes, input, token)
    }
    pub fn receive(
        bytes: &[u8],
        input: &FixedInput,
        token: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        let envelope: ResultEnvelope =
            codec::decode(bytes, input.envelope().limits.max_result_bytes as usize)?;
        envelope.validate(input, token)?;
        Ok(Self {
            envelope: Arc::new(envelope),
            bytes: Arc::from(bytes),
            digest: codec::digest(bytes),
        })
    }
    pub fn restore(
        bytes: &[u8],
        expected_digest: &str,
        input: &FixedInput,
        token: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        if bytes.len() > input.envelope().limits.max_result_bytes as usize {
            return Err(ExecutionError::new(ErrorCode::LimitExceeded, "result"));
        }
        if codec::digest(bytes) != expected_digest {
            return Err(ExecutionError::new(
                ErrorCode::OutputInvalid,
                "result-digest",
            ));
        }
        Self::receive(bytes, input, token)
    }
    pub fn envelope(&self) -> &ResultEnvelope {
        &self.envelope
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
    pub fn is_duplicate_of(&self, previous: &Self) -> Result<bool, ExecutionError> {
        if self.envelope.result_id != previous.envelope.result_id {
            return Ok(false);
        }
        if self.bytes != previous.bytes {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "result-identity",
            ));
        }
        Ok(true)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionAction {
    pub project_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub operation: String,
    pub result_ids: Vec<ExecutionId>,
    pub cancellation_revision: Revision,
    pub parameters: Value,
}
impl AdoptionAction {
    pub fn validate(
        &self,
        input: &FixedInput,
        results: &[FixedResult],
    ) -> Result<(), ExecutionError> {
        let envelope = input.envelope();
        if self.project_id != envelope.project_id
            || self.attempt_id != envelope.attempt_id
            || self.operation != envelope.operation
        {
            return Err(ExecutionError::new(
                ErrorCode::Unauthorized,
                "adoption-scope",
            ));
        }
        let unit = envelope
            .units
            .iter()
            .find(|unit| unit.unit_id == self.unit_id)
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "adoption-unit"))?;
        let ids: BTreeSet<_> = self.result_ids.iter().copied().collect();
        let result_ids: BTreeSet<_> = results
            .iter()
            .map(|result| result.envelope.result_id)
            .collect();
        let items: BTreeSet<_> = results
            .iter()
            .map(|result| result.envelope.item_id)
            .collect();
        if ids.len() != self.result_ids.len()
            || ids != result_ids
            || result_ids.len() != results.len()
            || items.len() != results.len()
            || items != unit.item_ids.iter().copied().collect()
            || results.iter().any(|result| {
                (result.envelope.attempt_id != self.attempt_id
                    && !envelope.reused_results.iter().any(|reference| {
                        reference.item_id == result.envelope.item_id
                            && reference.result_id == result.envelope.result_id
                            && reference.source_attempt_id == result.envelope.attempt_id
                    }))
                    || result.envelope.project_id != self.project_id
                    || result.envelope.outcome != ExecutionState::Succeeded
            })
        {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "adoption-coverage",
            ));
        }
        codec::validate_depth(&self.parameters, 1)?;
        codec::encode(self, MAX_INPUT_BYTES).map(|_| ())
    }
    pub fn digest(
        &self,
        input: &FixedInput,
        results: &[FixedResult],
    ) -> Result<String, ExecutionError> {
        self.validate(input, results)?;
        self.request_digest(input)
    }
    pub(crate) fn request_digest(&self, input: &FixedInput) -> Result<String, ExecutionError> {
        codec::validate_depth(&self.parameters, 1)?;
        let mut action = self.clone();
        action.result_ids.sort();
        // The exact frozen input binds scopes, dependencies, settings and versions.
        let bytes = codec::encode(&(action, input.digest()), MAX_INPUT_BYTES)?;
        Ok(codec::digest(&bytes))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeReference {
    pub kind: String,
    pub id: String,
    pub revision: Revision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptionReceipt {
    pub project_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub action_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub request_digest: String,
    pub changes: Vec<ChangeReference>,
}

fn label(value: &str) -> Result<(), ExecutionError> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(ExecutionError::new(ErrorCode::InvalidInput, "identifier"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
