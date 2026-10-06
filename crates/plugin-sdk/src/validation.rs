use std::{collections::BTreeSet, fmt};

use serde::{Deserialize, Serialize};

use crate::*;

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
        if self.limits.max_input_bytes == 0
            || self.limits.max_output_bytes == 0
            || self.limits.concurrency == 0
            || self.limits.timeout_ms == 0
        {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "contributions.limits",
            ));
        }
        Ok(())
    }
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
        let contribution = self
            .0
            .contributions
            .iter()
            .find(|c| c.id == contribution_id)
            .ok_or_else(|| {
                ContractError::at(ContractErrorCode::IncompatibleContract, "contributions.id")
            })?;
        let ContributionKind::Capability { declaration } = &contribution.contribution else {
            return Err(ContractError::at(
                ContractErrorCode::IncompatibleContract,
                "contributions.kind",
            ));
        };
        if declaration.contract != *contract
            || profile.is_some_and(|p| !declaration.profiles.contains(p))
        {
            return Err(ContractError::at(
                ContractErrorCode::IncompatibleContract,
                "contributions.contract",
            ));
        }
        // A profile-sensitive declaration cannot be called with an unspecified profile.
        if profile.is_none() && !declaration.profiles.is_empty() {
            return Err(ContractError::at(
                ContractErrorCode::IncompatibleContract,
                "contributions.profiles",
            ));
        }
        Ok(declaration)
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
