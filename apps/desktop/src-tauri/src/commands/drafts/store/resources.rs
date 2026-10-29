//! Resource input shares the original journal, compare-and-swap and quotas.
use super::*;
use std::collections::BTreeSet;

pub(super) const HEAD_SQL: &str = "CREATE TABLE resource_draft_heads (project_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=4456448), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))";
pub(super) const MAX_RECORD: usize = MAX_CONVERSATION_DRAFT_RECORD_BYTES;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

fn empty(key:&ResourceDraftKey)->ResourceDraftHead {
    ResourceDraftHead{key:key.clone(),revision:Revision::new(0).expect("zero revision"),writer_id:None,value:None}
}
pub(super) fn has_pending(value:&ResourceDraftValue)->bool {value.pending.is_some()||value.fact_pending.is_some()}
fn sequence(value:Revision)->Result<()> {
    if value.get()>MAX_SAFE_SEQUENCE {Err(fail(ErrorCode::LimitExceeded,"resource-drafts-sequence"))} else {Ok(())}
}
fn locale(value:&str,empty:bool)->Result<()> {
    if empty&&value.is_empty(){return Ok(());}
    if Locale::parse(value).is_ok_and(|l|l.as_str()==value){Ok(())}else{Err(fail(ErrorCode::InvalidInput,"resource-drafts-locale"))}
}
fn checked_key(value:&str)->Result<()> {
    if value.is_empty()||value.len()>1024||value.contains('\0'){Err(fail(ErrorCode::InvalidInput,"resource-drafts-key"))}else{Ok(())}
}
fn local_seq(seq:Revision,head:Revision)->Result<()> {
    sequence(seq)?;
    if seq>head{Err(fail(ErrorCode::InvalidInput,"resource-drafts-sequence"))}else{Ok(())}
}
pub(super) fn validate_value(key:&ResourceDraftKey,v:&ResourceDraftValue)->Result<()> {
    sequence(v.edit_seq)?;locale(&v.locale,true)?;
    if v.pending.is_some()&&v.fact_pending.is_some(){
        return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
    }
    local_seq(v.term_seq,v.edit_seq)?;local_seq(v.context_seq,v.edit_seq)?;
    if v.selected_term.as_ref().is_some_and(|t|t.locale!=v.locale)
        ||v.context_revision.as_ref().is_some_and(|c|c.locale!=v.locale
            ||v.selected_unit.as_ref().is_none_or(|u|u.unit_id!=c.unit_id)){
        return Err(fail(ErrorCode::InvalidInput,"resource-drafts-basis"));
    }
    if let Some(c)=&v.correction_draft {
        local_seq(c.edit_seq,v.edit_seq)?;
        if c.evidence.basis.project_id!=key.project_id{return Err(fail(ErrorCode::InvalidInput,"resource-drafts-project"));}
    }
    if let Some(f)=&v.fact_draft {
        checked_key(&f.key)?;local_seq(f.edit_seq,v.edit_seq)?;
        if f.basis.scope.project_id!=key.project_id{return Err(fail(ErrorCode::InvalidInput,"resource-drafts-project"));}
    }
    if v.typed_drafts.len()>128||v.knowledge_drafts.len()>128{
        return Err(fail(ErrorCode::LimitExceeded,"resource-drafts-count"));
    }
    let mut typed=BTreeSet::new();
    for d in &v.typed_drafts {
        checked_key(&d.key)?;locale(&d.locale,false)?;local_seq(d.edit_seq,v.edit_seq)?;
        if !typed.insert(&d.key)||d.base.as_ref().is_some_and(|b|b.project_id!=key.project_id
            ||b.kind!=d.kind||b.locale!=d.locale||d.context_id!=Some(b.context_id)){
            return Err(fail(ErrorCode::InvalidInput,"resource-drafts-typed"));
        }
    }
    let mut knowledge=BTreeSet::new();
    for d in &v.knowledge_drafts {
        checked_key(&d.key)?;locale(&d.locale,false)?;local_seq(d.edit_seq,v.edit_seq)?;
        if !knowledge.insert(&d.key)||d.proposal.project_id!=key.project_id
            ||d.target.as_ref().is_some_and(|t|t.project_id!=key.project_id)
            ||d.receipt.as_ref().is_some_and(|r|r.proposal!=d.proposal||r.entry_index!=d.entry_index){
            return Err(fail(ErrorCode::InvalidInput,"resource-drafts-knowledge"));
        }
    }
    if v.typed_active_key.as_ref().is_some_and(|k|!typed.contains(k))
        ||v.knowledge_active_key.as_ref().is_some_and(|k|!knowledge.contains(k)){
        return Err(fail(ErrorCode::InvalidInput,"resource-drafts-active"));
    }
    if let Some(p)=&v.pending {
        local_seq(p.submitted_seq(),v.edit_seq)?;
        let project=match p {
            ResourceDraftPending::TypedContextSave{request,draft_key,submitted_seq}=>{
                let d=v.typed_drafts.iter().find(|d|d.key==*draft_key)
                    .ok_or_else(||fail(ErrorCode::InvalidInput,"resource-drafts-pending"))?;
                if *submitted_seq>d.edit_seq||d.context_id!=request.context_id||d.kind!=request.kind
                    ||d.locale!=request.locale||d.base.as_ref().map(|b|b.revision_id)!=request.expected_revision_id{
                    return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
                }request.project_id
            }
            ResourceDraftPending::TypedContextWithdraw{request,draft_key,submitted_seq}=>{
                let d=v.typed_drafts.iter().find(|d|d.key==*draft_key)
                    .ok_or_else(||fail(ErrorCode::InvalidInput,"resource-drafts-pending"))?;
                if *submitted_seq>d.edit_seq||d.context_id!=Some(request.context_id)
                    ||d.base.as_ref().map(|b|b.revision_id)!=Some(request.expected_revision_id){
                    return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
                }request.project_id
            }
            ResourceDraftPending::KnowledgeDecision{request,draft_key,submitted_seq,..}=>{
                let d=v.knowledge_drafts.iter().find(|d|d.key==*draft_key)
                    .ok_or_else(||fail(ErrorCode::InvalidInput,"resource-drafts-pending"))?;
                if *submitted_seq>d.edit_seq||d.proposal!=request.proposal||d.entry_index!=request.entry_index{
                    return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
                }request.proposal.project_id
            }
            ResourceDraftPending::Correction{request,submitted_seq}=>{
                if v.correction_draft.as_ref().is_none_or(|d|*submitted_seq>d.edit_seq||d.evidence.basis!=request.basis){
                    return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
                }request.basis.project_id
            }
            ResourceDraftPending::Term{request,submitted_seq,..}=>{
                if *submitted_seq>v.term_seq||request.locale!=v.locale
                    ||v.selected_term.as_ref().map(|t|t.term_id.as_str())!=request.term_id.as_deref()
                    ||v.selected_term.as_ref().map(|t|t.revision_id)!=request.expected_revision_id{
                    return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
                }request.project_id
            }
            ResourceDraftPending::Context{request,submitted_seq}=>{
                if *submitted_seq>v.context_seq||request.locale!=v.locale
                    ||v.selected_unit.as_ref().is_none_or(|u|u.unit_id!=request.unit_id||u.source_revision_id!=request.source_revision_id)
                    ||v.context_revision.as_ref().map(|c|c.revision_id)!=request.expected_revision_id{
                    return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
                }request.project_id
            }
            ResourceDraftPending::Decision{request,locale:l,..}=>{locale(l,false)?;request.project_id}
            ResourceDraftPending::Capture{request,..}=>request.project_id,
        };
        if project!=key.project_id{return Err(fail(ErrorCode::InvalidInput,"resource-drafts-project"));}
    }
    if let Some(p)=&v.fact_pending {
        local_seq(p.submitted_seq,v.edit_seq)?;
        if p.request.basis.scope.project_id!=key.project_id||v.fact_draft.as_ref().is_none_or(|d|
            p.submitted_seq>d.edit_seq||d.basis!=p.request.basis||d.expected_decision_id!=p.request.expected_decision_id){
            return Err(fail(ErrorCode::InvalidInput,"resource-drafts-pending"));
        }
    }
    Ok(())
}
pub(super) type Stored=(i64,Option<i64>,i64,Option<Vec<u8>>);
pub(super) fn decode(key:&ResourceDraftKey,stored:Stored)->Result<ResourceDraftHead> {
    let (revision,seq,pending,payload)=stored;
    let bytes=payload.ok_or_else(||fail(ErrorCode::CorruptLedger,"resource-drafts-record"))?;
    let head:ResourceDraftHead=serde_json::from_slice(&bytes).map_err(|_|fail(ErrorCode::CorruptLedger,"resource-drafts-record"))?;
    let v=head.value.as_ref();
    if head.key!=*key||revision<=0||head.revision!=stored_revision(revision)?
        ||head.writer_id.is_some()!=v.is_some()||seq!=v.map(|v|v.edit_seq.get() as i64)
        ||pending!=i64::from(v.is_some_and(has_pending))
        ||v.is_some_and(|v|validate_value(key,v).is_err())
        ||encode_bounded(&head,MAX_RECORD).map_err(|_|fail(ErrorCode::CorruptLedger,"resource-drafts-record"))?!=bytes{
        return Err(fail(ErrorCode::CorruptLedger,"resource-drafts-record"));
    }Ok(head)
}
pub(super) fn validate_existing(connection: &Connection) -> Result<()> {
    let mut statement = connection.prepare("SELECT project_id,revision,edit_seq,has_pending,CASE WHEN length(payload)<=?1 THEN payload END FROM resource_draft_heads ORDER BY project_id").map_err(sql)?;
    let rows = statement.query_map([MAX_RECORD as i64], |row| Ok((row.get::<_,String>(0)?, (row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))).map_err(sql)?;
    for row in rows {
        let (project, stored) = row.map_err(sql)?;
        decode(&ResourceDraftKey { project_id: stored_id(&project)? }, stored)?;
    }
    Ok(())
}
fn read(c:&Connection,key:&ResourceDraftKey,format:i64)->Result<ResourceDraftHead>{
    if format<RESOURCE_FORMAT{return Ok(empty(key));}
    let row=c.query_row("SELECT revision,edit_seq,has_pending,CASE WHEN length(payload)<=?2 THEN payload END
        FROM resource_draft_heads WHERE project_id=?1",params![key.project_id.to_string(),MAX_RECORD as i64],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
    row.map(|r|decode(key,r)).transpose().map(|r|r.unwrap_or_else(||empty(key)))
}
fn persist(c:&Connection,h:&ResourceDraftHead,bytes:&[u8])->Result<()> {
    c.execute("INSERT INTO resource_draft_heads VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,edit_seq=excluded.edit_seq,
        has_pending=excluded.has_pending,payload=excluded.payload",params![h.key.project_id.to_string(),h.revision.get() as i64,
        h.value.as_ref().map(|v|v.edit_seq.get() as i64),i64::from(h.value.as_ref().is_some_and(has_pending)),bytes]).map_err(sql)?;Ok(())
}
fn apply(before:&ResourceDraftHead,r:&ResourceDraftWrite,resolve:Option<&ResourceDraftResolveTarget>)->Result<ResourceDraftHead>{
    if r.expected_revision<=before.revision&&before.writer_id==Some(r.writer_id)&&before.value.as_ref()==Some(&r.value){return Ok(before.clone());}
    if r.expected_revision!=before.revision{return Err(fail(ErrorCode::DependencyConflict,"drafts-revision"));}
    if before.value.as_ref().is_some_and(|v|r.value.edit_seq<=v.edit_seq){return Err(fail(ErrorCode::DependencyConflict,"drafts-edit-sequence"));}
    if let Some(old)=&before.value {
        let primary=matches!(resolve,Some(ResourceDraftResolveTarget::Primary{pending}) if old.pending.as_ref()==Some(pending)&&r.value.pending.is_none());
        let fact=matches!(resolve,Some(ResourceDraftResolveTarget::Fact{pending}) if old.fact_pending.as_ref()==Some(pending)&&r.value.fact_pending.is_none());
        if resolve.is_some()&&!primary&&!fact||!primary&&old.pending.is_some()&&old.pending!=r.value.pending
            ||!fact&&old.fact_pending.is_some()&&old.fact_pending!=r.value.fact_pending{
            return Err(fail(ErrorCode::DependencyConflict,"drafts-pending"));
        }
        if let Some(target)=resolve {keep_newer_input(old,&r.value,target)?;}
    }else if resolve.is_some(){return Err(fail(ErrorCode::DependencyConflict,"drafts-pending"));}
    Ok(ResourceDraftHead{key:r.key.clone(),revision:next_revision(before.revision)?,writer_id:Some(r.writer_id),value:Some(r.value.clone())})
}
fn keep_newer_input(old:&ResourceDraftValue,new:&ResourceDraftValue,target:&ResourceDraftResolveTarget)->Result<()> {
    let kept=match target {
        ResourceDraftResolveTarget::Primary{pending:ResourceDraftPending::Term{submitted_seq,..}}
            if old.term_seq>*submitted_seq=>old.term_draft==new.term_draft&&old.alias_input==new.alias_input&&old.term_seq==new.term_seq,
        ResourceDraftResolveTarget::Primary{pending:ResourceDraftPending::Context{submitted_seq,..}}
            if old.context_seq>*submitted_seq=>old.context_draft==new.context_draft&&old.context_reason==new.context_reason&&old.context_seq==new.context_seq,
        ResourceDraftResolveTarget::Primary{pending:ResourceDraftPending::Correction{submitted_seq,..}}
            if old.correction_draft.as_ref().is_some_and(|d|d.edit_seq>*submitted_seq)=>old.correction_draft==new.correction_draft,
        ResourceDraftResolveTarget::Primary{pending:ResourceDraftPending::TypedContextSave{draft_key,submitted_seq,..}
            |ResourceDraftPending::TypedContextWithdraw{draft_key,submitted_seq,..}}=>{
            match old.typed_drafts.iter().find(|d|d.key==*draft_key).filter(|d|d.edit_seq>*submitted_seq){
                None=>true,Some(a)=>new.typed_drafts.iter().find(|d|d.key==a.key).is_some_and(|b|
                    a.edit_seq==b.edit_seq&&a.name==b.name&&a.text==b.text&&a.scope==b.scope&&a.actor==b.actor&&a.reason==b.reason),
            }
        }
        ResourceDraftResolveTarget::Primary{pending:ResourceDraftPending::KnowledgeDecision{draft_key,submitted_seq,..}}=>{
            match old.knowledge_drafts.iter().find(|d|d.key==*draft_key).filter(|d|d.edit_seq>*submitted_seq){
                None=>true,Some(a)=>new.knowledge_drafts.iter().find(|d|d.key==a.key).is_some_and(|b|
                    a.edit_seq==b.edit_seq&&a.destination==b.destination&&a.target==b.target&&a.scope==b.scope
                    &&a.name==b.name&&a.text==b.text&&a.actor==b.actor&&a.reason==b.reason),
            }
        }
        ResourceDraftResolveTarget::Fact{pending}=>{
            match old.fact_draft.as_ref().filter(|d|d.edit_seq>pending.submitted_seq){
                None=>true,Some(a)=>new.fact_draft.as_ref().is_some_and(|b|a.edit_seq==b.edit_seq&&a.basis==b.basis
                    &&a.key==b.key&&a.disposition==b.disposition&&a.actor==b.actor&&a.reason==b.reason),
            }
        }
        _=>true,
    };
    if kept{Ok(())}else{Err(fail(ErrorCode::DependencyConflict,"resource-drafts-newer-input"))}
}
fn mutate_existing(c:&mut Connection,key:&ResourceDraftKey,apply:&impl Fn(&ResourceDraftHead)->Result<ResourceDraftHead>,limits:Limits)->Result<ResourceDraftHead>{
    let tx=c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(sql)?;
    let format=verify_schema(&tx)?;let before=read(&tx,key,format)?;let after=apply(&before)?;
    if before==after {
        if format<FORMAT{upgrade_schema(&tx,format)?;tx.commit().map_err(|_|fail(ErrorCode::OutcomeUnknown,"drafts-commit"))?;}
        return Ok(before);
    }
    let bytes=encode_bounded(&after,MAX_RECORD)?;
    let (tb,tr,pb,pr)=journal_usage(&tx,format,key.project_id)?;
    let old=if before.revision.get()==0{0}else{encode_bounded(&before,MAX_RECORD)?.len()};
    check_quota(pb as usize,tb as usize,pr as usize,tr as usize,old,bytes.len(),before.revision.get()==0,limits)?;
    upgrade_schema(&tx,format)?;persist(&tx,&after,&bytes)?;test_hook("resource-write-before-commit",Some(&tx));
    tx.commit().map_err(|_|fail(ErrorCode::OutcomeUnknown,"drafts-commit"))?;
    test_hook("resource-write-after-commit",None);Ok(after)
}
impl DraftStore {
    fn mutate_resource(&self,key:&ResourceDraftKey,apply:impl Fn(&ResourceDraftHead)->Result<ResourceDraftHead>)->Result<ResourceDraftHead>{
        if let Some(mut c)=self.existing(true)?{return mutate_existing(&mut c,key,&apply,self.limits);}
        let after=apply(&empty(key))?;if after.revision.get()==0{return Ok(after);}
        let bytes=encode_bounded(&after,MAX_RECORD)?;
        check_quota(0,0,0,0,0,bytes.len(),true,self.limits)?;
        self.initialize_or_retry(|tx|{persist(tx,&after,&bytes)?;Ok(after.clone())},|c|mutate_existing(c,key,&apply,self.limits))
    }
    pub fn read_resource(&self,key:&ResourceDraftKey)->Result<ResourceDraftHead>{
        let Some(mut c)=self.existing(false)?else{return Ok(empty(key));};
        let tx=c.transaction_with_behavior(TransactionBehavior::Deferred).map_err(sql)?;
        read(&tx,key,verify_schema(&tx)?)
    }
    pub fn write_resource(&self,r:&ResourceDraftWrite)->Result<ResourceDraftHead>{
        validate_value(&r.key,&r.value)?;self.mutate_resource(&r.key,|b|apply(b,r,None))
    }
    /// The command boundary first observes the exact original Core action.
    pub fn resolve_resource(&self,r:&ResourceDraftResolve)->Result<ResourceDraftHead>{
        validate_value(&r.write.key,&r.write.value)?;
        self.mutate_resource(&r.write.key,|b|apply(b,&r.write,Some(&r.target)))
    }
    pub fn clear_resource(&self,r:&ResourceDraftClear)->Result<ResourceDraftHead>{
        self.mutate_resource(&r.key,|b|{
            if b.revision!=r.expected_revision{return Err(fail(ErrorCode::DependencyConflict,"drafts-revision"));}
            if b.value.as_ref().is_some_and(has_pending){return Err(fail(ErrorCode::DependencyConflict,"drafts-pending"));}
            if b.value.is_none()&&b.revision.get()>0{return Ok(b.clone());}
            Ok(ResourceDraftHead{key:r.key.clone(),revision:next_revision(b.revision)?,writer_id:None,value:None})
        })
    }
}

#[cfg(test)]
mod tests;
