//! Fixed build data, explicit options and actual artifact checks. Release eligibility,
//! execution permission, filesystem access and publication remain host-owned.
use crate::validation::{encoded_limit, name, opaque_id, reference, unique};
use crate::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
mod configuration;
pub use configuration::*;

pub const MAX_BUILD_ARTIFACTS: usize = 32;
pub const MAX_BUILD_DECLARATION_BYTES: usize = 32 * 1024;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
pub fn build_input_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.build-input")
    }
}
pub fn artifact_set_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.artifact-set")
    }
}
pub fn artifact_check_input_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.artifact-check-input")
    }
}
pub fn build_declaration_contract() -> ContractRef {
    ContractRef {
        schema_version: 2,
        ..contract("tsumugi.build-declaration")
    }
}
pub fn build_error_contract() -> ContractRef {
    contract("tsumugi.build-error")
}
fn invalid(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::InvalidDeclaration, field)
}
fn mismatch(field: &str) -> ContractError {
    ContractError::at(ContractErrorCode::ResultMismatch, field)
}
fn language(value: &str) -> Result<(), ContractError> {
    crate::validation::language_label(value, "build.targetLanguage")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildOutputLimits {
    #[cfg_attr(feature = "schema", schemars(schema_with = "artifact_count_schema"))]
    pub max_artifacts: u32,
    #[cfg_attr(feature = "schema", schemars(schema_with = "artifact_bytes_schema"))]
    pub max_total_bytes: u32,
}
#[cfg(feature = "schema")]
fn artifact_count_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":1, "maximum":MAX_BUILD_ARTIFACTS})
}
#[cfg(feature = "schema")]
fn artifact_bytes_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":1, "maximum":MAX_MATERIAL_SET_BYTES})
}
impl BuildOutputLimits {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.max_artifacts == 0
            || self.max_artifacts as usize > MAX_BUILD_ARTIFACTS
            || self.max_total_bytes == 0
            || self.max_total_bytes as usize > MAX_MATERIAL_SET_BYTES
        {
            return Err(invalid("build.outputLimits"));
        }
        Ok(())
    }
}

/// One already decided text per source unit, even when it has many occurrences.
/// No candidate selection, review decision or project write handle is supplied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildTarget {
    pub unit_id: String,
    pub source_revision_id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildInput {
    pub source: ContentExchange,
    pub target_language: String,
    pub targets: Vec<BuildTarget>,
    /// Exact domain configuration; an empty collection means no configuration.
    pub configuration: Vec<EncodedPayload>,
    /// Complete authorized relative output paths, fixed before dispatch.
    pub output_paths: Vec<String>,
    /// Captured by the trusted planner, never replaced by returned artifacts.
    pub output_limits: BuildOutputLimits,
}
impl BuildInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.validate_with_limit(MAX_MATERIAL_INVOCATION_BYTES)
    }

    fn validate_with_limit(&self, limit: usize) -> Result<(), ContractError> {
        self.source.validate()?;
        language(&self.target_language)?;
        self.output_limits.validate()?;
        validate_build_output_paths(self.output_paths.iter().map(String::as_str))?;
        if self.output_paths.len() > self.output_limits.max_artifacts as usize {
            return Err(invalid("build.outputPaths"));
        }
        if self.source.units.is_empty() || self.targets.len() != self.source.units.len() {
            return Err(invalid("build.targets.coverage"));
        }
        unique(
            self.targets.iter().map(|t| &t.unit_id),
            "build.targets.unitId",
        )?;
        let units: BTreeMap<_, _> = self.source.units.iter().map(|u| (&u.id, u)).collect();
        for target in &self.targets {
            opaque_id(&target.unit_id, "build.targets.unitId")?;
            opaque_id(&target.source_revision_id, "build.targets.sourceRevisionId")?;
            if target.text.len() > MAX_TEXT_BYTES {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    "build.targets.text",
                ));
            }
            if units
                .get(&target.unit_id)
                .is_none_or(|u| u.source_revision_id != target.source_revision_id)
            {
                return Err(mismatch("build.targets.sourceRevisionId"));
            }
        }
        if self.configuration.len() > 32 {
            return Err(invalid("build.configuration"));
        }
        unique(
            self.configuration.iter().map(|c| &c.schema),
            "build.configuration.schema",
        )?;
        for configuration in &self.configuration {
            configuration.validate()?;
        }
        encoded_limit(self, limit.min(MAX_MATERIAL_INVOCATION_BYTES), "buildInput")
    }
}

