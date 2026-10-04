//! First-party extraction of a captured, flat SMAPI translation file.

use super::*;
use jsonc_parser::ast::ObjectPropName;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const TRANSLATION_OPERATION: &str = "translation-import";
pub const TRANSLATION_CAPABILITY: &str = "stardew-smapi.translation-extract";
pub const TRANSLATION_CAPABILITY_VERSION: &str = "1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationBundle {
    pub version: u32,
    pub plugin_id: String,
    pub plugin_version: String,
    pub bundle_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub target_locale: String,
    pub declared_locale: String,
    pub language_evidence: String,
    pub format_id: String,
    pub format_version: u32,
    pub file: CapturedFile,
    pub manifest_digest: String,
}

impl TranslationBundle {
    pub fn capture(
        path: &str,
        bytes: &[u8],
        target_locale: &str,
        source_snapshot_id: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        let declared = declared_locale(path)?;
        let target = Locale::parse(target_locale).map_err(|_| invalid("language-conflict"))?;
        if target.as_str() != target_locale
            || declared.split('-').next() != target_locale.split('-').next()
        {
            return Err(invalid("language-conflict"));
        }
        let mut bundle = Self {
            version: 1,
            plugin_id: PLUGIN_ID.into(),
            plugin_version: PLUGIN_VERSION.into(),
            bundle_id: ExecutionId::new(),
            source_snapshot_id,
            target_locale: target_locale.into(),
            declared_locale: declared,
            language_evidence: "user-confirmed".into(),
            format_id: FORMAT.into(),
            format_version: 1,
            file: CapturedFile::new(path, "translation", bytes)?,
            manifest_digest: String::new(),
        };
        bundle.manifest_digest = bundle.calculate_digest()?;
        bundle.validate()?;
        Ok(bundle)
    }

    fn calculate_digest(&self) -> Result<String, ExecutionError> {
        Ok(codec::digest(&codec::encode(
            &(
                self.version,
                &self.plugin_id,
                &self.plugin_version,
                self.bundle_id,
                self.source_snapshot_id,
                &self.target_locale,
                &self.declared_locale,
                &self.language_evidence,
                &self.format_id,
                self.format_version,
                self.file.artifact_id,
                &self.file.logical_path,
                &self.file.role,
                self.file.byte_length,
                &self.file.sha256,
            ),
            MAX_INPUT_BYTES,
        )?))
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        let declared = declared_locale(&self.file.logical_path)?;
        let target =
            Locale::parse(&self.target_locale).map_err(|_| invalid("language-conflict"))?;
        if self.version != 1
            || self.plugin_id != PLUGIN_ID
            || self.plugin_version != PLUGIN_VERSION
            || self.format_id != FORMAT
            || self.format_version != 1
            || self.language_evidence != "user-confirmed"
            || self.declared_locale != declared
            || target.as_str() != self.target_locale
            || declared.split('-').next() != self.target_locale.split('-').next()
            || self.file.role != "translation"
            || self.file.byte_length as usize != self.file.utf8.len()
            || self.file.utf8.len() > MAX_SOURCE_BYTES
            || codec::digest(self.file.utf8.as_bytes()) != self.file.sha256
            || self.calculate_digest()? != self.manifest_digest
        {
            return Err(invalid("invalid-structure"));
        }
        Ok(())
    }

