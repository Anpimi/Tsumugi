# Experimental local process protocol

Process protocol **1** is separate from manifest protocol, content exchange,
capability schema/behavior identities and package SemVer. Its sole type/schema
source is the Rust SDK. The [process Host](../../plugin-host/README.md) implements
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
`data`. The host sends `activate`, `invoke`, `cancel`, `close` or `ping`; the worker
sends `ready`, `result`, `cancelled`, `closed` or `pong`. The SDK checks structural
and semantic data; the Host also checks message direction, active state and exact
request/nonce/instance correlation. A syntactically valid result in the wrong
state is not an accepted invocation.

`activate`/`ready` carry the exact captured `ProcessActivation`: provider binding
plus capability declaration. The claimed binding includes package digest,
plugin/component/contribution identity, fresh instance and activation generation.
The actual Host must compare it to the artifact it captured and the process it
launched. A peer that echoes these values has not authenticated a publisher,
obtained a grant or proven safe domain behavior.

`invoke` and `result` reuse the existing invocation types and exact UTF-8 payload
digests. `receive_invocation_result` checks the complete result document against
the request's `maxResultBytes` and validates its separately bounded payload. Opaque payloads still need
their own schema/domain interpreter and Core adoption. `cancelled` acknowledges
only the correlated dispatch; it cannot claim rollback, refund or the absence of
an external effect. `closed` acknowledges only the captured provider's cleanup.
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

## JavaScript component profile

The experimental [JavaScript Host](../../../runtimes/javascript-host/README.md)
loads SDK components using generated [wire types](../javascript/process.d.ts) and
a small [component facade](../javascript/component.d.ts). The Rust schema remains
the wire source; the Host's `generate:contracts` command emits those TypeScript
types and an Ajv standalone validator. `profile-process` exports the Rust protocol
version, frame bound and SDK package version for generation.

This JavaScript profile rejects duplicate decoded JSON keys, non-scalar strings,
non-integer numeric tokens, unsafe JavaScript integers and excessive nesting.
Exact payload UTF-8 (including BOM, CRLF and Unicode) remains opaque data. These
additional parser limits are profile constraints; structural validation does not
replace Rust's semantic matching or the real parent's channel/authority checks.
