# Local Process Protocol

Process protocol **4** defines the chunked JSON message transport over stdio between the Rust Host and JavaScript or native Rust workers. Its version is independent of the manifest and exchange protocols (both `1`). Older process transports are rejected; rebuild native workers and use a matching JavaScript Host.

## Wire Framing and Byte Limits

A message consists of consecutive chunks. Each chunk has a four-byte unsigned big-endian length followed by that many bytes, at most 64 KiB. A zero-length chunk terminates the complete message. Messages cannot interleave, and the complete JSON must validate before dispatch. Partial headers, partial chunks, a missing terminator, malformed or duplicate JSON fields, and unsupported protocol versions fail the channel.

- `MAX_PROCESS_FRAME_BYTES` bounds the complete JSON message at `u32::MAX` bytes; it is independent of the 64 KiB transport chunk. An invocation's `maxResultBytes` can impose a smaller complete-result limit.
- `MAX_PROCESS_SESSION_BYTES` bounds all transmitted bytes in either direction at 8 GiB, including chunk headers and terminators. Host policy may be smaller. The separate application member protocol retains its own budgets.
- Ordinary service payloads retain 16 MiB. Material-backed source/check/build/review calls allow up to 1 GiB before envelope escaping; encoded source/artifact sets and content have their own 384 MiB and 512 MiB ceilings. All applicable limits must hold independently.
- Capability `maxInputBytes` and `maxOutputBytes` bound the raw `EncodedPayload` UTF-8 bytes. Rust payload clones share immutable strings; material digests and independent domain checks still apply.
- Writers serialize into bounded chunks with backpressure. Rust readers parse from bounded streams. JavaScript readers assemble the bounded complete message before their strict JSON parser.
- Invocation deadlines start before transmission and cover sending, execution and receiving. Host invocation policy permits up to 300 seconds and is intersected with the capability and Core deadline. Handshake, stop and cleanup retain independent smaller limits. Cancellation and authority revocation close the owned channel.
- `stdout` carries only messages; `stderr` has a separate diagnostic budget.

Each JSON message has the shape `{ "protocolVersion": 4, "body": { "kind": "<kind>", "data": ... } }`:

| Direction | Message `kind` values |
| --- | --- |
| Host → Worker | `activate`, `invoke`, `service-response`, `cancel`, `close`, `ping` |
| Worker → Host | `ready`, `result`, `service-request`, `cancelled`, `closed`, `pong` |

## Component Activation and Multi-Capability Rosters

An `activate` frame (and the worker's matching `ready` response) carries a `ProcessActivation` containing:

1. `instance`: a `ComponentInstanceBinding` (`plugin` identity, `componentId`, `packageDigest`, fresh `instanceId`, and `activationGeneration`).
2. `capabilities`: a non-empty, duplicate-free list of up to `MAX_PROCESS_CAPABILITIES` (128) `ProcessCapability` entries (`contributionId` + full `Capability` declaration).
3. `services`: a list of up to 16 `ServiceBinding` entries (empty when no project services are bound).

The worker must echo the exact `ProcessActivation` in its `ready` frame before any `invoke` frames are sent, and the capability roster is frozen for the lifetime of that instance.

- `ProcessActivation::capability(id)` looks up a roster member by contribution ID.
- `ProcessActivation::provider(id)` validates the roster and constructs the full per-call `ProviderBinding` for that contribution ID.
- `ProviderBinding::instance()` projects the shared `ComponentInstanceBinding` from a per-call binding (`ComponentInstanceBinding::provider(id)` performs syntax validation only and does not check roster membership).
- `Project` and `Attempt` components use singleton rosters (1 capability). The multi-capability `Application` profile supports up to 128 read-only JavaScript capabilities with no required dependencies or `ProjectService` permissions.

## Invocation, Cancellation, Shutdown, and Heartbeats

- **`invoke` / `result`**: Carries the full `InvocationRequest` (including the specific `ProviderBinding` with `contributionId`) and returns an `InvocationResult` checked via `receive_invocation_result`.
- **`cancel` / `cancelled`**: Requests cooperative cancellation of a specific dispatch ID and acknowledges that the dispatch was cancelled.
- **`close` / `closed`**: Carries the `ComponentInstanceBinding` to shut down the entire component instance and all capabilities in its roster.
- **`ping` / `pong`**: Exchanges a fresh nonce to verify process responsiveness.

```sh
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- schema-process
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- check-process-schema crates/plugin-sdk/schemas/process-frame.schema.json
cargo run -p tsumugi-plugin-sdk --features schema --bin tsumugi-plugin-contract -- validate-process frame.json
```

## Project Services (`service-request` / `service-response`)

For `Project`- and `Attempt`-scoped components, the Host can bind up to 16 `ServiceBinding` handles during activation. Each binding specifies a handle ID, provider identity, contract reference, input/output/error schemas, project and scope IDs, activation generation, configuration digest, project effect, and payload/call limits.

While an invocation is active on the channel:

1. The worker sends `service-request` with a unique `callId`, a bound `handleId`, the outer `InvocationContext` (whose `inputDigest` remains the outer invocation's input digest), and a separately hashed `EncodedPayload` for the service input.
2. Only one service call may be in flight at a time, up to 128 total service calls per channel.
3. The Host validates caller identity, scope, effect, byte/call limits, and the outer invocation's absolute deadline before dispatching the service callback and returning `service-response` with a `Succeeded`, `Failed`, or `Unknown` payload. Duplicate, unsolicited, or out-of-turn service frames terminate the channel.

## Component Profiles

### JavaScript Component Profile

The [JavaScript component Host](../../../runtimes/javascript-host/README.md) consumes the generated wire types ([`javascript/process.d.ts`](../javascript/process.d.ts)) and exposes the [`ComponentAPI`](../javascript/component.d.ts) facade:

- During `activate(api)`, the component inspects `api.instance` and `api.contributions` (both deeply frozen) and calls `api.register(contributionId, handler)` exactly once for every contribution in `api.contributions`.
- Missing, duplicate, unknown, or post-activation registrations fail activation and trigger disposal before `ready` is sent.
- Incoming frames are pre-scanned with `jsonc-parser` to reject duplicate JSON object keys, non-scalar strings, non-integer numbers, unsafe integers, and deep nesting before structural validation.

### Rust Native Component Profile

The optional `native-worker` feature provides [`serve_native_component`](native-worker.md), which wraps this Rust codec for single-capability native workers with no service bindings.
