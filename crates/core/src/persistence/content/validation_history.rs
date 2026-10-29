//! Exact source-check publication history beside the original current proof link.
use super::*;
use rusqlite::OptionalExtension;

pub(in crate::persistence) const TABLE: &str = "source_validation_history";
pub(in crate::persistence) const SQL: &str = "CREATE TABLE source_validation_history (
        checker_result_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_results(result_id),
        checker_attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
        producer_result_id TEXT NOT NULL REFERENCES execution_results(result_id),
        valid INTEGER NOT NULL CHECK(valid IN (0,1)))";

pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(SQL)
}

fn checked_record(
    c: &Connection,
    checker_attempt: ExecutionId,
    checker_result: ExecutionId,
    producer_result: ExecutionId,
    valid: bool,
) -> Result<PreparedSourceValidation, ExecutionError> {
    let producer_attempt: String = c.query_row(
        "SELECT attempt_id FROM execution_results WHERE result_id=?1",
        [producer_result.to_string()], |r| r.get(0),
    ).map_err(sql_error)?;
    let input = load_input(c, id(producer_attempt)?)?;
    if input.envelope().operation != OPERATION {
        return Err(corrupt());
    }
    let result = load_result(c, &input, producer_result)?;
    let check_input = load_input(c, checker_attempt)?;
    let check_result = load_result(c, &check_input, checker_result)?;
    let prepared = SourceValidationCapture::restore(ResultValidationCapture { input, result }, check_input)?
        .prepare(check_result)?;
    if prepared.proof.valid != valid {
        return Err(corrupt());
    }
    Ok(prepared)
}

/// Read a publication, not merely a generated checker result. The current link
/// may have been replaced; immutable frames still prove this exact publication.
pub(in crate::persistence) fn observe_in(
    c: &Connection,
    project: ExecutionId,
    checker_attempt: ExecutionId,
    checker_result: ExecutionId,
) -> Result<Option<bool>, ExecutionError> {
    if super::super::read_metadata_from(c).map_err(|_| corrupt())?.project_id().to_string() != project.to_string() {
        return Err(failure(ErrorCode::Unauthorized, "source-check-project"));
    }
    let input = load_input(c, checker_attempt)?;
    if input.envelope().project_id != project || input.envelope().operation != SOURCE_CHECK_OPERATION {
        return Err(failure(ErrorCode::ResultMismatch, "source-check-request"));
    }
    // Loading the exact frame rejects a result from another attempt even when
    // the publication has not happened yet.
    load_result(c, &input, checker_result)?;
    let saved: Option<(String, String, bool)> = c.query_row(
        "SELECT checker_attempt_id,producer_result_id,valid FROM source_validation_history WHERE checker_result_id=?1",
        [checker_result.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(sql_error)?;
    let Some((attempt, producer, valid)) = saved else { return Ok(None); };
    if attempt != checker_attempt.to_string() {
        return Err(failure(ErrorCode::ResultMismatch, "source-check-request"));
    }
    checked_record(c, checker_attempt, checker_result, id(producer)?, valid)?;
    Ok(Some(valid))
}

pub(in crate::persistence) fn record_in(
    c: &Connection,
    producer_result: ExecutionId,
    checker_attempt: ExecutionId,
    checker_result: ExecutionId,
    valid: bool,
) -> Result<(), ExecutionError> {
    let existing: Option<(String, String, bool)> = c.query_row(
        "SELECT checker_attempt_id,producer_result_id,valid FROM source_validation_history WHERE checker_result_id=?1",
        [checker_result.to_string()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).optional().map_err(sql_error)?;
    if let Some(existing) = existing {
        if existing != (checker_attempt.to_string(), producer_result.to_string(), valid) {
            return Err(failure(ErrorCode::ResultMismatch, "source-check-publication"));
        }
        return Ok(());
    }
    c.execute("INSERT INTO source_validation_history VALUES (?1,?2,?3,?4)",
        params![checker_result.to_string(), checker_attempt.to_string(), producer_result.to_string(), valid])
        .map_err(sql_error)?;
    Ok(())
}

/// An older schema can prove only the currently published link. Generated but
/// unlinked results and previously overwritten links are never invented here.
pub(in crate::persistence) fn migrate(c: &Connection) -> Result<(), ExecutionError> {
    initialize(c).map_err(sql_error)?;
    let mut statement = c.prepare(
        "SELECT l.producer_result_id,l.checker_result_id,r.attempt_id,l.valid
         FROM plugin_validation_links l
         JOIN execution_results producer ON producer.result_id=l.producer_result_id
         JOIN execution_attempts a ON a.attempt_id=producer.attempt_id
         JOIN execution_tasks t ON t.task_id=a.task_id
         JOIN execution_results r ON r.result_id=l.checker_result_id
         WHERE t.operation=?1",
    ).map_err(sql_error)?;
    let rows = statement.query_map([OPERATION], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?))
    }).map_err(sql_error)?.collect::<Result<Vec<_>, _>>().map_err(sql_error)?;
    for (producer, checker, attempt, valid) in rows {
        let (producer, checker, attempt) = (id(producer)?, id(checker)?, id(attempt)?);
        checked_record(c, attempt, checker, producer, valid)?;
        record_in(c, producer, attempt, checker, valid)?;
    }
    Ok(())
}

pub(in crate::persistence) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let sql: String = c.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1", [TABLE], |r| r.get(0))
        .map_err(sql_error)?;
    if sql != SQL { return Err(corrupt()); }
    let mut statement = c.prepare("SELECT checker_attempt_id,checker_result_id,producer_result_id,valid FROM source_validation_history")
        .map_err(sql_error)?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?,r.get::<_, bool>(3)?)))
        .map_err(sql_error)?;
    for row in rows {
        let (attempt, checker, producer, valid) = row.map_err(sql_error)?;
        checked_record(c, id(attempt)?, id(checker)?, id(producer)?, valid)?;
    }
    let missing: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM plugin_validation_links l
         JOIN execution_results r ON r.result_id=l.producer_result_id
         JOIN execution_attempts a ON a.attempt_id=r.attempt_id
         JOIN execution_tasks t ON t.task_id=a.task_id
         WHERE t.operation=?1 AND NOT EXISTS(SELECT 1 FROM source_validation_history h
             WHERE h.producer_result_id=l.producer_result_id AND h.checker_result_id=l.checker_result_id AND h.valid=l.valid))",
        [OPERATION], |r| r.get(0),
    ).map_err(sql_error)?;
    if missing { return Err(corrupt()); }
    Ok(())
}

impl ProjectStore {
    pub fn source_check_finish_request_observation(
        &self,
        project: ExecutionId,
        checker_attempt: ExecutionId,
        checker_result: ExecutionId,
    ) -> Result<Option<bool>, ExecutionError> {
        super::super::review::read_snapshot(self.connection().map_err(|_| failure(ErrorCode::StorageFailed, "source-check-read"))?, |c| {
            observe_in(c, project, checker_attempt, checker_result)
        })
    }
}

#[cfg(test)]
mod tests;
