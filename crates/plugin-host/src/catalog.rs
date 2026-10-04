//! Bounded declarations for already captured packages. Registration, enablement
//! and resolution neither activate code nor grant execution or adoption rights.

use std::{collections::BTreeMap, fmt};

use serde::{Deserialize, Serialize};

use tsumugi_plugin_sdk as sdk;

use crate::PackageImage;

pub const MAX_CATALOG_PACKAGES: usize = 128;
const MAX_ORIGIN_ID_BYTES: usize = 128;

/// Non-secret identifiers supplied by the trusted application after verifying
/// source metadata or recording an explicit manual approval. These are not
/// credentials, a URL to fetch, or a claim taken from the package manifest.
/// Each is 1..=128 bytes of ASCII letters, digits, dots, underscores, hyphens
/// and colons; the caller remains responsible for supplying non-secret values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageOrigin {
    pub source_id: String,
    pub publisher_id: String,
}

/// Independent expected values from verified metadata or explicit approval.
/// Constructing this value does not verify signatures, TUF metadata, publisher
/// identity or update freshness; that responsibility stays with its caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageApproval {
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub origin: PackageOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginField {
    SourceId,
    PublisherId,
}

/// Stable classifications without package text, file paths or credentials.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatalogError {
    InvalidOrigin(OriginField),
    IdentityMismatch,
    DigestMismatch,
    SourceConflict,
    PublisherConflict,
    DuplicatePackage,
    IdentityDigestConflict,
    MissingPackage,
    MissingContribution,
    DisabledPackage,
    BindingMismatch,
    NoCompatibleProvider,
    AmbiguousProvider,
    DuplicateSelection,
    LimitExceeded,
    Contract(sdk::ContractErrorCode),
}

pub type CatalogResult<T> = Result<T, CatalogError>;

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CatalogError {}

/// Immutable captured bytes and their independently approved source. Clones
/// retain this snapshot even when catalog enablement changes later.
#[derive(Clone)]
pub struct RegisteredPackage {
    image: PackageImage,
    origin: PackageOrigin,
}
impl RegisteredPackage {
    pub fn image(&self) -> &PackageImage {
        &self.image
    }

    pub fn origin(&self) -> &PackageOrigin {
        &self.origin
    }

    pub fn plugin(&self) -> &sdk::PluginIdentity {
        &self.image.manifest().manifest().plugin
    }

    pub fn package_digest(&self) -> &str {
        self.image.package_digest()
    }

    /// Declaration data only. The binding uses the actual captured digest and
    /// manifest owner; it does not represent an active channel or a permit.
    pub fn bind_capability(&self, contribution_id: &str) -> CatalogResult<sdk::CapabilityBinding> {
        sdk::bind_capability(
            self.image.manifest(),
            contribution_id,
            self.image.package_digest(),
        )
        .map_err(|error| {
            if error.code == sdk::ContractErrorCode::IncompatibleContract
                && error.field == "contributions.id"
            {
                CatalogError::MissingContribution
            } else {
                CatalogError::Contract(error.code)
            }
        })
    }
}
impl fmt::Debug for RegisteredPackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisteredPackage")
            .field("plugin", self.plugin())
            .field("package_digest", &self.package_digest())
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}

/// A fixed declaration choice together with the immutable package that owns it.
/// Starting it still requires a trusted launcher and a separate current grant.
#[derive(Clone, Debug)]
pub struct ResolvedCapability {
    package: RegisteredPackage,
    binding: sdk::CapabilityBinding,
}
impl ResolvedCapability {
    pub fn package(&self) -> &RegisteredPackage {
        &self.package
    }

    pub fn binding(&self) -> &sdk::CapabilityBinding {
        &self.binding
    }
}

struct CatalogEntry {
    package: RegisteredPackage,
    enabled: bool,
}

