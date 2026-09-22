//! Immutable source bundles, native identity evidence and read-only projections.
mod smapi;
pub use crate::persistence::content::SourceAdoptionHandler;
pub use smapi::{SourceRunner, extract};

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
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
pub const MANIFEST_PATH: &str = "manifest.json";
pub const SOURCE_PATH: &str = "i18n/default.json";
pub const PLUGIN_ID: &str = "stardew-smapi";
pub const PLUGIN_VERSION: &str = "0.1.0";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
            || self.plugin_id != PLUGIN_ID
            || self.plugin_version != PLUGIN_VERSION
            || self.format_id != FORMAT
            || self.format_version != 1
            || self.files.len() != 2
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
        for (f, (path, role, max)) in self.files.iter().zip([
            (MANIFEST_PATH, "companion", MAX_MANIFEST_BYTES),
            (SOURCE_PATH, "source", MAX_SOURCE_BYTES),
        ]) {
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
        if self.files[0].artifact_id == self.files[1].artifact_id
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
        FixedInput::capture(InputEnvelope::new(
            project,
            OPERATION,
            CAPABILITY,
            CAPABILITY_VERSION,
            vec![item],
        )?)
    }
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let e = input.envelope();
        if e.operation != OPERATION
            || e.capability_id != CAPABILITY
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
pub struct SourceOccurrence {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub namespace: String,
    pub key: String,
    pub text: String,
    pub key_byte_range: [u32; 2],
    pub value_byte_range: [u32; 2],
    pub identity_basis: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
pub struct ContentScope {
    pub revision: Revision,
    pub current_snapshot: Option<ExecutionId>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceConfirmation {
    pub result_digest: String,
    pub identity_policy: String,
    pub expected_content_revision: Revision,
    pub source_language: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentRow {
    pub occurrence_id: Option<ExecutionId>,
    pub unit_id: Option<ExecutionId>,
    pub source_revision_id: Option<ExecutionId>,
    pub occurrence: SourceOccurrence,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
