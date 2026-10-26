# `tsumugi-plugin-host`

`tsumugi-plugin-host` is the Rust runtime host for Tsumugi plugins. Built on the [Plugin SDK](../plugin-sdk/README.md), it provides:

- **Package & Runtime Inspection**: `PackageImage` archive verification, capability compatibility diagnostics, and runtime tree hashing (`tsumugi-plugin-package` and `tsumugi-plugin-runtime` CLIs).
- **Local Package Store & Offline Repositories**: `PackageStore` for managing installed package/runtime archives and user approval state, plus offline TUF repository and Pack verification powered by `tough`.
- **Worker Process & Service Channels**: `ProcessSession` and `ProjectServiceBroker` for spawning and communicating with native Rust workers and [JavaScript component Host](../../runtimes/javascript-host/README.md) workers over stdio using process protocol 3.
- **Optional Core & Member Adapters (`core-adapter`)**: `core::RunnerProxy`, `core::ApplicationInstance`, and `member::run_member` for bridging plugin workers and the [internal Pi member runtime](../../runtimes/agent-service/README.md) into `tsumugi-core`.

By default, `tsumugi-plugin-host` builds without `tsumugi-core`, SQLite, or model provider dependencies. Versioning boundaries between the application and the SDK are documented in [the versioning policy](../../docs/versioning.md).

## Building and Inspecting Packages

Requires Rust 1.98 or newer. From the repository root:

```sh
cargo build -p tsumugi-plugin-host --bins --locked
cargo test -p tsumugi-plugin-host --locked
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect /absolute/prebuilt-package
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect-archive < /absolute/candidate.tar
```

- `tsumugi-plugin-package inspect` / `inspect-archive` reads a directory or tar stream into a `PackageImage` and prints the package identity, file digests, and validated manifest declarations without executing plugin code.
- `tsumugi-plugin-package diagnose <directory> <request-json>` evaluates an inline JSON `CapabilityCompatibilityRequest` against the package. It exits with `0` if compatible, `2` if the requested contract or profile does not match, and `1` on malformed input or archive errors.
- `tsumugi-plugin-runtime inspect <tool-directory> <host-directory> <request.json>` hashes prebuilt Node tool and JavaScript Host directory trees against a `RuntimeInspectionRequest` and outputs the resulting `RuntimeEnvironmentDescriptor`.

Note: `tsumugi-plugin-host` depends on the workspace's `tsumugi-plugin-sdk` crate and the vendored, patched `tough` crate (see [`third_party/tough/PATCHES.md`](../../third_party/tough/PATCHES.md)). Use `--offline` only after populating Cargo's dependency cache.

## Captured package and actual channel

### `PackageImage` and `PackageStore`

`PackageImage` validates the entire plugin archive before staging: it checks portable relative paths, file counts, byte ceilings, executable flags, and declared contribution owners, and reads `Resource` and `Skill` files strictly as inert data. Deserialized capability, tool, or UI bindings are always re-verified against the immutable `PackageImage` rather than trusted from wire data.

`PackageStore` manages installed package and runtime archives alongside user approval and enable/disable state in a dedicated local directory (separate from project SQLite databases). Installing or updating a package in `PackageStore` never mutates an already-running worker process; active sessions retain their original immutable `PackageImage` and digests.

### Signed offline repositories

Offline repository verification uses `tough` to enforce TUF signature thresholds, role expiration, and rollback protection. A local metadata storage adapter routes verified TUF metadata updates through `PackageStore`'s durable file I/O while keeping root-of-trust keys and allowed repository sources under the caller's control. Verifying a repository signature or Pack listing validates package provenance; enabling and executing a package still requires explicit user approval and runtime grants.

### `ProcessSession` and `ProjectServiceBroker`

`ProcessSession` spawns either a native worker binary or a JavaScript component worker (via an approved Node tool + JavaScript Host tree) over stdio pipes:

- **Security Boundary**: Worker processes run with the OS user's permissions (`ProcessSession` is not an OS-level sandbox), so callers must pass an explicit unsandboxed-execution guard, live authority handle, execution scope, and `HostLimits`.
- **Protocol 3 Lifecycle**: Activation freezes a single `ComponentInstanceBinding` and its capability roster (`1` capability for `Project` and `Attempt` scopes; up to `128` read-only capabilities for JavaScript `Application` components). The worker must echo the exact `ProcessActivation` in its `ready` frame before any `invoke` frames are sent.
- **Channel Verification & Shutdown**: Every result frame is matched against the active channel's `ProviderBinding`, dispatch ID, schemas, byte limits, and deadline. On cancellation, authority revocation, channel error, or `close`, the Host stops admitting dispatches, waits for component disposal, and reaps the child process (and its Unix process group).
- **Project Services (`ProjectServiceBroker`)**: Attaches up to 16 explicitly bound `ServiceBinding` handles to a `Project` or `Attempt` session, validating required dependencies, effects, caller context, call count limits, and the outer invocation's absolute deadline on every `service-request`.

See the integration test suites in [`tests/process.rs`](tests/process.rs), [`tests/javascript.rs`](tests/javascript.rs), and [`tests/service.rs`](tests/service.rs) for end-to-end channel lifecycle examples.

## Core Execution Adapter (`core-adapter`)

