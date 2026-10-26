# `tsumugi-plugin-sdk`

`tsumugi-plugin-sdk` (`0.1.0-alpha.1`) is the experimental Rust contract library, conformance CLI, and JavaScript codegen package for Tsumugi plugins. It defines data schemas, semantic validators, and an optional native Rust worker entrypoint without depending on Core, SQLite, or the desktop application.

By default, the crate is data-only: it validates manifests and payloads and computes digests, while package installation, process management, and runtime authorization belong to the Host and application layers. Building this crate requires Rust 1.98 or newer.

## Contract Documentation

Protocol versions (`1` for manifests, content exchange, and runtime environments; `3` for the local process transport) are versioned independently of the crate's SemVer (`0.1.0-alpha.1`).

- **[Plugin Declarations](docs/declarations.md)**: `PluginManifest` structure, component scopes (`application`, `project`, `attempt`), capability compatibility predicates (`ValidatedManifest::diagnose_capability`), provider bindings (`bind_capability`, `ProviderSelectionBinding`, `ProviderBinding`), and [component dependency closure diagnostics](docs/declarations.md#component-dependency-closure-diagnostics).
- **[Content & Invocation Exchange](docs/exchange.md)**: `ExchangeDocument` envelopes, the three-layer `ContentExchange` model, Unicode text range conversions (`utf8-byte`, `utf16`, `grapheme`), `InvocationRequest` / `receive_invocation_result` channel matching, and `FixedCheckSet` coverage evaluation.
- **[Local Process Protocol](docs/process.md)**: Protocol 3 length-prefixed framing, `ProcessActivation` multi-capability rosters (up to 128 capabilities per `ComponentInstanceBinding`), project service bindings, and the JavaScript `ComponentAPI` (`api.instance`, `api.contributions`, `api.register(contributionId, handler)`).
- **[Rust Native Components](docs/native-worker.md)**: The optional `native-worker` Cargo feature (`NativeComponent` and `serve_native_component`) for serving single-capability native workers over stdio using the standard library.
- **[Runtime Environments](docs/environment.md)**: `RuntimeEnvironmentDescriptor` (`node-system-libraries-v1` on `macos`, `linux`, and `windows`), `NativeHostEnvironmentDescriptor` (`native-application-host-v1` on macOS and Linux), `ExecutionEnvironmentDescriptor`, and deterministic artifact/environment SHA-256 digests.
- **[Source Extraction](docs/source-extraction.md)**: `SourceExtractionInput`, `SourceExtractionCheckInput`, `SourceExtractionError`, and package-owned `SourceImportDeclaration` resources (`tsumugi.source-import-declaration/2/2` with required `reviewResource` bindings).
- **[Source Context Facts](docs/source-context.md)**: Optional `tsumugi.source-context-facts/1/1` domain blocks for attaching extracted or inferred speaker, role, scene, time, location, and note facts with Unicode source ranges.
- **[Existing Translation Import](docs/translation-import.md)**: `TranslationExtractionInput`, `TranslationExchange`, `TranslationExtractionCheckInput`, and `TranslationImportDeclaration` resources (`1/1`).
- **[Domain & Advisory Text Review](docs/review.md)**: Format-specific mandatory checks (`ReviewDeclaration`, `ReviewCheckInput`, `ReviewCheckError`) and format-independent advisory text checks (`TextReviewDeclaration`, `TextReviewCheckInput`, `TextReviewCheckReport`).
- **[Build & Artifact Verification](docs/build.md)**: `BuildInput`, `ArtifactSet`, `ArtifactCheckInput`, `BuildDeclaration`, and `BuildError` (`1/1`) for generating and verifying target text files.
- **[Read-Only Capability Tools](docs/tools.md)**: `CapabilityToolDeclaration` (`1/1`), `reference-query` UI slot bindings, and structured query template helpers (`createToolQuery` and `ToolQueryDeclaration::prepare_payload`).
- **[Work-Plan Generation Service](docs/generation.md)**: `tsumugi.work-plan-generation` (`GenerationServiceInput`, `GenerationServiceReceipt`, `GenerationServiceError`) and `tsumugi.generation-component-input` for invoking prepared read-only tools before enqueuing generation tasks.

The JSON files under [`tests/fixtures`](tests/fixtures) are synthetic conformance fixtures (using `example.*` schema and capability names) for testing parsers and validators.

## Building and Consuming the SDK

From the repository root, you can test and build the SDK standalone:

```sh
cargo test -p tsumugi-plugin-sdk --locked
cargo test -p tsumugi-plugin-sdk --all-features --locked
cargo build -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract --locked
```

- Default features include only the data contracts and semantic validators.
- The `schema` feature enables JSON Schema generation and builds the `tsumugi-plugin-contract` CLI.
- The `native-worker` feature enables the stdio framing and lifecycle runner for Rust worker binaries.

### Consuming from Rust

To depend on a verified SDK directory or an unpacked `cargo package -p tsumugi-plugin-sdk --locked` archive from an external Rust crate:

```toml
[dependencies]
tsumugi-plugin-sdk = { path = "/absolute/path/to/verified/tsumugi-plugin-sdk", version = "=0.1.0-alpha.1" }
```

Because `tsumugi-plugin-sdk` is not published to `crates.io` and `0.1.0-alpha.1` has been used across multiple source snapshots, consumers should pin the exact commit or archive digest rather than relying on the version string alone. When packaging with `cargo package -p tsumugi-plugin-sdk --locked`, Cargo normalizes workspace-inherited fields so the unpacked crate builds standalone with its own lockfile (use `--offline` only when a Cargo registry cache is already populated).

Minimal manifest validation example:

```rust
use tsumugi_plugin_sdk::{SDK_VERSION, parse_manifest};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("Pass a manifest path")?;
    let validated = parse_manifest(&std::fs::read(path)?)?;
    println!("SDK {SDK_VERSION}: {}", validated.manifest().plugin.id);
    Ok(())
}
```

### Consuming Checked-In JavaScript Modules

The generated ESM validators and TypeScript declarations in `javascript/` have zero external runtime dependencies and can be imported directly in Node `>=26.10.0 <27` (keep the entire `javascript/` directory intact when copying):

```sh
node --input-type=module -e "import validate from './javascript/validate-source-extraction-input.mjs'; import { readFileSync } from 'node:fs'; if (!validate(JSON.parse(readFileSync('tests/fixtures/source-extraction.input.json', 'utf8')))) process.exit(1);"
```

Note that JavaScript validators check JSON Schema structure on parsed objects; the Rust receivers additionally enforce duplicate-key rejection, SHA-256 digests, cross-field references, and UTF-8 byte budgets.

## Maintaining Schemas and Generated Bindings

The Rust/Serde types are the single source of truth for all schemas. The `tsumugi-plugin-contract` CLI emits JSON Schemas via `schema-<kind>` (or `schema` for the plugin manifest) and verifies checked-in files via `check-<kind>-schema` (or `check-schema`).

### Regenerating Schemas and JavaScript Validators

After updating Rust contract types, refresh the JSON schemas in `schemas/` and run the codegen script. The generator uses the `@tsumugi/plugin-sdk-tooling` workspace package (which pins Ajv and `json-schema-to-typescript`):

```sh
pnpm install --frozen-lockfile --filter @tsumugi/plugin-sdk-tooling
node crates/plugin-sdk/scripts/generate-contracts.mjs
node crates/plugin-sdk/scripts/generate-contracts.mjs --check
TSUMUGI_PLUGIN_CONTRACT="$PWD/target/debug/tsumugi-plugin-contract" node --test crates/plugin-sdk/tests/*.test.mjs
```

`generate-contracts.mjs` runs Cargo in `--locked --offline` mode to verify that all committed files in `schemas/` match the Rust definitions before emitting standalone `.mjs` validators and `.d.ts` declarations into `javascript/`. Ensure the Rust crate has been built first so Cargo's cache is populated, and adjust `TSUMUGI_PLUGIN_CONTRACT` if `CARGO_TARGET_DIR` is customized.

### Conformance CLI Examples

Manifest schema generation and validation:

```sh
cargo test -p tsumugi-plugin-sdk --features schema --locked
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema > crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-schema crates/plugin-sdk/schemas/plugin-manifest.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate crates/plugin-sdk/tests/fixtures/smapi.manifest.json
```

Content exchange, invocation result matching, and check coverage evaluation:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-exchange > crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-exchange-schema crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-exchange crates/plugin-sdk/tests/fixtures/webvtt.content.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- match-result crates/plugin-sdk/tests/fixtures/invocation.request.json crates/plugin-sdk/tests/fixtures/invocation.result.json crates/plugin-sdk/tests/fixtures/invocation.channel.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-coverage crates/plugin-sdk/tests/fixtures/checks.set.json crates/plugin-sdk/tests/fixtures/checks.results.json
```
