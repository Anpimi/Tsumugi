//! Local references are derived from original planning input, without executing it.
use super::*;
use crate::persistence::resources::{current_term, term_by_revision};

fn term_value(term: crate::TermRevision) -> ConversationTermReferenceValue {
    ConversationTermReferenceValue {
        term_id: term.term_id,
        revision_id: term.revision_id,
        source: term.source,
        target: term.target,
        protected: term.protected,
        origin_kind: term.origin_kind,
        removed: term.removed,
    }
}

enum Locator {
    Term(ConversationReferenceUnit, ExecutionId),
    File(ConversationReferenceUnit, ExecutionId, String, String),
}

impl ProjectStore {
    /// Read only the original shared terms and captured source-file associations.
    /// A later source or term change is reported alongside the historical target.
    pub fn conversation_references(
        &self,
        project_id: ExecutionId,
        conversation_id: ExecutionId,
        attempt_id: ExecutionId,
        after: u32,
        limit: u32,
    ) -> Result<Option<ConversationReferencePage>, ExecutionError> {
        if limit == 0 || limit > 16 {
            return Err(fail(ErrorCode::InvalidInput, "conversation-reference-page"));
        }
        let c = self
            .connection()
            .map_err(|_| fail(ErrorCode::StorageFailed, "conversation-reference-read"))?;
        read_snapshot(c, |c| {
            owned(c, project_id)?;
            conversation(c, project_id, conversation_id)?;
            let Some(input) = self.execution_input_if_present(attempt_id)? else {
                return Ok(None);
            };
            let preview = conversation_planning::preview_from_input(&input)?;
            if input.envelope().project_id != project_id
                || preview.project_id != project_id
                || preview.conversation_id != conversation_id
            {
                return Err(fail(
                    ErrorCode::ResultMismatch,
                    "conversation-reference-history",
                ));
            }
            let locale = match &preview.scope {
                ConversationPlanningScope::ConversationOnly {} => None,
                ConversationPlanningScope::Units { locale, .. } => Some(locale),
            };
            let mut locators = Vec::new();
            for basis in &preview.units {
                let unit = ConversationReferenceUnit {
                    unit_id: basis.unit_id,
                    locale: locale.ok_or_else(corrupt)?.clone(),
                    source_snapshot_id: basis.source_snapshot_id,
                    source_revision_id: basis.source_revision_id,
                };
                let mut terms = BTreeSet::new();
                for revision in &basis.shared_term_revision_ids {
                    if terms.insert(*revision) {
                        locators.push(Locator::Term(unit.clone(), *revision));
                    }
                }
                // Association is qualified by all original identities. No path is
                // interpreted as a native filename or accepted from model prose.
                let mut statement = c.prepare("SELECT DISTINCT f.artifact_id,f.logical_path,f.role
                    FROM source_occurrences o JOIN source_snapshots s ON s.snapshot_id=o.snapshot_id
                    JOIN source_files f ON f.artifact_id=o.artifact_id AND f.set_id=s.set_id
                    JOIN source_units u ON u.unit_id=o.unit_id
                    WHERE s.project_id=?1 AND u.project_id=?1 AND o.snapshot_id=?2 AND o.unit_id=?3 AND o.revision_id=?4
                    ORDER BY f.logical_path,f.artifact_id").map_err(sql)?;
                let files = statement
                    .query_map(
                        params![
                            project_id.to_string(),
                            basis.source_snapshot_id.to_string(),
                            basis.unit_id.to_string(),
                            basis.source_revision_id.to_string()
                        ],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .map_err(sql)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(sql)?;
                for (artifact, path, role) in files {
                    let artifact_id = ExecutionId::parse(&artifact).map_err(|_| corrupt())?;
                    locators.push(Locator::File(unit.clone(), artifact_id, path, role));
                }
            }
            let total = u32::try_from(locators.len())
                .map_err(|_| fail(ErrorCode::LimitExceeded, "conversation-references"))?;
            if after > total {
                return Err(fail(ErrorCode::InvalidInput, "conversation-reference-page"));
            }
            let mut rows = Vec::new();
            for locator in locators
                .into_iter()
                .skip(after as usize)
                .take(limit as usize)
            {
                rows.push(match locator {
                    Locator::Term(unit, revision) => {
                        let original =
                            term_by_revision(c, project_id, revision)?.ok_or_else(corrupt)?;
                        if original.locale != unit.locale
                            || original.removed
                            || original.scope_unit_id.is_some_and(|id| id != unit.unit_id)
                        {
                            return Err(corrupt());
                        }
                        let current =
                            current_term(c, project_id, &original.term_id)?.map(term_value);
                        ConversationMaterialReference::Term {
                            unit,
                            original: term_value(original),
                            current,
                        }
                    }
                    Locator::File(unit, artifact_id, logical_path, role) => {
                        ConversationMaterialReference::File {
                            unit,
                            artifact_id,
                            logical_path,
                            role,
                        }
                    }
                });
            }
            let consumed = after + u32::try_from(rows.len()).map_err(|_| corrupt())?;
            let page = ConversationReferencePage {
                project_id,
                conversation_id,
                attempt_id,
                input_digest: input.digest().into(),
                current_snapshot_id: self.content_scope()?.current_snapshot,
                after,
                total,
                next_after: (consumed < total).then_some(consumed),
                rows,
            };
            codec::encode(&page, 1024 * 1024)?;
            Ok(Some(page))
        })
    }
}
