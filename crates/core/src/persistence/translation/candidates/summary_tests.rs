use super::*;
use crate::application::{AuthorizeWorkPlan, PlanOptions};
use crate::content::{LineageChoice, LineageDecision, SourceAdoptionHandler, SourceBundle, SourceRunner};
use crate::execution::{ExecutionRuntime, ExecutionState, ResultEnvelope};
use crate::persistence::review::tests::{fixture, translate};

fn update_source_with_continued_identity(store: &mut ProjectStore, units: &[ExecutionId]) {
    let previous = store.content_scope().unwrap().current_snapshot.unwrap();
    let bundle = SourceBundle::capture(
        br#"{"UniqueID":"Review.Test","Name":"Review","Version":"1.0.0","EntryDll":"Review.dll"}"#,
        br#"{"hello":"Hello changed {{name}}","plain":"Plain changed"}"#,
        "en",
    ).unwrap();
    let input = bundle.fixed_input(store.metadata().unwrap().project_id()).unwrap();
    let mut runtime = ExecutionRuntime::new(store).unwrap();
    runtime.register_read_only(std::sync::Arc::new(SourceRunner)).unwrap();
    runtime.submit(store, &input).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let result = loop {
        runtime.tick(store).unwrap();
        let status = store.execution_attempt(input.envelope().attempt_id, true).unwrap();
        if status.items[0].execution == ExecutionState::Succeeded {
            break store.execution_current_result(
                input.envelope().attempt_id, input.envelope().items[0].item_id,
            ).unwrap().unwrap();
        }
        assert!(std::time::Instant::now() < deadline, "source fixture did not finish");
        std::thread::sleep(std::time::Duration::from_millis(2));
    };
    let comparison = store.source_comparison(input.envelope().attempt_id, result, 0, 10).unwrap();
    assert_eq!(comparison.previous_snapshot_id, previous);
    assert_eq!(comparison.changed as usize, units.len());
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Synthetic reviewer".into());
    for row in comparison.rows {
        assert_eq!(row.kind, crate::content::SourceChangeKind::Changed);
        let old = row.old.unwrap();
        assert!(units.contains(&old.unit_id.unwrap()));
        confirmation.lineage.push(LineageChoice {
            new_ordinal: row.new.unwrap().ordinal,
            old_occurrence_id: old.occurrence_id.unwrap(),
            decision: LineageDecision::Continue,
            reason: "Confirmed the same entry with updated source wording".into(),
        });
    }
    let action = store.prepare_adoption_with_id(
        ExecutionId::new(),
        input.envelope().attempt_id,
        input.envelope().units[0].unit_id,
        vec![result],
        serde_json::to_value(confirmation).unwrap(),
    ).unwrap();
    store.adopt_execution(&action, &SourceAdoptionHandler).unwrap();
    assert_ne!(store.content_scope().unwrap().current_snapshot.unwrap(), previous);
}

pub(in crate::persistence) fn save_candidate(
    store: &mut ProjectStore,
    unit: ExecutionId,
    text: &str,
) -> ExecutionId {
    let plan = store.prepare_work_plan(
        Some(crate::ai::AiConfig {
            endpoint: "http://127.0.0.1:9/v1/chat/completions".into(),
            model: "synthetic-summary".into(),
            credential_env: String::new(),
            ..crate::ai::AiConfig::default()
        }),
        "zh-CN", &[unit], PlanOptions::default(),
    ).unwrap();
    let grant = store.authorize_work_plan(&plan, &AuthorizeWorkPlan {
        action_id: ExecutionId::new(),
        plan_digest: plan.digest.clone(),
        confirmed: true,
        effects: plan.options.authorization_effects().unwrap(),
        expires_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600,
    }).unwrap();
    let input = FixedInput::capture(grant.input.unwrap()).unwrap();
    store.enqueue_execution(&input).unwrap();
    let item = input.envelope().items[0].item_id;
    let dispatch = store.dispatch_execution_item(input.envelope().attempt_id, item).unwrap();
    let result = FixedResult::capture(ResultEnvelope {
        plugin: None,
        project_id: input.envelope().project_id,
        attempt_id: input.envelope().attempt_id,
        item_id: item,
        result_id: ExecutionId::new(),
        supersedes: None,
        dispatch_token: dispatch.dispatch_token,
        capability_id: crate::ai::CAPABILITY.into(),
        capability_version: "1".into(),
        outcome: ExecutionState::Succeeded,
        output: Some(serde_json::to_value(crate::ai::AiOutput {
            unit_id: unit,
            target_locale: "zh-CN".into(),
            text: text.into(),
            usage: None,
            requests: 1,
            usage_incomplete: true,
        }).unwrap()),
        diagnostic: None,
    }, &input, dispatch.dispatch_token).unwrap();
    store.save_execution_result(&result).unwrap();
    store.validate_execution_result(input.envelope().attempt_id, result.envelope().result_id).unwrap();
    let action = store.prepare_adoption(
        input.envelope().attempt_id,
        input.envelope().units[0].unit_id,
        vec![result.envelope().result_id],
        serde_json::Value::Null,
    ).unwrap();
    let receipt = store.adopt_execution(&action, &crate::AiAdoptionHandler).unwrap();
    ExecutionId::parse(&receipt.changes[0].id).unwrap()
}

