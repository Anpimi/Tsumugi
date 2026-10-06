//! Saved releases bind exact frozen inputs, original results and adoption
//! receipts. Reading historical plugin output needs no live process or grant.
use super::*;
#[cfg(any(test, feature = "execution-test-host"))]
mod legacy;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseManifest {
    input_digest: String,
    result_ids: Vec<ExecutionId>,
    plan: FrozenPlan,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
enum FrozenPlan {
    #[cfg(any(test, feature = "execution-test-host"))]
    Builtin(BuildManifest),
    Plugin(ReleasePlan),
}

pub(super) struct ManifestSummary {
    pub project_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub policy_version: String,
    pub eligibility_basis: String,
    pub builder_version: String,
    pub validator_version: String,
    pub source_files: Vec<BuildSourceFile>,
    pub exceptions: Vec<ReleaseException>,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct Artifact {
    id: String,
    role: String,
    pub summary: ReleasedArtifact,
    pub bytes: Vec<u8>,
}

pub(super) struct Record {
    pub view: ReleaseView,
    pub artifacts: Vec<Artifact>,
}

fn prepare_data(
    input: &FixedInput,
    action: &AdoptionAction,
    results: &[FixedResult],
) -> Result<(ReleaseManifest, ManifestSummary, Vec<Artifact>), ExecutionError> {
    action.validate(input, results)?;
    let mut seen = BTreeSet::new();
    let mut artifacts = Vec::new();
    let (plan, summary) = if input.envelope().plugin.is_some() {
        let plan = ReleasePlan::from_input(input)?;
        let summary = plan.release_summary();
        for result in results {
            let item = input.item(result.envelope().item_id)?;
            let locale = item
                .scope
                .locale
                .as_deref()
                .ok_or_else(|| failure(ErrorCode::OutputInvalid, "release-locale"))?;
            let output = plan.artifact_set(result)?;
            if output.target_language != locale || !seen.insert(locale.to_owned()) {
                return Err(failure(ErrorCode::ResultMismatch, "release-coverage"));
            }
            // Generic builds count the frozen source units, not parsed domain
            // entries in each artifact. Domain interpretation belongs to its checker.
            let count = u32::try_from(plan.plugin_input(locale)?.targets.len())
                .map_err(|_| failure(ErrorCode::OutputInvalid, "release-unit-count"))?;
            for artifact in output.artifacts {
                artifacts.push(Artifact {
                    id: artifact.id,
                    role: artifact.role,
                    summary: ReleasedArtifact {
                        locale: locale.into(),
                        file_name: artifact.logical_path,
                        sha256: artifact.sha256,
                        entry_count: count,
                    },
                    bytes: artifact.utf8.into_bytes(),
                });
            }
        }
        if seen.len() != plan.choices().len() {
            return Err(failure(ErrorCode::ResultMismatch, "release-coverage"));
        }
        (FrozenPlan::Plugin(plan), summary)
    } else {
        #[cfg(any(test, feature = "execution-test-host"))]
        {
            legacy::prepare(input, results, &mut seen, &mut artifacts)?
        }
        #[cfg(not(any(test, feature = "execution-test-host")))]
        {
            return Err(failure(ErrorCode::InvalidInput, "build-plugin-required"));
        }
    };
    artifacts.sort_by(|a, b| {
        (&a.summary.locale, &a.summary.file_name).cmp(&(&b.summary.locale, &b.summary.file_name))
    });
    Ok((
        ReleaseManifest {
            input_digest: input.digest().into(),
            result_ids: action.result_ids.clone(),
            plan,
        },
        summary,
        artifacts,
    ))
}

pub(super) fn prepare(
    input: &FixedInput,
    action: &AdoptionAction,
    results: &[FixedResult],
) -> Result<PreparedMutation, ExecutionError> {
    let (manifest, summary, artifacts) = prepare_data(input, action, results)?;
    let manifest_bytes = codec::encode(&manifest, MAX_INPUT_BYTES)?;
    let digest = codec::digest(&manifest_bytes);
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
                summary.project_id.to_string(),
                action.attempt_id.to_string(),
                manifest_bytes,
                digest
            ],
        )?;
        for artifact in artifacts {
            transaction.execute(
                "INSERT INTO release_artifacts
                 (release_id,locale,artifact_id,role,file_name,bytes,sha256,validator_version,entry_count)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![release_id.to_string(), artifact.summary.locale, artifact.id,
                    artifact.role, artifact.summary.file_name, artifact.bytes,
                    artifact.summary.sha256, summary.validator_version, artifact.summary.entry_count],
            )?;
        }
        Ok(vec![ChangeReference {
            kind: "release".into(),
            id: release_id.to_string(),
            revision: Revision::new(1)?,
        }])
    }))
}

