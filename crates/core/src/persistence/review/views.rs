//! Session-local read scopes fix membership and order without persisting business data.
use super::*;
use std::{cell::RefCell, collections::VecDeque};

const MAX_READ_SCOPES: usize = 8;
const PREVIEW_CHARS: usize = 256;

#[derive(Clone, Debug)]
struct ReadScope {
    id: ExecutionId,
    project_id: ExecutionId,
    snapshot_id: ExecutionId,
    locale: String,
    query: String,
    units: Vec<(ExecutionId, u32)>,
}

#[derive(Debug, Default)]
pub(in crate::persistence) struct ReadScopes(RefCell<VecDeque<ReadScope>>);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSummaryDecision {
    pub decision_id: ExecutionId,
    pub basis: String,
    pub kind: ReviewDecisionKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSummaryCheck {
    pub run_id: ExecutionId,
    pub basis: String,
    pub outcome: String,
    pub has_findings: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSummary {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub native_key: String,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub source_preview: String,
    pub translation_preview: Option<String>,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub basis: String,
    pub current_decision: Option<ReviewSummaryDecision>,
    pub current_check: Option<ReviewSummaryCheck>,
}

impl From<ReviewTarget> for ReviewSummary {
    fn from(target: ReviewTarget) -> Self {
        Self {
            unit_id: target.unit_id,
            locale: target.locale,
            native_key: target.native_key,
            source_snapshot_id: target.source_snapshot_id,
            source_revision_id: target.source_revision_id,
            source_preview: target.source_text.chars().take(PREVIEW_CHARS).collect(),
            translation_preview: target
                .translation_text
                .map(|text| text.chars().take(PREVIEW_CHARS).collect()),
            selection_id: target.selection_id,
            revision_id: target.revision_id,
            basis: target.basis,
            current_decision: target
                .current_decision
                .map(|decision| ReviewSummaryDecision {
                    decision_id: decision.decision_id,
                    basis: decision.basis,
                    kind: decision.kind,
                }),
            current_check: target.current_check.map(|check| ReviewSummaryCheck {
                run_id: check.run_id,
                basis: check.basis,
                outcome: check.outcome,
                has_findings: check.rules.iter().any(|rule| rule.status == "findings"),
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSummaryPage {
    pub rows: Vec<ReviewSummary>,
    pub next_ordinal: Option<u32>,
    pub total: u32,
    pub scope_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub read_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewEditorSnapshot {
    pub target: ReviewTarget,
    pub translations: super::super::translation::TranslationHistory,
    pub terms: resources::TermResolution,
    pub context: Option<resources::ContextRevision>,
    pub read_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewNeighbor {
    pub unit_id: Option<ExecutionId>,
    pub after_ordinal: Option<u32>,
    pub source_snapshot_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewScopeUnit {
    pub unit_id: ExecutionId,
    pub expected_basis: String,
    pub expected_decision_id: Option<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewScopeCapture {
    pub scope_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub locale: String,
    pub query: String,
    pub units: Vec<ReviewScopeUnit>,
    pub read_version: String,
}

fn view_version(targets: &[ReviewTarget]) -> Result<String, ExecutionError> {
    use sha2::Digest;
    let mut hash = sha2::Sha256::new();
    for target in targets {
        let unit_digest = digest(&(
            target.unit_id,
            &target.locale,
            target.source_snapshot_id,
            &target.basis,
            target
                .current_decision
                .as_ref()
                .map(|item| item.decision_id),
            target.current_check.as_ref().map(|item| item.run_id),
            target
                .current_fallback
                .as_ref()
                .map(|item| item.fallback_id),
            target
                .current_waivers
                .iter()
                .map(|item| item.waiver_id)
                .collect::<Vec<_>>(),
        ))?;
        // Fixed-width digests avoid building a multi-megabyte encoded scope.
        hash.update(unit_digest.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

impl ProjectStore {
    fn retained_review_scope(
        &self,
        connection: &Connection,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
    ) -> Result<ReadScope, ExecutionError> {
        check_project(connection, project_id, locale)?;
        let scope = self
            .review_scopes
            .0
            .borrow()
            .iter()
            .find(|scope| scope.id == scope_id)
            .cloned()
            .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-scope-expired"))?;
        if scope.project_id != project_id || scope.locale != locale {
            return Err(failure(ErrorCode::Unauthorized, "review-scope"));
        }
        let snapshot: Option<String> = connection
            .query_row(
                "SELECT current_snapshot FROM content_scope WHERE row_id=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql)?;
        if snapshot.as_deref() != Some(scope.snapshot_id.to_string().as_str()) {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "review-scope-source-changed",
            ));
        }
        Ok(scope)
    }

    fn capture_review_read_scope(
        &self,
        connection: &Connection,
        project_id: ExecutionId,
        locale: &str,
        query: &str,
    ) -> Result<ReadScope, ExecutionError> {
        if query.len() > 256 || query.contains('\0') {
            return Err(failure(ErrorCode::InvalidInput, "review-query"));
        }
        check_project(connection, project_id, locale)?;
        let snapshot: Option<String> = connection
            .query_row(
                "SELECT current_snapshot FROM content_scope WHERE row_id=1",
                [],
                |row| row.get(0),
            )
            .map_err(sql)?;
        let snapshot_id = parse_id(
            snapshot.ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-source"))?,
        )?;
        let units = if query.is_empty() {
            // Fix identity/order across pages without reading every unit's text.
            let mut statement = connection
                .prepare(
                    "SELECT o.unit_id,o.ordinal FROM source_occurrences o
                 JOIN source_units u ON u.unit_id=o.unit_id
                 WHERE o.snapshot_id=?1 AND u.project_id=?2 ORDER BY o.ordinal LIMIT 10001",
                )
                .map_err(sql)?;
            statement
                .query_map(
                    params![snapshot_id.to_string(), project_id.to_string()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
                )
                .map_err(sql)?
                .map(|row| {
                    let (unit, ordinal) = row.map_err(sql)?;
                    Ok((parse_id(unit)?, ordinal))
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT o.unit_id,o.ordinal,o.native_key,r.text,tr.text
             FROM source_occurrences o JOIN source_revisions r ON r.revision_id=o.revision_id
             JOIN source_units u ON u.unit_id=o.unit_id AND u.project_id=?3
             LEFT JOIN translation_selections s ON s.unit_id=o.unit_id AND s.locale=?2
               AND s.sequence=(SELECT MAX(t.sequence) FROM translation_selections t
                               WHERE t.unit_id=o.unit_id AND t.locale=?2)
             LEFT JOIN translation_revisions tr ON tr.revision_id=s.revision_id
             WHERE o.snapshot_id=?1 ORDER BY o.ordinal LIMIT 10001",
                )
                .map_err(sql)?;
            let rows = statement
                .query_map(
                    params![snapshot_id.to_string(), locale, project_id.to_string()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, u32>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, Option<String>>(4)?,
                        ))
                    },
                )
                .map_err(sql)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql)?;
            let needle = query.to_lowercase();
            if rows.len() > MAX_SCOPE {
                return Err(failure(ErrorCode::LimitExceeded, "review-scope"));
            }
            rows.into_iter()
                .filter(|(_, _, key, source, translation)| {
                    needle.is_empty()
                        || key.to_lowercase().contains(&needle)
                        || source.to_lowercase().contains(&needle)
                        || translation
                            .as_ref()
                            .is_some_and(|text| text.to_lowercase().contains(&needle))
                })
                .map(|(unit, ordinal, _, _, _)| Ok((parse_id(unit)?, ordinal)))
                .collect::<Result<Vec<_>, ExecutionError>>()?
        };
        if units.len() > MAX_SCOPE {
            return Err(failure(ErrorCode::LimitExceeded, "review-scope"));
        }
        let scope = ReadScope {
            id: ExecutionId::new(),
            project_id,
            snapshot_id,
            locale: locale.to_owned(),
            query: query.to_owned(),
            units,
        };
        let mut retained = self.review_scopes.0.borrow_mut();
        if retained.len() == MAX_READ_SCOPES {
            retained.pop_front();
        }
        retained.push_back(scope.clone());
        Ok(scope)
    }

    /// Membership is captured once; later pages and saves cannot expand the filter.
    pub fn review_summary_page(
        &self,
        project_id: ExecutionId,
        locale: &str,
        after_ordinal: u32,
        limit: u32,
        query: &str,
        scope_id: Option<ExecutionId>,
    ) -> Result<ReviewSummaryPage, ExecutionError> {
        if limit == 0 || limit > 100 || after_ordinal > MAX_SCOPE as u32 {
            return Err(failure(ErrorCode::InvalidInput, "review-page"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        queries::read_snapshot(connection, |connection| {
            let scope = match scope_id {
                Some(id) => self.retained_review_scope(connection, project_id, locale, id)?,
                None => self.capture_review_read_scope(connection, project_id, locale, query)?,
            };
            if scope.query != query {
                return Err(failure(ErrorCode::DependencyConflict, "review-scope-query"));
            }
            let page: Vec<_> = scope
                .units
                .iter()
                .filter(|(_, ordinal)| *ordinal >= after_ordinal)
                .take(limit as usize + 1)
                .copied()
                .collect();
            let next_ordinal = page.get(limit as usize).map(|(_, ordinal)| *ordinal);
            let units: Vec<_> = page
                .into_iter()
                .take(limit as usize)
                .map(|(unit, _)| unit)
                .collect();
            let targets = queries::targets_in(connection, project_id, &units, locale)?;
            let read_version = view_version(&targets)?;
            Ok(ReviewSummaryPage {
                rows: targets.into_iter().map(ReviewSummary::from).collect(),
                next_ordinal,
                total: scope.units.len() as u32,
                scope_id: scope.id,
                source_snapshot_id: scope.snapshot_id,
                read_version,
            })
        })
    }

    pub fn review_neighbor(
        &self,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
        unit_id: ExecutionId,
        direction: i32,
    ) -> Result<ReviewNeighbor, ExecutionError> {
        if !matches!(direction, -1 | 1) {
            return Err(failure(ErrorCode::InvalidInput, "review-direction"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        queries::read_snapshot(connection, |connection| {
            let scope = self.retained_review_scope(connection, project_id, locale, scope_id)?;
            let position = scope
                .units
                .iter()
                .position(|(unit, _)| *unit == unit_id)
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-scope-unit"))?;
            let next = if direction < 0 {
                position.checked_sub(1)
            } else {
                position.checked_add(1)
            };
            let neighbor = next.and_then(|position| scope.units.get(position));
            Ok(ReviewNeighbor {
                unit_id: neighbor.map(|(unit, _)| *unit),
                after_ordinal: neighbor.map(|(_, ordinal)| *ordinal),
                source_snapshot_id: scope.snapshot_id,
            })
        })
    }

    /// Capture all fixed members (minus explicit exclusions), with mutation bases.
    pub fn review_scope_capture(
        &self,
        project_id: ExecutionId,
        locale: &str,
        scope_id: ExecutionId,
        excluded: &[ExecutionId],
    ) -> Result<ReviewScopeCapture, ExecutionError> {
        if excluded.len() > MAX_SCOPE {
            return Err(failure(ErrorCode::InvalidInput, "review-scope-exclusions"));
        }
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        queries::read_snapshot(connection, |connection| {
            let scope = self.retained_review_scope(connection, project_id, locale, scope_id)?;
            let exclusions: BTreeSet<_> = excluded.iter().copied().collect();
            if exclusions.len() != excluded.len()
                || exclusions.len() > MAX_SCOPE
                || exclusions
                    .iter()
                    .any(|unit| !scope.units.iter().any(|(member, _)| member == unit))
            {
                return Err(failure(ErrorCode::InvalidInput, "review-scope-exclusions"));
            }
            let units: Vec<_> = scope
                .units
                .iter()
                .map(|(unit, _)| *unit)
                .filter(|unit| !exclusions.contains(unit))
                .collect();
            let targets = queries::targets_in(connection, project_id, &units, locale)?;
            let read_version = view_version(&targets)?;
            Ok(ReviewScopeCapture {
                scope_id,
                source_snapshot_id: scope.snapshot_id,
                locale: scope.locale,
                query: scope.query,
                read_version,
                units: targets
                    .into_iter()
                    .map(|target| ReviewScopeUnit {
                        unit_id: target.unit_id,
                        expected_basis: target.basis,
                        expected_decision_id: target
                            .current_decision
                            .map(|decision| decision.decision_id),
                    })
                    .collect(),
            })
        })
    }

    pub fn review_editor_snapshot(
        &self,
        project_id: ExecutionId,
        unit_id: ExecutionId,
        locale: &str,
    ) -> Result<ReviewEditorSnapshot, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "review-read"))?;
        queries::read_snapshot(connection, |connection| {
            let target = queries::targets_in(connection, project_id, &[unit_id], locale)?
                .pop()
                .ok_or_else(|| failure(ErrorCode::DependencyConflict, "review-unit"))?;
            let first = self.translation_history(project_id, unit_id, locale, 0, 1)?;
            let translations = self.translation_history(
                project_id,
                unit_id,
                locale,
                first.total.saturating_sub(100),
                100,
            )?;
            let terms = resources::resolve_terms_in(connection, project_id, unit_id, locale)?;
            let context = resources::current_context(connection, project_id, unit_id, locale)?;
            let read_version = view_version(std::slice::from_ref(&target))?;
            Ok(ReviewEditorSnapshot {
                target,
                translations,
                terms,
                context,
                read_version,
            })
        })
    }
}