```sh
cargo check -p tsumugi-plugin-host --features core-adapter --lib --locked
```

Enabling the `core-adapter` feature provides the bridge between `tsumugi-core` and Host worker sessions:

- **`core::RunnerProxy`**: Binds a captured package, contribution, profile, and runtime environment to each Core dispatch and live execution permit. It records distinct timeout phases (dispatch admission, package staging, process readiness, invocation, and post-close result handling) while leaving project storage, strategy validation, budgets, and result adoption in Core.

### Application tool lifetime

`core::ApplicationInstance` manages long-lived `Application`-scoped tool instances (supporting multi-capability read-only JavaScript rosters and single-capability read-only Native workers, without required dependencies or project services):

- An `ApplicationInstance` reserves a specific activation generation and starts the worker process only after receiving dedicated application-lifetime consent.
- Each project query routed to the instance still requires its own active per-project execution grant. While idle between calls, the Host holds no project permit, input, or deadline.
- Cancellation, settings revocation, or a failed readiness handshake retires the activation generation. Calling `stop()` initiates shutdown, and `drained()` awaits full worker thread and child process cleanup.

### Member Channel (`member::run_member`)

Also under `core-adapter`, `member::run_member` (and `member::run_member_observed`, which returns an in-memory `MemberRunObservation` with phase-specific timeout, crash, and channel failure classifications) spawns the [internal Pi member runtime](../../runtimes/agent-service/README.md) on the approved Node distribution:

- Uses the Core-generated internal member channel protocol (distinct from the SDK plugin process protocol).
- Passes controlled transport responses rather than raw API credentials into the Node process, while Core and application handlers enforce model endpoints, shared budgets, tool admission, data sharing, and durable ledger writes.
- On cancellation or close, closes admission and waits for both the host callback handler and child process to drain before removing the temporary staging directory.

To run the synthetic member conformance suite after building the member runtime artifact:

```sh
TSUMUGI_TEST_MEMBER_ARTIFACT=/absolute/new/member-runtime \
  cargo test -p tsumugi-plugin-host --features member-conformance --test member --test member_artifact_build --locked -- --test-threads=1
```

## Running Conformance and Compatibility Tests

### Host & JavaScript Channel Conformance

Default `cargo test -p tsumugi-plugin-host --locked` runs metadata, TUF repository, `PackageStore`, and runtime tree tests against temporary directories. To run live worker channel tests:

```sh
# Synthetic Rust protocol peer
cargo test -p tsumugi-plugin-host --features conformance-worker --test process --locked -- --test-threads=1

# Prebuilt JavaScript Host + approved Node distribution
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/approved/node-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/new/clean-host-runtime \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/approved/environment.json \
  cargo test -p tsumugi-plugin-host --features javascript-conformance --test javascript --test service --locked -- --test-threads=1
```

### Native Worker Conformance

To test the SDK's `native-worker` example binary over a real Host channel:

```sh
cargo build -p tsumugi-plugin-sdk --example native-worker --features native-worker --locked
TSUMUGI_NATIVE_SDK_WORKER=/absolute/built/native-worker \
  cargo test -p tsumugi-plugin-host --test native_sdk_worker --locked -- --ignored --test-threads=1
```

To test `core::ApplicationInstance` with a native application worker fixture:

```sh
cargo build -p tsumugi-plugin-host --example native-application-worker --features native-application-conformance --locked
TSUMUGI_NATIVE_SDK_WORKER=/absolute/built/native-application-worker \
  cargo test -p tsumugi-plugin-host --features core-adapter --test native_application --locked -- --ignored --test-threads=1
```

### Host / Core Domain Compatibility Workspace (`compatibility/`)

Because the root workspace's dev-dependencies enable `tsumugi-core/execution-test-host`, end-to-end tests that verify production Core (`default-features = false`) with `tsumugi-plugin-host/core-adapter` live in the standalone [`compatibility/Cargo.toml`](compatibility/Cargo.toml) workspace.

Supply the approved Node/JavaScript Host runtime variables (`TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST`, `TSUMUGI_TEST_RUNTIME_APPROVAL`) along with a prebuilt domain plugin package (`TSUMUGI_TEST_PLUGIN_PACKAGE`) and its expected digest (`TSUMUGI_TEST_PLUGIN_DIGEST`):

```sh
# WebVTT source extraction, semantic checking, and atomic adoption
TSUMUGI_TEST_PLUGIN_PACKAGE=/absolute/prebuilt/webvtt \
TSUMUGI_TEST_PLUGIN_DIGEST=approved-package-digest \
  cargo test --manifest-path crates/plugin-host/compatibility/Cargo.toml --features core-adapter,javascript-conformance --test source_adoption --locked -- --test-threads=1
```

With the prebuilt SMAPI plugin package selected in `TSUMUGI_TEST_PLUGIN_PACKAGE` / `TSUMUGI_TEST_PLUGIN_DIGEST`, the same workspace also provides:

- `--test translation_validation`: verifies translation import and mixed capability scopes.
- `--test source_maintenance -- --ignored`: verifies upstream source updates, QA checks, human approval, artifact verification, and project reopen persistence.
- `--test release_validation`: verifies plugin QA and independent artifact check proof across all output locales before saving a release.
