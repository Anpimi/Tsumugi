use super::ProjectStore;
use crate::{ai::*, execution::*};
use rusqlite::{OptionalExtension, params};

impl ProjectStore {
    /// Resolve the ordinary saved candidate for this attempt's current result.
    /// Reading it never adopts, selects or resumes an execution.
    pub fn saved_ai_candidate(
        &self,
        attempt: ExecutionId,
        item_id: ExecutionId,
    ) -> Result<Option<ExecutionId>, ExecutionError> {
        let input = self.execution_input(attempt)?;
        let item = item_payload(&input, item_id)?;
        let Some(result) = self.execution_current_result(attempt, item_id)? else {
            return Ok(None);
        };
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "ai-candidate-read"))?;
        let revision: Option<String> = connection.query_row(
            "SELECT revision_id FROM translation_revisions WHERE project_id=?1 AND attempt_id=?2 AND item_id=?3 AND result_id=?4 AND unit_id=?5 AND locale=?6 AND origin_kind='ai' ORDER BY ordinal LIMIT 1",
            params![input.envelope().project_id.to_string(), attempt.to_string(), item_id.to_string(), result.to_string(), item.unit_id.to_string(), item.target_locale],
            |row|row.get(0),
        ).optional().map_err(super::ledger::sql_error)?;
        revision.map(|id| ExecutionId::parse(&id)).transpose()
    }

    pub fn preview_ai(
        &self,
        config: AiConfig,
        locale: &str,
        units: &[ExecutionId],
    ) -> Result<AiPreview, ExecutionError> {
        self.preview_ai_configs(vec![config], locale, units)?
            .pop()
            .ok_or_else(|| error(ErrorCode::InvalidInput, "ai-configurations"))
    }

    /// Prepare all variants from one current read snapshot. Source evidence is
    /// validated once; shared resources are observed once before each variant's
    /// independent sharing policy is applied. Nothing is dispatched or saved.
    pub(super) fn preview_ai_configs(
        &self,
        configs: Vec<AiConfig>,
        locale: &str,
        units: &[ExecutionId],
    ) -> Result<Vec<AiPreview>, ExecutionError> {
        if !(1..=4).contains(&configs.len()) {
            return Err(error(ErrorCode::LimitExceeded, "ai-configurations"));
        }
        for config in &configs {
            config.validate()?;
            super::resources::strategy::verify_config(self, config, locale)?;
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
        }
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "ai-project"))?;
        super::review::read_snapshot(connection, |connection| {
            preview_ai_configs_in(connection, configs, locale, units)
        })
    }
}

