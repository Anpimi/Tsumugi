use super::*;
use super::tests::project_with_source;
use crate::application::{AppendProjectConversationMessage, ConversationPlanningConsent,
    ConversationPlanningScope, CreateProjectConversation, PrepareConversationPlanning,
    PreparedConversationPlanning};
use crate::{ComparisonRequest, MergeBasis};
use std::sync::atomic::Ordering;

fn request(store: &ProjectStore, row: &crate::content::ContentRow) -> SaveTranslationRevision {
    SaveTranslationRevision { project_id: ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap(),
        action_id: ExecutionId::new(), unit_id: row.unit_id.unwrap(), locale: "zh-CN".into(),
        source_revision_id: row.source_revision_id.unwrap(), expected_selection_id: None,
        text: "Original e\u{301} 👩🏽‍💻".into() }
}

/// Real local consent is installed without enqueueing or invoking a producer.
fn planning_authority(store: &ProjectStore, project: ExecutionId) -> PreparedConversationPlanning {
    let conversation_id = ExecutionId::new();
    store.create_project_conversation(&CreateProjectConversation { project_id: project,
        action_id: ExecutionId::new(), conversation_id, title: None }).unwrap();
    let message_id = ExecutionId::new();
    store.append_project_conversation_message(&AppendProjectConversationMessage { project_id: project,
        action_id: ExecutionId::new(), conversation_id, message_id, body: "Synthetic local question".into() }).unwrap();
    let capture = store.prepare_conversation_planning(&PrepareConversationPlanning { project_id: project,
        conversation_id, selected_message_ids: vec![message_id], scope: ConversationPlanningScope::ConversationOnly {},
        config: crate::ai::AiConfig { endpoint: "https://example.invalid/v1/chat/completions".into(),
            model: "synthetic-observation".into(), credential_env: String::new(), max_requests: 1,
            ..crate::ai::AiConfig::default() } }).unwrap();
    let action = ExecutionId::new();
    store.authorize_conversation_planning(&capture, &ConversationPlanningConsent { action_id: action,
        task_id: ExecutionId::new(), attempt_id: action, preview_digest: capture.preview_digest().unwrap(),
        expires_at_ms: (crate::execution::plugin_authority::plugin_now_ms().unwrap() + 30_000).into(),
        share_messages: true, share_units: false }).unwrap()
}

fn observe<T>(store: &ProjectStore, planning: &PreparedConversationPlanning, read: impl FnOnce() -> T) -> T {
    let c = store.connection().unwrap();
    let writes = c.total_changes();
    let autocommit = c.is_autocommit();
    let reconciling = store.is_reconciling();
    let authority = store.planning_authority_revision.load(Ordering::Acquire);
    let permit_active = planning.permit.active.load(Ordering::Acquire);
    let clock = store.changes_since(Revision::new(0).unwrap());
    let value = read();
    assert_eq!(c.total_changes(), writes, "an observation must not write the project");
    assert_eq!(c.is_autocommit(), autocommit, "an existing snapshot belongs to its caller");
    assert_eq!(store.is_reconciling(), reconciling, "observation cannot settle uncertainty");
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire), authority);
    assert_eq!(planning.permit.active.load(Ordering::Acquire), permit_active);
    let after = store.changes_since(Revision::new(0).unwrap());
    assert_eq!((after.epoch, after.sequence, after.progress_sequence),
        (clock.epoch, clock.sequence, clock.progress_sequence));
    value
}

