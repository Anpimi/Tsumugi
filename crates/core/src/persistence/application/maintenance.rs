//! Maintenance derives from existing impact, review and protection owners.
use super::*;
use crate::application::{
    MaintenanceAction, MaintenanceAssessment, MaintenancePlanBasis, MaintenanceRow,
};
use crate::execution::MAX_INPUT_BYTES;

impl ProjectStore {
    pub fn maintenance_assessment(
        &self,
        project: ExecutionId,
        snapshot: ExecutionId,
        locale: &str,
        after: u32,
        limit: u32,
    ) -> Result<MaintenanceAssessment, ExecutionError> {
        self.capture_maintenance_assessment(project, snapshot, locale, after, limit)?
            .evaluate()
    }
    pub(in crate::persistence) fn capture_maintenance_assessment(
        &self,
        project: ExecutionId,
        snapshot: ExecutionId,
        locale: &str,
        after: u32,
        limit: u32,
    ) -> Result<CapturedMaintenanceAssessment, ExecutionError> {
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
            let (impact_rows, next_ordinal, targets) =
                self.source_impact_window(snapshot, locale, after, limit)?;
            let units = targets.iter().map(|v| v.unit_id).collect::<Vec<_>>();
            let impacts = self.capture_resource_impacts(project, locale, Some(&units))?;
            let mut seen = std::collections::BTreeSet::new();
            let mut rows = Vec::new();
            for row in impact_rows.clone() {
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
            let assessment = MaintenanceAssessment {
                project_id: project,
                source_snapshot_id: snapshot,
                locale: locale.into(),
                after,
                limit,
                next_ordinal,
                rows,
                coverage: "finite-current-source-window; explicit-unit-and-literal-possible-resource-impact; historical-and-external-query-coverage-unknown".into(),
                digest: String::new(),
            };
            let capture = CapturedMaintenanceAssessment {
                assessment,
                impact_rows,
                targets,
                impacts,
            };
            crate::execution::codec::encode(&capture, MAX_INPUT_BYTES)?;
            Ok(capture)
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

/// Bounded immutable data captured in one read snapshot. Matching resource
/// history and assessment serialization can run on the existing IO executor.
#[derive(Clone, Debug, serde::Serialize)]
pub(crate) struct CapturedMaintenanceAssessment {
    assessment: MaintenanceAssessment,
    impact_rows: Vec<crate::content::SourceImpactRow>,
    targets: Vec<crate::ReviewTarget>,
    impacts: super::super::resources::CapturedResourceImpacts,
}
impl CapturedMaintenanceAssessment {
    pub(crate) fn evaluate(self) -> Result<MaintenanceAssessment, ExecutionError> {
        let Self {
            mut assessment,
            mut impact_rows,
            targets,
            impacts,
        } = self;
        let impacts = impacts
            .evaluate()?
            .into_iter()
            .map(|v| (v.unit_id, v))
            .collect::<std::collections::BTreeMap<_, _>>();
        let targets = targets
            .into_iter()
            .map(|v| (v.unit_id, v))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut seen = std::collections::BTreeSet::new();
        for impact in &mut impact_rows {
            let unit = impact
                .current
                .unit_id
                .ok_or_else(|| ExecutionError::new(ErrorCode::CorruptLedger, "maintenance-unit"))?;
            if !seen.insert(unit) {
                continue;
            }
            let target = targets
                .get(&unit)
                .ok_or_else(|| ExecutionError::new(ErrorCode::CorruptLedger, "maintenance-unit"))?;
            let mut reasons = super::super::review::assess(target, impacts.contains_key(&unit)).0;
            if reasons.iter().any(|r| r == "resource-impact-unresolved") {
                if let Some(changes) = impacts.get(&unit) {
                    reasons.extend(
                        changes
                            .reasons
                            .iter()
                            .map(|r| format!("resource-change:{}", r.change_id)),
                    );
                }
            }
            super::super::content::maintenance::apply_impact_reasons(impact, reasons);
            let row = assessment
                .rows
                .iter_mut()
                .find(|r| r.unit_id == unit)
                .ok_or_else(|| ExecutionError::new(ErrorCode::CorruptLedger, "maintenance-unit"))?;
            row.reasons = impact.reasons.clone();
            row.mapping_unresolved = row.reasons.iter().any(|r| r == "correspondence-unresolved");
            row.suggested = if row.mapping_unresolved {
                MaintenanceAction::Unresolved
            } else if row.reasons.is_empty() {
                MaintenanceAction::Keep
            } else if row.selection_id.is_none() {
                MaintenanceAction::Repair
            } else {
                MaintenanceAction::Recheck
            };
        }
        assessment.digest = assessment.computed_digest()?;
        assessment.validate()?;
        Ok(assessment)
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
