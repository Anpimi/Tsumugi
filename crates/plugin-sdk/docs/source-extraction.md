# Source Extraction Contracts

Source extraction runs over the standard invocation and process transport using five payload contracts (versioned independently of the SDK's SemVer):

| Payload Type | Contract ID | Schema / Behavior |
|---|---|---|
| `SourceExtractionInput` | `tsumugi.source-extraction-input` | `1 / 1` |
| `ContentExchange` | `tsumugi.content-exchange` | `2 / 1` |
| `SourceExtractionError` | `tsumugi.source-extraction-error` | `1 / 1` |
| `SourceExtractionCheckInput` | `tsumugi.source-extraction-check-input` | `1 / 1` |
| `CheckResult[]` | `tsumugi.check-results` | `1 / 1` |

The SDK exports these contract identifiers alongside the helper constructors `source_extraction_input_contract`, `content_exchange_contract`, and `source_extraction_error_contract`.

## Extraction Input and Proposed `ContentExchange`

`SourceExtractionInput` provides an extractor component with:

- `profile`: the target domain profile (`ContractRef`).
- `sourceSetId` and `sourceLanguage` (wire label validated by the SDK; canonical language support is checked by the application's locale owner).
- `artifacts`: up to 2,000 source files (bounded to 2 MiB total and 2 MiB for the entire encoded `SourceExtractionInput`), each carrying a unique artifact ID, safe relative logical path, role, exact UTF-8 string (preserving BOMs, line endings, combining marks, and emoji), and SHA-256 digest.

`SourceExtractionInput::validate` and `ContentExchange::validate` share the same artifact validator to enforce size limits, unique IDs and paths, portable relative path rules, and exact SHA-256 byte digests.

### Validating Extraction Proposals (`validate_source_extraction`)

`validate_source_extraction(input, exchange)` verifies both the input and the proposed `ContentExchange` (schema/behavior `2/1`) and checks that:

- The proposal matches the input's `profile`, `sourceSetId`, `sourceLanguage`, and complete artifact set (artifact array order may differ; occurrence ordering is defined explicitly by `ContentExchange.order`).
- Every occurrence and protected fragment range lands on valid Unicode boundaries within its referenced artifact or unit text.
- Every unit provides required `NativeIdentityEvidence`:
  - `value`: the domain's canonical matching key (used as-is by Core without additional normalization or case-folding).
  - `display`: the original spelling and source range in the artifact, or `null` for derived identities.

Unit IDs and `sourceRevisionId` values in an extraction output are operation-local proposal references; Core allocates persistent project unit and revision IDs when adopting the extraction.

### Semantic Source Revision Policy (`SourceRevisionPolicy`)

Before running extraction, the policy owner captures a `SourceRevisionPolicy` specifying which `DomainBlock` schema/behavior IDs contribute their opaque UTF-8 payload bytes to semantic source revision hashing alongside decoded unit text and protected fragments.

## Package-Owned Source Import Declarations (`tsumugi.source-import-declaration/2/2`)

A plugin package can bundle a non-executable JSON resource with schema `tsumugi.source-import-declaration/2/2` (`SourceImportDeclaration`, up to 32 KiB) to declare a self-contained source import pipeline:

- `displayName` and exact domain `profile`.
- `materials`: an ordered list of 1 to 32 fixed relative files (each with a literal `logicalPath` up to 16 segments, `role`, and `maxBytes`, up to 2 MiB aggregate across all materials). No globs, optional files, or discovery scripts are permitted, and case-insensitive path aliases or file/directory overlaps are rejected.
- `extractor` and `checker`: distinct capability contribution IDs in the same package.
- `reviewResource`: the contribution ID of a [`ReviewDeclaration`](review.md) resource (`tsumugi.review-declaration/1/1`) in the same package.
- `revisionPolicy` (`SourceRevisionPolicy`) and a non-empty list of mandatory `semanticRules`.

`SourceImportDeclaration::bind` (using `parse_source_import_declaration`) validates the declaration against the package's `ValidatedManifest`, package digest, and captured `ReviewDeclaration`:

- Both `extractor` and `checker` must support the declared `profile` and the SDK's source extraction input/output/error contracts, and may request only `captured-input` permissions.
- The `checker` capability must be `read-only` and distinct from `extractor`.
- The referenced `reviewResource` is bound into a `ReviewBinding` fixed to the same package and profile (earlier `1/1` source-import resources without `reviewResource` are rejected).

The Host reads `SourceImportDeclaration` directly from the immutable `PackageImage` without executing plugin code.

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-import-declaration
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-source-import-declaration-schema crates/plugin-sdk/schemas/source-import-declaration.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-source-import-declaration crates/plugin-sdk/tests/fixtures/source-import.declaration.json
```

## Independent Source Checks (`SourceExtractionCheckInput`)

Because `validate_source_extraction` checks structural and coordinate integrity rather than domain format grammar, extracted proposals are verified by an independent semantic checker capability before adoption.

`SourceExtractionCheckInput` (up to 4 MiB encoded; `source` and `proposal` each retain their 2 MiB ceiling) bundles:

- `source`: the original `SourceExtractionInput`.
- `proposal`: the extractor's `ContentExchange`.
- `requirements`: non-empty, mandatory, non-waivable plugin check requirements targeting `sourceSetId` and pinned to the checker's `ProviderSelectionBinding`.

The checker returns `CheckResult[]` (`tsumugi.check-results`), which Core combines with its built-in checks and evaluates via `FixedCheckSet::evaluate`.

## Error Contract (`SourceExtractionError`)

`SourceExtractionError` (up to 32 KiB encoded) carries:

- `code`: one of `invalid-input`, `unsupported-profile`, `invalid-source`, `unsupported-structure`, `limit-exceeded`, or `cancelled`.
- `artifactId`: nullable ID referencing an artifact from `SourceExtractionInput`.
- `detail`: a non-empty UTF-8 description (up to 4,096 bytes, containing no NUL bytes). Error details must not expose local filesystem paths, raw user source text, or secrets.

## Generated JavaScript Types and Standalone Validators

From the Rust definitions, the SDK emits:

- Standalone JSON Schemas (`source-extraction-input.schema.json`, `source-extraction-error.schema.json`, `source-extraction-check-input.schema.json`, `check-results.schema.json`) and the build-time type catalog `content-types.schema.json`.
- TypeScript declarations in [`javascript/content.d.ts`](../javascript/content.d.ts).
- Zero-dependency standalone Ajv structural validators in `javascript/validate-source-extraction-input.mjs` and `javascript/validate-source-extraction-check-input.mjs` (preserving the SDK's [MIT license](../LICENSE) and the pinned Ajv emitter's MIT license header).

Because `JSON.parse` silently overwrites duplicate object keys and JSON Schema does not verify SHA-256 digests or UTF-8 byte budgets, the Host always validates raw wire payloads through the Rust receivers (`parse_content_exchange`, `parse_source_extraction_check_input`, `parse_check_results`).

To regenerate and test the schemas and JavaScript bindings from the repository root:

```sh
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-exchange > crates/plugin-sdk/schemas/content-exchange.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-extraction-input > crates/plugin-sdk/schemas/source-extraction-input.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-extraction-error > crates/plugin-sdk/schemas/source-extraction-error.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-source-extraction-check-input > crates/plugin-sdk/schemas/source-extraction-check-input.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-check-results > crates/plugin-sdk/schemas/check-results.schema.json
cargo run --locked --offline -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-content-types > crates/plugin-sdk/schemas/content-types.schema.json
node crates/plugin-sdk/scripts/generate-contracts.mjs
node crates/plugin-sdk/scripts/generate-contracts.mjs --check
cargo test --locked --offline -p tsumugi-plugin-sdk --features schema
TSUMUGI_PLUGIN_CONTRACT="$PWD/target/debug/tsumugi-plugin-contract" node --test crates/plugin-sdk/tests/source-extraction.test.mjs
```

The `tsumugi-plugin-contract` CLI also provides `validate-source-extraction-input`, `validate-source-extraction-error`, and `match-source-extraction <input.json> <exchange.json>` (where `<exchange.json>` is wrapped in an `ExchangeDocument`).
