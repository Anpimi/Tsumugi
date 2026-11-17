use super::*;
use crate::persistence::{ChangeSnapshot, PersistenceError, ledger::{self, ReadSnapshotStamp}};
use std::sync::Arc;

/// An authorized, pinned, read-only SQLite snapshot. It never owns a project
/// lock or an execution permit.
pub struct PreparedReviewEligibility {
    reader: Connection,
    observation: ChangeSnapshot,
    stamp: ReadSnapshotStamp,
    project: ExecutionId,
    cancellation: Arc<Cancellation>,
}

/// The SQLite read lock is released before this value reaches the session.
pub struct CompletedReviewEligibility {
    eligibility: Eligibility,
    stamp: ReadSnapshotStamp,
    cancellation: Arc<Cancellation>,
}

fn snapshot_error(error: PersistenceError) -> ExecutionError {
    let code = match error {
        PersistenceError::Busy { .. } => ErrorCode::Busy,
        PersistenceError::CorruptProject { .. } | PersistenceError::UnsupportedSchema { .. } => ErrorCode::CorruptLedger,
        _ => ErrorCode::StorageFailed,
    };
    failure(code, "review-read-snapshot")
}

impl PreparedReviewEligibility {
    pub fn calculate(
        self,
        locales: &[String],
        translation_scopes: &BTreeMap<String, Vec<ExecutionId>>,
    ) -> Result<CompletedReviewEligibility, ExecutionError> {
        let Self { reader, observation, stamp, project, cancellation } = self;
        queries::check_read_cancel(&cancellation)?;
        let result = ProjectStore::review_build_targets_from(
            &reader, observation, project, locales, translation_scopes, &cancellation, |_, _| {},
        );
        drop(reader);
        // SQLite interrupt errors belong to the cancelled read outcome.
        queries::check_read_cancel(&cancellation)?;
        Ok(CompletedReviewEligibility { eligibility: result?, stamp, cancellation })
    }
}

impl ProjectStore {
    /// Open the secondary reader only if it can be tied to the owned database
    /// file. The caller may use the original project connection otherwise.
    pub fn prepare_review_eligibility_read(
        &self,
        project: ExecutionId,
        cancellation: &Cancellation,
    ) -> Result<Option<PreparedReviewEligibility>, ExecutionError> {
        use crate::persistence::{DATABASE_FILENAME, PersistenceStage, read_metadata_from, reopen::FileStamp, require_current_schema};
        use rusqlite::OpenFlags;

        queries::check_read_cancel(cancellation)?;
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-read"));
        }
        let Some(opening) = self.open_basis.as_ref() else { return Ok(None); };
        let path = self.directory().canonicalize()
            .map_err(|_| failure(ErrorCode::DependencyConflict, "review-read-file"))?
            .join(DATABASE_FILENAME);
        let initial = FileStamp::read(&path)
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-read-file"))?;
        if !opening.owns_file(&initial) {
            // The reopen proof's OS file identity is currently Unix-only.
            #[cfg(not(unix))]
            return Ok(None);
            #[cfg(unix)]
            return Err(failure(ErrorCode::DependencyConflict, "review-read-file"));
        }
        let connection = self.connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        let Some(cancellation) = ledger::watch_review_reader(connection, cancellation.clone())? else {
            return Ok(None);
        };
        let reader = Connection::open_with_flags(
            &path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        ).map_err(sql)?;
        // Admission runs on the project owner. An external writer must not
        // make this short SQLite lock acquisition wait on that thread.
        reader.busy_timeout(std::time::Duration::ZERO).map_err(sql)?;
        ledger::register_input_reader(&reader).map_err(sql)?;
        reader.execute_batch("BEGIN").map_err(sql)?;
        require_current_schema(&reader, PersistenceStage::Read).map_err(snapshot_error)?;
        let observed = read_metadata_from(&reader).map_err(snapshot_error)?;
        if observed.project_id().to_string() != project.to_string()
            || FileStamp::read(&path).as_ref() != Some(&initial)
        {
            return Err(failure(ErrorCode::DependencyConflict, "review-read-file"));
        }
        // The secondary snapshot is already pinned. Under DELETE journaling,
        // an external commit cannot slide between this snapshot and the stamp.
        let stamp = queries::read_snapshot(connection, |connection| {
            ledger::read_snapshot_stamp(connection)?
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-read-snapshot"))
        })?;
        let interrupt = Arc::clone(&cancellation);
        reader.progress_handler(1024, Some(move || interrupt.is_requested())).map_err(sql)?;
        Ok(Some(PreparedReviewEligibility {
            reader, stamp, project, cancellation, observation: self.changes_since(Revision::new(0)?),
        }))
    }

    pub fn finish_review_eligibility_read(
        &self, completed: CompletedReviewEligibility,
    ) -> Result<Eligibility, ExecutionError> {
        queries::check_read_cancel(&completed.cancellation)?;
        if self.is_reconciling() {
            return Err(failure(ErrorCode::OutcomeUnknown, "review-read"));
        }
        let connection = self.connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        let current = queries::read_snapshot(connection, ledger::read_snapshot_stamp)?;
        if current.as_ref() != Some(&completed.stamp) {
            return Err(failure(ErrorCode::DependencyConflict, "review-read-stale"));
        }
        Ok(completed.eligibility)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::persistence::review::tests::fixture;
    use std::time::{Duration, Instant};

    #[test]
    fn detached_eligibility_releases_its_snapshot_for_a_project_write() {
        let (_root, mut store, project, _) = fixture();
        let signal = Cancellation::default();
        let prepared = store.prepare_review_eligibility_read(project, &signal).unwrap().unwrap();
        assert_eq!(store.prepare_review_eligibility_read(project, &Cancellation::default())
            .err().unwrap().code, ErrorCode::Busy);
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !signal.is_requested() {
                assert!(Instant::now() < deadline, "project write did not interrupt its reader");
                std::thread::yield_now();
            }
            prepared.calculate(&["zh-CN".into()], &BTreeMap::new()).err().unwrap().code
        });
        let revision = store.metadata().unwrap().metadata_revision();
        store.rename(revision, "Renamed while qualification was in progress").unwrap();
        assert_eq!(worker.join().unwrap(), ErrorCode::Cancelled);
    }

    #[test]
    fn detached_eligibility_requires_the_same_database_version_and_session() {
        let (_root, store, project, _) = fixture();
        let locales = ["zh-CN".into()];
        let prepared = || store.prepare_review_eligibility_read(project, &Cancellation::default()).unwrap().unwrap();
        let expected = store.review_eligibility(project, &locales).unwrap();
        let completed = prepared().calculate(&locales, &BTreeMap::new()).unwrap();
        assert_eq!(store.finish_review_eligibility_read(completed).unwrap(), expected);

        let completed = prepared().calculate(&locales, &BTreeMap::new()).unwrap();
        let writer = Connection::open(store.directory().join("project.sqlite3")).unwrap();
        writer.execute("UPDATE project_metadata SET display_name='External sample edit'", []).unwrap();
        assert_eq!(store.finish_review_eligibility_read(completed).unwrap_err().code,
            ErrorCode::DependencyConflict);

        let prepared = prepared();
        store.close().unwrap();
        assert_eq!(prepared.calculate(&locales, &BTreeMap::new()).err().unwrap().code,
            ErrorCode::Cancelled);
    }
}
