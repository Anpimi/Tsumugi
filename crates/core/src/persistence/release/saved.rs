//! Historical build projections use one read snapshot and the original plan,
//! result frames and SDK artifact validation. Reading never restores a permit.
use super::*;
use crate::execution::{ExecutionState, ItemStatus};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SavedArtifactCheckProof {
    pub checker_attempt_id: ExecutionId,
    pub checker_input_digest: String,
    pub checker_result_id: ExecutionId,
    pub checker_result_digest: String,
    pub checker: crate::execution::PluginExecutionBinding,
    pub valid: bool,
    #[serde(deserialize_with = "required_checks")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "checks_schema"))]
    pub checks: Option<Vec<tsumugi_plugin_sdk::CheckResult>>,
}
fn required_checks<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<tsumugi_plugin_sdk::CheckResult>>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn checks_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<Vec<tsumugi_plugin_sdk::CheckResult>> as schemars::JsonSchema>::json_schema(g)
}
fn required_proof<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<SavedArtifactCheckProof>, D::Error> {
    Option::deserialize(d)
}
#[cfg(feature = "wire-schema")]
fn proof_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<SavedArtifactCheckProof> as schemars::JsonSchema>::json_schema(g)
}

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
    #[serde(deserialize_with = "required_proof")]
    #[cfg_attr(feature = "wire-schema", schemars(schema_with = "proof_schema"))]
    pub artifact_check: Option<SavedArtifactCheckProof>,
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
            let cache = self.release_reads.borrow();
            if let Some(view) = cache
                .builds_at(connection)?
                .iter()
                .find(|view| view.project_id == project && view.attempt_id == attempt)
            {
                return Ok(view.as_ref().clone());
            }
            drop(cache);
            let view = read_build(connection, project, attempt, active)?;
            // A completed attempt has the same status for an active and an
            // inactive runtime. Never cache the active/unknown projection of
            // an in-flight attempt.
            if view
                .locales
                .iter()
                .all(|locale| locale.status.adoption == crate::execution::AdoptionState::Committed)
                && codec::check_encoded_size(&view, 1024 * 1024).is_ok()
            {
                let mut cache = self.release_reads.borrow_mut();
                let mut builds = cache.builds_at(connection)?.to_vec();
                builds.truncate(super::RETAINED_RELEASES - 1);
                builds.insert(0, Arc::new(view.clone()));
                cache.remember_builds(connection, builds)?;
            }
            Ok(view)
        })
    }
}

pub(in crate::persistence) fn read_build(
    connection: &Connection,
    project: ExecutionId,
    attempt: ExecutionId,
    active: bool,
) -> Result<SavedPluginBuildView, ExecutionError> {
    use super::super::ledger;
    let metadata = super::super::read_metadata_from(connection)
        .map_err(|_| failure(ErrorCode::CorruptLedger, "saved-build-project"))?;
    if metadata.project_id().to_string() != project.to_string() {
        return Err(failure(ErrorCode::Unauthorized, "build-project"));
    }
    let input = ledger::load_input_cached(connection, attempt)?;
    let plan = ReleasePlan::from_input(&input)?;
    if plan.project_id() != project {
        return Err(failure(ErrorCode::Unauthorized, "build-project"));
    }
    plan.validate_source_reference(connection)?;
    // The status check and history projection share this exact result. Retain
    // only display data while advancing to the next locale, not artifact bytes.
    let mut results = BTreeMap::new();
    let states = ledger::read_attempt_results_in(
        connection,
        &input,
        active,
        |id| ledger::load_result(connection, &input, id),
        |result, requires_proof| {
            let envelope = result.envelope();
            let original = ledger::result_input(connection, &input, envelope.result_id)?;
            // result_input checks that a reused attempt has identical settings,
            // item and provider. Validate its checker against the original IDs.
            let checked = ledger::checked_build_artifacts(connection, &original, result, &plan)?;
            if requires_proof && !checked.as_ref().is_some_and(|(proof, _)| proof.valid) {
                return Err(failure(
                    ErrorCode::CorruptLedger,
                    "semantic-validation-proof",
                ));
            }
            let (proof, output) = match checked {
                Some((proof, output)) => (Some(proof), Some(output)),
                None if envelope.outcome == ExecutionState::Succeeded => {
                    (None, Some(plan.artifact_set(result)?))
                }
                None => (None, None),
            };
            results.insert(
                envelope.item_id,
                (summarize_result(&input, result, output.as_ref())?, proof),
            );
            Ok(())
        },
        true,
    )?;
    build_view(&input, &plan, states, results)
}

pub(in crate::persistence) type SavedBuildParts =
    BTreeMap<ExecutionId, (SavedBuildResult, Option<SavedArtifactCheckProof>)>;

pub(in crate::persistence) fn summarize_result(
    input: &crate::execution::FixedInput,
    result: &crate::execution::FixedResult,
    output: Option<&tsumugi_plugin_sdk::ArtifactSet>,
) -> Result<SavedBuildResult, ExecutionError> {
    let envelope = result.envelope();
    let mut artifacts = Vec::new();
    if let Some(output) = output {
        let item = input.item(envelope.item_id)?;
        if item.scope.locale.as_deref() != Some(output.target_language.as_str()) {
            return Err(failure(ErrorCode::ResultMismatch, "saved-build-locale"));
        }
        for artifact in &output.artifacts {
            let size = artifact
                .bytes()
                .map_err(|_| failure(ErrorCode::OutputInvalid, "saved-build-bytes"))?
                .len();
            artifacts.push(SavedBuildArtifact {
                id: artifact.id().into(),
                role: artifact.role().into(),
                logical_path: artifact.logical_path().into(),
                sha256: artifact.sha256().into(),
                byte_length: u32::try_from(size)
                    .map_err(|_| failure(ErrorCode::OutputInvalid, "saved-build-size"))?,
            });
        }
    }
    Ok(SavedBuildResult {
        result_id: envelope.result_id,
        result_digest: result.digest().into(),
        outcome: envelope.outcome,
        artifacts,
    })
}

pub(super) fn build_view(
    input: &crate::execution::FixedInput,
    plan: &ReleasePlan,
    states: super::super::ledger::AttemptView,
    mut results: SavedBuildParts,
) -> Result<SavedPluginBuildView, ExecutionError> {
    let locales = plan
        .saved_locales()
        .map(|(choice, count)| {
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
            let (result, artifact_check) = match results.remove(&item.item_id) {
                Some((result, proof)) => (Some(result), proof),
                None => (None, None),
            };
            // A successful result already required an exact validated build input.
            if !result
                .as_ref()
                .is_some_and(|r| r.outcome == ExecutionState::Succeeded)
            {
                plan.plugin_input(&choice.locale)?;
            }
            Ok(SavedBuildLocale {
                item_id: item.item_id,
                choice: choice.clone(),
                status,
                result,
                artifact_check,
                target_count: u32::try_from(count)
                    .map_err(|_| failure(ErrorCode::OutputInvalid, "saved-build-target-count"))?,
            })
        })
        .collect::<Result<Vec<_>, ExecutionError>>()?;
    Ok(SavedPluginBuildView {
        project_id: plan.project_id(),
        task_id: input.envelope().task_id,
        attempt_id: input.envelope().attempt_id,
        input_digest: input.digest().into(),
        source_snapshot_id: plan.source_snapshot_id(),
        policy_version: plan.policy_version().into(),
        eligibility_basis: plan.eligibility_basis().into(),
        build: plan.build_environment().clone(),
        locales,
    })
}
