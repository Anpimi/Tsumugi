# JavaScript Component Host (`@tsumugi/javascript-host`)

`@tsumugi/javascript-host` is the Node.js worker bootstrap that runs inside child processes spawned by [`tsumugi-plugin-host`](../../crates/plugin-host/README.md). It implements the worker side of [process protocol 3](../../crates/plugin-sdk/docs/process.md)—handling component activation, capability handler registration, invocation framing, project service calls, cooperative cancellation, and disposal through the [`ComponentAPI` facade](../../crates/plugin-sdk/javascript/component.d.ts).

## Component Authoring Interface

A JavaScript plugin component exports a default object with an `activate(api)` method from its `.mjs` entrypoint:

```js
export default {
  activate(api) {
    api.onDispose(async () => { /* release owned resources */ });
    for (const contribution of api.contributions) {
      api.register(contribution.id, async (input, { signal }) => {
        signal.throwIfAborted();
        return { kind: 'succeeded', utf8: input.utf8 };
      });
    }
  },
};
```

### Lifecycle Rules

- **Registration**: During `activate(api)`, the component must call `api.register(contributionId, handler)` once for every contribution listed in `api.contributions`. `ready` is sent only after `activate` resolves and all roster members are registered. Missing, duplicate, unknown, or post-activation registrations fail activation and run any registered `onDispose` callbacks before shutting down.
- **Immutability & Signals**: `api.instance`, `api.contributions`, invocation `input`, `context`, `provider`, and bound `services` descriptors are cloned and deeply frozen before reaching component code. The component scope signal aborts on `close`, while each invocation receives its own `AbortSignal` (`signal`).
- **Return Values**: Handlers return `{ kind: 'succeeded' | 'failed' | 'unknown', utf8 }` conforming to the capability's declared output or error schema. Uncaught handler exceptions terminate the worker channel rather than synthesizing a domain error payload.
- **Project Services**: During an active invocation on a `Project` or `Attempt` channel, a handler can call `metadata.services.call(handleId, utf8, callId?)` to invoke a bound service. Only one service call may be in flight at a time, and handlers must await any pending service call before returning.
- **Shutdown**: Receiving `close` stops dispatch admission, aborts active signals, awaits in-flight handlers and `onDispose` callbacks, and replies with `closed` only if disposal succeeds cleanly.

## Building, Code Generation, and Unit Tests

Requires Node `>=26.10.0 <27`, Rust 1.98 or newer, and the repository's `pnpm` lockfile. From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts --filter @tsumugi/javascript-host --filter @tsumugi/plugin-sdk-tooling
node runtimes/javascript-host/scripts/generate-contracts.mjs --check
node runtimes/javascript-host/node_modules/typescript/bin/tsc -p runtimes/javascript-host/tsconfig.json
node --test runtimes/javascript-host/tests/*.test.mjs
```

- `generate-contracts.mjs` queries the Rust SDK's `tsumugi-plugin-contract` CLI (in `--locked --offline` mode) for the process frame schema and protocol limits, then emits `src/validate-process.mjs` and `src/protocol.ts`. Pass `--check` to verify that committed generated files are up to date.
- At runtime, the compiled ESM output depends only on `jsonc-parser@3.3.1` (used to reject duplicate JSON keys, non-scalar strings, non-integer numbers, and unsafe integers before `JSON.parse`). Ajv, TypeScript, and `json-schema-to-typescript` are build-time devDependencies only.

## Prepare the fixed macOS tool and host artifact

### Packaging a Clean Host Tree (`package-runtime.mjs`)

To produce a clean, reproducible JavaScript Host directory tree (suitable for `tsumugi-plugin-runtime inspect` and `ProcessSession`), first create a production deploy with `pnpm` and then run `package-runtime.mjs`:

```sh
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/production-deploy
node runtimes/javascript-host/scripts/package-runtime.mjs --source /absolute/new/production-deploy --output /absolute/new/clean-host-runtime
```

`package-runtime.mjs` walks only the pinned production dependency graph (`jsonc-parser@3.3.1`), verifies entrypoints and license files, strips source maps and package-manager metadata, normalizes file permissions, and writes a clean tree to `--output` (refusing preexisting output directories or path traversal).

### Preparing Both Node Tool and Host Trees (`prepare-desktop-runtime.mjs`)

`prepare-desktop-runtime.mjs` prepares both the pinned Node distribution (`node-distribution.macos-aarch64.json`) and the clean JavaScript Host tree in one step and validates them with the Rust `tsumugi-plugin-runtime` inspector:

- Accepts `--node-archive`, `--host-source`, `--inspector`, and `--output`.
- Verifies the Node archive's SHA-256 and Mach-O linkage profile (`node-system-libraries-v1`), packages the Host source tree, and writes the inspected runtime output to `--output`.

### Running Live Process Conformance (`test-process.mjs`)

Once you have an approved Node tool tree, a clean Host runtime tree, and their matching `RuntimeEnvironmentDescriptor` JSON file, you can run the end-to-end Rust + Node process conformance suite from the repository root:

```sh
node runtimes/javascript-host/scripts/test-process.mjs \
  --tool /absolute/approved/node-tree \
  --host /absolute/new/clean-host-runtime \
  --approval /absolute/approved/environment.json
```
