# Experimental standalone plugin Host

`tsumugi-plugin-host` provides captured package inspection, a local installation
Store, offline repository and Pack verification, and bounded child-process
channels using the [public SDK](../plugin-sdk/README.md). This source profile has
no Core, project database, domain runner or model dependency. The separate
[JavaScript component Host](../../runtimes/javascript-host/README.md) implements
the component side of the same protocol.

Core execution adapters, application member execution and desktop plugin loading
are outside this checkout's Host profile. Host inspection or successful framing
does not approve a source import, translation, review, release or model request.
The application and SDK retain their separate source-only version boundaries in
[the versioning policy](../../docs/versioning.md).

## Build and inspect prebuilt packages

Use Rust 1.98 or newer and the public repository's Cargo lockfile. Build only the
Host; no application build is needed:

```sh
cargo build -p tsumugi-plugin-host --bins --locked
cargo test -p tsumugi-plugin-host --locked
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect /absolute/prebuilt-package
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect-archive < /absolute/candidate.tar
```

The package inspector reads captured bytes and reports package identity, exact
file provenance and declarations. `diagnose <directory> <request-json>` accepts a
bounded SDK capability-compatibility request as a JSON literal, not another file
path. Exit `0` means compatible and `2` means the selected contract/profile does
not match; malformed input and capture failures are errors. Inspection neither
runs package code nor installs or approves it.

`tsumugi-plugin-runtime inspect <tool-directory> <host-directory> <request.json>`
inspects two explicit prebuilt trees using the Host's `RuntimeInspectionRequest`.
It does not download a runtime, approve it or start a child. The separate Host
preparation tools require explicit trusted inputs and a fresh output directory.

Cargo dependencies must be fetched or cached first; `--offline` is suitable only
with a prepared cache. The SDK is an explicit public sibling source dependency.
The patched `tough` source is also in this repository with its upstream licenses
and [patch description](../../third_party/tough/PATCHES.md). This is a workspace
source package, not an independently published crates.io Host distribution.

## Captured bytes and local state

`PackageImage` validates the complete package and declared contribution owners.
Paths, file counts, encoded sizes, portable names, file flags and actual captured
bytes are checked before staging. Resources and Skills remain inert data and are
read through their exact contracts. Tool and Ui binding do not grant execution
or provide a rendered desktop view. A deserialized binding must be rebound to
its actual immutable package rather than trusted as authority.

`PackageStore` owns installed package/runtime archives, approval settings and
exact install, disable and uninstall actions. Its local format and reopen
validation are separate from project storage. Replacement or uncertain actions
must be reconciled under their original identity. An installation does not
retarget a running process; captured selections remain immutable. The Store does
not automatically garbage-collect historical package bytes.

Offline repository verification uses `tough` for TUF signatures, rollback and
expiry rules. The local metadata-storage adapter routes verified progress through
the same durable Store IO owner. It does not replace the upstream verifier.
Trust roots and allowed sources must come from the trusted caller, not a plugin.
A valid repository signature or Pack listing does not grant process permission.
No online catalogue, automatic acquisition or production signing service is
provided by this profile.

## Process and service lifetime

`ProcessSession` can launch a captured native worker or a JavaScript component
through an independently captured Node/Host runtime. The trusted caller supplies
an explicit unsandboxed-execution decision, live authority guard, scope and
bounded `HostLimits`. Plugin processes have the operating-system access of their
user; this Host is not an OS sandbox.

Process protocol 3 freezes one component instance and its complete, unique
capability roster. Ready must acknowledge that exact activation before calls
start. Every invocation retains its selected contribution, input/output/error
schemas, scope, profile, byte limits and original deadline. Result and close
receipts identify the actual channel and dispatch, not a worker's claimed grant.
Project and Attempt channels retain singleton rosters; the bounded Application
transport profile admits only its documented read-only roster. Application
lifetime consent and per-project execution grants remain the trusted embedding
application's responsibility.

`ProjectServiceBroker` supplies explicitly selected services to supported scoped
channels. Missing required dependencies, incompatible effects, unselected handles
and foreign invocation contexts are refused before author code runs. Service
availability is not permission to execute it. A callback must retain the actual
caller and deadline and finish or drain its owned work after cancellation.

Cancellation, authority loss, close and transport failure stop admission and
suppress late results. Close waits for owned component cleanup and the direct
child's reap; an acknowledgement alone does not prove cleanup, rollback or the
absence of an external effect. The Unix launcher owns its process group. This
profile has macOS evidence; Windows/Linux execution and distribution support are
not established by the presence of platform implementations.

See the public synthetic [process tests](tests/process.rs),
[JavaScript tests](tests/javascript.rs) and [service tests](tests/service.rs) for
complete captured bindings and independent success/refusal/cleanup expectations.
These fixtures grant no authority over a real project or installed user package.

## Focused conformance

Default Host tests exercise metadata, trust, Store and runtime capture using
isolated temporary files. The `conformance-worker` feature builds the synthetic
protocol peer; the `javascript-conformance` feature selects actual captured
JavaScript channels. Build and prepare the JavaScript Host as documented there,
then provide explicit absolute fixture paths:

```sh
cargo test -p tsumugi-plugin-host --features conformance-worker --test process --locked -- --test-threads=1
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/approved/node-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/new/clean-host-runtime \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/approved/environment.json \
  cargo test -p tsumugi-plugin-host --features javascript-conformance --test javascript --test service --locked -- --test-threads=1
```

Use the environment names enforced by `tests/support/runtime.rs`; these inputs
must match the independently approved SDK/environment descriptor. Optional domain
package pairings require their own explicit prebuilt package fixtures.

The SDK native worker tests are separate and require its actual built example:

```sh
cargo build -p tsumugi-plugin-sdk --example native-worker --features native-worker --locked
TSUMUGI_NATIVE_SDK_WORKER=/absolute/built/native-worker \
  cargo test -p tsumugi-plugin-host --test native_sdk_worker --locked -- --ignored --test-threads=1
```

These tests exercise the same native singleton channel and captured environment;
they do not link the Core adapter. No Core adapter, desktop, real-model,
clean-machine or other-platform acceptance is implied by these headless checks.
