# Experimental local process protocol

Process protocol **3** is separate from manifest protocol, content exchange,
capability schema/behavior identities and package SemVer. Its sole type/schema
source is the Rust SDK. A separately implemented process Host must implement
actual pipe/state handling; parsing a frame does not start a worker or grant
authority.

Each frame is a four-byte unsigned **big-endian** JSON byte length followed by
exactly that many UTF-8 JSON bytes. A body must be nonempty and at most
`MAX_PROCESS_FRAME_BYTES` (24 MiB + 64 KiB). An invocation payload separately
fits `MAX_INVOCATION_PAYLOAD_BYTES` (4 MiB); JSON quoting can expand each arbitrary
UTF-8 byte to six bytes, with 64 KiB reserved for bounded metadata.
The SDK-generated process profile owns both limits. Domain source/content each
retain their own 2 MiB ceiling; combined source-check data uses 4 MiB.
`maxResultBytes` limits the complete encoded result frame, while a contribution's
`maxInputBytes`/`maxOutputBytes` limit raw payload bytes. The receiver checks both;
the Host additionally applies its narrower policy/capability and aggregate stream
limits. Stdout contains frames only. Stderr is a separately bounded diagnostic
stream, not a result channel. Partial headers/bodies, invalid JSON, unknown or
duplicate typed fields and unsupported protocols are errors.

The JSON envelope contains `protocolVersion` and a typed `body` with `kind` and
`data`. The host sends `activate`, `invoke`, `service-response`, `cancel`, `close` or
`ping`; the worker sends `ready`, `result`, `service-request`, `cancelled`,
`closed` or `pong`. The SDK checks structural
and semantic data; the Host also checks message direction, active state and exact
request/nonce/instance correlation. A syntactically valid result in the wrong
state is not an accepted invocation.

`activate`/`ready` carry the exact captured `ProcessActivation`: one `instance`,
the frozen `capabilities` roster and the mandatory `services` array. The
`ComponentInstanceBinding` includes plugin identity, component ID, package digest,
fresh instance ID and activation generation, without choosing a contribution.
Every `ProcessCapability` has a `contributionId` and its full `capability`
declaration. The roster must be nonempty, unique by contribution ID and contain
at most `MAX_PROCESS_CAPABILITIES` (128) members, while the original encoded-frame
byte limit still applies. Duplicate IDs with different declarations are also
refused. The actual Host must compare Ready to its complete original activation,
the artifact it captured and the process it launched. A peer that echoes these
values has not authenticated a publisher, obtained a grant or proven safe domain
behavior. A roster cannot be expanded after activation.

`ProcessActivation::capability(id)` looks up the exact member; `provider(id)`
validates the complete roster and derives that member's full call binding,
refusing a missing member. `ProviderBinding::instance()` projects its component
principal. `ComponentInstanceBinding::provider(id)` checks syntax only; it does
not prove membership. Scope, permissions, current authority and deadlines remain
with the actual Host. Project/Attempt use singleton rosters and retain the
existing service semantics. The initial multi-callable Application profile is
JavaScript and read-only, without required dependencies or ProjectService
permissions; broader composition and Native Application remain unsupported.

