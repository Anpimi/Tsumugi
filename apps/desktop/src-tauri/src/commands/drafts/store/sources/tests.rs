use super::*;
use tsumugi_core::content::{SourceConfirmation, SourceMaintenanceHookActivation, StopSourceMaintenanceHook};

fn rev(n: u64) -> Revision { Revision::new(n).unwrap() }

fn write(project_id: ExecutionId) -> SourceDraftWrite {
    SourceDraftWrite {
        key: SourceDraftKey { project_id }, expected_revision: rev(0), writer_id: ExecutionId::new(),
        value: SourceDraftValue {
            edit_seq: rev(1), mapping_seq: rev(1), domain: "Source A".into(), source: None,
            source_language: "en-US".into(), declared: true, selection_label: None, updating: false,
            attempt_id: None, check_attempt_id: None, capture_request: None, check_prepare_request: None,
            comparison_ref: None, lineage: vec![], actor: "Editor".into(), filter: String::new(),
            applied_filter: String::new(), manual_ordinal: None, historical_query: String::new(),
            preview_after: 0, comparison_after: 0, historical_search: None, receipt_ref: None,
            picker_uncertain: false, hook: SourceDraftHook { locale: "zh-CN".into(), enabled_intent: true, source_action_id: None },
            pending: None, hook_stop: None, correction: None,
        },
    }
}

fn primary_requests(project_id: ExecutionId) -> Vec<SourceDraftPending> {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/pluginSource.contract.json"))).unwrap();
    let source = serde_json::from_value(fixture["request"].clone()).unwrap();
    let start = SourceDraftStartRequest { project_id, attempt_id: ExecutionId::new(), input_digest: "a".repeat(64),
        grant_id: ExecutionId::new(), expires_at_ms: 123_u64.into(), unsandboxed_execution: false,
        start_metadata: tsumugi_core::content::SourcePluginStartMetadata { task_id: ExecutionId::new(), generation: ExecutionId::new() } };
    let seq = rev(1);
    vec![
        SourceDraftPending::Capture { request: SourceDraftCaptureRequest { project_id, selection_id: ExecutionId::new(), source_language: "en-US".into(), attempt_id: ExecutionId::new() }, submitted_seq: seq, submitted_mapping_seq: seq },
        SourceDraftPending::Start { request: start.clone(), submitted_seq: seq, submitted_mapping_seq: seq },
        SourceDraftPending::PrepareCheck { request: SourceDraftCheckPrepareRequest { project_id, source_attempt_id: ExecutionId::new(), source_result_id: ExecutionId::new(), attempt_id: ExecutionId::new(), source }, submitted_seq: seq, submitted_mapping_seq: seq },
        SourceDraftPending::StartCheck { request: start, submitted_seq: seq, submitted_mapping_seq: seq },
        SourceDraftPending::FinishCheck { request: SourceDraftCheckFinishRequest { project_id, attempt_id: ExecutionId::new(), result_id: ExecutionId::new() }, submitted_seq: seq, submitted_mapping_seq: seq },
        SourceDraftPending::Adopt { request: SourceDraftAdoptRequest { project_id, attempt_id: ExecutionId::new(), result_id: ExecutionId::new(), action_id: ExecutionId::new(),
            confirmation: SourceConfirmation { maintenance_hook: None, result_digest: "b".repeat(64), identity_policy: "synthetic/1".into(), expected_content_revision: rev(1), expected_mapping_revision: None, source_language: "en-US".into(), expected_current_snapshot: None, lineage: vec![], actor: None, lineage_base_snapshot: None } },
            unit_id: ExecutionId::new(), submitted_seq: seq, submitted_mapping_seq: seq },
    ]
}

fn hook_stop(project_id: ExecutionId) -> SourceDraftHookStop {
    SourceDraftHookStop { request: SourceDraftHookStopRequest { project_id, stop: StopSourceMaintenanceHook {
        project_id, source_action_id: ExecutionId::new(), action_id: ExecutionId::new(),
        activation: SourceMaintenanceHookActivation { policy_version: "synthetic/1".into(), session_epoch: "epoch".into(), locale: "zh-CN".into(), after: 0, limit: 10, expires_at_ms: 123 },
    } }, submitted_seq: rev(1) }
}

