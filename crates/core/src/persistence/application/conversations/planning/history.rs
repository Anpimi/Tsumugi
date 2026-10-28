//! A derived locator only. Input, output, permissions and budgets stay in the ledger.
use super::*;
use crate::execution::FixedInput;

const TABLE: &str = "CREATE TABLE application_conversation_planning_attempts (attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_attempts(attempt_id), conversation_id TEXT NOT NULL REFERENCES application_conversations(conversation_id), sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0), UNIQUE(conversation_id,sequence))";

pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch(TABLE)
}

pub(in crate::persistence) fn table_names() -> impl Iterator<Item = String> {
    ["application_conversation_planning_attempts".to_string()].into_iter()
}

fn parent(input: &FixedInput) -> Result<Option<ExecutionId>, ExecutionError> {
    if input.envelope().operation != conversation_planning::OPERATION
        && input.envelope().capability_id != conversation_planning::CAPABILITY
    {
        return Ok(None);
    }
    conversation_planning::settings(input).map_err(|_| corrupt())?;
    // settings validates the exact scope against the original preview.
    ExecutionId::parse(&input.envelope().items[0].scope.id)
        .map(Some)
        .map_err(|_| corrupt())
}

/// Called after the original attempt insert, within that same write transaction.
pub(in crate::persistence) fn record_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<(), ExecutionError> {
    let Some(parent) = parent(input)? else {
        return Ok(());
    };
    conversation(c, input.envelope().project_id, parent)?;
    let changed = c.execute(
        "INSERT INTO application_conversation_planning_attempts(attempt_id,conversation_id,sequence) SELECT attempt_id,?2,sequence FROM execution_attempts WHERE attempt_id=?1",
        params![input.envelope().attempt_id.to_string(), parent.to_string()],
    ).map_err(sql)?;
    if changed != 1 {
        return Err(corrupt());
    }
    Ok(())
}

/// Migration only: stream every original frame through the existing reader.
/// Results and proposal capture are deliberately irrelevant to discovery.
pub(in crate::persistence) fn backfill(c: &Connection) -> Result<(), ExecutionError> {
    let mut q = c
        .prepare("SELECT attempt_id FROM execution_attempts ORDER BY sequence")
        .map_err(sql)?;
    let ids = q
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sql)?;
    for id in ids {
        let id = ExecutionId::parse(&id.map_err(sql)?).map_err(|_| corrupt())?;
        record_input(c, &ledger::load_input(c, id)?)?;
    }
    Ok(())
}

/// Join the existing complete open-time ledger pass, so missing, forged or
/// reparented locators cannot make an incomplete history look authoritative.
pub(in crate::persistence) fn validate_input(
    c: &Connection,
    input: &FixedInput,
) -> Result<bool, ExecutionError> {
    let Some(parent) = parent(input)? else {
        return Ok(false);
    };
    let row: Option<(String, i64, i64)> = c.query_row(
        "SELECT d.conversation_id,d.sequence,a.sequence FROM application_conversation_planning_attempts d JOIN execution_attempts a ON a.attempt_id=d.attempt_id WHERE d.attempt_id=?1",
        [input.envelope().attempt_id.to_string()],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional().map_err(sql)?;
    let (saved, sequence, original) = row.ok_or_else(corrupt)?;
    if saved != parent.to_string() || sequence <= 0 || sequence != original {
        return Err(corrupt());
    }
    conversation(c, input.envelope().project_id, parent)?;
    if ledger::provider::recovery_policy(c, input.envelope().attempt_id)?
        != crate::execution::RecoveryPolicy::ExternalUnknown
    {
        return Err(corrupt());
    }
    Ok(true)
}

pub(in crate::persistence) fn validate(
    c: &Connection,
    expected: u64,
) -> Result<(), ExecutionError> {
    let shape: String = c.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='application_conversation_planning_attempts'",
        [], |row| row.get(0),
    ).map_err(sql)?;
    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM application_conversation_planning_attempts",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if shape != TABLE || u64::try_from(count).ok() != Some(expected) {
        return Err(corrupt());
    }
    Ok(())
}

impl ProjectStore {
    /// Pure history discovery: no runtime, permit, reconciliation or replay.
    /// The indexed seek bounds work independently of unrelated project tasks.
    pub fn conversation_planning_attempts(
        &self,
        project: ExecutionId,
        parent: ExecutionId,
        after: Revision,
        limit: u32,
    ) -> Result<ConversationPlanningAttemptPage, ExecutionError> {
        page_limit(limit)?;
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-planning-history"))?;
        read_snapshot(c, |c| {
            owned(c, project)?;
            conversation(c, project, parent)?;
            let mut q = c.prepare(
                "SELECT attempt_id,sequence FROM application_conversation_planning_attempts WHERE conversation_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3",
            ).map_err(sql)?;
            let ids = q
                .query_map(
                    params![parent.to_string(), after.get() as i64, limit + 1],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(sql)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql)?;
            let mut page = ConversationPlanningAttemptPage {
                project_id: project,
                conversation_id: parent,
                rows: Vec::with_capacity(limit as usize),
                next_after: None,
            };
            for (id, sequence) in ids.iter().take(limit as usize) {
                let attempt = ExecutionId::parse(id).map_err(|_| corrupt())?;
                let input = ledger::load_input(c, attempt)?;
                if input.envelope().project_id != project || !validate_input(c, &input)? {
                    return Err(corrupt());
                }
                page.rows.push(ConversationPlanningAttempt {
                    sequence: Revision::new(u64::try_from(*sequence).map_err(|_| corrupt())?)?,
                    task_id: input.envelope().task_id,
                    attempt_id: attempt,
                });
            }
            if ids.len() > limit as usize {
                page.next_after = page.rows.last().map(|row| row.sequence);
            }
            // Rows contain bounded identities only; never copy a prompt or a
            // result into the discovery page or truncate their source bytes.
            codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES)?;
            Ok(page)
        })
    }
}
