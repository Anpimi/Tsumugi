use super::*;
use super::super::tests::project_with_source;
use crate::ReviewWrite;
use std::sync::atomic::Ordering;

fn project(store: &ProjectStore) -> ExecutionId {
    ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap()
}
fn filter() -> TranslationMemoryFilter {
    TranslationMemoryFilter { source_locale: "en".into(), target_locale: "zh-CN".into(),
        source_text: None, translation_text: None, origin: None, selection: TranslationMemorySelection::All }
}
fn save(store: &ProjectStore, unit: ExecutionId, text: &str) -> SaveTranslationRevision {
    let target = store.review_target(project(store), unit, "zh-CN").unwrap();
    SaveTranslationRevision { reuse_origin: None, project_id: project(store), action_id: ExecutionId::new(),
        unit_id: unit, locale: "zh-CN".into(), source_revision_id: target.source_revision_id,
        expected_selection_id: target.selection_id, text: text.into() }
}
fn prepare(store: &ProjectStore, target: ExecutionId, donor: &TranslationMemoryEntry) -> PrepareTranslationMemoryReuse {
    let target = store.review_target(project(store), target, "zh-CN").unwrap();
    PrepareTranslationMemoryReuse { project_id: project(store), unit_id: target.unit_id,
        locale: target.locale, source_revision_id: target.source_revision_id,
        expected_selection_id: target.selection_id, donor_unit_id: donor.revision.unit_id,
        donor_revision_id: donor.revision.revision_id, donor_basis: donor.basis.clone() }
}
fn counts(store: &ProjectStore) -> (i64, i64) {
    store.connection().unwrap().query_row("SELECT (SELECT COUNT(*) FROM translation_revisions),
        (SELECT COUNT(*) FROM translation_selections)", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap()
}

#[test]
fn memory_pages_filter_full_history_and_pin_their_actual_cursor_basis() {
    let (_temp, mut store, rows) = project_with_source();
    let unit = rows[0].unit_id.unwrap();
    for index in 0..23 {
        let request = save(&store, unit, &format!("History {index} e\u{301} 👩🏽‍💻"));
        store.save_translation_edit(&request).unwrap();
    }
    let mut ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = store.list_translation_memory(project(&store), &filter(), cursor.as_deref(), 3).unwrap();
        assert_eq!(page.project_id,project(&store));
        assert_eq!(page.filter,filter());
        assert!(!page.rows.is_empty());
        assert!(page.rows.iter().all(|r|r.project_id==project(&store)));
        assert!(page.rows.iter().all(|r| r.source_text=="same" && r.source_label.native_key=="first"
            && r.source_label.occurrence_count==1 && r.is_current_source));
        ids.extend(page.rows.iter().map(|r| r.revision.revision_id));
        cursor = page.next_cursor;
        if cursor.is_none() { break; }
    }
    assert_eq!(ids.len(),23);
    assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(),23);
    let first = store.list_translation_memory(project(&store), &filter(), None, 1).unwrap();
    let cursor = first.next_cursor.unwrap();
    let mut current = filter();
    current.selection=TranslationMemorySelection::Current;
    assert_eq!(store.list_translation_memory(project(&store),&current,None,100).unwrap().rows.len(),1);
    current.selection=TranslationMemorySelection::Historical;
    assert_eq!(store.list_translation_memory(project(&store),&current,None,100).unwrap().rows.len(),22);
    current.selection=TranslationMemorySelection::All;
    current.translation_text=Some("History 12".into());
    assert_eq!(store.list_translation_memory(project(&store),&current,None,100).unwrap().rows.len(),1);
    assert_eq!(store.list_translation_memory(project(&store),&current,Some(&cursor),1).unwrap_err().code,ErrorCode::DependencyConflict);
    current.source_locale="EN".into();
    assert_eq!(store.list_translation_memory(project(&store),&current,None,1).unwrap_err().code,ErrorCode::InvalidInput);
    let request=save(&store,unit,"Another history row");
    store.save_translation_edit(&request).unwrap();
    assert_eq!(store.list_translation_memory(project(&store),&filter(),Some(&cursor),1).unwrap_err().code,ErrorCode::DependencyConflict);
    let suggestions=store.tm_suggestions(project(&store),rows[1].unit_id.unwrap(),"zh-CN",0,20).unwrap();
    let donor=ids.into_iter().find(|id| !suggestions.iter().any(|r|r.translation_revision_id==*id)).unwrap();
    let donor=store.translation_memory_entry(project(&store),unit,"zh-CN",donor).unwrap();
    assert!(store.prepare_translation_memory_reuse(&prepare(&store,rows[1].unit_id.unwrap(),&donor)).is_ok());
    assert!(store.translation_memory_entry(project(&store),rows[1].unit_id.unwrap(),"zh-CN",donor.revision.revision_id).is_err());
    assert!(store.translation_memory_entry(ExecutionId::new(),unit,"zh-CN",donor.revision.revision_id).is_err());
    assert!(store.translation_memory_entry(project(&store),unit,"ja",donor.revision.revision_id).is_err());
    // A byte-limited page must resume after the last returned row, including
    // when the requested item count would have fit.
    for index in 0..70 {
        let request=save(&store,unit,&format!("Large {index} {}", "x".repeat(16*1024-32)));
        store.save_translation_edit(&request).unwrap();
    }
    let page=store.list_translation_memory(project(&store),&filter(),None,100).unwrap();
    assert!(page.rows.len()<94 && !page.rows.is_empty());
    assert!(serde_json::to_vec(&page).unwrap().len()<=MAX_PAGE_BYTES);
    let tail=store.list_translation_memory(project(&store),&filter(),page.next_cursor.as_deref(),100).unwrap();
    assert!(tail.next_cursor.is_none());
    assert_eq!(page.rows.len()+tail.rows.len(),94);
    assert!(!page.rows.iter().any(|a|tail.rows.iter().any(|b|a.revision.revision_id==b.revision.revision_id)));
}