/// Actual text or binary output. Exact bytes do not establish domain conformance
/// or release eligibility. Logical paths grant no filesystem authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ArtifactSet {
    pub profile: ContractRef,
    pub source_set_id: String,
    pub target_language: String,
    pub artifacts: Vec<CapturedArtifact>,
}
impl ArtifactSet {
    pub fn validate(&self) -> Result<(), ContractError> {
        self.validate_and_count_bytes(MAX_ARTIFACT_SET_BYTES).map(|_| ())
    }

    fn validate_and_count_bytes(&self, limit: usize) -> Result<usize, ContractError> {
        let bytes = crate::content::validate_source_material(
            &self.profile,
            &self.source_set_id,
            &self.target_language,
            &self.artifacts,
        )?;
        if self.artifacts.len() > MAX_BUILD_ARTIFACTS {
            return Err(invalid("artifactSet.artifacts"));
        }
        validate_build_output_paths(self.artifacts.iter().map(|a| a.logical_path()))?;
        encoded_limit(self, limit.min(MAX_ARTIFACT_SET_BYTES), "artifactSet")?;
        Ok(bytes)
    }
}
/// Portable path, alias and file/directory collision checks shared by one build
/// and a Core release spanning several locales. Callers own collection limits.
pub fn validate_build_output_paths<'a>(
    paths: impl Iterator<Item = &'a str>,
) -> Result<(), ContractError> {
    let mut seen: Vec<String> = Vec::new();
    for path in paths {
        validate_portable_package_path(path)?;
        let path = path.to_ascii_lowercase();
        if path.split('/').count() > 16
            || seen.iter().any(|prior| {
                *prior == path
                    || prior.starts_with(&(path.clone() + "/"))
                    || path.starts_with(&(prior.clone() + "/"))
            })
        {
            return Err(invalid("build.outputPaths"));
        }
        seen.push(path);
    }
    if seen.is_empty() {
        return Err(invalid("build.outputPaths"));
    }
    Ok(())
}
/// Generic bytes/identity/bounds only. A valid association is not a semantic
/// proof, a successful required check, release eligibility or publication.
pub fn validate_build_artifacts(
    input: &BuildInput,
    output: &ArtifactSet,
) -> Result<(), ContractError> {
    input.validate()?;
    validate_artifacts_for_checked_input(input, output, MAX_ARTIFACT_SET_BYTES)
}