#[test]
fn pure_request_observations_preserve_unknown_and_authority_for_recorded_absent_and_mismatch() {
    let (_directory, mut store, rows) = project_with_source();
    let saved_request = request(&store, &rows[0]);
    let saved = store.save_translation_edit(&saved_request).unwrap();
    let newer = SaveTranslationRevision { action_id: ExecutionId::new(), text: "Newer revision".into(),
        expected_selection_id: Some(saved.selection.event_id), ..saved_request.clone() };
    let next = store.save_translation_edit(&newer).unwrap();
    let selection_request = SelectTranslationRevision { project_id: saved_request.project_id,
        action_id: ExecutionId::new(), unit_id: saved_request.unit_id, locale: saved_request.locale.clone(),
        source_revision_id: saved_request.source_revision_id, expected_selection_id: Some(next.selection.event_id),
        revision_id: saved.revision.revision_id };
    let selected = store.select_translation_revision(&selection_request).unwrap();
    let planning = planning_authority(&store, saved_request.project_id);
    assert!(planning.permit.check_input(planning.input()).is_ok());
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(observe(&store, &planning, || store.translation_save_request_observation(&saved_request)).unwrap(), Some(saved));
    assert_eq!(observe(&store, &planning, || store.translation_selection_request_observation(&selection_request)).unwrap(), Some(selected));
    let absent_save = SaveTranslationRevision { action_id: ExecutionId::new(), ..saved_request.clone() };
    let absent_selection = SelectTranslationRevision { action_id: ExecutionId::new(), ..selection_request.clone() };
    assert_eq!(observe(&store, &planning, || store.translation_save_request_observation(&absent_save)).unwrap(), None);
    assert_eq!(observe(&store, &planning, || store.translation_selection_request_observation(&absent_selection)).unwrap(), None);
    for changed in [SaveTranslationRevision { text: "Different request".into(), ..saved_request.clone() },
        SaveTranslationRevision { source_revision_id: ExecutionId::new(), ..saved_request.clone() },
        SaveTranslationRevision { expected_selection_id: Some(next.selection.event_id), ..saved_request.clone() },
        SaveTranslationRevision { locale: "ja".into(), ..saved_request.clone() },
        SaveTranslationRevision { unit_id: rows[1].unit_id.unwrap(), ..saved_request.clone() }] {
        assert_eq!(observe(&store, &planning, || store.translation_save_request_observation(&changed)).unwrap_err().code,
            ErrorCode::ResultMismatch);
    }
    for changed in [SelectTranslationRevision { revision_id: next.revision.revision_id, ..selection_request.clone() },
        SelectTranslationRevision { expected_selection_id: None, ..selection_request.clone() },
        SelectTranslationRevision { source_revision_id: ExecutionId::new(), ..selection_request.clone() },
        SelectTranslationRevision { locale: "ja".into(), ..selection_request.clone() }] {
        assert_eq!(observe(&store, &planning, || store.translation_selection_request_observation(&changed)).unwrap_err().code,
            ErrorCode::ResultMismatch);
    }
    assert_eq!(observe(&store, &planning, || store.translation_save_request_observation(&SaveTranslationRevision {
        project_id: ExecutionId::new(), ..saved_request.clone() })).unwrap_err().code, ErrorCode::Unauthorized);
    assert_eq!(observe(&store, &planning, || store.translation_selection_request_observation(&SelectTranslationRevision {
        project_id: ExecutionId::new(), ..selection_request.clone() })).unwrap_err().code, ErrorCode::Unauthorized);
    assert_eq!(store.save_translation_edit(&absent_save).unwrap_err().code, ErrorCode::OutcomeUnknown);
    // Explicit recovery retains its distinct original authority invalidation.
    let authority = store.planning_authority_revision.load(Ordering::Acquire);
    store.translation_save_receipt_by_request(&saved_request).unwrap();
    assert!(!store.is_reconciling());
    assert!(store.planning_authority_revision.load(Ordering::Acquire) > authority);
    assert!(planning.permit.check_input(planning.input()).is_err());
}

