//! Append-only interpretation changes beside the immutable adoption authority.
use super::*;
use rusqlite::OptionalExtension;
use std::collections::{BTreeMap, BTreeSet};

pub(in crate::persistence) const TABLES: &[(&str, &str)] = &[
    ("source_lineage_corrections", "CREATE TABLE source_lineage_corrections (
        action_id TEXT PRIMARY KEY NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
        mapping_revision INTEGER NOT NULL CHECK(mapping_revision>0),
        request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 4194304),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
        receipt BLOB NOT NULL CHECK(length(receipt) BETWEEN 1 AND 4194304),
        receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=64),
        UNIQUE(snapshot_id,mapping_revision))"),
    ("source_lineage_correction_bindings", "CREATE TABLE source_lineage_correction_bindings (
        action_id TEXT NOT NULL REFERENCES source_lineage_corrections(action_id),
        occurrence_id TEXT NOT NULL REFERENCES source_occurrences(occurrence_id),
        unit_id TEXT NOT NULL REFERENCES source_units(unit_id), revision_id TEXT NOT NULL,
        predecessor_id TEXT REFERENCES source_occurrences(occurrence_id),
        relation TEXT NOT NULL CHECK(relation IN ('unchanged','changed','new','unresolved')),
        PRIMARY KEY(action_id,occurrence_id),
        FOREIGN KEY(unit_id,revision_id) REFERENCES source_revisions(unit_id,revision_id),
        CHECK((relation='new' AND predecessor_id IS NULL) OR (relation!='new' AND predecessor_id IS NOT NULL)))"),
    ("source_snapshot_mapping_bases", "CREATE TABLE source_snapshot_mapping_bases (
        snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
        base_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
        mapping_revision INTEGER NOT NULL CHECK(mapping_revision>=0),
        PRIMARY KEY(snapshot_id,base_snapshot_id))"),
    ("source_lineage_correction_closures", "CREATE TABLE source_lineage_correction_closures (
        action_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
        request BLOB NOT NULL CHECK(length(request) BETWEEN 1 AND 4194304),
        request_digest TEXT NOT NULL CHECK(length(request_digest)=64))"),
];

