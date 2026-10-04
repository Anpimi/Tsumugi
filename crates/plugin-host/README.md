# Experimental process Host

`tsumugi-plugin-host` launches captured plugin artifacts through the standalone
SDK process protocol. Its default feature set depends on the SDK without Core;
the optional `core-adapter` feature implements Core's trusted execution port.
It has no domain runner or model dependency and is not yet connected to the
desktop's production extension catalog.

The implemented profile is one serialized capability on a project-scoped native
worker or JavaScript component. The Unix launcher creates an owned process group;
this profile is tested on macOS. Windows is refused until an owned Job Object implementation is verified.
The JavaScript launcher requires a `CapturedRuntime` containing the independently
approved Node tool and complete [built component Host](../../runtimes/javascript-host/README.md) trees. That Host
owns the process protocol and privately uses Cordis behind the SDK facade. The
plugin entrypoint exports a component; it is not launched as a protocol peer.
The local installation store can retain and reopen the approved runtime trees.
Trusted runtime acquisition and desktop distribution remain separate work.

## Captured package and actual channel

The trusted installer supplies immutable manifest/file bytes and an independently
expected package digest to `PackageImage::capture`. The digest covers ordered,
length-delimited paths/content and executable flags. Computing it does not
authenticate a publisher or authorize execution. Byte capture does not follow
source filesystem paths or unpack arbitrary archives. The initial materialization
profile rejects traversal, case aliases, non-ASCII paths and file/directory
collisions and reserved device names, then writes a private instance directory
under the host-owned staging parent.

`PackageImage::capture_directory` adds bounded capture of a selected prebuilt
local directory on macOS and Linux. Call it on a blocking IO worker with an
independently expected digest and a live read guard from the trusted application.
It opens every path component relative to a held directory descriptor with
`O_NOFOLLOW`, rejects links, hard-linked regular files and special files, and
requires two complete scans to agree on identities, metadata and file contents.
The snapshot keeps binary bytes and executable flags. The policy bounds captured
files to 256, total manifest/file bytes to 64 MiB, directories to 256, package
depth to 16 and observed processing time to ten seconds. The read guard is checked
between reads; synchronous filesystem calls themselves cannot be preempted.
macOS maps only the system `/var` and `/tmp` aliases to `/private`; arbitrary
symlinks remain rejected. Other platforms refuse this capture API. Tests have run
on macOS; the Linux implementation has not been exercised here.

Captured bytes remain fixed after source edits. Capturing does not execute the
entrypoint, unpack an archive, fetch metadata or prove publisher identity. The
caller still owns source approval, and an installer must validate archive/source
provenance before producing captured bytes. Network signature/update verification
and desktop package controls remain separate work.

Public package tooling uses `PackageImage::inspect_directory` to fingerprint a
prebuilt candidate through that same bounded capture owner. It returns the claimed
plugin identity, package digest, manifest SHA-256 and actual file/byte counts;
it returns no image, installation receipt, publisher approval or grant. This
read-only CLI accepts an absolute or relative selection without resolving away
symbolic links:

```sh
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect /path/to/prebuilt-package
```

Verify this candidate against trusted release metadata or explicitly approve its
source before supplying its digest to installation. The inspection performs no
component loading, download, build or installation script. Independent plugins
can materialize their declared runtime files and use this public tool instead of
copying the Host's package digest algorithm.

## Fixed runtime environment

`CapturedRuntime::capture_directories` captures two prebuilt, link-free trees on a
blocking IO worker. Independent installer approval supplies the SDK's strict
`RuntimeEnvironmentDescriptor`, exact platform/architecture, tool version,
complete tool/Host tree digests and relative entrypoints. Every actual byte and
executable flag must match. The trees share a 256 MiB / 2048-file / 60-second
observed bound. Later edits or deletion of their source directories cannot change
the retained snapshot. Capture executes no code and grants no authority.

The initial `node-system-libraries-v1` profile requires the trusted installer to
verify a Node distribution using only platform system libraries. A Homebrew
entrypoint with external dynamic libraries cannot be approved by hashing that
entrypoint alone. The Host does not infer this premise from a declared version,
parse binary dependencies, authenticate signatures or freeze the OS itself.

