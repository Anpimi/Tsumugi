//! Bounded declaration closure observations, without runtime service bindings.
//! External Host services, activation, grants and execution are not assessed.
use crate::{
    validation::{encoded_limit, name, reference},
    *,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_DEPENDENCY_MANIFESTS: usize = 128;
pub const MAX_DEPENDENCY_ROOTS: usize = 32;
pub const MAX_DEPENDENCY_CHOICES: usize = 128;
pub const MAX_DEPENDENCY_NODES: usize = 128;
pub const MAX_DEPENDENCY_EDGES: usize = 512;
pub const MAX_DEPENDENCY_PROVIDER_REFS: usize = 1024;
pub const MAX_DEPENDENCY_DEPTH: usize = 32;
pub const MAX_DEPENDENCY_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_DEPENDENCY_MANIFEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_DEPENDENCY_REPORT_BYTES: usize = 1024 * 1024;

/// A declaration owner, including components containing only resources or Skills.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComponentKey {
    pub plugin: PluginIdentity,
    pub component_id: String,
}

/// Choices belong to this exact owner and full dependency contract. Requiredness
/// and provider mode always come from the manifest, never from this request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyChoice {
    pub owner: ComponentKey,
    pub contract: ContractRef,
    pub profile: Option<ContractRef>,
    pub chosen: Vec<ProviderKey>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyClosureRequest {
    pub roots: Vec<ComponentKey>,
    pub selections: Vec<DependencyChoice>,
}

