//! Experimental plugin contracts shared by authors and hosts.
//!
//! Parsing a declaration does not install a package, start a component or grant
//! permission. Runtime identity, activation, authorization, execution and
//! persistence belong to the host; this crate has no Core or database dependency.
//! The optional `native-worker` feature serves this process through the same
//! contracts; it does not launch processes, install packages or grant authority.

mod binding;
mod build;
mod checks;
mod compatibility;
mod content;
mod declaration;
mod dependency_closure;
mod environment;
mod generation;
mod invocation;
#[cfg(feature = "native-worker")]
mod native_worker;
mod process;
mod resolution;
mod review;
mod service;
mod source_context;
mod source_extraction;
mod source_import;
mod text;
mod tool;
mod translation;
mod validation;

pub use binding::{CapabilityBinding, ProviderSelectionBinding, bind_capability};
pub use build::*;
pub use checks::*;
pub use compatibility::*;
pub use content::*;
pub use declaration::*;
pub use dependency_closure::*;
pub use environment::*;
pub use generation::*;
pub use invocation::*;
#[cfg(feature = "native-worker")]
pub use native_worker::*;
pub use process::*;
pub use resolution::{DeclaredProvider, ProviderKey, resolve_declarations};
pub use review::*;
pub use service::*;
pub use source_context::*;
pub use source_extraction::*;
pub use source_import::*;
pub use text::*;
pub use tool::*;
pub use translation::*;
pub use validation::{ContractError, ContractErrorCode, ValidatedManifest, parse_manifest};

/// Version of the SDK that owns the current contracts, from its package metadata.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The one currently supported declaration protocol, independent of SDK SemVer.
pub const MANIFEST_PROTOCOL: u32 = 1;
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

#[cfg(feature = "schema")]
pub fn manifest_schema() -> schemars::Schema {
    schemars::schema_for!(PluginManifest)
}

#[cfg(feature = "schema")]
fn manifest_protocol_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "const": MANIFEST_PROTOCOL})
}

#[cfg(feature = "schema")]
fn positive_u32_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":1, "maximum": u32::MAX})
}

#[cfg(feature = "schema")]
fn positive_u16_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":1, "maximum": u16::MAX})
}

/// The current experimental content/invocation/check wire protocol.
pub const EXCHANGE_PROTOCOL: u32 = 1;
pub const MAX_EXCHANGE_BYTES: usize = 2 * 1024 * 1024;
/// Content can carry separate identity and context extensions for every item.
/// Captured material, artifacts and non-content frames retain their own limits.
pub const MAX_CONTENT_EXCHANGE_BYTES: usize = 4 * 1024 * 1024;
/// Combined invocation data may contain both captured material and a proposal.
pub const MAX_INVOCATION_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
/// Any UTF-8 payload byte can expand to six JSON bytes. Metadata is separately
/// bounded by the typed context/provider/contracts and fits the reserved 64 KiB.
pub const MAX_PROCESS_FRAME_BYTES: usize = 6 * MAX_INVOCATION_PAYLOAD_BYTES + 64 * 1024;
pub const MAX_CONTENT_ITEMS: usize = 2000;
/// Separate identity and context extensions can accompany each content item.
/// The complete exchange still has its independent encoded-byte ceiling.
pub const MAX_CONTENT_DOMAIN_BLOCKS: usize = 4000;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;

/// Length-prefixed local process messages, independent of content protocols.
pub const PROCESS_PROTOCOL: u32 = 3;

/// Validate a logical package file path before a host materializes captured bytes.
/// This does not open a path or prove filesystem containment.
pub fn validate_package_path(value: &str) -> Result<(), ContractError> {
    validation::path(value, "package.path")
}

/// Apply the Host's portable relative-file naming policy to data artifacts.
/// This checks syntax only; filesystem containment and held handles stay host-owned.
pub fn validate_portable_package_path(value: &str) -> Result<(), ContractError> {
    validation::portable_path(value, "artifact.path")
}

/// Validate a lowercase SHA-256 value, without inspecting or approving bytes.
pub fn validate_package_digest(value: &str) -> Result<(), ContractError> {
    validation::digest(value, "package.digest")
}

/// Validate a contribution identifier with the declaration's original grammar.
/// This proves syntax only, without resolving a Resource or granting authority.
pub fn validate_contribution_id(value: &str) -> Result<(), ContractError> {
    validation::name(value, "contribution.id")
}

#[cfg(feature = "schema")]
pub fn process_schema() -> schemars::Schema {
    schemars::schema_for!(ProcessFrame)
}

/// Build-time metadata for generated language bindings, from the same constants
/// that the Rust receiver enforces. This is not a runtime authorization policy.
#[cfg(feature = "schema")]
pub fn process_profile() -> serde_json::Value {
    serde_json::json!({
        "protocolVersion": PROCESS_PROTOCOL,
        "maxFrameBytes": MAX_PROCESS_FRAME_BYTES,
        "maxInvocationPayloadBytes": MAX_INVOCATION_PAYLOAD_BYTES,
        "maxCapabilities": MAX_PROCESS_CAPABILITIES,
        "maxServiceBindings": MAX_SERVICE_BINDINGS,
        "maxServiceCalls": MAX_SERVICE_CALLS,
        "sdkVersion": SDK_VERSION
    })
}

#[cfg(feature = "schema")]
fn process_protocol_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "const": PROCESS_PROTOCOL})
}

#[cfg(feature = "schema")]
pub fn exchange_schema() -> schemars::Schema {
    schemars::schema_for!(ExchangeDocument)
}

#[cfg(feature = "schema")]
fn exchange_protocol_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "const": EXCHANGE_PROTOCOL})
}
#[cfg(feature = "schema")]
fn offset_schema(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"integer", "minimum":0, "maximum":u32::MAX})
}
