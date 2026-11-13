//! Saved releases bind exact frozen inputs, original results and adoption
//! receipts. Reading historical plugin output needs no live process or grant.
use super::*;
use crate::persistence::ledger::{CheckedPluginLink, OpenBuildEvidence, OpenPluginProofs, OpenResultReader};
#[cfg(any(
    test,
    feature = "execution-test-host",
    feature = "legacy-desktop-domain"
))]
mod legacy;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseManifest {
    #[serde(default = "original_manifest_version", skip_serializing_if = "is_original_manifest")]
    version: u32,
    input_digest: String,
    result_ids: Vec<ExecutionId>,
    plan: FrozenPlan,
}

fn original_manifest_version() -> u32 { 1 }
fn is_original_manifest(version: &u32) -> bool { *version == 1 }

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
enum FrozenPlan {
    #[cfg(any(
        test,
        feature = "execution-test-host",
        feature = "legacy-desktop-domain"
    ))]
    Builtin(BuildManifest),
    Plugin(ReleasePlan),
    /// The original fixed input is already required and authenticated by load.
    /// New plugin manifests use that immutable authority without duplicating it.
    PluginInput,
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
    validator_version: String,
    pub summary: ReleasedArtifact,
    pub bytes: Vec<u8>,
}

pub(super) struct Record {
    pub view: ReleaseView,
    pub artifacts: Vec<Artifact>,
    pub report_paths: BTreeSet<String>,
}

#[derive(Debug)]
pub(crate) struct VerifiedRelease {
    pub(super) view: ReleaseView,
    report_paths: BTreeSet<String>,
}

impl VerifiedRelease {
    pub(super) fn capture(record: &Record) -> Option<Self> {
        Self::bounded(record.view.clone(), record.report_paths.clone())
    }

    fn bounded(view: ReleaseView, report_paths: BTreeSet<String>) -> Option<Self> {
        // Bound the retained projection independently of the artifact budget.
        const MAX_VIEW_BYTES: usize = 16 * 1024 * 1024;
        codec::check_encoded_size(&view, MAX_VIEW_BYTES).ok()?;
        Some(Self { view, report_paths })
    }

    /// Only use after confirming the snapshot that qualified this release.
    pub(super) fn read(&self, connection: &Connection) -> Result<Record, ExecutionError> {
        let artifacts = read_artifacts(connection, self.view.release_id)?;
        if artifacts.len() != self.view.artifacts.len()
            || artifacts.iter().zip(&self.view.artifacts).any(|(artifact, expected)| {
                artifact.summary != *expected || codec::digest(&artifact.bytes) != expected.sha256
            })
        {
            return Err(failure(ErrorCode::CorruptLedger, "release-artifacts"));
        }
        Ok(Record {
            view: self.view.clone(),
            artifacts,
            report_paths: self.report_paths.clone(),
        })
    }
}

struct PreparedRecord {
    manifest: ReleaseManifest,
    summary: ManifestSummary,
    artifacts: Vec<Artifact>,
    referenced_plan: Option<Arc<ReleasePlan>>,
}

