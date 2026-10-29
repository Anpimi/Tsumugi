//! Strategy input shares the existing journal, quotas and compare-and-swap owner.
use super::*;
pub(super) const HEAD_SQL:&str="CREATE TABLE strategy_draft_heads (project_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), edit_seq INTEGER, has_pending INTEGER NOT NULL CHECK(has_pending IN(0,1)), payload BLOB NOT NULL CHECK(length(payload)<=4456448), CHECK(edit_seq IS NOT NULL OR has_pending=0), CHECK(edit_seq IS NULL OR edit_seq>=0))";
pub(super) const MAX_RECORD:usize=MAX_CONVERSATION_DRAFT_RECORD_BYTES;
fn empty(key:&StrategyDraftKey)->StrategyDraftHead{StrategyDraftHead{key:key.clone(),revision:Revision::new(0).expect("zero"),writer_id:None,value:None}}
pub(super) fn has_pending(v:&StrategyDraftValue)->bool{v.pending.is_some()}
fn sequence(v:Revision)->Result<()>{if v.get()>9_007_199_254_740_991{Err(fail(ErrorCode::LimitExceeded,"strategy-drafts-sequence"))}else{Ok(())}}
pub(super) fn validate_value(key:&StrategyDraftKey,v:&StrategyDraftValue)->Result<()>{
    for (field,draft) in &v.number_drafts {
        let baseline=match field {
            StrategyDraftNumber::SourceContextMaxBytes=>v.source_context.max_bytes,
            StrategyDraftNumber::SourceContextMaxItems=>v.source_context.max_items,
            StrategyDraftNumber::ConfigMaxItems=>v.config.max_items,
            StrategyDraftNumber::ConfigConcurrency=>v.config.concurrency,
            StrategyDraftNumber::ConfigMaxRequests=>v.config.max_requests,
            StrategyDraftNumber::ConfigMaxOutputTokens=>v.config.max_output_tokens,
            StrategyDraftNumber::ConfigMaxRetries=>v.config.max_retries,
            StrategyDraftNumber::ConfigTimeoutSeconds=>v.config.timeout_seconds,
        };
        if baseline!=draft.previous{return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-number"));}
    }
    for seq in [v.edit_seq,v.candidate_edit_seq,v.candidate_saved_seq,v.suite_edit_seq,v.suite_saved_seq]{sequence(seq)?;}
    if !v.locale.is_empty()&&!Locale::parse(&v.locale).is_ok_and(|l|l.as_str()==v.locale){return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-locale"));}
    if v.candidate_edit_seq>v.edit_seq||v.suite_edit_seq>v.edit_seq||v.candidate_saved_seq>v.candidate_edit_seq||v.suite_saved_seq>v.suite_edit_seq
        ||v.evidence.as_ref().is_some_and(|e|e.basis.project_id!=key.project_id)
        ||v.candidate.as_ref().is_some_and(|c|c.project_id!=key.project_id)
        ||v.suite.as_ref().is_some_and(|s|s.project_id!=key.project_id||s.request.project_id!=key.project_id){
        return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-basis"));
    }
    for judgment in v.judgments.values(){sequence(judgment.edit_seq)?;sequence(judgment.saved_seq)?;
        if judgment.saved_seq>judgment.edit_seq{return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-sequence"));}}
    if let Some(p)=&v.pending {
        sequence(p.edit_seq())?;
        if p.project_id()!=key.project_id||p.submitted_seq()>v.journal_seq||p.edit_seq()>v.edit_seq{return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-pending"));}
        let project=match p {
            StrategyDraftPending::Candidate{request,..}=>request.capture.basis.project_id,
            StrategyDraftPending::Suite{request,candidate,..}=>{if candidate.project_id!=key.project_id{return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-project"));}request.capture.project_id},
            StrategyDraftPending::Prepare{request,suite,..}=>{if suite.project_id!=key.project_id{return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-project"));}request.capture.project_id},
            StrategyDraftPending::Judgment{request,draft_seq,..}=>{sequence(*draft_seq)?;request.judgment.project_id},
            StrategyDraftPending::Promote{request,..}=>request.promotion.project_id,
            StrategyDraftPending::Withdraw{request,..}=>request.withdrawal.project_id,
            StrategyDraftPending::PrepareCheck{request,..}=>request.check.project_id,
            StrategyDraftPending::Check{request,..}=>{if request.check.project_id!=key.project_id||request.executions.iter().any(|e|e.project_id!=key.project_id){return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-project"));}request.check.check.project_id},
            StrategyDraftPending::Start{request,..}=>request.project_id,
            StrategyDraftPending::SaveCandidate{request,..}=>request.project_id,
        };
        if project!=key.project_id{return Err(fail(ErrorCode::InvalidInput,"strategy-drafts-project"));}
    }
    Ok(())
}
pub(super) type Stored=(i64,Option<i64>,i64,Option<Vec<u8>>);
pub(super) fn decode(key:&StrategyDraftKey,stored:Stored)->Result<StrategyDraftHead> {
    let (revision,seq,pending,payload)=stored;
    let bytes=payload.ok_or_else(||fail(ErrorCode::CorruptLedger,"strategy-drafts-record"))?;
    let head:StrategyDraftHead=serde_json::from_slice(&bytes).map_err(|_|fail(ErrorCode::CorruptLedger,"strategy-drafts-record"))?;
    let v=head.value.as_ref();
    if head.key!=*key||revision<=0||head.revision!=stored_revision(revision)?
        ||head.writer_id.is_some()!=v.is_some()||seq!=v.map(|v|v.journal_seq.get() as i64)
        ||pending!=i64::from(v.is_some_and(has_pending))
        ||v.is_some_and(|v|validate_value(key,v).is_err())
        ||encode_bounded(&head,MAX_RECORD).map_err(|_|fail(ErrorCode::CorruptLedger,"strategy-drafts-record"))?!=bytes{
        return Err(fail(ErrorCode::CorruptLedger,"strategy-drafts-record"));
    }Ok(head)
}
fn read(c:&Connection,key:&StrategyDraftKey,format:i64)->Result<StrategyDraftHead>{
    if format<STRATEGY_FORMAT{return Ok(empty(key));}
    let row=c.query_row("SELECT revision,edit_seq,has_pending,CASE WHEN length(payload)<=?2 THEN payload END
        FROM strategy_draft_heads WHERE project_id=?1",params![key.project_id.to_string(),MAX_RECORD as i64],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(sql)?;
    row.map(|r|decode(key,r)).transpose().map(|r|r.unwrap_or_else(||empty(key)))
}
fn persist(c:&Connection,h:&StrategyDraftHead,bytes:&[u8])->Result<()> {
    c.execute("INSERT INTO strategy_draft_heads VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,edit_seq=excluded.edit_seq,
        has_pending=excluded.has_pending,payload=excluded.payload",params![h.key.project_id.to_string(),h.revision.get() as i64,
        h.value.as_ref().map(|v|v.journal_seq.get() as i64),i64::from(h.value.as_ref().is_some_and(has_pending)),bytes]).map_err(sql)?;Ok(())
}
fn apply(before:&StrategyDraftHead,r:&StrategyDraftWrite,resolve:Option<&StrategyDraftPending>)->Result<StrategyDraftHead>{
    if r.expected_revision<=before.revision&&before.writer_id==Some(r.writer_id)&&before.value.as_ref()==Some(&r.value){return Ok(before.clone());}
    if r.expected_revision!=before.revision{return Err(fail(ErrorCode::DependencyConflict,"drafts-revision"));}
    if before.value.as_ref().is_some_and(|v|r.value.journal_seq<=v.journal_seq){return Err(fail(ErrorCode::DependencyConflict,"drafts-edit-sequence"));}
    if let Some(old)=&before.value {
        let resolved=resolve.is_some_and(|p|old.pending.as_ref()==Some(p)&&r.value.pending.is_none());
        if resolve.is_some()&&!resolved||!resolved&&old.pending.is_some()&&old.pending!=r.value.pending {
            return Err(fail(ErrorCode::DependencyConflict,"drafts-pending"));
        }
        if resolved {keep_newer_input(old,&r.value,resolve.expect("resolved request"))?;}
    }else if resolve.is_some(){return Err(fail(ErrorCode::DependencyConflict,"drafts-pending"));}
    Ok(StrategyDraftHead{key:r.key.clone(),revision:next_revision(before.revision)?,writer_id:Some(r.writer_id),value:Some(r.value.clone())})
}
fn keep_newer_input(old:&StrategyDraftValue,new:&StrategyDraftValue,_p:&StrategyDraftPending)->Result<()> {
    // Settlement changes references and saved counters, never an editor buffer.
    let same=old.locale==new.locale&&old.correction_unit==new.correction_unit&&old.evidence==new.evidence
        &&old.source_context==new.source_context&&old.reason==new.reason&&old.exceptions==new.exceptions
        &&old.config==new.config&&old.roles==new.roles&&old.number_drafts==new.number_drafts&&old.edit_seq==new.edit_seq
        &&old.candidate_edit_seq==new.candidate_edit_seq&&old.suite_edit_seq==new.suite_edit_seq
        &&old.judgments.len()==new.judgments.len()&&old.judgments.iter().all(|(key,a)|new.judgments.get(key).is_some_and(|b|
            a.edit_seq==b.edit_seq&&a.preference==b.preference&&a.notes==b.notes&&a.elapsed==b.elapsed&&a.modified==b.modified));
    if same{Ok(())}else{Err(fail(ErrorCode::DependencyConflict,"strategy-drafts-newer-input"))}
}
fn mutate_existing(c:&mut Connection,key:&StrategyDraftKey,apply:&impl Fn(&StrategyDraftHead)->Result<StrategyDraftHead>,limits:Limits)->Result<StrategyDraftHead>{
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
    upgrade_schema(&tx,format)?;persist(&tx,&after,&bytes)?;test_hook("strategy-write-before-commit",Some(&tx));
    tx.commit().map_err(|_|fail(ErrorCode::OutcomeUnknown,"drafts-commit"))?;
    test_hook("strategy-write-after-commit",None);Ok(after)
}
impl DraftStore {
    fn mutate_strategy(&self,key:&StrategyDraftKey,apply:impl Fn(&StrategyDraftHead)->Result<StrategyDraftHead>)->Result<StrategyDraftHead>{
        if let Some(mut c)=self.existing(true)?{return mutate_existing(&mut c,key,&apply,self.limits);}
        let after=apply(&empty(key))?;if after.revision.get()==0{return Ok(after);}
        let bytes=encode_bounded(&after,MAX_RECORD)?;
        check_quota(0,0,0,0,0,bytes.len(),true,self.limits)?;
        self.initialize_or_retry(|tx|{persist(tx,&after,&bytes)?;Ok(after.clone())},|c|mutate_existing(c,key,&apply,self.limits))
    }
    pub fn read_strategy(&self,key:&StrategyDraftKey)->Result<StrategyDraftHead>{
        let Some(mut c)=self.existing(false)?else{return Ok(empty(key));};
        let tx=c.transaction_with_behavior(TransactionBehavior::Deferred).map_err(sql)?;
        read(&tx,key,verify_schema(&tx)?)
    }
    pub fn write_strategy(&self,r:&StrategyDraftWrite)->Result<StrategyDraftHead>{
        validate_value(&r.key,&r.value)?;self.mutate_strategy(&r.key,|b|apply(b,r,None))
    }
    /// The command boundary first observes the exact original Core action.
    pub fn resolve_strategy(&self,r:&StrategyDraftResolve)->Result<StrategyDraftHead>{
        validate_value(&r.write.key,&r.write.value)?;
        self.mutate_strategy(&r.write.key,|b|apply(b,&r.write,Some(&r.pending)))
    }
    pub fn clear_strategy(&self,r:&StrategyDraftClear)->Result<StrategyDraftHead>{
        self.mutate_strategy(&r.key,|b|{
            if b.revision!=r.expected_revision{return Err(fail(ErrorCode::DependencyConflict,"drafts-revision"));}
            if b.value.as_ref().is_some_and(has_pending){return Err(fail(ErrorCode::DependencyConflict,"drafts-pending"));}
            if b.value.is_none()&&b.revision.get()>0{return Ok(b.clone());}
            Ok(StrategyDraftHead{key:r.key.clone(),revision:next_revision(b.revision)?,writer_id:None,value:None})
        })
    }
}

impl DraftStore {
    pub fn list_strategies(&self,key:&StrategyDraftKey,after:Option<&StrategyDraftKey>,limit:u32)->Result<StrategyDraftPage>{
        if limit==0||limit>MAX_DRAFT_PAGE_SIZE||after.is_some_and(|a|a.project_id!=key.project_id){return Err(fail(ErrorCode::InvalidInput,"drafts-page"));}
        let head=self.read_strategy(key)?;
        Ok(StrategyDraftPage{items:if after.is_none()&&head.value.is_some(){vec![head]}else{vec![]},next_after:None})
    }
    pub fn check_strategy_resolution(&self,r:&StrategyDraftResolve)->Result<(StrategyDraftHead,bool)>{
        validate_value(&r.write.key,&r.write.value)?;let before=self.read_strategy(&r.write.key)?;let after=apply(&before,&r.write,Some(&r.pending))?;
        let acknowledged=before==after;Ok((after,acknowledged))
    }
}
#[cfg(test)]
mod tests;
