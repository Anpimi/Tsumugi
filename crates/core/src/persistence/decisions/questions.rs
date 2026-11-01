//! Clarification groups remain in the original immutable proposal history.
//! Team discussions and ordinary human messages are not answers to these groups.
use super::*;
use crate::ai::conversation_planning::ConversationPlanningModelOutput;

#[derive(Debug, Eq, PartialEq)]
struct ProposalHead {
    conversation_id: ExecutionId,
    proposal_id: ExecutionId,
    revision_id: ExecutionId,
}

fn identity(raw: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&raw)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "decision-question-identity"))
}

/// Bound inspected proposal heads, including heads whose questions are empty.
fn heads_in(c: &Connection) -> Result<(Vec<ProposalHead>, bool), ExecutionError> {
    let mut statement = c.prepare(
        "SELECT p.conversation_id,p.proposal_id,p.revision_id
         FROM application_conversation_proposals p
         WHERE NOT EXISTS (
             SELECT 1 FROM application_conversation_proposals newer
             WHERE newer.proposal_id=p.proposal_id AND newer.revision>p.revision
         )
         ORDER BY p.proposal_id LIMIT ?1",
    ).map_err(super::super::ledger::sql_error)?;
    let mut heads = statement.query_map([(SOURCE_LIMIT + 1) as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
    }).map_err(super::super::ledger::sql_error)?
        .map(|row| {
            let (conversation, proposal, revision) = row.map_err(super::super::ledger::sql_error)?;
            Ok(ProposalHead { conversation_id: identity(conversation)?,
                proposal_id: identity(proposal)?, revision_id: identity(revision)? })
        }).collect::<Result<Vec<_>, ExecutionError>>()?;
    let complete = heads.len() <= SOURCE_LIMIT;
    heads.truncate(SOURCE_LIMIT);
    Ok((heads, complete))
}

