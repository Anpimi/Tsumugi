# Experimental process Host

`tsumugi-plugin-host` launches captured plugin artifacts through the standalone
SDK process protocol. It has no Core, database, domain runner or model dependency
and is not yet connected to the desktop's production extension catalog.

The implemented profile is one serialized capability on a project-scoped native
worker. The Unix launcher creates an owned process group; this profile is tested
on macOS. Windows is refused until an owned Job Object implementation is verified.
The JavaScript interpreter launcher accepts an absolute path from a trusted
runtime installer; its Cordis component coordinator and packaged runtime are
separate integration work, not established by the native conformance tests.

## Captured package and actual channel

The trusted installer supplies immutable manifest/file bytes and an independently
expected package digest to `PackageImage::capture`. The digest covers ordered,
length-delimited paths/content and executable flags. Computing it does not
authenticate a publisher or authorize execution. Package capture does not follow
source filesystem paths or unpack arbitrary archives. The initial materialization
profile rejects traversal, case aliases, non-ASCII paths and file/directory
collisions, then writes a private instance directory under the host-owned staging
parent. An installer must still validate archive/source provenance and actual
filesystem capture before calling this API.

Materialization runs on a blocking IO worker and retains ownership of its temporary
directory if the awaiting task is cancelled. Authority is rechecked immediately
before spawning, after materialization, as well as during the handshake.

`ProcessSession::launch` requires a current authority callback and an explicit
acknowledgement of unsandboxed execution. The manifest's requested permissions do
not provide either. Launch resolves the declared entrypoint and contribution,
clears the entire child environment, and assigns a fresh instance identity to the
actual process/pipe channel. Required dependencies without an implemented broker
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
artifact output opening and Core adoption are not provided by this profile.

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
