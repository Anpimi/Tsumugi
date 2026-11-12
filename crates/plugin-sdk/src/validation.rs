use std::{collections::BTreeSet, fmt};

use serde::{Deserialize, Serialize};

use crate::*;

/// Current artifact-capable domains may delegate to an explicitly declared
/// format process. Program paths retain ordinary permission validation; this
/// does not grant execution or permit network, services or staged file access.
pub(crate) fn domain_permissions_are_allowed(
    permissions: &[PermissionRequest],
    current_artifacts: bool,
) -> bool {
    permissions.iter().all(|permission| {
        matches!(permission, PermissionRequest::CapturedInput)
            || (current_artifacts && matches!(permission, PermissionRequest::Process { .. }))
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContractErrorCode {
    InvalidSchema,
    UnsupportedProtocol,
    InvalidDeclaration,
    LimitExceeded,
    DuplicateIdentity,
    MissingOwner,
    UndeclaredPermission,
    InvalidPath,
    AmbiguousProvider,
    IncompatibleContract,
    InvalidRange,
    UnsupportedExtension,
    ResultMismatch,
    InvalidCoverage,
}

/// Static field names only: do not echo arbitrary manifest contents into logs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContractError {
    pub code: ContractErrorCode,
    pub field: String,
}
impl ContractError {
    pub(crate) fn at(code: ContractErrorCode, field: &str) -> Self {
        Self {
            code,
            field: field.into(),
        }
    }
}
impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} at {}", self.code, self.field)
    }
}
impl std::error::Error for ContractError {}

/// Wire label syntax only; supported canonical locales are host-owned.
pub(crate) fn language_label(value: &str, field: &str) -> Result<(), ContractError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}

/// Owned and immutable after structural/semantic validation. Not an installed
/// package or a permission grant, and not proof that any component is available.
#[derive(Clone, Debug)]
pub struct ValidatedManifest(PluginManifest);

pub fn parse_manifest(bytes: &[u8]) -> Result<ValidatedManifest, ContractError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ContractError::at(
            ContractErrorCode::LimitExceeded,
            "manifest",
        ));
    }
    let manifest: PluginManifest = serde_json::from_slice(bytes)
        .map_err(|_| ContractError::at(ContractErrorCode::InvalidSchema, "manifest"))?;
    manifest.validate()
}