fn resource_write(project_id: ExecutionId) -> ResourceDraftWrite {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/resourceDraftCommands.contract.json"))).unwrap();
    let mut request: ResourceDraftWrite = serde_json::from_value(fixture["requests"]["write"]["write"].clone()).unwrap();
    request.key.project_id = project_id;
    if let Some(ResourceDraftPending::Term { request, .. }) = &mut request.value.pending { request.project_id = project_id; }
    request
}

#[test]
fn source_pending_kinds_preserve_newer_mapping_and_require_exact_resolution() {
    for pending in primary_requests(ExecutionId::new()) {
        let temp = tempfile::tempdir().unwrap();
        let store = DraftStore::at(temp.path().join("drafts")).unwrap();
        let mut original = write(pending.project_id());
        assert!(store.read_source(&original.key).unwrap().value.is_none());
        assert!(store.pending_snapshot(original.key.project_id, None).unwrap().rows.is_empty());
        assert!(!store.directory.exists());
        original.value.pending = Some(pending.clone());
        let first = store.write_source(&original).unwrap();
        assert_eq!(store.write_source(&original).unwrap(), first);
        let mut newer = original.clone();
        newer.expected_revision = first.revision;
        newer.value.edit_seq = rev(2); newer.value.mapping_seq = rev(2);
        newer.value.domain = "Newer mapping B".into();
        let saved = store.write_source(&newer).unwrap();
        let reopened = DraftStore::at(store.directory.clone()).unwrap();
        assert_eq!(reopened.read_source(&original.key).unwrap(), saved);
        assert!(!serde_json::to_string(&saved).unwrap().contains("sessionToken"));
        let mut foreign = newer.clone(); foreign.writer_id = ExecutionId::new(); foreign.value.edit_seq = rev(3);
        assert_eq!(reopened.write_source(&foreign).unwrap_err().stage, "drafts-revision");
        let mut stale_sequence = newer.clone(); stale_sequence.expected_revision = saved.revision;
        stale_sequence.value.domain = "Conflicting edit".into();
        assert_eq!(reopened.write_source(&stale_sequence).unwrap_err().stage, "drafts-edit-sequence");
        stale_sequence.value.edit_seq = rev(3); stale_sequence.value.mapping_seq = rev(1);
        assert_eq!(reopened.write_source(&stale_sequence).unwrap_err().stage, "drafts-edit-sequence");
        let mut clearing = newer.clone(); clearing.expected_revision = saved.revision;
        clearing.value.edit_seq = rev(3); clearing.value.pending = None;
        assert_eq!(reopened.write_source(&clearing).unwrap_err().stage, "drafts-pending");
        assert_eq!(reopened.clear_source(&SourceDraftClear { key: original.key.clone(), expected_revision: saved.revision }).unwrap_err().stage, "drafts-pending");
        let resolve = SourceDraftResolve { write: clearing, target: SourceDraftResolveTarget::Primary { pending: pending.clone() }, disposition: SourceDraftDisposition::Recorded };
        let wrong = primary_requests(original.key.project_id).remove(0);
        let mut wrong_identity = resolve.clone(); wrong_identity.target = SourceDraftResolveTarget::Primary { pending: wrong };
        assert_eq!(reopened.resolve_source(&wrong_identity).unwrap_err().stage, "drafts-pending");
        let mut lost = resolve.clone(); lost.write.value.domain = "Source A".into();
        assert_eq!(reopened.resolve_source(&lost).unwrap_err().stage, "source-drafts-newer-input");
        assert_eq!(reopened.read_source(&original.key).unwrap(), saved);
        let resolved = reopened.resolve_source(&resolve).unwrap();
        assert_eq!(resolved.value.as_ref().unwrap().domain, "Newer mapping B");
        assert!(resolved.value.as_ref().unwrap().pending.is_none());
        assert_eq!(reopened.resolve_source(&resolve).unwrap(), resolved);
    }
}

