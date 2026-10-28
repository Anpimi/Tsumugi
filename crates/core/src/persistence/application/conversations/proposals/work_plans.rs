//! Immutable proposal-to-plan associations and full confirmation evidence.
//! The original application authority remains the only owner of grants.
use super::*;
use crate::{
    application::{AuthorizeWorkPlan, WorkPlan},
    execution::MAX_INPUT_BYTES,
    persistence::application::control,
};

pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TABLE application_conversation_work_plans (plan_id TEXT PRIMARY KEY NOT NULL REFERENCES application_plans(plan_id), action_id TEXT NOT NULL UNIQUE REFERENCES application_actions(action_id), revision_id TEXT NOT NULL REFERENCES application_conversation_proposals(revision_id), conversation_id TEXT NOT NULL REFERENCES application_conversations(conversation_id), ordinal INTEGER NOT NULL CHECK(ordinal>0), request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 4194304), request_digest TEXT NOT NULL CHECK(length(request_digest)=64), record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 4096), digest TEXT NOT NULL CHECK(length(digest)=64), UNIQUE(conversation_id,ordinal))")
}
pub(in crate::persistence) fn table_names() -> impl Iterator<Item = String> {
    ["application_conversation_work_plans".to_string()].into_iter()
}

fn inner(r: &AuthorizeConversationProposalWorkPlan) -> AuthorizeWorkPlan {
    AuthorizeWorkPlan {
        action_id: r.action_id,
        plan_digest: r.plan_digest.clone(),
        confirmed: r.confirmed,
        effects: r.effects.clone(),
        expires_at: r.expires_at.get(),
    }
}
pub(in crate::persistence::application::conversations) fn summary(
    r: &AuthorizeConversationProposalWorkPlan,
) -> Result<Action, ExecutionError> {
    let bytes = codec::encode(r, MAX_INPUT_BYTES)?;
    Ok(Action::AuthorizeProposalWorkPlan {
        action_id: r.action_id,
        proposal: r.proposal.clone(),
        plan_id: r.plan_id,
        request_digest: codec::digest(&bytes),
    })
}

pub(in crate::persistence) fn reject_generic_authorization(
    c: &Connection,
    plan: ExecutionId,
    action: ExecutionId,
) -> Result<(), ExecutionError> {
    let bound:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM application_conversation_work_plans WHERE plan_id=?1 OR action_id=?2)",params![plan.to_string(),action.to_string()],|r|r.get(0)).map_err(sql)?;
    if bound {
        return Err(fail(
            ErrorCode::Unauthorized,
            "conversation-proposal-confirmation-required",
        ));
    }
    Ok(())
}

fn mapping_in(
    c: &Connection,
    source: &ConversationProposalRef,
    plan: &WorkPlan,
) -> Result<ConversationProposalRevision, ExecutionError> {
    let revision = revision_in(
        c,
        source.project_id,
        source.conversation_id,
        source.proposal_id,
        source.revision_id,
    )?;
    let ConversationPlanningModelOutput::Proposal {
        unit_ids,
        options,
        questions,
        ..
    } = &revision.content
    else {
        return Err(corrupt());
    };
    if !questions.is_empty() {
        return Err(fail(
            ErrorCode::Unauthorized,
            "conversation-proposal-questions",
        ));
    }
    let evidence = origin_in(
        c,
        source.project_id,
        source.conversation_id,
        revision.origin.attempt_id,
        revision.origin.result_id,
    )?;
    let ConversationPlanningScope::Units { locale, .. } = &evidence.preview.scope else {
        return Err(corrupt());
    };
    let mut expected = options.clone();
    expected.stages.sort_by_key(|choice| choice.stage);
    let mut units = unit_ids.clone();
    units.sort();
    let actual = plan
        .selection_basis
        .iter()
        .map(|basis| basis.unit_id)
        .collect::<Vec<_>>();
    if plan.project_id != source.project_id
        || &plan.locale != locale
        || actual != units
        || plan.options != expected
        || plan.maintenance.is_some()
    {
        return Err(fail(
            ErrorCode::ResultMismatch,
            "conversation-proposal-work-plan",
        ));
    }
    Ok(revision)
}