fn decision(
    store: &ProjectStore,
    project: ExecutionId,
    unit: ExecutionId,
    revision: ExecutionId,
) -> CandidateDecisionWrite {
    let target = store.review_target(project, unit, "zh-CN").unwrap();
    CandidateDecisionWrite {
        project_id: project,
        action_id: ExecutionId::new(),
        unit_id: unit,
        locale: "zh-CN".into(),
        revision_id: revision,
        source_revision_id: target.source_revision_id,
        expected_selection_id: target.selection_id,
        expected_decision_id: None,
        disposition: CandidateDisposition::Rejected,
        actor: "Synthetic reviewer".into(),
        reason: "Does not fit this entry".into(),
    }
}

fn count(store: &ProjectStore, project: ExecutionId, units: &[ExecutionId]) -> Vec<u32> {
    let counts = summaries(store.connection().unwrap(), project, units, "zh-CN").unwrap();
    assert_eq!(counts.len(), units.len());
    units.iter().map(|unit| counts[unit].count).collect()
}

#[test]
fn candidate_slice_keeps_current_source_full_revisions_decisions_and_selected_origin() {
    let (_directory, mut store, project, units) = fixture();
    let empty = save_candidate(&mut store, units[0], "");
    let text = "Candidate {{name}}\ne\u{301} 👩🏽‍💻 日本語 العربية";
    let other = save_candidate(&mut store, units[0], text);
    translate(&mut store, project, units[0], "zh-CN", "");
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let query = crate::SegmentQuery { text: String::new(), selection: crate::SegmentSelectionFilter::All, status: crate::SegmentStatusFilter::All };
    let captured = store.read_segment_page(project,"zh-CN",&query,None,None,50).unwrap();
    let before = store.changes_since(Revision::new(0).unwrap());
    let page = store.translation_candidate_slice(project,"zh-CN",snapshot,Some(captured.scope_id),&units,TranslationCandidateState::Available,0,None).unwrap();
    assert_eq!(page.rows[0].selected_origin_kind,Some(TranslationOrigin::Manual));
    assert_eq!(page.rows[0].target.translation_text.as_deref(),Some(""));
    assert!(page.rows[0].protection.protected);
    assert_eq!(page.rows[0].candidate_count,2);
    assert_eq!(page.rows[0].revisions[0].text,"");
    assert_eq!(page.rows[0].revisions[1].text,text);
    for revision in &page.rows[0].revisions {
        assert_eq!(*revision,store.translation_revision(project,units[0],"zh-CN",revision.revision_id).unwrap());
    }
    assert_eq!(page.rows[1].selected_origin_kind,None);
    assert_eq!(page.rows[1].target.translation_text,None);
    let after = store.changes_since(Revision::new(0).unwrap());
    assert_eq!(before.epoch,after.epoch); assert_eq!(before.sequence,after.sequence);
    let rejected = decision(&store,project,units[0],empty);
    let receipt = store.decide_translation_candidate(&rejected).unwrap();
    assert!(store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,Some(&page.read_version)).is_err());
    // The original retained membership survives our own decision writes.
    let hidden = store.translation_candidate_slice(project,"zh-CN",snapshot,Some(captured.scope_id),&units,TranslationCandidateState::Rejected,0,None).unwrap();
    assert_eq!(hidden.rows[0].revisions.len(),1);
    assert_eq!(hidden.rows[0].revisions[0].candidate_decision,Some(receipt));
    let active = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).unwrap();
    assert_eq!(active.rows[0].candidate_count,1);
    assert_eq!(active.rows[0].revisions[0].revision_id,other);
    store.select_translation_revision(&SelectTranslationRevision { project_id:project,action_id:ExecutionId::new(),unit_id:units[0],locale:"zh-CN".into(),
        source_revision_id:active.rows[0].target.source_revision_id,expected_selection_id:active.rows[0].target.selection_id,revision_id:other }).unwrap();
    let selected = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).unwrap();
    assert_eq!(selected.rows[0].selected_origin_kind,Some(TranslationOrigin::Ai));
    assert_eq!(selected.rows[0].candidate_count,0);
    update_source_with_continued_identity(&mut store,&units);
    assert!(store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).is_err());
    let current = store.content_scope().unwrap().current_snapshot.unwrap();
    let changed = store.translation_candidate_slice(project,"zh-CN",current,None,&units,TranslationCandidateState::Rejected,0,None).unwrap();
    assert_eq!(changed.rows[0].candidate_count,0,"old-source AI proposals never become current-source targets");
}

