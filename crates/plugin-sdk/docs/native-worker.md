# Rust Native Components (`native-worker`)

Enabling the optional `native-worker` Cargo feature on `tsumugi-plugin-sdk` exposes a standard-library stdio runner (`NativeComponent` and `serve_native_component`) for implementing single-capability native Rust plugin workers over [process protocol 3](process.md).

## Implementing a Native Worker

Implement the `NativeComponent` trait and invoke `serve_native_component` from `main`. See [`examples/native-worker.rs`](../examples/native-worker.rs) for a minimal echo worker:

```rust
use tsumugi_plugin_sdk::{
    EncodedPayload, NativeCapabilityOutput, NativeComponent,
    NativeInvocationMetadata, serve_native_component,
};

struct Component;
impl NativeComponent for Component {
    fn invoke(
        &mut self,
        input: &EncodedPayload,
        metadata: &NativeInvocationMetadata,
    ) -> NativeCapabilityOutput {
        // Check cooperative cancellation during long-running work.
        let _cancelled = metadata.cancellation.is_cancelled();
        NativeCapabilityOutput::Succeeded(input.utf8.clone())
    }
}

fn main() {
    if let Err(error) = serve_native_component(Component) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
```

Build and test the native worker feature and example from the repository root:

```sh
cargo test -p tsumugi-plugin-sdk --features schema,native-worker --locked
cargo build -p tsumugi-plugin-sdk --example native-worker --features native-worker --locked
```

## Activation, Invocation, and Scope Rules

- **Singleton Roster Only**: `serve_native_component` speaks process protocol 3, but accepts only activations with a single capability in `capabilities` and an empty `services` list (matching the `Project`, `Attempt`, and read-only Native `Application` tool singleton profiles). Activations requesting multiple capabilities or project service bindings are rejected before `activate` is called or `ready` is sent.
- **Typed Envelopes**: `invoke` receives the validated `EncodedPayload` and `NativeInvocationMetadata` (which provides the capability profile, invocation context, and cooperative cancellation tokens) and returns `NativeCapabilityOutput::Succeeded(utf8)`, `Failed(utf8)`, or `Unknown(utf8)`. The SDK constructs the outer `result` frame, attaches the SHA-256 digest and `ProviderBinding`, and preserves the full dispatch ID (up to 128 ASCII bytes).
- **Error Payloads**: `Failed` and `Unknown` outputs must serialize a valid JSON payload matching the capability's declared error schema rather than arbitrary exception text.

## Threading, Cancellation, and Disposal

`serve_native_component` splits control-plane reading from component execution:

1. **Control Reader & Execution Thread**: A dedicated stdin reader parses incoming frames (`invoke`, `cancel`, `close`, `ping`) while `activate`, `invoke`, and `dispose` run sequentially on an owned component thread. Only one invocation executes at a time, with up to 128 invocations per process session and a bounded 2-event internal queue per direction.
2. **Cooperative Cancellation**: Each invocation has its own cancellation token (`metadata.cancellation`), alongside a component-wide scope token. Receiving `cancel` for an queued invocation skips `invoke` and immediately emits `cancelled`; receiving `cancel` while `invoke` is running sets the token, emits `cancelled`, and suppresses the eventual return value from `invoke`.
3. **Deterministic Disposal**: `dispose` is called once when the component receives `close`, when activation fails, when `invoke` unwinds from a panic, or when the transport channel errors. Both cancellation tokens are triggered before `dispose` runs, and `closed` is emitted only if `dispose` completes cleanly (note: compiling with `panic = "abort"` terminates the process immediately on panic without running `dispose`).

## Wire and Stream Constraints

- **Stdio Separation**: `stdout` is used exclusively for length-prefixed protocol frames; any diagnostic logging must go to `stderr` (which the Host captures and bounds separately).
- **Frame & Aggregate Budgets**: The codec enforces both the capability's declared `maxInputBytes` / `maxOutputBytes` and the request's `maxResultBytes`, with a 64 MiB aggregate frame budget in each direction. Partial frames, unknown or duplicate JSON fields, duplicate dispatch IDs, and unexpected frame directions terminate the session.
- **Environment Descriptor**: When launching a native worker, the Host records a [`NativeHostEnvironmentDescriptor`](environment.md#native-application-host-profile) (`native-application-host-v1`) alongside the plugin package's `PackageImage` digest.