pub(in crate::persistence) const VIEWS: &[(&str, &str)] = &[
    ("source_effective_occurrences", "CREATE VIEW source_effective_occurrences AS
        SELECT o.rowid AS rowid,o.occurrence_id,o.snapshot_id,o.ordinal,o.artifact_id,
        COALESCE(b.unit_id,o.unit_id) AS unit_id,COALESCE(b.revision_id,o.revision_id) AS revision_id,
        o.namespace,o.native_key,o.comparison_key,o.key_start,o.key_end,o.value_start,o.value_end,
        o.local_unit_id,o.local_occurrence_id,o.local_revision_id,o.projection
        FROM source_occurrences o LEFT JOIN source_lineage_correction_bindings b
        ON b.occurrence_id=o.occurrence_id AND b.action_id=(
          SELECT c.action_id FROM source_lineage_corrections c
          JOIN source_lineage_correction_bindings x ON x.action_id=c.action_id
          WHERE x.occurrence_id=o.occurrence_id ORDER BY c.mapping_revision DESC LIMIT 1)"),
    ("source_binding_history", "CREATE VIEW source_binding_history AS
        SELECT o.rowid AS rowid,o.occurrence_id,o.snapshot_id,o.ordinal,o.artifact_id,o.unit_id,o.revision_id,
        o.namespace,o.native_key,o.comparison_key,o.key_start,o.key_end,o.value_start,o.value_end,
        o.local_unit_id,o.local_occurrence_id,o.local_revision_id,o.projection,0 AS mapping_revision
        FROM source_occurrences o UNION ALL
        SELECT o.rowid,o.occurrence_id,o.snapshot_id,o.ordinal,o.artifact_id,b.unit_id,b.revision_id,
        o.namespace,o.native_key,o.comparison_key,o.key_start,o.key_end,o.value_start,o.value_end,
        o.local_unit_id,o.local_occurrence_id,o.local_revision_id,o.projection,c.mapping_revision
        FROM source_occurrences o JOIN source_lineage_correction_bindings b ON b.occurrence_id=o.occurrence_id
        JOIN source_lineage_corrections c ON c.action_id=b.action_id"),
    ("source_effective_lineage", "CREATE VIEW source_effective_lineage AS
        SELECT l.occurrence_id,CASE WHEN b.action_id IS NULL THEN l.predecessor_id ELSE b.predecessor_id END AS predecessor_id,
        COALESCE(b.relation,l.relation) AS relation
        FROM source_lineage l LEFT JOIN source_lineage_correction_bindings b
        ON b.occurrence_id=l.occurrence_id AND b.action_id=(
          SELECT c.action_id FROM source_lineage_corrections c
          JOIN source_lineage_correction_bindings x ON x.action_id=c.action_id
          WHERE x.occurrence_id=l.occurrence_id ORDER BY c.mapping_revision DESC LIMIT 1)"),
];

pub(in crate::persistence) fn initialize(c: &Connection) -> rusqlite::Result<()> {
    for (_, sql) in TABLES { c.execute_batch(sql)?; }
    for (_, sql) in VIEWS { c.execute_batch(sql)?; }
    Ok(())
}

#[cfg(test)]
pub(in crate::persistence) fn make_legacy_schema(c:&Connection)->rusqlite::Result<()> {
    for (name,_) in VIEWS {c.execute_batch(&format!("DROP VIEW {name}"))?;}
    c.execute_batch("DROP TABLE source_lineage_correction_bindings; DROP TABLE source_lineage_corrections; DROP TABLE source_snapshot_mapping_bases; DROP TABLE source_lineage_correction_closures;")
}

// Old supported schemas are fully validated before the atomic migration. These
// transaction-local aliases expose exactly their original, uncorrected facts.
pub(in crate::persistence) fn legacy_read_views(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("CREATE TEMP VIEW source_effective_occurrences AS SELECT rowid AS rowid,* FROM main.source_occurrences;
        CREATE TEMP VIEW source_binding_history AS SELECT rowid AS rowid,*,0 AS mapping_revision FROM main.source_occurrences;
        CREATE TEMP VIEW source_effective_lineage AS SELECT * FROM main.source_lineage;")
}
pub(in crate::persistence) fn remove_legacy_read_views(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("DROP VIEW temp.source_effective_occurrences; DROP VIEW temp.source_binding_history; DROP VIEW temp.source_effective_lineage;")
}

pub(in crate::persistence) fn mapping_revision(c: &Connection, snapshot: ExecutionId) -> Result<Revision, ExecutionError> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_lineage_corrections')",[],|r|r.get(0)).map_err(sql_error)?;
    if !exists {return Revision::new(0);}
    let revision: i64 = c.query_row("SELECT COALESCE(MAX(mapping_revision),0) FROM source_lineage_corrections WHERE snapshot_id=?1",
        [snapshot.to_string()], |r| r.get(0)).map_err(sql_error)?;
    Revision::new(u64::try_from(revision).map_err(|_| corrupt())?)
}

fn occurrence_revision(c:&Connection,occurrence:ExecutionId,cap:Revision)->Result<Revision,ExecutionError>{
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_lineage_corrections')",[],|r|r.get(0)).map_err(sql_error)?;
    if !exists{return Revision::new(0);}
    let version:i64=c.query_row("SELECT COALESCE(MAX(a.mapping_revision),0) FROM source_lineage_corrections a JOIN source_lineage_correction_bindings b ON b.action_id=a.action_id WHERE b.occurrence_id=?1 AND a.mapping_revision<=?2",params![occurrence.to_string(),cap.get() as i64],|r|r.get(0)).map_err(sql_error)?;
    Revision::new(version as u64)
}

pub(in crate::persistence) fn effective_rows(c: &Connection, rows: &mut [ContentRow]) -> Result<(), ExecutionError> {
    for row in rows {
        let (unit, revision): (String, String) = c.query_row(
            "SELECT unit_id,revision_id FROM source_effective_occurrences WHERE occurrence_id=?1",
            [row.occurrence_id.ok_or_else(corrupt)?.to_string()], |r| Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?;
        row.unit_id = Some(id(unit)?);
        row.source_revision_id = Some(id(revision)?);
    }
    Ok(())
}

pub(in crate::persistence) fn binding_at(c: &Connection, occurrence: ExecutionId, revision: Revision) -> Result<(ExecutionId, ExecutionId), ExecutionError> {
    let (unit, source): (String, String) = c.query_row(
        "SELECT unit_id,revision_id FROM source_binding_history WHERE occurrence_id=?1 AND mapping_revision<=?2 ORDER BY mapping_revision DESC LIMIT 1",
        params![occurrence.to_string(),revision.get() as i64], |r| Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?;
    Ok((id(unit)?,id(source)?))
}

fn binding_at_version(c:&Connection,occurrence:ExecutionId,version:Revision)->Result<SourceLineageBinding,ExecutionError>{
    let (unit,source)=binding_at(c,occurrence,version)?;
    let corrected:Option<(Option<String>,String)>=if version.get()==0 {None} else {
        c.query_row("SELECT b.predecessor_id,b.relation FROM source_lineage_correction_bindings b JOIN source_lineage_corrections a ON a.action_id=b.action_id WHERE b.occurrence_id=?1 AND a.mapping_revision<=?2 ORDER BY a.mapping_revision DESC LIMIT 1",params![occurrence.to_string(),version.get() as i64],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql_error)?
    };
    let (predecessor,relation)=match corrected {Some(value)=>value,None=>c.query_row("SELECT predecessor_id,relation FROM source_lineage WHERE occurrence_id=?1",[occurrence.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?};
    Ok(SourceLineageBinding{occurrence_id:occurrence,unit_id:unit,source_revision_id:source,predecessor_id:predecessor.map(id).transpose()?,relation})
}

pub(in crate::persistence) fn unresolved_origin(c:&Connection,occurrence:ExecutionId,version:Revision)->Result<Option<Vec<SourceLineageOrigin>>,ExecutionError>{
    let mut occurrence=occurrence;let mut version=version;let mut seen=BTreeSet::new();let mut chain=Vec::new();
    loop {
        if !seen.insert(occurrence){return Err(corrupt());}
        let snapshot:String=c.query_row("SELECT snapshot_id FROM source_occurrences WHERE occurrence_id=?1",[occurrence.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let snapshot=id(snapshot)?;
        version=occurrence_revision(c,occurrence,version)?;
        chain.push(SourceLineageOrigin{snapshot_id:snapshot,occurrence_id:occurrence,mapping_revision:version});
        let current=binding_at_version(c,occurrence,version)?;
        if matches!(current.relation.as_str(),"new"|"unresolved") {
            let evidence:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_lineage_evidence WHERE new_occurrence_id=?1)",[occurrence.to_string()],|r|r.get(0)).map_err(sql_error)?;
            return Ok((evidence||version.get()>0).then_some(chain));
        }
        if !matches!(current.relation.as_str(),"unchanged"|"changed"){return Ok(None);}
        let old=current.predecessor_id.ok_or_else(corrupt)?;
        let old_snapshot:String=c.query_row("SELECT snapshot_id FROM source_occurrences WHERE occurrence_id=?1",[old.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let old_snapshot=id(old_snapshot)?;
        let has_bases:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_snapshot_mapping_bases')",[],|r|r.get(0)).map_err(sql_error)?;
        let captured=if has_bases {c.query_row("SELECT mapping_revision FROM source_snapshot_mapping_bases WHERE snapshot_id=?1 AND base_snapshot_id=?2",params![snapshot.to_string(),old_snapshot.to_string()],|r|r.get::<_,i64>(0)).optional().map_err(sql_error)?} else {None};
        let old_version=match captured {Some(v)=>Revision::new(v as u64)?,None=>mapping_revision(c,old_snapshot)?};
        if binding_at(c,old,old_version)?.0!=current.unit_id{return Err(corrupt());}
        occurrence=old;version=old_version;
        if chain.len()>MAX_OCCURRENCES{return Err(failure(ErrorCode::LimitExceeded,"source-lineage-depth"));}
    }
}

fn origin_base(c:&Connection,origin:&SourceLineageOrigin)->Result<ExecutionId,ExecutionError>{
    if let Some(receipt)=receipts_in(c,origin.snapshot_id)?.into_iter().rev().find(|r|r.mapping_revision<=origin.mapping_revision&&r.current_bindings.iter().any(|b|b.occurrence_id==origin.occurrence_id)) {
        return Ok(receipt.request.basis.previous_snapshot_id);
    }
    let bytes:Vec<u8>=c.query_row("SELECT a.request FROM source_snapshots s JOIN adoption_receipts r ON r.attempt_id=s.attempt_id JOIN execution_actions a ON a.action_id=r.action_id WHERE s.snapshot_id=?1",[origin.snapshot_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
    let action:AdoptionAction=codec::decode(&bytes,MAX_INPUT_BYTES)?;
    let confirmation:SourceConfirmation=from_value(&action.parameters)?;
    confirmation.lineage_base_snapshot.or(confirmation.expected_current_snapshot).ok_or_else(||failure(ErrorCode::InvalidInput,"source-lineage-initial"))
}

pub(in crate::persistence) fn frozen_predecessor(c: &Connection, snapshot: ExecutionId, occurrence: ExecutionId) -> Result<(ExecutionId, ExecutionId), ExecutionError> {
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_snapshot_mapping_bases')",[],|r|r.get(0)).map_err(sql_error)?;
    if !exists {return binding_at(c,occurrence,Revision::new(0)?);}
    let version: Option<i64> = c.query_row(
        "SELECT b.mapping_revision FROM source_snapshot_mapping_bases b JOIN source_occurrences o ON o.snapshot_id=b.base_snapshot_id WHERE b.snapshot_id=?1 AND o.occurrence_id=?2",
        params![snapshot.to_string(),occurrence.to_string()], |r| r.get(0)).optional().map_err(sql_error)?;
    binding_at(c, occurrence, Revision::new(version.unwrap_or(0) as u64)?)
}

pub(in crate::persistence) fn validate(c:&Connection)->Result<(),ExecutionError>{
    for (name,expected) in TABLES.iter().chain(VIEWS.iter()) {
        let actual:String=c.query_row("SELECT sql FROM sqlite_master WHERE name=?1",[name],|r|r.get(0)).map_err(sql_error)?;
        if actual!=*expected {return Err(corrupt());}
    }
    let project=id(super::super::read_metadata_from(c).map_err(|_|corrupt())?.project_id().to_string())?;
    let mut closures=c.prepare("SELECT action_id,project_id,snapshot_id,request,request_digest FROM source_lineage_correction_closures").map_err(sql_error)?;
    for row in closures.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Vec<u8>>(3)?,r.get::<_,String>(4)?))).map_err(sql_error)? {
        let (action,owner,snapshot,bytes,digest)=row.map_err(sql_error)?;
        let request:CorrectSourceLineage=codec::decode(&bytes,MAX_INPUT_BYTES)?;
        if codec::digest(&bytes)!=digest || action!=request.action_id.to_string() || owner!=project.to_string() || request.project_id!=project
            || snapshot!=request.basis.snapshot_id.to_string() || receipt_in(c,request.action_id)?.is_some(){return Err(corrupt());}
        check_request(c,&request)?;
    }
    let mut q=c.prepare("SELECT snapshot_id FROM source_snapshots").map_err(sql_error)?;
    let snapshots=q.query_map([],|r|r.get::<_,String>(0)).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?;
    for snapshot in snapshots {
        let snapshot=id(snapshot)?;
        let (scope_revision,(input,result,_,rows))=snapshot_rows(c,snapshot,true)?;
        let original:Vec<u8>=c.query_row("SELECT a.request FROM execution_actions a JOIN adoption_receipts r ON r.action_id=a.action_id WHERE r.attempt_id=?1",[input.envelope().attempt_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let original:AdoptionAction=codec::decode(&original,MAX_INPUT_BYTES)?;
        let original:SourceConfirmation=from_value(&original.parameters)?;
        if let Some(previous)=original.expected_current_snapshot {
            let frozen:Option<i64>=c.query_row("SELECT mapping_revision FROM source_snapshot_mapping_bases WHERE snapshot_id=?1 AND base_snapshot_id=?2",params![snapshot.to_string(),previous.to_string()],|r|r.get(0)).optional().map_err(sql_error)?;
            if frozen.unwrap_or(0) as u64!=original.expected_mapping_revision.map_or(0,Revision::get){return Err(corrupt());}
        }
        let raw=rows.iter().map(|r|(r.occurrence_id.unwrap(),r)).collect::<BTreeMap<_,_>>();
        let mut version=0;
        for receipt in receipts_in(c,snapshot)? {
            let request=&receipt.request;
            check_request(c,request)?;
            version+=1;
            if receipt.mapping_revision.get()!=version || request.project_id!=project || request.basis.project_id!=project
                || request.basis.result_id!=result.envelope().result_id || request.basis.result_digest!=result.digest()
                || request.basis.scope.current_snapshot!=Some(snapshot) || request.basis.scope.revision.get()!=scope_revision
                || receipt.current_bindings.len()!=receipt.previous_bindings.len() || receipt.current_bindings.is_empty() {
                return Err(corrupt());
            }
            let mut expected=BTreeSet::new();
            for (previous,next) in receipt.previous_bindings.iter().zip(&receipt.current_bindings) {
                let source=raw.get(&next.occurrence_id).ok_or_else(corrupt)?;
                let before=binding_at(c,previous.occurrence_id,request.basis.mapping_revision)?;
                let (owner,text):(String,String)=c.query_row("SELECT u.project_id,r.text FROM source_units u JOIN source_revisions r ON r.unit_id=u.unit_id WHERE u.unit_id=?1 AND r.revision_id=?2",params![next.unit_id.to_string(),next.source_revision_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?;
                if previous.occurrence_id!=next.occurrence_id || before!=(previous.unit_id,previous.source_revision_id)
                    || next.source_revision_id==previous.source_revision_id || owner!=project.to_string() || text!=source.occurrence.text
                    || !expected.insert(next.occurrence_id) {return Err(corrupt());}
                let (unit,revision,predecessor,relation):(String,String,Option<String>,String)=c.query_row("SELECT unit_id,revision_id,predecessor_id,relation FROM source_lineage_correction_bindings WHERE action_id=?1 AND occurrence_id=?2",params![request.action_id.to_string(),next.occurrence_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
                if unit!=next.unit_id.to_string() || revision!=next.source_revision_id.to_string() || predecessor!=next.predecessor_id.map(|id|id.to_string()) || relation!=next.relation {return Err(corrupt());}
                let old=next.predecessor_id.ok_or_else(corrupt)?;
                let old_row:Option<(String,String)>=c.query_row("SELECT snapshot_id,namespace FROM source_occurrences WHERE occurrence_id=?1",[old.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql_error)?;
                let allowed=old_row.as_ref().is_some_and(|(snapshot,namespace)|namespace==&source.occurrence.namespace
                    && (snapshot==&request.basis.previous_snapshot_id.to_string() || request.basis.origin_chain.iter().skip(1).any(|origin|origin.snapshot_id.to_string()==*snapshot&&origin.occurrence_id==old)));
                if !allowed {return Err(corrupt());}
                let old_unit:String=c.query_row("SELECT unit_id FROM source_effective_occurrences WHERE occurrence_id=?1",[old.to_string()],|r|r.get(0)).map_err(sql_error)?;
                if (next.relation=="changed"&&next.unit_id.to_string()!=old_unit)
                    || (next.relation=="unresolved"&&next.unit_id.to_string()==old_unit){return Err(corrupt());}
                let (number,prior):(i64,i64)=c.query_row("SELECT r.revision,COALESCE((SELECT MAX(p.revision) FROM source_binding_history h JOIN source_revisions p ON p.revision_id=h.revision_id WHERE h.unit_id=r.unit_id AND ((h.snapshot_id=?2 AND h.mapping_revision<=?3) OR h.snapshot_id=?4)),0) FROM source_revisions r WHERE r.revision_id=?1",params![next.source_revision_id.to_string(),snapshot.to_string(),request.basis.mapping_revision.get() as i64,request.basis.previous_snapshot_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(sql_error)?;
                if number<=prior{return Err(corrupt());}
            }
            let count:i64=c.query_row("SELECT COUNT(*) FROM source_lineage_correction_bindings WHERE action_id=?1",[request.action_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
            if count as usize!=expected.len(){return Err(corrupt());}
        }
    }
    let bad:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_snapshot_mapping_bases b WHERE b.mapping_revision!=(SELECT COALESCE(MAX(c.mapping_revision),0) FROM source_lineage_corrections c WHERE c.snapshot_id=b.base_snapshot_id))",[],|r|r.get(0)).map_err(sql_error)?;
    if bad{return Err(corrupt());}
    let bad:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM source_effective_occurrences GROUP BY snapshot_id,unit_id HAVING COUNT(DISTINCT local_unit_id)>1) OR EXISTS(SELECT 1 FROM source_effective_occurrences GROUP BY snapshot_id,local_unit_id HAVING COUNT(DISTINCT unit_id)>1 OR COUNT(DISTINCT revision_id)>1)",[],|r|r.get(0)).map_err(sql_error)?;
    if bad{return Err(corrupt());}
    Ok(())
}

fn binding(c: &Connection, occurrence: ExecutionId) -> Result<SourceLineageBinding, ExecutionError> {
    let (unit, source, predecessor, relation): (String,String,Option<String>,String) = c.query_row(
        "SELECT o.unit_id,o.revision_id,l.predecessor_id,l.relation FROM source_effective_occurrences o JOIN source_effective_lineage l ON l.occurrence_id=o.occurrence_id WHERE o.occurrence_id=?1",
        [occurrence.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(sql_error)?;
    Ok(SourceLineageBinding { occurrence_id:occurrence,unit_id:id(unit)?,source_revision_id:id(source)?,
        predecessor_id:predecessor.map(id).transpose()?,relation })
}

fn ids_in(c: &Connection, query: &str, unit: ExecutionId, locale: &str) -> Result<Vec<ExecutionId>, ExecutionError> {
    let mut q=c.prepare(query).map_err(sql_error)?;
    q.query_map(params![unit.to_string(),locale], |r| r.get::<_,String>(0)).map_err(sql_error)?
        .map(|r|id(r.map_err(sql_error)?)).collect()
}

fn saved_work(c: &Connection, project: ExecutionId, rows: &[ContentRow], units: &BTreeSet<ExecutionId>) -> Result<Vec<SourceLineageSavedWork>, ExecutionError> {
    let metadata=super::super::read_metadata_from(c).map_err(|_|corrupt())?;
    let mut work=Vec::new();
    for unit in units {
        if !unit_owned_by_project(c,project,*unit)? { return Err(corrupt()); }
        let mut locales=metadata.target_locales().iter().map(|l|l.as_str().to_owned()).collect::<BTreeSet<_>>();
        let mut q=c.prepare("SELECT DISTINCT locale FROM translation_revisions WHERE unit_id=?1").map_err(sql_error)?;
        locales.extend(q.query_map([unit.to_string()], |r|r.get::<_,String>(0)).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?);
        for locale in locales {
            let selection=super::super::translation::current_selection(c,*unit,&locale)?;
            let revisions=ids_in(c,"SELECT revision_id FROM translation_revisions WHERE unit_id=?1 AND locale=?2 ORDER BY ordinal",*unit,&locale)?;
            let review=ids_in(c,"SELECT action_id FROM review_decisions WHERE unit_id=?1 AND locale=?2 ORDER BY rowid",*unit,&locale)?;
            let checks=ids_in(c,"SELECT action_id FROM review_checks WHERE unit_id=?1 AND locale=?2 ORDER BY rowid",*unit,&locale)?;
            let waivers=ids_in(c,"SELECT action_id FROM review_waivers WHERE unit_id=?1 AND locale=?2 ORDER BY rowid",*unit,&locale)?;
            let fallbacks=ids_in(c,"SELECT action_id FROM review_fallbacks WHERE unit_id=?1 AND locale=?2 ORDER BY rowid",*unit,&locale)?;
            let protection:Option<(i64,bool)>=c.query_row("SELECT revision,protected FROM application_protections WHERE unit_id=?1 AND locale=?2",params![unit.to_string(),locale],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql_error)?;
            let context:Option<String>=c.query_row("SELECT revision_id FROM context_current WHERE unit_id=?1 AND locale=?2",params![unit.to_string(),locale],|r|r.get(0)).optional().map_err(sql_error)?;
            let source=rows.iter().find(|r|r.unit_id==Some(*unit)).ok_or_else(corrupt)?;
            let terms=super::super::resources::current_terms_in(c,project,&locale)?;
            let resolved=super::super::resources::resolve_terms_from(*unit,&locale,source.source_revision_id.ok_or_else(corrupt)?,&source.occurrence.text,&terms);
            let basis=codec::digest(&codec::encode(&(&selection,&revisions,&review,&checks,&waivers,&fallbacks,&protection,&context,&resolved),MAX_INPUT_BYTES)?);
            work.push(SourceLineageSavedWork { unit_id:*unit,locale,selection_id:selection.as_ref().map(|s|s.event_id),translation_revision_id:selection.as_ref().map(|s|s.revision_id),translation_revision_ids:revisions,review_action_ids:review,check_action_ids:checks,
                protection_revision:protection.map(|p|Revision::new(p.0 as u64)).transpose()?,protected:protection.is_some_and(|p|p.1),basis });
        }
    }
    Ok(work)
}

fn basis_in(c:&Connection,project:ExecutionId,snapshot:ExecutionId,ordinal:u32) -> Result<SourceLineageCorrectionBasis,ExecutionError> {
    let metadata=super::super::read_metadata_from(c).map_err(|_|corrupt())?;
    if metadata.project_id().to_string()!=project.to_string() { return Err(failure(ErrorCode::Unauthorized,"source-lineage-project")); }
    let scope=scope(c)?;
    if scope.current_snapshot!=Some(snapshot) { return Err(failure(ErrorCode::DependencyConflict,"source-lineage-current")); }
        let (_, (_,result,_,mut current))=snapshot_rows(c,snapshot,true)?;
    effective_rows(c,&mut current)?;
    let selected=current.get(ordinal as usize).cloned().ok_or_else(||failure(ErrorCode::InvalidInput,"source-lineage-ordinal"))?;
    let version=mapping_revision(c,snapshot)?;
    let local=occurrence_revision(c,selected.occurrence_id.ok_or_else(corrupt)?,version)?;
    let origin_chain=unresolved_origin(c,selected.occurrence_id.ok_or_else(corrupt)?,version)?.unwrap_or_else(||vec![SourceLineageOrigin{snapshot_id:snapshot,occurrence_id:selected.occurrence_id.unwrap(),mapping_revision:local}]);
    let origin=origin_chain.last().ok_or_else(corrupt)?;
    let previous=origin_base(c,origin)?;
    let (_,(_,_,_,mut old))=snapshot_rows(c,previous,true)?;
    effective_rows(c,&mut old)?;
    let (_,(_,_,_,mut origin_rows))=snapshot_rows(c,origin.snapshot_id,true)?;
    effective_rows(c,&mut origin_rows)?;
    let origin_row=origin_rows.iter().find(|r|r.occurrence_id==Some(origin.occurrence_id)).ok_or_else(corrupt)?;
    let group=current.iter().filter(|r|r.occurrence.operation_unit_id==selected.occurrence.operation_unit_id).collect::<Vec<_>>();
    let mut bindings=Vec::new();
    let mut candidates=Vec::new();
    let mut units=BTreeSet::new();
    let mut snapshots=BTreeMap::new();
    let mut edges=super::maintenance::lineage_evidence_in(c,origin_row,&mut snapshots)?;
    for row in group {
        bindings.push(binding(c,row.occurrence_id.ok_or_else(corrupt)?)?);
        units.insert(row.unit_id.ok_or_else(corrupt)?);
        edges.extend(super::maintenance::lineage_evidence_in(c,row,&mut snapshots)?);
    }
    let mut seen=BTreeSet::new();
    for edge in edges {
        if edge.old_snapshot_id==previous && seen.insert((edge.action_id,edge.old.occurrence_id)) {
            units.insert(edge.old.unit_id.ok_or_else(corrupt)?);candidates.push(edge);
        }
    }
    let mut work_rows=current;
    work_rows.extend(old);
    // Former B bindings remain visible after B is no longer current.
    for receipt in receipts_in(c,snapshot)? {
        for old_binding in receipt.previous_bindings {
            if bindings.iter().any(|b|b.occurrence_id==old_binding.occurrence_id) {
                units.insert(old_binding.unit_id);
                let mut row=work_rows.iter().find(|r|r.occurrence_id==Some(old_binding.occurrence_id)).cloned().ok_or_else(corrupt)?;
                row.unit_id=Some(old_binding.unit_id);row.source_revision_id=Some(old_binding.source_revision_id);
                work_rows.push(row);
            }
        }
    }
    let saved_work=saved_work(c,project,&work_rows,&units)?;
    Ok(SourceLineageCorrectionBasis {project_id:project,previous_snapshot_id:previous,snapshot_id:snapshot,result_id:result.envelope().result_id,
        result_digest:result.digest().into(),scope,mapping_revision:version,origin_chain,ordinal,bindings,candidates,saved_work})
}

fn receipt_in(c:&Connection,action:ExecutionId) -> Result<Option<SourceLineageCorrectionReceipt>,ExecutionError> {
    let row:Option<(String,i64,Vec<u8>,String,Vec<u8>,String)>=c.query_row("SELECT snapshot_id,mapping_revision,request,request_digest,receipt,receipt_digest FROM source_lineage_corrections WHERE action_id=?1",[action.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(sql_error)?;
    row.map(|(snapshot,version,request,rd,bytes,digest)|{
        if codec::digest(&request)!=rd || codec::digest(&bytes)!=digest { return Err(corrupt()); }
        let request:CorrectSourceLineage=codec::decode(&request,MAX_INPUT_BYTES)?;
        let receipt:SourceLineageCorrectionReceipt=codec::decode(&bytes,MAX_INPUT_BYTES)?;
        if receipt.request!=request || request.action_id!=action || request.basis.snapshot_id.to_string()!=snapshot
            || receipt.mapping_revision.get()!=version as u64 || receipt.mapping_revision<=request.basis.mapping_revision
            || receipt.previous_bindings!=request.basis.bindings || receipt.preserved_work!=request.basis.saved_work { return Err(corrupt()); }
        Ok(receipt)
    }).transpose()
}

fn closed_in(c:&Connection,request:&CorrectSourceLineage)->Result<bool,ExecutionError>{
    let saved:Option<(Vec<u8>,String)>=c.query_row("SELECT request,request_digest FROM source_lineage_correction_closures WHERE action_id=?1",[request.action_id.to_string()],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(sql_error)?;
    match saved {
        None=>Ok(false),
        Some((bytes,digest))=>{
            if codec::digest(&bytes)!=digest{return Err(corrupt());}
            let saved:CorrectSourceLineage=codec::decode(&bytes,MAX_INPUT_BYTES)?;
            if saved!=*request{return Err(failure(ErrorCode::ResultMismatch,"source-lineage-action"));}
            Ok(true)
        }
    }
}

pub(super) fn receipts_in(c:&Connection,snapshot:ExecutionId)->Result<Vec<SourceLineageCorrectionReceipt>,ExecutionError>{
    let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='source_lineage_corrections')",[],|r|r.get(0)).map_err(sql_error)?;
    if !exists {return Ok(Vec::new());}
    let mut q=c.prepare("SELECT action_id FROM source_lineage_corrections WHERE snapshot_id=?1 ORDER BY mapping_revision").map_err(sql_error)?;
    let actions=q.query_map([snapshot.to_string()],|r|r.get::<_,String>(0)).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?;
    actions.into_iter().map(|a|receipt_in(c,id(a)?)?.ok_or_else(corrupt)).collect()
}

fn invalid_shape(request:&CorrectSourceLineage)->bool {
    request.basis.project_id!=request.project_id || request.actor.trim()!=request.actor || request.actor.is_empty()
        || request.actor.len()>128 || request.actor.chars().any(char::is_control) || request.reason.trim().is_empty()
        || request.reason.len()>4096 || request.reason.contains('\0')
}

fn check_request(c:&Connection,request:&CorrectSourceLineage)->Result<(),ExecutionError>{
    let basis=&request.basis;
    if invalid_shape(request) {return Err(failure(ErrorCode::InvalidInput,"source-lineage-request"));}
    let (revision,(input,result,_,rows))=snapshot_rows(c,basis.snapshot_id,true)?;
    let selected=rows.get(basis.ordinal as usize).ok_or_else(||failure(ErrorCode::InvalidInput,"source-lineage-ordinal"))?;
    if input.envelope().project_id!=request.project_id || basis.result_id!=result.envelope().result_id
        || basis.result_digest!=result.digest() || basis.scope.current_snapshot!=Some(basis.snapshot_id) || basis.scope.revision.get()!=revision
        || basis.mapping_revision>mapping_revision(c,basis.snapshot_id)? {return Err(failure(ErrorCode::ResultMismatch,"source-lineage-basis"));}
    let expected=rows.iter().filter(|r|r.occurrence.operation_unit_id==selected.occurrence.operation_unit_id).map(|r|r.occurrence_id.unwrap()).collect::<BTreeSet<_>>();
    let actual=basis.bindings.iter().map(|b|b.occurrence_id).collect::<BTreeSet<_>>();
    if expected!=actual || actual.len()!=basis.bindings.len(){return Err(failure(ErrorCode::ResultMismatch,"source-lineage-group"));}
    for binding in &basis.bindings {
        if binding_at(c,binding.occurrence_id,basis.mapping_revision)?!=(binding.unit_id,binding.source_revision_id){return Err(failure(ErrorCode::ResultMismatch,"source-lineage-binding"));}
    }
    let local=occurrence_revision(c,selected.occurrence_id.ok_or_else(corrupt)?,basis.mapping_revision)?;
    let chain=unresolved_origin(c,selected.occurrence_id.ok_or_else(corrupt)?,basis.mapping_revision)?.unwrap_or_else(||vec![SourceLineageOrigin{snapshot_id:basis.snapshot_id,occurrence_id:selected.occurrence_id.unwrap(),mapping_revision:local}]);
    if chain!=basis.origin_chain || origin_base(c,chain.last().ok_or_else(corrupt)?)?!=basis.previous_snapshot_id {return Err(failure(ErrorCode::ResultMismatch,"source-lineage-origin"));}
    let (_, (old_input,_,_,mut old))=snapshot_rows(c,basis.previous_snapshot_id,true)?;
    effective_rows(c,&mut old)?;
    if old_input.envelope().project_id!=request.project_id{return Err(failure(ErrorCode::Unauthorized,"source-lineage-project"));}
    let endpoint=old.iter().find(|r|r.occurrence_id==Some(request.old_occurrence_id)).ok_or_else(||failure(ErrorCode::InvalidInput,"source-lineage-endpoint"))?;
    if endpoint.occurrence.namespace!=selected.occurrence.namespace || !identity_family(&endpoint.occurrence,&selected.occurrence)
        || !basis.candidates.iter().any(|e|e.old.occurrence_id==Some(request.old_occurrence_id)&&e.old_snapshot_id==basis.previous_snapshot_id){return Err(failure(ErrorCode::InvalidInput,"source-lineage-edge"));}
    if basis.candidates.iter().any(|candidate|candidate.old_snapshot_id!=basis.previous_snapshot_id||!old.iter().any(|row|row==&candidate.old)){return Err(failure(ErrorCode::ResultMismatch,"source-lineage-candidate"));}
    if request.decision==SourceLineageCorrectionDecision::Continue {
        let mut occupied=c.prepare("SELECT h.occurrence_id FROM source_binding_history h WHERE h.snapshot_id=?1 AND h.unit_id=?2 AND h.mapping_revision=(SELECT MAX(p.mapping_revision) FROM source_binding_history p WHERE p.occurrence_id=h.occurrence_id AND p.mapping_revision<=?3)").map_err(sql_error)?;
        for occurrence in occupied.query_map(params![basis.snapshot_id.to_string(),endpoint.unit_id.ok_or_else(corrupt)?.to_string(),basis.mapping_revision.get() as i64],|r|r.get::<_,String>(0)).map_err(sql_error)? {
            if !actual.contains(&id(occurrence.map_err(sql_error)?)?){return Err(failure(ErrorCode::DependencyConflict,"source-lineage-split-original"));}
        }
    }
    if request.decision!=SourceLineageCorrectionDecision::Continue && basis.bindings.len()>1
        && basis.bindings.iter().any(|b|b.predecessor_id==Some(request.old_occurrence_id)&&matches!(b.relation.as_str(),"unchanged"|"changed")) {
        return Err(failure(ErrorCode::DependencyConflict,"source-lineage-group-original"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;

fn monotonically_closed(c:&Connection,request:&CorrectSourceLineage)->Result<bool,ExecutionError>{
    match check_request(c,request) {
        Err(error) if matches!(error.stage.as_str(),"source-lineage-split-original"|"source-lineage-group-original")=>return Ok(true),
        result=>result?,
    }
    let current=scope(c)?;
    if current.revision>request.basis.scope.revision{return Ok(true);}
    for origin in &request.basis.origin_chain {
        if occurrence_revision(c,origin.occurrence_id,mapping_revision(c,origin.snapshot_id)?)?>origin.mapping_revision{return Ok(true);}
    }
    for work in &request.basis.saved_work {
        for (query,expected) in [
            ("SELECT revision_id FROM translation_revisions WHERE unit_id=?1 AND locale=?2 ORDER BY ordinal",&work.translation_revision_ids),
            ("SELECT action_id FROM review_decisions WHERE unit_id=?1 AND locale=?2 ORDER BY rowid",&work.review_action_ids),
            ("SELECT action_id FROM review_checks WHERE unit_id=?1 AND locale=?2 ORDER BY rowid",&work.check_action_ids),
        ] {
            let now=ids_in(c,query,work.unit_id,&work.locale)?;
            if !now.starts_with(expected){return Err(failure(ErrorCode::ResultMismatch,"source-lineage-work"));}
            if now.len()>expected.len(){return Ok(true);}
        }
        let protection:Option<i64>=c.query_row("SELECT revision FROM application_protections WHERE unit_id=?1 AND locale=?2",params![work.unit_id.to_string(),work.locale],|r|r.get(0)).optional().map_err(sql_error)?;
        if protection.unwrap_or(0) as u64>work.protection_revision.map_or(0,Revision::get){return Ok(true);}
        let current=super::super::translation::current_selection(c,work.unit_id,&work.locale)?;
        if current.as_ref().map(|s|s.event_id)!=work.selection_id {
            if let Some(old)=work.selection_id {
                let prior:Option<i64>=c.query_row("SELECT sequence FROM translation_selections WHERE event_id=?1 AND unit_id=?2 AND locale=?3",params![old.to_string(),work.unit_id.to_string(),work.locale],|r|r.get(0)).optional().map_err(sql_error)?;
                if prior.is_none(){return Err(failure(ErrorCode::ResultMismatch,"source-lineage-selection"));}
                if current.as_ref().is_some_and(|s|s.sequence>prior.unwrap() as u64){return Ok(true);}
            } else if current.is_some(){return Ok(true);}
        }
    }
    Ok(false)
}

struct CorrectionPlan {
    basis: SourceLineageCorrectionBasis,
    unit: Option<ExecutionId>,
    predecessors: BTreeMap<ExecutionId,ExecutionId>,
    continued: bool,
}

fn admit_in(c:&Connection,request:&CorrectSourceLineage)->Result<CorrectionPlan,ExecutionError>{
    check_request(c,request)?;
    let current=basis_in(c,request.project_id,request.basis.snapshot_id,request.basis.ordinal)?;
    let mut comparable=current.clone();comparable.mapping_revision=request.basis.mapping_revision;
    if comparable!=request.basis {return Err(failure(ErrorCode::DependencyConflict,"source-lineage-stale"));}
    let candidate=current.candidates.iter().find(|e|e.old.occurrence_id==Some(request.old_occurrence_id)).ok_or_else(||failure(ErrorCode::InvalidInput,"source-lineage-edge"))?;
    let first=current.bindings.first().ok_or_else(corrupt)?;
    if current.bindings.iter().any(|b|b.unit_id!=first.unit_id||b.source_revision_id!=first.source_revision_id){return Err(corrupt());}
    let old_unit=candidate.old.unit_id.ok_or_else(corrupt)?;
    let was_continued=current.bindings.iter().any(|b|b.predecessor_id==Some(request.old_occurrence_id)&&matches!(b.relation.as_str(),"unchanged"|"changed"));
    let continued=request.decision==SourceLineageCorrectionDecision::Continue || (!was_continued&&matches!(first.relation.as_str(),"unchanged"|"changed"));
    let unit=if request.decision==SourceLineageCorrectionDecision::Continue {Some(old_unit)} else if was_continued {
        let raw:String=c.query_row("SELECT unit_id FROM source_occurrences WHERE occurrence_id=?1",[first.occurrence_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let raw=id(raw)?;
        if raw!=old_unit {Some(raw)} else {
            receipts_in(c,current.snapshot_id)?.into_iter().rev().flat_map(|r|r.current_bindings).find(|b|b.unit_id!=old_unit&&b.relation=="unresolved"&&b.occurrence_id==first.occurrence_id).map(|b|b.unit_id)
        }
    } else {Some(first.unit_id)};
    let group=current.bindings.iter().map(|b|b.occurrence_id).collect::<BTreeSet<_>>();
    if let Some(unit)=unit {
        let mut q=c.prepare("SELECT occurrence_id FROM source_effective_occurrences WHERE snapshot_id=?1 AND unit_id=?2").map_err(sql_error)?;
        for occurrence in q.query_map(params![current.snapshot_id.to_string(),unit.to_string()],|r|r.get::<_,String>(0)).map_err(sql_error)? {
            if !group.contains(&id(occurrence.map_err(sql_error)?)?){return Err(failure(ErrorCode::DependencyConflict,"source-lineage-split"));}
        }
    }
    let selected:String=c.query_row("SELECT occurrence_id FROM source_occurrences WHERE snapshot_id=?1 AND ordinal=?2",params![current.snapshot_id.to_string(),current.ordinal],|r|r.get(0)).map_err(sql_error)?;
    let selected=id(selected)?;
    let mut predecessors=BTreeMap::new();
    for b in &current.bindings {
        let predecessor=if request.decision==SourceLineageCorrectionDecision::Continue {
            if b.occurrence_id==selected {request.old_occurrence_id} else {
                let mut q=c.prepare("SELECT e.old_occurrence_id FROM source_lineage_evidence e JOIN source_effective_occurrences o ON o.occurrence_id=e.old_occurrence_id WHERE e.new_occurrence_id=?1 AND o.unit_id=?2 ORDER BY o.ordinal").map_err(sql_error)?;
                let edges=q.query_map(params![b.occurrence_id.to_string(),old_unit.to_string()],|r|r.get::<_,String>(0)).map_err(sql_error)?.collect::<Result<Vec<_>,_>>().map_err(sql_error)?;
                if edges.len()!=1 {return Err(failure(ErrorCode::DependencyConflict,"source-lineage-group"));}
                id(edges[0].clone())?
            }
        } else {b.predecessor_id.unwrap_or(request.old_occurrence_id)};
        predecessors.insert(b.occurrence_id,predecessor);
    }
    Ok(CorrectionPlan{basis:current,unit,predecessors,continued})
}

impl ProjectStore {
    pub fn source_lineage_correction_basis(&self,project:ExecutionId,snapshot:ExecutionId,ordinal:u32)->Result<SourceLineageCorrectionBasis,ExecutionError>{
        let c=self.connection().map_err(|_|failure(ErrorCode::StorageFailed,"source-lineage-read"))?;
        super::super::review::read_snapshot(c,|c|basis_in(c,project,snapshot,ordinal))
    }
    pub fn source_lineage_correction_request_observation(&self,request:&CorrectSourceLineage)->Result<SourceLineageCorrectionObservation,ExecutionError>{
        let c=self.connection().map_err(|_|failure(ErrorCode::StorageFailed,"source-lineage-read"))?;
        super::super::review::read_snapshot(c,|c|{
        let metadata=super::super::read_metadata_from(c).map_err(|_|corrupt())?;
        if metadata.project_id().to_string()!=request.project_id.to_string(){return Err(failure(ErrorCode::Unauthorized,"source-lineage-project"));}
        match receipt_in(c,request.action_id)? {
            Some(receipt) if receipt.request==*request=>Ok(SourceLineageCorrectionObservation::Recorded{receipt}),
            Some(_)=>Err(failure(ErrorCode::ResultMismatch,"source-lineage-action")),
            None=>if closed_in(c,request)?||invalid_shape(request)||monotonically_closed(c,request)? {Ok(SourceLineageCorrectionObservation::ConfirmedNotApplied)} else {
                match admit_in(c,request) {
                    Err(error) if error.stage=="source-lineage-group"=>Ok(SourceLineageCorrectionObservation::ConfirmedNotApplied),
                    Err(error) if !matches!(error.stage.as_str(),"source-lineage-stale"|"source-lineage-split")=>Err(error),
                    _=>Ok(SourceLineageCorrectionObservation::ReceiptAbsent),
                }
            },
        }
        })
    }
    pub fn validate_source_lineage_correction(&self,request:&CorrectSourceLineage)->Result<(),ExecutionError>{
        let c=self.connection().map_err(|_|failure(ErrorCode::StorageFailed,"source-lineage-read"))?;
        super::super::review::read_snapshot(c,|c|{
            if let Some(receipt)=receipt_in(c,request.action_id)? {return if receipt.request==*request {Ok(())} else {Err(failure(ErrorCode::ResultMismatch,"source-lineage-action"))};}
            if closed_in(c,request)? {return Err(failure(ErrorCode::Cancelled,"source-lineage-closed"));}
            admit_in(c,request).map(|_|())
        })
    }
    pub fn correct_source_lineage(&mut self,request:&CorrectSourceLineage)->Result<SourceLineageCorrectionReceipt,ExecutionError>{
        // Recovery uses this same full request before checking today's basis.
        if let SourceLineageCorrectionObservation::Recorded{receipt}=self.source_lineage_correction_request_observation(request)? {return Ok(receipt);}
        let tx=self.execution_write_scoped(super::super::ChangeScope::Source)?;
        if let Some(receipt)=receipt_in(&tx,request.action_id)? {
            return if receipt.request==*request {Ok(receipt)} else {Err(failure(ErrorCode::ResultMismatch,"source-lineage-action"))};
        }
        if closed_in(&tx,request)? {return Err(failure(ErrorCode::Cancelled,"source-lineage-closed"));}
        let plan=admit_in(&tx,request)?;
        let current=plan.basis;
        let current_binding=current.bindings.first().ok_or_else(corrupt)?;
        let unit=match plan.unit {Some(unit)=>unit,None=>{let unit=ExecutionId::new();tx.execute("INSERT INTO source_units VALUES(?1,?2)",params![unit.to_string(),request.project_id.to_string()]).map_err(sql_error)?;unit}};
        let text:String=tx.query_row("SELECT text FROM source_revisions WHERE revision_id=?1",[current_binding.source_revision_id.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let latest:i64=tx.query_row("SELECT COALESCE(MAX(revision),0) FROM source_revisions WHERE unit_id=?1",[unit.to_string()],|r|r.get(0)).map_err(sql_error)?;
        let source=ExecutionId::new();
        tx.execute("INSERT INTO source_revisions VALUES(?1,?2,?3,?4)",params![source.to_string(),unit.to_string(),latest.checked_add(1).ok_or_else(corrupt)?,text]).map_err(sql_error)?;
        let mut bindings=Vec::new();
        for old in &current.bindings { bindings.push(SourceLineageBinding {occurrence_id:old.occurrence_id,unit_id:unit,source_revision_id:source,predecessor_id:plan.predecessors.get(&old.occurrence_id).copied(),relation:if plan.continued {"changed"} else {"unresolved"}.into()}); }
        let receipt=SourceLineageCorrectionReceipt {request:request.clone(),mapping_revision:current.mapping_revision.next()?,previous_bindings:current.bindings,current_bindings:bindings,preserved_work:current.saved_work};
        let request_bytes=codec::encode(request,MAX_INPUT_BYTES)?;let bytes=codec::encode(&receipt,MAX_INPUT_BYTES)?;
        tx.execute("INSERT INTO source_lineage_corrections VALUES(?1,?2,?3,?4,?5,?6,?7)",params![request.action_id.to_string(),request.basis.snapshot_id.to_string(),receipt.mapping_revision.get() as i64,&request_bytes,codec::digest(&request_bytes),&bytes,codec::digest(&bytes)]).map_err(sql_error)?;
        for binding in &receipt.current_bindings {tx.execute("INSERT INTO source_lineage_correction_bindings VALUES(?1,?2,?3,?4,?5,?6)",params![request.action_id.to_string(),binding.occurrence_id.to_string(),binding.unit_id.to_string(),binding.source_revision_id.to_string(),binding.predecessor_id.map(|id|id.to_string()),binding.relation]).map_err(sql_error)?;}
        super::super::ledger::commit(tx)?;
        Ok(receipt)
    }
    pub fn cancel_source_lineage_correction(&mut self,request:&CorrectSourceLineage)->Result<SourceLineageCorrectionObservation,ExecutionError>{
        if let SourceLineageCorrectionObservation::Recorded{receipt}=self.source_lineage_correction_request_observation(request)? {return Ok(SourceLineageCorrectionObservation::Recorded{receipt});}
        let tx=self.execution_write_scoped(super::super::ChangeScope::Source)?;
        if let Some(receipt)=receipt_in(&tx,request.action_id)? {
            return if receipt.request==*request {Ok(SourceLineageCorrectionObservation::Recorded{receipt})} else {Err(failure(ErrorCode::ResultMismatch,"source-lineage-action"))};
        }
        if closed_in(&tx,request)? {return Ok(SourceLineageCorrectionObservation::ConfirmedNotApplied);}
        check_request(&tx,request)?;
        let bytes=codec::encode(request,MAX_INPUT_BYTES)?;
        tx.execute("INSERT INTO source_lineage_correction_closures VALUES(?1,?2,?3,?4,?5)",params![request.action_id.to_string(),request.project_id.to_string(),request.basis.snapshot_id.to_string(),&bytes,codec::digest(&bytes)]).map_err(sql_error)?;
        super::super::ledger::commit(tx)?;
        Ok(SourceLineageCorrectionObservation::ConfirmedNotApplied)
    }
}