#[test]
fn memory_reuse_is_atomic_cas_checked_and_inherits_only_saved_target_provenance() {
    let (temp, mut store, rows) = project_with_source();
    let donor_unit=rows[0].unit_id.unwrap();
    let target_unit=rows[1].unit_id.unwrap();
    let donor_revision=super::super::candidates::summary_tests::save_candidate(&mut store,donor_unit,"Synthetic AI donor");
    let donor=store.translation_memory_entry(project(&store),donor_unit,"zh-CN",donor_revision).unwrap();
    let preview=store.prepare_translation_memory_reuse(&prepare(&store,target_unit,&donor)).unwrap();
    let changes=store.connection().unwrap().total_changes();
    let authority=store.planning_authority_revision.load(Ordering::Acquire);
    store.execution_unknown.store(true,Ordering::Release);
    assert!(store.list_translation_memory(project(&store),&filter(),None,10).is_ok());
    assert!(store.translation_memory_entry(project(&store),donor_unit,"zh-CN",donor_revision).is_ok());
    assert!(store.prepare_translation_memory_reuse(&prepare(&store,target_unit,&donor)).is_ok());
    assert!(store.is_reconciling());
    assert_eq!(store.connection().unwrap().total_changes(),changes);
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire),authority);
    store.execution_unknown.store(false,Ordering::Release);
    let mut request=save(&store,target_unit,"Human adapted donor");
    request.reuse_origin=Some(preview.reuse_origin.clone());
    let before=counts(&store);
    assert!(store.save_revision(&request,None,|_,_|Err::<(),_>(error(ErrorCode::InvalidInput,"synthetic-projection"))).is_err());
    assert_eq!(counts(&store),before);
    assert!(store.translation_save_request_observation(&request).unwrap().is_none());
    let saved=store.save_translation_edit(&request).unwrap();
    assert_eq!(saved.revision.origin_kind,TranslationOrigin::Manual);
    assert!(saved.revision.contributors.is_empty());
    assert_eq!(saved.revision.reuse_origin,request.reuse_origin);
    assert_eq!(store.save_translation_edit(&request).unwrap(),saved);
    assert_eq!(counts(&store),(before.0+1,before.1+1));
    let fresh=store.prepare_translation_memory_reuse(&prepare(&store,target_unit,&donor)).unwrap();
    let stale=save(&store,target_unit,"Fresh donor staging");
    let mut new_staging=stale.clone();
    new_staging.reuse_origin=Some(fresh.reuse_origin);
    let donor_target=store.review_target(project(&store),donor_unit,"zh-CN").unwrap();
    store.decide_translation_candidate(&CandidateDecisionWrite {
        project_id: project(&store),action_id:ExecutionId::new(),unit_id:donor_unit,locale:"zh-CN".into(),
        revision_id:donor_revision,source_revision_id:donor_target.source_revision_id,
        expected_selection_id:donor_target.selection_id,expected_decision_id:None,
        disposition:CandidateDisposition::Rejected,actor:"Synthetic reviewer".into(),reason:"Rejected donor".into(),
    }).unwrap();
    assert_eq!(store.save_translation_edit(&new_staging).unwrap_err().stage,"tm-donor-rejected");
    assert!(store.prepare_translation_memory_reuse(&prepare(&store,target_unit,&donor)).is_err());
    // The already adopted text is the user's own revision, so future edits inherit
    // its exact historical provenance without renewing donor admission.
    let inherited=store.save_translation_edit(&stale).unwrap();
    assert_eq!(inherited.revision.reuse_origin,request.reuse_origin);
    assert_eq!(store.translation_save_request_observation(&stale).unwrap(),Some(inherited.clone()));
    let mut forged=save(&store,target_unit,"Forged inherited reference");
    forged.reuse_origin=request.reuse_origin.clone();
    forged.reuse_origin.as_mut().unwrap().donor_basis="0".repeat(64);
    assert!(store.save_translation_edit(&forged).is_err());
    assert!(store.save_translation_edit(&new_staging).is_err());
    let mut wrong=prepare(&store,target_unit,&donor);
    wrong.source_revision_id=ExecutionId::new();
    assert_eq!(store.prepare_translation_memory_reuse(&wrong).unwrap_err().stage,"tm-target-basis");
    wrong=prepare(&store,target_unit,&donor);
    wrong.expected_selection_id=None;
    assert_eq!(store.prepare_translation_memory_reuse(&wrong).unwrap_err().stage,"tm-target-basis");
    let authority=store.planning_authority_revision.load(Ordering::Acquire);
    store.execution_unknown.store(true,Ordering::Release);
    assert_eq!(store.translation_save_request_observation(&request).unwrap(),Some(saved.clone()));
    assert!(store.is_reconciling());
    assert_eq!(store.planning_authority_revision.load(Ordering::Acquire),authority);
    assert!(matches!(store.recover_translation_save(&request).unwrap().outcome,
        TranslationActionOutcome::Recorded{..}));
    assert!(!store.is_reconciling());
    drop(store);
    let mut reopened=ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(reopened.translation_revision(project(&reopened),target_unit,"zh-CN",inherited.revision.revision_id).unwrap().reuse_origin,request.reuse_origin);
    assert_eq!(reopened.translation_save_request_observation(&request).unwrap(),Some(saved));
    // The editor sends its persisted current origin with a comparison merge.
    // It is inheritance, even though this original donor is now rejected.
    let first=reopened.translation_save_request_observation(&request).unwrap().unwrap().revision.revision_id;
    let parents=vec![first,inherited.revision.revision_id];
    let comparison=reopened.preview_comparison(project(&reopened),target_unit,"zh-CN",&parents).unwrap();
    let merge=crate::MergeBasis {contributors:parents,expected_basis:comparison.basis};
    let mut merge_request=save(&reopened,target_unit,"Human merged two target versions");
    merge_request.reuse_origin=request.reuse_origin.clone();
    let mut changed_origin=merge_request.clone();
    changed_origin.reuse_origin=new_staging.reuse_origin;
    let before=counts(&reopened);
    assert_eq!(reopened.save_merged_translation(&changed_origin,&merge).unwrap_err().stage,"tm-merge-origin");
    assert_eq!(counts(&reopened),before);
    let merged=reopened.save_merged_translation(&merge_request,&merge).unwrap();
    let authority=reopened.planning_authority_revision.load(Ordering::Acquire);
    reopened.execution_unknown.store(true,Ordering::Release);
    let observed=reopened.arena_merge_request_observation(&merge_request,&merge).unwrap().unwrap();
    assert_eq!(observed.request,merge_request);
    assert_eq!(observed.receipt,merged);
    assert!(reopened.is_reconciling());
    assert_eq!(reopened.planning_authority_revision.load(Ordering::Acquire),authority);
    let omitted=SaveTranslationRevision {reuse_origin:None,..merge_request.clone()};
    assert_eq!(reopened.arena_merge_request_observation(&omitted,&merge).unwrap_err().code,ErrorCode::ResultMismatch);
    assert!(matches!(reopened.recover_translation_merge(&merge_request,&merge).unwrap().outcome,
        TranslationActionOutcome::Recorded{..}));
    let parents=vec![inherited.revision.revision_id,merged.revision_id];
    let comparison=reopened.preview_comparison(project(&reopened),target_unit,"zh-CN",&parents).unwrap();
    let merge=crate::MergeBasis {contributors:parents,expected_basis:comparison.basis};
    let omitted=save(&reopened,target_unit,"Merge request with legacy optional origin omitted");
    let last=reopened.save_merged_translation(&omitted,&merge).unwrap();
    assert!(reopened.arena_merge_request_observation(&omitted,&merge).unwrap().is_some());
    drop(reopened);
    let reopened=ProjectStore::open(temp.path().join("project")).unwrap();
    assert_eq!(reopened.translation_revision(project(&reopened),target_unit,"zh-CN",last.revision_id).unwrap().reuse_origin,request.reuse_origin);
}

