use serde::{Deserialize, Serialize};

/// Claimed package identity; a host must authenticate the actual package source.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct PluginIdentity {
    pub publisher: String,
    pub id: String,
    pub version: String,
}

impl PluginIdentity {
    /// Validate identity syntax only, without authenticating its publisher.
    pub fn validate(&self) -> Result<(), crate::ContractError> {
        crate::validation::name(&self.publisher, "plugin.publisher")?;
        crate::validation::name(&self.id, "plugin.id")?;
        crate::validation::version(&self.version)
    }
}

/// Schema and behavior are separate exact-match compatibility identities.
/// Matching JSON field types or a package SemVer is not behavioral compatibility.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ContractRef {
    pub id: String,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub schema_version: u32,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub behavior_version: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ComponentScope {
    Application,
    Project,
    Attempt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum RuntimeKind {
    Data,
    NativeWorker,
    #[serde(rename = "javascript")]
    JavaScript,
}

/// These are requested permissions, never an authorization token.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum PermissionRequest {
    CapturedInput,
    StagedOutput,
    ProjectService { contract: ContractRef },
    Network { destination: String },
    Process { program: String },
}

/// Read-only concerns project state; proposals are not already-adopted changes.
/// Network/process effects still require their own host authorization.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum EffectKind {
    ReadOnly,
    Proposal,
    External,
}

/// Multiple providers retain separate provenance. A later merge is another
/// explicitly selected capability, not registration-order precedence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ProviderSelection {
    Single,
    CollectIndependent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapabilityDependency {
    pub contract: ContractRef,
    pub required: bool,
    pub selection: ProviderSelection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ExitRequirements {
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub stop_timeout_ms: u32,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub cleanup_timeout_ms: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ComponentDeclaration {
    pub id: String,
    pub scope: ComponentScope,
    pub runtime: RuntimeKind,
    /// Package-relative file. Actual opening and isolation are host responsibilities.
    pub entrypoint: Option<String>,
    pub dependencies: Vec<CapabilityDependency>,
    pub exit: ExitRequirements,
}

/// Requested upper bounds. The host must also enforce its own current limits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapabilityLimits {
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub max_input_bytes: u32,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub max_output_bytes: u32,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u16_schema")
    )]
    pub concurrency: u16,
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::positive_u32_schema")
    )]
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct CapabilityDeclaration {
    pub contract: ContractRef,
    pub input_schema: ContractRef,
    pub output_schema: ContractRef,
    pub error_schema: ContractRef,
    pub profiles: Vec<ContractRef>,
    pub effect: EffectKind,
    pub permissions: Vec<PermissionRequest>,
    pub limits: CapabilityLimits,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub enum ContributionKind {
    Capability { declaration: CapabilityDeclaration },
    Resource { schema: ContractRef, path: String },
    Skill { path: String },
    Ui { slot: String, schema: ContractRef },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ContributionDeclaration {
    pub id: String,
    /// Exactly one component owns activation and cleanup of this contribution.
    pub component_id: String,
    pub contribution: ContributionKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct PluginManifest {
    #[cfg_attr(
        feature = "schema",
        schemars(schema_with = "crate::manifest_protocol_schema")
    )]
    pub protocol_version: u32,
    pub plugin: PluginIdentity,
    pub permissions: Vec<PermissionRequest>,
    pub components: Vec<ComponentDeclaration>,
    pub contributions: Vec<ContributionDeclaration>,
}