fn prepare_data(
    input: &FixedInput,
    action: &AdoptionAction,
    results: &[FixedResult],
    version: u32,
    open_build: Option<OpenBuildEvidence>,
) -> Result<PreparedRecord, ExecutionError> {
    if ![1, 2, 3].contains(&version) || version >= 2 && input.envelope().plugin.is_none() {
        return Err(failure(ErrorCode::CorruptLedger, "release-manifest-version"));
    }
    action.validate(input, results)?;
    let mut seen = BTreeSet::new();
    let mut artifacts = Vec::new();
    let mut referenced_plan = None;
    let (plan, summary) = if input.envelope().plugin.is_some() {
        let (plan, mut artifact) = match open_build {
            Some(evidence) => (evidence.plan, evidence.artifact),
            None => (Arc::new(ReleasePlan::from_input(input)?), None),
        };
        let summary = plan.release_summary();
        for result in results {
            let item = input.item(result.envelope().item_id)?;
            let locale = item
                .scope
                .locale
                .as_deref()
                .ok_or_else(|| failure(ErrorCode::OutputInvalid, "release-locale"))?;
            let output = match artifact.take_if(|cached| cached.matches(result)) {
                Some(cached) => cached.output,
                None => plan.artifact_set(result)?,
            };
            if output.target_language != locale || !seen.insert(locale.to_owned()) {
                return Err(failure(ErrorCode::ResultMismatch, "release-coverage"));
            }
            // Generic builds count the frozen source units, not parsed domain
            // entries in each artifact. Domain interpretation belongs to its checker.
            let count = u32::try_from(plan.source().units.len())
                .map_err(|_| failure(ErrorCode::OutputInvalid, "release-unit-count"))?;
            let report = (version == 3)
                .then(|| plan.delivery_report(input.digest(), &output))
                .transpose()?;
            for artifact in output.artifacts {
                // The selected artifact set has already checked the exact bytes and digest.
                let bytes = artifact
                    .bytes()
                    .map_err(|_| failure(ErrorCode::OutputInvalid, "release-artifact-bytes"))?
                    .into_owned();
                artifacts.push(Artifact {
                    id: artifact.id().into(),
                    role: artifact.role().into(),
                    validator_version: summary.validator_version.clone(),
                    summary: ReleasedArtifact {
                        locale: locale.into(),
                        file_name: artifact.logical_path().into(),
                        sha256: artifact.sha256().into(),
                        entry_count: count,
                    },
                    bytes,
                });
            }
            if let Some((file_name, bytes)) = report {
                // Component IDs are untrusted and may use any valid opaque ID.
                // Pick a deterministic unused ID without changing their identities.
                let id = (0..=tsumugi_plugin_sdk::MAX_BUILD_ARTIFACTS)
                    .map(|index| format!("tsumugi-report-{index}"))
                    .find(|id| {
                        !artifacts.iter().any(|artifact| {
                            artifact.summary.locale == locale && artifact.id == *id
                        })
                    })
                    .ok_or_else(|| failure(ErrorCode::OutputInvalid, "release-report-id"))?;
                artifacts.push(Artifact {
                    id,
                    role: plan::REPORT_ROLE.into(),
                    validator_version: plan::REPORT_VALIDATOR.into(),
                    summary: ReleasedArtifact {
                        locale: locale.into(),
                        file_name,
                        sha256: codec::digest(&bytes),
                        entry_count: count,
                    },
                    bytes,
                });
            }
        }
        if seen.len() != plan.choices().len() {
            return Err(failure(ErrorCode::ResultMismatch, "release-coverage"));
        }
        let frozen = if version >= 2 {
            referenced_plan = Some(plan);
            FrozenPlan::PluginInput
        } else {
            FrozenPlan::Plugin(Arc::unwrap_or_clone(plan))
        };
        (frozen, summary)
    } else {
        #[cfg(any(
            test,
            feature = "execution-test-host",
            feature = "legacy-desktop-domain"
        ))]
        {
            legacy::prepare(input, results, &mut seen, &mut artifacts)?
        }
        #[cfg(not(any(
            test,
            feature = "execution-test-host",
            feature = "legacy-desktop-domain"
        )))]
        {
            return Err(failure(ErrorCode::InvalidInput, "build-plugin-required"));
        }
    };
    artifacts.sort_by(|a, b| {
        (&a.summary.locale, &a.summary.file_name).cmp(&(&b.summary.locale, &b.summary.file_name))
    });
    Ok(PreparedRecord {
        manifest: ReleaseManifest {
            version,
            input_digest: input.digest().into(),
            result_ids: action.result_ids.clone(),
            plan,
        },
        summary,
        artifacts,
        referenced_plan,
    })
}

pub(super) fn prepare(
    input: &FixedInput,
    action: &AdoptionAction,
    results: &[FixedResult],
) -> Result<PreparedMutation, ExecutionError> {
    let version = if input.envelope().plugin.is_some() { 3 } else { 1 };
    let PreparedRecord { manifest, summary, artifacts, .. } =
        prepare_data(input, action, results, version, None)?;
    let manifest_bytes = codec::encode(&manifest, MAX_INPUT_BYTES)?;
    let digest = codec::digest(&manifest_bytes);
    let action = action.clone();
    Ok(Box::new(move |transaction| {
        let release_id = ExecutionId::new();
        let created_at = transaction.query_row(
            "INSERT INTO release_records
             (release_id,action_id,project_id,attempt_id,manifest,manifest_digest)
             VALUES (?1,?2,?3,?4,?5,?6) RETURNING created_at",
            params![
                release_id.to_string(),
                action.action_id.to_string(),
                summary.project_id.to_string(),
                action.attempt_id.to_string(),
                manifest_bytes,
                digest
            ],
            |row| row.get(0),
        )?;
        for artifact in &artifacts {
            transaction.execute(
                "INSERT INTO release_artifacts
                 (release_id,locale,artifact_id,role,file_name,bytes,sha256,validator_version,entry_count)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![release_id.to_string(), artifact.summary.locale, artifact.id,
                    artifact.role, artifact.summary.file_name, artifact.bytes,
                    artifact.summary.sha256, artifact.validator_version, artifact.summary.entry_count],
            )?;
        }
        let report_paths = report_paths(version, &artifacts);
        let view = release_view(release_id, action.action_id, action.attempt_id, digest, created_at, summary, &artifacts);
        if let Some(verified) = VerifiedRelease::bounded(view, report_paths) {
            transaction.remember_release(verified);
        }
        Ok(vec![ChangeReference {
            kind: "release".into(),
            id: release_id.to_string(),
            revision: Revision::new(1)?,
        }])
    }))
}

