//! Explicit publication of already persisted Source checker evidence.
use super::*;
use rusqlite::OptionalExtension;

fn head_in(c: &Connection, producer: ExecutionId) -> Result<Option<(ExecutionId, bool)>, ExecutionError> {
    let row: Option<(String, bool)> = c.query_row(
        "SELECT checker_result_id,valid FROM plugin_validation_links WHERE producer_result_id=?1",
        [producer.to_string()], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(sql_error)?;
    row.map(|(result, valid)| Ok((id(result)?, valid))).transpose()
}

fn check_admission_in(
    c: &Connection,
    producer_input: &FixedInput,
    producer_result: &FixedResult,
    check_input: &FixedInput,
    check_result: &FixedResult,
    head: Option<(ExecutionId, bool)>,
) -> Result<(), ExecutionError> {
    if producer_input.envelope().operation != OPERATION || check_input.envelope().operation != SOURCE_CHECK_OPERATION
        || producer_input.envelope().project_id != check_input.envelope().project_id {
        return Err(failure(ErrorCode::ResultMismatch, "source-publication-association"));
    }
    for (input, result, producer) in [(producer_input, producer_result, true), (check_input, check_result, false)] {
        super::super::plugin_execution::check_source_publication_provenance_in(c, input, result)?;
        let (task, sequence, captured_cancel, execution, current, adoption, validation):
            (String, i64, i64, String, Option<String>, String, String) = c.query_row(
            "SELECT a.task_id,a.sequence,a.cancellation_revision,i.execution,i.current_result_id,i.adoption,i.validation
             FROM execution_attempts a JOIN execution_items i ON i.attempt_id=a.attempt_id
             WHERE a.attempt_id=?1 AND i.item_id=?2",
            params![input.envelope().attempt_id.to_string(), result.envelope().item_id.to_string()],
            |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)),
        ).map_err(sql_error)?;
        if task != input.envelope().task_id.to_string() { return Err(corrupt()); }
        if captured_cancel < 0 || super::super::ledger::cancel_revision(c, input.envelope().task_id)?.get() != captured_cancel as u64 {
            return Err(failure(ErrorCode::CorruptLedger, "source-publication-cancellation-basis"));
        }
        let newer: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_attempts WHERE task_id=?1 AND sequence>?2)",
            params![task, sequence], |r| r.get(0),
        ).map_err(sql_error)?;
        if newer { return Err(failure(ErrorCode::DependencyConflict, "source-publication-newer-attempt")); }
        if current.as_deref() != Some(result.envelope().result_id.to_string().as_str())
            || producer && execution != "succeeded" || !producer && !["succeeded", "failed"].contains(&execution.as_str()) {
            return Err(failure(ErrorCode::DependencyConflict, "source-publication-current-result"));
        }
        if producer {
            if head.is_none() && adoption == "committed" {
                return Err(failure(ErrorCode::DependencyConflict, "source-publication-adopted"));
            }
            if let Some((_, valid)) = head {
                if validation != if valid { "valid" } else { "invalid" } { return Err(corrupt()); }
            }
        }
    }
    if let Some((checker, valid)) = head {
        if checker == check_result.envelope().result_id {
            // A current link without its schema69 history is corruption, not
            // permission to reconstruct a missing publication by assumption.
            return Err(corrupt());
        }
        super::super::ledger::validate_source_link(c, producer_input, producer_result, valid)?;
    }
    Ok(())
}

