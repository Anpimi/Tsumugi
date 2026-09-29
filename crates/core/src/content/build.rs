//! First-party construction of a flat SMAPI locale file from a fixed project snapshot.

use super::*;
use jsonc_parser::{CollectOptions, ParseOptions, ast::Value as AstValue};
use std::collections::BTreeSet;

pub const BUILD_OPERATION: &str = "locale-build";
pub const BUILD_CAPABILITY: &str = "stardew-smapi.locale-build";
pub const BUILD_CAPABILITY_VERSION: &str = "1";
pub const BUILDER_VERSION: &str = "smapi-locale-build-1";
pub const VALIDATOR_VERSION: &str = "smapi-locale-artifact-1";
const MAX_ARTIFACT_BYTES: usize = 1024 * 1024;
pub fn artifact_digest(bytes: &[u8]) -> String {
    codec::digest(bytes)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildEntry {
    pub ordinal: u32,
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub native_key: String,
    pub source_text: String,
    pub value: String,
    pub selection_id: Option<ExecutionId>,
    pub revision_id: Option<ExecutionId>,
    pub fallback_id: Option<ExecutionId>,
    pub decision_id: Option<ExecutionId>,
    pub check_id: ExecutionId,
    pub waiver_ids: Vec<ExecutionId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildLocale {
    pub locale: String,
    pub file_name: String,
    pub entries: Vec<BuildEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildSourceFile {
    pub logical_path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildManifest {
    pub version: u32,
    pub project_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub policy_version: String,
    pub eligibility_basis: String,
    pub plugin_id: String,
    pub plugin_version: String,
    pub builder_version: String,
    pub validator_version: String,
    pub source_files: Vec<BuildSourceFile>,
    pub locales: Vec<BuildLocale>,
}

impl BuildManifest {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.version != 1
            || self.policy_version != "balanced-1"
            || self.eligibility_basis.len() != 64
            || !self
                .eligibility_basis
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.plugin_id != PLUGIN_ID
            || self.plugin_version != PLUGIN_VERSION
            || self.builder_version != BUILDER_VERSION
            || self.validator_version != VALIDATOR_VERSION
            || self.locales.is_empty()
            || self.locales.len() > 16
            || self.source_files.len() != 2
            || self.source_files[0].logical_path != MANIFEST_PATH
            || self.source_files[1].logical_path != SOURCE_PATH
            || self.source_files.iter().any(|file| {
                file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err(invalid("build-manifest"));
        }
        let mut locales = BTreeSet::new();
        let mut paths = BTreeSet::new();
        let expected_units: Vec<_> = self.locales[0]
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.ordinal,
                    entry.unit_id,
                    entry.source_revision_id,
                    &entry.native_key,
                )
            })
            .collect();
        if expected_units.is_empty() || expected_units.len() > MAX_OCCURRENCES {
            return Err(invalid("build-entries"));
        }
        for locale in &self.locales {
            let parsed = Locale::parse(&locale.locale).map_err(|_| invalid("build-locale"))?;
            let file_stem = locale
                .file_name
                .strip_prefix("i18n/")
                .and_then(|name| name.strip_suffix(".json"))
                .unwrap_or("")
                .to_ascii_lowercase();
            let windows_reserved = matches!(file_stem.as_str(), "con" | "prn" | "aux" | "nul")
                || (file_stem.len() == 4
                    && (file_stem.starts_with("com") || file_stem.starts_with("lpt"))
                    && file_stem.as_bytes()[3].is_ascii_digit());
            if parsed.as_str() != locale.locale
                || !locales.insert(&locale.locale)
                || !paths.insert(locale.file_name.to_ascii_lowercase())
                || !locale.file_name.starts_with("i18n/")
                || declared_locale(&locale.file_name).is_err()
                || locale.file_name.eq_ignore_ascii_case("i18n/default.json")
                || windows_reserved
                || declared_locale(&locale.file_name)?.split('-').next()
                    != locale.locale.split('-').next()
                || locale.entries.len() != expected_units.len()
            {
                return Err(invalid("build-locale"));
            }
            let mut keys = BTreeSet::new();
            for (index, entry) in locale.entries.iter().enumerate() {
                if entry.ordinal as usize != index
                    || (
                        entry.ordinal,
                        entry.unit_id,
                        entry.source_revision_id,
                        &entry.native_key,
                    ) != expected_units[index]
                    || !keys.insert(entry.native_key.to_ascii_lowercase())
                    || !smapi::ascii(&entry.native_key, 1024)
                    || entry.source_text.len() > MAX_TEXT_BYTES
                    || entry.value.len() > MAX_TEXT_BYTES
                    || (entry.fallback_id.is_some() && entry.value != entry.source_text)
                    || (entry.selection_id.is_some() != entry.revision_id.is_some())
                    || (entry.selection_id.is_some() != entry.decision_id.is_some())
                    || (entry.selection_id.is_some() == entry.fallback_id.is_some())
                {
                    return Err(invalid("build-entry"));
                }
            }
        }
        Ok(())
    }

    pub fn fixed_input(&self, attempt_id: ExecutionId) -> Result<FixedInput, ExecutionError> {
        self.validate()?;
        let project = self
            .project_id
            .to_string()
            .parse::<ProjectId>()
            .map_err(|_| invalid("build-project"))?;
        let items = self
            .locales
            .iter()
            .enumerate()
            .map(|(index, locale)| {
                Ok(InputItem::new(
                    Scope {
                        kind: "locale-artifact".into(),
                        id: locale.file_name.clone(),
                        locale: Some(locale.locale.clone()),
                    },
                    value(&index)?,
                    vec![],
                ))
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        let item_ids = items.iter().map(|item| item.item_id).collect();
        let mut envelope = InputEnvelope::new(
            project,
            BUILD_OPERATION,
            BUILD_CAPABILITY,
            BUILD_CAPABILITY_VERSION,
            items,
        )?;
        envelope.attempt_id = attempt_id;
        envelope.settings = value(self)?;
        envelope.units = vec![AdoptionUnit::new(item_ids)];
        envelope.limits.max_result_bytes = MAX_RESULT_BYTES as u32;
        FixedInput::capture(envelope)
    }

    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let envelope = input.envelope();
        if envelope.operation != BUILD_OPERATION
            || envelope.capability_id != BUILD_CAPABILITY
            || envelope.capability_version != BUILD_CAPABILITY_VERSION
            || envelope.units.len() != 1
            || envelope.items.len() != envelope.units[0].item_ids.len()
        {
            return Err(invalid("build-input"));
        }
        let manifest: Self = from_value(&envelope.settings)?;
        manifest.validate()?;
        if manifest.project_id != envelope.project_id
            || envelope.items.len() != manifest.locales.len()
        {
            return Err(invalid("build-input"));
        }
        let mut indexes = BTreeSet::new();
        for item in &envelope.items {
            let index: usize = from_value(&item.payload)?;
            let locale = manifest
                .locales
                .get(index)
                .ok_or_else(|| invalid("build-input"))?;
            if !indexes.insert(index)
                || item.scope.kind != "locale-artifact"
                || item.scope.id != locale.file_name
                || item.scope.locale.as_deref() != Some(&locale.locale)
                || !item.dependencies.is_empty()
            {
                return Err(invalid("build-input"));
            }
        }
        Ok(manifest)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildOutput {
    pub version: u32,
    pub locale: String,
    pub file_name: String,
    pub utf8: String,
    pub sha256: String,
    pub entry_count: u32,
    pub builder_version: String,
}

pub fn build_locale(
    locale: &BuildLocale,
    cancel: &Cancellation,
) -> Result<BuildOutput, ExecutionError> {
    let mut utf8 = String::from("{\n");
    for (index, entry) in locale.entries.iter().enumerate() {
        if cancel.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "build-cancelled"));
        }
        if index != 0 {
            utf8.push_str(",\n");
        }
        utf8.push_str("  ");
        utf8.push_str(&serde_json::to_string(&entry.native_key).map_err(|_| invalid("build-key"))?);
        utf8.push_str(": ");
        utf8.push_str(&serde_json::to_string(&entry.value).map_err(|_| invalid("build-value"))?);
        if utf8.len() > MAX_ARTIFACT_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "build-artifact"));
        }
    }
    utf8.push_str("\n}\n");
    if utf8.len() > MAX_ARTIFACT_BYTES {
        return Err(failure(ErrorCode::LimitExceeded, "build-artifact"));
    }
    Ok(BuildOutput {
        version: 1,
        locale: locale.locale.clone(),
        file_name: locale.file_name.clone(),
        sha256: codec::digest(utf8.as_bytes()),
        entry_count: locale.entries.len() as u32,
        utf8,
        builder_version: BUILDER_VERSION.into(),
    })
}