Launch materializes captured package, tool and Host bytes into one private owned
instance (`package/`, `runtime/tool/`, `runtime/host/`). Descriptor-relative
create-new IO uses private directories and read-only files, checking live
authority between chunks and before spawn. The child runs the captured Node and
Host entries with an empty inherited environment; it does not resolve them from
PATH, global modules or the original source directories. JavaScript invocation
requests must carry this environment's SDK-derived digest. The Native standalone
conformance profile does not provide this Node-specific Core environment binding.

## Package catalog and fixed selection

`catalog::PackageCatalog` records at most 128 captured package versions. Its
`PackageApproval` comes from independently verified metadata or explicit local
source approval, with expected plugin identity, digest and non-secret source and
publisher identifiers. Registration compares those values to the actual image;
the API does not verify signatures or TUF metadata. Same-name packages cannot
silently move source or publisher, and an existing exact identity cannot be
replaced with different bytes. Versions from the same origin can coexist.

Registration starts disabled. Explicit enablement makes declarations eligible
for new selection without loading code or granting project access. Resolution
reuses the SDK's exact contract/profile and provider-choice rules. Multiple
compatible providers or versions require an explicit choice for a single
operation; collection retains independent identities in canonical order.
`ResolvedCapability` holds the actual package image, approved origin and complete
capability binding. `lookup` checks an existing fixed binding without substituting
a newer version or another contribution. Disabling stops new catalog resolution;
already captured selections remain unchanged. The lifecycle owner must separately
stop dispatch and revoke Core permits when required. This catalog is in memory
and is not a second project store or a production installation/update service.

Run the admission and selection tests without a worker runtime:

```sh
cargo test -p tsumugi-plugin-host --test directory --test catalog --locked
```

## Durable local installation

`PackageStore::open_existing` opens a selected application-owned directory on
macOS and Linux. The directory must already exist, belong to the current user
and have mode `0700`; the API does not provision arbitrary paths. A held lock
permits one cooperating store owner. Root, lock and object-directory identities
are checked throughout descriptor-relative IO. Read-only package objects reject
links, hard-linked regular files, unexpected modes and unknown receipt fields.
The same-user process can still change permissions; these checks do not create
an OS sandbox or authenticate the publisher.

Installation accepts an already approved `RegisteredPackage` and a canonical
non-nil UUID action. It writes captured bytes into a private candidate, synchronizes
files and nested directories, then promotes the whole object exclusively under
its actual package digest. The private outer directory stays writable for the
rename and is sealed after the promoted identity and bytes are rechecked;
package files and descendants are already read-only. The object and required parent directories must be
synchronized before returning a successful immutable receipt. A failure after
promotion is `InstallError::UnknownCommit`; retain the object and retry the same
action to verify and synchronize it. A promoted but unsealed object returns
`RecoveryRequired` from `load`; only the original action with the exact approval
can seal and finish it. A new action cannot silently reuse the old receipt or
repair a different pending installation. Candidates interrupted before promotion
remain private and are not installed objects; this API does not delete unknown candidates.

Each store contains at most 128 installed package versions. Conflicting action,
identity, source or publisher metadata is rejected; same-source versions coexist.
The original action can be reconciled even at capacity. Reopening and `load`
require an independent `PackageApproval` and recapture actual bytes, rather than
trusting a receipt or digest-shaped directory name. Loading returns an immutable
image and receipt without catalog enablement, execution, a Core grant or project
adoption. The receipt format is owned by this experimental store, not a new
project database or public SDK protocol.

Use a blocking IO worker and a live application guard. Each install/load has a
60-second observed deadline, checked between filesystem operations; individual
blocking system calls are not preempted. The existing package capture limits
remain in effect. Linux is implemented but has not been exercised in the macOS
validation environment. Network acquisition/signatures, complete project
environment selection, uninstall/garbage collection and desktop controls remain
separate work.

### Reopening an approved runtime

`PackageStore::install_runtime` retains a `CapturedRuntime` under its SDK-derived
environment digest. Its independent `RuntimeApproval` contains the complete SDK
descriptor and trusted source/publisher origin. This uses the same store lock,
descriptor-relative IO, exclusive promotion and original-action recovery as
package installation. Runtime files and their receipt are read-only; the store
keeps distinct environments without replacing an installed one.
Unselected runtimes participate only in bounded receipt, read-only metadata and
descriptor-identity checks for conflicting actions. This does not approve their
execution bytes. The target runtime is fully recaptured before and after promotion
and during original-action recovery; loading always recaptures the selected trees.

