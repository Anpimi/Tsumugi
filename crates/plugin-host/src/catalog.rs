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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageApproval {
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub origin: PackageOrigin,
}

impl PackageApproval {
    /// Syntax only. The application supplies independently trusted values;
    /// validating this metadata does not authenticate or admit a package.
    pub fn validate(&self) -> CatalogResult<()> {
        validate_origin(&self.origin)?;
        self.plugin
            .validate()
            .map_err(|error| CatalogError::Contract(error.code))?;
        sdk::validate_package_digest(&self.package_digest)
            .map_err(|error| CatalogError::Contract(error.code))
    }
}

/// Shared metadata conflict policy for catalogs, installation indices and
/// trusted application settings. It retains no executable bytes or authority.
#[derive(Default)]
pub(crate) struct PackageApprovalIndex {
    plugins: BTreeMap<sdk::PluginIdentity, String>,
    origins: BTreeMap<String, (String, String, String)>,
}
impl PackageApprovalIndex {
    pub(crate) fn check_origin(&self, approval: &PackageApproval) -> CatalogResult<()> {
        approval.validate()?;
        let origin = (
            approval.origin.source_id.clone(),
            approval.origin.publisher_id.clone(),
            approval.plugin.publisher.clone(),
        );
        if let Some(prior) = self.origins.get(&approval.plugin.id) {
            if prior.0 != origin.0 {
                return Err(CatalogError::SourceConflict);
            }
            if prior.1 != origin.1 || prior.2 != origin.2 {
                return Err(CatalogError::PublisherConflict);
            }
        }
        Ok(())
    }

    /// Retained receipts constrain provenance without reserving an exact
    /// identity or action: reinstalling the same bytes remains independent.
    pub(crate) fn observe_origin(&mut self, approval: &PackageApproval) -> CatalogResult<()> {
        self.check_origin(approval)?;
        self.origins.insert(
            approval.plugin.id.clone(),
            (
                approval.origin.source_id.clone(),
                approval.origin.publisher_id.clone(),
                approval.plugin.publisher.clone(),
            ),
        );
        Ok(())
    }

    pub(crate) fn insert(&mut self, approval: &PackageApproval) -> CatalogResult<()> {
        self.observe_origin(approval)?;
        if let Some(digest) = self.plugins.get(&approval.plugin) {
            return Err(if digest == &approval.package_digest {
                CatalogError::DuplicatePackage
            } else {
                CatalogError::IdentityDigestConflict
            });
        }
        self.plugins
            .insert(approval.plugin.clone(), approval.package_digest.clone());
        Ok(())
    }
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

/// The same captured catalog observation that supplied declaration eligibility.
/// Origin remains independently supplied metadata, not publisher authentication.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDependencyPackage {
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
    pub origin: PackageOrigin,
    pub enabled: bool,
}

/// Captured identities for declaration diagnosis only. The provider index also
/// includes ambiguous/disabled candidates; it creates no runtime service binding,
/// instance, grant, current dispatch permission or adoption authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDependencyClosure {
    pub declarations: sdk::DependencyClosureReport,
    pub packages: Vec<CatalogDependencyPackage>,
    pub providers: Vec<sdk::ProviderSelectionBinding>,
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
    /// Diagnose against this actual captured catalog and its current enablement
    /// observation. External Host services are outside the declaration catalog;
    /// their absence here does not establish runtime unavailability.
    pub fn diagnose_dependencies(
        &self,
        request: &sdk::DependencyClosureRequest,
    ) -> CatalogResult<CatalogDependencyClosure> {
        let entries = self
            .packages
            .values()
            .map(|entry| sdk::DeclarationEntry {
                manifest: entry.package.image().manifest(),
                enabled: entry.enabled,
            })
            .collect::<Vec<_>>();
        let declarations = sdk::diagnose_dependency_closure(&entries, request)
            .map_err(|error| resolution_error(error.code))?;
        let referenced = declarations
            .edges
            .iter()
            .flat_map(|edge| edge.resolution.referenced_providers().iter().cloned())
            .collect::<std::collections::BTreeSet<_>>();
        let providers = referenced
            .into_iter()
            .map(|provider| {
                let package = self.registered(&provider.plugin)?;
                Ok(package.bind_capability(&provider.contribution_id)?.provider)
            })
            .collect::<CatalogResult<Vec<_>>>()?;
        let packages = self
            .packages
            .values()
            .map(|entry| CatalogDependencyPackage {
                plugin: entry.package.plugin().clone(),
                package_digest: entry.package.package_digest().into(),
                origin: entry.package.origin().clone(),
                enabled: entry.enabled,
            })
            .collect();
        let report = CatalogDependencyClosure {
            declarations,
            packages,
            providers,
        };
        let bytes = serde_json::to_vec(&report)
            .map_err(|_| CatalogError::Contract(sdk::ContractErrorCode::InvalidSchema))?;
        if bytes.len() > sdk::MAX_DEPENDENCY_REPORT_BYTES {
            return Err(CatalogError::LimitExceeded);
        }
        Ok(report)
    }

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
        let mut index = PackageApprovalIndex::default();
        for entry in self.packages.values() {
            index.insert(&PackageApproval {
                plugin: entry.package.plugin().clone(),
                package_digest: entry.package.package_digest().into(),
                origin: entry.package.origin().clone(),
            })?;
        }
        index.insert(&approval)?;
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

pub(crate) fn validate_origin(origin: &PackageOrigin) -> CatalogResult<()> {
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
