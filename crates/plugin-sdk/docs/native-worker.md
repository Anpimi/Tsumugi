# Experimental Rust native components

Enable the SDK's optional `native-worker` feature in the dependency on your
verified SDK snapshot. Default SDK consumers remain data-only. This feature adds
no dependency on Core, a project store, the desktop application, Cordis or another
runtime framework.

Implement `NativeComponent` and call `serve_native_component` once from your
Worker's `main`. The [public example](../examples/native-worker.rs) echoes opaque
input; it is a transport example, not a usable domain plugin.

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
        // Domain code consumes captured input and observes cancellation during
        // long work. Returning after cancellation cannot publish a result.
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

The one selected contribution and its contract are supplied to `activate`.
This basic facade accepts process protocol 3 with exactly one captured roster
member. It rejects a multi-callable activation before invoking author code or
publishing Ready; understanding protocol 3 does not enable Native Application
execution. Close and Closed refer to the captured component instance, including
its original activation generation, rather than selecting a contribution.
The component receives immutable captured payload/context/profile values in
`invoke`; it returns only `Succeeded`, `Failed` or `Unknown` UTF-8 bytes. The SDK
supplies the original provider, context, schema and digest. Its result ID is the
original unique dispatch ID, including when that ID uses the full 128-byte bound.
Author code does not write result envelopes or obtain raw transport handles.
Failed/unknown proposal bytes use the declared error schema; they are not generic
exception strings. Domain validation and Core adoption remain separate steps.

Activation and serial invocation run on an owned component thread. The control
reader remains available while code is running. An invocation's cancellation
signal and the component scope signal are independent; close cancels both.
Cancellation acknowledges the dispatch and suppresses its pending/late result.
A cancelled job that has not entered `invoke` is skipped. Cancellation does not
prove rollback, refund, or that an external effect did not happen.

`dispose` runs once after close, partial activation failure, an unwinding
invocation panic, or a channel error. Scope and invocation signals are cancelled
before disposal, including after failed activation or panic. With `panic=abort`,
the process terminates immediately and cannot promise component disposal; the
Host's child/group cleanup is still separate. Close waits for running code and disposal; unsuccessful
disposal cannot produce `closed`. Authors must observe the cooperative signals
and release their resources. The actual Host enforces deadlines and terminates
an uncooperative child; this SDK does not interrupt arbitrary Rust instructions.
The stdin reader ends when its peer closes stdin or the process exits, so this
entry point serves one Worker process rather than a reusable in-process service.

The entry point uses the existing [process codec](process.md), refusing partial
frames, duplicate/unknown typed fields and unsupported protocols. It validates
the complete request against the activated provider, capability, input/output/
error schemas, selected profile and input limit before invoking author code.
Only one invocation runs at a time; duplicate dispatches, a 129th invocation,
conflicting control and worker-to-host frames on stdin are refused. Payload and
whole-frame output limits both apply before writing any result bytes. Each
direction has a 64 MiB aggregate frame budget and a bounded two-event queue.
Stdout is reserved for protocol frames; diagnostic output belongs on stderr and
is separately bounded by the actual Host.

Package manifests still use the public declaration contract and harness.
Installing/enabling a package, executing native code with operating-system user
access, and each current scoped authorization remain independent Host decisions.
This entry point neither creates those decisions nor freezes the actual native
system-library environment. The current standalone Native Host route does not
yet establish complete Core runtime-environment binding; do not substitute a
Node descriptor for a native executable.

From the source repository root:

```sh
cargo test -p tsumugi-plugin-sdk --features schema,native-worker --locked
cargo build -p tsumugi-plugin-sdk --example native-worker --features native-worker --locked
TSUMUGI_NATIVE_SDK_WORKER="$PWD/target/debug/examples/native-worker" \
  cargo test -p tsumugi-plugin-host --test native_sdk_worker --locked -- --ignored
```

When using a custom Cargo target, supply the actual example binary path instead.
The Host test captures that binary into its immutable package, starts the staged
native entry point and checks original Unicode, serial results, heartbeat,
identity refusal, authority revocation and direct-child cleanup. These synthetic
transport tests do not prove a domain extraction/check/build workflow or Core
adoption.

This basic native component facade currently handles captured-input computation
without service calls. It rejects a nonempty process-3 service table before
activating author code, rather than claiming service readiness. Native authors
who implement service calls directly must use the public process-3 contracts and
observe the same exact context, schema, cancellation and lifetime rules. The
JavaScript facade's service API does not imply a native facade implementation.
