# Experimental plugin SDK

This package provides experimental data contracts, a conformance CLI, generated
JavaScript declarations and validators, and an optional Rust component entry
point. Start with the independent build and consumption commands below, then
read the contract for the capability you implement.

The source in this checkout supplies the SDK. Host and application responsibilities
described in these documents are integration requirements; this package provides
no plugin loader, Host executable or desktop plugin workflow. Parsing a declaration
or computing a digest does not install a package or grant execution authority.

The Rust SDK source in this checkout requires Rust 1.98 or newer. Independently
pinned SDK artifacts retain their own manifest and contract surface.

`tsumugi-plugin-sdk` is a Rust contract library and conformance harness. Its
current package version is `0.1.0-alpha.1`; declaration and exchange protocols `1` are separate
versions. It has no dependency on Core, SQLite, the desktop application or Cordis.
Default features are data-only. It does not launch processes, install packages
or grant permissions. The optional `native-worker` feature provides a
[Rust component entry point](docs/native-worker.md) for serving this process
through the same public protocol, with cancellation and cleanup.

See [the declaration contract](docs/declarations.md) for fields,
compatibility and host responsibilities, and [content exchange](docs/exchange.md)
for invocation, fidelity, text offsets and check coverage. The manifest fixtures in
[`tests/fixtures`](tests/fixtures) are synthetic declarations, not executable
plugin packages. Their `example.*` schemas and capabilities are fixture names;
the harness does not claim they are implemented domain APIs.

[Source extraction](docs/source-extraction.md) defines bounded captured-material
input, exact content-result association and finite public errors. Its JavaScript
content/text declarations are generated from the Rust schemas alongside the
existing process bindings.
An optional package Resource uses the same SDK's source-import declaration to
fix material paths, a profile and independent extractor/checker selections.
The Host interprets only its captured bytes; directory access and current grants
remain separate application decisions.

[Build and artifact data](docs/build.md) defines fixed decided targets, actual
UTF-8 output, complete independent check scope and a captured build Resource.
The SDK metadata APIs validate the data; a consuming application must separately
implement capture, execution and Release adoption. These contracts grant no
execution or publication permission.

[Existing translation data](docs/translation-import.md) adds complete captured
translation proposals, original native evidence and independent mandatory checks.
A captured Resource selects one file and exact extractor/checker contributions.
These helpers grant no execution or adoption authority; domain execution, current
project matching and desktop integration remain required consumers.

[Domain review checks](docs/review.md) define fixed source/selected-text scopes,
versioned mandatory domain rules and an immutable checker Resource. Results reuse
the existing check coverage contract. Core qualification and desktop execution
remain separate consumers; reading metadata grants no execution or review approval.

The same [review contract](docs/review.md) also defines explicit advisory text
checks independent of a source format. They capture selected rules, source and
translation text, exact supporting-resource pins and typed finding locations.
Their reports reuse the original check identities and coverage; they neither
adopt a resource nor replace mandatory source checks. The Host binds actual
packages and bytes. Joint project QA, qualification and desktop choices remain
separate consumers.

[Read-only capability tools](docs/tools.md) select an existing capability, exact
profile and same-package Resource/Skill support without duplicating its contracts
or permissions. The SDK and Host validate fixed metadata; application discovery,
current authorization and manual/batch/Agent journeys remain separate consumers.

[Work-plan generation service data](docs/generation.md) defines the public bounded
source-subset request, child-identity acknowledgement and finite errors for the
original authorized generator. Model, sharing, effects and budgets stay with the
application. The service requires an External component grant; metadata and
read-only tool consent cannot authorize generation. Application integration and
its runtime acceptance remain separate from these SDK data contracts.

[Source context facts](docs/source-context.md) add an optional typed domain block
with explicit extracted/inferred origin and captured source references. The
existing content receiver verifies its scope and Unicode coordinates. Bounded
JavaScript encoding and Rust data checks grant no project, sharing or execution
authority; domain collection and application capture remain separate consumers.

## Build and consume the SDK independently

Rust 1.98 or newer is required. From the source repository root, build and test
only this package; no desktop, Core or Host build is needed:

```sh
cargo test -p tsumugi-plugin-sdk --locked
cargo test -p tsumugi-plugin-sdk --all-features --locked
cargo build -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract --locked
```

