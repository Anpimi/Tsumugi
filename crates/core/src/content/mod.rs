//! Immutable source bundles, native identity evidence and read-only projections.
mod build;
mod smapi;
mod translation;
pub mod webvtt;
pub use crate::persistence::content::SourceAdoptionHandler;
pub use build::{
    BUILD_CAPABILITY, BUILD_CAPABILITY_VERSION, BUILD_OPERATION, BUILDER_VERSION, BuildEntry,
    BuildLocale, BuildManifest, BuildOutput, BuildRunner, BuildSourceFile, VALIDATOR_VERSION,
    WebvttBuildRunner, artifact_digest, build_locale, validate_build_output,
};
pub use smapi::{SourceRunner, WebvttSourceRunner};
pub fn extract(
    bundle: &SourceBundle,
    cancel: &Cancellation,
) -> Result<SourceOutput, ExecutionError> {
    if bundle.plugin_id == webvtt::PLUGIN {
        webvtt::extract(bundle, cancel)
    } else {
        smapi::extract(bundle, cancel)
    }
}
pub fn supported_identity_policy(policy: &str) -> bool {
    matches!(policy, IDENTITY_POLICY | webvtt::POLICY)
}
pub use translation::{
    TRANSLATION_OPERATION, TranslationBundle, TranslationEntry, TranslationOutput,
    TranslationRunner, declared_locale, extract_translation, validate_translation_output,
};

use crate::{
    Locale, ProjectId,
    execution::{codec, *},
};
use serde::{Deserialize, Serialize};

pub const OPERATION: &str = "source-import";
pub const CAPABILITY: &str = "stardew-smapi.extract";
pub const CAPABILITY_VERSION: &str = "1";
pub const FORMAT: &str = "smapi-i18n-flat";
pub const IDENTITY_POLICY: &str = "smapi-native-key/1";
pub const MAX_SOURCE_BYTES: usize = 128 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 16 * 1024;
pub const MAX_OCCURRENCES: usize = 2000;
pub const MAX_SOURCE_RESULT_BYTES: usize = MAX_RESULT_BYTES;
pub const MAX_CONTENT_PAGE_BYTES: usize = 256 * 1024;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
pub const MANIFEST_PATH: &str = "manifest.json";
pub const SOURCE_PATH: &str = "i18n/default.json";
pub const PLUGIN_ID: &str = "stardew-smapi";
pub const PLUGIN_VERSION: &str = "0.1.0";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct IntegrationDescriptor {
    pub id: String,
    pub version: String,
    pub capability_id: String,
    pub capability_version: String,
    pub input_version: u32,
    pub output_version: u32,
    pub format_profiles: Vec<String>,
    pub required_files: Vec<String>,
    pub permissions: Vec<String>,
    pub available: bool,
    pub reason: Option<String>,
}
pub fn integration_descriptor(capture_available: bool) -> IntegrationDescriptor {
    IntegrationDescriptor {
        id: PLUGIN_ID.into(),
        version: PLUGIN_VERSION.into(),
        capability_id: CAPABILITY.into(),
        capability_version: CAPABILITY_VERSION.into(),
        input_version: 1,
        output_version: 1,
        format_profiles: vec![FORMAT.into()],
        required_files: vec![MANIFEST_PATH.into(), SOURCE_PATH.into()],
        permissions: vec!["captured-input-only".into()],
        available: capture_available,
        reason: (!capture_available).then(|| "unsupported-platform".into()),
    }
}
pub fn webvtt_descriptor(capture_available: bool) -> IntegrationDescriptor {
    IntegrationDescriptor {
        id: webvtt::PLUGIN.into(),
        version: PLUGIN_VERSION.into(),
        capability_id: webvtt::EXTRACT.into(),
        capability_version: "1".into(),
        input_version: 1,
        output_version: 1,
        format_profiles: vec![webvtt::PROFILE.into()],
        required_files: vec![webvtt::PATH.into()],
        permissions: vec!["captured-input-only".into()],
        available: capture_available,
        reason: (!capture_available).then(|| "unsupported-platform".into()),
    }
}

