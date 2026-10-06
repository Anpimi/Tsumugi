//! Former source-domain assembly retained only for execution test fixtures.
use super::*;

pub const CAPABILITY: &str = "stardew-smapi.extract";
pub const CAPABILITY_VERSION: &str = "1";
pub const FORMAT: &str = "smapi-i18n-flat";
pub const IDENTITY_POLICY: &str = "smapi-native-key/1";
pub const MAX_MANIFEST_BYTES: usize = 16 * 1024;
pub const MANIFEST_PATH: &str = "manifest.json";
pub const SOURCE_PATH: &str = "i18n/default.json";
pub const PLUGIN_ID: &str = "stardew-smapi";
pub const PLUGIN_VERSION: &str = "0.1.0";

pub fn extract(
    bundle: &SourceBundle,
    cancel: &Cancellation,
) -> Result<SourceOutput, ExecutionError> {
    if bundle.profile == contract_ref(webvtt::PROFILE) {
        webvtt::extract(bundle, cancel)
    } else {
        smapi::extract(bundle, cancel)
    }
}
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
            profile: contract_ref(webvtt::PROFILE),
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
            profile: contract_ref(FORMAT),
            files: vec![
                CapturedFile::new(MANIFEST_PATH, "companion", manifest)?,
                CapturedFile::new(SOURCE_PATH, "source", source)?,
            ],
        };
        bundle.manifest_digest = bundle.calculate_digest()?;
        bundle.validate()?;
        Ok(bundle)
    }
    /// File shape required only by the explicitly transitional interpreters.
    pub(crate) fn validate_builtin_capture(&self) -> Result<(), ExecutionError> {
        self.validate()?;
        let expected = if self.profile == contract_ref(webvtt::PROFILE) {
            vec![(webvtt::PATH, "source", MAX_SOURCE_BYTES)]
        } else if self.profile == contract_ref(FORMAT) {
            vec![
                (MANIFEST_PATH, "companion", MAX_MANIFEST_BYTES),
                (SOURCE_PATH, "source", MAX_SOURCE_BYTES),
            ]
        } else {
            return Err(invalid("builtin-source-profile"));
        };
        if self.files.len() != expected.len()
            || self
                .files
                .iter()
                .zip(expected)
                .any(|(file, (path, role, limit))| {
                    file.logical_path != path || file.role != role || file.utf8.len() > limit
                })
            || self.files.iter().map(|file| file.utf8.len()).sum::<usize>() > MAX_SOURCE_BYTES
        {
            return Err(invalid("builtin-source-files"));
        }
        Ok(())
    }
    /// Explicit transitional built-in assembly. It never supplies a checker
    /// selection or a plugin binding and must receive real domain validation.
    pub fn fixed_input(&self, project: ProjectId) -> Result<FixedInput, ExecutionError> {
        self.validate()?;
        let policy = builtin_revision_policy(&self.profile)?;
        let settings = SourceSettings {
            revision_policy: policy,
            checker: None,
            semantic_rules: vec![],
        };
        self.capture_input(
            project,
            self.capability(),
            CAPABILITY_VERSION,
            None,
            settings,
        )
    }
}

fn builtin_revision_policy(
    profile: &sdk::ContractRef,
) -> Result<sdk::SourceRevisionPolicy, ExecutionError> {
    let revision_basis = if *profile == contract_ref(webvtt::PROFILE) {
        vec![contract_ref("webvtt.cue-basis")]
    } else if *profile == contract_ref(FORMAT) {
        vec![]
    } else {
        return Err(invalid("builtin-source-profile"));
    };
    Ok(sdk::SourceRevisionPolicy {
        profile: profile.clone(),
        revision_basis,
    })
}

