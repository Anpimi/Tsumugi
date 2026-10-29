use super::*;
use super::super::tests::{call,source_fixture};
use serde_json::{Value,json};
use tauri::Manager;
use tsumugi_core::{SaveTerm,ContextFactWrite,ContextFactDisposition,SourceFactBasis,SourceContextRequest};
use tsumugi_plugin_sdk as sdk;

#[test]
fn resource_draft_shared_wire_fixture_round_trips_without_session_credentials(){
    let fixture:Value=serde_json::from_str(include_str!("../../../../../test/fixtures/resourceDraftCommands.contract.json")).unwrap();
    fn round<T:serde::de::DeserializeOwned+Serialize>(v:&Value){
        assert_eq!(serde_json::to_value(serde_json::from_value::<T>(v.clone()).unwrap()).unwrap(),*v);
    }
    round::<ResourceDraftReadRequest>(&fixture["requests"]["read"]);
    round::<ResourceDraftWriteRequest>(&fixture["requests"]["write"]);
    round::<ResourceDraftResolveRequest>(&fixture["requests"]["resolve"]);
    round::<ResourceDraftClearRequest>(&fixture["requests"]["clear"]);
    for name in ["read","written","resolved","cleared"]{round::<ResourceDraftHead>(&fixture["responses"][name]);}
    let mut wrong=fixture["requests"]["write"].clone();
    wrong["write"]["value"]["pending"]["request"]["sessionToken"]=json!("must-not-persist");
    assert!(serde_json::from_value::<ResourceDraftWriteRequest>(wrong).is_err());
}

fn facts(mut exchange:sdk::ContentExchange)->sdk::ContentExchange{
    let source=exchange.units[0].occurrences[0].source.clone();
    exchange.domain_blocks=vec![sdk::DomainBlock{target:sdk::ContentTarget::Snapshot,
        schema:sdk::source_context_facts_contract(),handling:sdk::ExtensionHandling::Preserve,
        payload_utf8:serde_json::to_string(&sdk::SourceContextFacts{facts:vec![sdk::SourceContextFact{
            id:"synthetic-role".into(),kind:sdk::SourceContextFactKind::Role,text:"Observed hypothesis".into(),
            origin:sdk::SourceContextFactOrigin::Inferred{rationale:"Synthetic evidence".into(),sources:vec![source]},
        }]}).unwrap()}];
    exchange
}

