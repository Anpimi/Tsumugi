//! Pure per-entry EX projection of an independently checked complete proposal.
//! Original plugin coordinates and native evidence remain in the producer ledger.
use super::*;
use std::sync::{Arc, Mutex, OnceLock};

pub const TRANSLATION_PROJECTION_CAPABILITY: &str = "core.translation-project";
const VERSION: &str = "1";

/// Historical proof of one exact built-in match projection being enqueued.
/// The producer association is evidence, not current qualification or permission.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationProjectionStartRead {
    pub project_id: ExecutionId,
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub translation_attempt_id: ExecutionId,
    pub translation_result_id: ExecutionId,
}

fn invalid() -> ExecutionError {
    ExecutionError::new(ErrorCode::OutputInvalid, "translation-projection")
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranslationProjectionOrigin {
    pub producer_attempt: ExecutionId,
    pub producer_result: ExecutionId,
    pub producer_input_digest: String,
    pub producer_result_digest: String,
    pub checker_attempt: ExecutionId,
    pub checker_result: ExecutionId,
    pub checker_input_digest: String,
    pub checker_result_digest: String,
}

// Ordinal and Core artifact identity are shared by the containing projection.
// The compact wire tuple avoids repeating field names/IDs 2000 times within
// the fixed 1 MiB input budget. Original SDK source references remain untouched.
type ProjectionEntryWire = (String, String, String, Option<[u32; 2]>, [u32; 2]);
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(from = "ProjectionEntryWire", into = "ProjectionEntryWire")]
pub(crate) struct ProjectedTranslationEntry {
    native_value: String,
    native_key: String,
    text: String,
    key_byte_range: Option<[u32; 2]>,
    value_byte_range: [u32; 2],
}
impl From<ProjectionEntryWire> for ProjectedTranslationEntry {
    fn from(
        (native_value, native_key, text, key_byte_range, value_byte_range): ProjectionEntryWire,
    ) -> Self {
        Self {
            native_value,
            native_key,
            text,
            key_byte_range,
            value_byte_range,
        }
    }
}
impl From<ProjectedTranslationEntry> for ProjectionEntryWire {
    fn from(entry: ProjectedTranslationEntry) -> Self {
        (
            entry.native_value,
            entry.native_key,
            entry.text,
            entry.key_byte_range,
            entry.value_byte_range,
        )
    }
}
impl ProjectedTranslationEntry {
    pub(crate) fn native_value(&self) -> &str {
        &self.native_value
    }
    pub(crate) fn entry(&self, ordinal: u32, artifact_id: ExecutionId) -> TranslationEntry {
        TranslationEntry {
            ordinal,
            artifact_id,
            native_key: self.native_key.clone(),
            text: self.text.clone(),
            key_byte_range: self.key_byte_range,
            value_byte_range: self.value_byte_range,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TranslationProjection {
    pub version: u32,
    pub origin: TranslationProjectionOrigin,
    pub bundle_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub target_locale: String,
    pub declared_locale: String,
    pub native_scope: sdk::TranslationNativeScope,
    pub file: CapturedFile,
    pub entries: Vec<ProjectedTranslationEntry>,
}

pub(crate) fn is_translation_projection(input: &FixedInput) -> bool {
    input.envelope().operation == TRANSLATION_OPERATION
        && input.envelope().capability_id == TRANSLATION_PROJECTION_CAPABILITY
}

impl TranslationProjection {
    /// IDs are allocated by Core once, independently of opaque plugin-local IDs.
    /// Restoration uses the captured IDs and compares the entire rebuilt value.
    pub(crate) fn capture(
        producer: &FixedInput,
        result: &FixedResult,
        checker: &FixedInput,
        checked: &FixedResult,
        bundle_id: ExecutionId,
        artifact_id: ExecutionId,
    ) -> Result<Self, ExecutionError> {
        let proposal = validate_plugin_translation_output(producer, result)?;
        if proposal.artifacts.len() != 1 || proposal.entries.len() > MAX_OCCURRENCES {
            return Err(invalid());
        }
        let artifact = &proposal.artifacts[0];
        if artifact.utf8.len() > MAX_SOURCE_BYTES {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "translation-file-budget",
            ));
        }
        let mut file = CapturedFile::new(
            &artifact.logical_path,
            &artifact.role,
            artifact.utf8.as_bytes(),
        )?;
        file.artifact_id = artifact_id;
        let indexed: std::collections::BTreeMap<_, _> = proposal
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect();
        let mut entries = Vec::with_capacity(proposal.order.len());
        for id in &proposal.order {
            let imported = indexed.get(id.as_str()).ok_or_else(invalid)?;
            if imported.source.artifact_id != artifact.id {
                return Err(invalid());
            }
            let range = sdk::convert_text_range(
                &artifact.utf8,
                imported.source.range,
                sdk::TextEncoding::Utf8Byte,
            )
            .map_err(|_| invalid())?;
            let key_byte_range = imported
                .native_identity
                .display
                .source
                .as_ref()
                .map(|source| {
                    if source.artifact_id != artifact.id {
                        return Err(invalid());
                    }
                    sdk::convert_text_range(
                        &artifact.utf8,
                        source.range,
                        sdk::TextEncoding::Utf8Byte,
                    )
                    .map(|range| [range.start, range.end])
                    .map_err(|_| invalid())
                })
                .transpose()?;
            entries.push(ProjectedTranslationEntry {
                native_value: imported.native_identity.value.clone(),
                native_key: imported.native_identity.display.value.clone(),
                text: imported.text.clone(),
                key_byte_range,
                value_byte_range: [range.start, range.end],
            });
        }
        Ok(Self {
            version: 1,
            origin: TranslationProjectionOrigin {
                producer_attempt: producer.envelope().attempt_id,
                producer_result: result.envelope().result_id,
                producer_input_digest: producer.digest().into(),
                producer_result_digest: result.digest().into(),
                checker_attempt: checker.envelope().attempt_id,
                checker_result: checked.envelope().result_id,
                checker_input_digest: checker.digest().into(),
                checker_result_digest: checked.digest().into(),
            },
            bundle_id,
            source_snapshot_id: ExecutionId::parse(&proposal.source_snapshot_id)
                .map_err(|_| invalid())?,
            target_locale: proposal.target_language,
            declared_locale: proposal.declared_language,
            native_scope: proposal.native_scope,
            file,
            entries,
        })
    }

    pub(crate) fn fixed_input(&self, project: ProjectId) -> Result<FixedInput, ExecutionError> {
        let items = (0..self.entries.len().max(1))
            .map(|ordinal| {
                let ordinal = (!self.entries.is_empty()).then_some(ordinal as u32);
                InputItem::new(
                    Scope {
                        kind: if ordinal.is_some() {
                            "translation-entry"
                        } else {
                            "translation-empty"
                        }
                        .into(),
                        id: ordinal.map_or_else(
                            || self.bundle_id.to_string(),
                            |n| format!("{}:{n}", self.bundle_id),
                        ),
                        locale: Some(self.target_locale.clone()),
                    },
                    value(&ordinal).expect("optional integer serialization"),
                    vec![],
                )
            })
            .collect();
        let mut envelope = InputEnvelope::new(
            project,
            TRANSLATION_OPERATION,
            TRANSLATION_PROJECTION_CAPABILITY,
            VERSION,
            items,
        )?;
        envelope.settings = value(self)?;
        envelope.limits.max_result_bytes = MAX_TRANSLATION_RESULT_BYTES as u32;
        let input = FixedInput::capture(envelope)?;
        Self::from_input(&input)?;
        Ok(input)
    }

    pub(crate) fn from_input(input: &FixedInput) -> Result<Arc<Self>, ExecutionError> {
        static CACHE: OnceLock<Mutex<Option<(String, Arc<TranslationProjection>)>>> =
            OnceLock::new();
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        if let Some((_, projection)) = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|(digest, _)| digest == input.digest())
        {
            return Ok(projection.clone());
        }
        let envelope = input.envelope();
        if input.bytes().len() > MAX_TRANSLATION_INPUT_BYTES {
            return Err(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "translation-projection-input-budget",
            ));
        }
        if !is_translation_projection(input)
            || envelope.capability_version != VERSION
            || envelope.plugin.is_some()
            || envelope.units.len() != envelope.items.len()
            || envelope.limits.max_result_bytes as usize > MAX_TRANSLATION_RESULT_BYTES
        {
            return Err(invalid());
        }
        let projection: Self = from_value(&envelope.settings)?;
        if projection.file.byte_length as usize != projection.file.utf8.len()
            || projection.file.sha256 != codec::digest(projection.file.utf8.as_bytes())
        {
            return Err(invalid());
        }
        if projection.version != 1
            || projection.file.byte_length as usize > MAX_SOURCE_BYTES
            || projection.entries.len() > MAX_OCCURRENCES
            || envelope.items.len() != projection.entries.len().max(1)
            || Locale::parse(&projection.target_locale)
                .map_err(|_| invalid())?
                .as_str()
                != projection.target_locale
        {
            return Err(invalid());
        }
        let mut ordinals = std::collections::BTreeSet::new();
        for item in &envelope.items {
            let ordinal: Option<u32> = from_value(&item.payload)?;
            let valid = match ordinal {
                Some(n) => {
                    !projection.entries.is_empty() && (n as usize) < projection.entries.len()
                }
                None => projection.entries.is_empty(),
            };
            if !valid
                || !ordinals.insert(ordinal)
                || !item.dependencies.is_empty()
                || item.scope.locale.as_deref() != Some(projection.target_locale.as_str())
                || item.scope.kind
                    != if ordinal.is_some() {
                        "translation-entry"
                    } else {
                        "translation-empty"
                    }
                || item.scope.id
                    != ordinal.map_or_else(
                        || projection.bundle_id.to_string(),
                        |n| format!("{}:{n}", projection.bundle_id),
                    )
                || !envelope
                    .units
                    .iter()
                    .any(|unit| unit.item_ids == [item.item_id])
            {
                return Err(invalid());
            }
        }
        if projection
            .entries
            .iter()
            .any(|entry| entry.text.len() > MAX_TEXT_BYTES)
        {
            return Err(invalid());
        }
        let projection = Arc::new(projection);
        *cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((input.digest().into(), projection.clone()));
        Ok(projection)
    }

    pub(crate) fn output(
        &self,
        input: &FixedInput,
        item: ExecutionId,
    ) -> Result<TranslationOutput, ExecutionError> {
        let ordinal: Option<u32> = from_value(&input.item(item)?.payload)?;
        Ok(TranslationOutput {
            version: 1,
            bundle_id: self.bundle_id,
            manifest_digest: input.digest().into(),
            file_digest: self.file.sha256.clone(),
            entry_count: self.entries.len() as u32,
            entry: ordinal.map(|n| self.entries[n as usize].entry(n, self.file.artifact_id)),
        })
    }
}

