//! Fixed build inputs, verified locale artifacts and immutable local releases.

use super::ProjectStore;
use crate::{
    content::{
        BUILD_OPERATION, BUILDER_VERSION, BuildEntry, BuildLocale, BuildManifest, BuildOutput,
        BuildSourceFile, VALIDATOR_VERSION, validate_build_output,
    },
    execution::{
        AdoptionAction, AdoptionHandler, ChangeReference, ErrorCode, ExecutionError, ExecutionId,
        FixedInput, FixedResult, MAX_INPUT_BYTES, PreparedMutation, Revision, codec,
    },
};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

const TABLES: &[(&str, &str)] = &[
    (
        "release_records",
        "CREATE TABLE release_records (
        release_id TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL, attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id),
        manifest BLOB NOT NULL CHECK(length(manifest) BETWEEN 1 AND 1048576),
        manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    ),
    (
        "release_artifacts",
        "CREATE TABLE release_artifacts (
        release_id TEXT NOT NULL REFERENCES release_records(release_id),
        locale TEXT NOT NULL, file_name TEXT NOT NULL,
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 1048576),
        sha256 TEXT NOT NULL CHECK(length(sha256)=64),
        validator_version TEXT NOT NULL, entry_count INTEGER NOT NULL CHECK(entry_count>0),
        PRIMARY KEY(release_id,locale), UNIQUE(release_id,file_name))",
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
) -> Result<(), ExecutionError> {
    if input.envelope().operation != BUILD_OPERATION {
        return Ok(());
    }
    let manifest = BuildManifest::from_input(input)?;
    let (set, project): (String, String) = connection
        .query_row(
            "SELECT set_id,project_id FROM source_snapshots WHERE snapshot_id=?1",
            [manifest.source_snapshot_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let bundle = super::content::read_bundle(connection, ExecutionId::parse(&set)?)?;
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
#[cfg(test)]
pub(super) fn drop_for_legacy_fixture(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "DROP TABLE release_deliveries; DROP TABLE release_artifacts; DROP TABLE release_records;",
    )
}
pub(super) fn migrate_v7(connection: &mut Connection) -> rusqlite::Result<()> {
    let transaction =
        connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    initialize(&transaction)?;
    if transaction
        .prepare("PRAGMA foreign_key_check")?
        .exists([])?
    {
        return Err(rusqlite::Error::InvalidQuery);
    }
    transaction.pragma_update(None, "user_version", 8)?;
    #[cfg(test)]
    super::migration_crash_hook("before-release-migration-commit");
    transaction.commit()?;
    #[cfg(test)]
    super::migration_crash_hook("after-release-migration-commit");
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
    let mut records = connection.prepare(
        "SELECT release_id,project_id,attempt_id,manifest,manifest_digest FROM release_records",
    )?;
    let rows = records.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (release, project, attempt, manifest_bytes, digest) = row?;
        if codec::digest(&manifest_bytes) != digest {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let manifest: BuildManifest = codec::decode(&manifest_bytes, MAX_INPUT_BYTES)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        manifest
            .validate()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if manifest.project_id.to_string() != project {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let associated: (String, String) = connection.query_row(
            "SELECT a.project_id,t.operation FROM execution_attempts a
             JOIN execution_tasks t ON t.task_id=a.task_id WHERE a.attempt_id=?1",
            [&attempt],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if associated.0 != project || associated.1 != BUILD_OPERATION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut artifacts = connection.prepare(
            "SELECT locale,file_name,bytes,sha256,validator_version,entry_count
             FROM release_artifacts WHERE release_id=?1 ORDER BY locale",
        )?;
        let artifacts = artifacts.query_map([&release], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, u32>(5)?,
            ))
        })?;
        let mut seen = BTreeSet::new();
        for artifact in artifacts {
            let (locale, file_name, bytes, sha256, validator, count) = artifact?;
            let expected = manifest
                .locales
                .iter()
                .find(|item| item.locale == locale)
                .ok_or(rusqlite::Error::InvalidQuery)?;
            let utf8 = String::from_utf8(bytes).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let output = BuildOutput {
                version: 1,
                locale: locale.clone(),
                file_name,
                utf8,
                sha256,
                entry_count: count,
                builder_version: manifest.builder_version.clone(),
            };
            if validator != manifest.validator_version
                || !seen.insert(locale)
                || validate_build_output(expected, &output).is_err()
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
        }
        if seen.len() != manifest.locales.len() {
            return Err(rusqlite::Error::InvalidQuery);
        }
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
            "SELECT locale,file_name,sha256 FROM release_artifacts WHERE release_id=?1 ORDER BY locale",
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

    pub fn prepare_locale_build(
        &self,
        project_id: ExecutionId,
        attempt_id: ExecutionId,
        choices: &[BuildLocaleChoice],
        expected_eligibility_basis: &str,
    ) -> Result<FixedInput, ExecutionError> {
        if choices.is_empty() || choices.len() > 16 {
            return Err(failure(ErrorCode::InvalidInput, "build-locales"));
        }
        let snapshot = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "build-read"))?
            .unchecked_transaction()
            .map_err(sql)?;
        let locales: Vec<_> = choices.iter().map(|choice| choice.locale.clone()).collect();
        let eligibility =
            self.review_eligibility_if_basis(project_id, &locales, expected_eligibility_basis)?;
        if !eligibility.ready {
            return Err(failure(ErrorCode::DependencyConflict, "build-ineligible"));
        }
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
        for choice in choices {
            let mut after = 0;
            let mut entries = Vec::new();
            loop {
                let page = self.review_page(project_id, &choice.locale, after, 100)?;
                for (ordinal, target) in page.rows.into_iter().enumerate() {
                    let ordinal = after + ordinal as u32;
                    let current_check = target
                        .current_check
                        .ok_or_else(|| failure(ErrorCode::DependencyConflict, "build-check"))?;
                    let selected = target.selection_id.is_some();
                    let source_text = target.source_text.clone();
                    let value = if selected {
                        target
                            .translation_text
                            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "build-translation"))?
                    } else if target.current_fallback.is_some() {
                        target.source_text
                    } else {
                        return Err(failure(ErrorCode::DependencyConflict, "build-value"));
                    };
                    entries.push(BuildEntry {
                        ordinal,
                        unit_id: target.unit_id,
                        source_revision_id: target.source_revision_id,
                        native_key: target.native_key,
                        source_text,
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
                match page.next_ordinal {
                    Some(next) => after = next,
                    None => break,
                }
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
        let connection = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "release-read"))?;
        let (action, attempt, manifest_bytes, digest, created): (
            String,
            String,
            Vec<u8>,
            String,
            String,
        ) = connection
            .query_row(
                "SELECT action_id,attempt_id,manifest,manifest_digest,created_at
                 FROM release_records WHERE release_id=?1",
                [release_id.to_string()],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(sql)?;
        if codec::digest(&manifest_bytes) != digest {
            return Err(failure(ErrorCode::CorruptLedger, "release-manifest"));
        }
        let manifest: BuildManifest = codec::decode(&manifest_bytes, MAX_INPUT_BYTES)?;
        manifest.validate()?;
        let mut statement = connection
            .prepare(
                "SELECT locale,file_name,sha256,entry_count FROM release_artifacts
             WHERE release_id=?1 ORDER BY locale",
            )
            .map_err(sql)?;
        let artifacts = statement
            .query_map([release_id.to_string()], |row| {
                Ok(ReleasedArtifact {
                    locale: row.get(0)?,
                    file_name: row.get(1)?,
                    sha256: row.get(2)?,
                    entry_count: row.get(3)?,
                })
            })
            .map_err(sql)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql)?;
        if artifacts.len() != manifest.locales.len() {
            return Err(failure(ErrorCode::CorruptLedger, "release-artifacts"));
        }
        let exceptions = manifest
            .locales
            .iter()
            .flat_map(|locale| {
                locale.entries.iter().flat_map(|entry| {
                    let mut rows = Vec::new();
                    if entry.fallback_id.is_some() {
                        rows.push(ReleaseException {
                            locale: locale.locale.clone(),
                            native_key: entry.native_key.clone(),
                            kind: ReleaseExceptionKind::SourceFallback,
                        });
                    }
                    if !entry.waiver_ids.is_empty() {
                        rows.push(ReleaseException {
                            locale: locale.locale.clone(),
                            native_key: entry.native_key.clone(),
                            kind: ReleaseExceptionKind::QaWaiver,
                        });
                    }
                    rows
                })
            })
            .collect();
        Ok(ReleaseView {
            release_id,
            action_id: parse_id(action)?,
            attempt_id: parse_id(attempt)?,
            source_snapshot_id: manifest.source_snapshot_id,
            policy_version: manifest.policy_version,
            eligibility_basis: manifest.eligibility_basis,
            manifest_sha256: digest,
            builder_version: manifest.builder_version,
            validator_version: manifest.validator_version,
            source_files: manifest.source_files,
            exceptions,
            artifacts,
            created_at: created,
        })
    }

    pub fn release_artifact(
        &self,
        release_id: ExecutionId,
        locale: &str,
    ) -> Result<(ReleasedArtifact, Vec<u8>), ExecutionError> {
        let view = self.release_view(release_id)?;
        let summary = view
            .artifacts
            .into_iter()
            .find(|item| item.locale == locale)
            .ok_or_else(|| failure(ErrorCode::InvalidInput, "release-locale"))?;
        let (bytes, validator): (Vec<u8>, String) = self.connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "release-read"))?
            .query_row(
                "SELECT bytes,validator_version FROM release_artifacts WHERE release_id=?1 AND locale=?2",
                params![release_id.to_string(), locale],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).map_err(sql)?;
        let manifest_bytes: Vec<u8> = self
            .connection()
            .map_err(|_| failure(ErrorCode::StorageFailed, "release-read"))?
            .query_row(
                "SELECT manifest FROM release_records WHERE release_id=?1",
                [release_id.to_string()],
                |row| row.get(0),
            )
            .map_err(sql)?;
        let manifest: BuildManifest = codec::decode(&manifest_bytes, MAX_INPUT_BYTES)?;
        let expected = manifest
            .locales
            .iter()
            .find(|item| item.locale == locale)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "release-artifact"))?;
        let utf8 = String::from_utf8(bytes.clone())
            .map_err(|_| failure(ErrorCode::CorruptLedger, "release-artifact"))?;
        let output = BuildOutput {
            version: 1,
            locale: locale.into(),
            file_name: summary.file_name.clone(),
            utf8,
            sha256: summary.sha256.clone(),
            entry_count: summary.entry_count,
            builder_version: manifest.builder_version,
        };
        if validator != manifest.validator_version
            || codec::digest(&bytes) != summary.sha256
            || validate_build_output(expected, &output).is_err()
        {
            return Err(failure(ErrorCode::CorruptLedger, "release-artifact"));
        }
        Ok((summary, bytes))
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
        let manifest = BuildManifest::from_input(input)?;
        let manifest_bytes = codec::encode(&manifest, MAX_INPUT_BYTES)?;
        let mut seen = BTreeSet::new();
        let mut outputs = Vec::with_capacity(results.len());
        for result in results {
            let item = input.item(result.envelope().item_id)?;
            let index: usize = serde_json::from_value(item.payload.clone())
                .map_err(|_| failure(ErrorCode::OutputInvalid, "build-item"))?;
            let locale = manifest
                .locales
                .get(index)
                .ok_or_else(|| failure(ErrorCode::OutputInvalid, "build-item"))?;
            let output: BuildOutput = serde_json::from_value(
                result
                    .envelope()
                    .output
                    .clone()
                    .ok_or_else(|| failure(ErrorCode::OutputInvalid, "build-output"))?,
            )
            .map_err(|_| failure(ErrorCode::OutputInvalid, "build-output"))?;
            validate_build_output(locale, &output)?;
            if !seen.insert(index) {
                return Err(failure(ErrorCode::ResultMismatch, "build-duplicate"));
            }
            outputs.push(output);
        }
        if seen.len() != manifest.locales.len() {
            return Err(failure(ErrorCode::ResultMismatch, "build-coverage"));
        }
        let action = action.clone();
        Ok(Box::new(move |transaction| {
            let release_id = ExecutionId::new();
            transaction.execute(
                "INSERT INTO release_records
                 (release_id,action_id,project_id,attempt_id,manifest,manifest_digest)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    release_id.to_string(),
                    action.action_id.to_string(),
                    manifest.project_id.to_string(),
                    action.attempt_id.to_string(),
                    &manifest_bytes,
                    codec::digest(&manifest_bytes)
                ],
            )?;
            for output in outputs {
                transaction.execute(
                    "INSERT INTO release_artifacts
                     (release_id,locale,file_name,bytes,sha256,validator_version,entry_count)
                     VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        release_id.to_string(),
                        &output.locale,
                        &output.file_name,
                        output.utf8.as_bytes(),
                        &output.sha256,
                        manifest.validator_version,
                        output.entry_count
                    ],
                )?;
            }
            Ok(vec![ChangeReference {
                kind: "release".into(),
                id: release_id.to_string(),
                revision: Revision::new(1)?,
            }])
        }))
    }
}
