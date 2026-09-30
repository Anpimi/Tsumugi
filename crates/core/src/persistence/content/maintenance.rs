use super::*;
use rusqlite::OptionalExtension;
use std::collections::BTreeMap;

impl ProjectStore {
    pub fn source_history(&self, offset: u32, limit: u32) -> Result<SourceHistory, ExecutionError> {
        if limit == 0 || limit > 100 {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let current = scope(connection)?.current_snapshot;
        let mut statement = connection
            .prepare("SELECT snapshot_id FROM source_snapshots")
            .map_err(sql_error)?;
        let mut entries = Vec::new();
        for raw in statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(sql_error)?
        {
            let snapshot = id(raw.map_err(sql_error)?)?;
            let (revision, (input, result, output, rows)) =
                snapshot_rows(connection, snapshot, true)?;
            let action: String = connection
                .query_row(
                    "SELECT action_id FROM adoption_receipts WHERE attempt_id=?1",
                    [input.envelope().attempt_id.to_string()],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            entries.push(SourceHistoryEntry {
                snapshot_id: snapshot,
                revision,
                current: current == Some(snapshot),
                total: rows.len() as u32,
                action_id: id(action)?,
                result_digest: result.digest().into(),
                coverage: output.coverage,
            });
        }
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.revision));
        let total = entries.len() as u32;
        if offset > total {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        let next_offset = (offset + limit < total).then_some(offset + limit);
        Ok(SourceHistory {
            snapshots: entries
                .into_iter()
                .skip(offset as usize)
                .take(limit as usize)
                .collect(),
            total,
            next_offset,
        })
    }

    pub fn source_history_content(
        &self,
        snapshot: ExecutionId,
        query: &str,
        after: u32,
        limit: u32,
    ) -> Result<ContentPage, ExecutionError> {
        if query.len() > 256 {
            return Err(failure(ErrorCode::InvalidInput, "page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let (_, (input, result, output, rows)) = snapshot_rows(connection, snapshot, true)?;
        let query = query.to_lowercase();
        let rows = rows
            .into_iter()
            .filter(|row| {
                row.occurrence.key.to_lowercase().contains(&query)
                    || row.occurrence.text.to_lowercase().contains(&query)
            })
            .collect();
        page(
            Some(snapshot),
            &input,
            &result,
            output,
            scope(connection)?,
            rows,
            after,
            limit,
        )
    }

    pub fn source_lineage_evidence(
        &self,
        snapshot: ExecutionId,
        ordinal: u32,
    ) -> Result<Vec<LineageEvidence>, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let (_, (_, _, _, rows)) = snapshot_rows(connection, snapshot, true)?;
        let current = rows
            .get(ordinal as usize)
            .ok_or_else(|| failure(ErrorCode::InvalidInput, "page"))?;
        let (predecessor, relation): (Option<String>, String) = connection
            .query_row(
                "SELECT predecessor_id,relation FROM source_lineage WHERE occurrence_id=?1",
                [current.occurrence_id.unwrap().to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql_error)?;
        let mut statement = connection.prepare(
            "SELECT o.snapshot_id,o.ordinal,e.relationship,e.decision,e.actor,e.reason,e.action_id,e.policy FROM source_lineage_evidence e JOIN source_occurrences o ON o.occurrence_id=e.old_occurrence_id WHERE e.new_occurrence_id=?1 ORDER BY o.snapshot_id,o.ordinal"
        ).map_err(sql_error)?;
        let mut evidence = Vec::new();
        for edge in statement
            .query_map([current.occurrence_id.unwrap().to_string()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u32>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })
            .map_err(sql_error)?
        {
            let (old_snapshot, ordinal, relationship, decision, actor, reason, action, policy) =
                edge.map_err(sql_error)?;
            let old_snapshot_id = id(old_snapshot)?;
            let (_, (_, _, _, old_rows)) = snapshot_rows(connection, old_snapshot_id, true)?;
            let old = old_rows.get(ordinal as usize).ok_or_else(corrupt)?.clone();
            let applied_relation = (predecessor.as_deref()
                == old.occurrence_id.map(|id| id.to_string()).as_deref())
            .then(|| relation.clone());
            evidence.push(LineageEvidence {
                old,
                old_snapshot_id,
                relationship,
                decision,
                actor,
                reason,
                action_id: id(action)?,
                policy,
                applied_relation,
            });
        }
        Ok(evidence)
    }

    /// An estimate only. Adoption changes source facts, never writes a derived work queue.
    /// Current review/selection/resource facts are read again by the committed projection.
    pub fn source_update_estimate(
        &self,
        attempt: ExecutionId,
        result: ExecutionId,
        confirmation: &SourceConfirmation,
    ) -> Result<Vec<SourceImpactSummary>, ExecutionError> {
        let comparison = self.source_comparison_filtered(
            attempt,
            result,
            confirmation.lineage_base_snapshot,
            "",
            0,
            1,
        )?;
        if comparison.confirmation.result_digest != confirmation.result_digest
            || comparison.scope.revision != confirmation.expected_content_revision
            || comparison.scope.current_snapshot != confirmation.expected_current_snapshot
        {
            return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let current = self.source_content(comparison.scope.current_snapshot.unwrap(), 0, 1)?;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let (_, (_, _, _, current_rows)) =
            snapshot_rows(connection, current.snapshot_id.unwrap(), true)?;
        let (_, (_, _, _, base_rows)) =
            snapshot_rows(connection, comparison.previous_snapshot_id, true)?;
        let input = self.execution_input(attempt)?;
        let output = validate_output(&input, &self.execution_result(attempt, result)?)?;
        let metadata = self
            .metadata()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let mut summaries = Vec::new();
        for locale in metadata.target_locales() {
            let mut summary = SourceImpactSummary {
                locale: locale.as_str().into(),
                preserved: 0,
                reassess: 0,
                unresolved: 0,
                total: output.occurrences.len() as u32,
            };
            let mut pending = std::collections::BTreeSet::new();
            let mut offset = 0;
            loop {
                let work = self.review_work_page(
                    id(metadata.project_id().to_string())?,
                    locale.as_str(),
                    offset,
                    100,
                )?;
                pending.extend(work.items.into_iter().map(|item| item.unit_id));
                match work.next_offset {
                    Some(next) => offset = next,
                    None => break,
                }
            }
            for new in &output.occurrences {
                let explicit = confirmation
                    .lineage
                    .iter()
                    .find(|choice| choice.new_ordinal == new.ordinal);
                let old = if let Some(choice) = explicit {
                    if choice.decision == LineageDecision::Continue {
                        base_rows
                            .iter()
                            .find(|row| row.occurrence_id == Some(choice.old_occurrence_id))
                    } else {
                        None
                    }
                } else {
                    current_rows.iter().find(|row| {
                        row.occurrence.key.eq_ignore_ascii_case(&new.key)
                            && row.occurrence.text == new.text
                            && row.occurrence.identity_basis == new.identity_basis
                    })
                };
                let Some(old) = old else {
                    summary.unresolved += 1;
                    continue;
                };
                let target = current_rows
                    .iter()
                    .find(|row| row.unit_id == old.unit_id)
                    .and_then(|row| row.unit_id)
                    .map(|unit| {
                        self.review_target(
                            id(metadata.project_id().to_string())?,
                            unit,
                            locale.as_str(),
                        )
                    })
                    .transpose()?;
                if target
                    .as_ref()
                    .is_none_or(|target| target.selection_id.is_none())
                {
                    summary.unresolved += 1;
                } else if old.occurrence.text == new.text
                    && old.occurrence.identity_basis == new.identity_basis
                    && target.as_ref().is_some_and(|target| {
                        target.source_revision_id == old.source_revision_id.unwrap()
                            && !pending.contains(&target.unit_id)
                    })
                {
                    summary.preserved += 1;
                } else {
                    summary.reassess += 1;
                }
            }
            summaries.push(summary);
        }
        Ok(summaries)
    }

    pub fn source_impact(
        &self,
        snapshot: ExecutionId,
        locale: &str,
        after: u32,
        limit: u32,
    ) -> Result<SourceImpactPage, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        if scope(connection)?.current_snapshot != Some(snapshot) {
            return Err(failure(ErrorCode::DependencyConflict, "stale-preview"));
        }
        let metadata = self
            .metadata()
            .map_err(|_| failure(ErrorCode::StorageFailed, "source-read"))?;
        let project = id(metadata.project_id().to_string())?;
        let content = self.source_content(snapshot, after, limit)?;
        let mut work: BTreeMap<ExecutionId, Vec<String>> = BTreeMap::new();
        let mut offset = 0;
        loop {
            let page = self.review_work_page(project, locale, offset, 100)?;
            for item in page.items {
                work.insert(item.unit_id, item.reasons);
            }
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        let summary = SourceImpactSummary {
            locale: locale.into(),
            preserved: content.total - work.len() as u32,
            reassess: 0,
            unresolved: 0,
            total: content.total,
        };
        let mut summary = summary;
        let (_, (_, _, _, all)) = snapshot_rows(connection, snapshot, true)?;
        for row in &all {
            if work.contains_key(&row.unit_id.unwrap()) {
                let target = self.review_target(project, row.unit_id.unwrap(), locale)?;
                if target.selection_id.is_none() {
                    summary.unresolved += 1;
                } else {
                    summary.reassess += 1;
                }
            }
        }
        let mut rows = Vec::new();
        for row in content.rows {
            let target = self.review_target(project, row.unit_id.unwrap(), locale)?;
            let mut reasons = work.get(&row.unit_id.unwrap()).cloned().unwrap_or_default();
            let lineage = self.source_lineage_evidence(snapshot, row.occurrence.ordinal)?;
            let predecessor: Option<String> = connection
                .query_row(
                    "SELECT predecessor_id FROM source_lineage WHERE occurrence_id=?1",
                    [row.occurrence_id.unwrap().to_string()],
                    |r| r.get(0),
                )
                .map_err(sql_error)?;
            let previous = predecessor.and_then(|id| {
                lineage
                    .iter()
                    .find(|edge| {
                        edge.old
                            .occurrence_id
                            .is_some_and(|old| old.to_string() == id)
                    })
                    .map(|edge| edge.old.clone())
            });
            // Read immutable review/check evidence for the earlier source. These
            // are historical selection bases, never assertions of current validity.
            let mut previous_bases = Vec::new();
            if let Some(old) = &previous {
                for (table, kind) in [("review_decisions", "review"), ("review_checks", "check")] {
                    let query = format!(
                        "SELECT basis,basis_json,action_id FROM {table} WHERE unit_id=?1 AND locale=?2 AND json_extract(basis_json,'$.sourceRevisionId')=?3 ORDER BY rowid DESC LIMIT 1"
                    );
                    let raw: Option<(String, String, String)> = connection
                        .query_row(
                            &query,
                            params![
                                old.unit_id.unwrap().to_string(),
                                locale,
                                old.source_revision_id.unwrap().to_string()
                            ],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                        )
                        .optional()
                        .map_err(sql_error)?;
                    if let Some((basis, json, action)) = raw {
                        let evidence: crate::ReviewBasis =
                            codec::decode(json.as_bytes(), MAX_INPUT_BYTES)?;
                        let translation_text = evidence
                            .revision_id
                            .map(|revision| {
                                connection.query_row(
                                    "SELECT text FROM translation_revisions WHERE revision_id=?1",
                                    [revision.to_string()],
                                    |r| r.get::<_, String>(0),
                                )
                            })
                            .transpose()
                            .map_err(sql_error)?;
                        previous_bases.push(SourceImpactBasis {
                            basis,
                            evidence,
                            action_id: id(action)?,
                            kind: kind.into(),
                            translation_text,
                        });
                    }
                }
            }
            if !reasons.is_empty() {
                if previous
                    .as_ref()
                    .is_some_and(|old| old.source_revision_id != row.source_revision_id)
                {
                    reasons.push("source-changed".into());
                }
                if target.selection_id.is_none() && !lineage.is_empty() {
                    reasons.push("correspondence-unresolved".into());
                }
            }
            reasons.sort();
            reasons.dedup();
            let status = if reasons.is_empty() {
                "preserved"
            } else if target.selection_id.is_none() {
                "unresolved"
            } else {
                "reassess"
            };
            rows.push(SourceImpactRow {
                current: row,
                previous,
                previous_bases,
                locale: locale.into(),
                status: status.into(),
                reasons,
                selection_id: target.selection_id,
                translation_revision_id: target.revision_id,
                review_basis: target.basis,
                lineage,
            });
        }
        let page = SourceImpactPage {
            snapshot_id: snapshot,
            summary,
            next_ordinal: content.next_ordinal,
            rows,
        };
        codec::encode(&page, MAX_CONTENT_PAGE_BYTES)?;
        Ok(page)
    }
}