    pub fn fixed_input(&self, project: ProjectId) -> Result<FixedInput, ExecutionError> {
        let entries = parsed_translation(self, &Cancellation::default())?;
        let items = if entries.is_empty() {
            vec![InputItem::new(
                Scope {
                    kind: "translation-empty".into(),
                    id: self.bundle_id.to_string(),
                    locale: Some(self.target_locale.clone()),
                },
                value(&Option::<u32>::None)?,
                vec![],
            )]
        } else {
            entries
                .iter()
                .map(|entry| {
                    Ok(InputItem::new(
                        Scope {
                            kind: "translation-entry".into(),
                            id: format!("{}:{}", self.bundle_id, entry.ordinal),
                            locale: Some(self.target_locale.clone()),
                        },
                        value(&Some(entry.ordinal))?,
                        vec![],
                    ))
                })
                .collect::<Result<Vec<_>, ExecutionError>>()?
        };
        let mut envelope = InputEnvelope::new(
            project,
            TRANSLATION_OPERATION,
            TRANSLATION_CAPABILITY,
            TRANSLATION_CAPABILITY_VERSION,
            items,
        )?;
        envelope.settings = value(self)?;
        FixedInput::capture(envelope)
    }

    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        static CACHE: OnceLock<Mutex<Option<(String, TranslationBundle)>>> = OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        if let Some((_, bundle)) = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|(digest, _)| digest == input.digest())
        {
            return Ok(bundle.clone());
        }
        let envelope = input.envelope();
        if envelope.operation != TRANSLATION_OPERATION
            || envelope.capability_id != TRANSLATION_CAPABILITY
            || envelope.capability_version != TRANSLATION_CAPABILITY_VERSION
            || envelope.items.len() != envelope.units.len()
        {
            return Err(invalid("unsupported-format"));
        }
        let bundle: Self = from_value(&envelope.settings)?;
        bundle.validate()?;
        let entries = parsed_translation(&bundle, &Cancellation::default())?;
        if envelope.items.len() != entries.len().max(1) {
            return Err(invalid("invalid-structure"));
        }
        let mut ordinals = std::collections::BTreeSet::new();
        for item in &envelope.items {
            if !item.dependencies.is_empty()
                || item.scope.locale.as_deref() != Some(&bundle.target_locale)
            {
                return Err(invalid("invalid-structure"));
            }
            let ordinal: Option<u32> = from_value(&item.payload)?;
            let valid = if let Some(ordinal) = ordinal {
                item.scope.kind == "translation-entry"
                    && item.scope.id == format!("{}:{ordinal}", bundle.bundle_id)
                    && (ordinal as usize) < entries.len()
            } else {
                item.scope.kind == "translation-empty"
                    && item.scope.id == bundle.bundle_id.to_string()
                    && entries.is_empty()
            };
            if !valid || !ordinals.insert(ordinal) {
                return Err(invalid("invalid-structure"));
            }
        }
        if envelope.units.iter().any(|unit| unit.item_ids.len() != 1) {
            return Err(invalid("invalid-structure"));
        }
        *cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((input.digest().to_owned(), bundle.clone()));
        Ok(bundle)
    }
}

pub fn declared_locale(path: &str) -> Result<String, ExecutionError> {
    let Some(name) = path
        .strip_prefix("i18n/")
        .and_then(|name| name.strip_suffix(".json"))
    else {
        return Err(invalid("unsupported-format"));
    };
    if name == "default"
        || !name.is_ascii()
        || name.is_empty()
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(invalid("unsupported-format"));
    }
    let locale = Locale::parse(name).map_err(|_| invalid("language-conflict"))?;
    if locale.as_str() != name {
        return Err(invalid("language-conflict"));
    }
    Ok(name.into())
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationEntry {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub native_key: String,
    pub text: String,
    /// Half-open UTF-8 byte offsets in the captured file, including JSON quotes.
    pub key_byte_range: [u32; 2],
    /// Half-open UTF-8 byte offsets before escape decoding or text normalization.
    pub value_byte_range: [u32; 2],
}

pub fn extract_translation(
    bundle: &TranslationBundle,
    cancel: &Cancellation,
) -> Result<Vec<TranslationEntry>, ExecutionError> {
    Ok(parsed_translation(bundle, cancel)?.as_ref().clone())
}

