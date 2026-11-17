//! Pure per-entry EX projection of an independently checked complete proposal.
//! Original plugin coordinates and native evidence remain in the producer ledger.
use super::*;
use std::sync::{Arc, Mutex, OnceLock};

pub const TRANSLATION_PROJECTION_CAPABILITY: &str = "core.translation-project";
const VERSION: &str = "1";
pub(crate) const MAX_PAIRED_PROJECTION_INPUT_BYTES: usize =
    sdk::MAX_PAIRED_TRANSLATION_RESULT_BYTES + crate::execution::MAX_INPUT_BYTES;
pub(crate) const MAX_PAIRED_PROJECTION_ATTEMPT_BYTES: usize = MAX_PLUGIN_RESULT_BYTES;

/// Only this explicitly versioned, non-plugin projection has larger budgets.
pub(crate) fn is_paired_projection(envelope: &InputEnvelope) -> bool {
    envelope.operation == TRANSLATION_OPERATION
        && envelope.capability_id == TRANSLATION_PROJECTION_CAPABILITY
        && envelope.capability_version == VERSION
        && envelope.plugin.is_none()
        && envelope
            .settings
            .get("version")
            .and_then(serde_json::Value::as_u64)
            == Some(2)
}

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

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

// Ordinal and Core file identities are shared by the containing projection.
// The original five-field tuple preserves the single-file encoding; paired
// projections add compact file indexes without repeating IDs in every entry.
// Original SDK source references remain untouched.
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
            key_artifact_id: None,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub file: Option<CapturedFile>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub files: Option<Vec<TranslationImportFile>>,
    // Value-file index and optional display-file index, in proposal order.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub entry_files: Option<Vec<(u32, Option<u32>)>>,
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
        artifact_ids: Option<&[ExecutionId]>,
    ) -> Result<Self, ExecutionError> {
        let proposal = validate_plugin_translation_output(producer, result)?;
        let paired = plugin_translation_input(producer)?
            .0
            .paired_source
            .is_some();
        if proposal.artifacts.is_empty()
            || (!paired && proposal.artifacts.len() != 1)
            || proposal.entries.len() > if paired { sdk::MAX_CONTENT_ITEMS } else { MAX_OCCURRENCES }
            || artifact_ids.is_some_and(|ids| ids.len() != proposal.artifacts.len())
        {
            return Err(invalid());
        }
        let mut files = Vec::with_capacity(proposal.artifacts.len());
        let mut legacy_file = None;
        for (index, artifact) in proposal.artifacts.iter().enumerate() {
            let file = CapturedFile::from_artifact(
                artifact,
                artifact_ids.map_or_else(ExecutionId::new, |ids| ids[index]),
            )?;
            if !paired && file.byte_length as usize > MAX_SOURCE_BYTES {
                return Err(ExecutionError::new(
                    ErrorCode::LimitExceeded,
                    "translation-file-budget",
                ));
            }
            files.push(TranslationImportFile::from(&file));
            if !paired {
                legacy_file = Some(file);
            }
        }
        let artifact_indexes: std::collections::BTreeMap<_, _> = proposal
            .artifacts
            .iter()
            .enumerate()
            .map(|(i, artifact)| (artifact.id(), i))
            .collect();
        let indexed: std::collections::BTreeMap<_, _> = proposal
            .entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect();
        let mut entries = Vec::with_capacity(proposal.order.len());
        let mut entry_files = Vec::with_capacity(proposal.order.len());
        for id in &proposal.order {
            let imported = indexed.get(id.as_str()).ok_or_else(invalid)?;
            let index = *artifact_indexes
                .get(imported.source.artifact_id.as_str())
                .ok_or_else(invalid)?;
            let range = project_validated_range(&proposal.artifacts[index], imported.source.range)
                .map_err(|_| invalid())?;
            let key_source = imported
                .native_identity
                .display
                .source
                .as_ref()
                .map(|source| {
                    let key_index = *artifact_indexes
                        .get(source.artifact_id.as_str())
                        .ok_or_else(invalid)?;
                    if !paired && key_index != index {
                        return Err(invalid());
                    }
                    Ok((
                        key_index as u32,
                        project_validated_range(&proposal.artifacts[key_index], source.range)
                            .map_err(|_| invalid())?,
                    ))
                })
                .transpose()?;
            entries.push(ProjectedTranslationEntry {
                native_value: imported.native_identity.value.clone(),
                native_key: imported.native_identity.display.value.clone(),
                text: imported.text.clone(),
                key_byte_range: key_source.map(|(_, range)| range),
                value_byte_range: range,
            });
            entry_files.push((index as u32, key_source.map(|(index, _)| index)));
        }
        Ok(Self {
            version: if paired { 2 } else { 1 },
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
            file: legacy_file,
            files: paired.then_some(files),
            entry_files: paired.then_some(entry_files),
            entries,
        })
    }

    pub(crate) fn files(&self) -> Vec<TranslationImportFile> {
        self.files.clone().unwrap_or_else(|| {
            vec![TranslationImportFile::from(
                self.file.as_ref().expect("validated legacy file"),
            )]
        })
    }

    pub(crate) fn entry(&self, ordinal: u32) -> TranslationEntry {
        let (artifact_id, key_artifact_id) = if let Some(files) = &self.files {
            let (value, key) = self
                .entry_files
                .as_ref()
                .expect("validated file references")[ordinal as usize];
            (
                files[value as usize].artifact_id,
                key.map(|i| files[i as usize].artifact_id),
            )
        } else {
            (
                self.file
                    .as_ref()
                    .expect("validated legacy file")
                    .artifact_id,
                None,
            )
        };
        let mut entry = self.entries[ordinal as usize].entry(ordinal, artifact_id);
        entry.key_artifact_id = key_artifact_id;
        entry
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
        if self.version == 2 {
            envelope.limits.max_attempt_result_bytes = MAX_PAIRED_PROJECTION_ATTEMPT_BYTES as u32;
        }
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
        if input.bytes().len()
            > if is_paired_projection(envelope) {
                MAX_PAIRED_PROJECTION_INPUT_BYTES
            } else {
                MAX_TRANSLATION_INPUT_BYTES
            }
        {
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
        match (
            projection.version,
            &projection.file,
            &projection.files,
            &projection.entry_files,
        ) {
            (1, Some(file), None, None) => {
                let bytes = file.bytes()?;
                if file.byte_length as usize != bytes.len()
                    || file.sha256 != codec::digest(bytes.as_ref())
                    || bytes.len() > MAX_SOURCE_BYTES
                    || envelope.limits.max_attempt_result_bytes as usize > MAX_ATTEMPT_RESULT_BYTES
                {
                    return Err(invalid());
                }
            }
            (2, None, Some(files), Some(refs)) => {
                let mut ids = std::collections::BTreeSet::new();
                let mut paths = std::collections::BTreeSet::new();
                if files.is_empty()
                    || files.len() > sdk::MAX_SOURCE_IMPORT_MATERIALS
                    || refs.len() != projection.entries.len()
                    || files
                        .iter()
                        .map(|file| file.byte_length as u64)
                        .sum::<u64>()
                        > sdk::MAX_MATERIAL_SET_BYTES as u64
                    || files.iter().any(|file| {
                        !ids.insert(file.artifact_id)
                            || !paths.insert(&file.logical_path)
                            || file.logical_path.is_empty()
                            || file.logical_path.len() > 1024
                            || file.role.is_empty()
                            || file.role.len() > 128
                            || !supported_identity_policy(&file.sha256)
                    })
                    || refs
                        .iter()
                        .zip(&projection.entries)
                        .any(|((value, key), entry)| {
                            let valid_range = |index: u32, [start, end]: [u32; 2]| {
                                files
                                    .get(index as usize)
                                    .is_some_and(|file| start <= end && end <= file.byte_length)
                            };
                            !valid_range(*value, entry.value_byte_range)
                                || match (key, entry.key_byte_range) {
                                    (Some(index), Some(range)) => !valid_range(*index, range),
                                    (None, None) => false,
                                    _ => true,
                                }
                        })
                {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
        if projection.entries.len() > if projection.version == 2 { sdk::MAX_CONTENT_ITEMS } else { MAX_OCCURRENCES }
            || envelope.items.len() != projection.entries.len().max(1)
            || Locale::parse(&projection.target_locale)
                .map_err(|_| invalid())?
                .as_str()
                != projection.target_locale
        {
            return Err(invalid());
        }
        let singleton_items: std::collections::BTreeSet<_> = envelope.units.iter()
            .filter_map(|unit| match unit.item_ids.as_slice() { [item] => Some(*item), _ => None })
            .collect();
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
                || !singleton_items.contains(&item.item_id)
            {
                return Err(invalid());
            }
        }
        if projection.entries.iter().any(|entry| {
            entry.text.len() > MAX_TEXT_BYTES
                || entry.native_value.len() > 1024
                || entry.native_key.len() > 1024
        }) {
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
        let entry = ordinal.map(|n| self.entry(n));
        let files = self.files();
        let file = entry.as_ref().map_or(&files[0], |entry| {
            files
                .iter()
                .find(|file| file.artifact_id == entry.artifact_id)
                .expect("validated file reference")
        });
        Ok(TranslationOutput {
            version: self.version,
            bundle_id: self.bundle_id,
            manifest_digest: input.digest().into(),
            file_digest: file.sha256.clone(),
            entry_count: self.entries.len() as u32,
            entry,
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
impl TranslationProjectionRunner {
    pub(crate) fn project_result(
        projection: &TranslationProjection,
        input: &FixedInput,
        item: ExecutionId,
        token: ExecutionId,
    ) -> Result<FixedResult, ExecutionError> {
        let output = projection.output(input, item).and_then(|output| value(&output));
        Self::capture_result(input, item, token, output)
    }

    fn capture_result(
        input: &FixedInput,
        item: ExecutionId,
        token: ExecutionId,
        output: Result<serde_json::Value, ExecutionError>,
    ) -> Result<FixedResult, ExecutionError> {
        let mut envelope = ResultEnvelope {
            plugin: None,
            project_id: input.envelope().project_id,
            attempt_id: input.envelope().attempt_id,
            item_id: item,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: token,
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
        FixedResult::capture(envelope, input, token)
    }
}

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
        let result = if cancellation.is_requested() {
            Self::capture_result(
                input,
                request.item_id,
                request.dispatch_token,
                Err(ExecutionError::new(ErrorCode::Cancelled, "cancelled")),
            )?
        } else {
            let projection = TranslationProjection::from_input(input)?;
            Self::project_result(&projection, input, request.item_id, request.dispatch_token)?
        };
        sender.send(result)
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
            file: Some(
                CapturedFile::new("i18n/zh.json", "translation", &vec![b'x'; raw_bytes]).unwrap(),
            ),
            files: None,
            entry_files: None,
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

    fn paired_fixture(count: usize) -> TranslationProjection {
        let mut projection = fixture(count, 4);
        projection.version = 2;
        let first = projection.file.take().unwrap();
        let second = CapturedFile::new("tables/zh.bin", "translation", b"data").unwrap();
        projection.files = Some(vec![(&first).into(), (&second).into()]);
        projection.entry_files = Some(vec![(1, Some(0)); count]);
        for entry in &mut projection.entries {
            entry.key_byte_range = Some([1, 3]);
        }
        projection
    }

    #[test]
    fn paired_projection_keeps_cross_file_coordinates_without_recapturing_bytes() {
        let projection = paired_fixture(2);
        let input = projection.fixed_input(project()).unwrap();
        assert!(input.envelope().settings.get("file").is_none());
        assert!(!input.bytes().windows(6).any(|window| window == b"base64"));
        let restored = TranslationProjection::from_input(&input).unwrap();
        assert_eq!(*restored, projection);
        let entry = restored.entry(0);
        let files = restored.files();
        assert_eq!(entry.artifact_id, files[1].artifact_id);
        assert_eq!(entry.key_artifact_id, Some(files[0].artifact_id));
        assert_eq!(entry.key_byte_range, Some([1, 3]));
        for mutate in 0..7 {
            let mut envelope = input.envelope().clone();
            match mutate {
                0 => envelope.settings["file"] = serde_json::Value::Null,
                1 => envelope.settings["entryFiles"] = serde_json::Value::Null,
                2 => envelope.settings["entryFiles"][0][0] = 2.into(),
                3 => envelope.settings["entryFiles"][0][1] = serde_json::Value::Null,
                4 => envelope.settings["files"][1]["byteLength"] = 0.into(),
                5 => {
                    envelope.settings["files"][1]["artifactId"] =
                        envelope.settings["files"][0]["artifactId"].clone()
                }
                _ => envelope.settings["version"] = 1.into(),
            }
            assert!(
                FixedInput::capture(envelope)
                    .and_then(|captured| TranslationProjection::from_input(&captured))
                    .is_err(),
                "mutation {mutate}"
            );
        }
        let empty = paired_fixture(0).fixed_input(project()).unwrap();
        let empty = TranslationProjection::from_input(&empty).unwrap();
        assert_eq!(empty.files().len(), 2);
        assert!(empty.entries.is_empty());
    }

    #[test]
    fn paired_projection_whole_input_and_results_have_scoped_budgets() {
        // Compact projection stress only; no claim of domain/plugin capacity.
        let mut projection = paired_fixture(MAX_OCCURRENCES);
        for entry in &mut projection.entries {
            entry.text = "a".repeat(3750);
        }
        let input = projection.fixed_input(project()).unwrap();
        assert!(input.bytes().len() > MAX_INPUT_BYTES);
        assert!(input.bytes().len() <= MAX_PAIRED_PROJECTION_INPUT_BYTES);
        let mut result_bytes = 0;
        for item in &input.envelope().items {
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
                    output: Some(value(&projection.output(&input, item.item_id).unwrap()).unwrap()),
                    diagnostic: None,
                },
                &input,
                token,
            )
            .unwrap();
            result_bytes += result.bytes().len();
        }
        assert!(result_bytes > MAX_ATTEMPT_RESULT_BYTES);
        assert!(result_bytes <= MAX_PAIRED_PROJECTION_ATTEMPT_BYTES);
        eprintln!(
            "paired projection: input={} results={} items=2000",
            input.bytes().len(),
            result_bytes
        );
        let mut unrelated = input.envelope().clone();
        unrelated.capability_id = "other-projection".into();
        assert!(FixedInput::capture(unrelated).is_err());
        let mut over = input.envelope().clone();
        over.limits.max_attempt_result_bytes = MAX_PAIRED_PROJECTION_ATTEMPT_BYTES as u32 + 1;
        assert!(FixedInput::capture(over).is_err());
        // Core's queue and projection enforce their own item limit in addition
        // to the SDK proposal limit. Keep this count boundary's text minimal.
        let mut maximum = paired_fixture(sdk::MAX_CONTENT_ITEMS);
        let maximum_input = maximum.fixed_input(project()).unwrap();
        assert_eq!(maximum_input.envelope().items.len(), sdk::MAX_CONTENT_ITEMS);
        assert_eq!(maximum_input.envelope().units.len(), sdk::MAX_CONTENT_ITEMS);
        assert_eq!(TranslationProjection::from_input(&maximum_input).unwrap().entries.len(), sdk::MAX_CONTENT_ITEMS);
        drop(maximum_input);
        maximum.entries.push(maximum.entries[0].clone());
        maximum.entry_files.as_mut().unwrap().push((1, Some(0)));
        assert_eq!(maximum.fixed_input(project()).unwrap_err().code, ErrorCode::LimitExceeded);
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
        assert_eq!(restored.entry(0).key_byte_range, None);
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