After closing and reopening the store, `load_runtime` requires that independent
approval again and recaptures both complete trees, including executable flags.
The original acquisition directories are no longer needed. An installed receipt
records provenance and the original action; it is not a new source of trust or
permission. Changed bytes, descriptors or origin are refused. An interrupted
promotion remains uncertain, and an unsealed object requires its original action
to finish rather than being repaired by loading it.

The runtime trees share the SDK's 2048-file / 256 MiB bound, and each store keeps
at most 128 runtime environments. Package and runtime installations share the
action identity boundary. Installing or loading a runtime never executes it,
enables a plugin, restores a Core grant or adopts project results. The returned
runtime can be supplied to the existing JavaScript launcher or Core RunnerProxy;
their execution consent and channel checks still apply.
Callers with exhaustive matches on `InstallError` must handle `MissingRuntime`.

```sh
cargo test -p tsumugi-plugin-host --lib --test installation --test directory --test catalog --locked
```

Materialization runs on a blocking IO worker and retains ownership of its temporary
directory while a spawned child remains unreaped. Cancelling a pre-spawn
materialization future leaves the bounded blocking task to finish its own cleanup. Authority is rechecked immediately
before spawning, after materialization, as well as during the handshake.

`ProcessSession::launch` requires a current authority callback and an explicit
acknowledgement of unsandboxed execution. The manifest's requested permissions do
not provide either. Launch resolves the declared entrypoint and contribution,
does not inherit the parent environment, and assigns a fresh instance identity
to the actual process/pipe channel. Required dependencies without an implemented broker
are refused; other component scopes are refused. The handshake must echo the
captured capability and provider binding exactly. It cannot upgrade declarations,
effects, versions, limits or permission requests.

`invoke` checks the captured project/scope, package/instance, exact capability,
input/output/error/profile identities and limits. The SDK correlates the result
with both the captured request and this actual channel. Dispatch IDs cannot be
reused, and unsolicited/duplicate output cannot become the next dispatch's result.
`ReceivedResult` can only be constructed by the Host and exposes immutable output
and channel evidence. This is not domain semantic validation, replay authority,
human approval or a project write; Core must still perform those checks.

## Bounded IO and exit

The [SDK framing contract](../plugin-sdk/docs/process.md) owns the JSON source.
The host checks lengths before allocating incoming bodies, bounds the aggregate
stdout and stderr traffic and queues, limits invocation count, and applies policy
deadlines even when stdin is blocked by a worker that stopped reading. Raw stderr
is counted and discarded rather than printed or stored as trusted diagnostics.
Explicit heartbeats correlate a fresh nonce on the same channel.

Payload and frame ceilings are separate. Manifest `maxInputBytes` and
`maxOutputBytes` bound exact, unescaped payload UTF-8; `maxResultBytes` bounds the
complete encoded SDK result frame, including JSON escaping and metadata. The
Host checks the original received frame against the invocation budget before
parsing, including JSON whitespace and escape overhead. It also checks the raw
output limit for success, failure and unknown outcomes before returning evidence;
the SDK correlates the complete result with its captured request.
The default frame ceiling follows the SDK's finite process profile; the default
aggregate stdout ceiling is 64 MiB. Callers can select narrower frame/stream
limits. No limit permits truncation or partial result acceptance.

Cancellation and current authority are polled while waiting and rechecked before
returning output. Revocation poisons the channel, stops further dispatch, and
terminates the owned process group. `close` waits for a bounded acknowledgement,
terminates the group and reaps its direct child under a separate cleanup deadline.
`CloseReceipt` and `termination_receipt` distinguish acknowledgement, actual
direct-child reaping and known exit status. An error/timeout does not assert that
an external effect did not occur. Callers must await `close`; Drop kills/aborts as
a final cleanup safeguard and does not produce an acceptance receipt. If Drop or
post-spawn rollback cannot confirm reaping, it retains the instance instead of
deleting a live child's files. Cleanup also refuses a replaced parent/root identity.

Process groups provide lifecycle control, not a security sandbox. A trusted native
program can access the user's files/network and can escape its group. CPU/RSS
confinement, escaped descendants, signed source verification, host service grants,
artifact output opening and adoption authority are not provided by this profile.

## Core execution adapter