#[test]
fn memory_quality_uses_original_decisions_and_keeps_deleted_donor_labels() {
    let (_temp,mut store,project,units)=crate::persistence::review::tests::fixture();
    crate::persistence::review::tests::translate(&mut store,project,units[0],"zh-CN","你好 {{name}}");
    let target=store.review_target(project,units[0],"zh-CN").unwrap();
    let revision=target.revision_id.unwrap();
    let write=ReviewWrite {project_id:project,action_id:ExecutionId::new(),unit_id:units[0],locale:"zh-CN".into(),
        expected_basis:target.basis,expected_decision_id:None,actor:"Synthetic reviewer".into(),
        kind:ReviewDecisionKind::Approve,reason:String::new()};
    let approval=store.write_review(&write).unwrap();
    let donor=store.translation_memory_entry(project,units[0],"zh-CN",revision).unwrap();
    assert_eq!(donor.quality.current_approval,Some(approval.clone()));
    assert_eq!(donor.quality.past_approval,Some(approval.clone()));
    assert!(store.tm_suggestions(project,units[0],"zh-CN",0,20).unwrap().iter()
        .any(|r|r.translation_revision_id==revision && r.has_human_approval));
    let rejected_review=ReviewWrite {action_id:ExecutionId::new(),expected_decision_id:Some(approval.decision_id),
        kind:ReviewDecisionKind::RequestChanges,reason:"Needs another edit".into(),..write};
    let latest=store.write_review(&rejected_review).unwrap();
    let changed=store.translation_memory_entry(project,units[0],"zh-CN",revision).unwrap();
    assert_eq!(changed.quality.latest_decision,Some(latest));
    assert!(changed.quality.current_approval.is_none());
    assert_eq!(changed.quality.past_approval,Some(approval));
    assert_eq!(changed.basis,donor.basis);
    assert!(!store.tm_suggestions(project,units[0],"zh-CN",0,20).unwrap().iter()
        .find(|r|r.translation_revision_id==revision).unwrap().has_human_approval);
    crate::persistence::review::tests::adopt_source(&mut store,br#"{"replacement":"Different current entry"}"#);
    let historical=store.translation_memory_entry(project,units[0],"zh-CN",revision).unwrap();
    assert!(!historical.is_current_source);
    assert_eq!(historical.source_label,donor.source_label);
    assert_eq!(historical.source_text,donor.source_text);
    assert_eq!(historical.basis,donor.basis);
    assert!(historical.quality.past_approval.is_some());
    assert!(historical.quality.current_approval.is_none());
}

#[test]
fn supported_memory_migration_preserves_old_requests_rows_and_rolls_back_nullable_ddl() {
    for version in 61..=67 {
        let (temp,mut store,rows)=project_with_source();
        let request=save(&store,rows[0].unit_id.unwrap(),"Original e\u{301} 👩🏽‍💻");
        let original=serde_json::to_vec(&request).unwrap();
        assert!(!String::from_utf8(original.clone()).unwrap().contains("reuseOrigin"));
        let saved=store.save_translation_edit(&request).unwrap();
        let record=serde_json::to_vec(&saved.revision).unwrap();
        assert!(!String::from_utf8(record.clone()).unwrap().contains("reuseOrigin"));
        drop(store);
        let path=temp.path().join("project");
        let mut c=Connection::open(path.join(crate::persistence::DATABASE_FILENAME)).unwrap();
        c.execute_batch("DROP TABLE source_validation_history").unwrap();
        c.execute_batch("ALTER TABLE translation_revisions DROP COLUMN reuse_origin_json").unwrap();
        if version<66 {crate::persistence::resources::make_legacy_context_schema(&c).unwrap();}
        if version<65 {c.execute_batch("DROP TABLE application_conversation_planning_attempts").unwrap();}
        if version<64 {c.execute_batch("DROP TABLE application_conversation_work_plans").unwrap();}
        if version<63 {c.execute_batch("DROP TABLE application_conversation_proposals").unwrap();}
        if version==61 {c.execute_batch("DROP TABLE application_conversation_actions;
            DROP TABLE application_conversation_messages; DROP TABLE application_conversations").unwrap();}
        c.pragma_update(None,"user_version",version).unwrap();
        let row_before:(i64,String)=c.query_row("SELECT rowid,request_digest FROM translation_revisions
            WHERE revision_id=?1",[saved.revision.revision_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        // The same nullable-column operation participates in the original open transaction.
        {let tx=c.transaction().unwrap();super::super::migrate_memory(&tx).unwrap();}
        assert_eq!(c.query_row("SELECT COUNT(*) FROM pragma_table_info('translation_revisions') WHERE name='reuse_origin_json'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),version);
        drop(c);
        let reopened=ProjectStore::open(&path).unwrap();
        assert_eq!(reopened.translation_save_request_observation(&request).unwrap(),Some(saved.clone()));
        assert_eq!(serde_json::to_vec(&request).unwrap(),original);
        assert_eq!(serde_json::to_vec(&reopened.translation_revision(project(&reopened),request.unit_id,"zh-CN",saved.revision.revision_id).unwrap()).unwrap(),record);
        let row_after:(i64,String)=reopened.connection().unwrap().query_row("SELECT rowid,request_digest FROM translation_revisions
            WHERE revision_id=?1",[saved.revision.revision_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(row_before,row_after);
    }
}