pub fn validate_build_output(
    locale: &BuildLocale,
    output: &BuildOutput,
) -> Result<(), ExecutionError> {
    if output.version != 1
        || output.builder_version != BUILDER_VERSION
        || output.locale != locale.locale
        || output.file_name != locale.file_name
        || output.entry_count as usize != locale.entries.len()
        || output.utf8.len() > MAX_ARTIFACT_BYTES
        || output.utf8.starts_with('\u{feff}')
        || codec::digest(output.utf8.as_bytes()) != output.sha256
    {
        return Err(invalid("build-output"));
    }
    let parsed = jsonc_parser::parse_to_ast(
        &output.utf8,
        &CollectOptions::default(),
        &ParseOptions {
            allow_comments: false,
            allow_trailing_commas: false,
            allow_loose_object_property_names: false,
            allow_missing_commas: false,
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
        },
    )
    .map_err(|_| invalid("build-json"))?;
    let Some(AstValue::Object(object)) = parsed.value else {
        return Err(invalid("build-json"));
    };
    if object.properties.len() != locale.entries.len() {
        return Err(invalid("build-coverage"));
    }
    let mut keys = BTreeSet::new();
    for (property, expected) in object.properties.iter().zip(&locale.entries) {
        let Some(text) = property.value.as_string_lit() else {
            return Err(invalid("build-value"));
        };
        if !keys.insert(property.name.as_str().to_ascii_lowercase())
            || property.name.as_str() != expected.native_key
            || text.value.as_ref() != expected.value
        {
            return Err(invalid("build-content"));
        }
    }
    if output.utf8 != build_locale(locale, &Cancellation::default())?.utf8 {
        return Err(invalid("build-canonical"));
    }
    Ok(())
}