#[test]
fn candidate_slice_continues_one_unit_without_expanding_or_losing_members() {
    let (_directory, mut store, project, units) = fixture();
    let ids = (0..53).map(|index| save_candidate(&mut store,units[0],&format!("Candidate {index} e\u{301} 👩🏽‍💻"))).collect::<Vec<_>>();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let first = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).unwrap();
    assert_eq!(first.rows.len(),1); assert_eq!(first.rows[0].revisions.len(),50); assert_eq!(first.rows[0].candidate_count,53);
    let next = first.next.unwrap(); assert_eq!(next.unit_offset,0);
    let second = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,next.after_ordinal.get(),Some(&first.read_version)).unwrap();
    assert!(second.next.is_none()); assert_eq!(second.rows.len(),2); assert_eq!(second.rows[0].candidate_count,53);
    assert_eq!(second.rows[1].candidate_count,0);
    let returned = first.rows[0].revisions.iter().chain(&second.rows[0].revisions).map(|revision| revision.revision_id).collect::<Vec<_>>();
    assert_eq!(returned,ids);
    let invalid = |units: &[ExecutionId]| store.translation_candidate_slice(project,"zh-CN",snapshot,None,units,TranslationCandidateState::Available,0,None);
    assert!(invalid(&[]).is_err()); assert!(invalid(&[units[0],units[0]]).is_err()); assert!(invalid(&vec![ExecutionId::new();51]).is_err());
    assert!(invalid(&[ExecutionId::new()]).is_err());
    assert!(store.translation_candidate_slice(ExecutionId::new(),"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).is_err());
    assert!(store.translation_candidate_slice(project,"ZH-cn",snapshot,None,&units,TranslationCandidateState::Available,0,None).is_err());
}

#[test]
fn candidate_slice_byte_pages_keep_whole_unicode_and_validate_original_decisions() {
    let (_directory, mut store, project, units) = fixture();
    let text = "界e\u{301}👩🏽‍💻".repeat(700);
    let ids = (0..22).map(|_| save_candidate(&mut store,units[0],&text)).collect::<Vec<_>>();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let first = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).unwrap();
    assert!(first.rows[0].revisions.len() < ids.len());
    assert!(serde_json::to_vec(&first).unwrap().len() <= crate::content::MAX_CONTENT_PAGE_BYTES);
    let next = first.next.unwrap(); assert_eq!(next.unit_offset,0);
    let second = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,next.after_ordinal.get(),Some(&first.read_version)).unwrap();
    let revisions = first.rows[0].revisions.iter().chain(&second.rows[0].revisions).collect::<Vec<_>>();
    assert_eq!(revisions.iter().map(|revision| revision.revision_id).collect::<Vec<_>>(),ids);
    assert!(revisions.iter().all(|revision| revision.text == text));
    let reject = decision(&store,project,units[0],ids[0]); store.decide_translation_candidate(&reject).unwrap();
    store.connection().unwrap().execute("UPDATE translation_candidate_decisions SET receipt_digest=?1 WHERE action_id=?2",params!["f".repeat(64),reject.action_id.to_string()]).unwrap();
    assert_eq!(store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).unwrap_err().code,ErrorCode::CorruptLedger);
}

#[test]
fn candidate_slice_rejects_nonmembers_expired_scopes_and_changed_external_snapshots() {
    let (directory,store,project,units) = fixture();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let query = crate::SegmentQuery { text:"Hello".into(),selection:crate::SegmentSelectionFilter::All,status:crate::SegmentStatusFilter::All };
    let scope = store.read_segment_page(project,"zh-CN",&query,None,None,50).unwrap();
    assert_eq!(scope.total,1);
    let member = scope.rows[0].content.unit_id;
    let nonmember = units.iter().copied().find(|unit| *unit != member).unwrap();
    assert!(store.translation_candidate_slice(project,"zh-CN",snapshot,Some(scope.scope_id),&[nonmember],TranslationCandidateState::Available,0,None).is_err());
    let read = store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,None).unwrap();
    for _ in 0..8 { store.read_segment_page(project,"zh-CN",&query,None,None,50).unwrap(); }
    assert!(store.translation_candidate_slice(project,"zh-CN",snapshot,Some(scope.scope_id),&[member],TranslationCandidateState::Available,0,None).is_err());
    let independent = Connection::open(directory.path().join("project").join(super::super::super::DATABASE_FILENAME)).unwrap();
    independent.execute("UPDATE project_metadata SET display_name='External synthetic edit' WHERE row_id=1",[]).unwrap();
    assert!(store.translation_candidate_slice(project,"zh-CN",snapshot,None,&units,TranslationCandidateState::Available,0,Some(&read.read_version)).is_err());
}

