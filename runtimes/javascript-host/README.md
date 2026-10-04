# Experimental JavaScript component Host

This private workspace is the Node side of the [Rust process Host](../../crates/plugin-host).
It uses pinned `cordis@4.0.0-rc.10` for component registration and owned cleanup.
Plugins see only the [SDK component facade](../../crates/plugin-sdk/javascript/component.d.ts),
not a Cordis Context, Loader, service registry, credential or project database.
It implements one project-scoped, serial capability per process. Required service
dependencies and other scopes are refused by the Rust parent until their broker
exists. This is development runtime tooling, not a bundled desktop feature.

A captured `.mjs` entrypoint exports a component:

```js
export default {
  activate(api) {
    api.onDispose(async () => { /* release resources owned by this component */ });
    api.register(async (input, { signal }) => {
      signal.throwIfAborted();
      return { kind: 'succeeded', utf8: input.utf8 };
    });
  },
};
```

Register exactly once during activation. Register cleanup during activation too;
late registrations are rejected. The scope signal aborts on close, and each
invocation receives its own cancellation signal. Input/context/contribution data
is cloned and frozen. Results provide only `kind` (`succeeded`, `failed`, `unknown`)
and exact `utf8`; the Host supplies captured schema, provider, context and digest.
Exceptions terminate the channel, not a fabricated domain error payload. Domain
schemas still require their own semantic validators in Core.

Close stops new handlers, aborts active work and waits for activation, handlers and
owned asynchronous cleanup. A cleanup failure cannot produce `closed`. Late output
is discarded after cancellation/close; cancellation is not rollback. A completed
handler frees its serial slot before writing its result, because the peer can read
the result before the local write callback runs. A stuck component or disposer is
terminated under the Rust parent's deadlines and process-group policy.

## Build and checks

Use Node `>=26.10.0 <27`, the repository pnpm lockfile, and the Rust toolchain in
[the project README](../../README.md). No installation scripts are needed.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir runtimes/javascript-host generate:contracts
pnpm --dir runtimes/javascript-host build
pnpm --dir runtimes/javascript-host test
pnpm --dir runtimes/javascript-host test:process
```

Generation checks the SDK's Rust-owned process schema, emits its TypeScript wire
types and an Ajv standalone validator, and derives protocol bounds using the SDK
CLI. `check:contracts` detects stale output without rewriting it. Ajv and the
schema compiler are development dependencies. Runtime parsing uses `jsonc-parser`
with comments/trailing commas disabled and every syntax error rejected; its visitor
also rejects duplicate decoded keys before `JSON.parse` can erase them.

The compiler uses Bundler type resolution because Cordis's pinned declarations
contain extensionless relative exports. Our runtime imports have explicit `.js`
extensions and the compiled ESM runs directly in Node; no bundler is required.
The integration script supplies the actual Node executable and built bootstrap to
Rust tests; enabling `javascript-conformance` without those values fails. The tests
launch captured synthetic packages with fresh instance directories and no real
project or model access. Native-worker tests remain separate.

A separate development directory can be prepared with the pinned pnpm version:

```sh
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/runtime-directory
node runtimes/javascript-host/scripts/test-process.mjs --bootstrap /absolute/new/runtime-directory/dist/main.js
```

This directory includes runtime dependencies, not Node itself. pnpm installation
metadata can contain machine-local cache paths; this development directory is not
a sanitized desktop distribution artifact. A production
installer must authenticate and pin both Node and this bootstrap/dependency set;
the plugin manifest cannot choose them. The Rust `RuntimeLauncher::JavaScript`
now requires `approved_node` and `approved_bootstrap`. Update/recompile callers;
there is no historical project-data migration for this experimental API change.

## Limits and actual isolation

Frames use the SDK protocol, bounded before allocation, with a 64 MiB input / 16 MiB
output session ceiling and at most two pending writes. The parent enforces its own
narrower limits, live authority and captured identity. The JavaScript profile uses
safe integers and a 64-level JSON nesting limit; it rejects malformed UTF-8,
unpaired surrogates and duplicate fields. Raw stdout is protocol-only. Host errors
use a fixed diagnostic without embedding plugin input or exceptions.

Node runs with the user's OS access. The parent clears inherited environment;
platform-created variables may still appear after startup (for example macOS text
encoding metadata). This is not a JavaScript or OS sandbox: components can access
Node APIs, write stdout or attempt to modify the runtime. Such failures cannot
replace the Rust parent's actual channel identity or authorize Core writes. Source
trust, Core adoption, service grants, Windows cleanup and desktop distribution are
not established by this conformance profile.
