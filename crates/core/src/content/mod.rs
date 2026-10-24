//! Immutable source bundles, native identity evidence and read-only projections.
mod build;
mod import_start;
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
mod legacy_build;
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
mod legacy_source;
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
mod legacy_translation;
mod maintenance_hook;
mod plugin_translation;
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
mod smapi;
mod translation;
mod translation_projection;
pub use maintenance_hook::*;
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub mod webvtt;
pub use crate::persistence::content::SourceAdoptionHandler;
pub use import_start::*;
pub use build::{BUILD_OPERATION, BuildSourceFile, artifact_digest};
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub use legacy_build::{
    BUILD_CAPABILITY, BUILD_CAPABILITY_VERSION, BUILDER_VERSION, BuildEntry, BuildLocale,
    BuildManifest, BuildOutput, BuildRunner, VALIDATOR_VERSION, WebvttBuildRunner, build_locale,
    declared_locale, validate_build_output,
};
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
use legacy_source::{BuiltinOccurrence, project_builtin};
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub use legacy_source::{
    CAPABILITY, CAPABILITY_VERSION, FORMAT, IDENTITY_POLICY, IntegrationDescriptor, MANIFEST_PATH,
    MAX_MANIFEST_BYTES, PLUGIN_ID, PLUGIN_VERSION, SOURCE_PATH, extract, integration_descriptor,
    validate_builtin_output, webvtt_descriptor,
};
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub use legacy_translation::{TranslationBundle, TranslationRunner, extract_translation};
pub use plugin_translation::{
    MAX_TRANSLATION_INPUT_BYTES, MAX_TRANSLATION_RESULT_BYTES, PluginTranslationSettings,
    TRANSLATION_EXTRACTION_OPERATION, plugin_translation_input, validate_plugin_translation_output,
};
#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub use smapi::{SourceRunner, WebvttSourceRunner};
pub fn supported_identity_policy(policy: &str) -> bool {
    // This is the captured generic revision-policy digest, not a domain allowlist.
    policy.len() == 64
        && policy
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub use translation::{
    TRANSLATION_OPERATION, TranslationEntry, TranslationOutput, validate_translation_output,
};
pub use translation_projection::{
    TRANSLATION_PROJECTION_CAPABILITY, TranslationProjectionRunner, TranslationProjectionStartRead,
};
pub(crate) use translation_projection::{
    TranslationProjection, is_translation_projection, validate_projected_translation_output,
};

use crate::{
    Locale, ProjectId,
    execution::{codec, *},
};
use serde::{Deserialize, Serialize};
use tsumugi_plugin_sdk as sdk;

pub const OPERATION: &str = "source-import";
/// Bounded captured text, also enforced by the checked translation projection.
pub const MAX_SOURCE_BYTES: usize = 128 * 1024;
/// Complete serialized captured source material retained by the project store.
/// Execution inputs and combined semantic-check inputs have separate budgets.
pub const MAX_CAPTURED_SOURCE_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_OCCURRENCES: usize = 2000;
pub const MAX_SOURCE_RESULT_BYTES: usize = MAX_RESULT_BYTES;
pub const MAX_CONTENT_PAGE_BYTES: usize = 256 * 1024;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;

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
    pub profile: sdk::ContractRef,
    pub files: Vec<CapturedFile>,
}
impl SourceBundle {
    /// Capture declared material without invoking an embedded domain parser.
    /// Provider identity comes from the independently selected package binding;
    /// logical paths, roles and byte limits come from its captured SDK resource.
    pub fn capture_declared(
        binding: &sdk::SourceImportBinding,
        materials: Vec<Vec<u8>>,
        language: &str,
    ) -> Result<Self, ExecutionError> {
        let declaration = &binding.declaration;
        binding.validate().map_err(source_contract_error)?;
        if materials.len() != declaration.materials.len() {
            return Err(invalid("source-import-binding"));
        }
        let locale = Locale::parse(language).map_err(|_| invalid("language-required"))?;
        let files = declaration
            .materials
            .iter()
            .zip(materials)
            .map(|(declared, bytes)| {
                if bytes.len() > declared.max_bytes as usize {
                    return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
                }
                CapturedFile::new(&declared.logical_path, &declared.role, &bytes)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut bundle = Self {
            version: 1,
            plugin_id: binding.extractor.provider.plugin.id.clone(),
            plugin_version: binding.extractor.provider.plugin.version.clone(),
            set_id: ExecutionId::new(),
            manifest_digest: String::new(),
            source_language: locale.as_str().into(),
            language_evidence: "user-declared".into(),
            format_id: declaration.profile.id.clone(),
            format_version: declaration.profile.schema_version,
            profile: declaration.profile.clone(),
            files,
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
                &self.profile,
                refs,
            ),
            MAX_INPUT_BYTES,
        )?))
    }
    /// Generic captured-material validation. Domain file requirements belong to
    /// the selected extractor, not to this project capture projection.
    pub fn validate(&self) -> Result<(), ExecutionError> {
        let source = self.source_input();
        source.validate().map_err(source_contract_error)?;
        let _ = codec::encode(&source, MAX_CAPTURED_SOURCE_INPUT_BYTES)?;
        let locale =
            Locale::parse(&self.source_language).map_err(|_| invalid("language-required"))?;
        if locale.as_str() != self.source_language
            || self.version != 1
            || self.format_id != self.profile.id
            || self.format_version != self.profile.schema_version
            || self.language_evidence != "user-declared"
            || self.calculate_digest()? != self.manifest_digest
            || self
                .files
                .iter()
                .any(|file| file.byte_length as usize != file.utf8.len())
        {
            return Err(invalid("invalid-structure"));
        }
        Ok(())
    }
    pub fn source_input(&self) -> sdk::SourceExtractionInput {
        sdk::SourceExtractionInput {
            profile: self.profile.clone(),
            source_set_id: self.set_id.to_string(),
            source_language: self.source_language.clone(),
            artifacts: self
                .files
                .iter()
                .map(|file| sdk::CapturedTextArtifact {
                    id: file.artifact_id.to_string(),
                    logical_path: file.logical_path.clone(),
                    role: file.role.clone(),
                    sha256: file.sha256.clone(),
                    utf8: file.utf8.clone(),
                })
                .collect(),
        }
    }
    /// Capture a source operation from independently selected producer/checker
    /// declarations. Neither the input data nor a later result may select them.
    pub fn fixed_plugin_input(
        &self,
        project: ProjectId,
        binding: PluginExecutionBinding,
        settings: SourceSettings,
    ) -> Result<FixedInput, ExecutionError> {
        self.validate()?;
        let capability = binding.capability.declaration.contract.id.clone();
        let version = binding.capability_version();
        self.capture_input(project, &capability, &version, Some(binding), settings)
    }
    fn capture_input(
        &self,
        project: ProjectId,
        capability: &str,
        version: &str,
        plugin: Option<PluginExecutionBinding>,
        settings: SourceSettings,
    ) -> Result<FixedInput, ExecutionError> {
        let item = InputItem::new(
            Scope {
                kind: "source".into(),
                id: self.set_id.to_string(),
                locale: None,
            },
            value(&self.source_input())?,
            vec![],
        );
        let mut envelope = InputEnvelope::new(project, OPERATION, capability, version, vec![item])?;
        envelope.settings = value(&settings)?;
        envelope.plugin = plugin;
        envelope.limits.max_result_bytes = MAX_SOURCE_RESULT_BYTES as u32;
        let input = FixedInput::capture(envelope)?;
        let _ = Self::from_input(&input)?;
        Ok(input)
    }
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let e = input.envelope();
        #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
        if e.plugin.is_none() {
            return Err(failure(ErrorCode::InvalidInput, "source-plugin-required"));
        }
        if e.operation != OPERATION
            || e.items.len() != 1
            || e.units.len() != 1
            || e.units[0].item_ids != vec![e.items[0].item_id]
            || !e.items[0].dependencies.is_empty()
        {
            return Err(invalid("source-input"));
        }
        let source: sdk::SourceExtractionInput = from_value(&e.items[0].payload)?;
        source.validate().map_err(source_contract_error)?;
        let settings = SourceSettings::from_input(input)?;
        let (plugin_id, plugin_version) = if let Some(binding) = &e.plugin {
            binding.validate_project_or_attempt()?;
            let declaration = &binding.capability.declaration;
            if binding.profile.as_ref() != Some(&source.profile)
                || declaration.input_schema != sdk::source_extraction_input_contract()
                || declaration.output_schema != sdk::content_exchange_contract()
                || declaration.error_schema != sdk::source_extraction_error_contract()
                || settings.checker.is_none()
            {
                return Err(invalid("source-binding"));
            }
            (
                binding.capability.provider.plugin.id.clone(),
                binding.capability.provider.plugin.version.clone(),
            )
        } else {
            #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
            {
                legacy_source::input_provider(e, &source, &settings)?
            }
            #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
            {
                return Err(failure(ErrorCode::InvalidInput, "source-plugin-required"));
            }
        };
        // IDs here were allocated by Core's capture owner. SDK transport IDs
        // remain opaque; this project capture boundary requires its UUIDs.
        let set_id = ExecutionId::parse(&source.source_set_id)?;
        if e.items[0].scope
            != (Scope {
                kind: "source".into(),
                id: set_id.to_string(),
                locale: None,
            })
        {
            return Err(invalid("source-scope"));
        }
        let files = source
            .artifacts
            .iter()
            .map(|artifact| {
                Ok(CapturedFile {
                    artifact_id: ExecutionId::parse(&artifact.id)?,
                    logical_path: artifact.logical_path.clone(),
                    role: artifact.role.clone(),
                    byte_length: u32::try_from(artifact.utf8.len())
                        .map_err(|_| invalid("source-bytes"))?,
                    sha256: artifact.sha256.clone(),
                    utf8: artifact.utf8.clone(),
                })
            })
            .collect::<Result<Vec<_>, ExecutionError>>()?;
        let mut bundle = Self {
            version: 1,
            plugin_id,
            plugin_version,
            set_id,
            manifest_digest: String::new(),
            source_language: source.source_language,
            language_evidence: "user-declared".into(),
            format_id: source.profile.id.clone(),
            format_version: source.profile.schema_version,
            profile: source.profile,
            files,
        };
        bundle.manifest_digest = bundle.calculate_digest()?;
        bundle.validate()?;
        #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
        if e.plugin.is_none() {
            bundle.validate_builtin_capture()?;
        }
        Ok(bundle)
    }
}