pub(crate) fn name(value: &str, field: &str) -> Result<(), ContractError> {
    // Protocol identifiers are ASCII and bounded, independent of display names.
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-_/".contains(&c))
        || !value.as_bytes()[0].is_ascii_lowercase()
        || !value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        || value.split(['.', '-', '_', '/']).any(str::is_empty)
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}
pub(crate) fn version(value: &str) -> Result<(), ContractError> {
    if value.len() > 64 || semver::Version::parse(value).is_err() {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "plugin.version",
        ));
    }
    Ok(())
}
pub(crate) fn reference(value: &ContractRef, field: &str) -> Result<(), ContractError> {
    name(&value.id, field)?;
    if value.schema_version == 0 || value.behavior_version == 0 {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}
pub(crate) fn path(value: &str, field: &str) -> Result<(), ContractError> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value.contains(['\\', ':', '\0'])
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(ContractError::at(ContractErrorCode::InvalidPath, field));
    }
    Ok(())
}
pub(crate) fn portable_path(value: &str, field: &str) -> Result<(), ContractError> {
    path(value, field)?;
    if !value.is_ascii()
        || value.split('/').any(|part| {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            part.ends_with(['.', ' '])
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
    {
        return Err(ContractError::at(ContractErrorCode::InvalidPath, field));
    }
    Ok(())
}
fn permission(value: &PermissionRequest) -> Result<(), ContractError> {
    match value {
        PermissionRequest::ProjectService { contract } => {
            reference(contract, "permissions.contract")?
        }
        PermissionRequest::Network { destination } => {
            // The declaration carries an exact destination label. URL syntax,
            // actual destination and sharing authorization are broker checks.
            if destination.is_empty()
                || destination.len() > 2048
                || destination.chars().any(char::is_control)
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "permissions.destination",
                ));
            }
        }
        PermissionRequest::Process { program } => path(program, "permissions.program")?,
        _ => {}
    }
    Ok(())
}
pub(crate) fn unique<T: Ord>(
    values: impl IntoIterator<Item = T>,
    field: &str,
) -> Result<(), ContractError> {
    let mut seen = BTreeSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(ContractError::at(
                ContractErrorCode::DuplicateIdentity,
                field,
            ));
        }
    }
    Ok(())
}
pub(crate) fn count(len: usize, field: &str) -> Result<(), ContractError> {
    if len > 128 {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, field));
    }
    Ok(())
}
impl PluginManifest {
    pub fn validate(self) -> Result<ValidatedManifest, ContractError> {
        if self.protocol_version != MANIFEST_PROTOCOL {
            return Err(ContractError::at(
                ContractErrorCode::UnsupportedProtocol,
                "protocolVersion",
            ));
        }
        name(&self.plugin.publisher, "plugin.publisher")?;
        name(&self.plugin.id, "plugin.id")?;
        version(&self.plugin.version)?;
        count(self.permissions.len(), "permissions")?;
        count(self.components.len(), "components")?;
        count(self.contributions.len(), "contributions")?;
        if self.components.is_empty() || self.contributions.is_empty() {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "components",
            ));
        }
        unique(self.permissions.iter(), "permissions")?;
        for value in &self.permissions {
            permission(value)?;
        }
        unique(self.components.iter().map(|c| &c.id), "components.id")?;
        unique(self.contributions.iter().map(|c| &c.id), "contributions.id")?;
        for component in &self.components {
            name(&component.id, "components.id")?;
            match (component.runtime, &component.entrypoint) {
                (RuntimeKind::Data, None) => {}
                (RuntimeKind::Data, Some(_)) | (_, None) => {
                    return Err(ContractError::at(
                        ContractErrorCode::InvalidDeclaration,
                        "components.entrypoint",
                    ));
                }
                (_, Some(value)) => path(value, "components.entrypoint")?,
            }
            if component.exit.stop_timeout_ms == 0 || component.exit.cleanup_timeout_ms == 0 {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "components.exit",
                ));
            }
            count(component.dependencies.len(), "components.dependencies")?;
            unique(
                component.dependencies.iter().map(|d| &d.contract),
                "components.dependencies",
            )?;
            for dependency in &component.dependencies {
                reference(&dependency.contract, "components.dependencies.contract")?;
            }
            if !self
                .contributions
                .iter()
                .any(|c| c.component_id == component.id)
            {
                return Err(ContractError::at(
                    ContractErrorCode::InvalidDeclaration,
                    "components.contributions",
                ));
            }
        }
        for contribution in &self.contributions {
            name(&contribution.id, "contributions.id")?;
            let owner = self
                .components
                .iter()
                .find(|c| c.id == contribution.component_id)
                .ok_or_else(|| {
                    ContractError::at(ContractErrorCode::MissingOwner, "contributions.componentId")
                })?;
            match &contribution.contribution {
                ContributionKind::Capability { declaration } => {
                    if owner.runtime == RuntimeKind::Data {
                        return Err(ContractError::at(
                            ContractErrorCode::InvalidDeclaration,
                            "contributions.runtime",
                        ));
                    }
                    declaration.validate(&self.permissions)?;
                }
                ContributionKind::Resource {
                    schema,
                    path: value,
                } => {
                    reference(schema, "contributions.schema")?;
                    path(value, "contributions.path")?;
                }
                ContributionKind::Skill { path: value } => path(value, "contributions.path")?,
                ContributionKind::Ui { slot, schema } => {
                    if owner.runtime != RuntimeKind::JavaScript {
                        return Err(ContractError::at(
                            ContractErrorCode::InvalidDeclaration,
                            "contributions.runtime",
                        ));
                    }
                    name(slot, "contributions.slot")?;
                    reference(schema, "contributions.schema")?;
                }
            }
        }
        Ok(ValidatedManifest(self))
    }
}
impl CapabilityDeclaration {
    pub(crate) fn validate(&self, requested: &[PermissionRequest]) -> Result<(), ContractError> {
        for (value, field) in [
            (&self.contract, "contributions.contract"),
            (&self.input_schema, "contributions.inputSchema"),
            (&self.output_schema, "contributions.outputSchema"),
            (&self.error_schema, "contributions.errorSchema"),
        ] {
            reference(value, field)?;
        }
        count(self.profiles.len(), "contributions.profiles")?;
        unique(self.profiles.iter(), "contributions.profiles")?;
        for profile in &self.profiles {
            reference(profile, "contributions.profiles")?;
        }
        count(self.permissions.len(), "contributions.permissions")?;
        unique(self.permissions.iter(), "contributions.permissions")?;
        for value in &self.permissions {
            permission(value)?;
            if !requested.contains(value) {
                return Err(ContractError::at(
                    ContractErrorCode::UndeclaredPermission,
                    "contributions.permissions",
                ));
            }
        }
        limits(&self.limits, "contributions.limits")
    }
}
pub(crate) fn limits(value: &CapabilityLimits, field: &str) -> Result<(), ContractError> {
    if value.max_input_bytes == 0
        || value.max_output_bytes == 0
        || value.concurrency == 0
        || value.timeout_ms == 0
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}
impl ValidatedManifest {
    pub fn manifest(&self) -> &PluginManifest {
        &self.0
    }

