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
    pub input: FixedInput,
    pub item_id: ExecutionId,
    pub dispatch_token: ExecutionId,
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
pub struct ResultSender(SyncSender<FixedResult>);
impl ResultSender {
    pub fn send(&self, result: FixedResult) -> Result<(), ExecutionError> {
        self.0
            .send(result)
            .map_err(|_| ExecutionError::new(ErrorCode::Cancelled, "result-channel"))
    }
}
pub fn result_channel() -> (ResultSender, Receiver<FixedResult>) {
    let (sender, receiver) = sync_channel(8);
    (ResultSender(sender), receiver)
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

pub trait AdoptionHandler: Send + Sync {
    fn operation(&self) -> &str;
    /// Operation-specific scope and dependency checks happen inside this same
    /// transaction immediately before the writes. Errors roll back the unit.
    fn apply(
        &self,
        transaction: &AdoptionTransaction<'_>,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<Vec<ChangeReference>, ExecutionError>;
}
