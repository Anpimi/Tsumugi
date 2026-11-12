//! Core-owned delivery facts. Never send review history or infer selection from text equality.
use super::*;

pub(in crate::persistence::release) const REPORT_ROLE: &str = "tsumugi-release-report";
pub(in crate::persistence::release) const REPORT_VALIDATOR: &str = "tsumugi-release-report-1";

fn path(index: usize, locale: &str) -> String {
    format!("tsumugi-release/locale-{}-{locale}.json", index + 1)
}

pub(super) fn validate_paths(choices: &[PluginBuildLocaleChoice]) -> Result<(), ExecutionError> {
    let reports: Vec<_> = choices
        .iter()
        .enumerate()
        .map(|(index, choice)| path(index, &choice.locale))
        .collect();
    sdk::validate_build_output_paths(
        choices
            .iter()
            .flat_map(|choice| choice.output_paths.iter().map(String::as_str))
            .chain(reports.iter().map(String::as_str)),
    )
    .map_err(|_| failure(ErrorCode::InvalidInput, "release-report-paths"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Component {
    plugin: sdk::PluginIdentity,
    package_digest: String,
    capability: sdk::ContractRef,
}
impl From<&sdk::CapabilityBinding> for Component {
    fn from(binding: &sdk::CapabilityBinding) -> Self {
        Self {
            plugin: binding.provider.plugin.clone(),
            package_digest: binding.provider.package_digest.clone(),
            capability: binding.declaration.contract.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct File {
    path: String,
    role: String,
    bytes: usize,
    sha256: String,
}
impl File {
    fn capture(artifact: &sdk::CapturedArtifact) -> Result<Self, ExecutionError> {
        Ok(Self {
            path: artifact.logical_path().into(),
            role: artifact.role().into(),
            bytes: artifact.bytes().map_err(|_| invalid())?.len(),
            sha256: artifact.sha256().into(),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Setting {
    schema: sdk::ContractRef,
    group: String,
    option: String,
    option_id: String,
    value: String,
    value_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    input: String,
    input_range: sdk::SourceRange,
    properties: Vec<sdk::SourceCaptureProperty>,
    counts: sdk::SourceCaptureCounts,
    groups: Vec<sdk::SourceCaptureGroup>,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum Disposition {
    Translation,
    SourceRetained,
    SourceFallback,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    unit_id: String,
    source_revision_id: String,
    disposition: Disposition,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Coverage {
    scope: &'static str,
    units: usize,
    translations: usize,
    source_retained: usize,
    source_fallbacks: usize,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    format: &'static str,
    format_version: u32,
    input_sha256: String,
    source_input_sha256: String,
    source_result_sha256: String,
    source_language: String,
    target_language: String,
    profile: sdk::ContractRef,
    policy_version: String,
    builder: Component,
    domain_checker: Component,
    report_validator: &'static str,
    settings: Vec<Setting>,
    opaque_settings_omitted: bool,
    inputs: Vec<File>,
    source_capture: Option<Vec<Capture>>,
    coverage: Coverage,
    files: Vec<File>,
    limitations: [&'static str; 3],
}

impl ReleasePlan {
    pub(in crate::persistence::release) fn delivery_report(
        &self,
        input_digest: &str,
        output: &sdk::ArtifactSet,
    ) -> Result<(String, Vec<u8>), ExecutionError> {
        validate_paths(&self.choices())?;
        let (index, locale) = self
            .locales
            .iter()
            .enumerate()
            .find(|(_, locale)| locale.choice.locale == output.target_language)
            .ok_or_else(invalid)?;
        let translated = locale.choice.translated();
        let mut coverage = Coverage {
            scope: "captured-declared-text",
            units: locale.targets.len(),
            translations: 0,
            source_retained: 0,
            source_fallbacks: 0,
            entries: Vec::new(),
        };
        for target in &locale.targets {
            let disposition = if translated
                .as_ref()
                .is_some_and(|ids| !ids.contains(&target.review.unit_id))
            {
                coverage.source_retained += 1;
                Disposition::SourceRetained
            } else if target.review.selection_id.is_some() {
                coverage.translations += 1;
                Disposition::Translation
            } else {
                coverage.source_fallbacks += 1;
                Disposition::SourceFallback
            };
            coverage.entries.push(Entry {
                unit_id: target.local_unit_id.clone(),
                source_revision_id: target.local_source_revision_id.clone(),
                disposition,
            });
        }
        let mut settings = Vec::new();
        for declaration in self
            .build
            .binding
            .declaration
            .configuration
            .as_deref()
            .unwrap_or(&[])
        {
            let payload = locale
                .choice
                .configuration
                .iter()
                .find(|value| value.schema == declaration.schema)
                .ok_or_else(invalid)?;
            let values = declaration.read(payload).map_err(|_| invalid())?;
            for option in &declaration.options {
                let value = values
                    .selections
                    .iter()
                    .find(|value| value.id == option.id)
                    .ok_or_else(invalid)?;
                let choice = option
                    .choices
                    .iter()
                    .find(|choice| choice.id == value.value)
                    .ok_or_else(invalid)?;
                settings.push(Setting {
                    schema: declaration.schema.clone(),
                    group: declaration.display_name.clone(),
                    option: option.display_name.clone(),
                    option_id: option.id.clone(),
                    value: choice.display_name.clone(),
                    value_id: choice.id.clone(),
                });
            }
        }
        let schema = sdk::source_capture_summary_contract();
        let source_capture = self
            .source
            .domain_blocks
            .iter()
            .find(|block| block.schema == schema)
            .map(|block| -> Result<Vec<Capture>, ExecutionError> {
                let summary =
                    sdk::parse_source_capture_summary_block(block, &self.source.artifacts)
                        .map_err(|_| invalid())?;
                summary
                    .materials
                    .into_iter()
                    .map(|material| {
                        let input = self
                            .source
                            .artifacts
                            .iter()
                            .find(|artifact| artifact.id() == material.source.artifact_id)
                            .ok_or_else(invalid)?;
                        Ok(Capture {
                            input: input.logical_path().into(),
                            input_range: material.source.range,
                            properties: material.properties,
                            counts: material.counts,
                            groups: material.groups,
                        })
                    })
                    .collect()
            })
            .transpose()?;
        let mut files = output
            .artifacts
            .iter()
            .map(File::capture)
            .collect::<Result<Vec<_>, _>>()?;
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let report = Report {
            format: "tsumugi-release-report",
            format_version: 1,
            input_sha256: input_digest.into(),
            source_input_sha256: self.source_input_digest.clone(),
            source_result_sha256: self.source_result_digest.clone(),
            source_language: self.source.source_language.clone(),
            target_language: locale.choice.locale.clone(),
            profile: self.source.profile.clone(),
            policy_version: self.policy_version.clone(),
            builder: (&self.build.binding.builder).into(),
            domain_checker: (&self.build.binding.checker).into(),
            report_validator: REPORT_VALIDATOR,
            settings,
            opaque_settings_omitted: self.build.binding.declaration.configuration.is_none()
                && !locale.choice.configuration.is_empty(),
            inputs: self
                .source
                .artifacts
                .iter()
                .map(File::capture)
                .collect::<Result<Vec<_>, _>>()?,
            source_capture,
            coverage,
            files,
            limitations: [
                "Coverage describes captured, declared text; other resources are not a complete translation claim.",
                "Domain-file checks do not establish translation quality or execution in another application.",
                "This Core report is reconstructed from fixed inputs; it is not a domain-checker artifact.",
            ],
        };
        // Typed fields and the format-1 projection keep bytes independent of current
        // project edits, application version and live package metadata.
        Ok((
            path(index, &locale.choice.locale),
            codec::encode(&report, 32 * 1024 * 1024)?,
        ))
    }
}
