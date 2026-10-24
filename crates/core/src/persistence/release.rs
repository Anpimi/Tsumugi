//! Fixed build inputs, verified locale artifacts and immutable local releases.

use super::ProjectStore;
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
use crate::content::{
    BUILDER_VERSION, BuildEntry, BuildLocale, BuildManifest, BuildOutput, VALIDATOR_VERSION,
    validate_build_output,
};
use crate::{
    content::{BUILD_OPERATION, BuildSourceFile},
    execution::{
        AdoptionAction, AdoptionHandler, ChangeReference, ErrorCode, ExecutionError, ExecutionId,
        FixedInput, FixedResult, MAX_INPUT_BYTES, PreparedMutation, Revision, codec,
    },
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

mod plan;
mod record;
mod saved;
pub use plan::{PluginBuildLocaleChoice, ReleaseBuildEnvironment, ReleasePlan};
pub(super) use plan::{VerifiedBuildInput, prepare_input, verify_prepared_input};
pub use saved::{
    SavedArtifactCheckProof, SavedBuildArtifact, SavedBuildLocale, SavedBuildResult,
    SavedPluginBuildView,
};

const TABLES: &[(&str, &str)] = &[
    (
        "release_records",
        "CREATE TABLE release_records (
        release_id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
        manifest BLOB NOT NULL CHECK(length(manifest) BETWEEN 1 AND 4194304),
        manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
    (
        "release_artifacts",
        "CREATE TABLE release_artifacts (
        release_id TEXT NOT NULL REFERENCES release_records(release_id),
        locale TEXT NOT NULL, artifact_id TEXT NOT NULL, role TEXT NOT NULL, file_name TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 0 AND 2097152),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        validator_version TEXT NOT NULL, entry_count INTEGER NOT NULL CHECK(entry_count>0),
        PRIMARY KEY(release_id,locale,artifact_id), UNIQUE(release_id,file_name))",
    ),
    (
        "release_deliveries",
        "CREATE TABLE release_deliveries (
        delivery_id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL UNIQUE,
        release_id TEXT NOT NULL REFERENCES release_records(release_id),
        directory TEXT NOT NULL, overwrite_conflicts INTEGER NOT NULL CHECK(overwrite_conflicts IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('pending','succeeded','partial','failed','unknown')),
        expected_json TEXT NOT NULL, results_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
];

pub(super) fn table_names() -> impl Iterator<Item = String> {
    TABLES.iter().map(|(name, _)| (*name).to_owned())
}
pub(super) fn record_input(
    connection: &Connection,
    input: &FixedInput,
    verified: Option<&VerifiedBuildInput>,
) -> Result<(), ExecutionError> {
    if input.envelope().operation != BUILD_OPERATION {
        return Ok(());
    }
    if input.envelope().plugin.is_some() {
        return plan::record_input(input, verified);
    }
    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    {
        record_builtin_input(connection, input)
    }
    #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
    {
        let _ = connection;
        Err(failure(ErrorCode::InvalidInput, "build-plugin-required"))
    }
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
fn record_builtin_input(connection: &Connection, input: &FixedInput) -> Result<(), ExecutionError> {
    let manifest = BuildManifest::from_input(input)?;
    let (attempt, project): (String, String) = connection
        .query_row(
            "SELECT attempt_id,project_id FROM source_snapshots WHERE snapshot_id=?1",
            [manifest.source_snapshot_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let source_input = super::ledger::load_input(connection, ExecutionId::parse(&attempt)?)?;
    let bundle = crate::content::SourceBundle::from_input(&source_input)?;
    if project != manifest.project_id.to_string()
        || bundle.plugin_id != manifest.plugin_id
        || bundle.plugin_version != manifest.plugin_version
        || bundle.files.len() != manifest.source_files.len()
        || bundle
            .files
            .iter()
            .zip(&manifest.source_files)
            .any(|(actual, fixed)| {
                actual.logical_path != fixed.logical_path || actual.sha256 != fixed.sha256
            })
        || manifest.locales.iter().any(|locale| {
            locale
                .source_template
                .as_ref()
                .is_some_and(|template| template != &bundle.files[0].utf8)
        })
    {
        return Err(failure(ErrorCode::OutputInvalid, "build-source-template"));
    }
    Ok(())
}
pub(super) fn initialize(connection: &Connection) -> rusqlite::Result<()> {
    for (_, definition) in TABLES {
        connection.execute_batch(definition)?;
    }
    Ok(())
}
pub(super) fn validate(connection: &Connection) -> rusqlite::Result<()> {
    for (name, expected) in TABLES {
        let actual: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |row| row.get(0),
        )?;
        if actual != *expected {
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    if connection.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let mut records = connection.prepare("SELECT release_id FROM release_records")?;
    let ids = records
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        let id = parse_id(id).map_err(|_| rusqlite::Error::InvalidQuery)?;
        record::load(connection, id).map_err(|_| rusqlite::Error::InvalidQuery)?;
    }
    let mut deliveries = connection.prepare(
        "SELECT release_id,directory,state,expected_json,results_json FROM release_deliveries",
    )?;
    let rows = deliveries.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    for row in rows {
        let (release, directory, state, expected, results) = row?;
        if directory.is_empty() || directory.len() > 4096 {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let expected: Vec<DeliveryFile> =
            serde_json::from_str(&expected).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let mut statement = connection.prepare(
            "SELECT locale,file_name,sha256 FROM release_artifacts WHERE release_id=?1 ORDER BY locale,file_name",
        )?;
        let artifacts = statement
            .query_map([&release], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if expected.is_empty()
            || expected.len() != artifacts.len()
            || expected.iter().zip(&artifacts).any(|(file, artifact)| {
                file.locale != artifact.0
                    || file.file_name != artifact.1
                    || file.expected_sha256 != artifact.2
                    || file.actual_sha256.is_some()
                    || file.state != DeliveryFileState::Pending
            })
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        match results {
            None if state == "pending" => {}
            Some(encoded) if state != "pending" => {
                let files: Vec<DeliveryFile> =
                    serde_json::from_str(&encoded).map_err(|_| rusqlite::Error::InvalidQuery)?;
                if files.len() != expected.len()
                    || files.iter().zip(&expected).any(|(file, prior)| {
                        file.locale != prior.locale
                            || file.file_name != prior.file_name
                            || file.expected_sha256 != prior.expected_sha256
                            || !matches!(
                                file.state,
                                DeliveryFileState::Succeeded
                                    | DeliveryFileState::Failed
                                    | DeliveryFileState::Unknown
                            )
                            || (file.state == DeliveryFileState::Succeeded
                                && file.actual_sha256.as_deref() != Some(&file.expected_sha256))
                    })
                {
                    return Err(rusqlite::Error::InvalidQuery);
                }
                let success = files
                    .iter()
                    .filter(|file| file.state == DeliveryFileState::Succeeded)
                    .count();
                let actual_state = if success == files.len() {
                    "succeeded"
                } else if files
                    .iter()
                    .any(|file| file.state == DeliveryFileState::Unknown)
                {
                    "unknown"
                } else if success > 0 {
                    "partial"
                } else {
                    "failed"
                };
                if state != actual_state {
                    return Err(rusqlite::Error::InvalidQuery);
                }
            }
            _ => return Err(rusqlite::Error::InvalidQuery),
        }
    }
    Ok(())
}

fn failure(code: ErrorCode, stage: &str) -> ExecutionError {
    ExecutionError::new(code, stage)
}
fn sql(error: rusqlite::Error) -> ExecutionError {
    super::ledger::sql_error(error)
}
fn parse_id(value: String) -> Result<ExecutionId, ExecutionError> {
    ExecutionId::parse(&value).map_err(|_| failure(ErrorCode::CorruptLedger, "release-identity"))
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReleaseExceptionKind {
    SourceFallback,
    QaWaiver,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryFileState {
    Pending,
    Succeeded,
    Failed,
    Unknown,
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryState {
    Pending,
    Succeeded,
    Partial,
    Failed,
    Unknown,
}
impl DeliveryState {
    fn from_stored(value: &str) -> Result<Self, ExecutionError> {
        match value {
            "pending" => Ok(Self::Pending),
            "succeeded" => Ok(Self::Succeeded),
            "partial" => Ok(Self::Partial),
            "failed" => Ok(Self::Failed),
            "unknown" => Ok(Self::Unknown),
            _ => Err(failure(ErrorCode::CorruptLedger, "delivery-state")),
        }
    }
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildLocaleChoice {
    pub locale: String,
    pub file_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReleasedArtifact {
    pub locale: String,
    pub file_name: String,
    pub sha256: String,
    pub entry_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReleaseException {
    pub locale: String,
    pub native_key: String,
    pub kind: ReleaseExceptionKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReleaseView {
    pub release_id: ExecutionId,
    pub action_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub policy_version: String,
    pub eligibility_basis: String,
    pub manifest_sha256: String,
    pub builder_version: String,
    pub validator_version: String,
    pub source_files: Vec<BuildSourceFile>,
    pub exceptions: Vec<ReleaseException>,
    pub artifacts: Vec<ReleasedArtifact>,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DeliveryFile {
    pub locale: String,
    pub file_name: String,
    pub expected_sha256: String,
    pub actual_sha256: Option<String>,
    pub state: DeliveryFileState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct DeliveryView {
    pub delivery_id: ExecutionId,
    pub action_id: ExecutionId,
    pub release_id: ExecutionId,
    pub directory: String,
    pub overwrite_conflicts: bool,
    pub state: DeliveryState,
    pub files: Vec<DeliveryFile>,
    pub created_at: String,
}

/// Immutable acknowledgement of the accepted original build request.
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub struct LocaleBuildStartReceipt {
    pub project_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub operation: String,
    pub input_digest: String,
    pub choices: Vec<BuildLocaleChoice>,
    pub expected_eligibility_basis: String,
}

impl ProjectStore {
    pub fn list_releases(
        &self,
        project_id: ExecutionId,
    ) -> Result<Vec<ReleaseView>, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "release-read"))?;
        let mut statement = connection.prepare(
            "SELECT release_id FROM release_records WHERE project_id=?1 ORDER BY created_at DESC,release_id DESC LIMIT 100",
        ).map_err(sql)?;
        let ids = statement
            .query_map([project_id.to_string()], |row| row.get::<_, String>(0))
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        ids.into_iter()
            .map(|id| self.release_view(parse_id(id)?))
            .collect()
    }

    pub fn begin_delivery(
        &mut self,
        action_id: ExecutionId,
        release_id: ExecutionId,
        directory: &str,
        overwrite_conflicts: bool,
    ) -> Result<DeliveryView, ExecutionError> {
        if let Some(existing) = self.delivery_by_action(action_id)? {
            if existing.release_id != release_id
                || existing.directory != directory
                || existing.overwrite_conflicts != overwrite_conflicts
            {
                return Err(failure(ErrorCode::DependencyConflict, "delivery-action"));
            }
            return Ok(existing);
        }
        if directory.is_empty() || directory.len() > 4096 {
            return Err(failure(ErrorCode::InvalidInput, "delivery-directory"));
        }
        let release = self.release_view(release_id)?;
        let unresolved = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-read"))?
            .prepare(
                "SELECT 1 FROM release_deliveries WHERE release_id=?1 AND directory=?2
                      AND state IN ('pending','unknown') LIMIT 1",
            )
            .map_err(sql)?
            .exists(params![release_id.to_string(), directory])
            .map_err(sql)?;
        if unresolved {
            return Err(failure(ErrorCode::OutcomeUnknown, "delivery-unresolved"));
        }
        let files: Vec<_> = release
            .artifacts
            .into_iter()
            .map(|artifact| DeliveryFile {
                locale: artifact.locale,
                file_name: artifact.file_name,
                expected_sha256: artifact.sha256,
                actual_sha256: None,
                state: DeliveryFileState::Pending,
            })
            .collect();
        let delivery_id = ExecutionId::new();
        let encoded = serde_json::to_string(&files)
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-encode"))?;
        self.connection_mut().map_err(|_| failure(ErrorCode::StorageFailed, "delivery-write"))?
            .execute(
                "INSERT INTO release_deliveries
                 (delivery_id,action_id,release_id,directory,overwrite_conflicts,state,expected_json)
                 VALUES (?1,?2,?3,?4,?5,'pending',?6)",
                params![delivery_id.to_string(),action_id.to_string(),release_id.to_string(),directory,overwrite_conflicts,encoded],
            ).map_err(sql)?;
        self.delivery_by_action(action_id)?
            .ok_or_else(|| failure(ErrorCode::StorageFailed, "delivery-write"))
    }

    pub fn delivery_by_action(
        &self,
        action_id: ExecutionId,
    ) -> Result<Option<DeliveryView>, ExecutionError> {
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-read"))?;
        let row = connection.query_row(
            "SELECT delivery_id,release_id,directory,overwrite_conflicts,state,expected_json,results_json,created_at
             FROM release_deliveries WHERE action_id=?1",
            [action_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,row.get::<_, String>(4)?,row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,row.get::<_, String>(7)?)),
        );
        let (id, release, directory, overwrite_conflicts, state, expected, results, created_at) =
            match row {
                Ok(row) => row,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(error) => return Err(sql(error)),
            };
        let files = serde_json::from_str(results.as_deref().unwrap_or(&expected))
            .map_err(|_| failure(ErrorCode::CorruptLedger, "delivery-files"))?;
        Ok(Some(DeliveryView {
            delivery_id: parse_id(id)?,
            action_id,
            release_id: parse_id(release)?,
            directory,
            overwrite_conflicts,
            state: DeliveryState::from_stored(&state)?,
            files,
            created_at,
        }))
    }

    pub fn finish_delivery(
        &mut self,
        action_id: ExecutionId,
        files: Vec<DeliveryFile>,
    ) -> Result<DeliveryView, ExecutionError> {
        let current = self
            .delivery_by_action(action_id)?
            .ok_or_else(|| failure(ErrorCode::InvalidInput, "delivery-action"))?;
        if current.state != DeliveryState::Pending {
            return Err(failure(ErrorCode::DependencyConflict, "delivery-final"));
        }
        if current.files.len() != files.len()
            || files.iter().zip(&current.files).any(|(item, prior)| {
                item.locale != prior.locale
                    || item.file_name != prior.file_name
                    || item.expected_sha256 != prior.expected_sha256
                    || !matches!(
                        item.state,
                        DeliveryFileState::Succeeded
                            | DeliveryFileState::Failed
                            | DeliveryFileState::Unknown
                    )
                    || (item.state == DeliveryFileState::Succeeded
                        && item.actual_sha256.as_deref() != Some(&item.expected_sha256))
            })
        {
            return Err(failure(ErrorCode::InvalidInput, "delivery-results"));
        }
        let success = files
            .iter()
            .filter(|file| file.state == DeliveryFileState::Succeeded)
            .count();
        let state = if success == files.len() {
            "succeeded"
        } else if files
            .iter()
            .any(|file| file.state == DeliveryFileState::Unknown)
        {
            "unknown"
        } else if success > 0 {
            "partial"
        } else {
            "failed"
        };
        let encoded = serde_json::to_string(&files)
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-encode"))?;
        self.connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-write"))?
            .execute(
                "UPDATE release_deliveries SET state=?2,results_json=?3 WHERE action_id=?1",
                params![action_id.to_string(), state, encoded],
            )
            .map_err(sql)?;
        self.delivery_by_action(action_id)?
            .ok_or_else(|| failure(ErrorCode::StorageFailed, "delivery-write"))
    }

    pub fn reconcile_delivery(
        &mut self,
        action_id: ExecutionId,
        files: Vec<DeliveryFile>,
    ) -> Result<DeliveryView, ExecutionError> {
        let current = self
            .delivery_by_action(action_id)?
            .ok_or_else(|| failure(ErrorCode::InvalidInput, "delivery-action"))?;
        if current.state == DeliveryState::Pending {
            return self.finish_delivery(action_id, files);
        }
        if current.state != DeliveryState::Unknown {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "delivery-reconcile-state",
            ));
        }
        if current.files.len() != files.len()
            || files.iter().zip(&current.files).any(|(item, prior)| {
                item.locale != prior.locale
                    || item.file_name != prior.file_name
                    || item.expected_sha256 != prior.expected_sha256
                    || (prior.state != DeliveryFileState::Unknown && item != prior)
                    || (prior.state == DeliveryFileState::Unknown
                        && !matches!(
                            item.state,
                            DeliveryFileState::Unknown
                                | DeliveryFileState::Succeeded
                                | DeliveryFileState::Failed
                        ))
                    || (item.state == DeliveryFileState::Succeeded
                        && item.actual_sha256.as_deref() != Some(&item.expected_sha256))
                    || (prior.state == DeliveryFileState::Unknown
                        && item.state == DeliveryFileState::Failed
                        && item.actual_sha256.is_some())
            })
        {
            return Err(failure(
                ErrorCode::InvalidInput,
                "delivery-reconcile-results",
            ));
        }
        let success = files
            .iter()
            .filter(|file| file.state == DeliveryFileState::Succeeded)
            .count();
        let state = if success == files.len() {
            "succeeded"
        } else if files
            .iter()
            .any(|file| file.state == DeliveryFileState::Unknown)
        {
            "unknown"
        } else if success > 0 {
            "partial"
        } else {
            "failed"
        };
        let encoded = serde_json::to_string(&files)
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-encode"))?;
        let updated = self
            .connection_mut()
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-write"))?
            .execute(
                "UPDATE release_deliveries SET state=?2,results_json=?3
                 WHERE action_id=?1 AND state='unknown'",
                params![action_id.to_string(), state, encoded],
            )
            .map_err(sql)?;
        if updated != 1 {
            return Err(failure(
                ErrorCode::DependencyConflict,
                "delivery-reconcile-race",
            ));
        }
        self.delivery_by_action(action_id)?
            .ok_or_else(|| failure(ErrorCode::StorageFailed, "delivery-write"))
    }

    pub fn list_deliveries(
        &self,
        release_id: ExecutionId,
    ) -> Result<Vec<DeliveryView>, ExecutionError> {
        self.release_view(release_id)?;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "delivery-read"))?;
        let mut statement = connection.prepare(
            "SELECT action_id FROM release_deliveries WHERE release_id=?1 ORDER BY created_at DESC,delivery_id DESC LIMIT 100",
        ).map_err(sql)?;
        let ids = statement
            .query_map([release_id.to_string()], |row| row.get::<_, String>(0))
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        ids.into_iter()
            .map(|id| {
                self.delivery_by_action(parse_id(id)?)?
                    .ok_or_else(|| failure(ErrorCode::CorruptLedger, "delivery-read"))
            })
            .collect()
    }

    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    /// Resolve the original accepted input without recapturing current choices.
    pub fn find_locale_build(
        &self,
        project_id: ExecutionId,
        attempt_id: ExecutionId,
        choices: &[BuildLocaleChoice],
        expected_eligibility_basis: &str,
    ) -> Result<Option<FixedInput>, ExecutionError> {
        if self
            .metadata()
            .map_err(|_| failure(ErrorCode::CorruptLedger, "build-project"))?
            .project_id()
            .to_string()
            != project_id.to_string()
        {
            return Err(failure(ErrorCode::Unauthorized, "build-project"));
        }
        let Some(input) = self.execution_input_if_present(attempt_id)? else {
            return Ok(None);
        };
        let manifest = BuildManifest::from_input(&input)?;
        if manifest.project_id != project_id || input.envelope().project_id != project_id {
            return Err(failure(ErrorCode::Unauthorized, "build-project"));
        }
        if manifest.eligibility_basis != expected_eligibility_basis
            || manifest.locales.len() != choices.len()
            || manifest
                .locales
                .iter()
                .zip(choices)
                .any(|(saved, requested)| {
                    saved.locale != requested.locale || saved.file_name != requested.file_name
                })
        {
            return Err(failure(ErrorCode::ResultMismatch, "build-attempt-request"));
        }
        Ok(Some(input))
    }

    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    /// Read the original fixed input, never mutable progress or current eligibility.
    pub fn locale_build_start_receipt(
        &self,
        project_id: ExecutionId,
        attempt_id: ExecutionId,
        choices: &[BuildLocaleChoice],
        expected_eligibility_basis: &str,
    ) -> Result<Option<LocaleBuildStartReceipt>, ExecutionError> {
        let connection = self.connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?;
        let receipt = super::review::read_snapshot(connection, |_| {
            let Some(input) = self.find_locale_build(
                project_id, attempt_id, choices, expected_eligibility_basis,
            )? else { return Ok(None); };
            let manifest = BuildManifest::from_input(&input)?;
            Ok(Some(LocaleBuildStartReceipt {
                project_id: input.envelope().project_id,
                task_id: input.envelope().task_id,
                attempt_id: input.envelope().attempt_id,
                operation: input.envelope().operation.clone(),
                input_digest: input.digest().to_owned(),
                choices: manifest.locales.into_iter().map(|locale| BuildLocaleChoice {
                    locale: locale.locale, file_name: locale.file_name,
                }).collect(),
                expected_eligibility_basis: manifest.eligibility_basis,
            }))
        })?;
        // Only a successful exact read can release a lost-commit guard.
        if self.is_reconciling() { self.reconcile_execution()?; }
        Ok(receipt)
    }

    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    pub fn prepare_locale_build(
        &self,
        project_id: ExecutionId,
        attempt_id: ExecutionId,
        choices: &[BuildLocaleChoice],
        expected_eligibility_basis: &str,
    ) -> Result<FixedInput, ExecutionError> {
        if let Some(input) =
            self.find_locale_build(project_id, attempt_id, choices, expected_eligibility_basis)?
        {
            return Ok(input);
        }
        if choices.is_empty() || choices.len() > 16 {
            return Err(failure(ErrorCode::InvalidInput, "build-locales"));
        }
        let snapshot = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?
            .unchecked_transaction()
            .map_err(sql)?;
        let locales: Vec<_> = choices.iter().map(|choice| choice.locale.clone()).collect();
        let qualified =
            self.capture_qualified_release(project_id, &locales, expected_eligibility_basis)?;
        let eligibility = qualified.eligibility;
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?;
        let source_bundle = self.source_bundle(eligibility.source_snapshot_id)?;
        let vtt = source_bundle.plugin_id == crate::content::webvtt::PLUGIN;
        let mut files = connection
            .prepare(
                "SELECT f.logical_path,f.digest FROM source_files f
             JOIN source_snapshots s ON s.set_id=f.set_id
             WHERE s.snapshot_id=?1 ORDER BY CASE f.logical_path
             WHEN 'manifest.json' THEN 0 WHEN 'i18n/default.json' THEN 1 ELSE 2 END",
            )
            .map_err(sql)?;
        let files = files
            .query_map([eligibility.source_snapshot_id.to_string()], |row| {
                Ok(BuildSourceFile {
                    logical_path: row.get(0)?,
                    sha256: row.get(1)?,
                })
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        let mut manifest_locales = Vec::with_capacity(choices.len());
        for (choice, targets) in choices.iter().zip(qualified.locales) {
            let mut entries = Vec::new();
            for (ordinal, target) in targets {
                let value = plan::decided_text(&target)?.to_owned();
                let current_check = target
                    .current_check
                    .ok_or_else(|| failure(ErrorCode::DependencyConflict, "build-check"))?;
                entries.push(BuildEntry {
                    ordinal,
                    unit_id: target.unit_id,
                    source_revision_id: target.source_revision_id,
                    native_key: target.native_key,
                    source_text: target.source_text,
                    value,
                    selection_id: target.selection_id,
                    revision_id: target.revision_id,
                    fallback_id: target.current_fallback.map(|item| item.fallback_id),
                    decision_id: target.current_decision.map(|item| item.decision_id),
                    check_id: current_check.run_id,
                    waiver_ids: target
                        .current_waivers
                        .into_iter()
                        .map(|item| item.waiver_id)
                        .collect(),
                });
            }
            manifest_locales.push(BuildLocale {
                locale: choice.locale.clone(),
                file_name: choice.file_name.clone(),
                entries,
                source_template: vtt.then(|| source_bundle.files[0].utf8.clone()),
            });
        }
        // Review pages are read separately. Reject a capture if another writer
        // changed the reviewed basis while the fixed input was assembled.
        self.review_eligibility_if_basis(project_id, &locales, expected_eligibility_basis)?;
        let input = BuildManifest {
            version: 1,
            project_id,
            source_snapshot_id: eligibility.source_snapshot_id,
            policy_version: eligibility.policy_version,
            eligibility_basis: eligibility.basis,
            plugin_id: source_bundle.plugin_id.clone(),
            plugin_version: crate::content::PLUGIN_VERSION.into(),
            builder_version: if vtt {
                crate::content::webvtt::BUILDER
            } else {
                BUILDER_VERSION
            }
            .into(),
            validator_version: if vtt {
                crate::content::webvtt::CHECKER
            } else {
                VALIDATOR_VERSION
            }
            .into(),
            source_files: files,
            locales: manifest_locales,
        }
        .fixed_input(attempt_id)?;
        snapshot.commit().map_err(sql)?;
        Ok(input)
    }

    pub fn release_view(&self, release_id: ExecutionId) -> Result<ReleaseView, ExecutionError> {
        let snapshot = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "release-read"))?
            .unchecked_transaction()
            .map_err(sql)?;
        let record = record::load(&snapshot, release_id)?;
        snapshot.commit().map_err(sql)?;
        Ok(record.view)
    }

    /// Select a locale only when it has exactly one artifact. Callers exporting
    /// a complete ArtifactSet must use its exact saved logical paths instead.
    pub fn release_artifact(
        &self,
        release_id: ExecutionId,
        locale: &str,
    ) -> Result<(ReleasedArtifact, Vec<u8>), ExecutionError> {
        self.read_release_artifact(release_id, locale, None)
    }

    pub fn release_artifact_by_path(
        &self,
        release_id: ExecutionId,
        locale: &str,
        logical_path: &str,
    ) -> Result<(ReleasedArtifact, Vec<u8>), ExecutionError> {
        self.read_release_artifact(release_id, locale, Some(logical_path))
    }

    fn read_release_artifact(
        &self,
        release_id: ExecutionId,
        locale: &str,
        logical_path: Option<&str>,
    ) -> Result<(ReleasedArtifact, Vec<u8>), ExecutionError> {
        let snapshot = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "release-read"))?
            .unchecked_transaction()
            .map_err(sql)?;
        let record = record::load(&snapshot, release_id)?;
        let mut artifacts = record.artifacts.into_iter().filter(|a| {
            a.summary.locale == locale && logical_path.is_none_or(|p| a.summary.file_name == p)
        });
        let artifact = artifacts
            .next()
            .ok_or_else(|| failure(ErrorCode::InvalidInput, "release-artifact-path"))?;
        if artifacts.next().is_some() {
            return Err(failure(
                ErrorCode::InvalidInput,
                "release-artifact-ambiguous",
            ));
        }
        snapshot.commit().map_err(sql)?;
        Ok((artifact.summary, artifact.bytes))
    }
}

pub struct ReleaseAdoptionHandler;
impl AdoptionHandler for ReleaseAdoptionHandler {
    fn operation(&self) -> &str {
        BUILD_OPERATION
    }

    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        record::prepare(input, action, results)
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn request(store: &ProjectStore, attempt: ExecutionId) -> (ExecutionId, Vec<BuildLocaleChoice>, String) {
        let input = store.execution_input(attempt).unwrap();
        let manifest = BuildManifest::from_input(&input).unwrap();
        (manifest.project_id, manifest.locales.into_iter().map(|v| BuildLocaleChoice {
            locale: v.locale, file_name: v.file_name,
        }).collect(), manifest.eligibility_basis)
    }
    fn writes(store: &ProjectStore) -> i64 {
        store.connection().unwrap().query_row("SELECT total_changes()", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn locale_build_start_receipt_is_historical_exact_and_read_only_after_reopen() {
        let (temp, mut store, action) = super::super::review::tests::current_release_fixture(false);
        let (project, choices, basis) = request(&store, action.attempt_id);
        let input = store.execution_input(action.attempt_id).unwrap();
        let expected = LocaleBuildStartReceipt {
            project_id: project, task_id: input.envelope().task_id, attempt_id: action.attempt_id,
            operation: BUILD_OPERATION.into(), input_digest: input.digest().into(),
            choices: choices.clone(), expected_eligibility_basis: basis.clone(),
        };
        // Removing the original target and changing current eligibility cannot rewrite fixed input.
        let revision = store.metadata().unwrap().metadata_revision();
        store.set_target_locales(revision, &["fr-FR".into()]).unwrap();
        let before = writes(&store);
        let changes = serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap();
        assert_eq!(store.locale_build_start_receipt(project, action.attempt_id, &choices, &basis).unwrap(), Some(expected.clone()));
        assert_eq!(writes(&store), before);
        assert_eq!(serde_json::to_value(store.changes_since(Revision::new(0).unwrap())).unwrap(), changes);
        drop(store);
        let store = ProjectStore::open(temp.path().join("project")).unwrap();
        let before = writes(&store);
        assert_eq!(store.locale_build_start_receipt(project, action.attempt_id, &choices, &basis).unwrap(), Some(expected));
        assert_eq!(writes(&store), before);
    }

    #[test]
    fn locale_build_start_receipt_rejects_wrong_proof_and_preserves_unknown_guard() {
        let (_temp, store, action) = super::super::review::tests::current_release_fixture(false);
        let (project, choices, basis) = request(&store, action.attempt_id);
        store.execution_unknown.store(true, Ordering::Release);
        let before = writes(&store);
        for wrong in [vec![], vec![BuildLocaleChoice { locale: "fr-FR".into(), ..choices[0].clone() }],
            vec![BuildLocaleChoice { file_name: "i18n/other.json".into(), ..choices[0].clone() }],
            vec![choices[0].clone(), choices[0].clone()]] {
            assert!(store.locale_build_start_receipt(project, action.attempt_id, &wrong, &basis).is_err());
            assert!(store.is_reconciling());
        }
        assert!(store.locale_build_start_receipt(project, action.attempt_id, &choices, &"a".repeat(64)).is_err());
        assert!(store.locale_build_start_receipt(ExecutionId::new(), action.attempt_id, &choices, &basis).is_err());
        assert_eq!(writes(&store), before);
        assert!(store.is_reconciling());
        assert!(store.locale_build_start_receipt(project, action.attempt_id, &choices, &basis).unwrap().is_some());
        assert!(!store.is_reconciling());
        assert_eq!(writes(&store), before);

        let input = store.execution_input(action.attempt_id).unwrap();
        let c = store.connection().unwrap();
        c.execute("UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1", params![action.attempt_id.to_string(), "0".repeat(64)]).unwrap();
        store.execution_unknown.store(true, Ordering::Release);
        let before = writes(&store);
        assert!(store.locale_build_start_receipt(project, action.attempt_id, &choices, &basis).is_err());
        assert!(store.is_reconciling()); assert_eq!(writes(&store), before);
        c.execute("UPDATE execution_attempts SET digest=?2 WHERE attempt_id=?1", params![action.attempt_id.to_string(), input.digest()]).unwrap();
        let other: String = c.query_row("SELECT task_id FROM execution_tasks WHERE operation<>?1 LIMIT 1", [BUILD_OPERATION], |r| r.get(0)).unwrap();
        c.execute("UPDATE execution_attempts SET task_id=?2 WHERE attempt_id=?1", params![action.attempt_id.to_string(), other]).unwrap();
        let before = writes(&store);
        assert!(store.locale_build_start_receipt(project, action.attempt_id, &choices, &basis).is_err());
        assert!(store.is_reconciling()); assert_eq!(writes(&store), before);
    }

    #[test]
    fn locale_build_start_absence_is_read_only_and_reconciles_only_success() {
        let (_temp, store, action) = super::super::review::tests::current_release_fixture(false);
        let (project, choices, basis) = request(&store, action.attempt_id);
        store.execution_unknown.store(true, Ordering::Release);
        let before = writes(&store);
        assert_eq!(store.locale_build_start_receipt(project, ExecutionId::new(), &choices, &basis).unwrap(), None);
        assert!(!store.is_reconciling()); assert_eq!(writes(&store), before);
        let source: String = store.connection().unwrap().query_row("SELECT attempt_id FROM execution_attempts WHERE task_id IN (SELECT task_id FROM execution_tasks WHERE operation<>?1) LIMIT 1", [BUILD_OPERATION], |r| r.get(0)).unwrap();
        store.execution_unknown.store(true, Ordering::Release);
        assert!(store.locale_build_start_receipt(project, parse_id(source).unwrap(), &choices, &basis).is_err());
        assert!(store.is_reconciling()); assert_eq!(writes(&store), before);
    }
}
