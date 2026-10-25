# Experimental standalone plugin Host

`tsumugi-plugin-host` provides captured package inspection, a local installation
Store, offline repository and Pack verification, and bounded child-process
channels using the [public SDK](../plugin-sdk/README.md). Its default build has
no Core, project database, domain runner or model dependency. The opt-in
`core-adapter` profile connects captured channels to the existing Core Runner
port. The separate
[JavaScript component Host](../../runtimes/javascript-host/README.md) implements
the component side of the same protocol.

Application member execution and desktop plugin loading remain separate
consumers. Host inspection or successful framing does not approve a source import, translation, review, release or model request.
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

The Core adapter retains fixed timeout categories for dispatch admission, package
staging, process readiness, invocation and post-close result handling. These describe
where the trusted owner observed expiry; they do not prove that a component never
ran or that an unknown operation can be replayed safely. Existing limits and live
authority checks still apply, and old generic timeout records remain readable.

The member channel offers an optional in-memory `MemberRunObservation` through
`run_member_observed`, while `run_member` retains the same execution behavior.
Its fixed failure categories distinguish timeout, crash and channel failure at
the last trusted phase. An observed phase does not establish a root cause or
confirm cleanup; actual child reaping and handler draining remain required.

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

## Optional Core execution adapter

```sh
cargo check -p tsumugi-plugin-host --features core-adapter --lib --locked
```

`core::RunnerProxy` binds one captured package, contribution, profile and runtime
identity to each original Core dispatch and live plugin permit. It owns no project
Store and cannot approve or adopt results. Core remains the authority for consent,
strategy validation, budgets, original requests, cancellation and ledger writes.
A late result or a replacement channel cannot renew an old dispatch's authority.

`core::ApplicationInstance` reserves an exact application activation and starts
it only after separate explicit lifetime consent. Each project invocation still
needs its own current grant. Idle records retain no prior project permit, input or
deadline; unsandboxed component code can retain data already supplied to it.
Cancellation, settings withdrawal and failed readiness retire that activation.
`stop()` requests shutdown; `drained()` confirms actual owned-thread and child
cleanup. A cancelled handshake does not itself prove that cleanup completed.
The supported application roster excludes required dependencies and project
services. This application lifecycle is separate from the member channel below; desktop registry and team policy remain application consumers.

## Optional member channel

With `core-adapter`, `member::run_member` launches one captured application member
artifact with the independently approved Node tool. The member artifact uses the
Core-generated member profile, separately from the SDK Process protocol. Core
and application handlers retain original model requests, budgets, tool admission,
sharing and durable results. Node receives controlled transport replies instead
of ambient credentials. Cancellation closes admission and waits for the original
handler and owned child to drain before releasing staging.

Build the [internal Pi runtime](../../runtimes/agent-service/README.md) from its
pinned source and provide its fresh absolute artifact path alongside the runtime
inputs below. The opt-in fixtures are synthetic, with no real provider call:

```sh
TSUMUGI_TEST_MEMBER_ARTIFACT=/absolute/new/member-runtime \
  cargo test -p tsumugi-plugin-host --features member-conformance --test member --test member_artifact_build --locked -- --test-threads=1
```

A missing artifact, mismatched profile or unapproved runtime fails explicitly;
there is no PATH lookup or alternative member engine. This feature and its
headless tests do not establish native desktop or real-provider acceptance.

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
they do not link the Core adapter. Core adapter lifecycle tests are a separate
profile. Build the application fixture, then execute its ignored tests explicitly:

```sh
cargo build -p tsumugi-plugin-host --example native-application-worker --features native-application-conformance --locked
TSUMUGI_NATIVE_SDK_WORKER=/absolute/built/native-application-worker \
  cargo test -p tsumugi-plugin-host --features core-adapter --test native_application --locked -- --ignored --test-threads=1
```

The main workspace's Host fixture dev-dependency enables Core's
`execution-test-host`; those tests do not establish ordinary production Core
behavior. The separate `compatibility/` workspace uses Core and SDK with
`default-features = false` and enables only Host's `core-adapter`. For a normal
Core source/translation workflow, provide the approved runtime variables above
and an explicitly selected WebVTT package and its independently approved digest:

```sh
TSUMUGI_TEST_PLUGIN_PACKAGE=/absolute/prebuilt/webvtt \
TSUMUGI_TEST_PLUGIN_DIGEST=approved-package-digest \
  cargo test --manifest-path crates/plugin-host/compatibility/Cargo.toml --features core-adapter,javascript-conformance --test source_adoption --locked -- --test-threads=1
```

Select the SMAPI package in those variables to run `--test translation_validation`
(two cases including mixed capability scopes). Its `source_maintenance` target
additionally checks source updates, QA, human approval, artifact proof and release
preservation after reopening; execute that target with `--ignored` explicitly.
The SMAPI `release_validation` target separately requires real plugin QA and
independent artifact proof for every output locale before saving a release.
These headless checks do not establish desktop, real-model, clean-machine or
other-platform acceptance.