fn current_in(
    store: &ProjectStore,
    c: &Connection,
    source: &ConversationProposalRef,
    plan: &WorkPlan,
) -> Result<(), ExecutionError> {
    let revision = mapping_in(c, source, plan)?;
    if head(c, source.proposal_id)? != Some(source.revision_id) {
        return Err(fail(
            ErrorCode::DependencyConflict,
            "conversation-proposal-head",
        ));
    }
    let evidence = origin_in(
        c,
        source.project_id,
        source.conversation_id,
        revision.origin.attempt_id,
        revision.origin.result_id,
    )?;
    planning::validate_material_in(store, c, &evidence.preview, &evidence.material)?;
    store.verify_work_plan(plan)
}

fn check_confirmations(
    store: &ProjectStore,
    plan: &WorkPlan,
    r: &AuthorizeConversationProposalWorkPlan,
) -> Result<(), ExecutionError> {
    if plan.plan_id != r.plan_id
        || plan.digest != r.plan_digest
        || !r.confirmed
        || r.effects != plan.authorization_effects()?
        || r.tool_execution != plan.tools.is_some()
    {
        return Err(fail(
            ErrorCode::Unauthorized,
            "conversation-proposal-confirmation",
        ));
    }
    let expected = store
        .work_plan_review_checkers(plan)?
        .into_iter()
        .map(|checker| checker.key)
        .collect::<Vec<_>>();
    if r.checker_executions != expected {
        return Err(fail(ErrorCode::Unauthorized, "plugin-consent-required"));
    }
    let mut applications = BTreeMap::new();
    for tool in plan.tools.iter().flat_map(|tools| &tools.entries) {
        if let Some(basis) = &tool.execution.application_scope {
            if applications
                .insert(basis.instance_id, basis.clone())
                .is_some_and(|prior| prior != *basis)
            {
                return Err(corrupt());
            }
        }
    }
    let mut actual = BTreeMap::new();
    for basis in &r.application_tool_executions {
        if actual.insert(basis.instance_id, basis.clone()).is_some() {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-proposal-application-consent",
            ));
        }
    }
    if actual != applications {
        return Err(fail(
            ErrorCode::Unauthorized,
            "conversation-proposal-application-consent",
        ));
    }
    Ok(())
}

/// Verify the complete immutable outer request before consulting inner authority.
pub(in crate::persistence) fn link_in(
    c: &Connection,
    project: ExecutionId,
    thread: ExecutionId,
    plan: ExecutionId,
) -> Result<
    (
        ConversationProposalWorkPlanLink,
        AuthorizeConversationProposalWorkPlan,
    ),
    ExecutionError,
