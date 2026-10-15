//! Maintenance derives from existing impact, review and protection owners.
use super::*;
use crate::application::{
    MaintenanceAction, MaintenanceAssessment, MaintenancePlanBasis, MaintenanceRow,
};

impl ProjectStore {
    pub fn maintenance_assessment(
        &self,
        project: ExecutionId,
        snapshot: ExecutionId,
        locale: &str,
        after: u32,
        limit: u32,
    ) -> Result<MaintenanceAssessment, ExecutionError> {
        if limit == 0 || limit > 100 {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "maintenance-page",
            ));
        }
        let connection = self
            .connection()
            .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "maintenance-read"))?;
        super::super::review::read_snapshot(connection, |_| {
            if self
                .metadata()
                .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "maintenance-read"))?
                .project_id()
                .to_string()
                != project.to_string()
            {
                return Err(ExecutionError::new(
                    ErrorCode::Unauthorized,
                    "maintenance-project",
                ));
            }
            // One existing impact calculation supplies the whole finite window.
            // It does not imply coverage of arbitrary external query dependencies.
            let page = self.source_impact(snapshot, locale, after, limit)?;
            let mut seen = std::collections::BTreeSet::new();
            let mut rows = Vec::new();
            for row in page.rows {
                let unit = row.current.unit_id.ok_or_else(|| {
                    ExecutionError::new(ErrorCode::CorruptLedger, "maintenance-unit")
                })?;
                if !seen.insert(unit) {
                    continue;
                }
                let mapping_unresolved = row
                    .reasons
                    .iter()
                    .any(|reason| reason == "correspondence-unresolved");
                let suggested = if mapping_unresolved {
                    MaintenanceAction::Unresolved
                } else if row.reasons.is_empty() {
                    MaintenanceAction::Keep
                } else if row.selection_id.is_none() {
                    MaintenanceAction::Repair
                } else {
                    MaintenanceAction::Recheck
                };
                let translation_text = match row.translation_revision_id {
                    Some(id) => Some(
                        connection
                            .query_row(
                                "SELECT text FROM translation_revisions WHERE revision_id=?1",
                                [id.to_string()],
                                |row| row.get(0),
                            )
                            .map_err(|_| {
                                ExecutionError::new(
                                    ErrorCode::CorruptLedger,
                                    "maintenance-translation",
                                )
                            })?,
                    ),
                    None => None,
                };
                rows.push(MaintenanceRow {
                    unit_id: unit,
                    source_text: row.current.occurrence.text,
                    translation_text,
                    source_revision_id: row.current.source_revision_id.ok_or_else(|| {
                        ExecutionError::new(ErrorCode::CorruptLedger, "maintenance-source")
                    })?,
                    native_key: row.current.occurrence.key,
                    selection_id: row.selection_id,
                    translation_revision_id: row.translation_revision_id,
                    review_basis: row.review_basis,
                    protection: self.work_protection(unit, locale)?,
                    mapping_unresolved,
                    reasons: row.reasons,
                    suggested,
                });
            }
            let mut assessment = MaintenanceAssessment {
                project_id: project,
                source_snapshot_id: snapshot,
                locale: locale.into(),
                after,
                limit,
                next_ordinal: page.next_ordinal,
                rows,
                coverage: "finite-current-source-window; explicit-unit-and-literal-possible-resource-impact; historical-and-external-query-coverage-unknown".into(),
                digest: String::new(),
            };
            assessment.digest = assessment.computed_digest()?;
            assessment.validate()?;
            Ok(assessment)
        })
    }

    pub fn prepare_maintenance_work_plan(
        &self,
        config: Option<AiConfig>,
        locale: &str,
        units: &[ExecutionId],
        options: PlanOptions,
        tools: Option<crate::application::WorkPlanTools>,
        basis: MaintenancePlanBasis,
    ) -> Result<WorkPlan, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "maintenance-read"))?;
        super::super::review::read_snapshot(connection, |_| {
            let selected = basis.repair_units()?;
            let mut requested = units.to_vec();
            requested.sort();
            let old = &basis.assessment;
            if selected != requested
                || locale != old.locale
                || self.maintenance_assessment(
                    old.project_id,
                    old.source_snapshot_id,
                    locale,
                    old.after,
                    old.limit,
                )? != *old
            {
                return Err(ExecutionError::new(
                    ErrorCode::DependencyConflict,
                    "maintenance-current",
                ));
            }
            self.prepare_work_plan_with_tools(config, locale, units, options, tools)?
                .with_maintenance(basis)
        })
    }
}

pub(super) fn check_protection(
    c: &rusqlite::Connection,
    plan: &WorkPlan,
) -> Result<(), ExecutionError> {
    if let Some(basis) = &plan.maintenance {
        for unit in basis.repair_units()? {
            let row = basis
                .assessment
                .rows
                .iter()
                .find(|row| row.unit_id == unit)
                .unwrap();
            let current = super::control::protection(c, unit, &plan.locale)?;
            if current.protected || current.revision != row.protection.revision {
                return Err(ExecutionError::new(
                    ErrorCode::DependencyConflict,
                    "maintenance-protection",
                ));
            }
        }
    }
    Ok(())
}
