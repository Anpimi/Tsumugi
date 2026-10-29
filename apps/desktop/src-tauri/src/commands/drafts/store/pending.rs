//! A bounded observation of the original journal, with no recovery or mutation.
use super::*;
use sha2::{Digest, Sha256};

const MAX_SNAPSHOT_HEADS: u32 = 1_000;
const MAX_SNAPSHOT_ACTIONS: usize = 1_000;
const MAX_SNAPSHOT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum PendingJournalKey {
    Translation(DraftKey),
    Conversation(ConversationDraftKey),
    Resource(ResourceDraftKey),
}

/// Original frozen requests only. No unrelated current message or editor text.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub enum PendingJournalSlot {
    Translation(DraftPending),
    Conversation(ConversationDraftPending),
    Revocation(ConversationDraftRevocation),
    Resource(ResourceDraftPending),
    ResourceFact(ResourceFactPending),
}

impl PendingJournalSlot {
    pub fn action_id(&self) -> ExecutionId {
        match self {
            Self::Translation(DraftPending::Save { request, .. }
                | DraftPending::Merge { request, .. }) => request.action_id,
            Self::Translation(DraftPending::Selection { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::Create { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::Append { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::Planning { request, .. }) => request.consent.action_id,
            Self::Conversation(ConversationDraftPending::ProposalCapture { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::ProposalRevision { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::ProposalWorkPlan { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::WorkPlanStart { request, .. }) => request.action_id,
            Self::Conversation(ConversationDraftPending::WorkPlanControl { request, .. }) => request.action_id,
            Self::Revocation(slot) => slot.request.action_id,
            Self::Resource(slot) => slot.action_id(),
            Self::ResourceFact(slot) => slot.request.action_id,
        }
    }

    pub fn submitted_seq(&self) -> Revision {
        match self {
            Self::Translation(DraftPending::Save { submitted_seq, .. }
                | DraftPending::Selection { submitted_seq, .. }
                | DraftPending::Merge { submitted_seq, .. }) => *submitted_seq,
            Self::Conversation(ConversationDraftPending::Create { submitted_seq, .. }
                | ConversationDraftPending::Append { submitted_seq, .. }
                | ConversationDraftPending::Planning { submitted_seq, .. }
                | ConversationDraftPending::ProposalCapture { submitted_seq, .. }
                | ConversationDraftPending::ProposalRevision { submitted_seq, .. }
                | ConversationDraftPending::ProposalWorkPlan { submitted_seq, .. }
                | ConversationDraftPending::WorkPlanStart { submitted_seq, .. }
                | ConversationDraftPending::WorkPlanControl { submitted_seq, .. }) => *submitted_seq,
            Self::Revocation(slot) => slot.submitted_seq,
            Self::Resource(slot) => slot.submitted_seq(),
            Self::ResourceFact(slot) => slot.submitted_seq,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PendingActionRef {
    pub key: PendingJournalKey,
    pub head_revision: Revision,
    pub writer_id: ExecutionId,
    pub edit_seq: Revision,
    pub slot: PendingJournalSlot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum PendingSnapshotLimit { Heads, Bytes, Actions }

/// This is a journal basis, not a Core snapshot or proof of dispatch/unknown.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingSnapshot {
    pub rows: Vec<PendingActionRef>,
    pub basis: String,
    pub format: Option<i64>,
    pub scanned_heads: u32,
    pub scanned_bytes: u64,
    pub complete: bool,
    pub limit: Option<PendingSnapshotLimit>,
}

#[derive(Clone, Copy)]
struct SnapshotLimits { heads: u32, bytes: u64, actions: usize }
impl Default for SnapshotLimits {
    fn default() -> Self {
        Self { heads: MAX_SNAPSHOT_HEADS, bytes: MAX_SNAPSHOT_BYTES, actions: MAX_SNAPSHOT_ACTIONS }
    }
}

impl DraftStore {
    /// One existing-file, read-only transaction across both kinds of heads.
    /// Pending describes saved intent; callers must inspect its original owner
    /// and live operation reservation before calling it an unknown outcome.
    pub fn pending_snapshot(&self, project: ExecutionId, locale: Option<&str>) -> Result<PendingSnapshot> {
        self.pending_snapshot_with_limits(project, locale, SnapshotLimits::default())
    }

    fn pending_snapshot_with_limits(&self, project: ExecutionId, locale: Option<&str>, limits: SnapshotLimits) -> Result<PendingSnapshot> {
        if locale.is_some_and(|value| Locale::parse(value).is_err()
            || Locale::parse(value).is_ok_and(|parsed| parsed.as_str() != value)) {
            return Err(fail(ErrorCode::InvalidInput, "drafts-key"));
        }
        let mut snapshot = PendingSnapshot { rows: Vec::new(), basis: String::new(), format: None,
            scanned_heads: 0, scanned_bytes: 0, complete: true, limit: None };
        let mut digest = Sha256::new();
        digest.update(serde_json::to_vec(&("pending-journal-1", project, locale))
            .map_err(|_| fail(ErrorCode::InvalidInput, "drafts-snapshot-basis"))?);
        let Some(mut connection) = self.existing(false)? else {
            return finish(snapshot, digest);
        };
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred).map_err(sql)?;
        let format = verify_schema(&tx)?;
        snapshot.format = Some(format);
        digest.update(format.to_le_bytes());
        let translation = "SELECT 0 AS journal_kind,locale,unit_id AS entry_id,revision,edit_seq,source_revision_id,has_pending,length(payload) AS bytes,payload FROM draft_heads WHERE project_id=?1 AND (?2 IS NULL OR locale=?2)";
        let query = if format >= RESOURCE_FORMAT {
            format!("{translation} UNION ALL SELECT 1 AS journal_kind,'' AS locale,conversation_id AS entry_id,revision,edit_seq,NULL AS source_revision_id,has_pending,length(payload) AS bytes,payload FROM conversation_draft_heads WHERE project_id=?1 UNION ALL SELECT 2 AS journal_kind,'' AS locale,project_id AS entry_id,revision,edit_seq,NULL AS source_revision_id,has_pending,length(payload) AS bytes,payload FROM resource_draft_heads WHERE project_id=?1 ORDER BY journal_kind,locale,entry_id LIMIT ?3")
        } else if format >= CONVERSATION_FORMAT {
            format!("{translation} UNION ALL SELECT 1 AS journal_kind,'' AS locale,conversation_id AS entry_id,revision,edit_seq,NULL AS source_revision_id,has_pending,length(payload) AS bytes,payload FROM conversation_draft_heads WHERE project_id=?1 ORDER BY journal_kind,locale,entry_id LIMIT ?3")
        } else { format!("{translation} ORDER BY journal_kind,locale,entry_id LIMIT ?3") };
        let mut statement = tx.prepare(&query).map_err(sql)?;
        let mut rows = statement.query(params![project.to_string(), locale, i64::from(limits.heads) + 1]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            if snapshot.scanned_heads == limits.heads {
                snapshot.limit = Some(PendingSnapshotLimit::Heads); break;
            }
            let kind: i64 = row.get(0).map_err(sql)?;
            let bytes: i64 = row.get(7).map_err(sql)?;
            let bytes = u64::try_from(bytes).map_err(|_| fail(ErrorCode::CorruptLedger, "drafts-record"))?;
            let record_limit = if kind == 0 || format == CONVERSATION_FORMAT { MAX_DRAFT_RECORD_BYTES } else { MAX_CONVERSATION_DRAFT_RECORD_BYTES };
            if bytes > record_limit as u64 {
                return Err(fail(ErrorCode::CorruptLedger, "drafts-record"));
            }
            if bytes > limits.bytes.saturating_sub(snapshot.scanned_bytes) {
                snapshot.limit = Some(PendingSnapshotLimit::Bytes); break;
            }
            let payload: Vec<u8> = row.get(8).map_err(sql)?;
            digest.update(kind.to_le_bytes());
            digest.update(bytes.to_le_bytes());
            digest.update(&payload);
            let stored_revision: i64 = row.get(3).map_err(sql)?;
            let edit_seq: Option<i64> = row.get(4).map_err(sql)?;
            let has_pending: i64 = row.get(6).map_err(sql)?;
            let entry: String = row.get(2).map_err(sql)?;
            let (key, head_revision, writer_id, edit_seq, slots) = if kind == 0 {
                let key = DraftKey { project_id: project, unit_id: stored_id(&entry)?, locale: row.get(1).map_err(sql)? };
                let head = decode_head(&key, StoredHead { revision: stored_revision, edit_seq,
                    source: row.get(5).map_err(sql)?, pending: has_pending, payload: Some(payload) }, format)?;
                let seq = head.value.as_ref().map(|value| value.edit_seq);
                let slots = head.value.and_then(|value| value.pending)
                    .map(PendingJournalSlot::Translation).into_iter().collect::<Vec<_>>();
                (PendingJournalKey::Translation(key), head.revision, head.writer_id, seq, slots)
            } else if kind == 1 {
                let key = ConversationDraftKey { project_id: project, conversation_id: stored_id(&entry)? };
                let head = conversations::decode(&key, (stored_revision, edit_seq, has_pending, Some(payload)), format)?;
                let seq = head.value.as_ref().map(|value| value.edit_seq);
                let mut slots = Vec::new();
                if let Some(value) = head.value {
                    slots.extend(value.pending.map(PendingJournalSlot::Conversation));
                    slots.extend(value.revocations.into_iter().map(PendingJournalSlot::Revocation));
                }
                (PendingJournalKey::Conversation(key), head.revision, head.writer_id, seq, slots)
            } else {
                let key=ResourceDraftKey{project_id:project};
                if entry!=project.to_string(){return Err(fail(ErrorCode::CorruptLedger,"resource-drafts-project"));}
                let head=resources::decode(&key,(stored_revision,edit_seq,has_pending,Some(payload)))?;
                let seq=head.value.as_ref().map(|v|v.edit_seq);
                let mut slots=Vec::new();
                if let Some(v)=head.value {
                    let include=v.pending.as_ref().is_some_and(|p|locale.is_none_or(|l|resource_locale(p,&v)==Some(l)));
                    slots.extend(v.pending.filter(|_|include).map(PendingJournalSlot::Resource));
                    slots.extend(v.fact_pending.filter(|p|locale.is_none_or(|l|p.request.basis.scope.locale==l)).map(PendingJournalSlot::ResourceFact));
                }
                (PendingJournalKey::Resource(key),head.revision,head.writer_id,seq,slots)
            };
            snapshot.scanned_heads += 1;
            snapshot.scanned_bytes += bytes;
            for slot in slots {
                if snapshot.rows.len() == limits.actions {
                    snapshot.limit = Some(PendingSnapshotLimit::Actions); break;
                }
                snapshot.rows.push(PendingActionRef { key: key.clone(), head_revision,
                    writer_id: writer_id.ok_or_else(|| fail(ErrorCode::CorruptLedger, "drafts-record"))?,
                    edit_seq: edit_seq.ok_or_else(|| fail(ErrorCode::CorruptLedger, "drafts-record"))?, slot });
            }
            if snapshot.limit.is_some() { break; }
        }
        drop(rows);
        drop(statement);
        // End the read transaction. No journal migration or mutation is used.
        tx.commit().map_err(sql)?;
        finish(snapshot, digest)
    }
}

fn resource_locale<'a>(p:&'a ResourceDraftPending,v:&'a ResourceDraftValue)->Option<&'a str>{
    match p {
        ResourceDraftPending::TypedContextSave{request,..}=>Some(&request.locale),
        ResourceDraftPending::TypedContextWithdraw{draft_key,..}=>v.typed_drafts.iter().find(|d|d.key==*draft_key).map(|d|d.locale.as_str()),
        ResourceDraftPending::KnowledgeDecision{draft_key,..}=>v.knowledge_drafts.iter().find(|d|d.key==*draft_key).map(|d|d.locale.as_str()),
        ResourceDraftPending::Correction{request,..}=>Some(&request.basis.locale),
        ResourceDraftPending::Term{request,..}=>Some(&request.locale),
        ResourceDraftPending::Context{request,..}=>Some(&request.locale),
        ResourceDraftPending::Decision{locale,..}=>Some(locale),
        ResourceDraftPending::Capture{request,..}=>Some(&request.locale),
    }
}

fn finish(mut snapshot: PendingSnapshot, mut digest: Sha256) -> Result<PendingSnapshot> {
    snapshot.complete = snapshot.limit.is_none();
    digest.update(serde_json::to_vec(&(snapshot.format, snapshot.scanned_heads,
        snapshot.scanned_bytes, snapshot.limit)).map_err(|_| fail(ErrorCode::InvalidInput, "drafts-snapshot-basis"))?);
    snapshot.basis = format!("{:x}", digest.finalize());
    Ok(snapshot)
}

#[cfg(test)]
mod tests;
