//! Historical build projections use one read snapshot and the original plan,
//! result frames and SDK artifact validation. Reading never restores a permit.
use super::*;
use crate::execution::{ExecutionState, ItemStatus};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SavedBuildArtifact {
    pub id: String,
    pub role: String,
    pub logical_path: String,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
    pub byte_length: u32,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SavedBuildResult {
    pub result_id: ExecutionId,
    pub result_digest: String,
    pub outcome: ExecutionState,
    pub artifacts: Vec<SavedBuildArtifact>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SavedBuildLocale {
    pub item_id: ExecutionId,
    pub choice: PluginBuildLocaleChoice,
    #[cfg_attr(feature = "wire-schema", schemars(range(max = 4294967295u64)))]
    pub target_count: u32,
    pub status: ItemStatus,
    pub result: Option<SavedBuildResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SavedPluginBuildView {
    pub project_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub source_snapshot_id: ExecutionId,
    pub policy_version: String,
    pub eligibility_basis: String,
    pub build: ReleaseBuildEnvironment,
    pub locales: Vec<SavedBuildLocale>,
}

impl ProjectStore {
    /// Read a saved plugin build without consulting installed packages, current
    /// eligibility or execution authorization. Those remain separate gates.
    pub fn read_saved_plugin_build(
        &self,
        project: ExecutionId,
        attempt: ExecutionId,
        active: bool,
    ) -> Result<SavedPluginBuildView, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "saved-build-read"))?;
        super::super::review::read_snapshot(connection, |connection| {
            let input = super::super::ledger::load_input_cached(connection, attempt)?;
            let plan = ReleasePlan::from_input(&input)?;
            let metadata = super::super::read_metadata_from(connection)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "saved-build-project"))?;
            if plan.project_id() != project
                || metadata.project_id().to_string() != project.to_string()
            {
                return Err(failure(ErrorCode::Unauthorized, "build-project"));
            }
            plan.validate_source_reference(connection)?;
            let states = self.execution_attempt(attempt, active)?;
            let locales = plan
                .choices()
                .into_iter()
                .map(|choice| {
                    let item = input
                        .envelope()
                        .items
                        .iter()
                        .find(|item| item.scope.locale.as_deref() == Some(choice.locale.as_str()))
                        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "saved-build-item"))?;
                    let status = states
                        .items
                        .iter()
                        .find(|status| status.item_id == item.item_id)
                        .cloned()
                        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "saved-build-state"))?;
                    let result = self
                        .execution_current_result(attempt, item.item_id)?
                        .map(|id| {
                            let result = super::super::ledger::load_result(connection, &input, id)?;
                            let envelope = result.envelope();
                            if envelope.item_id != item.item_id
                                || envelope.outcome != status.execution
                            {
                                return Err(failure(
                                    ErrorCode::ResultMismatch,
                                    "saved-build-result",
                                ));
                            }
                            let artifacts = if envelope.outcome == ExecutionState::Succeeded {
                                let output = plan.artifact_set(&result)?;
                                if output.target_language != choice.locale {
                                    return Err(failure(
                                        ErrorCode::ResultMismatch,
                                        "saved-build-locale",
                                    ));
                                }
                                output
                                    .artifacts
                                    .into_iter()
                                    .map(|artifact| {
                                        Ok(SavedBuildArtifact {
                                            id: artifact.id,
                                            role: artifact.role,
                                            logical_path: artifact.logical_path,
                                            byte_length: u32::try_from(artifact.utf8.len())
                                                .map_err(|_| {
                                                    failure(
                                                        ErrorCode::OutputInvalid,
                                                        "saved-build-size",
                                                    )
                                                })?,
                                            sha256: artifact.sha256,
                                        })
                                    })
                                    .collect::<Result<Vec<_>, ExecutionError>>()?
                            } else {
                                Vec::new()
                            };
                            Ok(SavedBuildResult {
                                result_id: id,
                                result_digest: result.digest().into(),
                                outcome: envelope.outcome,
                                artifacts,
                            })
                        })
                        .transpose()?;
                    let target_count = u32::try_from(
                        plan.plugin_input(&choice.locale)?.targets.len(),
                    )
                    .map_err(|_| failure(ErrorCode::OutputInvalid, "saved-build-target-count"))?;
                    Ok(SavedBuildLocale {
                        item_id: item.item_id,
                        choice,
                        target_count,
                        status,
                        result,
                    })
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?;
            Ok(SavedPluginBuildView {
                project_id: project,
                task_id: input.envelope().task_id,
                attempt_id: attempt,
                input_digest: input.digest().into(),
                source_snapshot_id: plan.source_snapshot_id(),
                policy_version: plan.policy_version().into(),
                eligibility_basis: plan.eligibility_basis().into(),
                build: plan.build_environment().clone(),
                locales,
            })
        })
    }
}