#[test]
fn ai_pending_counts_only_unselected_non_rejected_ai_and_preserves_human_protection() {
    use crate::{SegmentQuery, SegmentSelectionFilter, SegmentStatusFilter, SelectTranslationRevision};
    let (directory, mut store, project, units) = fixture();
    let query = SegmentQuery { text: String::new(), selection: SegmentSelectionFilter::All,
        status: SegmentStatusFilter::AiPending };
    let pending = |store: &ProjectStore| store.read_segment_page(project, "zh-CN", &query, None, None, 100).unwrap();
    translate(&mut store, project, units[0], "zh-CN", "Manual first");
    translate(&mut store, project, units[0], "zh-CN", "Manual current");
    assert_eq!(count(&store, project, &units), vec![1, 0]);
    assert_eq!(pending(&store).total, 0, "manual history is not an AI proposal");
    let revision = save_candidate(&mut store, units[0], "");
    let page = pending(&store);
    assert_eq!(page.total, 1, "empty AI text remains a saved candidate");
    assert_eq!(page.rows[0].content.unit_id, units[0]);
    assert_eq!(page.rows[0].candidate_count, 2);
    assert_eq!(page.rows[0].ai_candidate_count, 1);
    assert!(page.rows[0].protection.protected, "querying never removes human protection");
    let reject = decision(&store, project, units[0], revision);
    store.decide_translation_candidate(&reject).unwrap();
    assert_eq!(pending(&store).total, 0);
    store.decide_translation_candidate(&CandidateDecisionWrite {
        action_id: ExecutionId::new(), expected_decision_id: Some(reject.action_id),
        disposition: CandidateDisposition::Restored, ..reject
    }).unwrap();
    assert_eq!(pending(&store).total, 1);
    let target = store.review_target(project, units[0], "zh-CN").unwrap();
    store.select_translation_revision(&SelectTranslationRevision {
        project_id: project, action_id: ExecutionId::new(), unit_id: units[0], locale: "zh-CN".into(),
        revision_id: revision, source_revision_id: target.source_revision_id,
        expected_selection_id: target.selection_id,
    }).unwrap();
    assert_eq!(pending(&store).total, 0, "the current selection is not pending");
    translate(&mut store, project, units[0], "zh-CN", "New manual choice");
    assert_eq!(pending(&store).rows[0].ai_candidate_count, 1,
        "the candidate owner keeps earlier selected alternatives available");
    update_source_with_continued_identity(&mut store, &units);
    assert_eq!(pending(&store).total, 1, "source applicability does not erase a proposal");
    let affected = store.read_segment_page(project, "zh-CN", &SegmentQuery {
        status: SegmentStatusFilter::Affected, ..query.clone()
    }, None, None, 100).unwrap();
    assert_eq!(affected.total, 1);
    assert_eq!(affected.rows[0].applicability.source_basis_current, Some(false));
    store.close().unwrap();
    let reopened = ProjectStore::open(directory.path().join("project")).unwrap();
    assert_eq!(pending(&reopened).rows[0].ai_candidate_count, 1);
}

