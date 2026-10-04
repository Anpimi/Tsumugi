# Experimental process Host

`tsumugi-plugin-host` launches captured plugin artifacts through the standalone
SDK process protocol. Its default feature set depends on the SDK without Core;
the optional `core-adapter` feature implements Core's trusted execution port.
It has no domain runner or model dependency and is not yet connected to the
desktop's production extension catalog.

The implemented profile is one serialized capability on a project-scoped native
worker or JavaScript component. The Unix launcher creates an owned process group;
this profile is tested on macOS. Windows is refused until an owned Job Object implementation is verified.
The JavaScript launcher requires absolute paths for both an approved Node runtime
and the [built component Host](../../runtimes/javascript-host/README.md). That Host
owns the process protocol and privately uses Cordis behind the SDK facade. The
plugin entrypoint exports a component; it is not launched as a protocol peer.
Runtime installation/pinning and desktop distribution remain separate work.

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
provenance before producing captured bytes. Network signature/update verification,
persistent installation and desktop package controls remain separate work.

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

Materialization runs on a blocking IO worker and retains ownership of its temporary
directory if the awaiting task is cancelled. Authority is rechecked immediately
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

Cancellation and current authority are polled while waiting and rechecked before
returning output. Revocation poisons the channel, stops further dispatch, and
terminates the owned process group. `close` waits for a bounded acknowledgement,
terminates the group and reaps its direct child under a separate cleanup deadline.
`CloseReceipt` and `termination_receipt` distinguish acknowledgement, actual
direct-child reaping and known exit status. An error/timeout does not assert that
an external effect did not occur. Callers must await `close`; Drop kills/aborts as
a final cleanup safeguard and does not produce an acceptance receipt.

Process groups provide lifecycle control, not a security sandbox. A trusted native
program can access the user's files/network and can escape its group. CPU/RSS
confinement, escaped descendants, signed source verification, host service grants,
artifact output opening and adoption authority are not provided by this profile.

## Core execution adapter

With `core-adapter`, `RunnerProxy` captures a package contribution and the trusted
installer's runtime environment digest. Core's fixed input retains this complete
selection; registration order does not choose between providers. The adapter
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

The actual process budget is bounded by both fixed Core limits and transport
limits. Failed and unknown SDK outcomes preserve their raw error evidence without
claiming replay safety. A new process cannot authenticate an earlier instance's
outcome, so this adapter's outcome query remains unavailable. A failed launch does
not expose a Core-visible cleanup receipt; no result is accepted from that path.

Build the JavaScript Host as described in its README, then run the synthetic
Core integration with explicit absolute runtime paths:

```sh
TSUMUGI_TEST_NODE=/absolute/path/to/node \
TSUMUGI_TEST_JS_HOST_BOOTSTRAP=/absolute/path/to/built/dist/main.js \
cargo test -p tsumugi-plugin-host --features core-adapter,javascript-conformance --test core --locked
```

These tests use an isolated project and independent proposal expectations. They
do not prove a production plugin catalog, domain migration or desktop workflow.

## Real-process conformance

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