pub(super) fn preview_ai_configs_in(
    connection: &rusqlite::Connection,
    configs: Vec<AiConfig>,
    locale: &str,
    units: &[ExecutionId],
) -> Result<Vec<AiPreview>, ExecutionError> {
            let metadata = super::read_metadata_from(connection)
                .map_err(|_| error(ErrorCode::CorruptLedger, "ai-project"))?;
            if !metadata
                .target_locales()
                .iter()
                .any(|target| target.as_str() == locale)
            {
                return Err(error(ErrorCode::DependencyConflict, "ai-locale"));
            }
            let project = ExecutionId::parse(&metadata.project_id().to_string())?;
            let source =
                super::resources::SourceContextReader::read_in(connection, project, locale)
                    .map_err(|failure| {
                        if failure.code == ErrorCode::DependencyConflict
                            && failure.stage == "source-context-snapshot"
                        {
                            error(ErrorCode::DependencyConflict, "ai-source")
                        } else {
                            failure
                        }
                    })?;
            let baseline: i64 = connection
                .query_row(
                    "SELECT COALESCE(MAX(rowid),0) FROM resource_changes",
                    [],
                    |r| r.get(0),
                )
                .map_err(super::ledger::sql_error)?;
            let share_terms = configs.iter().any(|config| config.share_terms);
            let share_context = configs.iter().any(|config| config.share_context);
            let share_decisions = configs.iter().any(|config| {
                config.share_context
                    || config.source_context.extracted
                    || config.source_context.inferred
            });
            let share_source = configs
                .iter()
                .any(|config| config.source_context.is_enabled() || config.share_context);
            let current_terms = if share_terms {
                super::resources::current_terms_in(connection, project, locale)?
            } else {
                Vec::new()
            };
            let mut prepared = configs
                .into_iter()
                .map(|config| (config, Vec::with_capacity(units.len())))
                .collect::<Vec<_>>();
            for unit in units {
                let row = source.source_for_unit(*unit)?;
                let revision = row
                    .source_revision_id
                    .ok_or_else(|| error(ErrorCode::CorruptLedger, "ai-source"))?;
                let mut terms = Vec::new();
                let mut omissions = Vec::new();
                if share_terms {
                    for entry in super::resources::resolve_terms_from(
                        *unit,
                        locale,
                        revision,
                        &row.occurrence.text,
                        &current_terms,
                    )
                    .entries
                    {
                        if let Some(term) = entry.selected {
                            terms.push(SharedTerm {
                                revision_id: term.revision_id,
                                source: term.source,
                                target: term.target,
                                protected: term.protected,
                            });
                        } else {
                            omissions.push(format!("term-conflict:{}", entry.source));
                        }
                    }
                }
                let context = if share_context {
                    super::resources::current_context(connection, project, *unit, locale)?
                } else {
                    None
                };
                let source_view = if share_source {
                    Some(source.project(&crate::SourceContextRequest {
                        project_id: project,
                        source_snapshot_id: source.snapshot_id,
                        unit_id: *unit,
                        source_revision_id: revision,
                        locale: locale.into(),
                    })?)
                } else {
                    None
                };
                let decisions = if share_decisions {
                    super::resources::current_fact_decisions_in(
                        connection,
                        source_view
                            .as_ref()
                            .ok_or_else(|| error(ErrorCode::CorruptLedger, "context-fact-view"))?,
                    )?
                } else {
                    Vec::new()
                };
                for (config, items) in &mut prepared {
                    let (project_context, source_context) = if let Some(view) = &source_view {
                        crate::ProjectFactCapture::capture(view, &decisions, config)?
                    } else {
                        (
                            crate::ProjectFactCapture::NotSelected,
                            crate::SourceContextCapture::NotSelected,
                        )
                    };
                    let mut item = AiItem {
                        unit_id: *unit,
                        source_revision_id: revision,
                        source_snapshot_id: source.snapshot_id,
                        native_key: row.occurrence.key.clone(),
                        source_locale: source.source_locale.clone(),
                        source_text: row.occurrence.text.clone(),
                        target_locale: locale.into(),
                        terms: if config.share_terms {
                            terms.clone()
                        } else {
                            Vec::new()
                        },
                        context: if config.share_context {
                            context.clone()
                        } else {
                            None
                        },
                        source_context,
                        project_context,
                        omissions: if config.share_terms {
                            omissions.clone()
                        } else {
                            Vec::new()
                        },
                        resource_baseline: baseline as u64,
                    };
                    if config.share_context && item.context.is_none() {
                        item.omissions.push("context-missing".into());
                    }
                    if !config.share_terms {
                        item.omissions.push("terms-not-shared".into());
                    }
                    if !config.share_context {
                        item.omissions.push("context-not-shared".into());
                    }
                    // Enforce each real prompt budget before retaining another
                    // item, including resources shared by only one variant.
                    request_body(config, &item)?;
                    items.push(item);
                }
            }
            prepared
                .into_iter()
                .map(|(config, items)| {
                    let digest = preview_digest(&config, &items)?;
                    Ok(AiPreview {
                        config,
                        recipe: RECIPE.into(),
                        items,
                        digest,
                    })
                })
                .collect()
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
            agent: None,
        })
        .map_err(|_| error(ErrorCode::InvalidInput, "ai-input"))?;
        // Allow bounded retries inside the producer without the generic runtime
        // expiring a healthy retry before its configured request timeout.
        e.limits.timeout_ms = ((self.config.timeout_seconds * 1000 + 6000)
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
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        prepare_ai(input, action, results, true)
    }
}
impl AdoptionHandler for AiAdoptionHandler {
    fn operation(&self) -> &str {
        OPERATION
    }
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        prepare_ai(input, action, results, false)
    }
}
fn prepare_ai(
    input: &FixedInput,
    action: &AdoptionAction,
    results: &[FixedResult],
    arena: bool,
) -> Result<PreparedMutation, ExecutionError> {
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
    let input = input.clone();
    let action = action.clone();
    let result = result.clone();
    Ok(Box::new(move |tx| {
        let input = &input;
        let action = &action;
        let result = &result;
        if arena {
            let cancelled: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM execution_attempts a JOIN execution_cancellations c USING(task_id) WHERE a.attempt_id=?1 AND c.revision>a.cancellation_revision)", [action.attempt_id.to_string()], |r| r.get(0))?;
            if cancelled {
                return Err(error(ErrorCode::Cancelled, "ai-cancelled"));
            }
        }
        let (project, locales): (String, String) = tx.query_row(
            "SELECT project_id,target_locales_json FROM project_metadata WHERE row_id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let targets: Vec<String> = serde_json::from_str(&locales)
            .map_err(|_| error(ErrorCode::CorruptLedger, "ai-locale"))?;
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
    }))
}