The `schema` feature supplies the contract CLI. The optional `native-worker`
feature supplies component-side framing and lifecycle helpers; it neither launches
a process nor provides a Host. The tests use synthetic data. They do not establish
platform execution support or a complete plugin/application workflow.

For a separate Rust consumer, use the exact verified SDK source directory or an
unpacked Cargo source archive as a dependency:

```toml
[dependencies]
tsumugi-plugin-sdk = { path = "/absolute/path/to/verified/tsumugi-plugin-sdk", version = "=0.1.0-alpha.1" }
```

A minimal consumer of the public declaration API is:

```rust
use tsumugi_plugin_sdk::{SDK_VERSION, parse_manifest};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("Pass a manifest path")?;
    let validated = parse_manifest(&std::fs::read(path)?)?;
    println!("SDK {SDK_VERSION}: {}", validated.manifest().plugin.id);
    Ok(())
}
```

The consumer can read `tests/fixtures/smapi.manifest.json` from its selected SDK.
Those declarations are synthetic conformance examples, not runnable domain plugins.
A Cargo source package can be built with `cargo package -p tsumugi-plugin-sdk --locked`
from the source checkout; keep its exact provenance when selecting it. Cargo
normalizes inherited package metadata so that the unpacked crate has no parent
workspace or sibling-source dependency. Generate and retain the consumer's own
Cargo lockfile. Registry dependencies require network access or an already
prepared cache; `--offline` works only with that cache.

The checked-in `javascript/` modules and their local helper modules are consumable
without a Host or third-party JavaScript runtime package. Keep the whole directory
when using them. For example, run this from the selected SDK directory with Node
`>=26.10.0 <27`:

```sh
node --input-type=module -e "import validate from './javascript/validate-source-extraction-input.mjs'; import { readFileSync } from 'node:fs'; if (!validate(JSON.parse(readFileSync('tests/fixtures/source-extraction.input.json', 'utf8')))) process.exit(1);"
```

Structural JavaScript validation does not replace the strict Rust receiver,
semantic checks, actual package capture or authorization.

## Maintain generated contracts

Rust/Serde is the single schema owner. The contract CLI emits each schema with
`schema-<kind>` and compares it with `check-<kind>-schema` (manifest uses `schema`
and `check-schema`). The examples below and the contract documents show the
corresponding commands. Update schemas with that CLI before regenerating JavaScript.

The private Node package in this directory is developer tooling, with exact Ajv
and json-schema-to-typescript dependencies in the repository's pnpm lockfile.
From the repository root:

```sh
pnpm install --frozen-lockfile --filter @tsumugi/plugin-sdk-tooling
node crates/plugin-sdk/scripts/generate-contracts.mjs
node crates/plugin-sdk/scripts/generate-contracts.mjs --check
TSUMUGI_PLUGIN_CONTRACT="$PWD/target/debug/tsumugi-plugin-contract" node --test crates/plugin-sdk/tests/*.test.mjs
```

Use the actual built CLI path when setting `CARGO_TARGET_DIR`. The generator first
checks all committed SDK schemas against Rust, then produces only SDK JavaScript
files. It preserves generator license notices and refuses output requiring a
third-party runtime helper. `--check` compares generated output without writing it.
Generation uses Cargo's locked offline mode, so prepare its registry dependencies
with a successful SDK build first. These tooling dependencies are needed for
regeneration; consuming checked-in JavaScript requires no installation. Run Node
directly after the filtered install so package-manager script bootstrapping does
not install unrelated workspace packages.

From the repository root:

```sh
cargo test -p tsumugi-plugin-sdk --features schema --locked
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema > crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-schema crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate crates/plugin-sdk/tests/fixtures/smapi.manifest.json
```

