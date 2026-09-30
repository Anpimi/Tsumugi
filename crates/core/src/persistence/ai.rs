use super::ProjectStore;
use crate::{ai::*, execution::*};
use rusqlite::params;

impl ProjectStore {
    pub fn preview_ai(
        &self,
        config: AiConfig,
        locale: &str,
        units: &[ExecutionId],
    ) -> Result<AiPreview, ExecutionError> {
        config.validate()?;
        let metadata = self
            .metadata()
            .map_err(|_| error(ErrorCode::StorageFailed, "ai-project"))?;
        if !metadata
            .target_locales()
            .iter()
            .any(|l| l.as_str() == locale)
        {
            return Err(error(ErrorCode::DependencyConflict, "ai-locale"));
        }
        if units.is_empty()
            || units.len() > config.max_items as usize
            || units
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != units.len()
        {
            return Err(error(ErrorCode::LimitExceeded, "ai-scope"));
        }
        let snapshot = self
            .content_scope()?
            .current_snapshot
            .ok_or_else(|| error(ErrorCode::DependencyConflict, "ai-source"))?;
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "ai-project"))?;
        let project = ExecutionId::parse(&metadata.project_id().to_string())?;
        let baseline: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(rowid),0) FROM resource_changes",
                [],
                |r| r.get(0),
            )
            .map_err(super::ledger::sql_error)?;
        let mut items = Vec::new();
        for unit in units {
            let (revision,key,text):(String,String,String)=connection.query_row("SELECT o.revision_id,o.native_key,r.text FROM source_occurrences o JOIN source_revisions r ON r.unit_id=o.unit_id AND r.revision_id=o.revision_id WHERE o.snapshot_id=?1 AND o.unit_id=?2",params![snapshot.to_string(),unit.to_string()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(super::ledger::sql_error)?;
            let mut terms = Vec::new();
            let mut omissions = Vec::new();
            if config.share_terms {
                for entry in self.resolve_terms(project, *unit, locale)?.entries {
                    if let Some(t) = entry.selected {
                        terms.push(SharedTerm {
                            revision_id: t.revision_id,
                            source: t.source,
                            target: t.target,
                            protected: t.protected,
                        });
                    } else {
                        omissions.push(format!("term-conflict:{}", entry.source));
                    }
                }
            }
            let context = if config.share_context {
                self.context_revision(project, *unit, locale)?
            } else {
                None
            };
            if config.share_context && context.is_none() {
                omissions.push("context-missing".into());
            }
            if !config.share_terms {
                omissions.push("terms-not-shared".into());
            }
            if !config.share_context {
                omissions.push("context-not-shared".into());
            }
            let item = AiItem {
                unit_id: *unit,
                source_revision_id: ExecutionId::parse(&revision)?,
                source_snapshot_id: snapshot,
                native_key: key,
                source_locale: metadata.source_locale().as_str().into(),
                source_text: text,
                target_locale: locale.into(),
                terms,
                context,
                omissions,
                resource_baseline: baseline as u64,
            };
            request_body(&config, &item)?;
            items.push(item);
        }
        let digest = preview_digest(&config, &items)?;
        Ok(AiPreview {
            config,
            recipe: RECIPE.into(),
            items,
            digest,
        })
    }
}
impl AiPreview {
    pub fn fixed_input(&self, project: crate::ProjectId) -> Result<FixedInput, ExecutionError> {
        let items = self
            .items
            .iter()
            .map(|i| {
                Ok(InputItem::new(
                    Scope {
                        kind: "translation-unit".into(),
                        id: i.unit_id.to_string(),
                        locale: Some(i.target_locale.clone()),
                    },
                    serde_json::to_value(i)
                        .map_err(|_| error(ErrorCode::InvalidInput, "ai-input"))?,
                    vec![],
                ))
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        let mut e = InputEnvelope::new(project, OPERATION, CAPABILITY, "1", items)?;
        e.settings = serde_json::to_value(AiSettings {
            recipe: RECIPE.into(),
            config: self.config.clone(),
        })
        .map_err(|_| error(ErrorCode::InvalidInput, "ai-input"))?;
        // Allow bounded retries inside the producer without the generic runtime
        // expiring a healthy retry before its configured request timeout.
        e.limits.timeout_ms = ((self.config.timeout_seconds * 1000 + 1000)
            * (self.config.max_retries + 1))
            .min(600_000);
        FixedInput::capture(e)
    }
}

pub struct AiAdoptionHandler;
pub struct ArenaAdoptionHandler;
impl AdoptionHandler for ArenaAdoptionHandler {
    fn operation(&self) -> &str {
        crate::ai::arena::OPERATION
    }
    fn apply(
        &self,
        tx: &AdoptionTransaction<'_>,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<Vec<ChangeReference>, ExecutionError> {
        apply_ai(tx, input, action, results, true)
    }
}
impl AdoptionHandler for AiAdoptionHandler {
    fn operation(&self) -> &str {
        OPERATION
    }
    fn apply(
        &self,
        tx: &AdoptionTransaction<'_>,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<Vec<ChangeReference>, ExecutionError> {
        apply_ai(tx, input, action, results, false)
    }
}
fn apply_ai(
    tx: &AdoptionTransaction<'_>,
    input: &FixedInput,
    action: &AdoptionAction,
    results: &[FixedResult],
    arena: bool,
) -> Result<Vec<ChangeReference>, ExecutionError> {
    if arena {
        let cancelled: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_attempts a JOIN execution_cancellations c USING(task_id) WHERE a.attempt_id=?1 AND c.revision>a.cancellation_revision)", [action.attempt_id.to_string()], |r| r.get(0))?;
        if cancelled {
            return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
        }
    }
    if results.len() != 1 {
        return Err(error(ErrorCode::ResultMismatch, "ai-result"));
    }
    let result = &results[0];
    let (out, item) = if arena {
        (
            crate::ai::arena::validate_output(input, result)?,
            crate::ai::arena::item_payload(input, result.envelope().item_id)?.item,
        )
    } else {
        (
            validate_output(input, result)?,
            item_payload(input, result.envelope().item_id)?,
        )
    };
    let (project, locales): (String, String) = tx.query_row(
        "SELECT project_id,target_locales_json FROM project_metadata WHERE row_id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let targets: Vec<String> =
        serde_json::from_str(&locales).map_err(|_| error(ErrorCode::CorruptLedger, "ai-locale"))?;
    if project != action.project_id.to_string() || !targets.contains(&item.target_locale) {
        return Err(error(ErrorCode::DependencyConflict, "ai-locale"));
    }
    let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM source_occurrences o JOIN content_scope c ON c.current_snapshot=o.snapshot_id WHERE o.unit_id=?1 AND o.revision_id=?2)",params![item.unit_id.to_string(),item.source_revision_id.to_string()],|r|r.get(0))?;
    if !valid {
        return Err(error(ErrorCode::DependencyConflict, "ai-source"));
    }
    let ordinal:i64=tx.query_row("SELECT COALESCE(MAX(ordinal),0)+1 FROM translation_revisions WHERE unit_id=?1 AND locale=?2",params![item.unit_id.to_string(),item.target_locale],|r|r.get(0))?;
    let id = ExecutionId::new();
    tx.execute("INSERT INTO translation_revisions (revision_id,project_id,unit_id,locale,ordinal,text,source_snapshot_id,source_revision_id,origin_kind,action_id,request_digest,attempt_id,result_id,item_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ai',?9,?10,?11,?12,?13)",params![id.to_string(),project,item.unit_id.to_string(),item.target_locale,ordinal,out.text,item.source_snapshot_id.to_string(),item.source_revision_id.to_string(),action.action_id.to_string(),action.request_digest(input)?,action.attempt_id.to_string(),result.envelope().result_id.to_string(),result.envelope().item_id.to_string()])?;
    tx.execute(
        "INSERT INTO translation_resource_baselines VALUES (?1,?2)",
        params![id.to_string(), item.resource_baseline as i64],
    )?;
    Ok(vec![ChangeReference {
        kind: "translation-revision".into(),
        id: id.to_string(),
        revision: Revision::new(ordinal as u64)?,
    }])
}