#[test]
fn summaries_keep_history_separate_from_current_selection_and_latest_rejection() {
    let (_directory, mut store, project, units) = fixture();
    assert_eq!(count(&store, project, &units), vec![0, 0]);
    translate(&mut store, project, units[0], "zh-CN", "");
    assert_eq!(count(&store, project, &units), vec![0, 0]);
    translate(&mut store, project, units[0], "zh-CN", "Current");
    assert_eq!(count(&store, project, &units), vec![1, 0]);
    let rejected_revision = save_candidate(&mut store, units[0], "Alternative");
    let restored_revision = save_candidate(&mut store, units[0], "Alternative");
    assert_eq!(count(&store, project, &units), vec![3, 0]);

    let reject = decision(&store, project, units[0], rejected_revision);
    store.decide_translation_candidate(&reject).unwrap();
    assert_eq!(count(&store, project, &units), vec![2, 0]);
    let restore = CandidateDecisionWrite {
        action_id: ExecutionId::new(),
        expected_decision_id: Some(reject.action_id),
        disposition: CandidateDisposition::Restored,
        ..reject.clone()
    };
    store.decide_translation_candidate(&restore).unwrap();
    assert_eq!(count(&store, project, &units), vec![3, 0]);
    store.decide_translation_candidate(&CandidateDecisionWrite {
        action_id: ExecutionId::new(),
        expected_decision_id: Some(restore.action_id),
        ..reject
    }).unwrap();
    let reject = decision(&store, project, units[0], restored_revision);
    store.decide_translation_candidate(&reject).unwrap();
    store.decide_translation_candidate(&CandidateDecisionWrite {
        action_id: ExecutionId::new(),
        expected_decision_id: Some(reject.action_id),
        disposition: CandidateDisposition::Restored,
        ..reject
    }).unwrap();
    assert_eq!(count(&store, project, &units), vec![2, 0]);
    assert_eq!(store.translation_history(project, units[0], "zh-CN", 0, 100).unwrap().total, 4);

    translate(&mut store, project, units[0], "fr-FR", "First");
    translate(&mut store, project, units[0], "fr-FR", "Second");
    assert_eq!(count(&store, project, &units), vec![2, 0]);
    let french = summaries(store.connection().unwrap(), project, &units, "fr-FR").unwrap();
    assert_eq!(french[&units[0]].count, 1);
    assert_eq!(french[&units[1]].count, 0);

    let old_source = store.review_target(project, units[0], "zh-CN").unwrap().source_revision_id;
    update_source_with_continued_identity(&mut store, &units);
    let new_source = store.review_target(project, units[0], "zh-CN").unwrap().source_revision_id;
    assert_ne!(old_source, new_source);
    let history = store.translation_history(project, units[0], "zh-CN", 0, 100).unwrap();
    assert_eq!(history.total, 4);
    assert!(history.rows.iter().all(|revision| revision.source_revision_id == old_source));
    assert_eq!(count(&store, project, &units), vec![2, 0]);
    let path = store.directory().to_path_buf();
    store.close().unwrap();
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(count(&reopened, project, &units), vec![2, 0]);
}

#[test]
fn summaries_validate_scope_and_the_latest_original_decision_receipt() {
    let (_directory, mut store, project, units) = fixture();
    let revision = save_candidate(&mut store, units[0], "Alternative");
    let reject = decision(&store, project, units[0], revision);
    let saved = store.decide_translation_candidate(&reject).unwrap();
    assert_eq!(count(&store, project, &units), vec![0, 0]);
    let connection = store.connection().unwrap();
    assert_eq!(summaries(connection, ExecutionId::new(), &units, "zh-CN").unwrap_err().code, ErrorCode::Unauthorized);
    assert_eq!(summaries(connection, project, &[units[0], ExecutionId::new()], "zh-CN").unwrap_err().code, ErrorCode::Unauthorized);
    assert_eq!(summaries(connection, project, &[units[0], units[0]], "zh-CN").unwrap_err().code, ErrorCode::InvalidInput);
    assert!(summaries(connection, project, &units, "zh-cn").is_err());
    assert!(summaries(connection, project, &[], "zh-CN").unwrap().is_empty());
    connection.execute("UPDATE translation_candidate_decisions SET receipt_digest=?1 WHERE action_id=?2",
        params!["0".repeat(64), reject.action_id.to_string()]).unwrap();
    assert_eq!(latest(connection, revision).unwrap_err().stage, "candidate-decision-receipt");
    assert_eq!(summaries(connection, project, &units, "zh-CN").unwrap_err().stage, "candidate-decision-receipt");
    let wrong_request = CandidateDecisionWrite { unit_id: units[1], ..saved.request };
    let wrong_receipt = CandidateDecision {
        request: wrong_request.clone(),
        source_snapshot_id: saved.source_snapshot_id,
    };
    let request_bytes = codec::encode(&wrong_request, MAX_INPUT_BYTES).unwrap();
    let receipt_bytes = codec::encode(&wrong_receipt, MAX_INPUT_BYTES).unwrap();
    connection.execute(
        "UPDATE translation_candidate_decisions SET request=?1,request_digest=?2,receipt=?3,receipt_digest=?4 WHERE action_id=?5",
        params![request_bytes, codec::digest(&request_bytes), receipt_bytes, codec::digest(&receipt_bytes), reject.action_id.to_string()],
    ).unwrap();
    assert_eq!(latest(connection, revision).unwrap(), Some(wrong_receipt));
    assert_eq!(summaries(connection, project, &units, "zh-CN").unwrap_err().stage, "candidate-summary-decision");
}
