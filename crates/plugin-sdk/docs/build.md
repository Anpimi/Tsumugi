# Build and Artifact Contracts

The SDK defines these contracts for building target files and verifying the resulting output:

- `tsumugi.build-input/2/1` (`BuildInput`)
- `tsumugi.artifact-set/2/1` (`ArtifactSet`)
- `tsumugi.artifact-check-input/2/1` (`ArtifactCheckInput`)
- `tsumugi.build-declaration/2/1` (`BuildDeclaration`)
- `tsumugi.build-error/1/1` (`BuildError`)

These contracts define the data payloads exchanged between Core and build/check plugins; release qualification and file writing remain handled by Core and the Host.

The supported schema-1 build input, artifact set and artifact-check input remain a complete text-only family. `BuildBinding` accepts that family without relabeling historical evidence, rejects mixed versions, and requires text artifacts for both its source and output. The current schema-2 family admits binary artifacts. Output evidence must match the exact captured producer declaration.

## Build Input (`BuildInput`)

`BuildInput` supplies a builder component with everything needed to render target files:

- The original `ContentExchange` (preserving original source artifacts, protected fragments, occurrence order, and opaque domain blocks).
- One finalized target text per source unit, paired with its exact source revision reference. Multiple occurrences of the same unit share that unit's target text.
- The target language wire label (canonical language support is validated by the application's locale owner).
- Optional domain configuration (`EncodedPayload` entries, up to 32 distinct schemas).
- The exact list of allowed relative output paths and output size ceilings.

Validation rejects missing, duplicate, unknown, or mismatched source revision references, and target text is never implicitly defaulted from source text. Builders receive only this self-contained input—never direct access to `ProjectStore`, SQL, local directories, candidate history, or release eligibility state.

## Output Artifacts (`ArtifactSet`) and Size Limits

`ArtifactSet` returns generated text or binary files with the fixed profile, source set ID and target language. Each artifact includes its ID, role, logical path, one exact byte representation and original-byte SHA-256 digest. See [artifact representations](exchange.md#captured-artifacts-and-source-coordinates). Output byte limits count decoded bytes; complete encoded limits also apply.

Returned paths must exactly match the expected relative paths declared in `BuildInput` (no extra paths, missing outputs, or case substitutions) and obey the portable relative-path rules:

- Maximum depth of 16 path segments; ASCII-only filenames.
- No absolute paths, `..` traversal, alternate path separators, reserved device names, or trailing dots/spaces.
- No case-insensitive path collisions or file/directory prefix collisions.

Size limits enforced by the receivers:

| Item | Limit |
| --- | --- |
| Artifacts in `ArtifactSet` | 32 files (or smaller ceiling set in `BuildInput`) |
| Path depth | 16 segments |
| Decided unit text | 16 KiB per unit |
| Distinct configuration schemas | 32 |
| Original `ContentExchange` | 4 MiB encoded (also bounded by the enclosing invocation) |
| `ArtifactSet` output | 2 MiB encoded (or smaller raw-byte ceiling set in `BuildInput`) |
| `BuildInput` / `ArtifactCheckInput` | 4 MiB encoded each |

## Artifact Verification (`ArtifactCheckInput`) and Resource Binding

`validate_build_artifacts` verifies structural consistency, path coverage, SHA-256 digests, and size limits on a returned `ArtifactSet`. Domain syntax and format validity are verified separately by passing `ArtifactCheckInput` to an independent semantic checker.

`ArtifactCheckInput` bundles the original `BuildInput`, the generated `ArtifactSet`, and mandatory, nonwaivable domain check requirements covering every generated artifact ID. Checker results use the standard `tsumugi.check-results` contract and are evaluated against Core's `FixedCheckSet`.

### `BuildDeclaration` Resource (`tsumugi.build-declaration/2/1`)

A package can declare its build pipeline in a non-executable JSON resource with schema `tsumugi.build-declaration/2/1`. The resource specifies:

- The domain `profile`.
- Separate `builder` and `checker` contribution IDs within the same package.
- Output count and byte ceilings.
- The required artifact check rules.
- `configuration`, an explicit array (empty for a recipe without choices). Each configuration declares an exact payload schema, a readable name and 1–32 named options. Each option has 1–32 uniquely identified, readable choices. No default is inferred from a source or target locale. Configuration schemas and option IDs must be unique within their owning collection; names are bounded and the complete declaration still fits 32 KiB.

`BuildDeclaration::bind` (producing a `BuildBinding`) validates the resource against the package's `ValidatedManifest` and package digest:

- The builder capability must accept `BuildInput`, return `ArtifactSet`, declare a `proposal` effect, and use `BuildError`.
- The checker capability must accept `ArtifactCheckInput`, return `tsumugi.check-results`, declare a `read-only` effect, and use `BuildError`.
- Both capabilities may request only `captured-input` permissions and must accommodate the declared payload ceilings.

`PackageImage` reads the `BuildDeclaration` resource directly from the package archive without executing plugin code.

`BuildDeclaration::capture_configuration` resolves complete `BuildConfigurationSelection` values against those declarations and returns the existing `EncodedPayload` objects in declaration order. Each payload uses `BuildConfigurationValues` JSON, for example `{"selections":[{"id":"loading-language","value":"english"}]}`, and the ordinary payload digest. The setting's meaning and supported IDs belong to the package; a loading-language choice can differ from the translation locale. Missing, duplicate, unknown or extra selections, changed schema versions, invalid payloads and undeclared configuration payloads are rejected by `BuildBinding::validate_input` before dispatch. The selected values, paths and original bytes become part of the same fixed build input; capturing choices neither changes application settings nor grants execution permission.

`parse_build_declaration_for_contract` also reads resource `1/1` when selected by that exact immutable manifest reference. Its body omits `configuration` and retains its original serialization and opaque configuration semantics. Current `2/1` authoring requires a non-null array; an older body cannot claim the new profile, and unknown resource generations are rejected. This resource version is independent of the build input and artifact payload family.

## CLI and Code Generation

JSON Schemas, TypeScript declarations, and standalone JavaScript validators are generated from the Rust definitions:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-build-declaration crates/plugin-sdk/tests/fixtures/build.declaration.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-build-input
node crates/plugin-sdk/scripts/generate-contracts.mjs
```

`BuildError` uses a finite set of error classifications and bounded detail strings; error diagnostics must not include user content, local filesystem paths, or secrets. See the [SDK README](../README.md) for general build and consumption details.
