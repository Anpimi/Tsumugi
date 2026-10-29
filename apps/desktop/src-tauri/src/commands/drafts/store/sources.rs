//! Source heads use the original journal transactions, quotas and CAS rules.
use super::*;

pub(super) const MAX_RECORD: usize = 8 * 1024 * 1024 + MAX_DRAFT_RECORD_BYTES;
pub(super) const HEAD_SQL: &str = "CREATE TABLE source_draft_heads (project_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=8650752), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))";
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

fn empty(key: &SourceDraftKey) -> SourceDraftHead {
    SourceDraftHead { key: key.clone(), revision: Revision::new(0).expect("zero revision"), writer_id: None, value: None }
}
pub(super) fn has_pending(value: &SourceDraftValue) -> bool { value.pending.is_some() || value.hook_stop.is_some() }
fn sequence(value: Revision, head: Revision) -> Result<()> {
    if value.get() > MAX_SAFE_SEQUENCE || value > head {
        return Err(fail(ErrorCode::InvalidInput, "source-drafts-sequence"));
    }
    Ok(())
}
pub(super) fn validate_value(key: &SourceDraftKey, value: &SourceDraftValue) -> Result<()> {
    sequence(value.edit_seq, value.edit_seq)?;
    sequence(value.mapping_seq, value.edit_seq)?;
    if value.lineage.windows(2).any(|pair| pair[0].new_ordinal >= pair[1].new_ordinal) {
        return Err(fail(ErrorCode::InvalidInput, "source-drafts-lineage"));
    }
    if value.capture_request.as_ref().is_some_and(|r| r.project_id != key.project_id)
        || value.check_prepare_request.as_ref().is_some_and(|r| r.project_id != key.project_id) {
        return Err(fail(ErrorCode::InvalidInput, "source-drafts-project"));
    }
    if let Some(pending) = &value.pending {
        sequence(pending.submitted_seq(), value.edit_seq)?;
        sequence(pending.submitted_mapping_seq(), value.mapping_seq)?;
        if pending.project_id() != key.project_id {
            return Err(fail(ErrorCode::InvalidInput, "source-drafts-project"));
        }
        if let SourceDraftPending::CorrectLineage { request, .. } = pending {
            if request.correction.project_id != key.project_id || request.correction.basis.project_id != key.project_id {
                return Err(fail(ErrorCode::InvalidInput, "source-drafts-project"));
            }
        }
    }
    if let Some(pending) = &value.hook_stop {
        sequence(pending.submitted_seq, value.edit_seq)?;
        if pending.request.project_id != key.project_id || pending.request.stop.project_id != key.project_id {
            return Err(fail(ErrorCode::InvalidInput, "source-drafts-project"));
        }
    }
    Ok(())
}
pub(super) fn decode(key: &SourceDraftKey, stored: (i64, Option<i64>, i64, Option<Vec<u8>>)) -> Result<SourceDraftHead> {
    let (revision, seq, pending, payload) = stored;
    let bytes = payload.ok_or_else(|| fail(ErrorCode::CorruptLedger, "source-drafts-record"))?;
    let head: SourceDraftHead = serde_json::from_slice(&bytes).map_err(|_| fail(ErrorCode::CorruptLedger, "source-drafts-record"))?;
    let value = head.value.as_ref();
    if head.key != *key || revision <= 0 || head.revision != stored_revision(revision)?
        || head.writer_id.is_some() != value.is_some() || seq != value.map(|v| v.edit_seq.get() as i64)
        || pending != i64::from(value.is_some_and(has_pending))
        || value.is_some_and(|v| validate_value(key, v).is_err())
        || encode_bounded(&head, MAX_RECORD).map_err(|_| fail(ErrorCode::CorruptLedger, "source-drafts-record"))? != bytes {
        return Err(fail(ErrorCode::CorruptLedger, "source-drafts-record"));
    }
    Ok(head)
}
fn read(connection: &Connection, key: &SourceDraftKey, format: i64) -> Result<SourceDraftHead> {
    if format < SOURCE_FORMAT { return Ok(empty(key)); }
    let row = connection.query_row("SELECT revision,edit_seq,has_pending,CASE WHEN length(payload)<=?2 THEN payload END FROM source_draft_heads WHERE project_id=?1",
        params![key.project_id.to_string(), MAX_RECORD as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .optional().map_err(sql)?;
    let head = row.map(|row| decode(key, row)).transpose()?.unwrap_or_else(|| empty(key));
    if format < FORMAT && head.value.as_ref().is_some_and(|value| value.correction.is_some()
        || matches!(value.pending, Some(SourceDraftPending::CorrectLineage { .. }))) {
        return Err(fail(ErrorCode::CorruptLedger, "source-drafts-format"));
    }
    Ok(head)
}
pub(super) fn validate_existing(connection: &Connection, format: i64) -> Result<()> {
    let mut statement = connection.prepare("SELECT project_id FROM source_draft_heads ORDER BY project_id").map_err(sql)?;
    let projects = statement.query_map([], |row| row.get::<_, String>(0)).map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>().map_err(sql)?;
    for project in projects { read(connection, &SourceDraftKey { project_id: stored_id(&project)? }, format)?; }
    Ok(())
}
fn persist(connection: &Connection, head: &SourceDraftHead, bytes: &[u8]) -> Result<()> {
    connection.execute("INSERT INTO source_draft_heads VALUES(?1,?2,?3,?4,?5) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,edit_seq=excluded.edit_seq,has_pending=excluded.has_pending,payload=excluded.payload",
        params![head.key.project_id.to_string(), head.revision.get() as i64, head.value.as_ref().map(|v| v.edit_seq.get() as i64), i64::from(head.value.as_ref().is_some_and(has_pending)), bytes]).map_err(sql)?;
    Ok(())
}
fn keep_newer_input(old: &SourceDraftValue, new: &SourceDraftValue, target: &SourceDraftResolveTarget) -> Result<()> {
    let newer = match target {
        SourceDraftResolveTarget::Primary { pending } => old.mapping_seq > pending.submitted_mapping_seq(),
        SourceDraftResolveTarget::HookStop { pending } => old.edit_seq > pending.submitted_seq,
    };
    if newer && (old.mapping_seq != new.mapping_seq || old.domain != new.domain || old.source != new.source
        || old.source_language != new.source_language || old.declared != new.declared || old.selection_label != new.selection_label
        || old.lineage != new.lineage || old.actor != new.actor || old.filter != new.filter || old.applied_filter != new.applied_filter
        || old.manual_ordinal != new.manual_ordinal || old.historical_query != new.historical_query
        || old.hook.locale != new.hook.locale || old.hook.enabled_intent != new.hook.enabled_intent || old.correction != new.correction) {
        return Err(fail(ErrorCode::DependencyConflict, "source-drafts-newer-input"));
    }
    Ok(())
}
fn apply(before: &SourceDraftHead, request: &SourceDraftWrite, target: Option<&SourceDraftResolveTarget>) -> Result<SourceDraftHead> {
    if request.expected_revision <= before.revision && before.writer_id == Some(request.writer_id)
        && before.value.as_ref() == Some(&request.value) { return Ok(before.clone()); }
    if request.expected_revision != before.revision { return Err(fail(ErrorCode::DependencyConflict, "drafts-revision")); }
    if before.value.as_ref().is_some_and(|v| request.value.edit_seq <= v.edit_seq || request.value.mapping_seq < v.mapping_seq) {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-edit-sequence"));
    }
    if let Some(old) = &before.value {
        let primary = matches!(target, Some(SourceDraftResolveTarget::Primary { pending }) if old.pending.as_ref() == Some(pending) && request.value.pending.is_none());
        let hook = matches!(target, Some(SourceDraftResolveTarget::HookStop { pending }) if old.hook_stop.as_ref() == Some(pending) && request.value.hook_stop.is_none());
        if target.is_some() && !primary && !hook || !primary && old.pending.is_some() && old.pending != request.value.pending
            || !hook && old.hook_stop.is_some() && old.hook_stop != request.value.hook_stop {
            return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
        }
        if let Some(target) = target { keep_newer_input(old, &request.value, target)?; }
    } else if target.is_some() { return Err(fail(ErrorCode::DependencyConflict, "drafts-pending")); }
    Ok(SourceDraftHead { key: request.key.clone(), revision: next_revision(before.revision)?, writer_id: Some(request.writer_id), value: Some(request.value.clone()) })
}
fn mutate_existing(connection: &mut Connection, key: &SourceDraftKey, apply: &impl Fn(&SourceDraftHead) -> Result<SourceDraftHead>, limits: Limits) -> Result<SourceDraftHead> {
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql)?;
    let format = verify_schema(&tx)?;
    let before = read(&tx, key, format)?;
    let after = apply(&before)?;
    if before == after {
        if format < FORMAT { upgrade_schema(&tx, format)?; tx.commit().map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?; }
        return Ok(before);
    }
    let bytes = encode_bounded(&after, MAX_RECORD)?;
    let (total_bytes, total_rows, project_bytes, project_rows) = journal_usage(&tx, format, key.project_id)?;
    let old = if before.revision.get() == 0 { 0 } else { encode_bounded(&before, MAX_RECORD)?.len() };
    check_quota(project_bytes as usize, total_bytes as usize, project_rows as usize, total_rows as usize, old, bytes.len(), before.revision.get() == 0, limits)?;
    upgrade_schema(&tx, format)?;
    persist(&tx, &after, &bytes)?;
    test_hook("source-write-before-commit", Some(&tx));
    tx.commit().map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
    test_hook("source-write-after-commit", None);
    Ok(after)
}
impl DraftStore {
    fn mutate_source(&self, key: &SourceDraftKey, apply: impl Fn(&SourceDraftHead) -> Result<SourceDraftHead>) -> Result<SourceDraftHead> {
        if let Some(mut connection) = self.existing(true)? { return mutate_existing(&mut connection, key, &apply, self.limits); }
        let after = apply(&empty(key))?;
        if after.revision.get() == 0 { return Ok(after); }
        let bytes = encode_bounded(&after, MAX_RECORD)?;
        check_quota(0, 0, 0, 0, 0, bytes.len(), true, self.limits)?;
        self.initialize_or_retry(|tx| { persist(tx, &after, &bytes)?; Ok(after.clone()) }, |connection| mutate_existing(connection, key, &apply, self.limits))
    }
    pub fn read_source(&self, key: &SourceDraftKey) -> Result<SourceDraftHead> {
        let Some(mut connection) = self.existing(false)? else { return Ok(empty(key)); };
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred).map_err(sql)?;
        read(&tx, key, verify_schema(&tx)?)
    }
    pub fn write_source(&self, request: &SourceDraftWrite) -> Result<SourceDraftHead> {
        validate_value(&request.key, &request.value)?;
        self.mutate_source(&request.key, |before| apply(before, request, None))
    }
    pub fn resolve_source(&self, request: &SourceDraftResolve) -> Result<SourceDraftHead> {
        validate_value(&request.write.key, &request.write.value)?;
        self.mutate_source(&request.write.key, |before| apply(before, &request.write, Some(&request.target)))
    }
    pub fn check_source_resolution(&self, request: &SourceDraftResolve) -> Result<()> {
        validate_value(&request.write.key, &request.write.value)?;
        apply(&self.read_source(&request.write.key)?, &request.write, Some(&request.target)).map(|_| ())
    }
    pub fn clear_source(&self, request: &SourceDraftClear) -> Result<SourceDraftHead> {
        self.mutate_source(&request.key, |before| {
            if before.revision != request.expected_revision { return Err(fail(ErrorCode::DependencyConflict, "drafts-revision")); }
            if before.value.as_ref().is_some_and(has_pending) { return Err(fail(ErrorCode::DependencyConflict, "drafts-pending")); }
            if before.value.is_none() && before.revision.get() > 0 { return Ok(before.clone()); }
            Ok(SourceDraftHead { key: request.key.clone(), revision: next_revision(before.revision)?, writer_id: None, value: None })
        })
    }
}

#[cfg(test)]
mod tests;
