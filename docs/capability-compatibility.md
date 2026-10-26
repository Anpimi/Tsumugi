# Inspect capability declaration compatibility

You can use `tsumugi-plugin-package diagnose` to check whether a prebuilt plugin package matches the exact capability contract and profile your consumer expects. The command uses the same SDK matcher that handles runtime provider resolution. Matching package versions or structurally valid JSON alone do not guarantee compatibility.

From a matching Tsumugi source checkout, you can test the prebuilt WebVTT package from the [authoring walkthrough](plugin-authoring.md):

```sh
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- \
  diagnose /absolute/path/to/prebuilt-webvtt \
  '{"contributionId":"extract-source","contract":{"id":"webvtt.extract","schemaVersion":1,"behaviorVersion":1},"profile":{"id":"webvtt-captions","schemaVersion":1,"behaviorVersion":1}}'
```

Always pass the expected values from the consuming contract or workbench rather than copying the package's own declaration (which would only compare the package against itself). Keep the target package and your SDK/Host checkout fixed while investigating version mismatches.

### Request format

The final argument is a UTF-8 JSON object up to 4,096 bytes containing:

- `contributionId`: The target contribution identifier.
- `contract`: An object with `id` and positive integers for `schemaVersion` and `behaviorVersion`.
- `profile` (optional): An object with `id`, `schemaVersion`, and `behaviorVersion`. Omitting `profile` or setting it to `null` requests an unprofiled capability rather than defaulting to one of the package's declared profiles.

Include only non-secret declaration metadata. The tool rejects unknown or duplicate fields, invalid identifiers, malformed JSON, and oversized inputs before reading the package directory.

## Results and exit status

When diagnosis runs, it prints a single JSON object with two top-level fields:

- `package`: The standard five-field package summary (`plugin`, `packageDigest`, `manifestSha256`, `fileCount`, `byteCount`).
- `compatibility`: Your `request`, the resulting `status`, the owning `componentId`, `declaredContract`, and all `declaredProfiles`. When a component or contract is unavailable, those fields are `null`.

Both sections are produced from a single immutable read of the package directory. Directory limits and fingerprints work the same way as in [ordinary inspection](../crates/plugin-host/README.md#captured-package-and-actual-channel).

| Exit code | Meaning |
|---|---|
| `0` | Diagnosis succeeded and the capability declaration and profile match. |
| `2` | Diagnosis succeeded, but the declaration or profile does not match. Check `status` and the declared values in the JSON output. |
| `1` | Invalid request, unsupported arguments, or failed package read. An error is printed to stderr and no JSON output is produced. |

Note that `cargo run` itself can return exit code `1` if compilation fails. If you are scripting against these exit codes, build the binary first with `cargo build --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package` and invoke the compiled executable directly. The standard `inspect <prebuilt-directory>` subcommand retains its existing output format and exit codes.

| Diagnostic status | Meaning |
|---|---|
| `compatible` | The declared contract and requested profile match. |
| `contribution-missing` | The requested `contributionId` does not exist in the manifest. |
| `not-callable` | The contribution exists, but it is not a callable capability. |
| `contract-id-mismatch` | The capability declares a different contract ID. |
| `contract-schema-mismatch` | Contract IDs match, but `schemaVersion` differs. |
| `contract-behavior-mismatch` | Contract IDs and `schemaVersion` match, but `behaviorVersion` differs. |
| `profile-required` | The capability declares profiles, but the request omitted `profile`. |
| `profile-unsupported` | The requested profile is not among the capability's declared profiles. |

For example, if you keep `webvtt.extract` at `schemaVersion: 1` but request `behaviorVersion: 2` against the example package's `1`/`1` declaration, the tool returns `contract-behavior-mismatch` even if the JSON schemas are identical. All declared profiles are listed in the output without picking a fallback or nearest version. To resolve a mismatch, update the consumer's expectation or use a package that implements the target version—bumping version numbers in the manifest alone does not make a plugin compatible with a new behavior contract.

## Scope of the check

`diagnose` only verifies the capability's contract and profile declarations. If the package uses an unsupported manifest protocol, reading the package fails before a compatibility report can be generated.

This check is purely static: it does not execute plugin code or installation scripts, and it does not modify the package store, installations, execution grants, or project data. Input/output/error schema validation, SDK artifact provenance, process protocol compatibility, runtime availability, and domain semantics are verified separately. For details, see [SDK declarations](../crates/plugin-sdk/docs/declarations.md) and [authoring support boundaries](plugin-authoring.md#compatibility-and-support-boundary).