pub(crate) fn failure(code: ErrorCode, reason: &str) -> ExecutionError {
    ExecutionError::new(code, reason)
}
pub(crate) fn invalid(reason: &str) -> ExecutionError {
    failure(ErrorCode::OutputInvalid, reason)
}
pub(crate) fn value<T: Serialize>(v: &T) -> Result<serde_json::Value, ExecutionError> {
    serde_json::to_value(v).map_err(|_| invalid("invalid-structure"))
}
pub(crate) fn from_value<T: serde::de::DeserializeOwned>(
    v: &serde_json::Value,
) -> Result<T, ExecutionError> {
    serde_json::from_value(v.clone()).map_err(|_| invalid("invalid-structure"))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedFile {
    pub artifact_id: ExecutionId,
    pub logical_path: String,
    pub role: String,
    pub byte_length: u32,
    pub sha256: String,
    pub utf8: String,
}
impl CapturedFile {
    fn new(path: &str, role: &str, bytes: &[u8]) -> Result<Self, ExecutionError> {
        let utf8 = std::str::from_utf8(bytes)
            .map_err(|_| invalid("unsupported-encoding"))?
            .to_owned();
        Ok(Self {
            artifact_id: ExecutionId::new(),
            logical_path: path.into(),
            role: role.into(),
            byte_length: bytes.len() as u32,
            sha256: codec::digest(bytes),
            utf8,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceBundle {
    pub version: u32,
    pub plugin_id: String,
    pub plugin_version: String,
    pub set_id: ExecutionId,
    pub manifest_digest: String,
    pub source_language: String,
    pub language_evidence: String,
    pub format_id: String,
    pub format_version: u32,
    pub files: Vec<CapturedFile>,
}
impl SourceBundle {
    pub fn capture_webvtt(source: &[u8], language: &str) -> Result<Self, ExecutionError> {
        if source.len() > MAX_SOURCE_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        let locale = Locale::parse(language).map_err(|_| invalid("language-required"))?;
        let mut bundle = Self {
            version: 1,
            plugin_id: webvtt::PLUGIN.into(),
            plugin_version: PLUGIN_VERSION.into(),
            set_id: ExecutionId::new(),
            manifest_digest: String::new(),
            source_language: locale.as_str().into(),
            language_evidence: "user-declared".into(),
            format_id: webvtt::PROFILE.into(),
            format_version: 1,
            files: vec![CapturedFile::new(webvtt::PATH, "source", source)?],
        };
        bundle.manifest_digest = bundle.calculate_digest()?;
        bundle.validate()?;
        Ok(bundle)
    }
    pub fn capability(&self) -> &str {
        if self.plugin_id == webvtt::PLUGIN {
            webvtt::EXTRACT
        } else {
            CAPABILITY
        }
    }
    pub fn capture(manifest: &[u8], source: &[u8], language: &str) -> Result<Self, ExecutionError> {
        if manifest.len() > MAX_MANIFEST_BYTES
            || source.len() > MAX_SOURCE_BYTES
            || manifest.len() + source.len() > MAX_SOURCE_BYTES
        {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        let locale = Locale::parse(language).map_err(|_| invalid("language-required"))?;
        let mut bundle = Self {
            version: 1,
            plugin_id: PLUGIN_ID.into(),
            plugin_version: PLUGIN_VERSION.into(),
            set_id: ExecutionId::new(),
            manifest_digest: String::new(),
            source_language: locale.as_str().into(),
            language_evidence: "user-declared".into(),
            format_id: FORMAT.into(),
            format_version: 1,
            files: vec![
                CapturedFile::new(MANIFEST_PATH, "companion", manifest)?,
                CapturedFile::new(SOURCE_PATH, "source", source)?,
            ],
        };
        bundle.manifest_digest = bundle.calculate_digest()?;
        bundle.validate()?;
        Ok(bundle)
    }
    fn calculate_digest(&self) -> Result<String, ExecutionError> {
        // The digest binds the immutable manifest without duplicating raw bytes.
        let refs: Vec<_> = self
            .files
            .iter()
            .map(|f| {
                (
                    &f.artifact_id,
                    &f.logical_path,
                    &f.role,
                    f.byte_length,
                    &f.sha256,
                )
            })
            .collect();
        Ok(codec::digest(&codec::encode(
            &(
                self.version,
                &self.plugin_id,
                &self.plugin_version,
                self.set_id,
                &self.source_language,
                &self.language_evidence,
                &self.format_id,
                self.format_version,
                refs,
            ),
            MAX_INPUT_BYTES,
        )?))
    }
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.version != 1
            || !matches!(self.plugin_id.as_str(), PLUGIN_ID | webvtt::PLUGIN)
            || self.plugin_version != PLUGIN_VERSION
            || self.format_id
                != if self.plugin_id == webvtt::PLUGIN {
                    webvtt::PROFILE
                } else {
                    FORMAT
                }
            || self.format_version != 1
            || self.files.len()
                != if self.plugin_id == webvtt::PLUGIN {
                    1
                } else {
                    2
                }
            || self.language_evidence != "user-declared"
        {
            return Err(invalid("unsupported-format"));
        }
        let locale =
            Locale::parse(&self.source_language).map_err(|_| invalid("language-required"))?;
        if locale.as_str() != self.source_language {
            return Err(invalid("language-conflict"));
        }
        let mut total = 0usize;
        let expected = if self.plugin_id == webvtt::PLUGIN {
            vec![(webvtt::PATH, "source", MAX_SOURCE_BYTES)]
        } else {
            vec![
                (MANIFEST_PATH, "companion", MAX_MANIFEST_BYTES),
                (SOURCE_PATH, "source", MAX_SOURCE_BYTES),
            ]
        };
        for (f, (path, role, max)) in self.files.iter().zip(expected) {
            if f.logical_path != path
                || f.role != role
                || f.byte_length as usize != f.utf8.len()
                || f.sha256 != codec::digest(f.utf8.as_bytes())
            {
                return Err(invalid("invalid-structure"));
            }
            if f.utf8.len() > max {
                return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
            }
            total += f.utf8.len();
        }
        if total > MAX_SOURCE_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        if (self.files.len() == 2 && self.files[0].artifact_id == self.files[1].artifact_id)
            || self.calculate_digest()? != self.manifest_digest
        {
            return Err(invalid("invalid-structure"));
        }
        Ok(())
    }
    pub fn fixed_input(&self, project: ProjectId) -> Result<FixedInput, ExecutionError> {
        self.validate()?;
        let item = InputItem::new(
            Scope {
                kind: "source".into(),
                id: self.set_id.to_string(),
                locale: None,
            },
            value(self)?,
            vec![],
        );
        let mut envelope = InputEnvelope::new(
            project,
            OPERATION,
            self.capability(),
            CAPABILITY_VERSION,
            vec![item],
        )?;
        envelope.limits.max_result_bytes = MAX_SOURCE_RESULT_BYTES as u32;
        FixedInput::capture(envelope)
    }
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let e = input.envelope();
        if e.operation != OPERATION
            || !matches!(e.capability_id.as_str(), CAPABILITY | webvtt::EXTRACT)
            || e.capability_version != CAPABILITY_VERSION
            || e.items.len() != 1
            || e.units.len() != 1
            || e.units[0].item_ids != vec![e.items[0].item_id]
            || !e.settings.is_null()
            || !e.items[0].dependencies.is_empty()
        {
            return Err(invalid("unsupported-format"));
        }
        let b: Self = from_value(&e.items[0].payload)?;
        b.validate()?;
        if e.capability_id != b.capability() {
            return Err(invalid("unsupported-format"));
        }
        if e.items[0].scope
            != (Scope {
                kind: "source".into(),
                id: b.set_id.to_string(),
                locale: None,
            })
        {
            return Err(invalid("invalid-structure"));
        }
        Ok(b)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceOccurrence {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub namespace: String,
    pub key: String,
    pub text: String,
    /// Half-open UTF-8 byte offsets into the captured artifact, using its format profile.
    pub key_byte_range: [u32; 2],
    /// Half-open UTF-8 byte offsets into the original artifact, not the decoded text.
    pub value_byte_range: [u32; 2],
    pub identity_basis: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct FileCoverage {
    pub artifact_id: ExecutionId,
    pub logical_path: String,
    pub role: String,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOutput {
    pub version: u32,
    pub set_id: ExecutionId,
    pub manifest_digest: String,
    pub format_id: String,
    pub format_version: u32,
    pub identity_policy: String,
    pub namespace: String,
    pub source_language: String,
    pub coverage: Vec<FileCoverage>,
    pub occurrences: Vec<SourceOccurrence>,
    pub diagnostics: Vec<String>,
}

/// Typed output validation is shared by the ledger, preview and adoption boundary.
pub fn validate_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<SourceOutput, ExecutionError> {
    let bundle = SourceBundle::from_input(input)?;
    if result.envelope().item_id != input.envelope().items[0].item_id
        || result.envelope().outcome != ExecutionState::Succeeded
    {
        return Err(invalid("invalid-structure"));
    }
    let output: SourceOutput = from_value(
        result
            .envelope()
            .output
            .as_ref()
            .ok_or_else(|| invalid("invalid-structure"))?,
    )?;
    // Reinterpret captured bytes using the fixed internal profile, never external files.
    // This rejects omitted entries as well as plausible but forged text/ranges.
    let expected = extract(&bundle, &Cancellation::default())?;
    if output != expected {
        return Err(invalid("invalid-structure"));
    }
    Ok(output)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContentScope {
    pub revision: Revision,
    pub current_snapshot: Option<ExecutionId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceConfirmation {
    pub result_digest: String,
    pub identity_policy: String,
    pub expected_content_revision: Revision,
    pub source_language: String,
    #[serde(default)]
    pub expected_current_snapshot: Option<ExecutionId>,
    #[serde(default)]
    pub lineage: Vec<LineageChoice>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub lineage_base_snapshot: Option<ExecutionId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct LineageChoice {
    pub new_ordinal: u32,
    pub old_occurrence_id: ExecutionId,
    pub decision: LineageDecision,
    pub reason: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum LineageDecision {
    Continue,
    Reject,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceChangeKind {
    Unchanged,
    Moved,
    Changed,
    Added,
    RenameCandidate,
    Ambiguous,
    Removed,
}
impl SourceChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unchanged => "unchanged",
            Self::Moved => "moved",
            Self::Changed => "changed",
            Self::Added => "added",
            Self::RenameCandidate => "rename-candidate",
            Self::Ambiguous => "ambiguous",
            Self::Removed => "removed",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceChange {
    pub kind: SourceChangeKind,
    pub old: Option<ContentRow>,
    pub new: Option<SourceOccurrence>,
    pub candidates: Vec<ContentRow>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceChangePage {
    pub scope: ContentScope,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
    pub previous_snapshot_id: ExecutionId,
    pub confirmation: SourceConfirmation,
    pub total: u32,
    pub filtered_total: u32,
    pub unchanged: u32,
    pub moved: u32,
    pub changed: u32,
    pub added: u32,
    pub ambiguous: u32,
    pub removed: u32,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<SourceChange>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceHistory {
    pub snapshots: Vec<SourceHistoryEntry>,
    pub next_offset: Option<u32>,
    pub total: u32,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceHistoryEntry {
    pub snapshot_id: ExecutionId,
    #[serde(with = "crate::execution::revision_wire")]
    #[cfg_attr(feature = "wire-schema", schemars(with = "Revision"))]
    pub revision: u64,
    pub current: bool,
    pub total: u32,
    pub action_id: ExecutionId,
    pub result_digest: String,
    pub coverage: Vec<FileCoverage>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct LineageEvidence {
    pub old: ContentRow,
    pub old_snapshot_id: ExecutionId,
    pub relationship: String,
    pub decision: String,
    pub actor: Option<String>,
    pub reason: Option<String>,
    pub action_id: ExecutionId,
    pub policy: String,
    pub applied_relation: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImpactBasis {
    pub basis: String,
    pub evidence: crate::ReviewBasis,
    pub action_id: ExecutionId,
    pub kind: String,
    pub translation_text: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImpactSummary {
    pub locale: String,
    pub preserved: u32,
    pub reassess: u32,
    pub unresolved: u32,
    pub total: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum SourceImpactStatus {
    Preserved,
    Reassess,
    Unresolved,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImpactRow {
    pub current: ContentRow,
    pub previous: Option<ContentRow>,
    pub previous_bases: Vec<SourceImpactBasis>,
    pub locale: String,
    pub status: SourceImpactStatus,
    pub reasons: Vec<String>,
    pub selection_id: Option<ExecutionId>,
    pub translation_revision_id: Option<ExecutionId>,
    pub review_basis: String,
    pub lineage: Vec<LineageEvidence>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImpactPage {
    pub snapshot_id: ExecutionId,
    pub summary: SourceImpactSummary,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<SourceImpactRow>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContentRow {
    pub occurrence_id: Option<ExecutionId>,
    pub unit_id: Option<ExecutionId>,
    pub source_revision_id: Option<ExecutionId>,
    pub occurrence: SourceOccurrence,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ContentPage {
    pub snapshot_id: Option<ExecutionId>,
    pub attempt_id: ExecutionId,
    pub result_id: ExecutionId,
    pub scope: ContentScope,
    pub confirmation: SourceConfirmation,
    pub namespace: String,
    pub coverage: Vec<FileCoverage>,
    pub total: u32,
    pub next_ordinal: Option<u32>,
    pub diagnostics: Vec<String>,
    pub rows: Vec<ContentRow>,
}

#[cfg(test)]
mod tests;