/// An in-memory catalog with no IO, project database, automatic activation,
/// install hooks, update selection or authorization authority. Versions coexist;
/// neither insertion order nor version ordering determines a provider.
#[derive(Default)]
pub struct PackageCatalog {
    packages: BTreeMap<sdk::PluginIdentity, CatalogEntry>,
}
impl PackageCatalog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.packages.len()
    }

    pub fn is_empty(&self) -> bool {
        self.packages.is_empty()
    }

    /// Compare to independently supplied expected values before recording the
    /// package. A logical plugin cannot silently move source or publisher; a
    /// changed digest under an existing exact identity is not an update.
    pub fn register(
        &mut self,
        image: PackageImage,
        approval: PackageApproval,
    ) -> CatalogResult<()> {
        validate_origin(&approval.origin)?;
        let plugin = &image.manifest().manifest().plugin;
        if *plugin != approval.plugin {
            return Err(CatalogError::IdentityMismatch);
        }
        if image.package_digest() != approval.package_digest {
            return Err(CatalogError::DigestMismatch);
        }
        for entry in self.packages.values() {
            if entry.package.plugin().id == plugin.id {
                if entry.package.origin.source_id != approval.origin.source_id {
                    return Err(CatalogError::SourceConflict);
                }
                if entry.package.origin.publisher_id != approval.origin.publisher_id
                    || entry.package.plugin().publisher != plugin.publisher
                {
                    return Err(CatalogError::PublisherConflict);
                }
            }
        }
        if let Some(entry) = self.packages.get(plugin) {
            return Err(
                if entry.package.package_digest() == image.package_digest() {
                    CatalogError::DuplicatePackage
                } else {
                    CatalogError::IdentityDigestConflict
                },
            );
        }
        if self.packages.len() >= MAX_CATALOG_PACKAGES {
            return Err(CatalogError::LimitExceeded);
        }
        self.packages.insert(
            plugin.clone(),
            CatalogEntry {
                package: RegisteredPackage {
                    image,
                    origin: approval.origin,
                },
                enabled: false,
            },
        );
        Ok(())
    }

    /// Administrative inspection includes disabled packages and grants no right
    /// to run them. New provider resolution uses resolve or lookup instead.
    pub fn registered(&self, plugin: &sdk::PluginIdentity) -> CatalogResult<&RegisteredPackage> {
        self.packages
            .get(plugin)
            .map(|entry| &entry.package)
            .ok_or(CatalogError::MissingPackage)
    }

    pub fn is_enabled(&self, plugin: &sdk::PluginIdentity) -> CatalogResult<bool> {
        self.packages
            .get(plugin)
            .map(|entry| entry.enabled)
            .ok_or(CatalogError::MissingPackage)
    }

    /// Change eligibility for new resolution only. This does not activate code,
    /// cancel an invocation, revoke a permit, or alter a previously held image.
    pub fn set_enabled(
        &mut self,
        plugin: &sdk::PluginIdentity,
        enabled: bool,
    ) -> CatalogResult<()> {
        self.packages
            .get_mut(plugin)
            .ok_or(CatalogError::MissingPackage)?
            .enabled = enabled;
        Ok(())
    }

    pub fn resolve(
        &self,
        contract: &sdk::ContractRef,
        profile: Option<&sdk::ContractRef>,
        mode: sdk::ProviderSelection,
        chosen: &[sdk::ProviderKey],
    ) -> CatalogResult<Vec<ResolvedCapability>> {
        if chosen.len() > MAX_CATALOG_PACKAGES {
            return Err(CatalogError::LimitExceeded);
        }
        // Availability is catalog-owned. Contract/profile compatibility,
        // ambiguity, collection and duplicate choices stay with the SDK.
        for key in chosen {
            let entry = self
                .packages
                .get(&key.plugin)
                .ok_or(CatalogError::MissingPackage)?;
            entry.package.bind_capability(&key.contribution_id)?;
            if !entry.enabled {
                return Err(CatalogError::DisabledPackage);
            }
        }
        let manifests = self.manifests(true);
        let selected = match sdk::resolve_declarations(&manifests, contract, profile, mode, chosen)
        {
            Ok(selected) => selected,
            Err(error) => {
                // Distinguish compatible-but-disabled declarations without
                // duplicating the SDK's matching policy or choosing one.
                if chosen.is_empty() && error.code == sdk::ContractErrorCode::IncompatibleContract {
                    let disabled = self.manifests(false);
                    if sdk::resolve_declarations(
                        &disabled,
                        contract,
                        profile,
                        sdk::ProviderSelection::CollectIndependent,
                        &[],
                    )
                    .is_ok()
                    {
                        return Err(CatalogError::DisabledPackage);
                    }
                }
                return Err(resolution_error(error.code));
            }
        };
        selected
            .into_iter()
            .map(|provider| {
                let package = self.registered(&provider.key.plugin)?.clone();
                let binding = package.bind_capability(&provider.key.contribution_id)?;
                Ok(ResolvedCapability { package, binding })
            })
            .collect()
    }

    /// Resolve an exact previously fixed choice. Never substitute a newer
    /// version, another owner, another contribution or different captured bytes.
    pub fn lookup(
        &self,
        selected: &sdk::ProviderSelectionBinding,
    ) -> CatalogResult<ResolvedCapability> {
        selected
            .validate()
            .map_err(|error| CatalogError::Contract(error.code))?;
        let entry = self
            .packages
            .get(&selected.plugin)
            .ok_or(CatalogError::MissingPackage)?;
        if entry.package.package_digest() != selected.package_digest {
            return Err(CatalogError::DigestMismatch);
        }
        let binding = entry.package.bind_capability(&selected.contribution_id)?;
        if binding.provider != *selected {
            return Err(CatalogError::BindingMismatch);
        }
        if !entry.enabled {
            return Err(CatalogError::DisabledPackage);
        }
        Ok(ResolvedCapability {
            package: entry.package.clone(),
            binding,
        })
    }

    fn manifests(&self, enabled: bool) -> Vec<sdk::ValidatedManifest> {
        self.packages
            .values()
            .filter(|entry| entry.enabled == enabled)
            .map(|entry| entry.package.image.manifest().clone())
            .collect()
    }
}

fn validate_origin(origin: &PackageOrigin) -> CatalogResult<()> {
    for (value, field) in [
        (&origin.source_id, OriginField::SourceId),
        (&origin.publisher_id, OriginField::PublisherId),
    ] {
        if value.is_empty()
            || value.len() > MAX_ORIGIN_ID_BYTES
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-:".contains(&byte))
        {
            return Err(CatalogError::InvalidOrigin(field));
        }
    }
    Ok(())
}

fn resolution_error(code: sdk::ContractErrorCode) -> CatalogError {
    match code {
        sdk::ContractErrorCode::IncompatibleContract => CatalogError::NoCompatibleProvider,
        sdk::ContractErrorCode::AmbiguousProvider => CatalogError::AmbiguousProvider,
        sdk::ContractErrorCode::DuplicateIdentity => CatalogError::DuplicateSelection,
        sdk::ContractErrorCode::LimitExceeded => CatalogError::LimitExceeded,
        code => CatalogError::Contract(code),
    }
}
