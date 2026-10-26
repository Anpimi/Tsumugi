# Local Process Protocol

Process protocol **3** defines the length-prefixed JSON message framing used over stdio pipes between the Rust Host (`tsumugi-plugin-host`) and plugin worker processes (JavaScript components or native Rust workers). Its version (`3`) is independent of the manifest protocol (`1`), content exchange protocol (`1`), and SDK crate version (`0.1.0-alpha.1`).

## Wire Framing and Byte Limits

Every frame consists of a 4-byte unsigned **big-endian** byte length followed by a non-empty UTF-8 JSON body of at most `MAX_PROCESS_FRAME_BYTES` (24 MiB + 64 KiB).

- `MAX_INVOCATION_PAYLOAD_BYTES` is 4 MiB of raw UTF-8 payload data. Because JSON string escaping can expand arbitrary UTF-8 bytes up to 6x (`\u00XX`), the 24 MiB + 64 KiB frame ceiling accommodates worst-case escaping plus 64 KiB of envelope metadata.
- Individual domain contracts enforce their own tighter payload limits (for example, 2 MiB for source extraction or content exchange, and 4 MiB for combined check inputs).
- A capability's `maxInputBytes` and `maxOutputBytes` bound raw `EncodedPayload` UTF-8 bytes, while `InvocationRequest.maxResultBytes` bounds the complete encoded `result` frame.
- `stdout` carries only protocol frames; `stderr` is reserved for diagnostic output and is bounded separately by the Host.

Each JSON message has the shape `{ "protocolVersion": 3, "body": { "kind": "<kind>", "data": ... } }`:

| Direction | Frame `kind` values |
| --- | --- |
| Host → Worker | `activate`, `invoke`, `service-response`, `cancel`, `close`, `ping` |
| Worker → Host | `ready`, `result`, `service-request`, `cancelled`, `closed`, `pong` |

The Rust codec rejects partial headers or bodies, malformed JSON, unknown or duplicate JSON fields, and unsupported protocol versions (protocol 1 and 2 frames are not accepted).

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