pub(crate) fn validate_projected_translation_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<TranslationOutput, ExecutionError> {
    FixedResult::restore(
        result.bytes(),
        result.digest(),
        input,
        result.envelope().dispatch_token,
    )?;
    let projection = TranslationProjection::from_input(input)?;
    let expected = projection.output(input, result.envelope().item_id)?;
    let actual: TranslationOutput =
        from_value(result.envelope().output.as_ref().ok_or_else(invalid)?)?;
    if result.envelope().outcome != ExecutionState::Succeeded || actual != expected {
        return Err(invalid());
    }
    Ok(actual)
}

/// This Core runner only copies checked entries; it never interprets domain files.
/// Store mutation boundaries independently restore the original checker proof.
pub struct TranslationProjectionRunner;
impl Runner for TranslationProjectionRunner {
    fn capability_id(&self) -> &str {
        TRANSLATION_PROJECTION_CAPABILITY
    }
    fn capability_version(&self) -> &str {
        VERSION
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        let input = &request.input;
        let output = if cancellation.is_requested() {
            Err(ExecutionError::new(ErrorCode::Cancelled, "cancelled"))
        } else {
            TranslationProjection::from_input(input)?
                .output(input, request.item_id)
                .and_then(|output| value(&output))
        };
        let mut envelope = ResultEnvelope {
            plugin: None,
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: TRANSLATION_PROJECTION_CAPABILITY.into(),
            capability_version: VERSION.into(),
            outcome: ExecutionState::Succeeded,
            output: None,
            diagnostic: None,
        };
        match output {
            Ok(output) => envelope.output = Some(output),
            Err(error) => {
                envelope.outcome = if error.code == ErrorCode::Cancelled {
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

    // Structural projection fixtures only; they cannot establish plugin proof
    // or pass the Store's independently reconstructed origin boundary.
    fn fixture(count: usize, raw_bytes: usize) -> TranslationProjection {
        TranslationProjection {
            version: 1,
            origin: TranslationProjectionOrigin {
                producer_attempt: ExecutionId::new(),
                producer_result: ExecutionId::new(),
                producer_input_digest: "a".repeat(64),
                producer_result_digest: "b".repeat(64),
                checker_attempt: ExecutionId::new(),
                checker_result: ExecutionId::new(),
                checker_input_digest: "c".repeat(64),
                checker_result_digest: "d".repeat(64),
            },
            bundle_id: ExecutionId::new(),
            source_snapshot_id: ExecutionId::new(),
            target_locale: "zh-CN".into(),
            declared_locale: "zh".into(),
            native_scope: sdk::TranslationNativeScope {
                namespace: "Example.Mod".into(),
                policy: contract_ref("opaque-case-sensitive"),
            },
            file: CapturedFile::new("i18n/zh.json", "translation", &vec![b'x'; raw_bytes]).unwrap(),
            entries: (0..count)
                .map(|ordinal| ProjectedTranslationEntry {
                    native_value: format!("MiX{ordinal}"),
                    native_key: format!("Display{ordinal}"),
                    text: "a".into(),
                    key_byte_range: None,
                    value_byte_range: [0, 1],
                })
                .collect(),
        }
    }
    fn project() -> ProjectId {
        crate::ProjectMetadata::create("Projection bounds", "en-US", ["zh-CN"])
            .unwrap()
            .project_id()
    }

    #[test]
    fn translation_projection_maximum_items_share_one_file_within_whole_input_and_attempt_budgets()
    {
        let projection = fixture(MAX_OCCURRENCES, MAX_SOURCE_BYTES);
        let input = projection.fixed_input(project()).unwrap();
        assert_eq!(input.envelope().items.len(), 2000);
        assert_eq!(input.envelope().units.len(), 2000);
        assert!(input.bytes().len() <= MAX_TRANSLATION_INPUT_BYTES);
        let mut bytes = 0;
        for item in &input.envelope().items {
            let output = projection.output(&input, item.item_id).unwrap();
            assert!(output.entry.as_ref().unwrap().key_byte_range.is_none());
            let token = ExecutionId::new();
            let result = FixedResult::capture(
                ResultEnvelope {
                    plugin: None,
                    project_id: input.envelope().project_id,
                    attempt_id: input.envelope().attempt_id,
                    item_id: item.item_id,
                    result_id: ExecutionId::new(),
                    supersedes: None,
                    dispatch_token: token,
                    capability_id: TRANSLATION_PROJECTION_CAPABILITY.into(),
                    capability_version: VERSION.into(),
                    outcome: ExecutionState::Succeeded,
                    output: Some(value(&output).unwrap()),
                    diagnostic: None,
                },
                &input,
                token,
            )
            .unwrap();
            assert!(result.bytes().len() <= MAX_TRANSLATION_RESULT_BYTES);
            bytes += result.bytes().len();
        }
        assert!(bytes <= input.envelope().limits.max_attempt_result_bytes as usize);
        eprintln!(
            "projection maximum: input={} bytes, results={} bytes, items=2000",
            input.bytes().len(),
            bytes
        );
        assert!(
            fixture(MAX_OCCURRENCES + 1, MAX_SOURCE_BYTES)
                .fixed_input(project())
                .is_err()
        );
        assert!(
            fixture(MAX_OCCURRENCES, MAX_SOURCE_BYTES + 1)
                .fixed_input(project())
                .is_err()
        );
    }

    #[test]
    fn translation_projection_preserves_absent_display_and_exact_values_and_rejects_changed_order()
    {
        let mut projection = fixture(2, 4);
        projection.entries[0].text = "".into();
        let input = projection.fixed_input(project()).unwrap();
        let restored = TranslationProjection::from_input(&input).unwrap();
        assert_eq!(restored.entries[0].native_value(), "MiX0");
        assert_eq!(
            restored.entries[0]
                .entry(0, restored.file.artifact_id)
                .key_byte_range,
            None
        );
        // FixedInput sorts random item IDs; position does not identify ordinal 0.
        let empty_entry = input
            .envelope()
            .items
            .iter()
            .find(|item| item.payload.as_u64() == Some(0))
            .unwrap();
        assert_eq!(
            restored
                .output(&input, empty_entry.item_id)
                .unwrap()
                .entry
                .unwrap()
                .text,
            ""
        );
        let mut reordered = input.envelope().clone();
        let first = reordered.items[0].payload.clone();
        reordered.items[0].payload = reordered.items[1].payload.clone();
        reordered.items[1].payload = first;
        assert!(
            TranslationProjection::from_input(&FixedInput::capture(reordered).unwrap()).is_err()
        );
        let empty = fixture(0, 2).fixed_input(project()).unwrap();
        assert_eq!(empty.envelope().items.len(), 1);
        assert!(
            TranslationProjection::from_input(&empty)
                .unwrap()
                .output(&empty, empty.envelope().items[0].item_id)
                .unwrap()
                .entry
                .is_none()
        );
    }
}