#[test]
fn source_and_hook_slots_are_independent_and_snapshot_uses_original_requests() {
    let temp = tempfile::tempdir().unwrap(); let store = DraftStore::at(temp.path().join("drafts")).unwrap();
    let project = ExecutionId::new(); let mut original = write(project);
    let pending = primary_requests(project).remove(0); let hook = hook_stop(project);
    original.value.pending = Some(pending.clone()); original.value.hook_stop = Some(hook.clone());
    let first = store.write_source(&original).unwrap();
    let mut newer = original.clone(); newer.expected_revision = first.revision;
    newer.value.edit_seq = rev(2); newer.value.mapping_seq = rev(2); newer.value.domain = "Mapping B".into();
    let saved = store.write_source(&newer).unwrap();
    let snapshot = store.pending_snapshot(project, Some("zh-CN")).unwrap();
    assert!(snapshot.complete); assert_eq!(snapshot.rows.len(), 2);
    assert!(snapshot.rows.iter().all(|row| row.key == PendingJournalKey::Source(original.key.clone()) && row.head_revision == saved.revision));
    assert_eq!(snapshot.rows[0].slot, PendingJournalSlot::Source(pending.clone()));
    assert_eq!(snapshot.rows[1].slot, PendingJournalSlot::SourceHookStop(hook.clone()));
    let mut next = newer.clone(); next.expected_revision = saved.revision; next.value.edit_seq = rev(3); next.value.pending = None;
    let first_resolve = SourceDraftResolve { write: next, target: SourceDraftResolveTarget::Primary { pending }, disposition: SourceDraftDisposition::Recorded };
    let after = store.resolve_source(&first_resolve).unwrap();
    assert_eq!(after.value.as_ref().unwrap().hook_stop, Some(hook.clone()));
    let mut finish = first_resolve.write.clone(); finish.expected_revision = after.revision;
    finish.value.edit_seq = rev(4); finish.value.hook_stop = None;
    let resolve_hook = SourceDraftResolve { write: finish, target: SourceDraftResolveTarget::HookStop { pending: hook }, disposition: SourceDraftDisposition::ConfirmedNotApplied };
    let mut lost = resolve_hook.clone(); lost.write.value.domain = "Source A".into();
    assert_eq!(store.resolve_source(&lost).unwrap_err().stage, "source-drafts-newer-input");
    let done = store.resolve_source(&resolve_hook).unwrap();
    assert_eq!(done.value.unwrap().domain, "Mapping B");
    assert!(store.pending_snapshot(project, None).unwrap().rows.is_empty());
}

#[test]
fn source_record_and_journal_limits_apply_across_resource_heads() {
    let temp = tempfile::tempdir().unwrap(); let mut store = DraftStore::at(temp.path().join("drafts")).unwrap();
    let project = ExecutionId::new(); let resource = resource_write(project);
    store.write_resource(&resource).unwrap();
    let mut source = write(project);
    store.limits.project_records = 1;
    assert_eq!(store.write_source(&source).unwrap_err().stage, "drafts-capacity");
    store.limits = Limits::default(); store.limits.total_records = 1;
    source.key.project_id = ExecutionId::new();
    assert_eq!(store.write_source(&source).unwrap_err().stage, "drafts-capacity");
    store.limits = Limits::default();
    let resource_bytes: i64 = Connection::open(store.directory.join(DATABASE)).unwrap()
        .query_row("SELECT length(payload) FROM resource_draft_heads", [], |r| r.get(0)).unwrap();
    store.limits.total_bytes = usize::try_from(resource_bytes).unwrap();
    assert_eq!(store.write_source(&source).unwrap_err().stage, "drafts-capacity");
    store.limits = Limits::default();
    source.value.domain = "x".repeat(MAX_RECORD);
    assert_eq!(store.write_source(&source).unwrap_err().code, ErrorCode::LimitExceeded);
    assert!(store.read_source(&source.key).unwrap().value.is_none());
    assert!(store.read_resource(&resource.key).unwrap().value.is_some());
}

