# Experimental plugin declarations

The [`tsumugi-plugin-sdk`](..) crate currently provides strict
data declarations, exact declaration resolution and a public schema/validation
harness. These contracts are experimental. The desktop still uses its existing
built-in integrations; this SDK unit does not replace the production loader or
establish runtime isolation.

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
an instance. Actual cycle detection, optional-service availability and cleanup
belong to the runtime host.

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