fn parsed_translation(
    bundle: &TranslationBundle,
    cancel: &Cancellation,
) -> Result<Arc<Vec<TranslationEntry>>, ExecutionError> {
    bundle.validate()?;
    if cancel.is_requested() {
        return Err(failure(ErrorCode::Cancelled, "cancelled"));
    }
    // A fixed bundle digest commits to every captured byte and field. Keep only one
    // parsed bundle, so per-entry EX dispatch and validation do not reparse the
    // entire file for every item.
    static CACHE: OnceLock<Mutex<Option<(String, Arc<Vec<TranslationEntry>>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Some((_, entries)) = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|(digest, _)| digest == &bundle.manifest_digest)
    {
        return Ok(entries.clone());
    }
    let deadline = Instant::now() + Duration::from_secs(60);
    let (root, offset) = super::smapi::parse(&bundle.file.utf8, cancel, deadline)?;
    let root = root
        .as_object()
        .ok_or_else(|| invalid("invalid-structure"))?;
    let mut entries = Vec::new();
    for property in &root.properties {
        if cancel.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "cancelled"));
        }
        if Instant::now() > deadline {
            return Err(failure(ErrorCode::OutcomeUnknown, "extract-timeout"));
        }
        let key = property.name.as_str();
        if !super::smapi::ascii(key, 1024) {
            return Err(invalid("unsupported-format"));
        }
        let text = property
            .value
            .as_string_lit()
            .ok_or_else(|| invalid("translation-value-not-string"))?;
        if text.value.len() > MAX_TEXT_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        if key == "$schema" {
            continue;
        }
        if entries.len() >= MAX_OCCURRENCES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        let key_range = match &property.name {
            ObjectPropName::String(value) => value.range,
            _ => return Err(invalid("invalid-structure")),
        };
        entries.push(TranslationEntry {
            ordinal: entries.len() as u32,
            artifact_id: bundle.file.artifact_id,
            native_key: key.into(),
            text: text.value.to_string(),
            key_byte_range: [
                offset + key_range.start as u32,
                offset + key_range.end as u32,
            ],
            value_byte_range: [
                offset + text.range.start as u32,
                offset + text.range.end as u32,
            ],
        });
    }
    let entries = Arc::new(entries);
    *cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) =
        Some((bundle.manifest_digest.clone(), entries.clone()));
    Ok(entries)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationOutput {
    pub version: u32,
    pub bundle_id: ExecutionId,
    pub manifest_digest: String,
    pub file_digest: String,
    pub entry_count: u32,
    pub entry: Option<TranslationEntry>,
}

pub fn validate_translation_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<TranslationOutput, ExecutionError> {
    let bundle = TranslationBundle::from_input(input)?;
    if result.envelope().outcome != ExecutionState::Succeeded {
        return Err(invalid("invalid-structure"));
    }
    let item = input.item(result.envelope().item_id)?;
    let ordinal: Option<u32> = from_value(&item.payload)?;
    let entries = parsed_translation(&bundle, &Cancellation::default())?;
    let expected = TranslationOutput {
        version: 1,
        bundle_id: bundle.bundle_id,
        manifest_digest: bundle.manifest_digest,
        file_digest: bundle.file.sha256,
        entry_count: entries.len() as u32,
        entry: ordinal.map(|ordinal| entries[ordinal as usize].clone()),
    };
    let actual: TranslationOutput = from_value(
        result
            .envelope()
            .output
            .as_ref()
            .ok_or_else(|| invalid("invalid-structure"))?,
    )?;
    if actual != expected {
        return Err(invalid("invalid-structure"));
    }
    Ok(actual)
}

