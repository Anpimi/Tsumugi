use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc::{Receiver, SyncSender, sync_channel},
};

use super::*;

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn request(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_requested(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug)]
pub struct DispatchRequest {
    pub(crate) provider: Option<crate::ai::provider::BudgetPort>,
    pub(crate) plugin_permit: Option<PluginPermit>,
    pub input: FixedInput,
    pub item_id: ExecutionId,
    pub dispatch_token: ExecutionId,
}
impl DispatchRequest {
    pub fn plugin_permit(&self) -> Option<&PluginPermit> {
        self.plugin_permit.as_ref()
    }
}

/// Chosen by the trusted host, never by a producer's manifest or result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryPolicy {
    ReadOnly,
    IdempotentLocalWrite,
    ExternalUnknown,
}
impl RecoveryPolicy {
    pub fn allows_replay(self) -> bool {
        self != Self::ExternalUnknown
    }
}

#[derive(Clone)]
pub enum QueryOutcome {
    Known(FixedResult),
    Pending,
    Unavailable,
}

/// An in-process producer receives data and a bounded result channel, never a
/// ProjectStore or a transaction. Returning from run does not adopt its results.
pub trait Runner: Send + Sync + 'static {
    fn capability_id(&self) -> &str;
    fn capability_version(&self) -> &str;
    fn plugin_provider(&self) -> Option<&tsumugi_plugin_sdk::ProviderSelectionBinding> {
        None
    }
    /// The exact approved environment paired with `plugin_provider`. Registration
    /// requires both values together; these descriptions do not grant execution.
    fn plugin_environment(&self) -> Option<&tsumugi_plugin_sdk::RuntimeEnvironmentDescriptor> {
        None
    }
    fn concurrency_limit(&self, _input: &FixedInput) -> usize {
        1
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError>;
    fn query(&self, _request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        Ok(QueryOutcome::Unavailable)
    }
}

#[derive(Clone)]
pub struct ResultSender {
    sender: SyncSender<FixedResult>,
    validator: Option<(FixedInput, Arc<dyn ResultValidator>)>,
}
impl ResultSender {
    pub(crate) fn with_validator(
        mut self,
        input: FixedInput,
        validator: Arc<dyn ResultValidator>,
    ) -> Self {
        self.validator = Some((input, validator));
        self
    }
    pub fn send(&self, mut result: FixedResult) -> Result<(), ExecutionError> {
        if result.envelope().outcome == ExecutionState::Succeeded {
            if let Some((input, validator)) = &self.validator {
                let checked =
                    FixedResult::receive(result.bytes(), input, result.envelope().dispatch_token)?;
                let prepared = ResultValidationCapture {
                    input: input.clone(),
                    result: checked,
                }
                .prepare(validator.as_ref())?;
                result.semantic_validation = Some(prepared.proof);
            }
        }
        self.sender
            .send(result)
            .map_err(|_| ExecutionError::new(ErrorCode::Cancelled, "result-channel"))
    }
}
pub fn result_channel() -> (ResultSender, Receiver<FixedResult>) {
    let (sender, receiver) = sync_channel(8);
    (
        ResultSender {
            sender,
            validator: None,
        },
        receiver,
    )
}

/// A trusted Core operation can query and update domain tables in the owning
/// adoption transaction. It must not run transaction-control SQL or external IO.
/// The wrapper deliberately provides no commit, connection or nested transaction.
pub struct AdoptionTransaction<'a> {
    transaction: &'a rusqlite::Transaction<'a>,
}
impl<'a> AdoptionTransaction<'a> {
    pub(crate) fn new(transaction: &'a rusqlite::Transaction<'a>) -> Self {
        Self { transaction }
    }
    pub fn query_row<
        T,
        P: rusqlite::Params,
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    >(
        &self,
        sql: &str,
        params: P,
        map: F,
    ) -> Result<T, ExecutionError> {
        self.transaction
            .query_row(sql, params, map)
            .map_err(storage_error)
    }
    pub fn query_rows<
        T,
        P: rusqlite::Params,
        F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    >(
        &self,
        sql: &str,
        params: P,
        map: F,
    ) -> Result<Vec<T>, ExecutionError> {
        let mut statement = self.transaction.prepare(sql).map_err(storage_error)?;
        statement
            .query_map(params, map)
            .map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)
    }
    pub fn execute<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> Result<usize, ExecutionError> {
        self.transaction.execute(sql, params).map_err(storage_error)
    }
}
fn storage_error(error: rusqlite::Error) -> ExecutionError {
    let code = if matches!(error, rusqlite::Error::QueryReturnedNoRows) {
        ErrorCode::DependencyConflict
    } else {
        ErrorCode::StorageFailed
    };
    ExecutionError::new(code, "adoption-handler")
}

/// A prepared mutation belongs to a trusted Core adapter, never to a plugin.
/// It may recheck bounded database facts and write atomically, but must not
/// parse domain formats, call producers, perform external IO, or control transactions.
pub type PreparedMutation = Box<
    dyn FnOnce(&AdoptionTransaction<'_>) -> Result<Vec<ChangeReference>, ExecutionError> + Send,
>;

/// Core-owned bridge from immutable execution evidence to a checked mutation.
/// Producers use Runner/result contracts and never receive this SQL authority.
pub trait AdoptionHandler: Send + Sync {
    fn operation(&self) -> &str;
    /// Decode and validate domain evidence outside all database transactions.
    /// Capture validated values in the returned mutation; do not defer parsing.
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError>;
}
