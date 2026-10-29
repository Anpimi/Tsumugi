//! The existing Strategy owner settles original requests before removing intent.
use super::*;
use tsumugi_core::{StrategyActionRequest,StrategyCandidateSaveRequest};
macro_rules! request {($name:ident {$($field:ident:$ty:ty),*})=>{
    #[derive(Clone,Debug,Serialize,Deserialize)]
    #[serde(rename_all="camelCase",deny_unknown_fields)]
    #[cfg_attr(feature="wire-schema",derive(schemars::JsonSchema))]
    pub struct $name {pub session_token:String,$(pub $field:$ty),*}
};}
request!(StrategyDraftReadRequest {key:StrategyDraftKey});
request!(StrategyDraftWriteRequest {write:StrategyDraftWrite});
request!(StrategyDraftResolveRequest {resolve:StrategyDraftResolve});
request!(StrategyDraftClearRequest {clear:StrategyDraftClear});
request!(StrategyDraftListRequest {key:StrategyDraftKey,after:Option<StrategyDraftKey>,limit:u32});
request!(StrategyDraftActionRequest {key:StrategyDraftKey,pending:StrategyDraftPending});

async fn journal<T:Send+'static>(state:&AppState,token:String,project:ExecutionId,
    operation:impl FnOnce(DraftStore)->Result<T,ExecutionError>+Send+'static)->Result<T,CommandError>{
    authorize(state,token.clone(),project,None).await?;
    let drafts=store(state)?;
    let result=state.io.run(CommandStage::DraftStorage,move||operation(drafts).map_err(map_error)).await?;
    authorize(state,token,project,None).await?;Ok(result)
}
pub(in crate::commands) fn observe_strategy_pending(store:&ProjectStore,key:&StrategyDraftKey,p:&StrategyDraftPending)
    ->Result<Option<StrategyDraftDisposition>,ExecutionError>{
    if p.project_id()!=key.project_id{return Err(ExecutionError::new(ErrorCode::Unauthorized,"strategy-drafts-project"));}
    let request=match p {
        StrategyDraftPending::Candidate{request,..}=>StrategyActionRequest::Candidate(request.capture.clone()),
        StrategyDraftPending::Suite{request,..}=>StrategyActionRequest::Suite(request.capture.clone()),
        StrategyDraftPending::Prepare{request,..}=>StrategyActionRequest::Prepare(request.capture.clone()),
        StrategyDraftPending::Judgment{request,..}=>StrategyActionRequest::Judgment(request.judgment.clone()),
        StrategyDraftPending::Promote{request,..}=>StrategyActionRequest::Promote(request.promotion.clone()),
        StrategyDraftPending::Withdraw{request,..}=>StrategyActionRequest::Withdraw(request.withdrawal.clone()),
        StrategyDraftPending::PrepareCheck{request,..}=>StrategyActionRequest::Check(request.check.clone()),
        StrategyDraftPending::Check{request,..}=>StrategyActionRequest::Check(request.check.check.clone()),
        StrategyDraftPending::Start{request,..}=>return Ok(store.strategy_evaluation_start_action_observation(
            request.project_id,request.evaluation_id,request.attempt_id,&request.digest)?.map(|_|StrategyDraftDisposition::Recorded)),
        StrategyDraftPending::SaveCandidate{request,attempt_id,unit_id,..}=>{
            let input=store.strategy_evaluation_input(request.project_id,request.evaluation_id)?;
            if input.envelope().attempt_id!=*attempt_id||input.envelope().units.iter().filter(|u|
                u.unit_id==*unit_id&&u.item_ids.as_slice()==[request.item_id]).count()!=1{
                return Err(ExecutionError::new(ErrorCode::ResultMismatch,"strategy-drafts-save"));
            }
            let original=StrategyCandidateSaveRequest{
                project_id:request.project_id,evaluation_id:request.evaluation_id,item_id:request.item_id,
                result_id:request.result_id,action_id:request.action_id};
            let found=store.strategy_candidate_save_action_observation(&original)?;
            if let Some(found)=found {
                if found.adoption.action.attempt_id!=*attempt_id||found.adoption.action.unit_id!=*unit_id{
                    return Err(ExecutionError::new(ErrorCode::ResultMismatch,"strategy-drafts-save"));}
                if found.adoption.receipt.is_some(){return Ok(Some(StrategyDraftDisposition::Recorded));}
            }
            return Ok(store.strategy_candidate_save_settlement_observation(&original)?.map(|recorded|if recorded{
                StrategyDraftDisposition::Recorded}else{StrategyDraftDisposition::ConfirmedNotApplied}));
        }
    };
    Ok(store.strategy_request_settlement_observation(&request)?.map(|recorded|if recorded{
        StrategyDraftDisposition::Recorded}else{StrategyDraftDisposition::ConfirmedNotApplied}))
}
#[tauri::command]
pub async fn read_local_strategy_draft(state:State<'_,AppState>,request:StrategyDraftReadRequest)->Result<StrategyDraftHead,CommandError>{
    journal(&state,request.session_token,request.key.project_id,move|d|d.read_strategy(&request.key)).await
}
#[tauri::command]
pub async fn write_local_strategy_draft(state:State<'_,AppState>,request:StrategyDraftWriteRequest)->Result<StrategyDraftHead,CommandError>{
    journal(&state,request.session_token,request.write.key.project_id,move|d|d.write_strategy(&request.write)).await
}
#[tauri::command]
pub async fn clear_local_strategy_draft(state:State<'_,AppState>,request:StrategyDraftClearRequest)->Result<StrategyDraftHead,CommandError>{
    journal(&state,request.session_token,request.clear.key.project_id,move|d|d.clear_strategy(&request.clear)).await
}
#[tauri::command]
pub async fn list_local_strategy_drafts(state:State<'_,AppState>,request:StrategyDraftListRequest)->Result<StrategyDraftPage,CommandError>{
    journal(&state,request.session_token,request.key.project_id,move|d|d.list_strategies(&request.key,request.after.as_ref(),request.limit)).await
}
#[tauri::command]
pub async fn read_local_strategy_action(state:State<'_,AppState>,request:StrategyDraftActionRequest)->Result<StrategyDraftAction,CommandError>{
    action(&state,request,false).await
}
#[tauri::command]
pub async fn close_local_strategy_action(state:State<'_,AppState>,request:StrategyDraftActionRequest)->Result<StrategyDraftAction,CommandError>{
    action(&state,request,true).await
}
async fn action(state:&AppState,request:StrategyDraftActionRequest,close:bool)->Result<StrategyDraftAction,CommandError>{
    if close {
        if !matches!(request.pending,StrategyDraftPending::Start{..}|StrategyDraftPending::Check{..}|StrategyDraftPending::PrepareCheck{..}){
            return Err(map_error(ExecutionError::new(ErrorCode::InvalidInput,"strategy-drafts-close")));
        }
        let original=request.clone();
        journal(state,request.session_token.clone(),request.key.project_id,move|d|{
            let head=d.read_strategy(&original.key)?;
            if head.value.as_ref().and_then(|v|v.pending.as_ref())!=Some(&original.pending){
                return Err(ExecutionError::new(ErrorCode::ResultMismatch,"strategy-drafts-pending"));
            }Ok(())
        }).await?;
    }
    let cancellations=state.review_check_cancellations.clone();
    state.sessions.run("local_strategy_action",CommandStage::DraftStorage,move|sessions|{
        let active=super::super::execution::authorized(sessions,&request.session_token,request.key.project_id,CommandStage::DraftStorage)?;
        let disposition=super::super::execution::strategy::observe_draft(active,&request.key,&request.pending,close)?;
        if close&&disposition!=Some(StrategyDraftDisposition::Recorded){
            let running=cancellations.lock().map_err(|_|CommandError::unknown(CommandStage::DraftStorage))?;
            if let Some((token,project,cancel))=running.get(&request.pending.action_id()){
                if token==&request.session_token&&*project==request.key.project_id{cancel.request();}
            }
        }
        let rejection=if disposition==Some(StrategyDraftDisposition::Rejected){super::super::execution::strategy::draft_rejection(active,&request.pending)}else{None};
        Ok(StrategyDraftAction{pending:request.pending,disposition,rejection})
    }).await
}
#[tauri::command]
pub async fn resolve_local_strategy_draft(state:State<'_,AppState>,request:StrategyDraftResolveRequest)->Result<StrategyDraftHead,CommandError>{
    let preview=request.resolve.clone();
    let (checked,acknowledged)=journal(&state,request.session_token.clone(),preview.write.key.project_id,move|d|d.check_strategy_resolution(&preview)).await?;
    if acknowledged{return Ok(checked);}
    let original=request.clone();
    state.sessions.run("local_strategy_drafts.resolve",CommandStage::DraftStorage,move|sessions|{
        let r=&original.resolve;
        let active=super::super::execution::authorized(sessions,&original.session_token,r.write.key.project_id,CommandStage::DraftStorage)?;
        let observed=super::super::execution::strategy::observe_draft(active,&r.write.key,&r.pending,false)?;
        if observed!=Some(r.disposition){return Err(map_error(ExecutionError::new(
            if observed.is_none(){ErrorCode::OutcomeUnknown}else{ErrorCode::ResultMismatch},"strategy-drafts-pending")));}Ok(())
    }).await?;
    journal(&state,request.session_token,request.resolve.write.key.project_id,move|d|d.resolve_strategy(&request.resolve)).await
}
#[cfg(test)]
mod tests;