/// Caller-observed eligibility for declaration lookup only. This flag neither
/// authenticates a package nor supplies a runtime, service descriptor or permit.
#[derive(Clone, Copy)]
pub struct DeclarationEntry<'a> {
    pub manifest: &'a ValidatedManifest,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DependencyClosureScope {
    DeclarationCatalogOnly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyComponent {
    pub key: ComponentKey,
    pub scope: ComponentScope,
    pub runtime: RuntimeKind,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case", deny_unknown_fields)]
pub enum DependencyResolution {
    Resolved { providers: Vec<ProviderKey> },
    RequiredDeclarationMissing,
    OptionalDeclarationAbsent,
    AmbiguousProviders { providers: Vec<ProviderKey> },
    DisabledProviders { providers: Vec<ProviderKey> },
    IncompatibleSelection,
}
impl DependencyResolution {
    /// Referenced declarations, including diagnostic candidates. Only Resolved
    /// identifies selected edges; none of these keys is an execution binding.
    pub fn referenced_providers(&self) -> &[ProviderKey] {
        match self {
            Self::Resolved { providers }
            | Self::AmbiguousProviders { providers }
            | Self::DisabledProviders { providers } => providers,
            _ => &[],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyEdge {
    pub owner: ComponentKey,
    pub contract: ContractRef,
    pub required: bool,
    pub selection: ProviderSelection,
    pub profile: Option<ContractRef>,
    pub chosen: Vec<ProviderKey>,
    pub resolution: DependencyResolution,
}

/// A complete bounded observation, not a readiness or authorization result.
/// Missing declarations do not establish that an external Host service is absent.
/// Cycles are canonical closed traversal witnesses, not every possible cycle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyClosureReport {
    pub scope: DependencyClosureScope,
    pub roots: Vec<ComponentKey>,
    pub nodes: Vec<DependencyComponent>,
    pub edges: Vec<DependencyEdge>,
    pub cycles: Vec<Vec<ComponentKey>>,
}

fn limit(length: usize, maximum: usize, field: &str) -> Result<(), ContractError> {
    if length > maximum {
        return Err(ContractError::at(ContractErrorCode::LimitExceeded, field));
    }
    Ok(())
}
impl ComponentKey {
    fn validate(&self) -> Result<(), ContractError> {
        self.plugin.validate()?;
        name(&self.component_id, "dependencyClosure.componentId")
    }
}
impl DependencyClosureRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        encoded_limit(
            self,
            MAX_DEPENDENCY_REQUEST_BYTES,
            "dependencyClosure.request",
        )?;
        if self.roots.is_empty() {
            return Err(ContractError::at(
                ContractErrorCode::InvalidDeclaration,
                "dependencyClosure.roots",
            ));
        }
        limit(
            self.roots.len(),
            MAX_DEPENDENCY_ROOTS,
            "dependencyClosure.roots",
        )?;
        limit(
            self.selections.len(),
            MAX_DEPENDENCY_CHOICES,
            "dependencyClosure.selections",
        )?;
        let mut roots = BTreeSet::new();
        for root in &self.roots {
            root.validate()?;
            if !roots.insert(root) {
                return Err(ContractError::at(
                    ContractErrorCode::DuplicateIdentity,
                    "dependencyClosure.roots",
                ));
            }
        }
        let mut choices = BTreeSet::new();
        let mut provider_refs = 0usize;
        for choice in &self.selections {
            choice.owner.validate()?;
            reference(&choice.contract, "dependencyClosure.contract")?;
            if let Some(profile) = &choice.profile {
                reference(profile, "dependencyClosure.profile")?;
            }
            if !choices.insert((&choice.owner, &choice.contract)) {
                return Err(ContractError::at(
                    ContractErrorCode::DuplicateIdentity,
                    "dependencyClosure.selections",
                ));
            }
            // Retain the original resolver's bound for one explicit selection.
            crate::validation::count(choice.chosen.len(), "dependencyClosure.chosen")?;
            provider_refs += choice.chosen.len();
            limit(
                provider_refs,
                MAX_DEPENDENCY_PROVIDER_REFS,
                "dependencyClosure.providers",
            )?;
            let mut providers = BTreeSet::new();
            for provider in &choice.chosen {
                provider.plugin.validate()?;
                name(
                    &provider.contribution_id,
                    "dependencyClosure.contributionId",
                )?;
                if !providers.insert(provider) {
                    return Err(ContractError::at(
                        ContractErrorCode::DuplicateIdentity,
                        "dependencyClosure.chosen",
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Strict, bounded JSON convenience for Rust consumers. It reads no files.
pub fn parse_dependency_closure_request(
    bytes: &[u8],
) -> Result<DependencyClosureRequest, ContractError> {
    limit(
        bytes.len(),
        MAX_DEPENDENCY_REQUEST_BYTES,
        "dependencyClosure.request",
    )?;
    let request: DependencyClosureRequest = serde_json::from_slice(bytes).map_err(|_| {
        ContractError::at(
            ContractErrorCode::InvalidSchema,
            "dependencyClosure.request",
        )
    })?;
    request.validate()?;
    Ok(request)
}

/// Diagnose only reachable declared component dependencies. A missing choice
/// uses the existing resolver's exact no-profile/no-explicit-provider behavior.
/// Disabled observations never become selected providers. All results are
/// canonical; a bound failure returns no truncated or apparently complete graph.
pub fn diagnose_dependency_closure(
    entries: &[DeclarationEntry<'_>],
    request: &DependencyClosureRequest,
) -> Result<DependencyClosureReport, ContractError> {
    request.validate()?;
    limit(
        entries.len(),
        MAX_DEPENDENCY_MANIFESTS,
        "dependencyClosure.manifests",
    )?;
    let manifests: Vec<_> = entries
        .iter()
        .map(|entry| entry.manifest.manifest())
        .collect();
    encoded_limit(
        &manifests,
        MAX_DEPENDENCY_MANIFEST_BYTES,
        "dependencyClosure.manifests",
    )?;
    let mut traversal = Traversal::new(entries, request)?;
    let mut roots = request.roots.clone();
    roots.sort();
    for root in &roots {
        traversal.visit(root)?;
    }
    if traversal.used.len() != traversal.choices.len() {
        return Err(ContractError::at(
            ContractErrorCode::InvalidDeclaration,
            "dependencyClosure.selections.unused",
        ));
    }
    let report = DependencyClosureReport {
        scope: DependencyClosureScope::DeclarationCatalogOnly,
        roots,
        nodes: traversal.nodes.into_values().collect(),
        edges: traversal.edges.into_values().collect(),
        cycles: traversal.cycles.into_iter().collect(),
    };
    encoded_limit(
        &report,
        MAX_DEPENDENCY_REPORT_BYTES,
        "dependencyClosure.report",
    )?;
    Ok(report)
}

type EdgeKey = (ComponentKey, ContractRef);
struct Traversal<'a> {
    components: BTreeMap<ComponentKey, (&'a ComponentDeclaration, bool)>,
    enabled: Vec<ValidatedManifest>,
    all: Vec<ValidatedManifest>,
    enabled_plugins: BTreeSet<PluginIdentity>,
    choices: BTreeMap<EdgeKey, DependencyChoice>,
    used: BTreeSet<EdgeKey>,
    nodes: BTreeMap<ComponentKey, DependencyComponent>,
    edges: BTreeMap<EdgeKey, DependencyEdge>,
    active: Vec<ComponentKey>,
    finished: BTreeSet<ComponentKey>,
    cycles: BTreeSet<Vec<ComponentKey>>,
    provider_refs: usize,
}
impl<'a> Traversal<'a> {
    fn new(
        entries: &[DeclarationEntry<'a>],
        request: &DependencyClosureRequest,
    ) -> Result<Self, ContractError> {
        let mut components = BTreeMap::new();
        let mut packages = BTreeSet::new();
        let mut enabled_plugins = BTreeSet::new();
        for entry in entries {
            let manifest = entry.manifest.manifest();
            encoded_limit(manifest, MAX_MANIFEST_BYTES, "dependencyClosure.manifest")?;
            if !packages.insert(&manifest.plugin) {
                return Err(ContractError::at(
                    ContractErrorCode::DuplicateIdentity,
                    "dependencyClosure.manifests.plugin",
                ));
            }
            if entry.enabled {
                enabled_plugins.insert(manifest.plugin.clone());
            }
            for component in &manifest.components {
                components.insert(
                    ComponentKey {
                        plugin: manifest.plugin.clone(),
                        component_id: component.id.clone(),
                    },
                    (component, entry.enabled),
                );
            }
        }
        Ok(Self {
            components,
            enabled: entries
                .iter()
                .filter(|entry| entry.enabled)
                .map(|entry| entry.manifest.clone())
                .collect(),
            all: entries.iter().map(|entry| entry.manifest.clone()).collect(),
            enabled_plugins,
            choices: request
                .selections
                .iter()
                .map(|choice| {
                    (
                        (choice.owner.clone(), choice.contract.clone()),
                        choice.clone(),
                    )
                })
                .collect(),
            used: BTreeSet::new(),
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            active: Vec::new(),
            finished: BTreeSet::new(),
            cycles: BTreeSet::new(),
            provider_refs: 0,
        })
    }

    fn resolve(
        &self,
        dependency: &CapabilityDependency,
        choice: Option<&DependencyChoice>,
    ) -> Result<DependencyResolution, ContractError> {
        let profile = choice.and_then(|choice| choice.profile.as_ref());
        let chosen = choice.map_or(&[][..], |choice| choice.chosen.as_slice());
        match declared_keys(
            &self.enabled,
            dependency,
            profile,
            dependency.selection,
            chosen,
        ) {
            Ok(providers) => Ok(DependencyResolution::Resolved { providers }),
            Err(error) if error.code == ContractErrorCode::AmbiguousProvider => {
                let providers = declared_keys(
                    &self.enabled,
                    dependency,
                    profile,
                    ProviderSelection::CollectIndependent,
                    chosen,
                )?;
                Ok(DependencyResolution::AmbiguousProviders { providers })
            }
            Err(error) if error.code == ContractErrorCode::IncompatibleContract => {
                match declared_keys(
                    &self.all,
                    dependency,
                    profile,
                    ProviderSelection::CollectIndependent,
                    chosen,
                ) {
                    Ok(providers) => {
                        let providers = providers
                            .into_iter()
                            .filter(|provider| !self.enabled_plugins.contains(&provider.plugin))
                            .collect::<Vec<_>>();
                        if !providers.is_empty() {
                            return Ok(DependencyResolution::DisabledProviders { providers });
                        }
                    }
                    Err(error) if error.code == ContractErrorCode::IncompatibleContract => {}
                    Err(error) => return Err(error),
                }
                Ok(if !chosen.is_empty() {
                    DependencyResolution::IncompatibleSelection
                } else if dependency.required {
                    DependencyResolution::RequiredDeclarationMissing
                } else {
                    DependencyResolution::OptionalDeclarationAbsent
                })
            }
            Err(error) => Err(error),
        }
    }

    fn visit(&mut self, key: &ComponentKey) -> Result<(), ContractError> {
        if let Some(position) = self.active.iter().position(|active| active == key) {
            let mut cycle = self.active[position..].to_vec();
            let first = (0..cycle.len())
                .min_by_key(|index| &cycle[*index])
                .expect("nonempty active cycle");
            cycle.rotate_left(first);
            cycle.push(cycle[0].clone());
            self.cycles.insert(cycle);
            return Ok(());
        }
        if self.finished.contains(key) {
            return Ok(());
        }
        // Bound the live traversal stack, not an enumeration of all graph paths.
        limit(
            self.active.len() + 1,
            MAX_DEPENDENCY_DEPTH,
            "dependencyClosure.depth",
        )?;
        limit(
            self.nodes.len() + 1,
            MAX_DEPENDENCY_NODES,
            "dependencyClosure.nodes",
        )?;
        let (component, enabled) = self.components.get(key).copied().ok_or_else(|| {
            ContractError::at(
                ContractErrorCode::MissingOwner,
                "dependencyClosure.component",
            )
        })?;
        self.nodes.insert(
            key.clone(),
            DependencyComponent {
                key: key.clone(),
                scope: component.scope,
                runtime: component.runtime,
                enabled,
            },
        );
        self.active.push(key.clone());
        let mut dependencies = component.dependencies.clone();
        dependencies.sort_by(|a, b| a.contract.cmp(&b.contract));
        for dependency in dependencies {
            limit(
                self.edges.len() + 1,
                MAX_DEPENDENCY_EDGES,
                "dependencyClosure.edges",
            )?;
            let edge_key = (key.clone(), dependency.contract.clone());
            let choice = self.choices.get(&edge_key);
            if choice.is_some() {
                self.used.insert(edge_key.clone());
            }
            let resolution = self.resolve(&dependency, choice)?;
            self.provider_refs += resolution.referenced_providers().len();
            limit(
                self.provider_refs,
                MAX_DEPENDENCY_PROVIDER_REFS,
                "dependencyClosure.providers",
            )?;
            let mut chosen = choice.map_or_else(Vec::new, |choice| choice.chosen.clone());
            chosen.sort();
            let edge = DependencyEdge {
                owner: key.clone(),
                contract: dependency.contract,
                required: dependency.required,
                selection: dependency.selection,
                profile: choice.and_then(|choice| choice.profile.clone()),
                chosen,
                resolution,
            };
            let children = match &edge.resolution {
                DependencyResolution::Resolved { providers } => providers
                    .iter()
                    .map(|provider| {
                        let manifest = self
                            .all
                            .iter()
                            .find(|manifest| manifest.manifest().plugin == provider.plugin)
                            .expect("resolved declaration package");
                        let contribution = manifest
                            .manifest()
                            .contributions
                            .iter()
                            .find(|contribution| contribution.id == provider.contribution_id)
                            .expect("resolved declaration contribution");
                        ComponentKey {
                            plugin: provider.plugin.clone(),
                            component_id: contribution.component_id.clone(),
                        }
                    })
                    .collect::<BTreeSet<_>>(),
                _ => BTreeSet::new(),
            };
            self.edges.insert(edge_key, edge);
            for child in children {
                self.visit(&child)?;
            }
        }
        self.active.pop();
        self.finished.insert(key.clone());
        Ok(())
    }
}

fn declared_keys(
    manifests: &[ValidatedManifest],
    dependency: &CapabilityDependency,
    profile: Option<&ContractRef>,
    mode: ProviderSelection,
    chosen: &[ProviderKey],
) -> Result<Vec<ProviderKey>, ContractError> {
    resolve_declarations(manifests, &dependency.contract, profile, mode, chosen)
        .map(|providers| providers.into_iter().map(|provider| provider.key).collect())
}