#[test]
fn format_ten_resource_survives_read_failed_upgrade_and_committed_source_write() {
    let temp = tempfile::tempdir().unwrap(); let store = DraftStore::at(temp.path().join("drafts")).unwrap();
    let project = ExecutionId::new(); let resource = resource_write(project);
    let resource_head = store.write_resource(&resource).unwrap();
    let path = store.directory.join(DATABASE);
    let blocker = Connection::open(&path).unwrap(); set_legacy_format(&blocker, RESOURCE_FORMAT).unwrap();
    let row: (i64, Vec<u8>) = blocker.query_row("SELECT rowid,payload FROM resource_draft_heads", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    let source = write(project);
    assert!(store.read_source(&source.key).unwrap().value.is_none());
    assert_eq!(store.read_resource(&resource.key).unwrap(), resource_head);
    assert_eq!(blocker.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), RESOURCE_FORMAT);
    blocker.execute_batch("BEGIN; SELECT * FROM resource_draft_heads;").unwrap();
    assert_eq!(store.write_source(&source).unwrap_err().code, ErrorCode::OutcomeUnknown);
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(blocker.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), RESOURCE_FORMAT);
    assert_eq!(blocker.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='source_draft_heads'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(blocker.query_row("SELECT rowid,payload FROM resource_draft_heads", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).unwrap(), row);
    let saved = store.write_source(&source).unwrap();
    assert_eq!(store.read_source(&source.key).unwrap(), saved);
    assert_eq!(blocker.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), FORMAT);
    assert_eq!(blocker.query_row("SELECT rowid,payload FROM resource_draft_heads", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).unwrap(), row);
}

#[test]
fn format_eleven_source_bytes_and_pending_survive_read_failed_upgrade_and_new_correction_draft() {
    let temp = tempfile::tempdir().unwrap(); let store = DraftStore::at(temp.path().join("drafts")).unwrap();
    let project = ExecutionId::new(); let mut original = write(project);
    original.value.pending = Some(primary_requests(project).remove(0));
    let head = store.write_source(&original).unwrap();
    let path = store.directory.join(DATABASE); let blocker = Connection::open(&path).unwrap();
    set_legacy_format(&blocker, SOURCE_FORMAT).unwrap();
    let row: (i64, Vec<u8>) = blocker.query_row("SELECT rowid,payload FROM source_draft_heads WHERE project_id=?1", [project.to_string()], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert!(!String::from_utf8(row.1.clone()).unwrap().contains("\"correction\""));
    assert_eq!(store.read_source(&original.key).unwrap(), head);
    assert_eq!(blocker.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SOURCE_FORMAT);
    let mut other = write(ExecutionId::new());
    other.value.correction = Some(SourceDraftCorrection { snapshot_id: ExecutionId::new(), ordinal: 3,
        old_occurrence_id: None, decision: tsumugi_core::content::SourceLineageCorrectionDecision::Unresolved,
        actor: "Newer B 人工".into(), reason: "Keep both saved translations".into() });
    blocker.execute_batch("BEGIN; SELECT * FROM source_draft_heads;").unwrap();
    assert_eq!(store.write_source(&other).unwrap_err().code, ErrorCode::OutcomeUnknown);
    blocker.execute_batch("ROLLBACK").unwrap();
    assert_eq!(blocker.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SOURCE_FORMAT);
    assert_eq!(blocker.query_row("SELECT rowid,payload FROM source_draft_heads WHERE project_id=?1", [project.to_string()], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).unwrap(), row);
    let saved = store.write_source(&other).unwrap();
    assert_eq!(store.read_source(&other.key).unwrap(), saved);
    assert_eq!(blocker.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), FORMAT);
    assert_eq!(blocker.query_row("SELECT rowid,payload FROM source_draft_heads WHERE project_id=?1", [project.to_string()], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).unwrap(), row);
    assert_eq!(store.read_source(&original.key).unwrap(), head);
}
