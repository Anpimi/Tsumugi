use super::*;

/// A pending extraction has operation-local endpoints, not adopted unit or
/// occurrence identities. Keep its entire comparison under the original result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::persistence) struct PendingSourceMapping {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
    pub scope: ContentScope,
    pub mapping_revision: Revision,
    pub previous_snapshot_id: ExecutionId,
    pub result_digest: String,
    pub changed_count: u32,
    pub ambiguous_count: u32,
    pub rename_candidate_count: u32,
    pub cancellation_revision: Revision,
    pub cancellation_requested: bool,
    /// Observation of the producer's and checker's original live plugin
    /// authorization. This neither grants authority nor replaces the full
    /// adoption guard.
    pub authorization_current: bool,
}

/// Read within the caller's existing SQLite snapshot. The limit bounds scanned
/// eligible results, including results which contain no uncertain mappings.
/// Cancellation revokes old actions, while a saved valid result remains evidence
/// for an explicitly reauthorized adoption. A later attempt permanently replaces
/// the original item, as in the execution owner's adoption/recovery guards.
pub(in crate::persistence) fn pending_in(
    store: &ProjectStore,
    connection: &Connection,
    project: ExecutionId,
    scan_limit: usize,
) -> Result<(Vec<PendingSourceMapping>, bool), ExecutionError> {
    if super::super::read_metadata_from(connection)
        .map_err(|_| corrupt())?
        .project_id()
        .to_string()
        != project.to_string()
    {
        return Err(failure(ErrorCode::Unauthorized, "source-mapping-project"));
    }
    let scope = scope(connection)?;
    let Some(previous_snapshot_id) = scope.current_snapshot else {
        // First imports have no predecessor correspondence to decide.
        return Ok((Vec::new(), true));
    };
    let (_, (old_input, _, old_output, mut old_rows)) =
        snapshot_rows(connection, previous_snapshot_id, true)?;
    lineage_corrections::effective_rows(connection,&mut old_rows)?;
    let query_limit = scan_limit.checked_add(1)
        .and_then(|limit| i64::try_from(limit).ok())
        .ok_or_else(|| failure(ErrorCode::LimitExceeded, "source-mapping-limit"))?;
    let mut statement = connection.prepare(
        "SELECT a.attempt_id,a.task_id,i.item_id,i.current_result_id,a.cancellation_revision
         FROM execution_attempts a JOIN execution_tasks t ON t.task_id=a.task_id
         JOIN execution_items i ON i.attempt_id=a.attempt_id
         WHERE a.project_id=?1 AND t.project_id=?1 AND t.operation=?2
         AND i.execution='succeeded' AND i.validation='valid'
         AND i.adoption IN ('unapplied','conflict')
         AND NOT EXISTS(SELECT 1 FROM adoption_receipts r WHERE r.attempt_id=a.attempt_id)
         AND NOT EXISTS(SELECT 1 FROM execution_items next_item
             JOIN execution_attempts next_attempt ON next_attempt.attempt_id=next_item.attempt_id
             WHERE next_attempt.task_id=a.task_id AND next_item.item_id=i.item_id
             AND next_attempt.sequence>a.sequence)
         ORDER BY a.attempt_id,i.item_id,i.current_result_id LIMIT ?3",
    ).map_err(sql_error)?;
    let candidates = statement.query_map(
        params![project.to_string(), crate::content::OPERATION, query_limit],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
            row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?)),
    ).map_err(sql_error)?.collect::<Result<Vec<_>, _>>().map_err(sql_error)?;
    let complete = candidates.len() <= scan_limit;
    let mut groups = Vec::new();
    for (attempt, task, item, result, captured_cancel) in candidates.into_iter().take(scan_limit) {
        let attempt_id = id(attempt)?;
        let task_id = id(task)?;
        let item_id = id(item)?;
        let result_id = id(result)?;
        let (input, result, output) = load_qualified_source(connection, attempt_id, result_id)?;
        if input.envelope().project_id != project
            || input.envelope().task_id != task_id
            || input.envelope().operation != crate::content::OPERATION
            || input.envelope().items.len() != 1
            || input.envelope().items[0].item_id != item_id
            || result.envelope().item_id != item_id
        {
            return Err(corrupt());
        }
        let bundle = SourceBundle::from_input(&input)?;
        if read_bundle(connection, bundle.set_id)? != bundle.source_input() {
            return Err(corrupt());
        }
        let cancellation_revision = super::super::ledger::cancel_revision(connection, task_id)?;
        let captured_cancel = u64::try_from(captured_cancel).map_err(|_| corrupt())?;
        if captured_cancel > cancellation_revision.get() {
            return Err(corrupt());
        }
        // Another valid format/domain can be stored in the execution ledger.
        // It has no comparison against this current source, rather than being
        // corrupt or an unresolved relationship in the current domain.
        if old_input.envelope().project_id != input.envelope().project_id
            || old_output.namespace != output.namespace
            || old_output.source_language != output.source_language
            || old_output.identity_policy != output.identity_policy
        {
            continue;
        }
        let changes = compare_rows(&old_rows, &output.occurrences);
        let counts = SourceChangeCounts::from_changes(&changes);
        if counts.mapping_review_required() == 0 {
            continue;
        }
        let authorization_current = if input.envelope().plugin.is_some() {
            let prepared = super::super::ledger::validate_source_link(connection, &input, &result, true)?;
            // Check both original grants even when the first is no longer live.
            // Historical proof stays readable; no check creates or renews a grant.
            let producer_current = input_authorization_current(store, connection, &input)?;
            let checker_current = input_authorization_current(
                store, connection, &prepared.capture.check_input,
            )?;
            producer_current && checker_current
        } else {
            true
        };
        groups.push(PendingSourceMapping {
            task_id, attempt_id, item_id, result_id, scope: scope.clone(), mapping_revision:lineage_corrections::mapping_revision(connection,previous_snapshot_id)?, previous_snapshot_id,
            result_digest: result.digest().into(), changed_count: counts.changed,
            ambiguous_count: counts.ambiguous, rename_candidate_count: counts.rename_candidate,
            cancellation_revision, cancellation_requested: cancellation_revision.get() > captured_cancel,
            authorization_current,
        });
    }
    Ok((groups, complete))
}

fn input_authorization_current(
    store: &ProjectStore,
    connection: &Connection,
    input: &FixedInput,
) -> Result<bool, ExecutionError> {
    match super::super::plugin_execution::check_input_in(
        connection, input, &store.plugin_authority,
    ) {
        Ok(_) => Ok(true),
        Err(error) if matches!(error.code,
            ErrorCode::Unauthorized | ErrorCode::DependencyConflict | ErrorCode::Cancelled) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
pub(in crate::persistence) mod tests;
