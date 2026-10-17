# Host/Core compatibility runner

`compatibility.py` is a Python 3.11+ standard-library entry point for two existing
Host/Core integration tests. It uses an explicitly selected prebuilt WebVTT package
and SMAPI package. It does not build plugins or the JavaScript component Host,
install packages, download a runtime, or substitute another domain implementation.

Run from any directory on macOS or Linux with Cargo, Git and the repository's
Rust toolchain available. Supply independently approved package digests and the
tool/Host trees plus approval descriptor used by the existing runtime fixture:

```sh
export CARGO_TARGET_DIR=/absolute/path/to/shared-cargo-target
python3 crates/plugin-host/scripts/compatibility.py \
  --webvtt-package /absolute/path/to/prebuilt-webvtt \
  --webvtt-digest '<approved-WebVTT-packageDigest>' \
  --smapi-package /absolute/path/to/prebuilt-smapi \
  --smapi-digest '<approved-SMAPI-packageDigest>' \
  --runtime-tool /absolute/path/to/captured-node-tool \
  --runtime-host /absolute/path/to/prebuilt-javascript-host \
  --runtime-approval /absolute/path/to/approved-runtime-descriptor.json \
  --output /absolute/path/to/new-results-directory \
  --offline
```

The script finds its own checkout. `CARGO_TARGET_DIR` must be explicitly set to
an absolute shared cache path; the output directory must be new. `--offline` is
optional and applies to every Cargo invocation. All Cargo commands use
`--locked`. A command has a 1,800-second limit; timeout/interruption terminates
only its owned process session. Each integration test also retains its original
bounded Worker and temporary-project cleanup.

The two test targets belong to the independent
[`compatibility/Cargo.toml`](../compatibility/Cargo.toml) workspace, which refers
to the original test files and their support modules without copying them. It
depends on the normal Core and the Host's `core-adapter` feature. Before dispatch,
locked Cargo metadata must identify this checkout's exact Core, SDK and Host
manifests and show **no enabled Core features**. Missing or inconsistent metadata
refuses dispatch; neither case is marked as executed. This isolates the Host
package's own development dependency on `execution-test-host`.

Before starting either test, the runner calls this checkout's public
`tsumugi-plugin-package inspect` for both packages and checks each observed
`packageDigest` against its supplied pin. It calls `tsumugi-plugin-runtime
inspect` using the supplied descriptor's profile, version and entrypoints, then
requires the complete observed descriptor to equal that approval. The original
Rust capture owners perform the package/runtime byte checks. Inspection itself
is not Worker evidence or distribution approval.

The two fixed selections use the consumer workspace's local
`core-adapter,javascript-conformance` cfg features; these do not enable the Core
test feature:

| Domain | Integration target | Exact test |
| --- | --- | --- |
| WebVTT | `source_adoption` | `official_source_checks_gate_atomic_adoption_revision_updates_and_reopening` |
| Stardew SMAPI (`stardew-smapi`) | `translation_validation` | `complete_translation_requires_current_scope_independent_grants_and_saved_check_proof` |

These are the actual `PackageImage` prebuilt-package → `RunnerProxy` → Worker → Core grant,
semantic-check, adoption and reopen consumers. The script does not copy their
fixtures, checks, runtime or domain algorithms. Each selection must report
exactly one executed test with its exact name, one pass and no failure, ignored
test or measurement. Other tests filtered out of the integration target are
reported normally. An empty filtered run cannot pass. A failure in one case
does not hide the other runnable case's result.

`compatibility.json` has `schemaVersion: 1`, an overall `status`, the actual
`host.commit`/`host.dirty`, SDK Cargo/source declarations, the approved and
observed runtime descriptor, both `cases` and every attempted `commands` entry.
The `consumer` entry records its metadata command, resolved workspace root,
exact owner manifest paths, enabled features and validation status.
Each case records `domain`, `test` (the exact function name), `status`, the real
package `inspection` and, when libtest ran, `executionCounts`. `execution`
retains its command and five explicit fixture selectors. Complete stdout and
stderr logs are retained for inspections, metadata and tests, including failures.
Exit zero means both consumers passed; exit one means an incomplete or failed
run; exit two refuses an existing output directory or invalid CLI usage.

SDK producer fields describe tracked source in this checkout. A dirty checkout
is recorded as dirty, and its commit does not identify those uncommitted bytes.
Package/runtime fingerprints identify captured bytes; neither they nor a Host
checkout declaration authenticate a publisher or prove which source commit
produced the prebuilt JavaScript Host. Its tool version/profile remain installer
claims. This runner does not establish PackageStore installation, Desktop IPC/GUI behavior, sandboxing, all
platforms, model quality, broad release compatibility or production permission.

The orchestration tests use a fake command boundary and do not start Cargo or
Workers. They verify exact selection, refusal of empty/ignored runs, pin and
runtime mismatches, retained failure evidence and separate domain results:

```sh
python3 -m unittest discover -s crates/plugin-host/scripts/tests -v
```

Those Python checks alone are not package/runtime compatibility evidence.