> {
    let row:Option<(String,String,String,i64,Vec<u8>,String,Vec<u8>,String)>=c.query_row("SELECT action_id,revision_id,conversation_id,ordinal,request,request_digest,record,digest FROM application_conversation_work_plans WHERE plan_id=?1",[plan.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).optional().map_err(sql)?;
    let (action, revision, conversation, ordinal, bytes, request_digest, record, digest) = row
        .ok_or_else(|| {
            fail(
                ErrorCode::Unauthorized,
                "conversation-proposal-work-plan-identity",
            )
        })?;
    if codec::digest(&bytes) != request_digest {
        return Err(corrupt());
    }
    let r: AuthorizeConversationProposalWorkPlan = codec::decode(&bytes, MAX_INPUT_BYTES)?;
    let link: ConversationProposalWorkPlanLink = decode(&record, &digest)?;
    owned(c, project)?;
    if link.project_id != project
        || link.conversation_id != thread
        || link.plan_id != plan
        || link.action_id.to_string() != action
        || link.revision_id.to_string() != revision
        || link.conversation_id.to_string() != conversation
        || ordinal <= 0
        || link.ordinal.get() != ordinal as u64
        || r.proposal
            != (ConversationProposalRef {
                project_id: project,
                conversation_id: thread,
                proposal_id: link.proposal_id,
                revision_id: link.revision_id,
            })
        || r.plan_id != plan
        || r.action_id != link.action_id
        || r.plan_digest != link.plan_digest
    {
        return Err(corrupt());
    }
    let original:Option<(Vec<u8>,String,Vec<u8>,String)>=c.query_row("SELECT request,request_digest,receipt,receipt_digest FROM application_conversation_actions WHERE action_id=?1",[link.action_id.to_string()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).optional().map_err(sql)?;
    let (request_bytes, request_hash, receipt_bytes, receipt_hash) =
        original.ok_or_else(corrupt)?;
    if decode::<Action>(&request_bytes, &request_hash)? != summary(&r)?
        || decode::<Receipt>(&receipt_bytes, &receipt_hash)?
            != (Receipt::ProposalWorkPlan {
                receipt: link.clone(),
            })
    {
        return Err(corrupt());
    }
    let stored = control::load(c, plan)?;
    let action_plan: String = c
        .query_row(
            "SELECT plan_id FROM application_actions WHERE action_id=?1",
            [link.action_id.to_string()],
            |row| row.get(0),
        )
        .map_err(sql)?;
    if action_plan != plan.to_string() {
        return Err(corrupt());
    }
    mapping_in(c, &r.proposal, &stored.plan)?;
    if stored.plan.digest != link.plan_digest {
        return Err(corrupt());
    }
    let request = control::Request::Authorize {
        plan_id: plan,
        request: inner(&r),
    };
    let receipt = control::existing(c, &request)?.ok_or_else(corrupt)?;
    control::validate_receipt(&request, &receipt, &stored)?;
    Ok((link, r))
}

fn original_link(
    c: &Connection,
    r: &AuthorizeConversationProposalWorkPlan,
) -> Result<Option<ConversationProposalWorkPlanLink>, ExecutionError> {
    let request = summary(r)?;
    match original(c, &request)? {
        Some(Receipt::ProposalWorkPlan { receipt }) => {
            let (link, saved) = link_in(
                c,
                r.proposal.project_id,
                r.proposal.conversation_id,
                r.plan_id,
            )?;
            if &saved != r || link != receipt {
                return Err(fail(ErrorCode::ResultMismatch, "conversation-action"));
            }
            Ok(Some(link))
        }
        None => {
            let inner_exists: bool = c
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM application_actions WHERE action_id=?1)",
                    [r.action_id.to_string()],
                    |row| row.get(0),
                )
                .map_err(sql)?;
            if inner_exists {
                return Err(fail(ErrorCode::ResultMismatch, "conversation-action"));
            }
            Ok(None)
        }
        _ => Err(corrupt()),
    }
}

pub(in crate::persistence::application::conversations) fn validate(
    c: &Connection,
    recorded: &BTreeSet<ExecutionId>,
) -> Result<(), ExecutionError> {
    let project = ExecutionId::parse(
        &read_metadata_from(c)
            .map_err(|_| corrupt())?
            .project_id()
            .to_string(),
    )
    .map_err(|_| corrupt())?;
    let ids=c.prepare("SELECT plan_id,conversation_id FROM application_conversation_work_plans ORDER BY conversation_id,ordinal").map_err(sql)?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
    let mut actions = BTreeSet::new();
    let mut ordinals = BTreeMap::<ExecutionId, u64>::new();
    for (plan, thread) in ids {
        let thread = ExecutionId::parse(&thread).map_err(|_| corrupt())?;
        let (link, _) = link_in(
            c,
            project,
            thread,
            ExecutionId::parse(&plan).map_err(|_| corrupt())?,
        )?;
        let ordinal = ordinals.entry(thread).or_default();
        *ordinal += 1;
        if link.ordinal.get() != *ordinal || !actions.insert(link.action_id) {
            return Err(corrupt());
        }
    }
    if &actions != recorded {
        return Err(corrupt());
    }
    Ok(())
}

