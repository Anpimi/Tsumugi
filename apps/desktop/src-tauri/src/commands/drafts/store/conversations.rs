//! Conversation input uses the same journal file, transaction and shared quotas.
use super::*;
use tsumugi_core::application::{MAX_CONVERSATION_MESSAGE_BYTES, MAX_CONVERSATION_TITLE_BYTES};

pub(super) const HEAD_SQL: &str = "CREATE TABLE conversation_draft_heads (project_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=262144), PRIMARY KEY(project_id,conversation_id), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))";

fn empty(key: &ConversationDraftKey) -> ConversationDraftHead {
    ConversationDraftHead {
        key: key.clone(),
        revision: Revision::new(0).expect("zero revision"),
        writer_id: None,
        value: None,
    }
}
fn validate_pending(
    key: &ConversationDraftKey,
    pending: &ConversationDraftPending,
    seq: Revision,
    text: &str,
) -> Result<()> {
    let (project, thread, submitted) = match pending {
        ConversationDraftPending::Create {
            request,
            submitted_seq,
        } => {
            if request.title.as_ref().is_some_and(|title| {
                title.trim().is_empty() || title.len() > MAX_CONVERSATION_TITLE_BYTES
            }) {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-title"));
            }
            (request.project_id, request.conversation_id, *submitted_seq)
        }
        ConversationDraftPending::Append {
            request,
            submitted_seq,
        } => {
            if request.body.trim().is_empty()
                || request.body.len() > MAX_CONVERSATION_MESSAGE_BYTES
                || *submitted_seq == seq && request.body != text
            {
                return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-message"));
            }
            (request.project_id, request.conversation_id, *submitted_seq)
        }
    };
    if project != key.project_id || thread != key.conversation_id || submitted > seq {
        return Err(fail(ErrorCode::InvalidInput, "conversation-drafts-pending"));
    }
    Ok(())
}
fn validate_value(key: &ConversationDraftKey, value: &ConversationDraftValue) -> Result<()> {
    if let Some(pending) = &value.pending {
        validate_pending(key, pending, value.edit_seq, &value.text)?;
    }
    Ok(())
}
fn same_write(before: &ConversationDraftHead, r: &ConversationDraftWrite) -> bool {
    r.expected_revision <= before.revision
        && before.writer_id == Some(r.writer_id)
        && before.value.as_ref() == Some(&r.value)
}
fn apply_write(
    before: &ConversationDraftHead,
    r: &ConversationDraftWrite,
    resolve: Option<&ConversationDraftPending>,
) -> Result<ConversationDraftHead> {
    if same_write(before, r) {
        return Ok(before.clone());
    }
    if before.revision != r.expected_revision {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-revision"));
    }
    if before
        .value
        .as_ref()
        .is_some_and(|old| r.value.edit_seq <= old.edit_seq)
    {
        return Err(fail(ErrorCode::DependencyConflict, "drafts-edit-sequence"));
    }
    match resolve {
        Some(pending)
            if r.value.pending.is_none()
                && before
                    .value
                    .as_ref()
                    .and_then(|value| value.pending.as_ref())
                    == Some(pending) =>
        {
            ()
        }
        Some(_) => return Err(fail(ErrorCode::DependencyConflict, "drafts-pending")),
        None if before
            .value
            .as_ref()
            .and_then(|value| value.pending.as_ref())
            .is_some_and(|pending| r.value.pending.as_ref() != Some(pending)) =>
        {
            return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
        }
        None => (),
    }
    Ok(ConversationDraftHead {
        key: r.key.clone(),
        revision: next_revision(before.revision)?,
        writer_id: Some(r.writer_id),
        value: Some(r.value.clone()),
    })
}