pub(super) struct OpenRecordFrames<'scan, 'input, 'snapshot> {
    pub(super) results: &'scan mut OpenResultReader<'input>,
    pub(super) proofs: &'scan OpenPluginProofs<'snapshot>,
}

pub(super) fn load(
    connection: &Connection,
    release_id: ExecutionId,
    mut open: Option<OpenRecordFrames<'_, '_, '_>>,
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
    let input = match &open {
        Some(frames) if frames.results.input().envelope().attempt_id == attempt => {
            std::borrow::Cow::Borrowed(frames.results.input())
        }
        Some(_) => return Err(failure(ErrorCode::CorruptLedger, "release-attempt")),
        None => std::borrow::Cow::Owned(super::super::ledger::load_input(connection, attempt)?),
    };
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
        .map(|id| match &mut open {
            Some(frames) => frames.results.load(*id),
            None => super::super::ledger::load_result(connection, &input, *id),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let build = open.as_mut().and_then(|frames| frames.results.take_build_evidence());
    let PreparedRecord {
        manifest: expected_manifest,
        summary,
        artifacts: expected_artifacts,
        referenced_plan,
    } = prepare_data(&input, &action, &results, manifest.version, build)?;
    if manifest != expected_manifest || bytes != codec::encode(&expected_manifest, MAX_INPUT_BYTES)?
    {
        return Err(failure(ErrorCode::CorruptLedger, "release-fixed-input"));
    }
    if input.envelope().plugin.is_some() {
        match &expected_manifest.plan {
            FrozenPlan::Plugin(plan) => plan.validate_source_reference(connection)?,
            FrozenPlan::PluginInput => referenced_plan
                .as_ref()
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "release-plugin-plan"))?
                .validate_source_reference(connection)?,
            #[cfg(any(
                test,
                feature = "execution-test-host",
                feature = "legacy-desktop-domain"
            ))]
            FrozenPlan::Builtin(_) => {
                return Err(failure(ErrorCode::CorruptLedger, "release-plugin-plan"));
            }
        }
        for result in &results {
            let envelope = result.envelope();
            let link = CheckedPluginLink::Artifact {
                build_attempt: envelope.attempt_id,
            };
            if !open.as_ref().is_some_and(|frames| {
                frames.proofs.matches(connection, envelope.result_id, link, true)
            }) {
                super::super::ledger::validate_plugin_link(connection, &input, result, true)?;
            }
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
    let artifacts = read_artifacts(connection, release_id)?;
    for artifact in &artifacts {
        if expected_artifacts.iter().find(|expected| expected.summary.locale == artifact.summary.locale
            && expected.summary.file_name == artifact.summary.file_name).is_some_and(|expected| expected.validator_version != artifact.validator_version) {
            return Err(failure(ErrorCode::CorruptLedger, "release-validator"));
        }
    }
    // Comparing all bytes, IDs, roles and paths to original verified results
    // also rejects a substituted file whose own digest was recomputed.
    if artifacts != expected_artifacts {
        return Err(failure(ErrorCode::CorruptLedger, "release-artifacts"));
    }
    let report_paths = report_paths(manifest.version, &artifacts);
    let view = release_view(release_id, action_id, attempt, digest, created, summary, &artifacts);
    Ok(Record { view, artifacts, report_paths })
}

fn release_view(release_id: ExecutionId, action_id: ExecutionId, attempt: ExecutionId,
    digest: String, created: String, summary: ManifestSummary, artifacts: &[Artifact]) -> ReleaseView {
    ReleaseView {
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
    }
}

fn report_paths(version: u32, artifacts: &[Artifact]) -> BTreeSet<String> {
    if version == 3 {
        artifacts
            .iter()
            .filter(|artifact| {
                artifact.validator_version == plan::REPORT_VALIDATOR
                    && artifact.role == plan::REPORT_ROLE
            })
            .map(|artifact| artifact.summary.file_name.clone())
            .collect()
    } else {
        BTreeSet::new()
    }
}

fn read_artifacts(
    connection: &Connection,
    release_id: ExecutionId,
) -> Result<Vec<Artifact>, ExecutionError> {
    let mut query = connection.prepare(
        "SELECT locale,artifact_id,role,file_name,bytes,sha256,validator_version,entry_count
         FROM release_artifacts WHERE release_id=?1 ORDER BY locale,file_name",
    ).map_err(sql)?;
    let rows = query.query_map([release_id.to_string()], |r| {
        Ok(Artifact {
            id: r.get(1)?,
            role: r.get(2)?,
            validator_version: r.get(6)?,
            summary: ReleasedArtifact {
                locale: r.get(0)?,
                file_name: r.get(3)?,
                sha256: r.get(5)?,
                entry_count: r.get(7)?,
            },
            bytes: r.get(4)?,
        })
    }).map_err(sql)?;
    rows.collect::<Result<_, _>>().map_err(sql)
}