`invoke` and `result` reuse the existing invocation types, the full per-call
`ProviderBinding` including contribution ID, and exact UTF-8 payload digests.
Sharing an instance does not authorize any other roster member's call.
`receive_invocation_result` checks the complete result document against
the request's `maxResultBytes` and validates its separately bounded payload. Opaque payloads still need
their own schema/domain interpreter and Core adoption. `cancelled` acknowledges
only the correlated dispatch; it cannot claim rollback, refund or the absence of
an external effect. `close` and `closed` carry the component `instance` and apply
to its entire frozen roster. `closed` acknowledges only that instance's cleanup.
The Host's actual exit/reaping evidence remains separate. `ping`/`pong` use fresh
nonces for an explicit liveness check, not an authorization lease.

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-process
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-process-schema crates/plugin-sdk/schemas/process-frame.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-process frame.json
```

The generated schema is structural. Exact provider/request matching, logical
package-path rules, identities, payload digest verification and live Host state
remain semantic checks. A JSON parser in another language may discard duplicate
members; a schema alone cannot detect that loss. The receiving Rust SDK parses
the original bytes and rejects duplicate typed fields.

## Project services

A trusted Host can select at most sixteen exact service bindings before starting
one project-scoped component. Every binding fixes its handle, provider, contract,
input/output/error schemas, project/scope, activation generation, configuration
digest, effect and limits. Required dependencies must have the selected provider
set ready; optional dependencies may have no provider. Single selection refuses
ambiguity, while independent collection retains each explicitly supplied provider.
The capability must request the exact `ProjectService` contract. These values
are captured descriptions, not execution grants or project/credential handles.

During an active invocation, `service-request` carries a fresh call ID, selected
handle, the original invocation context and a separately hashed opaque input.
The context's input digest continues to identify the outer invocation; it must
not be replaced by the service-input digest. `service-response` echoes the exact
call, handle and context and returns a typed success/failure/unknown payload using
the binding's schema. The Rust Host constructs the caller from its actual child
channel and original request, enforces scope, effect, byte/call limits, and checks
current authority before and after dispatch. The trusted caller also exposes the
original absolute invocation deadline so an enqueued operation can retain that
bound after the callback returns. The deadline covers service calls; progress
never renews it. Duplicate, unsolicited or
stale calls and responses revoke the channel. Cancellation cannot prove rollback.

The transport is serial, with one pending service call and at most 128 calls per
channel. A broker should return an enqueue receipt promptly for long work rather
than hold a worker until that work completes. Its owner must retain any original
execution/grant association until the child task is terminal, including after
channel cleanup. This transport supplies no AI, budget, adoption or authorization
implementation. Those remain the application's existing execution owners.

Process 1/2 frames and captured runtime descriptions are not accepted by the
current process-3 receiver. Regenerate bindings and build/capture the current
Host; no historical wire fallback or development-data migration is supplied.
Manifest and content-exchange protocol identities remain independent.

## JavaScript component profile

A separate JavaScript Host can load components using the generated
[wire types](../javascript/process.d.ts) and the declared
[component facade](../javascript/component.d.ts). The SDK supplies those data
definitions, while activation and execution require a matching Host implementation. The Rust schema remains
the wire source; the SDK's `generate:contracts` command emits those TypeScript
types and an Ajv standalone validator. `profile-process` exports the Rust protocol
version, frame and roster bounds and SDK package version for generation.

The facade exposes read-only `instance` and `contributions` descriptions, where
each contribution has its exact ID and contract. During `activate`, authors call
`register(contributionId, handler)` exactly once for every captured member.
Missing, duplicate, unknown and late registrations fail. Only complete successful
activation publishes Ready; a partially registered component must be disposed
without exposing a callable subset. Disposal and late callbacks remain bound to
their original instance and activation generation. The old `contribution` field
and no-ID registration API have no fallback. Per-call metadata retains its
original complete provider, invocation context, cancellation signal and services.

This JavaScript profile rejects duplicate decoded JSON keys, non-scalar strings,
non-integer numeric tokens, unsafe JavaScript integers and excessive nesting.
Exact payload UTF-8 (including BOM, CRLF and Unicode) remains opaque data. These
additional parser limits are profile constraints; structural validation does not
replace Rust's semantic matching or the real parent's channel/authority checks.

## Rust native component profile

The optional SDK `native-worker` feature provides the
[native component entry point](native-worker.md), using this same strict Rust
codec. Authors implement their capability over captured input and return opaque
proposal bytes; the entry point owns framing, handshake, result correlation,
cooperative cancellation and disposal. The actual process Host still checks
captured package identity, scope, live authority, deadlines and reaping. This
component-side API does not establish a complete Native/Core runtime environment
or perform domain validation/adoption.