    /// Resolve a declaration only. Even a unique match is not an active instance
    /// or a grant. The host must bind verified package/instance/scope identities.
    pub fn capability(
        &self,
        contribution_id: &str,
        contract: &ContractRef,
        profile: Option<&ContractRef>,
    ) -> Result<&CapabilityDeclaration, ContractError> {
        crate::compatibility::resolve_capability_declaration(
            self.manifest(),
            contribution_id,
            contract,
            profile,
        )
    }
}

pub(crate) fn opaque_id(value: &str, field: &str) -> Result<(), ContractError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b".-_:/".contains(&c))
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}
pub(crate) fn digest(value: &str, field: &str) -> Result<(), ContractError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            field,
        ));
    }
    Ok(())
}

/// Count canonical JSON without allocating an unbounded intermediate buffer.
pub(crate) fn encoded_limit<T: serde::Serialize>(
    value: &T,
    limit: usize,
    field: &str,
) -> Result<(), ContractError> {
    struct Counter {
        bytes: usize,
        limit: usize,
        exceeded: bool,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.bytes = self.bytes.saturating_add(bytes.len());
            if self.bytes > self.limit {
                self.exceeded = true;
                return Err(std::io::Error::other("encoded data limit"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        bytes: 0,
        limit,
        exceeded: false,
    };
    serde_json::to_writer(&mut counter, value).map_err(|_| {
        ContractError::at(
            if counter.exceeded {
                ContractErrorCode::LimitExceeded
            } else {
                ContractErrorCode::InvalidSchema
            },
            field,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_limit_counts_exact_utf8_and_escaped_bytes_without_a_full_buffer() {
        let mut input = parse_review_check_input(include_bytes!("../tests/fixtures/review.input.json")).unwrap();
        input.source.domain_blocks.last_mut().unwrap().payload_utf8.push_str("🧵 e\u{301} \"\\\0\t\r\n");
        input.validate().unwrap();
        let exact = serde_json::to_vec(&input).unwrap().len();
        encoded_limit(&input, exact, "reviewCheckInput").unwrap();
        input.source.domain_blocks.last_mut().unwrap().payload_utf8.push('x');
        assert_eq!(serde_json::to_vec(&input).unwrap().len(), exact + 1);
        input.validate().unwrap();
        assert_eq!(encoded_limit(&input, exact, "reviewCheckInput").unwrap_err(),
            ContractError::at(ContractErrorCode::LimitExceeded, "reviewCheckInput"));
        encoded_limit(&input, exact + 1, "reviewCheckInput").unwrap();
    }

    #[test]
    fn encoded_limit_distinguishes_serialization_failure_from_an_exceeded_budget() {
        struct Invalid;
        impl Serialize for Invalid {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("synthetic serialization failure"))
            }
        }
        let value = ("\0".repeat(32), Invalid);
        assert_eq!(encoded_limit(&value, 8, "fixture").unwrap_err(),
            ContractError::at(ContractErrorCode::LimitExceeded, "fixture"));
        assert_eq!(encoded_limit(&value, 1024, "fixture").unwrap_err(),
            ContractError::at(ContractErrorCode::InvalidSchema, "fixture"));
    }

    #[test]
    fn material_parser_boundaries_precede_schema_decoding() {
        type Parse = fn(&[u8]) -> Result<(), ContractError>;
        // One zero-filled buffer covers all physical length guards. At the
        // exact ceiling invalid JSON reaches schema decoding; +1 must be
        // rejected by the length guard first. This is not a maximum-size
        // semantically valid material fixture.
        let bytes = vec![0; MAX_MATERIAL_INVOCATION_BYTES + 1];
        let receivers: &[(usize, Parse, &str)] = &[
            (MAX_SOURCE_EXTRACTION_INPUT_BYTES, |bytes| parse_source_extraction_input(bytes).map(drop), "sourceExtractionInput"),
            (MAX_MATERIAL_INVOCATION_BYTES, |bytes| parse_source_extraction_check_input(bytes).map(drop), "sourceExtractionCheckInput"),
            (MAX_MATERIAL_INVOCATION_BYTES, |bytes| parse_build_input(bytes).map(drop), "BuildInput"),
            (MAX_ARTIFACT_SET_BYTES, |bytes| parse_artifact_set(bytes).map(drop), "ArtifactSet"),
            (MAX_MATERIAL_INVOCATION_BYTES, |bytes| parse_artifact_check_input(bytes).map(drop), "ArtifactCheckInput"),
            (MAX_MATERIAL_INVOCATION_BYTES, |bytes| parse_review_check_input(bytes).map(drop), "reviewCheckInput"),
        ];
        for &(limit, parse, field) in receivers {
            assert_eq!(parse(&bytes[..limit]).unwrap_err(),
                ContractError::at(ContractErrorCode::InvalidSchema, field));
            assert_eq!(parse(&bytes[..limit + 1]).unwrap_err(),
                ContractError::at(ContractErrorCode::LimitExceeded, field));
        }
    }
}
