//! Experimental, data-only plugin declarations shared by authors and hosts.
//!
//! Parsing a declaration does not install a package, start a component or grant
//! permission. Runtime identity, activation, authorization, execution and
//! persistence belong to the host; this crate has no Core or database dependency.

mod declaration;
mod resolution;
mod validation;

pub use declaration::*;
pub use resolution::{DeclaredProvider, ProviderKey, resolve_declarations};
pub use validation::{ContractError, ContractErrorCode, ValidatedManifest, parse_manifest};

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
