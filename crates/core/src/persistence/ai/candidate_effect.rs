//! Historical candidate provenance is an observation, not a renewed plan grant.
use super::*;
use crate::{
    TranslationOrigin,
    application::{AutomaticSelectionReceipt, AutomationLease},
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAiCandidateEffect {
    pub project_id: ExecutionId,
    pub unit_id: ExecutionId,
    pub locale: String,
    pub revision_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub item_id: ExecutionId,
    pub result_id: ExecutionId,
    pub task_id: ExecutionId,
    pub lease: Option<AutomationLease>,
    pub current_result: bool,
    pub receipt: Option<AutomaticSelectionReceipt>,
}

impl ProjectStore {
    /// Resolve one immutable AI revision, including legacy, Arena and team translation
    /// producers. Historical authority is checked for association, never resumed.
    pub fn saved_ai_candidate_effect(
        &self,
        project: ExecutionId,
        unit: ExecutionId,
        locale: &str,
        revision: ExecutionId,
    ) -> Result<SavedAiCandidateEffect, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| error(ErrorCode::StorageFailed, "ai-candidate-effect-read"))?;
        super::super::review::read_snapshot(connection, |connection| {
            let saved = self.translation_revision(project, unit, locale, revision)?;
            if saved.origin_kind != TranslationOrigin::Ai {
                return Err(error(ErrorCode::InvalidInput, "ai-candidate-effect-origin"));
            }
            let (Some(attempt), Some(item_id), Some(result_id)) =
                (saved.attempt_id, saved.item_id, saved.result_id)
            else {
                return Err(error(
                    ErrorCode::CorruptLedger,
                    "ai-candidate-effect-origin",
                ));
            };
            let input = self.execution_input(attempt)?;
            let result = self.execution_result(attempt, result_id)?;
            let (item, output) = if input.envelope().operation == crate::ai::arena::OPERATION {
                (
                    crate::ai::arena::item_payload(&input, item_id)?.item,
                    crate::ai::arena::validate_output(&input, &result)?,
                )
            } else if input.envelope().operation == crate::ai::team::OPERATION {
                (
                    crate::ai::item_payload(&input, item_id)?,
                    super::team_translation_output(&input, &result)?,
                )
            } else {
                (
                    crate::ai::item_payload(&input, item_id)?,
                    crate::ai::validate_output(&input, &result)?,
                )
            };
            if input.envelope().project_id != project
                || input.envelope().attempt_id != attempt
                || result.envelope().project_id != project
                || result.envelope().attempt_id != attempt
                || result.envelope().item_id != item_id
                || result.envelope().result_id != result_id
                || item.unit_id != unit
                || item.target_locale != locale
                || item.source_snapshot_id != saved.source_snapshot_id
                || item.source_revision_id != saved.source_revision_id
                || output.unit_id != unit
                || output.target_locale != locale
                || output.text != saved.text
            {
                return Err(error(
                    ErrorCode::CorruptLedger,
                    "ai-candidate-effect-provenance",
                ));
            }
            let lease = input.envelope().automation;
            let association: Option<(String, i64)> = connection
                .query_row(
                    "SELECT plan_id,generation FROM application_executions WHERE attempt_id=?1",
                    [attempt.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(super::super::ledger::sql_error)?;
            match (lease, association) {
                (None, None) => {}
                (Some(lease), Some((plan, generation)))
                    if plan == lease.plan_id.to_string()
                        && generation > 0
                        && generation as u64 == lease.generation.get() =>
                {
                    let plan = self.work_plan(lease.plan_id)?;
                    let status = self.work_plan_status(lease.plan_id)?;
                    if plan.project_id != project
                        || plan.locale != locale
                        || status.lease.plan_id != lease.plan_id
                        || status.lease.generation < lease.generation
                        || !plan.selection_basis.iter().any(|basis| {
                            basis.unit_id == unit
                                && basis.source_snapshot_id == item.source_snapshot_id
                                && basis.source_revision_id == item.source_revision_id
                                && basis.native_key == item.native_key
                        })
                    {
                        return Err(error(ErrorCode::CorruptLedger, "ai-candidate-effect-plan"));
                    }
                }
                _ => return Err(error(ErrorCode::CorruptLedger, "ai-candidate-effect-plan")),
            }
            let receipt = lease
                .map(|lease| self.automatic_selection_for_candidate(lease, revision))
                .transpose()?
                .flatten();
            let value = SavedAiCandidateEffect {
                project_id: project,
                unit_id: unit,
                locale: locale.into(),
                revision_id: revision,
                source_snapshot_id: saved.source_snapshot_id,
                source_revision_id: saved.source_revision_id,
                attempt_id: attempt,
                item_id,
                result_id,
                task_id: input.envelope().task_id,
                lease,
                current_result: self.execution_current_result(attempt, item_id)? == Some(result_id),
                receipt,
            };
            codec::encode(&value, crate::content::MAX_CONTENT_PAGE_BYTES)?;
            Ok(value)
        })
    }
}
