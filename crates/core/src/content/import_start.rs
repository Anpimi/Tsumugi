//! Native import submissions bound to the existing immutable execution input.

use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImportStart {
    pub project_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub selection_id: ExecutionId,
    pub source_language: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationImportStart {
    pub project_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub selection_id: ExecutionId,
    pub file_name: String,
    pub target_locale: String,
    pub language_confirmed: bool,
    pub expected_file_digest: String,
    pub expected_source_snapshot_id: ExecutionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceImportStartRead {
    pub request: SourceImportStart,
    pub task_id: ExecutionId,
    pub input_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationImportStartRead {
    pub request: TranslationImportStart,
    pub task_id: ExecutionId,
    pub input_digest: String,
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranslationSettings {
    bundle: TranslationBundle,
    native_start: TranslationImportStart,
}

impl SourceImportStart {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        if Locale::parse(&self.source_language).map_err(|_| invalid("language-required"))?.as_str()
            != self.source_language {
            return Err(invalid("language-conflict"));
        }
        Ok(())
    }
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let bundle = SourceBundle::from_input(input)?;
        let request = source_native_start(input, &bundle)?
            .ok_or_else(|| failure(ErrorCode::ResultMismatch, "source-start-unbound"))?;
        check_root(input, request.project_id, request.attempt_id)?;
        Ok(request)
    }
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
impl TranslationImportStart {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        let declared = declared_locale(&format!("i18n/{}", self.file_name))?;
        let locale = Locale::parse(&self.target_locale).map_err(|_| invalid("language-conflict"))?;
        if !self.language_confirmed || locale.as_str() != self.target_locale
            || declared.split('-').next() != self.target_locale.split('-').next()
            || self.expected_file_digest.len() != 64
            || !self.expected_file_digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(invalid("translation-start-request"));
        }
        Ok(())
    }
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        TranslationBundle::from_input(input)?;
        let (_, request) = translation_settings(&input.envelope().settings)?;
        let request = request.ok_or_else(|| failure(ErrorCode::ResultMismatch, "translation-start-unbound"))?;
        check_root(input, request.project_id, request.attempt_id)?;
        Ok(request)
    }
}

fn check_root(input: &FixedInput, project: ExecutionId, attempt: ExecutionId) -> Result<(), ExecutionError> {
    let envelope = input.envelope();
    if envelope.project_id != project || envelope.attempt_id != attempt || envelope.previous_attempt_id.is_some() {
        return Err(failure(ErrorCode::ResultMismatch, "import-start-root"));
    }
    Ok(())
}

fn check_origin(input: &FixedInput, project: ExecutionId, attempt: ExecutionId) -> Result<(), ExecutionError> {
    // Continuations retain the original request; they do not become new native starts.
    let envelope = input.envelope();
    if envelope.project_id != project || (envelope.previous_attempt_id.is_none() && envelope.attempt_id != attempt)
        || (envelope.previous_attempt_id.is_some() && envelope.attempt_id == attempt) {
        return Err(failure(ErrorCode::ResultMismatch, "import-start-origin"));
    }
    Ok(())
}

pub(crate) fn source_native_start(input: &FixedInput, bundle: &SourceBundle) -> Result<Option<SourceImportStart>, ExecutionError> {
    let settings = super::SourceSettings::from_input(input)?;
    let Some(request) = settings.native_start else { return Ok(None); };
    validate_source_start(input, &bundle.source_language, &request)?;
    Ok(Some(request))
}

pub(crate) fn validate_source_start(input: &FixedInput, source_language: &str, request: &SourceImportStart) -> Result<(), ExecutionError> {
    request.validate()?;
    check_origin(input, request.project_id, request.attempt_id)?;
    if request.source_language != source_language {
        return Err(failure(ErrorCode::ResultMismatch, "source-start-language"));
    }
    Ok(())
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub(crate) fn translation_settings(settings: &serde_json::Value) -> Result<(TranslationBundle, Option<TranslationImportStart>), ExecutionError> {
    // These are two current producer forms, not a fallback for malformed native input.
    if settings.get("nativeStart").is_some() || settings.get("bundle").is_some() {
        let settings: TranslationSettings = from_value(settings)?;
        Ok((settings.bundle, Some(settings.native_start)))
    } else {
        Ok((from_value(settings)?, None))
    }
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub(crate) fn validate_translation_start(input: &FixedInput, bundle: &TranslationBundle, request: &TranslationImportStart) -> Result<(), ExecutionError> {
    request.validate()?;
    check_origin(input, request.project_id, request.attempt_id)?;
    if bundle.target_locale != request.target_locale || bundle.source_snapshot_id != request.expected_source_snapshot_id
        || bundle.file.logical_path != format!("i18n/{}", request.file_name) || bundle.file.sha256 != request.expected_file_digest {
        return Err(failure(ErrorCode::ResultMismatch, "translation-start-capture"));
    }
    Ok(())
}

impl SourceBundle {
    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    pub fn fixed_input_for_import_start(&self, project: ProjectId, request: &SourceImportStart) -> Result<FixedInput, ExecutionError> {
        let mut envelope = self.fixed_input(project)?.envelope().clone();
        let mut settings: super::SourceSettings = from_value(&envelope.settings)?;
        settings.native_start = Some(request.clone());
        envelope.attempt_id = request.attempt_id;
        envelope.settings = value(&settings)?;
        let input = FixedInput::capture(envelope)?;
        SourceImportStart::from_input(&input)?;
        Ok(input)
    }
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
impl TranslationBundle {
    pub fn fixed_input_for_import_start(&self, project: ProjectId, request: &TranslationImportStart) -> Result<FixedInput, ExecutionError> {
        let mut envelope = self.fixed_input(project)?.envelope().clone();
        envelope.attempt_id = request.attempt_id;
        envelope.settings = value(&TranslationSettings { bundle: self.clone(), native_start: request.clone() })?;
        let input = FixedInput::capture(envelope)?;
        TranslationImportStart::from_input(&input)?;
        Ok(input)
    }
}
