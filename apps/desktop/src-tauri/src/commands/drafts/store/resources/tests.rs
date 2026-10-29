use super::*;
use tsumugi_core::{ContextResourceKind,ContextResourceScope,ContextResourceRevision,SourceContextRequest,
    SourceFactBasis,SelectedSourceFact,ContextFactDisposition,ContextFactWrite,CorrectionTermBasis,
    CorrectionTermEvidence,RevisionSelectionRef,SaveTerm,SaveContext,CaptureContext,ResourceDecision,
    ResourceDecisionKind,CaptureCorrectionTerm,SaveContextResource,WithdrawContextResource,
    application::{ConversationProposalRef,DecideConversationKnowledgeProposal,ConversationKnowledgeDecisionKind,ConversationKnowledgeEntry},
    content::ContentScope};
use tsumugi_plugin_sdk as sdk;

fn rev(n:u64)->Revision{Revision::new(n).unwrap()}
fn value()->ResourceDraftValue{
    ResourceDraftValue{edit_seq:rev(10),locale:"zh-CN".into(),selected_term:None,
        term_draft:ResourceTermInput{source:String::new(),aliases:vec![],target:String::new(),protected:false,scope_unit_id:None,reason:String::new()},
        alias_input:"unfinished alias, ".into(),term_seq:rev(1),newer_term:true,selected_unit:None,context_revision:None,
        context_draft:"Unfinished note e\u{301} 👩🏽‍💻".into(),context_reason:String::new(),context_seq:rev(1),newer_context:true,
        correction_draft:None,fact_draft:None,typed_drafts:vec![],typed_active_key:None,knowledge_drafts:vec![],
        knowledge_active_key:None,preview_capture_id:None,fixed_context_id:None,picker_unknown:true,pending:None,fact_pending:None}
}
fn write(project:ExecutionId)->ResourceDraftWrite{
    ResourceDraftWrite{key:ResourceDraftKey{project_id:project},expected_revision:rev(0),writer_id:ExecutionId::new(),value:value()}
}
fn originals(w:&mut ResourceDraftWrite)->Vec<ResourceDraftPending>{
    let project=w.key.project_id;let unit=ExecutionId::new();let source=ExecutionId::new();let snapshot=ExecutionId::new();
    let scope=ContentScope{revision:rev(2),current_snapshot:Some(snapshot)};
    let base=ContextResourceRevision{proposal_origin:None,revision_id:ExecutionId::new(),context_id:ExecutionId::new(),
        subject_id:ExecutionId::new(),project_id:project,kind:ContextResourceKind::Character,locale:"zh-CN".into(),
        scope:ContextResourceScope::Project,name:"Saved setting".into(),text:"Saved baseline".into(),source_basis:scope.clone(),
        withdrawn:false,actor:"Synthetic editor".into(),reason:"Original setting".into(),action_id:ExecutionId::new(),previous_revision_id:None};
    for (key,base) in [("new:synthetic",None),("saved",Some(base.clone()))]{
        w.value.typed_drafts.push(ResourceContextResourceDraft{key:key.into(),context_id:base.as_ref().map(|b|b.context_id),
            subject_id:base.as_ref().map(|b|b.subject_id),kind:ContextResourceKind::Character,locale:"zh-CN".into(),
            base,source_basis:scope.clone(),scope:ContextResourceScope::FileGroup{namespace:"Synthetic".into(),logical_paths:vec![]},
            name:String::new(),text:"Partial typed B".into(),actor:String::new(),reason:String::new(),edit_seq:rev(1),restoring:false});
    }
    let proposal=ConversationProposalRef{project_id:project,conversation_id:ExecutionId::new(),proposal_id:ExecutionId::new(),revision_id:ExecutionId::new()};
    w.value.knowledge_drafts.push(ResourceKnowledgeProposalDraft{key:"proposal-entry".into(),proposal:proposal.clone(),entry_index:0,
        entry:ConversationKnowledgeEntry{kind:ContextResourceKind::Style,name:"Original".into(),text:"Original proposal".into(),unit_ids:vec![unit]},
        locale:"zh-CN".into(),destination:None,target:None,scope:None,name:String::new(),text:"Unfinished comparison B".into(),
        actor:String::new(),reason:String::new(),edit_seq:rev(1),receipt:None,recorded_fields:None});
    w.value.selected_unit=Some(ResourceContextTarget{unit_id:unit,source_revision_id:source,
        occurrence:ResourceContextOccurrence{key:"historical-label".into(),text:"Original source".into()}});
    let correction_basis=CorrectionTermBasis{project_id:project,unit_id:unit,locale:"zh-CN".into(),
        source_snapshot_id:snapshot,source_revision_id:source,
        before:RevisionSelectionRef{revision_id:ExecutionId::new(),selection_id:ExecutionId::new()},
        after:RevisionSelectionRef{revision_id:ExecutionId::new(),selection_id:ExecutionId::new()}};
    w.value.correction_draft=Some(ResourceCorrectionDraft{evidence:CorrectionTermEvidence{basis:correction_basis.clone(),
        source_text:"Original source".into(),before_text:"Before".into(),after_text:"After".into(),
        before_source_snapshot_id:snapshot,before_source_revision_id:source,current:false},
        source:String::new(),target:"Partial correction B".into(),protected:false,reason:String::new(),edit_seq:rev(1)});
    // This is retained local intent, not evidence that a Core source fact exists.
    let fact_basis=SourceFactBasis{scope:SourceContextRequest{project_id:project,unit_id:unit,source_snapshot_id:snapshot,
        source_revision_id:source,locale:"zh-CN".into()},source_result_id:ExecutionId::new(),source_result_digest:"a".repeat(64),
        fact:SelectedSourceFact{block_index:0,fact_index:0,target:sdk::ContentTarget::Snapshot,
            schema:sdk::source_context_facts_contract(),handling:sdk::ExtensionHandling::Preserve,in_revision_basis:false,
            fact:sdk::SourceContextFact{id:"synthetic-fact".into(),kind:sdk::SourceContextFactKind::Role,text:"Hypothesis".into(),
                origin:sdk::SourceContextFactOrigin::Inferred{rationale:"Synthetic local hypothesis".into(),sources:vec![]}}}};
    w.value.fact_draft=Some(ResourceFactDraft{basis:fact_basis.clone(),key:"fact".into(),expected_decision_id:None,
        disposition:ContextFactDisposition::RejectInference,actor:String::new(),reason:String::new(),edit_seq:rev(1)});
    vec![
        ResourceDraftPending::TypedContextSave{request:SaveContextResource{project_id:project,action_id:ExecutionId::new(),
            context_id:None,subject_id:None,expected_revision_id:None,source_basis:scope,
            kind:ContextResourceKind::Character,locale:"zh-CN".into(),scope:ContextResourceScope::Project,
            name:"Submitted A".into(),text:"Submitted A".into(),actor:"Editor".into(),reason:"Original action".into()},
            draft_key:"new:synthetic".into(),submitted_seq:rev(0)},
        ResourceDraftPending::TypedContextWithdraw{request:WithdrawContextResource{project_id:project,action_id:ExecutionId::new(),
            context_id:base.context_id,expected_revision_id:base.revision_id,actor:"Editor".into(),reason:"Original withdrawal".into()},
            draft_key:"saved".into(),submitted_seq:rev(0)},
        ResourceDraftPending::KnowledgeDecision{request:DecideConversationKnowledgeProposal{action_id:ExecutionId::new(),
            proposal,entry_index:0,decision:ConversationKnowledgeDecisionKind::Keep,actor:"Reviewer".into(),reason:"Original decision".into(),adoption:None},
            draft_key:"proposal-entry".into(),submitted_seq:rev(0),submitted_fields:"Original comparison A".into()},
        ResourceDraftPending::Correction{request:CaptureCorrectionTerm{action_id:ExecutionId::new(),basis:correction_basis,
            source:"Source".into(),target:"Submitted A".into(),protected:false,reason:"Original correction".into()},submitted_seq:rev(0)},
        ResourceDraftPending::Term{request:SaveTerm{project_id:project,action_id:ExecutionId::new(),term_id:None,locale:"zh-CN".into(),
            source:"Source".into(),aliases:vec![],target:"Submitted A".into(),protected:false,scope_unit_id:None,expected_revision_id:None,reason:"Original term".into()},
            submitted_seq:rev(0),alias_input:"Submitted aliases A".into()},
        ResourceDraftPending::Context{request:SaveContext{project_id:project,action_id:ExecutionId::new(),unit_id:unit,locale:"zh-CN".into(),
            source_revision_id:source,expected_revision_id:None,text:"Submitted note A".into(),reason:"Original note".into()},submitted_seq:rev(0)},
        ResourceDraftPending::Decision{request:ResourceDecision{project_id:project,action_id:ExecutionId::new(),capture_id:ExecutionId::new(),
            entry_id:"term".into(),expected_revision_id:None,decision:ResourceDecisionKind::Keep},locale:"zh-CN".into(),submitted_seq:rev(3)},
        ResourceDraftPending::Capture{request:CaptureContext{project_id:project,action_id:ExecutionId::new(),unit_id:unit,locale:"zh-CN".into(),
            source_revision_id:source,budget_bytes:16384},submitted_seq:rev(3)},
    ]
}
fn fact_pending(w:&ResourceDraftWrite)->ResourceFactPending{
    ResourceFactPending{request:ContextFactWrite{action_id:ExecutionId::new(),
        basis:w.value.fact_draft.as_ref().unwrap().basis.clone(),expected_decision_id:None,
        disposition:ContextFactDisposition::RejectInference,actor:"Reviewer".into(),reason:"Original fact action".into()},
        submitted_seq:rev(0)}
}
#[test]
fn all_resource_inputs_and_nine_original_action_kinds_survive_cas_and_explicit_slot_resolution(){
    for index in 0..9 {
        let temp=tempfile::tempdir().unwrap();let store=DraftStore::at(temp.path().join("drafts")).unwrap();
        let mut w=write(ExecutionId::new());let mut primary=originals(&mut w);
        let (target,slot)=if index<8{
            let pending=primary.remove(index);w.value.pending=Some(pending.clone());
            (ResourceDraftResolveTarget::Primary{pending:pending.clone()},PendingJournalSlot::Resource(pending))
        }else{
            let pending=fact_pending(&w);w.value.fact_pending=Some(pending.clone());
            (ResourceDraftResolveTarget::Fact{pending:pending.clone()},PendingJournalSlot::ResourceFact(pending))
        };
        assert!(store.read_resource(&w.key).unwrap().value.is_none());assert!(!store.directory.exists());
        let first=store.write_resource(&w).unwrap();assert_eq!(store.write_resource(&w).unwrap(),first);
        let mut b=w.clone();b.expected_revision=first.revision;b.value.edit_seq=rev(11);
        b.value.term_draft.target="Newer B e\u{301} 👩🏽‍💻".into();b.value.term_seq=rev(2);
        b.value.fact_draft.as_mut().unwrap().reason="Newer fact reason B".into();
        b.value.fact_draft.as_mut().unwrap().edit_seq=rev(2);
        let saved=store.write_resource(&b).unwrap();
        let reopened=DraftStore::at(store.directory.clone()).unwrap();
        assert_eq!(reopened.read_resource(&w.key).unwrap(),saved);
        let snapshot=reopened.pending_snapshot(w.key.project_id,None).unwrap();
        assert!(snapshot.complete);assert_eq!(snapshot.rows.len(),1);
        assert!(snapshot.rows.iter().all(|r|matches!(r.key,PendingJournalKey::Resource(_))));
        assert_eq!(snapshot.rows[0].slot,slot);
        assert_eq!(snapshot.rows[0].slot.action_id(),slot.action_id());
        assert_eq!(snapshot.rows[0].slot.submitted_seq(),slot.submitted_seq());
        let mut cleared=b.clone();cleared.expected_revision=saved.revision;cleared.value.edit_seq=rev(12);cleared.value.pending=None;
        cleared.value.fact_pending=None;
        assert_eq!(store.write_resource(&cleared).unwrap_err().stage,"drafts-pending");
        assert_eq!(store.clear_resource(&ResourceDraftClear{key:w.key.clone(),expected_revision:saved.revision}).unwrap_err().stage,"drafts-pending");
        let r=ResourceDraftResolve{write:cleared,target,
            disposition:ResourceDraftDisposition::Recorded};
        if index==4||index==8{
            let mut lost=r.clone();
            if index==4{lost.write.value.term_draft.target="Lost newer B".into();}
            else{lost.write.value.fact_draft=None;}
            assert_eq!(store.resolve_resource(&lost).unwrap_err().stage,"resource-drafts-newer-input");
            assert_eq!(store.read_resource(&w.key).unwrap(),saved);
        }
        let resolved=store.resolve_resource(&r).unwrap();
        assert_eq!(resolved.value.as_ref().unwrap().term_draft.target,b.value.term_draft.target);
        assert_eq!(resolved.value.as_ref().unwrap().fact_draft,b.value.fact_draft);
        assert!(resolved.value.as_ref().unwrap().pending.is_none()&&resolved.value.as_ref().unwrap().fact_pending.is_none());
        assert_eq!(store.resolve_resource(&r).unwrap(),resolved);
        assert!(store.write_resource(&b).is_err());
        assert!(store.pending_snapshot(w.key.project_id,None).unwrap().rows.is_empty());
        assert!(store.clear_resource(&ResourceDraftClear{key:w.key.clone(),expected_revision:resolved.revision}).unwrap().value.is_none());
        assert!(store.write_resource(&w).is_err());
    }
}
fn translation(project:ExecutionId)->DraftWrite{
    DraftWrite{key:DraftKey{project_id:project,unit_id:ExecutionId::new(),locale:"zh-CN".into()},
        expected_revision:rev(0),writer_id:ExecutionId::new(),value:DraftValue{basis:DraftBasis{source_revision_id:ExecutionId::new(),
            selection_id:None,revision_id:None,text:None},text:"Original translation draft".into(),edit_seq:rev(1),
            pending:None,merge:None,reuse_origin:None}}
}
#[test]
fn all_supported_journals_stay_read_only_until_any_successful_writer_creates_resource_table(){
    for format in 1..=9 {
        let temp=tempfile::tempdir().unwrap();let store=DraftStore::at(temp.path().join("drafts")).unwrap();
        let project=ExecutionId::new();let mut original=translation(project);
        if format==REUSE_ORIGIN_FORMAT {
            original.value.reuse_origin=Some(tsumugi_core::TranslationReuseOrigin{
                target_source_snapshot_id:ExecutionId::new(),target_unit_id:original.key.unit_id,
                target_source_revision_id:original.value.basis.source_revision_id,target_selection_id:None,
                donor_unit_id:ExecutionId::new(),donor_source_revision_id:ExecutionId::new(),
                donor_translation_revision_id:ExecutionId::new(),donor_basis:"a".repeat(64)});
        }
        let saved=store.write(&original).unwrap();
        let c=Connection::open(store.directory.join(DATABASE)).unwrap();
        if format<CONVERSATION_FORMAT{c.execute_batch("DROP TABLE conversation_draft_heads").unwrap();}
        if format==CONVERSATION_FORMAT{
            c.execute_batch("DROP TABLE conversation_draft_heads").unwrap();c.execute_batch(conversations::LEGACY_HEAD_SQL).unwrap();
        }
        set_legacy_format(&c,format).unwrap();
        let original_bytes:Vec<u8>=c.query_row("SELECT payload FROM draft_heads",[],|r|r.get(0)).unwrap();drop(c);
        let mut resource=write(project);resource.expected_revision=rev(1);
        assert!(store.read_resource(&resource.key).unwrap().value.is_none());
        assert_eq!(store.read(&original.key).unwrap(),saved);
        assert!(store.write_resource(&resource).is_err());
        let c=Connection::open(store.directory.join(DATABASE)).unwrap();
        assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),format);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='resource_draft_heads'",[],|r|r.get::<_,i64>(0)).unwrap(),0);drop(c);
        match format%3 {
            0=>{store.write(&original).unwrap();}
            1=>{store.write_conversation(&ConversationDraftWrite{key:ConversationDraftKey{project_id:project,conversation_id:ExecutionId::new()},
                expected_revision:rev(0),writer_id:ExecutionId::new(),value:ConversationDraftValue{text:String::new(),edit_seq:rev(1),
                    message_edit_seq:None,pending:None,revocations:vec![],proposal_edits:vec![],team_drafts:vec![]}}).unwrap();}
            _=>{resource.expected_revision=rev(0);store.write_resource(&resource).unwrap();}
        }
        let c=Connection::open(store.directory.join(DATABASE)).unwrap();
        assert_eq!(c.pragma_query_value(None,"user_version",|r|r.get::<_,i64>(0)).unwrap(),FORMAT);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name='resource_draft_heads'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(c.query_row("SELECT payload FROM draft_heads",[],|r|r.get::<_,Vec<u8>>(0)).unwrap(),original_bytes);
    }
}
#[test]
fn resource_limits_and_wrong_project_cannot_publish_or_drop_retained_input(){
    let temp=tempfile::tempdir().unwrap();let store=DraftStore::at(temp.path().join("drafts")).unwrap();
    let mut w=write(ExecutionId::new());
    w.value.edit_seq=rev(MAX_SAFE_SEQUENCE+1);
    assert_eq!(store.write_resource(&w).unwrap_err().code,ErrorCode::LimitExceeded);assert!(!store.directory.exists());
    w.value=value();w.value.context_draft="x".repeat(MAX_RECORD+1);
    assert_eq!(store.write_resource(&w).unwrap_err().code,ErrorCode::LimitExceeded);assert!(!store.directory.exists());
    w.value=value();let pending=originals(&mut w).remove(4);let fact=fact_pending(&w);
    w.value.pending=Some(pending);w.value.fact_pending=Some(fact);
    assert_eq!(store.write_resource(&w).unwrap_err().stage,"resource-drafts-pending");
    assert!(!store.directory.exists());
    w.value=value();let mut pending=originals(&mut w).remove(4);
    if let ResourceDraftPending::Term{request,..}=&mut pending{request.project_id=ExecutionId::new();}
    w.value.pending=Some(pending);
    assert_eq!(store.write_resource(&w).unwrap_err().stage,"resource-drafts-project");
    assert!(!store.directory.exists());
}