impl ProjectStore {
    /// Capture only original persisted frames. No runtime, permission renewal,
    /// plugin lookup, file capture, or worker execution belongs to this path.
    pub fn capture_source_validation_publication(
        &self,
        project: ExecutionId,
        checker_attempt: ExecutionId,
        checker_result: ExecutionId,
    ) -> Result<SourceValidationPublicationCapture, ExecutionError> {
        let c = self.connection().map_err(|_| failure(ErrorCode::StorageFailed, "source-publication-read"))?;
        super::super::review::read_snapshot(c, |c| {
            if super::super::read_metadata_from(c).map_err(|_| corrupt())?.project_id().to_string() != project.to_string() {
                return Err(failure(ErrorCode::Unauthorized, "source-publication-project"));
            }
            let check_input = load_input(c, checker_attempt)?;
            if check_input.envelope().operation != SOURCE_CHECK_OPERATION || check_input.envelope().project_id != project {
                return Err(failure(ErrorCode::ResultMismatch, "source-publication-checker"));
            }
            let check_result = load_result(c, &check_input, checker_result)?;
            let basis: SourceValidationBasis = serde_json::from_value(check_input.envelope().settings.clone())
                .map_err(|_| failure(ErrorCode::ResultMismatch, "source-publication-basis"))?;
            let input = load_input(c, basis.source_attempt_id)?;
            let result = load_result(c, &input, basis.source_result_id)?;
            if input.envelope().project_id != project || input.digest() != basis.source_input_digest
                || result.digest() != basis.source_result_digest {
                return Err(failure(ErrorCode::ResultMismatch, "source-publication-basis"));
            }
            let capture = SourceValidationCapture::restore(ResultValidationCapture { input, result }, check_input)?;
            let head = head_in(c, basis.source_result_id)?;
            if validation_history::observe_in(c, project, checker_attempt, checker_result)?.is_none() {
                check_admission_in(c, &capture.source.input, &capture.source.result, &capture.check_input, &check_result, head)?;
            }
            Ok(SourceValidationPublicationCapture { capture, check_result, scope: scope(c)?,
                epoch: self.changes_since(Revision::new(0)?).epoch, publication_head: head })
        })
    }

    /// The caller explicitly records this checker result. A different current
    /// proof is retained; recording history must not regress current validity.
    pub fn commit_source_validation_publication(
        &mut self,
        prepared: PreparedSourceValidationPublication,
    ) -> Result<(), ExecutionError> {
        let validation = &prepared.validation;
        let project = validation.capture.source.input.envelope().project_id;
        let checker_attempt = validation.capture.check_input.envelope().attempt_id;
        let checker_result = validation.check_result.envelope().result_id;
        if let Some(valid) = self.source_check_finish_request_observation(project, checker_attempt, checker_result)? {
            if valid != validation.proof.valid { return Err(failure(ErrorCode::ResultMismatch, "source-check-publication")); }
            return Ok(());
        }
        if self.is_reconciling() { self.reconcile_execution()?; }
        let epoch = self.changes_since(Revision::new(0)?).epoch;
        let tx = self.execution_write()?;
        let (producer_input, producer_result, check_input, check_result) = Self::semantic_publication_frames_in(&tx,
            &validation.capture.source, &validation.capture.check_input, &validation.check_result, &validation.proof)?;
        if let Some(valid) = validation_history::observe_in(&tx, project, checker_attempt, checker_result)? {
            if valid != validation.proof.valid { return Err(failure(ErrorCode::ResultMismatch, "source-check-publication")); }
            return Ok(());
        }
        if epoch != prepared.epoch || scope(&tx)? != prepared.scope {
            return Err(failure(ErrorCode::DependencyConflict, "source-publication-scope"));
        }
        let head = head_in(&tx, producer_result.envelope().result_id)?;
        if head != prepared.publication_head {
            return Err(failure(ErrorCode::DependencyConflict, "source-publication-head-changed"));
        }
        check_admission_in(&tx, &producer_input, &producer_result, &check_input, &check_result, head)?;
        if head.is_some() {
            validation_history::record_in(&tx, producer_result.envelope().result_id, checker_attempt,
                checker_result, validation.proof.valid)?;
        } else {
            Self::publish_semantic_frames_in(&tx, &producer_input, &producer_result, &check_input, &check_result, &validation.proof)?;
        }
        super::super::ledger::commit(tx)
    }
}

#[cfg(test)]
mod tests;
