# Build and Artifact Contracts

The SDK defines five schema/behavior `1/1` contracts for building target files and verifying the resulting output:

- `tsumugi.build-input` (`BuildInput`)
- `tsumugi.artifact-set` (`ArtifactSet`)
- `tsumugi.artifact-check-input` (`ArtifactCheckInput`)
- `tsumugi.build-declaration` (`BuildDeclaration`)
- `tsumugi.build-error` (`BuildError`)

These contracts define the data payloads exchanged between Core and build/check plugins; release qualification and file writing remain handled by Core and the Host.

## Build Input (`BuildInput`)

`BuildInput` supplies a builder component with everything needed to render target files:

- The original `ContentExchange` (preserving original source artifacts, protected fragments, occurrence order, and opaque domain blocks).
- One finalized target text per source unit, paired with its exact source revision reference. Multiple occurrences of the same unit share that unit's target text.
- The target language wire label (canonical language support is validated by the application's locale owner).
- Optional domain configuration (`EncodedPayload` entries, up to 32 distinct schemas).
- The exact list of allowed relative output paths and output size ceilings.

Validation rejects missing, duplicate, unknown, or mismatched source revision references, and target text is never implicitly defaulted from source text. Builders receive only this self-contained input—never direct access to `ProjectStore`, SQL, local directories, candidate history, or release eligibility state.

## Output Artifacts (`ArtifactSet`) and Size Limits

`ArtifactSet` returns the generated UTF-8 files along with the fixed profile, source set ID, and target language. Each artifact includes its ID, role, logical path, UTF-8 string (preserving BOMs and line endings), and recomputed SHA-256 digest. Only UTF-8 text artifacts are supported.

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
| Original `ContentExchange` | 2 MiB encoded |
| `ArtifactSet` output | 2 MiB encoded (or smaller raw-byte ceiling set in `BuildInput`) |
| `BuildInput` / `ArtifactCheckInput` | 4 MiB encoded each |

## Artifact Verification (`ArtifactCheckInput`) and Resource Binding

`validate_build_artifacts` verifies structural consistency, path coverage, SHA-256 digests, and size limits on a returned `ArtifactSet`. Domain syntax and format validity are verified separately by passing `ArtifactCheckInput` to an independent semantic checker.

`ArtifactCheckInput` bundles the original `BuildInput`, the generated `ArtifactSet`, and mandatory, nonwaivable domain check requirements covering every generated artifact ID. Checker results use the standard `tsumugi.check-results` contract and are evaluated against Core's `FixedCheckSet`.

### `BuildDeclaration` Resource (`tsumugi.build-declaration/1/1`)

A package can declare its build pipeline in a non-executable JSON resource with schema `tsumugi.build-declaration/1/1`. The resource specifies:

- The domain `profile`.
- Separate `builder` and `checker` contribution IDs within the same package.
- Output count and byte ceilings.
- The required artifact check rules.

`BuildDeclaration::bind` (producing a `BuildBinding`) validates the resource against the package's `ValidatedManifest` and package digest:

- The builder capability must accept `BuildInput`, return `ArtifactSet`, declare a `proposal` effect, and use `BuildError`.
- The checker capability must accept `ArtifactCheckInput`, return `tsumugi.check-results`, declare a `read-only` effect, and use `BuildError`.
- Both capabilities may request only `captured-input` permissions and must accommodate the declared payload ceilings.

`PackageImage` reads the `BuildDeclaration` resource directly from the package archive without executing plugin code.

## CLI and Code Generation

JSON Schemas, TypeScript declarations, and standalone JavaScript validators are generated from the Rust definitions:

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-build-declaration crates/plugin-sdk/tests/fixtures/build.declaration.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-build-input
node crates/plugin-sdk/scripts/generate-contracts.mjs
```

`BuildError` uses a finite set of error classifications and bounded detail strings; error diagnostics must not include user content, local filesystem paths, or secrets. See the [SDK README](../README.md) for general build and consumption details.
