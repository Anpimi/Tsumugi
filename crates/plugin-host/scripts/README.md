# Host / Core Compatibility Runner (`compatibility.py`)

`compatibility.py` is a Python 3.11+ script (using only the Python standard library) that runs the two primary Host + Core domain integration tests against prebuilt WebVTT and Stardew SMAPI plugin packages and a prebuilt JavaScript runtime.

## Usage

Run the script on macOS or Linux with Cargo, Git, and Rust 1.98+ installed. Set `CARGO_TARGET_DIR` to an absolute shared target directory and pass absolute paths to the prebuilt packages, expected package digests, captured Node tool tree, clean JavaScript Host tree, approved runtime descriptor, and a non-existent output directory:

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

- `--offline` is optional and forwards `--offline` to every `cargo` command. All `cargo` invocations run with `--locked`.
- Each subprocess has a 1,800-second timeout; on timeout or interruption, the runner terminates the subprocess's process session.

## Verification Pipeline

1. **Workspace & Feature Isolation**: The runner executes tests through the standalone [`compatibility/Cargo.toml`](../compatibility/Cargo.toml) workspace rather than the root workspace. Before running any test, it checks `cargo metadata --locked` to confirm that `tsumugi-core`, `tsumugi-plugin-sdk`, and `tsumugi-plugin-host` resolve to this checkout and that **zero Core features** (specifically excluding `execution-test-host`) are enabled.
2. **Package & Runtime Pin Verification**:
   - Runs `tsumugi-plugin-package inspect` on both `--webvtt-package` and `--smapi-package` and verifies that each computed `packageDigest` matches `--webvtt-digest` and `--smapi-digest`.
   - Runs `tsumugi-plugin-runtime inspect` on `--runtime-tool` and `--runtime-host` using the profile, version, and entrypoints from `--runtime-approval`, verifying that the observed `RuntimeEnvironmentDescriptor` matches the approved descriptor.
3. **End-to-End Integration Execution**: Runs two exact test functions with `--features core-adapter,javascript-conformance`:

| Domain | Integration Target | Test Function |
| --- | --- | --- |
| WebVTT | `source_adoption` | `official_source_checks_gate_atomic_adoption_revision_updates_and_reopening` |
| Stardew SMAPI (`stardew-smapi`) | `translation_validation` | `complete_translation_requires_current_scope_independent_grants_and_saved_check_proof` |

Each test exercises the full `PackageImage` → `RunnerProxy` → JavaScript Worker → Core permission, semantic check, adoption, and project reopen flow. Each target must report `1 passed, 0 failed, 0 ignored` for the exact named test; if one domain fails, the runner still executes and records the second domain before exiting.

## Output Format (`compatibility.json`) and Exit Codes

The runner writes `compatibility.json` (`schemaVersion: 1`) and full stdout/stderr logs for every command into `--output`:

- `status`: overall run status (`passed` or `failed`).
- `host`: current Git commit SHA and dirty worktree status (`host.commit`, `host.dirty`).
- `sdk`: SDK version and source metadata from Cargo.
- `consumer`: resolved `compatibility/Cargo.toml` workspace root, manifest paths, enabled features, and validation status.
- `runtime`: the approved and observed `RuntimeEnvironmentDescriptor`.
- `cases`: per-domain results including `domain`, `test`, `status`, `inspection`, `executionCounts`, and the `execution` command/fixture arguments.
- `commands`: full command lines and log file references for every executed step.

Exit codes:

- `0`: all inspections and both domain integration tests passed.
- `1`: an inspection, metadata check, or integration test failed.
- `2`: invalid CLI arguments or `--output` already exists.

## Unit Tests

The runner's own orchestration logic (argument validation, metadata feature gating, digest/descriptor mismatch handling, and test count parsing) is tested with mocked subprocess calls:

```sh
python3 -m unittest discover -s crates/plugin-host/scripts/tests -v
```