Exchange harness examples:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-exchange > crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-exchange-schema crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-exchange crates/plugin-sdk/tests/fixtures/webvtt.content.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- match-result crates/plugin-sdk/tests/fixtures/invocation.request.json crates/plugin-sdk/tests/fixtures/invocation.result.json crates/plugin-sdk/tests/fixtures/invocation.channel.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-coverage crates/plugin-sdk/tests/fixtures/checks.set.json crates/plugin-sdk/tests/fixtures/checks.results.json
```

The schemas are generated from the Rust/Serde source. The CLI `validate` command
also checks owner references, duplicate identities, SemVer syntax, requested
permissions, bounds and package-relative paths. Structural JSON Schema validation
alone cannot prove those relationships or runtime authorization.

`CapabilityCompatibilityRequest` and `ValidatedManifest::diagnose_capability`
expose the same exact capability contract/profile predicate used by
`capability()` and provider resolution. They report missing/non-callable
contributions, independent contract schema/behavior differences and unsupported
or omitted profiles without selecting another implementation. A consuming Host
must bind those diagnostics to its actual captured package. These data reports
grant no execution authority or guarantee about a domain implementation's behavior.

The Rust SDK also provides [bounded component dependency closure
diagnostics](docs/declarations.md#component-dependency-closure-diagnostics).
Explicit roots and per-dependency profile/provider choices share the same
resolver. Reports preserve missing or disabled declarations, ambiguity and
cycles; the Host can attach actual captured package identities. Host-provided
services and runtime authorization remain outside this declaration-only graph.

The crate has its own experimental version and can be packaged independently.
It has not been published to crates.io. Earlier immutable SDK archives remain
pinned by their consumers, and this source may differ from those frozen
`0.1.0-alpha.1` archives. Select the exact source commit and complete artifact;
equal version labels do not prove equal contents or compatibility. A subsequent
SDK distribution must reassess compatibility and advance its prerelease rather
than replace an earlier archive. The application has a separate version and
release boundary.

The [local process protocol](docs/process.md) adds SDK-owned handshake, invocation,
cancel/close and heartbeat frames. A separately implemented Host must bind those
frames to captured packages and actual child pipes. The SDK has no
Core dependency; its optional native component entry point uses only the standard
library and the existing contracts, with no additional framework dependency.

Process protocol **3** activates one `ComponentInstanceBinding` and a frozen,
nonempty roster of at most 128 `ProcessCapability` declarations. Ready must echo
the complete original activation, and Close/Closed identify the whole instance.
Each invocation still carries its exact `ProviderBinding`, including its own
contribution. `ProcessActivation::provider(id)` checks that exact member;
`ProviderBinding::instance()` projects the shared component principal. Neither
helper grants authority. Project/Attempt activation keeps a singleton roster and
its existing service rules. The basic Rust native facade accepts only a singleton
without services, and rejects a larger roster before author activation.

The JavaScript `ComponentAPI` exposes read-only `instance` and `contributions`
descriptions. Authors call `register(contributionId, handler)` for every captured
member exactly once before Ready. Missing, duplicate, unknown or late registration
is an error. There is no old single-contribution API or protocol-2 fallback.
The initial multi-callable Application profile is JavaScript, read-only, without
required dependencies or project services; this wire format does not enable
Native Application execution or domain, Agent or generation adoption. Manifest
and exchange protocols remain at 1, and this source keeps the SDK version
`0.1.0-alpha.1`. Captured process-2 environments require new matching materials;
the receiver does not migrate historical descriptions.

`bind_capability` captures an exact validated declaration and its owner with an
independently supplied package digest. `ProviderSelectionBinding` identifies that
fixed choice without an instance or activation generation; `ProviderBinding`
adds those fields for an actual channel. Neither data value grants execution or
adoption authority, and a digest does not authenticate a package publisher.

[Captured runtime descriptions](docs/environment.md) define the experimental
`node-system-libraries-v1` profile, complete tool/Host artifact hashes, and an
SDK-owned environment digest derived from the full validated descriptor.
The captured Node data contract admits `macos`, `linux` and `windows`; this does
not establish platform execution or distribution support. Adding the Windows
Rust enum variant requires downstream exhaustive matches to include it and a
consumer to explicitly verify a matching immutable SDK artifact. Older artifacts
keep their own contract surface even when their version labels are equal.
`ExecutionEnvironmentDescriptor` also admits the separate
`native-application-host-v1` profile, recording the actual application Host
identity rather than artificial Node artifacts. Native package bytes remain
independently bound by the provider. Neither profile grants permission.
These data helpers contain no filesystem capture or loader. Host integration
must independently approve and retain the actual runtime bytes.

Source-import Resource schema/behavior 2/2 additionally requires `reviewResource`,
which selects an immutable SDK ReviewDeclaration. `SourceImportDeclaration::bind`
requires that captured declaration and fixes its ReviewBinding to the same package
and profile. Missing/wrong resources or replacement providers/profiles are refused.
The source extraction/check protocols remain unchanged; these data helpers grant no
execution or project qualification. Earlier experimental Resource 1/1 is not
accepted by this SDK binding; no historical development migration is supplied.