impl ProjectStore {
    pub fn capture_conversation_proposal_work_plan(
        &self,
        proposal: &ConversationProposalRef,
        plan: WorkPlan,
    ) -> Result<PreparedConversationProposalWorkPlan, ExecutionError> {
        if self.is_reconciling() {
            return Err(fail(ErrorCode::OutcomeUnknown, "conversation-session"));
        }
        plan.validate()?;
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-work-plan"))?,
            |c| current_in(self, c, proposal, &plan),
        )?;
        Ok(PreparedConversationProposalWorkPlan {
            proposal: proposal.clone(),
            plan,
            epoch: self.changes_since(Revision::new(0)?).epoch,
        })
    }
    pub fn validate_conversation_proposal_work_plan(
        &self,
        prepared: &PreparedConversationProposalWorkPlan,
    ) -> Result<(), ExecutionError> {
        if self.is_reconciling() {
            return Err(fail(ErrorCode::OutcomeUnknown, "conversation-session"));
        }
        if self.changes_since(Revision::new(0)?).epoch != prepared.epoch {
            return Err(fail(
                ErrorCode::Unauthorized,
                "conversation-proposal-session",
            ));
        }
        read_snapshot(
            self.connection()
                .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-proposal-work-plan"))?,
            |c| current_in(self, c, &prepared.proposal, &prepared.plan),
        )
    }
    pub fn authorize_conversation_proposal_work_plan(
        &mut self,
        prepared: &PreparedConversationProposalWorkPlan,
        r: &AuthorizeConversationProposalWorkPlan,
    ) -> Result<ConversationProposalWorkPlanLink, ExecutionError> {
        let request = summary(r)?;
        let mut tx = self.execution_write_scoped(ChangeScope::Project)?;
        owned(&tx, r.proposal.project_id)?;
        if let Some(link) = original_link(&tx, r)? {
            return Ok(link);
        }
        if prepared.proposal != r.proposal
            || prepared.plan.plan_id != r.plan_id
            || prepared.plan.digest != r.plan_digest
        {
            return Err(fail(
                ErrorCode::ResultMismatch,
                "conversation-proposal-preparation",
            ));
        }
        self.validate_conversation_proposal_work_plan(prepared)?;
        check_confirmations(self, &prepared.plan, r)?;
        control::authorize_in(self, &mut tx, &prepared.plan, &inner(r))?;
        let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM application_conversation_work_plans WHERE conversation_id=?1",[r.proposal.conversation_id.to_string()],|row|row.get(0)).map_err(sql)?;
        let link = ConversationProposalWorkPlanLink {
            project_id: r.proposal.project_id,
            conversation_id: r.proposal.conversation_id,
            proposal_id: r.proposal.proposal_id,
            revision_id: r.proposal.revision_id,
            plan_id: r.plan_id,
            action_id: r.action_id,
            plan_digest: r.plan_digest.clone(),
            ordinal: Revision::new(u64::try_from(ordinal).map_err(|_| corrupt())?)?,
        };
        let bytes = codec::encode(r, MAX_INPUT_BYTES)?;
        let record_bytes = codec::encode(&link, 4096)?;
        tx.execute(
            "INSERT INTO application_conversation_work_plans VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                link.plan_id.to_string(),
                link.action_id.to_string(),
                link.revision_id.to_string(),
                link.conversation_id.to_string(),
                ordinal,
                bytes,
                codec::digest(&bytes),
                record_bytes,
                codec::digest(&record_bytes)
            ],
        )
        .map_err(sql)?;
        record(
            &tx,
            &request,
            &Receipt::ProposalWorkPlan {
                receipt: link.clone(),
            },
        )?;
        ledger::commit(tx)?;
        Ok(link)
    }
    pub fn conversation_proposal_work_plan_receipt(
        &self,
        r: &AuthorizeConversationProposalWorkPlan,
    ) -> Result<Option<ConversationProposalWorkPlanLink>, ExecutionError> {
        read_snapshot(
            self.connection().map_err(|_| {
                fail(
                    ErrorCode::StorageFailed,
                    "conversation-proposal-work-plan-read",
                )
            })?,
            |c| {
                owned(c, r.proposal.project_id)?;
                original_link(c, r)
            },
        )
    }
    pub fn recover_conversation_proposal_work_plan(
        &self,
        r: &AuthorizeConversationProposalWorkPlan,
    ) -> Result<ConversationProposalWorkPlanRecovery, ExecutionError> {
        let receipt = match self.conversation_proposal_work_plan_receipt(r) {
            Err(error)
                if error.code == ErrorCode::ResultMismatch
                    && error.stage == "conversation-action" =>
            {
                return Ok(ConversationProposalWorkPlanRecovery {
                    request: r.clone(),
                    outcome: ConversationActionOutcome::Mismatch {},
                });
            }
            value => value?,
        };
        // Missing receipts still require a well-formed original confirmation;
        // no unrecorded request can recreate its lost opaque preparation.
        if receipt.is_none() {
            if !r.confirmed
                || r.expires_at.get() == 0
                || r.expires_at.get() > i64::MAX as u64
                || tsumugi_plugin_sdk::validate_package_digest(&r.plan_digest).is_err()
                || r.effects
                    .iter()
                    .enumerate()
                    .any(|(index, effect)| r.effects[..index].contains(effect))
                || r.checker_executions
                    .iter()
                    .enumerate()
                    .any(|(index, checker)| r.checker_executions[..index].contains(checker))
                || r.application_tool_executions
                    .iter()
                    .enumerate()
                    .any(|(index, basis)| {
                        r.application_tool_executions[..index]
                            .iter()
                            .any(|prior| prior.instance_id == basis.instance_id)
                    })
            {
                return Err(fail(
                    ErrorCode::InvalidInput,
                    "conversation-proposal-confirmation",
                ));
            }
            read_snapshot(
                self.connection().map_err(|_| {
                    fail(
                        ErrorCode::StorageFailed,
                        "conversation-proposal-work-plan-read",
                    )
                })?,
                |c| {
                    revision_in(
                        c,
                        r.proposal.project_id,
                        r.proposal.conversation_id,
                        r.proposal.proposal_id,
                        r.proposal.revision_id,
                    )?;
                    Ok(())
                },
            )?;
        }
        if self.is_reconciling() {
            self.reconcile_execution()?;
        }
        Ok(ConversationProposalWorkPlanRecovery {
            request: r.clone(),
            outcome: match receipt {
                Some(receipt) => ConversationActionOutcome::Recorded { receipt },
                None => ConversationActionOutcome::Pending {
                    replay: ConversationActionReplay::Blocked,
                },
            },
        })
    }
    pub fn read_conversation_proposal_work_plan(
        &self,
        project: ExecutionId,
        thread: ExecutionId,
        plan: ExecutionId,
    ) -> Result<ConversationProposalWorkPlanLink, ExecutionError> {
        read_snapshot(
            self.connection().map_err(|_| {
                fail(
                    ErrorCode::StorageFailed,
                    "conversation-proposal-work-plan-read",
                )
            })?,
            |c| link_in(c, project, thread, plan).map(|v| v.0),
        )
    }
    pub fn read_conversation_proposal_work_plans(
        &self,
        project: ExecutionId,
        thread: ExecutionId,
        after: Option<Revision>,
        limit: u32,
    ) -> Result<ConversationProposalWorkPlanPage, ExecutionError> {
        page_limit(limit)?;
        let after = i64::try_from(after.map_or(0, |v| v.get()))
            .map_err(|_| fail(ErrorCode::InvalidInput, "conversation-page"))?;
        read_snapshot(
            self.connection().map_err(|_| {
                fail(
                    ErrorCode::StorageFailed,
                    "conversation-proposal-work-plan-read",
                )
            })?,
            |c| {
                owned(c, project)?;
                conversation(c, project, thread)?;
                let ids=c.prepare("SELECT plan_id FROM application_conversation_work_plans WHERE conversation_id=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3").map_err(sql)?.query_map(params![thread.to_string(),after,limit+1],|r|r.get::<_,String>(0)).map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?;
                let mut page = ConversationProposalWorkPlanPage {
                    project_id: project,
                    conversation_id: thread,
                    rows: vec![],
                    next_after: None,
                };
                for (index, id) in ids.iter().take(limit as usize).enumerate() {
                    page.rows.push(
                        link_in(
                            c,
                            project,
                            thread,
                            ExecutionId::parse(id).map_err(|_| corrupt())?,
                        )?
                        .0,
                    );
                    page.next_after = if ids.len() > index + 1 {
                        page.rows.last().map(|v| v.ordinal)
                    } else {
                        None
                    };
                }
                codec::encode(&page, MAX_CONVERSATION_PAGE_BYTES)?;
                Ok(page)
            },
        )
    }
    pub fn is_conversation_proposal_work_plan(
        &self,
        project: ExecutionId,
        plan: ExecutionId,
    ) -> Result<bool, ExecutionError> {
        read_snapshot(
            self.connection().map_err(|_| {
                fail(
                    ErrorCode::StorageFailed,
                    "conversation-proposal-work-plan-read",
                )
            })?,
            |c| {
                owned(c, project)?;
                let thread:Option<String>=c.query_row("SELECT conversation_id FROM application_conversation_work_plans WHERE plan_id=?1",[plan.to_string()],|row|row.get(0)).optional().map_err(sql)?;
                match thread {
                    Some(thread) => {
                        link_in(
                            c,
                            project,
                            ExecutionId::parse(&thread).map_err(|_| corrupt())?,
                            plan,
                        )?;
                        Ok(true)
                    }
                    None => Ok(false),
                }
            },
        )
    }
}

#[cfg(test)]
mod tests;