#[test]
fn registered_resource_journal_and_pure_term_fact_routes_preserve_unknown_and_newer_input(){
    let (directory,mut core,rows)=source_fixture::source_fixture_with_transform(2,facts);
    let project=ExecutionId::parse(&core.metadata().unwrap().project_id().to_string()).unwrap();
    let scope=SourceContextRequest{project_id:project,unit_id:rows[0].unit_id.unwrap(),locale:"zh-CN".into(),
        source_snapshot_id:core.content_scope().unwrap().current_snapshot.unwrap(),source_revision_id:rows[0].source_revision_id.unwrap()};
    let fact=ContextFactWrite{action_id:ExecutionId::new(),basis:SourceFactBasis::from_view(&core.source_context(&scope).unwrap(),0,0).unwrap(),
        expected_decision_id:None,disposition:ContextFactDisposition::RejectInference,actor:"Synthetic reviewer".into(),reason:"Original fact action".into()};
    let fact_receipt=core.decide_context_fact(&fact).unwrap();
    core.close().unwrap();
    let application=tempfile::tempdir().unwrap();
    let app=crate::commands::register_commands(tauri::test::mock_builder())
        .invoke_handler(crate::commands::execution::production_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    app.state::<AppState>().local_drafts.set(DraftStore::at(application.path().join("drafts")).unwrap()).ok().unwrap();
    let window=tauri::WebviewWindowBuilder::new(&app,"main",tauri::WebviewUrl::App("index.html".into())).build().unwrap();
    let path=directory.path().join("project");
    let opened=call(&window,"open_project",json!({"locator":path})).unwrap();let token=opened["sessionToken"].clone();
    let key=ResourceDraftKey{project_id:project};
    let session=json!({"sessionToken":token,"projectId":project});
    let envelope=|fields:Value|{
        let mut request=session.clone();request.as_object_mut().unwrap().extend(fields.as_object().unwrap().clone());request
    };
    let term=SaveTerm{project_id:project,action_id:ExecutionId::new(),term_id:None,locale:"zh-CN".into(),source:"Source".into(),
        aliases:vec![],target:"Submitted term A".into(),protected:false,scope_unit_id:None,expected_revision_id:None,reason:"Original term action".into()};
    let pending=ResourceDraftPending::Term{request:term.clone(),submitted_seq:tsumugi_core::execution::Revision::new(1).unwrap(),alias_input:"".into()};
    let fixture:Value=serde_json::from_str(include_str!("../../../../../test/fixtures/resourceDraftCommands.contract.json")).unwrap();
    let mut value=fixture["requests"]["write"]["write"]["value"].clone();
    value["pending"]=serde_json::to_value(&pending).unwrap();value["editSeq"]=json!("2");value["termSeq"]=json!("2");
    value["selectedTerm"]=Value::Null;
    value["termDraft"]=json!({"source":"Source","aliases":[],"target":"Retained newer B 👩🏽‍💻 é","protected":false,"scopeUnitId":null,"reason":"User newer reason"});
    let read=json!({"sessionToken":token,"key":key});
    assert_eq!(call(&window,"read_local_resource_draft",read.clone()).unwrap()["revision"],"0");
    assert!(!application.path().join("drafts").exists());
    let writer=ExecutionId::new();
    let write=json!({"key":key,"expectedRevision":"0","writerId":writer,"value":value});
    let written=call(&window,"write_local_resource_draft",json!({"sessionToken":token,"write":write})).unwrap();
    assert_eq!(call(&window,"read_local_resource_draft",read.clone()).unwrap(),written);
    assert!(call(&window,"clear_local_resource_draft",json!({"sessionToken":token,"clear":{"key":key,"expectedRevision":written["revision"]}})).is_err());
    let mut after=value.clone();after["pending"]=Value::Null;after["editSeq"]=json!("3");
    let resolve=json!({"write":{"key":key,"expectedRevision":written["revision"],"writerId":writer,"value":after},
        "target":{"kind":"primary","pending":pending},"disposition":"confirmed-not-applied"});
    assert_eq!(call(&window,"resolve_local_resource_draft",json!({"sessionToken":token,"resolve":resolve})).unwrap_err()["code"],"outcome-unknown");
    assert_eq!(call(&window,"read_local_resource_draft",read.clone()).unwrap(),written);
    let observed_term=envelope(json!({"term":term}));
    let observed_fact=envelope(json!({"decision":fact}));
    assert!(app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().execution.is_none()));
    assert_eq!(call(&window,"observe_term_save_action",observed_term.clone()).unwrap(),Value::Null);
    assert_eq!(call(&window,"observe_context_fact_action",observed_fact.clone()).unwrap(),serde_json::to_value(&fact_receipt).unwrap());
    assert!(app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().execution.is_none()),
        "pure term/fact routes must not initialize the runtime before any business write");
    let saved=call(&window,"save_term",observed_term.clone()).unwrap();
    // A real DELETE-journal commit interruption marks uncertainty in the active
    // Core store. The original business writer may initialize a runtime; no
    // Provider call is made, and later observations must retain that baseline.
    let reader=rusqlite::Connection::open(path.join("project.sqlite3")).unwrap();
    reader.execute_batch("BEGIN; SELECT * FROM project_metadata").unwrap();
    let mut interrupted=observed_term.clone();interrupted["term"]["actionId"]=json!(ExecutionId::new());
    interrupted["term"]["target"]=json!("Unacknowledged other term");
    assert_eq!(call(&window,"save_term",interrupted.clone()).unwrap_err()["code"],"outcome-unknown");
    reader.execute_batch("ROLLBACK").unwrap();
    assert!(app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().store.is_reconciling()));
    let execution_before_observation=app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().execution.is_some());
    let before=app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()));
    assert_eq!(call(&window,"observe_term_save_action",observed_term.clone()).unwrap()["receipt"],saved);
    assert_eq!(call(&window,"observe_context_fact_action",observed_fact.clone()).unwrap(),serde_json::to_value(&fact_receipt).unwrap());
    let mut wrong=observed_term.clone();wrong["term"]["reason"]=json!("Altered original");
    assert_eq!(call(&window,"observe_term_save_action",wrong).unwrap_err()["code"],"result-mismatch");
    let mut wrong=observed_fact.clone();wrong["decision"]["reason"]=json!("Altered original");
    assert_eq!(call(&window,"observe_context_fact_action",wrong).unwrap_err()["code"],"result-mismatch");
    for command in ["observe_term_save_action","observe_context_fact_action"]{
        let original=if command=="observe_term_save_action"{&observed_term}else{&observed_fact};
        let mut wrong=original.clone();wrong["sessionToken"]=json!("retired-session");
        assert!(call(&window,command,wrong).is_err());
        let mut wrong=original.clone();wrong["projectId"]=json!(ExecutionId::new());
        assert!(call(&window,command,wrong).is_err());
    }
    let mut resolved=resolve.clone();resolved["disposition"]=json!("recorded");
    resolved["write"]["value"]["selectedTerm"]=saved.clone();
    let resolved=call(&window,"resolve_local_resource_draft",json!({"sessionToken":token,"resolve":resolved})).unwrap();
    assert_eq!(resolved["value"]["termDraft"],value["termDraft"]);
    assert_eq!(resolved["value"]["termSeq"],"2");
    assert!(app.state::<AppState>().sessions.with(move |s|{
        let active=s.active.as_ref().unwrap();assert!(active.store.is_reconciling());
        assert_eq!(active.execution.is_some(),execution_before_observation);true
    }));
    let after=app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().store.changes_since(tsumugi_core::execution::Revision::new(0).unwrap()));
    assert_eq!(serde_json::to_value(before).unwrap(),serde_json::to_value(after).unwrap());
    let clear=json!({"sessionToken":token,"clear":{"key":key,"expectedRevision":resolved["revision"]}});
    let cleared=call(&window,"clear_local_resource_draft",clear).unwrap();assert!(cleared["value"].is_null());
    assert!(app.state::<AppState>().sessions.with(move |s|{
        let active=s.active.as_ref().unwrap();assert_eq!(active.execution.is_some(),execution_before_observation);
        active.store.is_reconciling()
    }));
    // Only this explicit original-owner recovery settles Core uncertainty.
    call(&window,"read_term_save_action",observed_term).unwrap();
    assert!(!app.state::<AppState>().sessions.with(|s|s.active.as_ref().unwrap().store.is_reconciling()));
    call(&window,"close_project",session).unwrap();
    let reopened=call(&window,"open_project",json!({"locator":path})).unwrap();
    assert!(call(&window,"read_local_resource_draft",read).is_err());
    assert_eq!(call(&window,"read_local_resource_draft",json!({"sessionToken":reopened["sessionToken"],"key":key})).unwrap(),cleared);
}