pub struct TranslationRunner;
impl Runner for TranslationRunner {
    fn capability_id(&self) -> &str {
        TRANSLATION_CAPABILITY
    }
    fn capability_version(&self) -> &str {
        TRANSLATION_CAPABILITY_VERSION
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        let input = &request.input;
        let outcome = TranslationBundle::from_input(input)
            .and_then(|bundle| {
                let item = input.item(request.item_id)?;
                let ordinal: Option<u32> = from_value(&item.payload)?;
                let entries = parsed_translation(&bundle, &cancellation)?;
                Ok(TranslationOutput {
                    version: 1,
                    bundle_id: bundle.bundle_id,
                    manifest_digest: bundle.manifest_digest,
                    file_digest: bundle.file.sha256,
                    entry_count: entries.len() as u32,
                    entry: ordinal.map(|ordinal| entries[ordinal as usize].clone()),
                })
            })
            .and_then(|output| value(&output));
        let mut envelope = ResultEnvelope {
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: TRANSLATION_CAPABILITY.into(),
            capability_version: TRANSLATION_CAPABILITY_VERSION.into(),
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
        sender.send(FixedResult::capture(
            envelope,
            input,
            request.dispatch_token,
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn snapshot() -> ExecutionId {
        ExecutionId::new()
    }
    fn project() -> ProjectId {
        crate::ProjectMetadata::create("Translation fixture", "en", ["zh-CN"])
            .unwrap()
            .project_id()
    }

    #[test]
    fn translation_unicode_fixture_preserves_original_utf8_ranges() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/source-unicode.contract.json"
        ))
        .unwrap();
        let case = &fixture["cases"][0];
        let raw = case["raw"].as_str().unwrap();
        let bundle =
            TranslationBundle::capture("i18n/zh.json", raw.as_bytes(), "zh-CN", snapshot())
                .unwrap();
        let entries = extract_translation(&bundle, &Cancellation::default()).unwrap();
        let expected = case["rows"].as_array().unwrap();
        assert_eq!(entries.len(), expected.len());
        for (entry, row) in entries.iter().zip(expected) {
            let oracle = &row["occurrence"];
            assert_eq!(entry.ordinal as u64, oracle["ordinal"].as_u64().unwrap());
            assert_eq!(entry.native_key, oracle["key"].as_str().unwrap());
            assert_eq!(entry.text, oracle["text"].as_str().unwrap());
            assert_eq!(
                serde_json::to_value(entry.key_byte_range).unwrap(),
                oracle["keyByteRange"]
            );
            assert_eq!(
                serde_json::to_value(entry.value_byte_range).unwrap(),
                oracle["valueByteRange"]
            );
            let [start, end] = entry.value_byte_range.map(|v| v as usize);
            assert_eq!(
                serde_json::from_slice::<String>(&raw.as_bytes()[start..end]).unwrap(),
                entry.text
            );
            let decoded: TranslationEntry =
                serde_json::from_value(serde_json::to_value(entry).unwrap()).unwrap();
            assert_eq!(decoded, *entry);
        }
    }

    #[test]
    fn real_translation_matches_independent_oracle_and_fixed_input() {
        let bytes = include_bytes!("../../tests/fixtures/stardew-lookup/i18n/zh.json");
        let oracle: Value = serde_json::from_slice(include_bytes!(
            "../../tests/fixtures/stardew-lookup/translation-oracle.json"
        ))
        .unwrap();
        let bundle =
            TranslationBundle::capture("i18n/zh.json", bytes, "zh-CN", snapshot()).unwrap();
        assert_eq!(
            bundle.file.sha256,
            oracle["translationSha256"].as_str().unwrap()
        );
        let entries = extract_translation(&bundle, &Cancellation::default()).unwrap();
        assert_eq!(entries.len(), oracle["count"].as_u64().unwrap() as usize);
        for (entry, expected) in entries.iter().zip(oracle["entries"].as_array().unwrap()) {
            assert_eq!(entry.ordinal, expected["ordinal"].as_u64().unwrap() as u32);
            assert_eq!(entry.native_key, expected["key"].as_str().unwrap());
            assert_eq!(entry.text, expected["text"].as_str().unwrap());
            for range in [entry.key_byte_range, entry.value_byte_range] {
                assert!(range[0] < range[1]);
                assert!(range[1] <= bytes.len() as u32);
            }
        }
        let input = bundle.fixed_input(project()).unwrap();
        assert_eq!(input.envelope().items.len(), 532);
        assert!(input.bytes().len() <= MAX_INPUT_BYTES);
        assert_eq!(TranslationBundle::from_input(&input).unwrap(), bundle);
        let item = &input.envelope().items[0];
        let token = ExecutionId::new();
        let (sender, receiver) = result_channel();
        TranslationRunner
            .run(
                DispatchRequest {
            provider: None,
                    input: input.clone(),
                    item_id: item.item_id,
                    dispatch_token: token,
                },
                Cancellation::default(),
                sender,
            )
            .unwrap();
        let result = receiver.recv().unwrap();
        assert_eq!(result.envelope().outcome, ExecutionState::Succeeded);
        let output = validate_translation_output(&input, &result).unwrap();
        let ordinal: Option<u32> = from_value(&item.payload).unwrap();
        assert_eq!(
            output.entry,
            Some(entries[ordinal.unwrap() as usize].clone())
        );
        let mut forged = result.envelope().clone();
        let mut forged_output = output;
        forged_output.entry.as_mut().unwrap().text = "forged".into();
        forged.output = Some(value(&forged_output).unwrap());
        let forged = FixedResult::capture(forged, &input, token).unwrap();
        assert_eq!(
            validate_translation_output(&input, &forged)
                .unwrap_err()
                .code,
            ErrorCode::OutputInvalid
        );
    }

    #[test]
    fn complete_file_limits_and_language_mapping_are_enforced() {
        let source = format!(
            "{{{}}}",
            (0..MAX_OCCURRENCES)
                .map(|n| format!("\"k{n}\":\"x\""))
                .collect::<Vec<_>>()
                .join(",")
        );
        let bundle =
            TranslationBundle::capture("i18n/zh.json", source.as_bytes(), "zh-CN", snapshot())
                .unwrap();
        assert_eq!(
            extract_translation(&bundle, &Cancellation::default())
                .unwrap()
                .len(),
            MAX_OCCURRENCES
        );
        let input = bundle.fixed_input(project()).unwrap();
        assert_eq!(input.envelope().items.len(), MAX_OCCURRENCES);
        assert!(input.bytes().len() <= MAX_INPUT_BYTES);
        let too_many = source.replacen('}', ",\"extra\":\"x\"}", 1);
        let over =
            TranslationBundle::capture("i18n/zh.json", too_many.as_bytes(), "zh-CN", snapshot())
                .unwrap();
        assert_eq!(
            extract_translation(&over, &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        let padded = format!("{{\"a\":\"x\"{}}}", " ".repeat(MAX_SOURCE_BYTES - 9));
        assert_eq!(padded.len(), MAX_SOURCE_BYTES);
        assert!(
            TranslationBundle::capture("i18n/zh.json", padded.as_bytes(), "zh-CN", snapshot())
                .is_ok()
        );
        assert_eq!(
            TranslationBundle::capture(
                "i18n/zh.json",
                format!("{padded} ").as_bytes(),
                "zh-CN",
                snapshot()
            )
            .unwrap_err()
            .code,
            ErrorCode::LimitExceeded
        );
        let longest = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_TEXT_BYTES));
        let exact =
            TranslationBundle::capture("i18n/zh.json", longest.as_bytes(), "zh-CN", snapshot())
                .unwrap();
        assert_eq!(
            extract_translation(&exact, &Cancellation::default()).unwrap()[0]
                .text
                .len(),
            MAX_TEXT_BYTES
        );
        let too_long = format!("{{\"a\":\"{}\"}}", "x".repeat(MAX_TEXT_BYTES + 1));
        let over =
            TranslationBundle::capture("i18n/zh.json", too_long.as_bytes(), "zh-CN", snapshot())
                .unwrap();
        assert_eq!(
            extract_translation(&over, &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::LimitExceeded
        );
        for (path, target) in [
            ("i18n/default.json", "zh-CN"),
            ("i18n/zh.json", "ja"),
            ("../zh.json", "zh-CN"),
            ("i18n/ZH.json", "zh-CN"),
        ] {
            assert!(TranslationBundle::capture(path, b"{}", target, snapshot()).is_err());
        }
        let empty = TranslationBundle::capture("i18n/zh.json", b"{}", "zh-CN", snapshot()).unwrap();
        assert!(
            extract_translation(&empty, &Cancellation::default())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            empty.fixed_input(project()).unwrap().envelope().items.len(),
            1
        );
        for text in [br#"{"a":"x","A":"y"}"#.as_slice(), br#"{"a":1}"#.as_slice()] {
            let invalid =
                TranslationBundle::capture("i18n/zh.json", text, "zh-CN", snapshot()).unwrap();
            assert!(extract_translation(&invalid, &Cancellation::default()).is_err());
        }
    }
}
