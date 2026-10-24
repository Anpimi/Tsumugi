//! Frozen built-in release records for the explicit Desktop migration profile.
use super::*;

fn builtin_summary(manifest: &BuildManifest) -> ManifestSummary {
    ManifestSummary {
        project_id: manifest.project_id,
        source_snapshot_id: manifest.source_snapshot_id,
        policy_version: manifest.policy_version.clone(),
        eligibility_basis: manifest.eligibility_basis.clone(),
        builder_version: manifest.builder_version.clone(),
        validator_version: manifest.validator_version.clone(),
        source_files: manifest.source_files.clone(),
        exceptions: manifest
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
            .collect(),
    }
}

pub(super) fn prepare(
    input: &FixedInput,
    results: &[FixedResult],
    seen: &mut BTreeSet<String>,
    artifacts: &mut Vec<Artifact>,
) -> Result<(FrozenPlan, ManifestSummary), ExecutionError> {
    let manifest = BuildManifest::from_input(input)?;
    let summary = builtin_summary(&manifest);
    for result in results {
        if result.envelope().plugin.is_some() {
            return Err(failure(ErrorCode::ResultMismatch, "build-legacy-result-channel"));
        }
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
        if !seen.insert(locale.locale.clone()) {
            return Err(failure(ErrorCode::ResultMismatch, "build-duplicate"));
        }
        artifacts.push(Artifact {
            id: output.file_name.clone(),
            role: "locale".into(),
            summary: ReleasedArtifact {
                locale: output.locale,
                file_name: output.file_name,
                sha256: output.sha256,
                entry_count: output.entry_count,
            },
            bytes: output.utf8.into_bytes(),
        });
    }
    if seen.len() != manifest.locales.len() {
        return Err(failure(ErrorCode::ResultMismatch, "build-coverage"));
    }
    Ok((FrozenPlan::Builtin(manifest), summary))
}