fn validate_artifacts_for_checked_input(
    input: &BuildInput,
    output: &ArtifactSet,
    limit: usize,
) -> Result<(), ContractError> {
    let bytes = output.validate_and_count_bytes(limit)?;
    if input.source.profile != output.profile
        || input.source.source_set_id != output.source_set_id
        || input.target_language != output.target_language
        || input
            .output_paths
            .iter()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>()
            != output.artifacts.iter().map(|a| a.logical_path()).collect()
    {
        return Err(mismatch("artifactSet.input"));
    }
    if output.artifacts.len() > input.output_limits.max_artifacts as usize
        || bytes > input.output_limits.max_total_bytes as usize
    {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "artifactSet.outputLimits",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ArtifactCheckInput {
    pub input: BuildInput,
    pub output: ArtifactSet,
    pub requirements: Vec<CheckRequirement>,
}
impl ArtifactCheckInput {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_build_artifacts(&self.input, &self.output)?;
        self.validate_requirements()?;
        self.validate_encoded_size(MAX_MATERIAL_INVOCATION_BYTES)
    }

    fn validate_requirements(&self) -> Result<(), ContractError> {
        if self.requirements.is_empty() || self.requirements.len() > 32 {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "artifactCheck.requirements",
            ));
        }
        unique(
            self.requirements.iter().map(|r| &r.key),
            "artifactCheck.requirements",
        )?;
        let targets: std::collections::BTreeSet<_> =
            self.output.artifacts.iter().map(|a| a.id()).collect();
        let mut provider = None;
        let mut basis = None;
        for requirement in &self.requirements {
            requirement.validate()?;
            let CheckImplementation::Plugin { provider: selected } =
                &requirement.key.implementation
            else {
                return Err(invalid("artifactCheck.provider"));
            };
            if provider.is_some_and(|prior| prior != selected)
                || basis.is_some_and(|prior| {
                    prior != (&requirement.input_digest, &requirement.scope_digest)
                })
                || !requirement.mandatory
                || requirement.waivable
                || requirement.not_applicable.is_some()
                || requirement
                    .targets
                    .iter()
                    .map(String::as_str)
                    .collect::<std::collections::BTreeSet<_>>()
                    != targets
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidCoverage,
                    "artifactCheck.requirements",
                ));
            }
            provider = Some(selected);
            basis = Some((&requirement.input_digest, &requirement.scope_digest));
        }
        Ok(())
    }

    fn validate_encoded_size(&self, limit: usize) -> Result<(), ContractError> {
        encoded_limit(self, limit.min(MAX_MATERIAL_INVOCATION_BYTES), "artifactCheckInput")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildDeclaration {
    pub display_name: String,
    pub profile: ContractRef,
    pub builder: String,
    pub checker: String,
    pub output_limits: BuildOutputLimits,
    pub artifact_rules: Vec<ContractRef>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "explicit_configuration"
    )]
    #[cfg_attr(
        feature = "schema",
        schemars(with = "Vec<BuildConfigurationDeclaration>")
    )]
    pub configuration: Option<Vec<BuildConfigurationDeclaration>>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildBinding {
    pub declaration: BuildDeclaration,
    pub builder: CapabilityBinding,
    pub checker: CapabilityBinding,
}
fn explicit_configuration<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<BuildConfigurationDeclaration>>, D::Error> {
    Vec::<BuildConfigurationDeclaration>::deserialize(deserializer).map(Some)
}
impl BuildDeclaration {
    pub fn declaration_contract(&self) -> ContractRef {
        ContractRef {
            schema_version: if self.configuration.is_some() { 2 } else { 1 },
            ..build_declaration_contract()
        }
    }
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.display_name.trim().is_empty()
            || self.display_name.len() > 128
            || self.display_name.chars().any(char::is_control)
        {
            return Err(invalid("buildDeclaration.displayName"));
        }
        reference(&self.profile, "buildDeclaration.profile")?;
        name(&self.builder, "buildDeclaration.builder")?;
        name(&self.checker, "buildDeclaration.checker")?;
        if self.builder == self.checker {
            return Err(invalid("buildDeclaration.checker"));
        }
        self.output_limits.validate()?;
        if self.artifact_rules.is_empty() || self.artifact_rules.len() > 32 {
            return Err(invalid("buildDeclaration.artifactRules"));
        }
        unique(self.artifact_rules.iter(), "buildDeclaration.artifactRules")?;
        for rule in &self.artifact_rules {
            reference(rule, "buildDeclaration.artifactRules")?;
        }
        if let Some(configuration) = &self.configuration {
            if configuration.len() > 32 {
                return Err(invalid("build.configuration"));
            }
            unique(
                configuration.iter().map(|entry| &entry.schema),
                "build.configuration.schema",
            )?;
            for declaration in configuration {
                declaration.validate()?;
            }
        }
        encoded_limit(self, MAX_BUILD_DECLARATION_BYTES, "buildDeclaration")
    }
    pub fn bind(
        &self,
        manifest: &ValidatedManifest,
        package_digest: &str,
    ) -> Result<BuildBinding, ContractError> {
        self.validate()?;
        let binding = BuildBinding {
            declaration: self.clone(),
            builder: bind_capability(manifest, &self.builder, package_digest)?,
            checker: bind_capability(manifest, &self.checker, package_digest)?,
        };
        binding.validate()?;
        Ok(binding)
    }
}
impl BuildBinding {
    pub fn validate_input(&self, input: &BuildInput) -> Result<(), ContractError> {
        self.validate()?;
        input.validate_with_limit(self.builder.declaration.limits.max_input_bytes as usize)?;
        self.declaration
            .validate_configuration(&input.configuration)?;
        if self.builder.declaration.input_schema.schema_version == 1 {
            crate::artifact::require_text_artifacts(
                &input.source.artifacts,
                "buildDeclaration.source.artifacts",
            )?;
        }
        if input.source.profile != self.declaration.profile
            || input.output_limits != self.declaration.output_limits
        {
            return Err(mismatch("buildDeclaration.input"));
        }
        Ok(())
    }
    pub fn validate_artifacts(
        &self,
        input: &BuildInput,
        output: &ArtifactSet,
    ) -> Result<(), ContractError> {
        self.validate_input(input)?;
        self.validate_artifacts_for_validated_build(input, output)
    }

