# Plugin Declarations

[`tsumugi-plugin-sdk`](..) defines the `PluginManifest` data model, capability and dependency resolution rules, and JSON Schema validation harness for declaration protocol `1`.

## Identity, Ownership, and Scope

A `PluginManifest` declares:

- Protocol version (`1`), publisher ID, plugin ID, and SemVer version.
- Package-level requested permissions.
- Components and their owned contributions (`capabilities`, `resources`, `skills`, `ui`).

Each component specifies an execution scope (`application`, `project`, or `attempt`), a runtime kind (`javascript`, `native`, or `data`), a package-relative entrypoint (omitted for `data` components), required and optional capability dependencies, and stop/cleanup deadlines. `data` components cannot own callable capabilities or executable UI, but can own `resources` and `skills`. Each contribution belongs to exactly one component in the same manifest.

Identifiers are bounded lowercase ASCII namespace labels. Package paths must be relative and portable—without `..` segments, empty segments, Windows drive prefixes, or backslashes. When staging a package on disk, the Host independently verifies file handles, symlinks, and platform constraints.

## Capability Declarations and Compatibility

Each capability contribution declares its input, output, and error schemas, supported profiles, project effect (`read-only`, `proposal`, or `external`), requested permissions, and payload/time limits.

Both contracts and profiles carry explicit positive `schemaVersion` and `behaviorVersion` numbers. Compatibility requires an exact match on both versions—there is no implicit SemVer range matching or automatic fallback to another profile. Capabilities that declare profiles require callers to specify an exact profile when resolving or invoking them.

### Resolution and Provider Bindings

- `resolve_declarations` resolves capability requests against a set of validated manifests. A single-provider request with multiple matching declarations requires an explicit `ProviderKey` (publisher, plugin, version, and contribution ID) to disambiguate. A `collect-independent` request returns all matching providers in canonical order rather than relying on registration order.
- `CapabilityCompatibilityRequest` and `ValidatedManifest::diagnose_capability` apply the exact same contract/profile predicate as `capability()` and provider resolution, reporting missing or non-callable contributions, contract schema/behavior mismatches, and unsupported or omitted profiles.
- `bind_capability` pairs a validated declaration and its owning component with an independently verified package digest to form a `ProviderSelectionBinding`. Attaching a live `instance` ID and `activationGeneration` produces a `ProviderBinding` for an active process channel.

### Domain Capability Fixtures

The synthetic manifests in `tests/fixtures/` model the capability matrix for the two reference domains (using `example.*` schema IDs):

| Capability | SMAPI fixture (`smapi-i18n-flat`) | WebVTT fixture (`webvtt-captions`) |
|---|---|---|
| Detect / material checks | Declared | Declared |
| Extract source | Declared | Declared |
| Import translations | Declared | Unavailable |
| Match source / identity proposals | Declared | Declared |
| Validate content | Declared | Declared |
| Build | Declared | Declared |
| Validate artifact | Declared | Declared |

## Component dependency closure diagnostics

The SDK can inspect the transitive component dependency graph of explicitly selected root components via `diagnose_dependency_closure`. Because roots are identified by `ComponentKey` (plugin identity, version, and component ID), data and Skill components can be inspected alongside callable components.

Each dependency edge preserves the manifest's `required` flag and `Single` or `CollectIndependent` resolution policy. Callers may supply per-dependency `DependencyChoice` entries specifying the owning component, exact contract, optional profile, and selected provider keys; omitting a choice runs the standard resolver with no profile and no preferred provider.

```rust
let report = tsumugi_plugin_sdk::diagnose_dependency_closure(&entries, &request)?;
```

- `DependencyClosureRequest` can be constructed in Rust (and checked via `.validate()`) or parsed from strict JSON via `parse_dependency_closure_request`.
- Each `DeclarationEntry` wraps a borrowed `ValidatedManifest` and an `enabled: bool` flag.
- In `tsumugi-plugin-host`, `PackageCatalog::diagnose_dependencies(&request)` wraps this report into a `CatalogDependencyClosure` containing `declarations` (the SDK report), `packages` (digests, approved origins, and enabled flags), and `providers` (`ProviderSelectionBinding` identities).

### Traversal Rules and Limits

- Unknown root packages or components fail with `MissingOwner`.
- A known root with `enabled = false` is included in the report with its dependencies traversed so callers can inspect why a disabled component would or would not resolve.
- Nodes, edges, selected providers, and closed dependency cycles are emitted in canonical order, with shared components visited once.
- Missing required declarations, absent optional declarations, disabled providers, and ambiguous single-provider matches are reported as distinct states.
- Duplicate roots, duplicate or unused dependency choices, and duplicate provider selections are rejected.
- The report scope is `declaration-catalog-only`: Host-provided external services (such as `tsumugi.core` work-plan generation) are resolved by the Host at runtime rather than through catalog manifests.

Exceeding any input or graph limit fails validation rather than truncating the report:

| Input or traversal | Limit |
|---|---:|
| Validated manifests | 128 / 32 MiB total |
| Root components | 32 |
| Per-dependency choices | 128 |
| Reachable components | 128 |
| Dependency edges | 512 |
| Request provider choices / reported edge provider references | 1024 each |
| Providers in one explicit choice (existing resolver bound) | 128 |
| Active traversal depth | 32 |
| Encoded request / report | 64 KiB / 1 MiB |

## Effects and Requested Permissions

Capabilities declare one of three project effects:

- `read-only`: inspects inputs without proposing project state changes or performing external side effects.
- `proposal`: returns candidate content, translations, or artifacts for Core to validate and adopt.
- `external`: interacts with external services or approved model endpoints.

Every permission requested by a capability must also be declared in the package's top-level permission set. Permission descriptors can reference `captured-input`, staged outputs, specific `project-service` contracts, network destination labels, or package-relative executables. Declared permissions and resource limits are requests evaluated by the Host: the Host enforces stricter runtime ceilings, validates concrete URLs and service handles, and tracks caller delegation chains and budgets.

## JSON Schema and CLI Harness

With the `schema` feature enabled, `tsumugi-plugin-contract` generates and verifies `schemas/plugin-manifest.schema.json`:

- `schema`: emits the JSON Schema from the Rust/Serde types (using standard integer bounds for unsigned integers).
- `check-schema <file>`: verifies that the committed schema matches the current Rust definition.
- `validate <file>`: parses a manifest (up to 256 KiB), rejecting unknown or duplicate JSON keys, unsupported protocol versions, missing component owners, duplicate IDs, invalid resource limits, and undeclared capability permissions. Errors report static classifications and field names without echoing untrusted input text.

See [Content and Invocation Exchange](exchange.md) for the payload envelope and check coverage contracts.