pub(super) fn load(
    connection: &Connection,
    release_id: ExecutionId,
) -> Result<Record, ExecutionError> {
    let (action_id, project_id, attempt_id, bytes, digest, created): (
        String,
        String,
        String,
        Vec<u8>,
        String,
        String,
    ) = connection
        .query_row(
            "SELECT action_id,project_id,attempt_id,manifest,manifest_digest,created_at
         FROM release_records WHERE release_id=?1",
            [release_id.to_string()],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .map_err(sql)?;
    if codec::digest(&bytes) != digest {
        return Err(failure(ErrorCode::CorruptLedger, "release-manifest"));
    }
    let manifest: ReleaseManifest = codec::decode(&bytes, MAX_INPUT_BYTES)?;
    let attempt = parse_id(attempt_id)?;
    let action_id = parse_id(action_id)?;
    let input = super::super::ledger::load_input(connection, attempt)?;
    let (action_bytes, action_digest): (Vec<u8>, String) = connection
        .query_row(
            "SELECT request,digest FROM execution_actions WHERE action_id=?1",
            [action_id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(sql)?;
    let action: AdoptionAction = codec::decode(&action_bytes, MAX_INPUT_BYTES)?;
    if action.action_id != action_id
        || action.attempt_id != attempt
        || action.project_id.to_string() != project_id
        || action.request_digest(&input)? != action_digest
        || manifest.input_digest != input.digest()
        || manifest.result_ids != action.result_ids
    {
        return Err(failure(ErrorCode::CorruptLedger, "release-association"));
    }
    let results = action
        .result_ids
        .iter()
        .map(|id| super::super::ledger::load_result(connection, &input, *id))
        .collect::<Result<Vec<_>, _>>()?;
    let (expected_manifest, summary, expected_artifacts) = prepare_data(&input, &action, &results)?;
    if manifest != expected_manifest || bytes != codec::encode(&expected_manifest, MAX_INPUT_BYTES)?
    {
        return Err(failure(ErrorCode::CorruptLedger, "release-fixed-input"));
    }
    if input.envelope().plugin.is_some() {
        match &manifest.plan {
            FrozenPlan::Plugin(plan) => plan.validate_source_reference(connection)?,
            #[cfg(any(test, feature = "execution-test-host"))]
            FrozenPlan::Builtin(_) => {}
        }
        for result in &results {
            super::super::ledger::validate_plugin_link(connection, &input, result, true)?;
        }
    }
    let receipt = super::super::ledger::read_receipt(connection, action_id)?
        .ok_or_else(|| failure(ErrorCode::CorruptLedger, "release-receipt"))?;
    let reference = ChangeReference {
        kind: "release".into(),
        id: release_id.to_string(),
        revision: Revision::new(1)?,
    };
    if receipt.project_id != action.project_id
        || receipt.attempt_id != attempt
        || receipt.unit_id != action.unit_id
        || receipt.request_digest != action_digest
        || receipt.changes != [reference]
    {
        return Err(failure(ErrorCode::CorruptLedger, "release-receipt"));
    }
    let mut query = connection
        .prepare(
            "SELECT locale,artifact_id,role,file_name,bytes,sha256,validator_version,entry_count
         FROM release_artifacts WHERE release_id=?1 ORDER BY locale,file_name",
        )
        .map_err(sql)?;
    let rows = query
        .query_map([release_id.to_string()], |r| {
            Ok((
                Artifact {
                    id: r.get(1)?,
                    role: r.get(2)?,
                    summary: ReleasedArtifact {
                        locale: r.get(0)?,
                        file_name: r.get(3)?,
                        sha256: r.get(5)?,
                        entry_count: r.get(7)?,
                    },
                    bytes: r.get(4)?,
                },
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(sql)?;
    let mut artifacts = Vec::new();
    for row in rows {
        let (artifact, validator) = row.map_err(sql)?;
        if validator != summary.validator_version {
            return Err(failure(ErrorCode::CorruptLedger, "release-validator"));
        }
        artifacts.push(artifact);
    }
    // Comparing all bytes, IDs, roles and paths to original verified results
    // also rejects a substituted file whose own digest was recomputed.
    if artifacts != expected_artifacts {
        return Err(failure(ErrorCode::CorruptLedger, "release-artifacts"));
    }
    let view = ReleaseView {
        release_id,
        action_id,
        attempt_id: attempt,
        source_snapshot_id: summary.source_snapshot_id,
        policy_version: summary.policy_version,
        eligibility_basis: summary.eligibility_basis,
        manifest_sha256: digest,
        builder_version: summary.builder_version,
        validator_version: summary.validator_version,
        source_files: summary.source_files,
        exceptions: summary.exceptions,
        artifacts: artifacts.iter().map(|a| a.summary.clone()).collect(),
        created_at: created,
    };
    Ok(Record { view, artifacts })
}
