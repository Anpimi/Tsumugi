//! Session-local invalidation versions, never a second source of project facts.
use crate::execution::Revision;
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "kebab-case")]
pub enum ChangeScope {
    Project,
    Source,
    Translation,
    Resources,
    Review,
    Arena,
    Release,
    Execution,
}

impl ChangeScope {
    pub(crate) fn for_fact(kind: &str) -> Self {
        match kind {
            "source-snapshot" => Self::Source,
            "translation-revision" | "translation-selection" => Self::Translation,
            "release" => Self::Release,
            // An extension can affect facts the desktop does not yet understand.
            _ => Self::Project,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeSnapshot {
    #[cfg_attr(feature = "wire-schema", schemars(with = "crate::execution::ExecutionId"))]
    pub epoch: String,
    pub sequence: Revision,
    pub progress_sequence: Revision,
    pub scopes: Vec<ChangeScope>,
}

#[derive(Debug, Default)]
pub(super) struct ChangeClock(Mutex<ClockState>);
#[derive(Debug)]
struct ClockState {
    epoch: String,
    sequence: u64,
    progress_sequence: u64,
    scopes: BTreeMap<ChangeScope, u64>,
}

impl Default for ClockState {
    fn default() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            progress_sequence: 0,
            scopes: BTreeMap::new(),
        }
    }
}

impl ChangeClock {
    pub(super) fn snapshot(&self, after: Revision) -> ChangeSnapshot {
        let state = self.0.lock().expect("project change clock poisoned");
        ChangeSnapshot {
            epoch: state.epoch.clone(),
            sequence: Revision::new(state.sequence).expect("bounded change sequence"),
            progress_sequence: Revision::new(state.progress_sequence)
                .expect("bounded progress sequence"),
            scopes: state
                .scopes
                .iter()
                .filter_map(|(&scope, &sequence)| (sequence > after.get()).then_some(scope))
                .collect(),
        }
    }

    pub(super) fn observe(
        self: &Arc<Self>,
        tx: &Transaction<'_>,
        scope: ChangeScope,
    ) -> CommitObserver {
        CommitObserver {
            clock: self.clone(),
            before: tx.total_changes(),
            scopes: vec![scope],
        }
    }

    fn record(&self, scopes: &[ChangeScope]) {
        let mut state = self.0.lock().expect("project change clock poisoned");
        if scopes.iter().any(|scope| *scope != ChangeScope::Execution) {
            state.sequence = state
                .sequence
                .checked_add(1)
                .filter(|value| *value <= i64::MAX as u64)
                .expect("project change sequence exhausted");
            let sequence = state.sequence;
            for &scope in scopes
                .iter()
                .filter(|scope| **scope != ChangeScope::Execution)
            {
                state.scopes.insert(scope, sequence);
            }
        }
        if scopes.contains(&ChangeScope::Execution) {
            state.progress_sequence = state
                .progress_sequence
                .checked_add(1)
                .filter(|value| *value <= i64::MAX as u64)
                .expect("project progress sequence exhausted");
        }
    }
}

pub(super) struct CommitObserver {
    clock: Arc<ChangeClock>,
    before: u64,
    scopes: Vec<ChangeScope>,
}
impl CommitObserver {
    pub(super) fn add_scope(&mut self, scope: ChangeScope) {
        if !self.scopes.contains(&scope) {
            self.scopes.push(scope);
        }
    }
    pub(super) fn commit(self, tx: Transaction<'_>) -> rusqlite::Result<()> {
        // total_changes is compared only inside this transaction. Rolled-back
        // earlier statements cannot generate a committed invalidation.
        let changed = tx.total_changes() != self.before;
        tx.commit()?;
        if changed {
            self.clock.record(&self.scopes);
        }
        Ok(())
    }
}

impl super::ProjectStore {
    /// Versions reset on reopen; consumers must reconcile both session and epoch.
    pub fn changes_since(&self, after: Revision) -> ChangeSnapshot {
        self.changes.snapshot(after)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_committed_changes_advance_versions_and_progress_is_separate() {
        let clock = Arc::new(ChangeClock::default());
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE facts(value INTEGER PRIMARY KEY)")
            .unwrap();
        let tx = connection.transaction().unwrap();
        let observer = clock.observe(&tx, ChangeScope::Translation);
        tx.execute("INSERT INTO facts VALUES(1)", []).unwrap();
        drop(observer);
        drop(tx);
        assert_eq!(
            clock.snapshot(Revision::new(0).unwrap()).sequence,
            Revision::new(0).unwrap()
        );
        let tx = connection.transaction().unwrap();
        clock
            .observe(&tx, ChangeScope::Translation)
            .commit(tx)
            .unwrap();
        assert_eq!(
            clock.snapshot(Revision::new(0).unwrap()).sequence,
            Revision::new(0).unwrap()
        );
        for scope in [
            ChangeScope::Translation,
            ChangeScope::Resources,
            ChangeScope::Execution,
        ] {
            let tx = connection.transaction().unwrap();
            let observer = clock.observe(&tx, scope);
            tx.execute("INSERT INTO facts VALUES(?1)", [scope as i64])
                .unwrap();
            observer.commit(tx).unwrap();
        }
        let snapshot = clock.snapshot(Revision::new(1).unwrap());
        assert_eq!(snapshot.sequence.get(), 2);
        assert_eq!(snapshot.progress_sequence.get(), 1);
        assert_eq!(snapshot.scopes, [ChangeScope::Resources]);
        let tx = connection.transaction().unwrap();
        let observer = clock.observe(&tx, ChangeScope::Source);
        tx.execute("INSERT INTO facts VALUES(30)", []).unwrap();
        // Deferred FK failure makes COMMIT fail, and must not publish a change.
        tx.execute_batch("CREATE TABLE invalid(parent INTEGER REFERENCES facts(value) DEFERRABLE INITIALLY DEFERRED)").unwrap();
        tx.execute("INSERT INTO invalid VALUES(999)", []).unwrap();
        assert!(observer.commit(tx).is_err());
        assert_eq!(clock.snapshot(Revision::new(0).unwrap()).sequence.get(), 2);
    }
}
