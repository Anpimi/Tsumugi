use super::*;
use crate::persistence::application::conversations::proposals::tests::completed_profile;
use crate::persistence::application::tests::fixture;
use crate::{ContextResourceAction, ContextResourceKind, SaveContextResource};

fn proposal(
    store: &mut ProjectStore,
    units: &[ExecutionId],
    questions: Vec<String>,
) -> ConversationProposalRef {
    let output = ConversationPlanningModelOutput::KnowledgeProposal {
        summary: "Synthetic knowledge suggestions".into(),
        questions,
        entries: [
            ContextResourceKind::Character,
            ContextResourceKind::Style,
            ContextResourceKind::Background,
        ]
        .into_iter()
        .map(|kind| ConversationKnowledgeEntry {
            kind,
            name: "Synthetic material".into(),
            text: "Original suggested material".into(),
            unit_ids: vec![units[0]],
        })
        .collect(),
    };
    let request = completed_profile(
        store,
        units,
        output,
        true,
        Some(ConversationPlanningPurpose::Knowledge),
    );
    let revision = store.capture_conversation_proposal(&request).unwrap();
    ConversationProposalRef {
        project_id: revision.project_id,
        conversation_id: revision.conversation_id,
        proposal_id: revision.proposal_id,
        revision_id: revision.revision_id,
    }
}
fn prepare(
    store: &ProjectStore,
    p: &ConversationProposalRef,
    index: u32,
    unit: ExecutionId,
) -> ConversationKnowledgeAdoptionPreview {
    store
        .preview_conversation_knowledge_adoption(&PrepareConversationKnowledgeAdoption {
            proposal: p.clone(),
            entry_index: index,
            context_id: None,
            subject_id: None,
            scope: ContextResourceScope::Unit { unit_id: unit },
        })
        .unwrap()
}
fn adopt(preview: &ConversationKnowledgeAdoptionPreview) -> DecideConversationKnowledgeProposal {
    DecideConversationKnowledgeProposal {
        action_id: ExecutionId::new(),
        proposal: preview.proposal.clone(),
        entry_index: preview.entry_index,
        decision: ConversationKnowledgeDecisionKind::Adopt,
        actor: "Synthetic editor".into(),
        reason: "Compared and explicitly adopted".into(),
        adoption: Some(ConversationKnowledgeAdoption {
            context_id: preview.current.as_ref().map(|v| v.context_id),
            subject_id: preview.subject.as_ref().map(|v| v.subject_id),
            expected_revision_id: preview.current.as_ref().map(|v| v.revision_id),
            scope: preview.scope.clone(),
            source_basis: preview.source_basis.clone(),
            name: preview.entry.name.clone(),
            text: preview.entry.text.clone(),
            comparison_basis: preview.basis.clone(),
            confirm_wider_scope: false,
        }),
    }
}
fn counts(c: &Connection) -> (i64, i64, i64) {
    c.query_row("SELECT (SELECT COUNT(*) FROM context_revisions),(SELECT COUNT(*) FROM resource_changes),(SELECT COUNT(*) FROM application_conversation_actions)",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
}
fn pending(store: &ProjectStore, project: ExecutionId) -> usize {
    store
        .decision_page(
            project,
            &crate::DecisionQuery {
                locale: Some("zh-CN".into()),
                sources: vec![crate::DecisionSource::ResourceProposal],
            },
            None,
            100,
            |_| false,
        )
        .unwrap()
        .items
        .iter()
        .filter(|i| {
            matches!(
                i.action,
                crate::DecisionAction::ReviewKnowledgeProposal { .. }
            )
        })
        .count()
}

#[test]
fn knowledge_batch_adopts_all_types_without_global_material_invalidation_and_reopens_origin() {
    let (_temp, mut store, units) = fixture();
    let p = proposal(&mut store, &units[..2], vec![]);
    assert_eq!(pending(&store, p.project_id), 3);
    let mut saved = Vec::new();
    for index in 0..3 {
        let preview = prepare(&store, &p, index, units[0]);
        let mut request = adopt(&preview);
        request.adoption.as_mut().unwrap().text = format!("Human edited suggestion {index}");
        let receipt = store
            .decide_conversation_knowledge_proposal(&request)
            .unwrap();
        assert_eq!(
            store
                .decide_conversation_knowledge_proposal(&request)
                .unwrap(),
            receipt
        );
        let resource = receipt.resource.unwrap();
        assert_eq!(resource.proposal_origin.as_ref().unwrap().proposal, p);
        assert_eq!(
            resource.proposal_origin.as_ref().unwrap().entry_index,
            index
        );
        assert_eq!(resource.text, format!("Human edited suggestion {index}"));
        let causal = store
            .context_resource_action(p.project_id, request.action_id)
            .unwrap()
            .unwrap();
        assert!(matches!(
            causal.request,
            ContextResourceAction::ProposalAdoption(_)
        ));
        assert!(
            store
                .recover_context_resource_action(&causal.request)
                .is_err()
        );
        saved.push((request, resource));
    }
    assert_eq!(pending(&store, p.project_id), 0);
    let first = &saved[0].1;
    let edited = store
        .save_context_resource(&SaveContextResource {
            project_id: p.project_id,
            action_id: ExecutionId::new(),
            context_id: Some(first.context_id),
            subject_id: None,
            expected_revision_id: Some(first.revision_id),
            source_basis: store.content_scope().unwrap(),
            kind: first.kind,
            locale: first.locale.clone(),
            scope: first.scope.clone(),
            name: first.name.clone(),
            text: "Later manual correction".into(),
            actor: "Synthetic editor".into(),
            reason: "Manual follow-up".into(),
        })
        .unwrap();
    assert_eq!(edited.proposal_origin, first.proposal_origin);
    let path = store.directory().to_path_buf();
    drop(store);
    let reopened = ProjectStore::open(path).unwrap();
    for (r, v) in saved {
        assert_eq!(
            reopened
                .conversation_knowledge_decision_receipt(&r)
                .unwrap()
                .unwrap()
                .resource,
            Some(v)
        );
    }
    assert_eq!(
        reopened
            .current_context_resource(p.project_id, edited.context_id)
            .unwrap(),
        Some(edited)
    );
}

#[test]
fn keep_reject_and_explicit_recovery_preserve_resources_and_single_entry_decisions() {
    let (_temp, mut store, units) = fixture();
    let p = proposal(&mut store, &units[..1], vec![]);
    for (index, kind) in [
        (0, ConversationKnowledgeDecisionKind::Keep),
        (1, ConversationKnowledgeDecisionKind::Reject),
    ] {
        let before = counts(store.connection().unwrap());
        let request = DecideConversationKnowledgeProposal {
            action_id: ExecutionId::new(),
            proposal: p.clone(),
            entry_index: index,
            decision: kind,
            actor: "Synthetic editor".into(),
            reason: "Explicit review decision".into(),
            adoption: None,
        };
        let saved = store
            .decide_conversation_knowledge_proposal(&request)
            .unwrap();
        assert!(saved.resource.is_none());
        assert_eq!(saved.actor, request.actor);
        assert_eq!(saved.reason, request.reason);
        assert_eq!(
            counts(store.connection().unwrap()),
            (before.0, before.1, before.2 + 1)
        );
        store
            .execution_unknown
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(
            store
                .conversation_knowledge_decision_receipt(&request)
                .unwrap(),
            Some(saved.clone())
        );
        assert!(store.is_reconciling());
        assert!(matches!(
            store
                .recover_conversation_knowledge_decision(&request)
                .unwrap()
                .outcome,
            ConversationActionOutcome::Recorded { .. }
        ));
        assert!(!store.is_reconciling());
        let mut duplicate = request.clone();
        duplicate.action_id = ExecutionId::new();
        assert_eq!(
            store
                .decide_conversation_knowledge_proposal(&duplicate)
                .unwrap_err()
                .code,
            ErrorCode::DependencyConflict
        );
        duplicate.action_id = request.action_id;
        duplicate.reason = "Changed replay".into();
        assert_eq!(
            store
                .decide_conversation_knowledge_proposal(&duplicate)
                .unwrap_err()
                .code,
            ErrorCode::ResultMismatch
        );
    }
}

#[test]
fn scoped_subject_variants_do_not_overwrite_the_parent_and_existing_targets_use_exact_cas() {
    let (_temp, mut store, units) = fixture();
    let p = proposal(&mut store, &units[..1], vec![]);
    let manual = SaveContextResource {
        project_id: p.project_id,
        action_id: ExecutionId::new(),
        context_id: None,
        subject_id: None,
        expected_revision_id: None,
        source_basis: store.content_scope().unwrap(),
        kind: ContextResourceKind::Character,
        locale: "zh-CN".into(),
        scope: ContextResourceScope::Project,
        name: "Existing character".into(),
        text: "Existing human material".into(),
        actor: "Synthetic editor".into(),
        reason: "Original setting".into(),
    };
    let root = store.save_context_resource(&manual).unwrap();
    let preview = store
        .preview_conversation_knowledge_adoption(&PrepareConversationKnowledgeAdoption {
            proposal: p.clone(),
            entry_index: 0,
            context_id: None,
            subject_id: Some(root.subject_id),
            scope: ContextResourceScope::Unit { unit_id: units[0] },
        })
        .unwrap();
    let later = store
        .save_context_resource(&SaveContextResource {
            action_id: ExecutionId::new(),
            context_id: Some(root.context_id),
            expected_revision_id: Some(root.revision_id),
            text: "Newer human material".into(),
            ..manual.clone()
        })
        .unwrap();
    let child = store
        .decide_conversation_knowledge_proposal(&adopt(&preview))
        .unwrap()
        .resource
        .unwrap();
    assert_ne!(child.context_id, root.context_id);
    assert_eq!(child.subject_id, root.subject_id);
    assert_eq!(
        store
            .current_context_resource(p.project_id, root.context_id)
            .unwrap(),
        Some(later.clone())
    );
    let other = proposal(&mut store, &units[..1], vec![]);
    let preview = store
        .preview_conversation_knowledge_adoption(&PrepareConversationKnowledgeAdoption {
            proposal: other.clone(),
            entry_index: 0,
            context_id: Some(root.context_id),
            subject_id: None,
            scope: ContextResourceScope::Unit { unit_id: units[0] },
        })
        .unwrap();
    let newest = store
        .save_context_resource(&SaveContextResource {
            action_id: ExecutionId::new(),
            context_id: Some(root.context_id),
            expected_revision_id: Some(later.revision_id),
            text: "Human input B".into(),
            ..manual
        })
        .unwrap();
    let request = adopt(&preview);
    assert_eq!(
        store
            .decide_conversation_knowledge_proposal(&request)
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    assert!(
        store
            .conversation_knowledge_decision_receipt(&request)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .current_context_resource(p.project_id, root.context_id)
            .unwrap(),
        Some(newest)
    );
}

#[test]
fn adoption_requires_wider_confirmation_and_rolls_back_with_the_outer_action() {
    let (_temp, mut store, units) = fixture();
    let p = proposal(&mut store, &units[..1], vec![]);
    let preview = store
        .preview_conversation_knowledge_adoption(&PrepareConversationKnowledgeAdoption {
            proposal: p.clone(),
            entry_index: 0,
            context_id: None,
            subject_id: None,
            scope: ContextResourceScope::Project,
        })
        .unwrap();
    assert!(preview.requires_wider_confirmation);
    let mut request = adopt(&preview);
    assert_eq!(
        store
            .decide_conversation_knowledge_proposal(&request)
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    request.adoption.as_mut().unwrap().confirm_wider_scope = true;
    let before = counts(store.connection().unwrap());
    store.connection().unwrap().execute_batch("CREATE TRIGGER reject_knowledge_decision BEFORE INSERT ON application_conversation_actions BEGIN SELECT RAISE(ABORT,'synthetic decision failure'); END;").unwrap();
    assert!(
        store
            .decide_conversation_knowledge_proposal(&request)
            .is_err()
    );
    assert_eq!(counts(store.connection().unwrap()), before);
    assert!(
        store
            .conversation_knowledge_decision_receipt(&request)
            .unwrap()
            .is_none()
    );
    store
        .connection()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_knowledge_decision")
        .unwrap();
    let saved = store
        .decide_conversation_knowledge_proposal(&request)
        .unwrap();
    let scopes = store.changes_since(Revision::new(0).unwrap()).scopes;
    assert!(scopes.contains(&ChangeScope::Project) && scopes.contains(&ChangeScope::Resources));
    assert!(matches!(
        saved.resource.unwrap().scope,
        ContextResourceScope::Project
    ));
}

#[test]
fn questions_need_a_real_revision_and_stale_source_only_blocks_adoption() {
    let (_temp, mut store, units) = fixture();
    let p = proposal(
        &mut store,
        &units[..1],
        vec!["Which setting is intended?".into()],
    );
    assert_eq!(
        store
            .preview_conversation_knowledge_adoption(&PrepareConversationKnowledgeAdoption {
                proposal: p.clone(),
                entry_index: 0,
                context_id: None,
                subject_id: None,
                scope: ContextResourceScope::Unit { unit_id: units[0] }
            })
            .unwrap_err()
            .code,
        ErrorCode::Unauthorized
    );
    store
        .append_project_conversation_message(&AppendProjectConversationMessage {
            project_id: p.project_id,
            conversation_id: p.conversation_id,
            action_id: ExecutionId::new(),
            message_id: ExecutionId::new(),
            body: "An ordinary answer is not a proposal revision".into(),
        })
        .unwrap();
    let mut prior = store
        .read_conversation_proposal(
            p.project_id,
            p.conversation_id,
            p.proposal_id,
            Some(p.revision_id),
        )
        .unwrap();
    if let ConversationPlanningModelOutput::KnowledgeProposal { questions, .. } = &mut prior.content
    {
        questions.clear();
    }
    let revised = store
        .revise_conversation_proposal(&ReviseConversationProposal {
            project_id: p.project_id,
            conversation_id: p.conversation_id,
            action_id: ExecutionId::new(),
            proposal_id: p.proposal_id,
            revision_id: ExecutionId::new(),
            expected_revision_id: p.revision_id,
            content: prior.content,
        })
        .unwrap();
    let latest = ConversationProposalRef {
        revision_id: revised.revision_id,
        ..p.clone()
    };
    let prepared = prepare(&store, &latest, 0, units[0]);
    crate::persistence::review::tests::adopt_source(&mut store, br#"{"replacement":"New source"}"#);
    assert_eq!(
        store
            .decide_conversation_knowledge_proposal(&adopt(&prepared))
            .unwrap_err()
            .code,
        ErrorCode::DependencyConflict
    );
    let keep = DecideConversationKnowledgeProposal {
        action_id: ExecutionId::new(),
        proposal: latest,
        entry_index: 0,
        decision: ConversationKnowledgeDecisionKind::Keep,
        actor: "Synthetic editor".into(),
        reason: "Keep after source changed".into(),
        adoption: None,
    };
    assert!(
        store
            .decide_conversation_knowledge_proposal(&keep)
            .unwrap()
            .resource
            .is_none()
    );
    assert!(
        store
            .read_conversation_proposal(
                p.project_id,
                p.conversation_id,
                p.proposal_id,
                Some(p.revision_id)
            )
            .is_ok()
    );
}

#[test]
fn schema_66_upgrade_keeps_the_exact_old_profile_and_original_proposal_bytes() {
    let (_temp, mut store, units) = fixture();
    let request = super::super::tests::completed(
        &mut store,
        &units[..1],
        super::super::tests::model(units[0]),
        true,
    );
    let proposal = store.capture_conversation_proposal(&request).unwrap();
    let input = store.execution_input(request.attempt_id).unwrap();
    let bytes = input.bytes().to_vec();
    let path = store.directory().to_path_buf();
    drop(store);
    let c = Connection::open(path.join(crate::persistence::DATABASE_FILENAME)).unwrap();
    crate::persistence::translation::make_legacy_memory_schema(&c).unwrap();
    c.pragma_update(None, "user_version", 66).unwrap();
    drop(c);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened
            .execution_input(request.attempt_id)
            .unwrap()
            .bytes(),
        bytes
    );
    assert_eq!(
        reopened
            .read_conversation_proposal(
                request.project_id,
                request.conversation_id,
                request.proposal_id,
                Some(request.revision_id)
            )
            .unwrap(),
        proposal
    );
    assert_eq!(
        reopened
            .connection()
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        67
    );
}