#[test]
fn pure_merge_observation_keeps_original_binding_and_nests_in_the_callers_snapshot() {
    let (_directory, mut store, rows) = project_with_source();
    let first = request(&store, &rows[0]);
    let first_saved = store.save_translation_edit(&first).unwrap();
    let second = SaveTranslationRevision { action_id: ExecutionId::new(), expected_selection_id: Some(first_saved.selection.event_id),
        text: "Second proposal".into(), ..first.clone() };
    let second_saved = store.save_translation_edit(&second).unwrap();
    let comparison = store.create_comparison(&ComparisonRequest { project_id: first.project_id,
        action_id: ExecutionId::new(), unit_id: first.unit_id, locale: first.locale.clone(),
        revision_ids: vec![first_saved.revision.revision_id, second_saved.revision.revision_id], blind: true }).unwrap();
    let merge = MergeBasis { contributors: comparison.rows.iter().map(|row| row.revision_id).collect(), expected_basis: comparison.basis };
    let merge_request = SaveTranslationRevision { action_id: ExecutionId::new(), expected_selection_id: Some(second_saved.selection.event_id),
        text: "Merged proposal".into(), ..first.clone() };
    let planning = planning_authority(&store, first.project_id);
    store.execution_unknown.store(true, Ordering::Release);
    assert_eq!(observe(&store, &planning, || store.arena_merge_request_observation(&merge_request, &merge)).unwrap(), None);
    store.execution_unknown.store(false, Ordering::Release);
    let merged = store.save_merged_translation(&merge_request, &merge).unwrap();
    let newer = SaveTranslationRevision { action_id: ExecutionId::new(), expected_selection_id: Some(merged.event_id),
        text: "Newer human work".into(), ..first.clone() };
    let latest = store.save_translation_edit(&newer).unwrap();
    let selection = SelectTranslationRevision { project_id: first.project_id, action_id: ExecutionId::new(), unit_id: first.unit_id,
        locale: first.locale.clone(), source_revision_id: first.source_revision_id,
        expected_selection_id: Some(latest.selection.event_id), revision_id: first_saved.revision.revision_id };
    let selected = store.select_translation_revision(&selection).unwrap();
    let metadata_revision = store.metadata().unwrap().metadata_revision();
    store.set_target_locales(metadata_revision, &["ja".into()]).unwrap();
    store.execution_unknown.store(true, Ordering::Release);
    let expected = Some(ArenaMergeActionRead { request: merge_request.clone(), merge: merge.clone(), receipt: merged.clone() });
    super::super::review::read_snapshot(store.connection().unwrap(), |_| {
        assert_eq!(observe(&store, &planning, || store.translation_save_request_observation(&first))?, Some(first_saved));
        assert_eq!(observe(&store, &planning, || store.translation_selection_request_observation(&selection))?, Some(selected));
        assert_eq!(observe(&store, &planning, || store.arena_merge_request_observation(&merge_request, &merge))?, expected);
        Ok(())
    }).unwrap();
    for changed in [SaveTranslationRevision { text: "Changed".into(), ..merge_request.clone() },
        SaveTranslationRevision { expected_selection_id: None, ..merge_request.clone() },
        SaveTranslationRevision { action_id: first.action_id, ..merge_request.clone() }] {
        assert_eq!(observe(&store, &planning, || store.arena_merge_request_observation(&changed, &merge)).unwrap_err().code,
            ErrorCode::ResultMismatch);
    }
    let mut reordered = merge.clone();
    reordered.contributors.reverse();
    assert_eq!(observe(&store, &planning, || store.arena_merge_request_observation(&merge_request, &reordered)).unwrap_err().code,
        ErrorCode::ResultMismatch);
    let changed_basis = MergeBasis { expected_basis: "0".repeat(64), ..merge.clone() };
    assert_eq!(observe(&store, &planning, || store.arena_merge_request_observation(&merge_request, &changed_basis)).unwrap_err().code,
        ErrorCode::ResultMismatch);
    store.connection().unwrap().execute("UPDATE translation_contributors SET ordinal=3 WHERE revision_id=?1 AND ordinal=0",
        [merged.revision_id.to_string()]).unwrap();
    assert_eq!(observe(&store, &planning, || store.arena_merge_request_observation(&merge_request, &merge)).unwrap_err().code,
        ErrorCode::CorruptLedger);
}

#[test]
fn pure_receipt_observations_reject_damaged_save_and_selection_chains_without_reconciliation() {
    let (_directory, mut store, rows) = project_with_source();
    let saved_request = request(&store, &rows[0]);
    let saved = store.save_translation_edit(&saved_request).unwrap();
    let selection = SelectTranslationRevision { project_id: saved_request.project_id, action_id: ExecutionId::new(),
        unit_id: saved_request.unit_id, locale: saved_request.locale.clone(), source_revision_id: saved_request.source_revision_id,
        expected_selection_id: Some(saved.selection.event_id), revision_id: saved.revision.revision_id };
    let selected = store.select_translation_revision(&selection).unwrap();
    let planning = planning_authority(&store, saved_request.project_id);
    store.execution_unknown.store(true, Ordering::Release);
    let c = store.connection().unwrap();
    c.execute("UPDATE translation_revisions SET text='damaged' WHERE revision_id=?1", [saved.revision.revision_id.to_string()]).unwrap();
    assert_eq!(observe(&store, &planning, || store.translation_save_request_observation(&saved_request)).unwrap_err().code,
        ErrorCode::CorruptLedger);
    c.execute("UPDATE translation_revisions SET text=?1 WHERE revision_id=?2", params![saved_request.text, saved.revision.revision_id.to_string()]).unwrap();
    c.execute("UPDATE translation_selections SET previous_event_id=event_id WHERE event_id=?1", [selected.event_id.to_string()]).unwrap();
    assert_eq!(observe(&store, &planning, || store.translation_selection_request_observation(&selection)).unwrap_err().code,
        ErrorCode::CorruptLedger);
}