#[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
pub(crate) fn contract_ref(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn source_contract_error(error: sdk::ContractError) -> ExecutionError {
    if error.code == sdk::ContractErrorCode::LimitExceeded {
        failure(ErrorCode::LimitExceeded, "source-contract-limit")
    } else {
        invalid("source-contract")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct SourceReviewBinding {
    pub declaration: sdk::ReviewDeclaration,
    pub checker: PluginExecutionBinding,
}
impl SourceReviewBinding {
    /// Preserve the selected package rules and independently captured runtime.
    /// Capturing this metadata grants no checker execution or project approval.
    pub fn capture(
        binding: &sdk::ReviewBinding,
        checker: &PluginExecutionBinding,
    ) -> Result<Self, ExecutionError> {
        binding.validate().map_err(source_contract_error)?;
        checker.validate_project_or_attempt()?;
        if checker.capability != binding.checker
            || checker.profile.as_ref() != Some(&binding.declaration.profile)
        {
            return Err(invalid("source-review-binding"));
        }
        Ok(Self {
            declaration: binding.declaration.clone(),
            checker: checker.clone(),
        })
    }
    fn validate(
        &self,
        source: &sdk::SourceExtractionInput,
        producer: &PluginExecutionBinding,
    ) -> Result<(), ExecutionError> {
        self.checker.validate_project_or_attempt()?;
        sdk::ReviewBinding {
            declaration: self.declaration.clone(),
            checker: self.checker.capability.clone(),
        }
        .validate()
        .map_err(source_contract_error)?;
        if self.declaration.profile != source.profile
            || self.checker.profile.as_ref() != Some(&source.profile)
            || self.checker.capability.provider.plugin != producer.capability.provider.plugin
            || self.checker.capability.provider.package_digest
                != producer.capability.provider.package_digest
        {
            return Err(invalid("source-review-binding"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSettings {
    /// Original native submission evidence, never a plugin binding or grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_start: Option<SourceImportStart>,
    pub revision_policy: sdk::SourceRevisionPolicy,
    pub checker: Option<PluginExecutionBinding>,
    pub semantic_rules: Vec<sdk::ContractRef>,
    /// Null is reserved for the explicit legacy desktop channel and fixtures.
    /// Plugin adoption requires the fixed package Review rules and runtime.
    pub review: Option<SourceReviewBinding>,
}
impl SourceSettings {
    pub fn from_input(input: &FixedInput) -> Result<Self, ExecutionError> {
        let settings: Self = from_value(&input.envelope().settings)?;
        settings
            .revision_policy
            .validate()
            .map_err(source_contract_error)?;
        let source: sdk::SourceExtractionInput = from_value(
            &input
                .envelope()
                .items
                .first()
                .ok_or_else(|| invalid("source-input"))?
                .payload,
        )?;
        if settings.revision_policy.profile != source.profile {
            return Err(invalid("source-policy"));
        }
        if let Some(review) = &settings.review {
            let producer = input
                .envelope()
                .plugin
                .as_ref()
                .ok_or_else(|| invalid("source-review-producer"))?;
            review.validate(&source, producer)?;
        } else {
            #[cfg(not(test))]
            if input.envelope().plugin.is_some() {
                return Err(failure(ErrorCode::InvalidInput, "source-review-required"));
            }
            #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
            return Err(failure(ErrorCode::InvalidInput, "source-review-required"));
        }
        if let Some(checker) = &settings.checker {
            checker.validate_project_or_attempt()?;
            let declaration = &checker.capability.declaration;
            if checker.profile.as_ref() != Some(&source.profile)
                || declaration.input_schema != sdk::source_extraction_check_input_contract()
                || declaration.output_schema != sdk::check_results_contract()
                || declaration.error_schema != sdk::source_extraction_error_contract()
                || settings.semantic_rules.is_empty()
                || settings.semantic_rules.len() > 32
                || settings
                    .semantic_rules
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != settings.semantic_rules.len()
                || settings.semantic_rules.iter().any(|rule| {
                    sdk::SourceRevisionPolicy {
                        profile: source.profile.clone(),
                        revision_basis: vec![rule.clone()],
                    }
                    .validate()
                    .is_err()
                })
            {
                return Err(invalid("source-checker"));
            }
        } else {
            if input.envelope().plugin.is_some() {
                return Err(failure(ErrorCode::InvalidInput, "source-checker-required"));
            }
            #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
            if !settings.semantic_rules.is_empty() {
                return Err(invalid("builtin-source-rules"));
            }
            #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
            return Err(failure(ErrorCode::InvalidInput, "source-checker-required"));
        }
        if let Some(request) = &settings.native_start {
            import_start::validate_source_start(input, &source.source_language, request)?;
        }
        Ok(settings)
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
    pub key_byte_range: Option<[u32; 2]>,
    /// Derived UTF-8 coordinates for existing readers; original coordinates are
    /// retained in `source`, including their explicit encoding.
    pub value_byte_range: [u32; 2],
    /// Opaque digest of the exact captured revision policy, text, protected
    /// fragments and only the policy-selected domain blocks.
    pub identity_basis: String,
    pub operation_unit_id: String,
    pub operation_occurrence_id: String,
    pub operation_source_revision_id: String,
    pub source: sdk::SourceReference,
    pub native_identity: Option<sdk::NativeIdentityEvidence>,
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
    /// Complete proposal reconstructed from the immutable result owner.
    pub exchange: sdk::ContentExchange,
    pub revision_policy: sdk::SourceRevisionPolicy,
}

impl SourceOccurrence {
    /// Canonical matching values were already interpreted by the domain. Core
    /// compares their entire namespace/policy/value tuple without case folding.
    pub fn matching_identity(&self) -> Option<(&str, &sdk::ContractRef, &str)> {
        self.native_identity.as_ref().map(|identity| {
            (
                identity.namespace.as_str(),
                &identity.policy,
                identity.value.as_str(),
            )
        })
    }
    pub(crate) fn comparison_key(&self) -> Result<Option<String>, ExecutionError> {
        self.native_identity
            .as_ref()
            .map(|identity| {
                String::from_utf8(codec::encode(
                    &(&identity.namespace, &identity.policy, &identity.value),
                    MAX_INPUT_BYTES,
                )?)
                .map_err(|_| invalid("source-identity"))
            })
            .transpose()
    }
    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        self.matching_identity().is_some() && self.matching_identity() == other.matching_identity()
    }
}

/// Decode and associate a captured proposal without invoking a domain parser.
/// This is deliberately insufficient to mark an execution result semantically
/// Valid; the store-owned validation proof remains a separate requirement.
pub fn validate_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<SourceOutput, ExecutionError> {
    let bundle = SourceBundle::from_input(input)?;
    if input.envelope().plugin.is_some() != result.envelope().plugin.is_some() {
        return Err(invalid("source-result-plugin"));
    }
    if result.envelope().item_id != input.envelope().items[0].item_id
        || result.envelope().outcome != ExecutionState::Succeeded
    {
        return Err(invalid("source-result"));
    }
    let exchange: sdk::ContentExchange = if let Some(evidence) = &result.envelope().plugin {
        let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
            return Err(invalid("source-result"));
        };
        if output.schema != sdk::content_exchange_contract() {
            return Err(invalid("source-result-schema"));
        }
        // Typed Serde sees the original bytes; Value is only an independently
        // checked result projection and cannot conceal duplicate typed fields.
        sdk::parse_content_exchange(output.utf8.as_bytes()).map_err(source_contract_error)?
    } else {
        #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
        {
            from_value(
                result
                    .envelope()
                    .output
                    .as_ref()
                    .ok_or_else(|| invalid("source-result"))?,
            )?
        }
        #[cfg(not(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain")))]
        return Err(invalid("source-result-plugin"));
    };
    let output = project_source_output(
        &bundle,
        exchange,
        SourceSettings::from_input(input)?.revision_policy,
    )?;
    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    let mut output = output;
    #[cfg(any(test, feature = "execution-test-host", feature = "legacy-desktop-domain"))]
    if input.envelope().plugin.is_none() {
        output.diagnostics = result
            .envelope()
            .diagnostic
            .iter()
            .map(|diagnostic| diagnostic.code.clone())
            .collect();
    }
    Ok(output)
}

pub(crate) fn project_source_output(
    bundle: &SourceBundle,
    exchange: sdk::ContentExchange,
    policy: sdk::SourceRevisionPolicy,
) -> Result<SourceOutput, ExecutionError> {
    sdk::validate_source_extraction(&bundle.source_input(), &exchange)
        .map_err(source_contract_error)?;
    policy.validate().map_err(source_contract_error)?;
    if policy.profile != exchange.profile {
        return Err(invalid("source-policy"));
    }
    let indexed_occurrences: std::collections::BTreeMap<_, _> = exchange
        .units
        .iter()
        .flat_map(|unit| {
            unit.occurrences
                .iter()
                .map(move |occurrence| (&occurrence.id, (unit, occurrence)))
        })
        .collect();
    let mut snapshot_blocks = Vec::new();
    let mut unit_blocks = std::collections::BTreeMap::<&str, Vec<_>>::new();
    for block in &exchange.domain_blocks {
        if !policy.revision_basis.contains(&block.schema) {
            continue;
        }
        let basis = (&block.schema, &block.payload_utf8);
        match &block.target {
            sdk::ContentTarget::Snapshot => snapshot_blocks.push(basis),
            sdk::ContentTarget::Unit { id } => {
                unit_blocks.entry(id.as_str()).or_default().push(basis)
            }
            sdk::ContentTarget::Occurrence { id } => {
                let (unit, _) = indexed_occurrences
                    .get(id)
                    .ok_or_else(|| invalid("source-order"))?;
                unit_blocks.entry(unit.id.as_str()).or_default().push(basis);
            }
        }
    }
    let mut unit_bases = std::collections::BTreeMap::new();
    for unit in &exchange.units {
        let mut blocks = snapshot_blocks.clone();
        blocks.extend(unit_blocks.remove(unit.id.as_str()).unwrap_or_default());
        // Preserve the previous exact multiset and ordering of schema/payload
        // pairs. Operation-local target IDs never enter the revision basis.
        blocks.sort();
        unit_bases.insert(
            unit.id.as_str(),
            codec::digest(&codec::encode(
                &(&policy, &unit.text, &unit.protected_fragments, blocks),
                MAX_SOURCE_RESULT_BYTES,
            )?),
        );
    }
    let mut occurrences = Vec::new();
    for (ordinal, occurrence_id) in exchange.order.iter().enumerate() {
        let (unit, occurrence) = indexed_occurrences
            .get(occurrence_id)
            .ok_or_else(|| invalid("source-order"))?;
        let artifact = exchange
            .artifacts
            .iter()
            .find(|artifact| artifact.id == occurrence.source.artifact_id)
            .ok_or_else(|| invalid("source-artifact"))?;
        let source_range = sdk::convert_text_range(
            &artifact.utf8,
            occurrence.source.range,
            sdk::TextEncoding::Utf8Byte,
        )
        .map_err(source_contract_error)?;
        let key_byte_range = occurrence
            .native_identity
            .as_ref()
            .and_then(|identity| identity.display.source.as_ref())
            .map(|reference| {
                let artifact = exchange
                    .artifacts
                    .iter()
                    .find(|artifact| artifact.id == reference.artifact_id)
                    .ok_or_else(|| invalid("source-display"))?;
                let range = sdk::convert_text_range(
                    &artifact.utf8,
                    reference.range,
                    sdk::TextEncoding::Utf8Byte,
                )
                .map_err(source_contract_error)?;
                // The legacy reader's key range has one artifact column. Keep
                // absence explicit when the display evidence is in another one.
                Ok::<Option<[u32; 2]>, ExecutionError>(
                    (reference.artifact_id == occurrence.source.artifact_id)
                        .then_some([range.start, range.end]),
                )
            })
            .transpose()?
            .flatten();
        let identity_basis = unit_bases[unit.id.as_str()].clone();
        let namespace = occurrence
            .native_identity
            .as_ref()
            .map(|identity| identity.namespace.clone())
            .unwrap_or_default();
        let key = occurrence
            .native_identity
            .as_ref()
            .map(|identity| identity.display.value.clone())
            .unwrap_or_else(|| occurrence.id.clone());
        occurrences.push(SourceOccurrence {
            ordinal: ordinal as u32,
            artifact_id: ExecutionId::parse(&occurrence.source.artifact_id)?,
            namespace,
            key,
            text: unit.text.clone(),
            key_byte_range,
            value_byte_range: [source_range.start, source_range.end],
            identity_basis,
            operation_unit_id: unit.id.clone(),
            operation_occurrence_id: occurrence.id.clone(),
            operation_source_revision_id: unit.source_revision_id.clone(),
            source: occurrence.source.clone(),
            native_identity: occurrence.native_identity.clone(),
        });
    }
    Ok(SourceOutput {
        version: 1,
        set_id: bundle.set_id,
        manifest_digest: bundle.manifest_digest.clone(),
        format_id: bundle.format_id.clone(),
        format_version: bundle.format_version,
        identity_policy: codec::digest(&codec::encode(&policy, MAX_INPUT_BYTES)?),
        namespace: occurrences
            .first()
            .map(|row| row.namespace.clone())
            .unwrap_or_default(),
        source_language: bundle.source_language.clone(),
        coverage: bundle
            .files
            .iter()
            .map(|file| FileCoverage {
                artifact_id: file.artifact_id,
                logical_path: file.logical_path.clone(),
                role: file.role.clone(),
                sha256: file.sha256.clone(),
            })
            .collect(),
        occurrences,
        diagnostics: vec![],
        exchange,
        revision_policy: policy,
    })
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
    #[serde(deserialize_with = "required_maintenance_hook")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(schema_with = "maintenance_hook_schema")
    )]
    pub maintenance_hook: Option<SourceMaintenanceHookActivation>,
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
pub(crate) mod tests;
