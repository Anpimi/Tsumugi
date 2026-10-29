use super::*;
use super::super::tests::{call,source_fixture};
use tauri::Manager;
use serde_json::json;
use tsumugi_core::{CaptureContextStrategy,CaptureStrategySuite,CaptureStrategyEvaluation,SaveTranslationRevision,
    SourceContextSelection,ai::AiConfig,execution::Revision};
use std::collections::BTreeMap;
fn rev(n:u64)->Revision{Revision::new(n).unwrap()}

#[test]
fn registered_strategy_journal_recovers_exact_receipt_and_closes_reopened_start_without_host(){
    let (directory,mut core,rows)=source_fixture::source_fixture();
    let project=ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let units=rows.iter().filter_map(|r|r.unit_id).collect::<Vec<_>>();
    for text in ["Original manual translation","Corrected manual translation"] {
        let target=core.review_target(project,units[0],"zh-CN").unwrap();
        core.save_translation_revision(&SaveTranslationRevision{project_id:project,action_id:ExecutionId::new(),unit_id:units[0],locale:"zh-CN".into(),
            source_revision_id:target.source_revision_id,expected_selection_id:target.selection_id,text:text.into(),reuse_origin:None}).unwrap();
    }
    let target=core.review_target(project,units[0],"zh-CN").unwrap();
    let basis=core.correction_term_basis(project,units[0],"zh-CN",target.selection_id.unwrap()).unwrap();
    let capture=CaptureContextStrategy{action_id:ExecutionId::new(),basis:basis.basis.clone(),source_context:SourceContextSelection{neighbors:true,..Default::default()},
        reason:"Use neighboring source".into(),exceptions:"Only this project and locale".into()};
    let candidate=core.capture_context_strategy(&capture).unwrap();
    let config=AiConfig{endpoint:"http://127.0.0.1:9/v1/chat/completions".into(),model:"synthetic-strategy".into(),max_items:2,max_requests:4,
        share_terms:false,share_context:false,..Default::default()};
    let suite=core.capture_strategy_suite(&CaptureStrategySuite{action_id:ExecutionId::new(),project_id:project,candidate_id:candidate.candidate_id,
        config:config.clone(),calibration_unit_ids:vec![units[0]],holdout_unit_ids:vec![units[1]]}).unwrap();
    let evaluation=core.capture_strategy_evaluation(&CaptureStrategyEvaluation{action_id:ExecutionId::new(),project_id:project,candidate_id:candidate.candidate_id,suite_id:suite.suite_id}).unwrap();
    core.close().unwrap();
    let application=tempfile::tempdir().unwrap();
    let app=crate::commands::register_commands(tauri::test::mock_builder()).invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.state::<AppState>().local_drafts.set(DraftStore::at(application.path().join("drafts")).unwrap()).ok().unwrap();
    let window=tauri::WebviewWindowBuilder::new(&app,"main",tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let opened=call(&window,"open_project",json!({"locator":directory.path().join("project")})).unwrap();
    let token=opened["sessionToken"].clone();let key=StrategyDraftKey{project_id:project};
    let pending=StrategyDraftPending::Candidate{request:StrategyCaptureOriginal{project_id:project,capture},edit_seq:rev(1),submitted_seq:rev(1)};
    let value=StrategyDraftValue{number_drafts:BTreeMap::new(),journal_seq:rev(1),edit_seq:rev(2),locale:"zh-CN".into(),correction_unit:units[0].to_string(),evidence:Some(basis),source_context:candidate.source_context.clone(),
        reason:"Newer unfinished reason B".into(),exceptions:String::new(),config,roles:BTreeMap::new(),candidate:Some(candidate),suite:Some(suite.try_into().unwrap()),evaluation_id:Some(evaluation.evaluation_id),
        judgments:BTreeMap::new(),candidate_edit_seq:rev(2),candidate_saved_seq:rev(1),suite_edit_seq:rev(0),suite_saved_seq:rev(0),pending:Some(pending.clone())};
    let mut write=StrategyDraftWrite{key:key.clone(),expected_revision:rev(0),writer_id:ExecutionId::new(),value};
    assert_eq!(call(&window,"read_local_strategy_draft",json!({"sessionToken":token,"key":key})).unwrap()["revision"],"0");
    assert!(!application.path().join("drafts").exists());
    let saved=call(&window,"write_local_strategy_draft",json!({"sessionToken":token,"write":write})).unwrap();
    assert_eq!(call(&window,"list_local_strategy_drafts",json!({"sessionToken":token,"key":key,"after":null,"limit":10})).unwrap()["items"],json!([saved]));
    let observation=call(&window,"read_local_strategy_action",json!({"sessionToken":token,"key":key,"pending":pending})).unwrap();
    assert_eq!(observation["disposition"],"recorded");
    write.expected_revision=serde_json::from_value(saved["revision"].clone()).unwrap();write.value.journal_seq=rev(2);write.value.pending=None;
    let resolved=call(&window,"resolve_local_strategy_draft",json!({"sessionToken":token,"resolve":{"write":write,"pending":pending,"disposition":"recorded"}})).unwrap();
    let start=StrategyDraftPending::Start{request:StrategyStartOriginal{project_id:project,evaluation_id:evaluation.evaluation_id,attempt_id:evaluation.attempt_id,digest:evaluation.input_digest,confirmed:true},edit_seq:rev(2),submitted_seq:rev(3)};
    write.expected_revision=serde_json::from_value(resolved["revision"].clone()).unwrap();write.value.journal_seq=rev(3);write.value.pending=Some(start.clone());
    let saved=call(&window,"write_local_strategy_draft",json!({"sessionToken":token,"write":write})).unwrap();
    let closed=call(&window,"close_local_strategy_action",json!({"sessionToken":token,"key":key,"pending":start})).unwrap();
    assert_eq!(closed["pending"],json!(start));assert_eq!(closed["disposition"],"confirmed-not-applied");
    write.expected_revision=serde_json::from_value(saved["revision"].clone()).unwrap();write.value.journal_seq=rev(4);write.value.pending=None;
    let final_head=call(&window,"resolve_local_strategy_draft",json!({"sessionToken":token,"resolve":{"write":write,"pending":start,"disposition":"confirmed-not-applied"}})).unwrap();
    assert_eq!(final_head["value"]["reason"],"Newer unfinished reason B");assert_eq!(final_head["value"]["pending"],json!(null));
    let attempt=evaluation.attempt_id;
    app.state::<AppState>().sessions.with(move|sessions|{
        let active=sessions.active.as_mut().unwrap();assert!(active.execution.is_none());
        assert!(active.store.execution_input_if_present(attempt).unwrap().is_none());
    });
    // A mutable qualification rejection is a live Native reply, not an absent
    // receipt promoted to a permanent closure. It must release local intent so
    // the independent human evaluation can continue.
    let promotion=tsumugi_core::PromoteContextStrategy{project_id:project,action_id:ExecutionId::new(),evaluation_id:evaluation.evaluation_id,expected_revision_id:None};
    let pending=StrategyDraftPending::Promote{request:StrategyPromoteOriginal{project_id:project,promotion:promotion.clone()},edit_seq:rev(2),submitted_seq:rev(5)};
    write.expected_revision=serde_json::from_value(final_head["revision"].clone()).unwrap();write.value.journal_seq=rev(5);write.value.pending=Some(pending.clone());
    let saved=call(&window,"write_local_strategy_draft",json!({"sessionToken":token,"write":write})).unwrap();
    let rejection=call(&window,"promote_context_strategy",json!({"sessionToken":token,"projectId":project,"promotion":promotion})).unwrap_err();
    assert_eq!(rejection["reason"],"strategy-checks-incomplete");
    let observed=call(&window,"read_local_strategy_action",json!({"sessionToken":token,"key":key,"pending":pending})).unwrap();
    assert_eq!(observed["disposition"],"rejected");assert_eq!(observed["rejection"],rejection);
    assert!(!observed["rejection"].as_object().unwrap().contains_key("sessionToken"));
    write.expected_revision=serde_json::from_value(saved["revision"].clone()).unwrap();write.value.journal_seq=rev(6);write.value.pending=None;
    let released=call(&window,"resolve_local_strategy_draft",json!({"sessionToken":token,"resolve":{"write":write,"pending":pending,"disposition":"rejected"}})).unwrap();
    assert_eq!(released["value"]["pending"],json!(null));assert!(released["value"].get("rejection").is_none());
    write.expected_revision=serde_json::from_value(released["revision"].clone()).unwrap();write.value.journal_seq=rev(7);
    write.value.judgments.insert(units[1].to_string(),StrategyJudgmentDraft{preference:None,notes:"Continue the independent unfinished judgment".into(),elapsed:"1e".into(),modified:String::new(),edit_seq:rev(1),saved_seq:rev(0)});
    let continued=call(&window,"write_local_strategy_draft",json!({"sessionToken":token,"write":write})).unwrap();
    assert_eq!(continued["value"]["judgments"][units[1].to_string()]["notes"],"Continue the independent unfinished judgment");
}
