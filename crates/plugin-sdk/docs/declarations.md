# Experimental plugin declarations

The [`tsumugi-plugin-sdk`](..) crate currently provides strict
data declarations, exact declaration resolution and a public schema/validation
harness. These contracts are experimental. The SDK does not install packages,
replace the runtime loader or establish runtime isolation.

## Identity, ownership and scope

A `PluginManifest` records declaration protocol `1`, a claimed publisher/plugin
ID and SemVer, requested permissions, components and contributions. Components
declare application, project or attempt scope, runtime kind, package-relative
entrypoint, required/optional capability dependencies and bounded stop/cleanup
deadlines. Data components have no entrypoint and cannot provide callable
capabilities or executable UI. Resources and Skills can belong to data components.

Each contribution has one component owner. A package can contribute resources,
Skills, UI and multiple capabilities under one package identity. Required and
optional dependencies, lifecycle ownership and future result/input dependencies
are different relationships. Parsing a dependency does not resolve it or activate
an instance. Activation-time cycle prevention, actual optional-service
availability and cleanup belong to the runtime host.

Identifiers are bounded lowercase ASCII namespace labels. Package references are
relative, without parent traversal, empty segments, drive paths or backslashes.
The host must still verify actual handles, symlinks, package contents and platform
constraints when loading. Manifest claims cannot authenticate publisher identity
or protect a worker from accessing the operating system.

## Capability declarations and compatibility

Every capability identifies its input, output and error schemas, supported
profiles, project effect, requested permissions and resource limits. Profiles
and contracts carry separate positive `schemaVersion` and `behaviorVersion`
identities. Current declaration resolution requires an exact match for both;
there is no implicit SemVer range or fallback to another profile. A profile-sensitive
capability requires an explicit profile. Changing behavior with the same JSON
field types does not satisfy the previous behavior identity.

`resolve_declarations` only inspects validated declarations. Overlapping single
providers require an explicit `ProviderKey`, including claimed publisher, plugin,
version and contribution. `collect-independent` keeps each provider's identity
in canonical order, without merging values or using registration order as
precedence. The runtime must later bind a verified package digest, actual channel,
instance, activation generation, project/attempt scope and configuration. A
declaration key is not that binding and cannot authorize a callback.

The synthetic fixtures cover the current domain capability matrix:

| Capability | SMAPI fixture | WebVTT fixture |
|---|---|---|
| Detect/material checks | Declared | Declared |
| Extract source | Declared | Declared |
| Import translations | Declared | Unavailable |
| Match source/identity proposals | Declared | Declared |
| Validate content | Declared | Declared |
| Build | Declared | Declared |
| Validate artifact | Declared | Declared |

Fixture profile names match the existing `smapi-i18n-flat` and
`webvtt-captions` scopes. They preserve the absence of WebVTT translation import.
They do not implement these capabilities, widen either format profile or prove
domain fidelity. Their `example.*` schema IDs remain fixture declarations.

## Component dependency closure diagnostics

The Rust SDK can inspect the transitive component dependencies of explicitly
selected roots. A root identifies an exact plugin version and component, so
data and Skill components can be inspected without inventing a callable.
Each dependency keeps the manifest's required flag and Single or
CollectIndependent policy. An independent choice identifies its owner and exact
contract, with an optional exact profile and selected provider keys. Omitting
that choice uses the original resolver with no profile and no preferred provider;
it does not guess a profile or resolve ambiguity by load order.

Construct a `DependencyClosureRequest` from `ComponentKey` roots and independent
`DependencyChoice` selections. `parse_dependency_closure_request` accepts bounded
strict JSON; `validate()` applies the same rules to requests built directly in
Rust. Each `DeclarationEntry` borrows a `ValidatedManifest` and carries the
caller's observed `enabled` flag:

```rust
let report = tsumugi_plugin_sdk::diagnose_dependency_closure(&entries, &request)?;
```

The Host's `PackageCatalog::diagnose_dependencies(&request)` produces a
`CatalogDependencyClosure`: `declarations` contains that SDK report, `packages`
retains the catalog's exact package digests, approved origins and enabled flags,
and `providers` retains the original `ProviderSelectionBinding` identities.
Construct the catalog through its existing independently approved image owner;
a manifest or this report cannot supply package approval.

Unknown root packages or components are rejected with `MissingOwner`. A known
disabled root is retained with `enabled=false`; its dependencies are still
inspected as declarations. This does not admit that component for activation.

The report retains nodes, edges, selected providers and closed cycle paths in
canonical order. Shared components are traversed once. Missing required
declarations, absent optional declarations, disabled selections and ambiguity
remain distinct; optional absence alone is not a conclusion that the component
cannot run. Duplicate roots or choices, duplicate provider selections and unused
choices are rejected. Limits fail explicitly rather than truncating a report:

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

The report's `declaration-catalog-only` scope observes the supplied manifests and
enabled state. External Host services are not included. For example, a missing
`tsumugi.core` catalog declaration does not prove that the Host's original
generation service is unavailable. The report grants no approval, instance,
service handle or execution permission and does not relax Application scope
restrictions. A real service binding must still validate its captured provider,
runtime, scope, generation, permissions, cancellation and original deadline.

## Effects and requested permissions

`read-only`, `proposal` and `external` describe declared project effects.
A proposal is an output for Core to consider, not already-adopted project state.
Package permissions and per-capability requirements must agree. Requests can name
captured inputs, staged outputs, exact project services, network destinations or
package-relative programs. Network labels do not validate or authorize actual
URLs; the broker validates the concrete request and destination.

No declaration grants these permissions. Installation, trust, scopes, execution
grants, budget ownership and write authority remain distinct host decisions.
Cross-plugin calls must preserve the originating caller and complete delegation
chain. The host must reuse the existing execution/work-plan cancellation,
generation, budget, receipt and adoption boundaries; this SDK exposes no database,
authorizer, credential store or second task ledger. Declared limits are requests;
host limits can be stricter. Missing required checks cannot become a successful
empty result, and an automatic selection cannot become human approval.

## Schema and harness

Generate JSON Schema with the SDK's `schema` CLI command; the optional `schema`
feature compiles generation support. Runtime parsing uses the same Rust/Serde
types and a bounded 256 KiB input. Unknown fields, duplicate JSON fields,
unrecognized enum values, unsupported protocol, missing contribution owners,
duplicate identities, invalid limits and undeclared permission requirements are
rejected. The CLI prints only a validated declaration or a static error
classification/field, not arbitrary rejected contents.

The checked-in `schemas/plugin-manifest.schema.json` is generated, not separately
edited. `check-schema <file>` compares it with the current Rust generator and
rejects stale schemas. The schema pins the supported protocol from the same Rust
constant. Relationship and other semantic checks remain in the validation harness.
Unsigned fields use standard integer bounds from their Rust primitive limits;
no custom integer-format registration is needed in a JSON Schema validator.

Use the CLI validation command as well as structural schema validation. Neither
proves a real host, package execution, OS sandbox, effective permissions or
accepted project writes. The [content/result envelope and check coverage](exchange.md)
are separate data contracts with their own protocol; manifest validation does not
validate their payloads or provide the runtime host.