type Stored = (i64, Option<i64>, i64, Option<Vec<u8>>);
fn stored(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Stored> {
    Ok((
        row.get(offset)?,
        row.get(offset + 1)?,
        row.get(offset + 2)?,
        row.get(offset + 3)?,
    ))
}
fn decode(key: &ConversationDraftKey, row: Stored) -> Result<ConversationDraftHead> {
    let (revision, seq, pending, payload) = row;
    let payload =
        payload.ok_or_else(|| fail(ErrorCode::CorruptLedger, "conversation-drafts-record"))?;
    let head: ConversationDraftHead = serde_json::from_slice(&payload)
        .map_err(|_| fail(ErrorCode::CorruptLedger, "conversation-drafts-record"))?;
    let value = head.value.as_ref();
    if head.key != *key
        || revision <= 0
        || head.revision != stored_revision(revision)?
        || head.writer_id.is_some() != value.is_some()
        || seq != value.map(|value| value.edit_seq.get() as i64)
        || pending != i64::from(value.is_some_and(|value| value.pending.is_some()))
        || value.is_some_and(|value| validate_value(key, value).is_err())
        || encode(&head)
            .map_err(|_| fail(ErrorCode::CorruptLedger, "conversation-drafts-record"))?
            != payload
    {
        return Err(fail(ErrorCode::CorruptLedger, "conversation-drafts-record"));
    }
    Ok(head)
}
fn read_head(
    c: &Connection,
    key: &ConversationDraftKey,
    format: i64,
) -> Result<ConversationDraftHead> {
    if format < FORMAT {
        return Ok(empty(key));
    }
    let row=c.query_row("SELECT revision,edit_seq,has_pending,CASE WHEN length(payload)<=?3 THEN payload END FROM conversation_draft_heads WHERE project_id=?1 AND conversation_id=?2",params![key.project_id.to_string(),key.conversation_id.to_string(),MAX_DRAFT_RECORD_BYTES as i64],|row|stored(row,0)).optional().map_err(sql)?;
    match row {
        Some(row) => decode(key, row),
        None => Ok(empty(key)),
    }
}
fn persist(c: &Connection, head: &ConversationDraftHead, payload: &[u8]) -> Result<()> {
    c.execute("INSERT INTO conversation_draft_heads VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(project_id,conversation_id) DO UPDATE SET revision=excluded.revision,edit_seq=excluded.edit_seq,has_pending=excluded.has_pending,payload=excluded.payload",params![head.key.project_id.to_string(),head.key.conversation_id.to_string(),head.revision.get() as i64,head.value.as_ref().map(|value|value.edit_seq.get() as i64),i64::from(head.value.as_ref().is_some_and(|value|value.pending.is_some())),payload]).map_err(sql)?;
    Ok(())
}
fn mutate_existing(
    c: &mut Connection,
    key: &ConversationDraftKey,
    apply: &impl Fn(&ConversationDraftHead) -> Result<ConversationDraftHead>,
    limits: Limits,
) -> Result<ConversationDraftHead> {
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sql)?;
    let format = verify_schema(&tx)?;
    let before = read_head(&tx, key, format)?;
    let after = apply(&before)?;
    if before == after {
        if format < FORMAT {
            upgrade_schema(&tx, format)?;
            tx.commit()
                .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
        }
        return Ok(before);
    }
    let payload = encode(&after)?;
    let (bytes, records, project_bytes, project_records) =
        journal_usage(&tx, format, key.project_id)?;
    let old = if before.revision.get() == 0 {
        0
    } else {
        encode(&before)?.len()
    };
    check_quota(
        project_bytes as usize,
        bytes as usize,
        project_records as usize,
        records as usize,
        old,
        payload.len(),
        before.revision.get() == 0,
        limits,
    )?;
    upgrade_schema(&tx, format)?;
    persist(&tx, &after, &payload)?;
    test_hook("write-before-commit", Some(&tx));
    tx.commit()
        .map_err(|_| fail(ErrorCode::OutcomeUnknown, "drafts-commit"))?;
    test_hook("write-after-commit", None);
    Ok(after)
}
impl DraftStore {
    fn mutate_conversation(
        &self,
        key: &ConversationDraftKey,
        apply: impl Fn(&ConversationDraftHead) -> Result<ConversationDraftHead>,
    ) -> Result<ConversationDraftHead> {
        if let Some(mut c) = self.existing(true)? {
            return mutate_existing(&mut c, key, &apply, self.limits);
        }
        let after = apply(&empty(key))?;
        let payload = encode(&after)?;
        check_quota(0, 0, 0, 0, 0, payload.len(), true, self.limits)?;
        self.initialize_or_retry(
            |c| {
                persist(c, &after, &payload)?;
                Ok(after.clone())
            },
            |c| mutate_existing(c, key, &apply, self.limits),
        )
    }
    pub fn read_conversation(&self, key: &ConversationDraftKey) -> Result<ConversationDraftHead> {
        let Some(mut c) = self.existing(false)? else {
            return Ok(empty(key));
        };
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&tx)?;
        read_head(&tx, key, format)
    }
    pub fn write_conversation(&self, r: &ConversationDraftWrite) -> Result<ConversationDraftHead> {
        validate_value(&r.key, &r.value)?;
        self.mutate_conversation(&r.key, |before| apply_write(before, r, None))
    }
    /// Called only after the Host reads the exact original committed receipt.
    pub fn resolve_conversation(
        &self,
        r: &ConversationDraftResolve,
    ) -> Result<ConversationDraftHead> {
        validate_value(&r.write.key, &r.write.value)?;
        validate_pending(
            &r.write.key,
            &r.pending,
            r.write.value.edit_seq,
            &r.write.value.text,
        )?;
        if r.write.value.pending.is_some() {
            return Err(fail(ErrorCode::InvalidInput, "drafts-pending"));
        }
        self.mutate_conversation(&r.write.key, |before| {
            apply_write(before, &r.write, Some(&r.pending))
        })
    }
    pub fn clear_conversation(&self, r: &ConversationDraftClear) -> Result<ConversationDraftHead> {
        self.mutate_conversation(&r.key, |before| {
            if before.revision != r.expected_revision {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-revision"));
            }
            if before
                .value
                .as_ref()
                .is_some_and(|value| value.pending.is_some())
            {
                return Err(fail(ErrorCode::DependencyConflict, "drafts-pending"));
            }
            if before.value.is_none() && before.revision.get() > 0 {
                return Ok(before.clone());
            }
            Ok(ConversationDraftHead {
                key: r.key.clone(),
                revision: next_revision(before.revision)?,
                writer_id: None,
                value: None,
            })
        })
    }
    pub fn list_conversations(
        &self,
        project: ExecutionId,
        after: Option<&ConversationDraftKey>,
        limit: u32,
    ) -> Result<ConversationDraftPage> {
        if !(1..=MAX_DRAFT_PAGE_SIZE).contains(&limit)
            || after.is_some_and(|key| key.project_id != project)
        {
            return Err(fail(ErrorCode::InvalidInput, "drafts-page"));
        }
        let Some(mut c) = self.existing(false)? else {
            return Ok(ConversationDraftPage {
                items: vec![],
                next: None,
            });
        };
        let tx = c
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(sql)?;
        let format = verify_schema(&tx)?;
        if format < FORMAT {
            return Ok(ConversationDraftPage {
                items: vec![],
                next: None,
            });
        }
        let mut q=tx.prepare("SELECT conversation_id,revision,edit_seq,has_pending,CASE WHEN length(payload)<=?4 THEN payload END FROM conversation_draft_heads WHERE project_id=?1 AND (?2 IS NULL OR conversation_id>?2) ORDER BY conversation_id LIMIT ?3").map_err(sql)?;
        let rows = q
            .query_map(
                params![
                    project.to_string(),
                    after.map(|key| key.conversation_id.to_string()),
                    limit + 1,
                    MAX_DRAFT_RECORD_BYTES as i64
                ],
                |row| Ok((row.get::<_, String>(0)?, stored(row, 1)?)),
            )
            .map_err(sql)?;
        let mut items = vec![];
        let mut last = None;
        let mut more = false;
        for (index, row) in rows.enumerate() {
            let (thread, row) = row.map_err(sql)?;
            let key = ConversationDraftKey {
                project_id: project,
                conversation_id: stored_id(&thread)?,
            };
            let head = decode(&key, row)?;
            if index == limit as usize {
                more = true;
                break;
            }
            last = Some(key.clone());
            if let Some(value) = head.value {
                items.push(ConversationDraftSummary {
                    key,
                    revision: head.revision,
                    edit_seq: value.edit_seq,
                    has_pending: value.pending.is_some(),
                });
            }
        }
        Ok(ConversationDraftPage {
            items,
            next: if more { last } else { None },
        })
    }
}

#[cfg(test)]
mod tests;
