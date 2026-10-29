//! Resource recovery retains local input, never renewed execution authority.
use super::*;

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub struct ResourceDraftReadRequest {pub session_token:String,pub key:ResourceDraftKey}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub struct ResourceDraftWriteRequest {pub session_token:String,pub write:ResourceDraftWrite}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub struct ResourceDraftClearRequest {pub session_token:String,pub clear:ResourceDraftClear}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
#[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
pub struct ResourceDraftResolveRequest {pub session_token:String,pub resolve:ResourceDraftResolve}

async fn journal<T:Send+'static>(state:&AppState,token:String,project:ExecutionId,
    operation:impl FnOnce(DraftStore)->Result<T,ExecutionError>+Send+'static)->Result<T,CommandError>{
    authorize(state,token.clone(),project,None).await?;
    let drafts=store(state)?;
    let result=state.io.run(CommandStage::DraftStorage,move||operation(drafts).map_err(map_error)).await?;
    authorize(state,token,project,None).await?;
    Ok(result)
}

/// None is unresolved, including after an absent receipt. Only a stable
/// receipt-first rejection from the original owner proves non-application.
pub(in crate::commands) fn observe_resource_target(store:&ProjectStore,key:&ResourceDraftKey,
    target:&ResourceDraftResolveTarget)->Result<Option<ResourceDraftDisposition>,ExecutionError>{
    use tsumugi_core::ContextResourceAction;
    let (project,result,reasons):(ExecutionId,Result<bool,ExecutionError>,&[&str])=match target {
        ResourceDraftResolveTarget::Primary{pending}=>match pending {
            ResourceDraftPending::TypedContextSave{request,..}=>(request.project_id,
                store.context_resource_request_settlement_observation(&ContextResourceAction::Save(request.clone())).map(|v|v.is_some()),
                &["context-resource-current","context-resource-source"]),
            ResourceDraftPending::TypedContextWithdraw{request,..}=>(request.project_id,
                store.context_resource_request_settlement_observation(&ContextResourceAction::Withdraw(request.clone())).map(|v|v.is_some()),
                &["context-resource-current"]),
            ResourceDraftPending::KnowledgeDecision{request,..}=>(request.proposal.project_id,
                store.conversation_knowledge_decision_settlement_observation(request).map(|v|v.is_some()),
                &["conversation-proposal-head","knowledge-proposal-decided","knowledge-source","knowledge-locale","knowledge-proposal-comparison"]),
            ResourceDraftPending::Correction{request,..}=>(request.basis.project_id,
                store.correction_term_request_settlement_observation(request).map(|v|v.is_some()),
                &["correction-stale","correction-existing"]),
            ResourceDraftPending::Term{request,..}=>(request.project_id,
                store.term_save_request_settlement_observation(request).map(|v|v.is_some()),
                &["resource-current","resource-term"]),
            ResourceDraftPending::Context{request,..}=>(request.project_id,
                store.context_save_request_settlement_observation(request).map(|v|v.is_some()),
                &["context-current","context-source"]),
            ResourceDraftPending::Decision{request,..}=>(request.project_id,
                store.resource_decision_request_settlement_observation(request).map(|v|v.is_some()),&["resource-current","correction-stale"]),
            ResourceDraftPending::Capture{request,..}=>(request.project_id,
                store.context_capture_request_settlement_observation(request).map(|v|v.is_some()),&["context-source"]),
        },
        ResourceDraftResolveTarget::Fact{pending}=>(pending.request.basis.scope.project_id,
            store.context_fact_request_settlement_observation(&pending.request).map(|v|v.is_some()),&["context-fact-current"]),
    };
    if project!=key.project_id{return Err(ExecutionError::new(ErrorCode::Unauthorized,"resource-drafts-project"));}
    match result {
        Ok(true)=>Ok(Some(ResourceDraftDisposition::Recorded)),
        Ok(false)=>Ok(None),
        Err(error) if error.code==ErrorCode::DependencyConflict&&reasons.contains(&error.stage.as_str())=>
            Ok(Some(ResourceDraftDisposition::ConfirmedNotApplied)),
        Err(error)=>Err(error),
    }
}

#[tauri::command]
pub async fn read_local_resource_draft(state:State<'_,AppState>,request:ResourceDraftReadRequest)
    ->Result<ResourceDraftHead,CommandError>{
    journal(&state,request.session_token,request.key.project_id,move|d|d.read_resource(&request.key)).await
}
#[tauri::command]
pub async fn write_local_resource_draft(state:State<'_,AppState>,request:ResourceDraftWriteRequest)
    ->Result<ResourceDraftHead,CommandError>{
    journal(&state,request.session_token,request.write.key.project_id,move|d|d.write_resource(&request.write)).await
}
#[tauri::command]
pub async fn clear_local_resource_draft(state:State<'_,AppState>,request:ResourceDraftClearRequest)
    ->Result<ResourceDraftHead,CommandError>{
    journal(&state,request.session_token,request.clear.key.project_id,move|d|d.clear_resource(&request.clear)).await
}
#[tauri::command]
pub async fn resolve_local_resource_draft(state:State<'_,AppState>,request:ResourceDraftResolveRequest)
    ->Result<ResourceDraftHead,CommandError>{
    let original=request.clone();
    state.sessions.run("local_resource_drafts.resolve",CommandStage::DraftStorage,move|sessions|{
        let key=&original.resolve.write.key;
        let active=super::super::execution::authorized(sessions,&original.session_token,key.project_id,CommandStage::DraftStorage)?;
        let disposition=observe_resource_target(&active.store,key,&original.resolve.target).map_err(map_error)?
            .ok_or_else(||map_error(ExecutionError::new(ErrorCode::OutcomeUnknown,"resource-drafts-pending")))?;
        if disposition!=original.resolve.disposition{
            return Err(map_error(ExecutionError::new(ErrorCode::ResultMismatch,"resource-drafts-disposition")));
        }Ok(())
    }).await?;
    journal(&state,request.session_token,request.resolve.write.key.project_id,
        move|d|d.resolve_resource(&request.resolve)).await
}

#[cfg(test)]
mod tests;