pub struct BuildRunner;
impl Runner for BuildRunner {
    fn capability_id(&self) -> &str {
        BUILD_CAPABILITY
    }
    fn capability_version(&self) -> &str {
        BUILD_CAPABILITY_VERSION
    }

    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        let input = &request.input;
        let outcome = BuildManifest::from_input(input).and_then(|manifest| {
            let index: usize = from_value(&input.item(request.item_id)?.payload)?;
            let locale = manifest
                .locales
                .get(index)
                .ok_or_else(|| invalid("build-item"))?;
            let output = build_locale(locale, &cancellation)?;
            validate_build_output(locale, &output)?;
            value(&output)
        });
        let mut envelope = ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: BUILD_CAPABILITY.into(),
            capability_version: BUILD_CAPABILITY_VERSION.into(),
            outcome: ExecutionState::Succeeded,
            output: None,
            diagnostic: None,
        };
        match outcome {
            Ok(output) => envelope.output = Some(output),
            Err(error) => {
                envelope.outcome =
                    if matches!(error.code, ErrorCode::Cancelled | ErrorCode::OutcomeUnknown) {
                        ExecutionState::Unknown
                    } else {
                        ExecutionState::Failed
                    };
                envelope.diagnostic = Some(Diagnostic {
                    code: error.stage,
                    retry_safe: false,
                });
            }
        }
        let result = match FixedResult::capture(envelope.clone(), input, request.dispatch_token) {
            Ok(result) => result,
            Err(error) if error.code == ErrorCode::LimitExceeded => {
                envelope.outcome = ExecutionState::Failed;
                envelope.output = None;
                envelope.diagnostic = Some(Diagnostic {
                    code: "limit-exceeded".into(),
                    retry_safe: false,
                });
                FixedResult::capture(envelope, input, request.dispatch_token)?
            }
            Err(error) => return Err(error),
        };
        sender.send(result)
    }
}