With `core-adapter`, `RunnerProxy` captures a package contribution and the trusted
installer's `CapturedRuntime`. Core's fixed input retains the complete SDK
descriptor and derives its digest. Registration and host policy use the exact
provider/environment pair, so A/B environments for the same package coexist;
registration order does not choose between them. The adapter
checks that selection again before staging and sends only the selected item's
captured data through the SDK channel. Installer authentication and environment
pinning remain the installer's responsibility.

The trusted application must register the proxy, capture its `execution_binding`,
then explicitly authorize the input through `ExecutionRuntime::authorize_plugin`
with a stable grant ID, expiry and unsandboxed-execution consent. That per-attempt
grant is stored in the existing project ledger; its live permit can be revoked,
expires, and ends with its runtime generation or project session. Reopening reads
history without reactivating old grants. This first adapter refuses automation
leases and delegated child execution.

The adapter closes the actual child before returning a result. Core retains the
raw SDK payload, independently supplied channel, grant ID and checked JSON proposal.
A successful proposal requires a trusted `ResultValidator`, registered for its
operation, to become valid. The validator runs on captured values outside the
project thread and transaction. Missing validators leave proposals pending;
`capture_result_validation` / `prepare` / `commit_result_validation` supports later
explicit checking. Producer bytes cannot carry the private validation proof.
Checked results still require a separate explicit adoption action and trusted
handler; the existing transaction rechecks current scope, result, cancellation
and plugin authority. Existing committed receipts remain idempotently readable.

Plugin source extraction instead requires `capture_source_validation`, a separately
authorized execution of its fixed checker input, and `commit_source_validation`;
a generic result validator cannot replace those mandatory checks. New source
adoption rechecks the selected checker's exact live grant both before preparation
and inside the final transaction. Revoking or cancelling that checker blocks
adoption even after its semantic proof was saved. Previously adopted content and
committed receipt replay remain available without restoring execution authority.

The adapter clamps the fixed complete-result allowance to the Host's frame
ceiling, while raw payload limits remain attached to the captured declaration.
Core's ledger envelope has its own budget for original SDK bytes and the checked
JSON projection. Failed and unknown SDK outcomes preserve their raw error evidence without
claiming replay safety. A new process cannot authenticate an earlier instance's
outcome, so this adapter's outcome query remains unavailable. A failed launch does
not expose a Core-visible cleanup receipt; no result is accepted from that path.

Build the JavaScript Host as described in its README, then run the synthetic
Core integration with independently approved absolute artifact-tree paths:

```sh
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/path/to/tool-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/path/to/clean-host-tree \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/path/to/approved-descriptor.json \
cargo test -p tsumugi-plugin-host --features core-adapter,javascript-conformance --test core --locked
```

These tests use an isolated project and independent proposal expectations. They
do not prove a production plugin catalog, domain migration or desktop workflow.

## Real-process conformance

The `official` pairing test consumes an explicitly selected prebuilt WebVTT
candidate from the independent
[official plugin repository](https://github.com/Anpimi/tsumugi-plugins). It installs
and reopens the approved package, then runs its extraction, locale builder and
artifact checker through the actual captured JavaScript Host. Literal expected
bytes cover Unicode, BOM/CRLF, notes and layout; malformed source/target and
rehashed timing/note changes are refused. It does not link domain source or
establish Core adoption, desktop selection or a complete migration.

Provide reviewed package bytes/digest and the same independently approved runtime
trees described above; missing selections fail instead of skipping:

```sh
TSUMUGI_TEST_PLUGIN_PACKAGE=/absolute/path/to/prebuilt-webvtt \
TSUMUGI_TEST_PLUGIN_DIGEST='<independently-approved-package-digest>' \
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/path/to/tool-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/path/to/clean-host-tree \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/path/to/approved-descriptor.json \
cargo test -p tsumugi-plugin-host --features javascript-conformance --test official --locked -- --test-threads=1
```

```sh
cargo test -p tsumugi-plugin-host --features conformance-worker --locked
```

The explicit feature builds a separate synthetic worker executable consuming only
the public SDK. Tests stage its actual binary bytes and launch independent
processes with synthetic input, including incorrect identities, malformed and
oversized frames, blocked input, crashes, duplicate output, authority revocation,
uncooperative exit and A/B instance cleanup. They do not invoke a paid model or
open a developer project. The worker is a conformance peer, not a production
domain implementation or evidence of an accepted desktop plugin flow.
