# Experimental JavaScript component Host

This private Node workspace package is the component side of the
[standalone Rust Host](../../crates/plugin-host/README.md). It owns registration,
asynchronous activation, invocation, service correlation and cleanup using the
[SDK facade](../../crates/plugin-sdk/javascript/component.d.ts). It has no Core,
project database, model or credential dependency. A separate trusted parent must
capture the runtime and package, obtain execution consent and retain authority.
This source profile does not provide desktop plugin or application member loading.

## Component contract

A captured `.mjs` entrypoint exports a component:

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

Register every frozen roster member exactly once during activation. Ready waits
for complete asynchronous setup; missing, duplicate, unknown or late registration
fails even if component code catches the error. Partial activation failure still
awaits registered cleanup. The scope signal aborts on close, while each invocation
has its own cancellation signal. Input, context, provider, `api.instance` and
`api.contributions` are cloned and deeply frozen.

Handlers return only `{ kind: 'succeeded' | 'failed' | 'unknown', utf8 }` under the
selected output or error contract. The Host supplies provider identity, schemas,
envelope and digest. Exceptions terminate the channel rather than invent a valid
domain error. SDK structural validation does not replace domain validation or
project adoption.

Selected service descriptions are immutable. During a live invocation,
`metadata.services.call(handleId, utf8, callId?)` uses the selected binding and
original context. One service call may be pending; cancellation/close rejects it,
and a handler cannot finish with an unawaited call. A call ID never grants replay
permission. The parent owns authority, scope, deadline and any unsettled effects.

Process protocol 3 retains a complete bounded callable roster and per-call
contribution identity. Project/Attempt profiles use singleton rosters; the bounded
Application transport profile supports read-only members without required
services. Earlier protocols and the old single-handler facade are rejected.
Close stops admission, waits for activation, handlers and disposal, and cannot
acknowledge failed cleanup. Cancellation does not promise rollback. The trusted
Rust parent enforces process deadlines and reap.

## Build, generate and test

Use Node `>=26.10.0 <27`, Rust 1.98 or newer and the repository pnpm lockfile. From
the source repository root, install only the Host and SDK generation tools:

```sh
pnpm install --frozen-lockfile --ignore-scripts --filter @tsumugi/javascript-host --filter @tsumugi/plugin-sdk-tooling
node runtimes/javascript-host/scripts/generate-contracts.mjs --check
node runtimes/javascript-host/node_modules/typescript/bin/tsc -p runtimes/javascript-host/tsconfig.json
node --test runtimes/javascript-host/tests/*.test.mjs
```

Use `--offline` only with prepared dependency caches. Direct Node commands keep
package-manager script bootstrapping from installing unrelated workspace packages.
The Host generator reads the SDK's Rust-owned process schema and profile through
its locked offline CLI, reuses the SDK generation helper and emits only the Host's
`validate-process.mjs` and `protocol.ts`. SDK declarations and validators remain
owned by `crates/plugin-sdk/scripts`. `--check` refuses stale output without
writing files. No Core or application schema generator is involved.

Compiled ESM runs directly in Node with explicit `.js` imports. The sole runtime
package is pinned `jsonc-parser@3.3.1`; its visitor rejects duplicate decoded JSON
keys before `JSON.parse` can discard them. Ajv, TypeScript and the schema compiler
are development tools and are not runtime dependencies.

## Prepare an explicit clean runtime

A development deploy is an explicit trusted input, not a distributable capture of
an arbitrary source checkout. After building, prepare a fresh production deploy:

```sh
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/production-deploy
node runtimes/javascript-host/scripts/package-runtime.mjs --source /absolute/new/production-deploy --output /absolute/new/clean-host-runtime
```

The packager follows only the pinned production dependency edges inside that
deploy. It refuses paths escaping the input, changed package identities, missing
entrypoints/licenses, private cache paths and preexisting outputs. It copies
ordinary files with fresh bytes and portable flags, strips source maps and omits
installation metadata. The output contains compiled Host code and the complete
`jsonc-parser` runtime dependency; it does not contain Node itself. A partial
failed output is evidence to inspect; select a fresh path rather than overwrite
an installed or approved runtime.

`prepare-desktop-runtime.mjs` is also usable as an explicit standalone preparation
tool despite its historical filename. Its `--node-archive`, `--host-source`,
`--inspector` and `--output` arguments select a pinned Node archive, trusted deploy,
actual Rust runtime inspector and fresh output. It does not read a desktop build
owner or start Tauri. Its Mach-O checks describe the supported captured-Node
profile, independently of the desktop application's minimum system version.
Preparation does not grant approval or establish clean-machine/platform support.

Actual Rust channel tests require an independently approved Node tree, this
matching clean Host tree and their exact environment descriptor. Use
`node runtimes/javascript-host/scripts/test-process.mjs --tool ... --host ... --approval ...`
from the repository root after the trusted owner approves those inputs.
Synthetic packaging and Node unit tests do not
prove a real channel, Core adoption or desktop behavior. Frozen SDK/plugin/runtime
pins and release assets are never replaced by these development commands.