// Only the transitional built-in interpreters construct this private data.
// These domain ranges are not the generic adoption or persistence contract.
pub(crate) struct BuiltinOccurrence {
    pub ordinal: u32,
    pub artifact_id: ExecutionId,
    pub namespace: String,
    pub key: String,
    pub canonical_key: String,
    pub text: String,
    pub key_byte_range: [u32; 2],
    pub value_byte_range: [u32; 2],
    pub policy: sdk::ContractRef,
    pub basis: Option<(sdk::ContractRef, String)>,
}
pub(crate) fn project_builtin(
    bundle: &SourceBundle,
    rows: Vec<BuiltinOccurrence>,
    diagnostics: Vec<String>,
) -> Result<SourceOutput, ExecutionError> {
    let mut exchange = sdk::ContentExchange {
        profile: bundle.profile.clone(),
        source_set_id: bundle.set_id.to_string(),
        source_language: bundle.source_language.clone(),
        artifacts: bundle.source_input().artifacts,
        units: vec![],
        order: vec![],
        relations: vec![],
        domain_blocks: vec![],
    };
    for row in rows {
        let unit_id = format!("unit-{}", row.ordinal);
        let occurrence_id = format!("occurrence-{}", row.ordinal);
        let source = sdk::SourceReference {
            artifact_id: row.artifact_id.to_string(),
            range: sdk::TextRange {
                encoding: sdk::TextEncoding::Utf8Byte,
                start: row.value_byte_range[0],
                end: row.value_byte_range[1],
            },
        };
        let identity_source = sdk::SourceReference {
            artifact_id: row.artifact_id.to_string(),
            range: sdk::TextRange {
                encoding: sdk::TextEncoding::Utf8Byte,
                start: row.key_byte_range[0],
                end: row.key_byte_range[1],
            },
        };
        exchange.units.push(sdk::ContentUnit {
            id: unit_id,
            source_revision_id: format!("source-{}", row.ordinal),
            text: row.text,
            occurrences: vec![sdk::ContentOccurrence {
                id: occurrence_id.clone(),
                source,
                native_identity: Some(sdk::NativeIdentityEvidence {
                    namespace: row.namespace,
                    value: row.canonical_key,
                    policy: row.policy,
                    display: sdk::NativeIdentityDisplay {
                        value: row.key,
                        source: Some(identity_source),
                    },
                }),
            }],
            protected_fragments: vec![],
        });
        exchange.order.push(occurrence_id.clone());
        if let Some((schema, payload_utf8)) = row.basis {
            exchange.domain_blocks.push(sdk::DomainBlock {
                target: sdk::ContentTarget::Occurrence { id: occurrence_id },
                schema,
                handling: sdk::ExtensionHandling::Required,
                payload_utf8,
            });
        }
    }
    let mut output =
        project_source_output(bundle, exchange, builtin_revision_policy(&bundle.profile)?)?;
    output.diagnostics = diagnostics;
    Ok(output)
}

/// The explicit built-in transitional channel still requires its actual domain
/// interpreter. Plugin inputs can never fall back to this validator.
pub fn validate_builtin_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<SourceOutput, ExecutionError> {
    if input.envelope().plugin.is_some() || SourceSettings::from_input(input)?.checker.is_some() {
        return Err(failure(
            ErrorCode::Unauthorized,
            "builtin-source-validation",
        ));
    }
    let actual = validate_output(input, result)?;
    let expected = extract(&SourceBundle::from_input(input)?, &Cancellation::default())?;
    if actual.exchange != expected.exchange || actual.diagnostics != expected.diagnostics {
        return Err(invalid("invalid-structure"));
    }
    Ok(actual)
}

pub(super) fn input_provider(
    e: &InputEnvelope,
    source: &sdk::SourceExtractionInput,
    settings: &SourceSettings,
) -> Result<(String, String), ExecutionError> {
    if settings.checker.is_some() || e.capability_version != CAPABILITY_VERSION {
        return Err(invalid("builtin-source-binding"));
    }
    let plugin = match e.capability_id.as_str() {
        CAPABILITY if source.profile == contract_ref(FORMAT) => PLUGIN_ID,
        webvtt::EXTRACT if source.profile == contract_ref(webvtt::PROFILE) => webvtt::PLUGIN,
        _ => return Err(invalid("builtin-source-binding")),
    };
    if settings.revision_policy != builtin_revision_policy(&source.profile)? {
        return Err(invalid("builtin-source-policy"));
    }
    Ok((plugin.into(), PLUGIN_VERSION.into()))
}