    fn validate_artifacts_for_validated_build(
        &self,
        input: &BuildInput,
        output: &ArtifactSet,
    ) -> Result<(), ContractError> {
        validate_artifacts_for_checked_input(
            input, output, self.builder.declaration.limits.max_output_bytes as usize,
        )?;
        if self.builder.declaration.input_schema.schema_version == 1 {
            crate::artifact::require_text_artifacts(
                &output.artifacts,
                "buildDeclaration.output.artifacts",
            )?;
        }
        Ok(())
    }
    pub fn validate_check_input(&self, input: &ArtifactCheckInput) -> Result<(), ContractError> {
        self.validate_input(&input.input)?;
        self.validate_check_for_validated_build(input)?;
        input.validate_encoded_size(self.checker.declaration.limits.max_input_bytes as usize)
    }

    /// Validate the actual artifacts and checker requirements for an input
    /// already validated with this build binding. The caller must enforce the
    /// checker's encoded request limit when serializing the complete request.
    pub fn validate_check_for_validated_build(
        &self,
        input: &ArtifactCheckInput,
    ) -> Result<(), ContractError> {
        self.validate_artifacts_for_validated_build(&input.input, &input.output)?;
        input.validate_requirements()?;
        let expected: std::collections::BTreeSet<_> =
            self.declaration.artifact_rules.iter().collect();
        if input
            .requirements
            .iter()
            .map(|r| &r.key.rule)
            .collect::<std::collections::BTreeSet<_>>()
            != expected
            || input.requirements.iter().any(|r| {
                r.key.implementation
                    != (CheckImplementation::Plugin {
                        provider: self.checker.provider.clone(),
                    })
            })
        {
            return Err(ContractError::at(
                ContractErrorCode::InvalidCoverage,
                "buildDeclaration.requirements",
            ));
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<(), ContractError> {
        self.declaration.validate()?;
        self.builder.validate()?;
        self.checker.validate()?;
        if self.builder.provider.plugin != self.checker.provider.plugin
            || self.builder.provider.package_digest != self.checker.provider.package_digest
            || self.builder.provider.contribution_id != self.declaration.builder
            || self.checker.provider.contribution_id != self.declaration.checker
        {
            return Err(invalid("buildDeclaration.provider"));
        }
        let version = crate::artifact::artifact_contract_version(
            &self.builder.declaration.input_schema,
            build_input_contract(),
        )
        .ok_or_else(|| invalid("buildDeclaration.capability"))?;
        for (binding, mut input, mut output, effect) in [
            (
                &self.builder,
                build_input_contract(),
                artifact_set_contract(),
                EffectKind::Proposal,
            ),
            (
                &self.checker,
                artifact_check_input_contract(),
                check_results_contract(),
                EffectKind::ReadOnly,
            ),
        ] {
            if version == 1 {
                input.schema_version = 1;
                output.schema_version = 1;
            }
            let d = &binding.declaration;
            if d.input_schema != input
                || d.output_schema != output
                || d.error_schema != build_error_contract()
                || !d.profiles.contains(&self.declaration.profile)
                || d.effect != effect
                || !crate::validation::domain_permissions_are_allowed(
                    &d.permissions,
                    d.input_schema.schema_version == 2,
                )
            {
                return Err(invalid("buildDeclaration.capability"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum BuildErrorCode {
    InvalidInput,
    UnsupportedProfile,
    InvalidTarget,
    InvalidArtifact,
    LimitExceeded,
    Cancelled,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildError {
    pub code: BuildErrorCode,
    pub artifact_id: Option<String>,
    pub detail: String,
}
impl BuildError {
    pub fn validate(&self) -> Result<(), ContractError> {
        if let Some(id) = &self.artifact_id {
            opaque_id(id, "buildError.artifactId")?;
        }
        if self.detail.is_empty() || self.detail.contains('\0') || self.detail.len() > 4096 {
            return Err(invalid("buildError.detail"));
        }
        Ok(())
    }
}

macro_rules! receiver {
    ($parse:ident, $schema:ident, $ty:ty, $limit:expr) => {
        pub fn $parse(bytes: &[u8]) -> Result<$ty, ContractError> {
            if bytes.len() > $limit {
                return Err(ContractError::at(
                    ContractErrorCode::LimitExceeded,
                    stringify!($ty),
                ));
            }
            let value: $ty = serde_json::from_slice(bytes).map_err(|_| {
                ContractError::at(ContractErrorCode::InvalidSchema, stringify!($ty))
            })?;
            value.validate()?;
            Ok(value)
        }
        #[cfg(feature = "schema")]
        pub fn $schema() -> schemars::Schema {
            schemars::schema_for!($ty)
        }
    };
}
receiver!(
    parse_build_input,
    build_input_schema,
    BuildInput,
    MAX_MATERIAL_INVOCATION_BYTES
);
receiver!(
    parse_artifact_set,
    artifact_set_schema,
    ArtifactSet,
    MAX_ARTIFACT_SET_BYTES
);
receiver!(
    parse_artifact_check_input,
    artifact_check_input_schema,
    ArtifactCheckInput,
    MAX_MATERIAL_INVOCATION_BYTES
);
pub fn parse_build_declaration(bytes: &[u8]) -> Result<BuildDeclaration, ContractError> {
    parse_build_declaration_for_contract(bytes, &build_declaration_contract())
}
pub fn parse_build_declaration_for_contract(
    bytes: &[u8],
    contract: &ContractRef,
) -> Result<BuildDeclaration, ContractError> {
    if ![1, 2].iter().any(|version| {
        *contract
            == ContractRef {
                schema_version: *version,
                ..build_declaration_contract()
            }
    }) {
        return Err(invalid("buildDeclaration.contract"));
    }
    if bytes.len() > MAX_BUILD_DECLARATION_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "buildDeclaration",
        ));
    }
    let value: BuildDeclaration = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "buildDeclaration"))?;
    value.validate()?;
    if value.declaration_contract() != *contract {
        return Err(invalid("buildDeclaration.contract"));
    }
    Ok(value)
}
#[cfg(feature = "schema")]
pub fn build_declaration_schema() -> schemars::Schema {
    let mut schema = schemars::schema_for!(BuildDeclaration);
    schema
        .as_object_mut()
        .unwrap()
        .get_mut("required")
        .unwrap()
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!("configuration"));
    schema
}
receiver!(
    parse_build_error,
    build_error_schema,
    BuildError,
    MAX_BUILD_DECLARATION_BYTES
);
#[cfg(feature = "schema")]
pub fn build_types_schema() -> schemars::Schema {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct BuildTypes {
        input: BuildInput,
        artifacts: ArtifactSet,
        check_input: ArtifactCheckInput,
        declaration: BuildDeclaration,
        configuration_values: BuildConfigurationValues,
        configuration_selection: BuildConfigurationSelection,
        error: BuildError,
    }
    schemars::schema_for!(BuildTypes)
}
