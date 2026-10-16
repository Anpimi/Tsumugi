# Inspect capability declaration compatibility

Use the public package tool to compare a prebuilt package with the exact
capability contract and profile expected by your consumer. The SDK's existing
matcher owns both provider resolution and these diagnostics. A package SemVer
or structurally valid JSON does not establish a match.

From the matching Tsumugi source snapshot, this example checks the independently
built WebVTT package from the [authoring walkthrough](plugin-authoring.md):

```sh
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- \
  diagnose /absolute/path/to/prebuilt-webvtt \
  '{"contributionId":"extract-source","contract":{"id":"webvtt.extract","schemaVersion":1,"behaviorVersion":1},"profile":{"id":"webvtt-captions","schemaVersion":1,"behaviorVersion":1}}'
```

Supply the expected values from the consuming contract or workbench. Copying a
package's own declaration into the request only compares that declaration to
itself. Keep the selected package and matching SDK/Host snapshot fixed while
investigating a version difference.

The last argument is a UTF-8 JSON value bounded to 4,096 bytes. It has
`contributionId`, `contract` and an optional `profile`. Contract/profile values
contain `id`, positive `schemaVersion` and positive `behaviorVersion`. Use only
non-secret declaration metadata. Unknown or duplicate typed fields, invalid
identifiers, malformed input and excess bytes are refused before package capture.
An omitted or null profile requests an unprofiled capability; it does not choose
one of the package's profiles.

## Results and exit status

Successful diagnosis writes one JSON object containing:

- `package`: the original five-field inspection (`plugin`, `packageDigest`,
  `manifestSha256`, `fileCount`, `byteCount`).
- `compatibility`: the complete independent `request`, a `status`, the owning
  `componentId`, `declaredContract` and all `declaredProfiles`. Unavailable
  component/contract values are explicit nulls.

Both parts describe one immutable capture. The tool reuses the original bounded
directory reader and does not reopen a source manifest to assemble a second
observation. Capture limitations and fingerprints have the same meaning as
[ordinary inspection](../crates/plugin-host/README.md#captured-package-and-actual-channel).

| Exit code | Meaning |
|---|---|
| `0` | Diagnosis completed and the capability declaration/profile matches. |
| `2` | Diagnosis completed and the declaration/profile does not match; inspect the JSON status and declared values. |
| `1` | Invalid request, unsupported arguments or failed package capture; an error is written to stderr. No diagnostic JSON is produced. |

`cargo run` can itself fail before the tool starts. To consume the tool's exit
codes directly, build it once with `cargo build --locked -p tsumugi-plugin-host
--bin tsumugi-plugin-package` and invoke the actual binary in your Cargo target.
The existing `inspect <prebuilt-directory>` command keeps its original output
and exit behavior.

| Diagnostic status | Meaning |
|---|---|
| `compatible` | Exact contract and requested profile match. |
| `contribution-missing` | The requested contribution ID is absent. |
| `not-callable` | That contribution exists but is not a callable capability. |
| `contract-id-mismatch` | The callable declares a different contract ID. |
| `contract-schema-mismatch` | Contract IDs match, but schema versions differ. |
| `contract-behavior-mismatch` | Contract IDs and schema versions match, but behavior versions differ. |
| `profile-required` | The callable declares profiles and the request selected none. |
| `profile-unsupported` | The exact requested profile is absent from the declared profiles. |

For example, keeping `webvtt.extract` schema version 1 but requesting behavior
version 2 reports `contract-behavior-mismatch` against the example's 1/1
declaration. Identical JSON field types cannot erase that difference. The report
retains all declared profiles without selecting a first or nearest version.
Correct the consumer expectation or use an actually matching implementation;
changing declaration numbers alone cannot implement another behavior contract.

## Scope of the check

This operation checks the selected capability's contract and profile references.
Input/output/error schema compatibility, SDK artifact provenance, process
protocol, runtime availability, domain semantics and real Host execution require
their respective checks. An unsupported manifest protocol fails during strict
package capture before a compatibility report exists. See the
[SDK declarations](../crates/plugin-sdk/docs/declarations.md) and
[authoring support boundaries](plugin-authoring.md#compatibility-and-support-boundary).

Inspection starts no component or installation script and creates no Store,
installation, execution grant or project mutation. A `compatible` result is a
declaration diagnosis; installation, current environment selection and each
execution still use their original independent approval boundaries.