pub(super) fn project(
    store: &ProjectStore,
    c: &Connection,
    project: ExecutionId,
) -> Result<SourceProjection, ExecutionError> {
    let (heads, complete) = heads_in(c)?;
    let changes = store.changes_since(Revision::new(0)?);
    let mut items = Vec::new();
    for head in heads {
        // Read even empty heads through the owner: a damaged record must not
        // turn into a successful observation of zero outstanding questions.
        let revision = store.read_conversation_proposal(project, head.conversation_id,
            head.proposal_id, Some(head.revision_id))?;
        let questions=match &revision.content {
            ConversationPlanningModelOutput::Proposal{questions,..}|ConversationPlanningModelOutput::TermProposal { questions, .. } | ConversationPlanningModelOutput::KnowledgeProposal{questions,..}=>questions,
            _=>return Err(failure(ErrorCode::CorruptLedger,"decision-question-content")),
        };
        if questions.is_empty() { continue; }
        let (state, currentness) = match store.validate_conversation_proposal(project,
            head.conversation_id, head.proposal_id, head.revision_id) {
            Ok(current) if current == revision => (DecisionState::Pending, None),
            Ok(_) => return Err(failure(ErrorCode::CorruptLedger, "decision-question-current")),
            Err(error) if error.code == ErrorCode::DependencyConflict => (DecisionState::Stale, Some(error)),
            Err(error) => return Err(error),
        };
        // The owner verified the immutable revision and provenance. Referencing
        // that identity keeps large legal text out of the observation envelope.
        // Current materials and authority remain separate observations.
        let basis = codec::digest(&codec::encode(&(project, head.proposal_id, head.revision_id, &revision.origin, state,
            currentness, &changes.epoch, changes.sequence), crate::execution::MAX_INPUT_BYTES)?);
        items.push(DecisionItem {
            decision_id: format!("agent-question:proposal:{}", head.proposal_id),
            source: DecisionSource::AgentQuestion,
            state,
            locale: None,
            targets: vec![DecisionTarget::Conversation { conversation_id: head.conversation_id },
                DecisionTarget::ConversationProposal { conversation_id: head.conversation_id,
                    proposal_id: head.proposal_id }],
            targets_complete: true,
            basis,
            source_action_id: None,
            action: DecisionAction::ClarifyConversationProposal { conversation_id: head.conversation_id,
                proposal_id: head.proposal_id, revision_id: head.revision_id },
            evidence: Some(DecisionEvidence::ProposalQuestions { question_count: questions.len() as u32 }),
        });
    }
    Ok(SourceProjection { items, complete })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        application::*,
        ai::{AiConfig, conversation_planning},
        execution::{Cancellation, DispatchRequest, ExecutionRuntime, ExecutionState, FixedResult,
            ResultEnvelope, ResultSender, Runner},
        persistence::review::tests::{fixture, translate},
    };
    use rusqlite::params;
    use std::sync::Arc;

    struct NeverRun;
    impl Runner for NeverRun {
        fn capability_id(&self) -> &str { conversation_planning::CAPABILITY }
        fn capability_version(&self) -> &str { "1" }
        fn run(&self, _: DispatchRequest, _: Cancellation, _: ResultSender) -> Result<(), ExecutionError> {
            panic!("question fixture must not dispatch a producer")
        }
    }

    fn capture(store: &mut ProjectStore, project: ExecutionId, unit: ExecutionId,
        questions: &[&str]) -> CaptureConversationProposal {
        let conversation = ExecutionId::new();
        store.create_project_conversation(&CreateProjectConversation { project_id: project,
            action_id: ExecutionId::new(), conversation_id: conversation, title: None }).unwrap();
        let message = store.append_project_conversation_message(&AppendProjectConversationMessage {
            project_id: project, action_id: ExecutionId::new(), conversation_id: conversation,
            message_id: ExecutionId::new(), body: "Please prepare a translation proposal.".into(),
        }).unwrap();
        let capture = store.prepare_conversation_planning(&PrepareConversationPlanning {
            purpose: None,
            project_id: project, conversation_id: conversation, selected_message_ids: vec![message.message_id],
            scope: ConversationPlanningScope::Units { locale: "zh-CN".into(), unit_ids: vec![unit] },
            config: AiConfig { endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
                model: "synthetic-model".into(), credential_env: String::new(), share_context: true,
                max_requests: 1, max_retries: 0, concurrency: 1, ..AiConfig::default() },
        }).unwrap();
        let attempt = ExecutionId::new();
        let prepared = store.authorize_conversation_planning(&capture, &ConversationPlanningConsent {
            action_id: attempt, task_id: ExecutionId::new(), attempt_id: attempt,
            preview_digest: capture.preview_digest().unwrap(),
            expires_at_ms: (crate::execution::plugin_authority::plugin_now_ms().unwrap() + 30_000).into(),
            share_messages: true, share_units: true,
        }).unwrap();
        let mut runtime = ExecutionRuntime::new(store).unwrap();
        runtime.register(Arc::new(NeverRun)).unwrap();
        runtime.submit_conversation_planning(store, &prepared).unwrap();
        let dispatch = store.dispatch_execution_item(attempt, attempt).unwrap();
        let model = ConversationPlanningModelOutput::Proposal { summary: "Translate this entry.".into(),
            unit_ids: vec![unit], options: PlanOptions::default(),
            questions: questions.iter().map(|question| (*question).to_owned()).collect() };
        let result = FixedResult::capture(ResultEnvelope { project_id: project, attempt_id: attempt,
            item_id: attempt, result_id: ExecutionId::new(), supersedes: None,
            dispatch_token: dispatch.dispatch_token, capability_id: conversation_planning::CAPABILITY.into(),
            capability_version: "1".into(), plugin: None, outcome: ExecutionState::Succeeded,
            output: Some(serde_json::json!({"model":model,"usage":null,"requests":1,"usageIncomplete":true})),
            diagnostic: None,
        }, prepared.input(), dispatch.dispatch_token).unwrap();
        store.save_execution_result(&result).unwrap();
        store.validate_execution_result(attempt, result.envelope().result_id).unwrap();
        let request = CaptureConversationProposal { project_id: project, action_id: ExecutionId::new(),
            conversation_id: conversation, proposal_id: ExecutionId::new(), revision_id: ExecutionId::new(),
            attempt_id: attempt, result_id: result.envelope().result_id };
        store.capture_conversation_proposal(&request).unwrap();
        request
    }

    fn read(store: &ProjectStore, project: ExecutionId) -> Result<SourceProjection, ExecutionError> {
        review::read_snapshot(store.connection().unwrap(), |c| super::project(store, c, project))
    }

    fn page(store: &ProjectStore, project: ExecutionId, cursor: Option<&DecisionCursor>) -> Result<DecisionPage, ExecutionError> {
        store.decision_page(project, &DecisionQuery { locale: None,
            sources: vec![DecisionSource::AgentQuestion] }, cursor, 1, |_| false)
    }

    #[test]
    fn large_legal_question_groups_remain_readable_without_truncation() {
        let (_directory, mut store, project, units) = fixture();
        let question = "\\\"".repeat(1024);
        let request = capture(&mut store, project, units[0], &[question.as_str(); 7]);
        let original = store.read_conversation_proposal(project, request.conversation_id,
            request.proposal_id, Some(request.revision_id)).unwrap();
        assert!(matches!(original.content, ConversationPlanningModelOutput::Proposal { questions, .. }
            if questions == vec![question; 7]));
        let projection = read(&store, project).unwrap();
        assert_eq!(projection.items.len(), 1);
        assert_eq!(projection.items[0].evidence, Some(DecisionEvidence::ProposalQuestions { question_count: 7 }));
    }

    #[test]
    fn a_group_keeps_its_identity_until_the_latest_original_revision_has_no_questions() {
        let (_directory, mut store, project, units) = fixture();
        let request = capture(&mut store, project, units[0], &["Which audience?", "Which tone?"]);
        let first = read(&store, project).unwrap();
        assert!(first.complete);
        assert_eq!(first.items.len(), 1);
        let first = &first.items[0];
        assert_eq!(first.decision_id, format!("agent-question:proposal:{}", request.proposal_id));
        assert_eq!(first.state, DecisionState::Pending);
        assert_eq!(first.locale, None);
        assert_eq!(first.source_action_id, None);
        assert_eq!(first.evidence, Some(DecisionEvidence::ProposalQuestions { question_count: 2 }));
        assert!(first.targets.contains(&DecisionTarget::ConversationProposal {
            conversation_id: request.conversation_id, proposal_id: request.proposal_id }));
        assert_eq!(first.action, DecisionAction::ClarifyConversationProposal {
            conversation_id: request.conversation_id, proposal_id: request.proposal_id, revision_id: request.revision_id });
        store.append_project_conversation_message(&AppendProjectConversationMessage {
            project_id: project, action_id: ExecutionId::new(), conversation_id: request.conversation_id,
            message_id: ExecutionId::new(), body: "Another message, without an exact question reference.".into(),
        }).unwrap();
        let after_message = read(&store, project).unwrap();
        assert_eq!(after_message.items.len(), 1);
        assert_eq!(after_message.items[0].decision_id, first.decision_id);
        assert_eq!(after_message.items[0].evidence, first.evidence);
        let mut content = store.read_conversation_proposal(project, request.conversation_id,
            request.proposal_id, Some(request.revision_id)).unwrap().content;
        if let ConversationPlanningModelOutput::Proposal { questions, .. } = &mut content {
            *questions = vec!["A revised question with different meaning.".into()];
        }
        let edit = ReviseConversationProposal { project_id: project, action_id: ExecutionId::new(),
            conversation_id: request.conversation_id, proposal_id: request.proposal_id,
            revision_id: ExecutionId::new(), expected_revision_id: request.revision_id, content };
        let revised = store.revise_conversation_proposal(&edit).unwrap();
        let second = read(&store, project).unwrap();
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].decision_id, first.decision_id);
        assert_ne!(second.items[0].basis, first.basis);
        assert_eq!(second.items[0].evidence, Some(DecisionEvidence::ProposalQuestions { question_count: 1 }));
        let mut content = revised.content;
        if let ConversationPlanningModelOutput::Proposal { questions, .. } = &mut content { questions.clear(); }
        store.revise_conversation_proposal(&ReviseConversationProposal { action_id: ExecutionId::new(),
            revision_id: ExecutionId::new(), expected_revision_id: revised.revision_id, content, ..edit }).unwrap();
        assert!(read(&store, project).unwrap().items.is_empty());
        let historical = store.read_conversation_proposal(project, request.conversation_id,
            request.proposal_id, Some(request.revision_id)).unwrap();
        assert!(matches!(historical.content, ConversationPlanningModelOutput::Proposal { questions, .. } if questions.len() == 2));
    }

    #[test]
    fn changed_original_material_keeps_questions_visible_as_stale() {
        let (_directory, mut store, project, units) = fixture();
        capture(&mut store, project, units[0], &["Which audience?"]);
        let first = read(&store, project).unwrap();
        translate(&mut store, project, units[0], "zh-CN", "A newer human translation");
        let current = read(&store, project).unwrap();
        assert_eq!(current.items.len(), 1);
        assert_eq!(current.items[0].state, DecisionState::Stale);
        assert_eq!(current.items[0].decision_id, first.items[0].decision_id);
        assert_ne!(current.items[0].basis, first.items[0].basis);
    }

    #[test]
    fn repeated_reads_and_reopen_preserve_original_facts_without_creating_authority() {
        let (directory, mut store, project, units) = fixture();
        let request = capture(&mut store, project, units[0], &["Which audience?"]);
        let before = store.connection().unwrap().total_changes();
        let changes = store.changes_since(Revision::new(0).unwrap());
        let first = read(&store, project).unwrap();
        assert_eq!(read(&store, project).unwrap().items, first.items);
        assert_eq!(store.connection().unwrap().total_changes(), before);
        let after = store.changes_since(Revision::new(0).unwrap());
        assert_eq!((after.epoch, after.sequence, after.progress_sequence),
            (changes.epoch, changes.sequence, changes.progress_sequence));
        assert!(!store.is_reconciling());
        let original = store.read_conversation_proposal(project, request.conversation_id,
            request.proposal_id, None).unwrap();
        drop(store);
        let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
        let current = read(&reopened, project).unwrap();
        assert_eq!(current.items.len(), 1);
        assert_eq!(current.items[0].decision_id, first.items[0].decision_id);
        assert_eq!(reopened.read_conversation_proposal(project, request.conversation_id,
            request.proposal_id, None).unwrap(), original);
        assert!(!reopened.is_reconciling());
    }

    #[test]
    fn pagination_retains_complete_source_coverage_and_rejects_an_old_revision_cursor() {
        let (_directory, mut store, project, units) = fixture();
        let first_request = capture(&mut store, project, units[0], &["Which audience?"]);
        capture(&mut store, project, units[1], &["Which tone?"]);
        let first = page(&store, project, None).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.known_count, 2);
        assert_eq!(first.total, Some(2));
        assert_eq!(first.coverage[0].state, DecisionCoverageState::Complete);
        assert_eq!(first.coverage[0].reason, None);
        let cursor = first.next.as_ref().unwrap();
        let second = page(&store, project, Some(cursor)).unwrap();
        assert_eq!(second.items.len(), 1);
        assert_ne!(second.items[0].decision_id, first.items[0].decision_id);
        assert!(second.next.is_none());
        let mut content = store.read_conversation_proposal(project, first_request.conversation_id,
            first_request.proposal_id, None).unwrap().content;
        if let ConversationPlanningModelOutput::Proposal { questions, .. } = &mut content { questions.clear(); }
        store.revise_conversation_proposal(&ReviseConversationProposal { project_id: project,
            action_id: ExecutionId::new(), conversation_id: first_request.conversation_id,
            proposal_id: first_request.proposal_id, revision_id: ExecutionId::new(),
            expected_revision_id: first_request.revision_id, content }).unwrap();
        assert_eq!(page(&store, project, Some(cursor)).unwrap_err().code, ErrorCode::DependencyConflict);
    }

    #[test]
    fn the_head_scan_counts_empty_heads_toward_its_bound_and_uses_the_latest_revision() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE application_conversation_proposals (
            conversation_id TEXT, proposal_id TEXT, revision_id TEXT, revision INTEGER)").unwrap();
        let conversation = ExecutionId::new();
        let first = ExecutionId::new();
        let latest = ExecutionId::new();
        c.execute("INSERT INTO application_conversation_proposals VALUES(?1,?2,?3,1)",
            params![conversation.to_string(), first.to_string(), ExecutionId::new().to_string()]).unwrap();
        c.execute("INSERT INTO application_conversation_proposals VALUES(?1,?2,?3,2)",
            params![conversation.to_string(), first.to_string(), latest.to_string()]).unwrap();
        let (heads, complete) = heads_in(&c).unwrap();
        assert!(complete);
        assert_eq!(heads, vec![ProposalHead { conversation_id: conversation, proposal_id: first, revision_id: latest }]);
        for _ in 1..SOURCE_LIMIT {
            c.execute("INSERT INTO application_conversation_proposals VALUES(?1,?2,?3,1)",
                params![conversation.to_string(), ExecutionId::new().to_string(), ExecutionId::new().to_string()]).unwrap();
        }
        let (heads, complete) = heads_in(&c).unwrap();
        assert_eq!(heads.len(), SOURCE_LIMIT);
        assert!(complete);
        c.execute("INSERT INTO application_conversation_proposals VALUES(?1,?2,?3,1)",
            params![conversation.to_string(), ExecutionId::new().to_string(), ExecutionId::new().to_string()]).unwrap();
        let (heads, complete) = heads_in(&c).unwrap();
        assert_eq!(heads.len(), SOURCE_LIMIT);
        assert!(!complete);
    }

    #[test]
    fn unreadable_original_records_are_errors_even_when_their_questions_were_empty() {
        let (_directory, mut store, project, units) = fixture();
        let request = capture(&mut store, project, units[0], &[]);
        assert!(read(&store, project).unwrap().items.is_empty());
        store.connection().unwrap().execute("UPDATE application_conversation_proposals SET digest=?1 WHERE revision_id=?2",
            params!["0".repeat(64), request.revision_id.to_string()]).unwrap();
        assert_eq!(read(&store, project).err().unwrap().code, ErrorCode::CorruptLedger);
        let page = page(&store, project, None).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total, None);
        assert_eq!(page.coverage[0].state, DecisionCoverageState::Partial);
        assert_eq!(page.coverage[0].error_code, Some(ErrorCode::CorruptLedger));
    }

    #[test]
    fn unknown_currentness_is_unavailable_and_a_read_does_not_reconcile_it() {
        let (_directory, mut store, project, units) = fixture();
        capture(&mut store, project, units[0], &["Which audience?"]);
        store.execution_unknown.store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(read(&store, project).err().unwrap().code, ErrorCode::OutcomeUnknown);
        let page = page(&store, project, None).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total, None);
        assert_eq!(page.coverage[0].state, DecisionCoverageState::Partial);
        assert_eq!(page.coverage[0].error_code, Some(ErrorCode::OutcomeUnknown));
        assert!(store.is_reconciling());
    }
}
