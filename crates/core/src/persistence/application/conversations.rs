//! Durable project conversations, independent of execution permission and plans.
use super::super::{ChangeScope, ProjectStore, ledger, read_metadata_from, review::read_snapshot};
use crate::{
    application::conversations::*,
    execution::{ErrorCode, ExecutionError, ExecutionId, Revision, codec},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
mod planning;

const MAX_RECORD: usize = 64 * 1024;
const TABLES: &[(&str, &str)] = &[
    (
        "application_conversations",
        "CREATE TABLE application_conversations (conversation_id TEXT PRIMARY KEY NOT NULL, ordinal INTEGER NOT NULL UNIQUE CHECK(ordinal>0), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 4096), digest TEXT NOT NULL CHECK(length(digest)=64))",
    ),
    (
        "application_conversation_messages",
        "CREATE TABLE application_conversation_messages (message_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES application_conversations(conversation_id), ordinal INTEGER NOT NULL CHECK(ordinal>0), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 65536), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(conversation_id,ordinal))",
    ),
    (
        "application_conversation_actions",
        "CREATE TABLE application_conversation_actions (action_id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL REFERENCES application_conversations(conversation_id), request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 65536), request_digest TEXT NOT NULL CHECK(length(request_digest)=64), receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 65536), receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64))",
    ),
];
pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES {
        c.execute_batch(sql)?;
    }
    Ok(())
}
pub(in crate::persistence) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| name.to_string())
}
fn fail(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn corrupt() -> ExecutionError {
    fail(ErrorCode::CorruptLedger, "conversation-record")
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    ledger::sql_error(error)
}
fn owned(c: &Connection, project: ExecutionId) -> Result<(), ExecutionError> {
    if read_metadata_from(c)
        .map_err(|_| corrupt())?
        .project_id()
        .to_string()
        != project.to_string()
    {
        return Err(fail(ErrorCode::Unauthorized, "conversation-project"));
    }
    Ok(())
}
fn title(value: &Option<String>) -> Result<(), ExecutionError> {
    if value
        .as_ref()
        .is_some_and(|value| value.trim().is_empty() || value.len() > MAX_CONVERSATION_TITLE_BYTES)
    {
        return Err(fail(ErrorCode::InvalidInput, "conversation-title"));
    }
    Ok(())
}
fn body(value: &str) -> Result<(), ExecutionError> {
    if value.trim().is_empty() || value.len() > MAX_CONVERSATION_MESSAGE_BYTES {
        return Err(fail(ErrorCode::InvalidInput, "conversation-body"));
    }
    Ok(())
}
fn decode<T: for<'de> Deserialize<'de>>(bytes: &[u8], digest: &str) -> Result<T, ExecutionError> {
    if codec::digest(bytes) != digest {
        return Err(corrupt());
    }
    codec::decode(bytes, MAX_RECORD).map_err(|_| corrupt())
}
fn conversation(
    c: &Connection,
    project: ExecutionId,
    id: ExecutionId,
) -> Result<ProjectConversation, ExecutionError> {
    let row: Option<(i64, Vec<u8>, String)> = c
        .query_row(
            "SELECT ordinal,record,digest FROM application_conversations WHERE conversation_id=?1",
            [id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(sql)?;
    let (ordinal, bytes, digest) =
        row.ok_or_else(|| fail(ErrorCode::Unauthorized, "conversation-identity"))?;
    let value: ProjectConversation = decode(&bytes, &digest)?;
    if value.project_id != project
        || value.conversation_id != id
        || ordinal <= 0
        || value.ordinal.get() != ordinal as u64
        || title(&value.title).is_err()
    {
        return Err(corrupt());
    }
    Ok(value)
}
fn message(
    c: &Connection,
    project: ExecutionId,
    id: ExecutionId,
) -> Result<ProjectConversationMessage, ExecutionError> {
    let row: Option<(String,i64,Vec<u8>,String)>=c.query_row("SELECT conversation_id,ordinal,record,digest FROM application_conversation_messages WHERE message_id=?1",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
    let (parent, ordinal, bytes, digest) = row.ok_or_else(corrupt)?;
    let value: ProjectConversationMessage = decode(&bytes, &digest)?;
    if value.project_id != project
        || value.message_id != id
        || value.conversation_id.to_string() != parent
        || ordinal <= 0
        || value.ordinal.get() != ordinal as u64
        || body(&value.body).is_err()
    {
        return Err(corrupt());
    }
    conversation(c, project, value.conversation_id)?;
    Ok(value)
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Action {
    Create {
        request: CreateProjectConversation,
    },
    Append {
        request: AppendProjectConversationMessage,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Receipt {
    Create { receipt: ProjectConversation },
    Append { receipt: ProjectConversationMessage },
}
impl Action {
    fn id(&self) -> ExecutionId {
        match self {
            Self::Create { request } => request.action_id,
            Self::Append { request } => request.action_id,
        }
    }
    fn parent(&self) -> ExecutionId {
        match self {
            Self::Create { request } => request.conversation_id,
            Self::Append { request } => request.conversation_id,
        }
    }
    fn project(&self) -> ExecutionId {
        match self {
            Self::Create { request } => request.project_id,
            Self::Append { request } => request.project_id,
        }
    }
}
fn action(
    c: &Connection,
    project: ExecutionId,
    id: ExecutionId,
) -> Result<Option<(Action, Receipt)>, ExecutionError> {
    let row:Option<(String,Vec<u8>,String,Vec<u8>,String)>=c.query_row("SELECT conversation_id,request,request_digest,receipt,receipt_digest FROM application_conversation_actions WHERE action_id=?1",[id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(sql)?;
    let Some((parent, request, request_digest, receipt, receipt_digest)) = row else {
        return Ok(None);
    };
    let request: Action = decode(&request, &request_digest)?;
    let receipt: Receipt = decode(&receipt, &receipt_digest)?;
    if request.id() != id || request.parent().to_string() != parent || request.project() != project
    {
        return Err(corrupt());
    }
    match (&request, &receipt) {
        (Action::Create { request }, Receipt::Create { receipt })
            if request.title == receipt.title
                && receipt == &conversation(c, project, request.conversation_id)? =>
        {
            ()
        }
        (Action::Append { request }, Receipt::Append { receipt })
            if receipt == &message(c, project, request.message_id)?
                && receipt.conversation_id == request.conversation_id
                && receipt.body == request.body =>
        {
            ()
        }
        _ => return Err(corrupt()),
    }
    Ok(Some((request, receipt)))
}
fn original(c: &Connection, request: &Action) -> Result<Option<Receipt>, ExecutionError> {
    match action(c, request.project(), request.id())? {
        Some((saved, receipt)) if &saved == request => Ok(Some(receipt)),
        Some(_) => Err(fail(ErrorCode::ResultMismatch, "conversation-action")),
        None => Ok(None),
    }
}
fn record(c: &Connection, request: &Action, receipt: &Receipt) -> Result<(), ExecutionError> {
    let bytes = codec::encode(request, MAX_RECORD)?;
    let result = codec::encode(receipt, MAX_RECORD)?;
    c.execute(
        "INSERT INTO application_conversation_actions VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            request.id().to_string(),
            request.parent().to_string(),
            bytes,
            codec::digest(&bytes),
            result,
            codec::digest(&result)
        ],
    )
    .map_err(sql)?;
    Ok(())
}
pub(in crate::persistence) fn validate(c: &Connection) -> Result<(), ExecutionError> {
    let project = ExecutionId::parse(
        &read_metadata_from(c)
            .map_err(|_| corrupt())?
            .project_id()
            .to_string(),
    )
    .map_err(|_| corrupt())?;
    let mut parents = std::collections::BTreeSet::new();
    let mut messages = std::collections::BTreeSet::new();
    let mut q = c
        .prepare("SELECT action_id FROM application_conversation_actions ORDER BY action_id")
        .map_err(sql)?;
    for id in q.query_map([], |r| r.get::<_, String>(0)).map_err(sql)? {
        let id = ExecutionId::parse(&id.map_err(sql)?).map_err(|_| corrupt())?;
        let (request, _) = action(c, project, id)?.ok_or_else(corrupt)?;
        match request {
            Action::Create { request } => {
                if !parents.insert(request.conversation_id) {
                    return Err(corrupt());
                }
            }
            Action::Append { request } => {
                if !messages.insert(request.message_id) {
                    return Err(corrupt());
                }
            }
        }
    }
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM application_conversations", [], |r| {
            r.get(0)
        })
        .map_err(sql)?;
    let max: i64 = c
        .query_row(
            "SELECT COALESCE(MAX(ordinal),0) FROM application_conversations",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    let sent: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM application_conversation_messages",
            [],
            |r| r.get(0),
        )
        .map_err(sql)?;
    if count != parents.len() as i64 || max != count || sent != messages.len() as i64 {
        return Err(corrupt());
    }
    for parent in parents {
        let (count,max):(i64,i64)=c.query_row("SELECT COUNT(*),COALESCE(MAX(ordinal),0) FROM application_conversation_messages WHERE conversation_id=?1",[parent.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
        if count != max {
            return Err(corrupt());
        }
    }
    Ok(())
}
fn page_limit(limit: u32) -> Result<(), ExecutionError> {
    if limit == 0 || limit > MAX_CONVERSATION_PAGE {
        return Err(fail(ErrorCode::InvalidInput, "conversation-page"));
    }
    Ok(())
}

impl ProjectStore {
    /// Internal command deduplication only; unlike explicit recovery this never
    /// clears the original unknown gate or grants replay permission.
    pub fn project_conversation_create_receipt(
        &self,
        r: &CreateProjectConversation,
    ) -> Result<Option<ProjectConversation>, ExecutionError> {
        title(&r.title)?;
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-read"))?,
            |c| {
                owned(c, r.project_id)?;
                match original(c, &Action::Create { request: r.clone() })? {
                    Some(Receipt::Create { receipt }) => Ok(Some(receipt)),
                    None => Ok(None),
                    _ => Err(corrupt()),
                }
            },
        )
    }
    pub fn project_conversation_message_receipt(
        &self,
        r: &AppendProjectConversationMessage,
    ) -> Result<Option<ProjectConversationMessage>, ExecutionError> {
        body(&r.body)?;
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-read"))?,
            |c| {
                owned(c, r.project_id)?;
                match original(c, &Action::Append { request: r.clone() })? {
                    Some(Receipt::Append { receipt }) => Ok(Some(receipt)),
                    None => Ok(None),
                    _ => Err(corrupt()),
                }
            },
        )
    }
    /// Trusted local human entry point. It does not initialize or authorize a runtime.
    pub fn create_project_conversation(
        &self,
        r: &CreateProjectConversation,
    ) -> Result<ProjectConversation, ExecutionError> {
        if self.is_reconciling() {
            return Err(fail(ErrorCode::OutcomeUnknown, "conversation-session"));
        }
        title(&r.title)?;
        let tx = self.execution_write_scoped(ChangeScope::Project)?;
        owned(&tx, r.project_id)?;
        let request = Action::Create { request: r.clone() };
        if let Some(Receipt::Create { receipt }) = original(&tx, &request)? {
            return Ok(receipt);
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM application_conversations WHERE conversation_id=?1)",
                [r.conversation_id.to_string()],
                |r| r.get(0),
            )
            .map_err(sql)?;
        if exists {
            return Err(fail(ErrorCode::ResultMismatch, "conversation-identity"));
        }
        let next: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(ordinal),0)+1 FROM application_conversations",
                [],
                |r| r.get(0),
            )
            .map_err(sql)?;
        let receipt = ProjectConversation {
            project_id: r.project_id,
            conversation_id: r.conversation_id,
            ordinal: Revision::new(u64::try_from(next).map_err(|_| corrupt())?)?,
            title: r.title.clone(),
        };
        let bytes = codec::encode(&receipt, 4096)?;
        tx.execute(
            "INSERT INTO application_conversations VALUES(?1,?2,?3,?4)",
            params![
                r.conversation_id.to_string(),
                next,
                bytes,
                codec::digest(&bytes)
            ],
        )
        .map_err(sql)?;
        record(
            &tx,
            &request,
            &Receipt::Create {
                receipt: receipt.clone(),
            },
        )?;
        ledger::commit(tx)?;
        Ok(receipt)
    }
    pub fn append_project_conversation_message(
        &self,
        r: &AppendProjectConversationMessage,
    ) -> Result<ProjectConversationMessage, ExecutionError> {
        if self.is_reconciling() {
            return Err(fail(ErrorCode::OutcomeUnknown, "conversation-session"));
        }
        body(&r.body)?;
        let tx = self.execution_write_scoped(ChangeScope::Project)?;
        owned(&tx, r.project_id)?;
        let request = Action::Append { request: r.clone() };
        if let Some(Receipt::Append { receipt }) = original(&tx, &request)? {
            return Ok(receipt);
        }
        conversation(&tx, r.project_id, r.conversation_id)?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM application_conversation_messages WHERE message_id=?1)",[r.message_id.to_string()],|r|r.get(0)).map_err(sql)?;
        if exists {
            return Err(fail(
                ErrorCode::ResultMismatch,
                "conversation-message-identity",
            ));
        }
        let next:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM application_conversation_messages WHERE conversation_id=?1",[r.conversation_id.to_string()],|r|r.get(0)).map_err(sql)?;
        let receipt = ProjectConversationMessage {
            project_id: r.project_id,
            conversation_id: r.conversation_id,
            message_id: r.message_id,
            ordinal: Revision::new(u64::try_from(next).map_err(|_| corrupt())?)?,
            author: ConversationAuthor::Human,
            body: r.body.clone(),
        };
        let bytes = codec::encode(&receipt, MAX_RECORD)?;
        tx.execute(
            "INSERT INTO application_conversation_messages VALUES(?1,?2,?3,?4,?5)",
            params![
                r.message_id.to_string(),
                r.conversation_id.to_string(),
                next,
                bytes,
                codec::digest(&bytes)
            ],
        )
        .map_err(sql)?;
        record(
            &tx,
            &request,
            &Receipt::Append {
                receipt: receipt.clone(),
            },
        )?;
        ledger::commit(tx)?;
        Ok(receipt)
    }
    pub fn read_project_conversation(
        &self,
        project: ExecutionId,
        id: ExecutionId,
    ) -> Result<ProjectConversation, ExecutionError> {
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-read"))?,
            |c| {
                owned(c, project)?;
                conversation(c, project, id)
            },
        )
    }
    pub fn list_project_conversations(
        &self,
        project: ExecutionId,
        after: Option<Revision>,
        limit: u32,
    ) -> Result<ProjectConversationPage, ExecutionError> {
        page_limit(limit)?;
        let after = i64::try_from(after.map_or(0, |value| value.get()))
            .map_err(|_| fail(ErrorCode::InvalidInput, "conversation-page"))?;
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-read"))?,
            |c| {
                owned(c, project)?;
                let mut q=c.prepare("SELECT conversation_id FROM application_conversations WHERE ordinal>?1 ORDER BY ordinal LIMIT ?2").map_err(sql)?;
                let ids = q
                    .query_map(params![after, limit + 1], |r| r.get::<_, String>(0))
                    .map_err(sql)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sql)?;
                let mut page = ProjectConversationPage {
                    project_id: project,
                    rows: Vec::new(),
                    next_after: None,
                };
                for (index, id) in ids.iter().take(limit as usize).enumerate() {
                    page.rows.push(conversation(
                        c,
                        project,
                        ExecutionId::parse(id).map_err(|_| corrupt())?,
                    )?);
                    page.next_after = if ids.len() > index + 1 {
                        page.rows.last().map(|row| row.ordinal)
                    } else {
                        None
                    };
                    if codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES).is_err() {
                        page.rows.pop();
                        page.next_after = Some(
                            page.rows
                                .last()
                                .ok_or_else(|| {
                                    fail(ErrorCode::LimitExceeded, "conversation-page-bytes")
                                })?
                                .ordinal,
                        );
                        break;
                    }
                }
                codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES)?;
                Ok(page)
            },
        )
    }
    pub fn read_project_conversation_messages(
        &self,
        project: ExecutionId,
        id: ExecutionId,
        after: Option<Revision>,
        limit: u32,
    ) -> Result<ProjectConversationMessagePage, ExecutionError> {
        page_limit(limit)?;
        let after = i64::try_from(after.map_or(0, |value| value.get()))
            .map_err(|_| fail(ErrorCode::InvalidInput, "conversation-page"))?;
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-read"))?,
            |c| {
                owned(c, project)?;
                conversation(c, project, id)?;
                let mut q=c.prepare("SELECT message_id FROM application_conversation_messages WHERE conversation_id=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3").map_err(sql)?;
                let ids = q
                    .query_map(params![id.to_string(), after, limit + 1], |r| {
                        r.get::<_, String>(0)
                    })
                    .map_err(sql)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sql)?;
                let mut page = ProjectConversationMessagePage {
                    project_id: project,
                    conversation_id: id,
                    rows: Vec::new(),
                    next_after: None,
                };
                for (index, key) in ids.iter().take(limit as usize).enumerate() {
                    page.rows.push(message(
                        c,
                        project,
                        ExecutionId::parse(key).map_err(|_| corrupt())?,
                    )?);
                    page.next_after = if ids.len() > index + 1 {
                        page.rows.last().map(|row| row.ordinal)
                    } else {
                        None
                    };
                    if codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES).is_err() {
                        page.rows.pop();
                        page.next_after = Some(
                            page.rows
                                .last()
                                .ok_or_else(|| {
                                    fail(ErrorCode::LimitExceeded, "conversation-page-bytes")
                                })?
                                .ordinal,
                        );
                        break;
                    }
                }
                codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES)?;
                Ok(page)
            },
        )
    }
    fn recover_conversation_action(
        &self,
        request: &Action,
    ) -> Result<Option<Receipt>, ExecutionError> {
        let found = read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-read"))?,
            |c| {
                owned(c, request.project())?;
                original(c, request)
            },
        )?;
        // An explicit verified recovery may resolve the original in-memory commit
        // uncertainty. Internal write deduplication never calls this path.
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(found)
    }
    pub fn recover_project_conversation_create(
        &self,
        r: &CreateProjectConversation,
    ) -> Result<ProjectConversationCreateRecovery, ExecutionError> {
        title(&r.title)?;
        let outcome = match self.recover_conversation_action(&Action::Create { request: r.clone() })
        {
            Ok(Some(Receipt::Create { receipt })) => {
                ConversationActionOutcome::Recorded { receipt }
            }
            Ok(None) => ConversationActionOutcome::Pending {
                replay: self.conversation_replay(),
            },
            Err(error)
                if error.code == ErrorCode::ResultMismatch
                    && error.stage == "conversation-action" =>
            {
                ConversationActionOutcome::Mismatch {}
            }
            Err(error) => return Err(error),
            _ => return Err(corrupt()),
        };
        Ok(ProjectConversationCreateRecovery {
            request: r.clone(),
            outcome,
        })
    }
    pub fn recover_project_conversation_message(
        &self,
        r: &AppendProjectConversationMessage,
    ) -> Result<ProjectConversationMessageRecovery, ExecutionError> {
        body(&r.body)?;
        let outcome = match self.recover_conversation_action(&Action::Append { request: r.clone() })
        {
            Ok(Some(Receipt::Append { receipt })) => {
                ConversationActionOutcome::Recorded { receipt }
            }
            Ok(None) => ConversationActionOutcome::Pending {
                replay: self.conversation_replay(),
            },
            Err(error)
                if error.code == ErrorCode::ResultMismatch
                    && error.stage == "conversation-action" =>
            {
                ConversationActionOutcome::Mismatch {}
            }
            Err(error) => return Err(error),
            _ => return Err(corrupt()),
        };
        Ok(ProjectConversationMessageRecovery {
            request: r.clone(),
            outcome,
        })
    }
    fn conversation_replay(&self) -> ConversationActionReplay {
        if self.is_reconciling() {
            ConversationActionReplay::Blocked
        } else {
            ConversationActionReplay::ExplicitSameRequest
        }
    }
}

#[cfg(test)]
mod tests;
