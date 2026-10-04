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
pnpm --dir runtimes/javascript-host test:process \
  --tool /absolute/approved/node-tree \
  --host /absolute/new/clean-host-runtime \
  --approval /absolute/approved/environment.json
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
The integration script supplies the approved tool tree, clean Host tree and
environment descriptor to Rust tests; enabling `javascript-conformance` without
those values fails. Prepare the clean Host tree as described below. The tests
launch captured synthetic packages with fresh instance directories and no real
project or model access. Native-worker tests remain separate.

A separate development directory can be prepared with the pinned pnpm version:

```sh
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/runtime-directory
```

This directory includes runtime dependencies, not Node itself. pnpm installation
metadata can contain machine-local cache paths; this development directory is not
a sanitized desktop distribution artifact. A production
installer must authenticate and pin both Node and this bootstrap/dependency set;
the plugin manifest cannot choose them. The Rust JavaScript launcher requires
the independently approved, captured tool and Host environment. Update/recompile
callers; there is no historical project-data migration for this experimental API
change.

## Prepare a clean Host runtime

After building, use a trusted production deploy as an explicit input. Keep this
input unchanged while packaging. The packager follows only the pinned dependency
edges within that deploy; it refuses links in public package files and dependencies
that resolve outside the input. A workspace `node_modules` tree that refers to an
external pnpm store is not a supported input.

```sh
pnpm --filter @tsumugi/javascript-host deploy --prod --ignore-scripts /absolute/new/production-deploy
pnpm --dir runtimes/javascript-host package:runtime \
  --source /absolute/new/production-deploy \
  --output /absolute/new/clean-host-runtime \
  --cordis-license /absolute/approved/cordis-LICENSE
```

The output parent directory must already exist; the output itself must be new.
Packaging does not install dependencies, run lifecycle scripts, execute the Host,
or contact a network service. An IO failure can leave a partial output: discard
that preparation directory explicitly and retry with a fresh destination. The
packager never overwrites or removes an existing output.

The resulting tree contains the complete compiled `dist`, the Host `package.json`,
and the published public files and original `package.json` bytes for exactly
`cordis@4.0.0-rc.10`, `cosmokit@1.8.1`, `jsonc-parser@3.3.1`, and
`@standard-schema/spec@1.1.0`, including their licenses. Cordis owns the two
transitive dependencies; they need not appear at the deploy's top level.
jsonc-parser's published entrypoint is `lib/umd/main.js`. Both its UMD and ESM files,
and both cosmokit module formats, remain in the output. This profile uses the
Cordis library only: it does not run the published Cordis CLI or install its
optional loader/include peers. Upstream CLI and peer declarations remain intact.

The Cordis published package omits its license file. Supply the unmodified
[upstream MIT license](https://github.com/cordiverse/cordis/blob/f8ea3cd50f1a5724e8e715995bcde131c9c12b2c/LICENSE)
approved for this exact package revision. Its SHA-256 is
`034fb52b1d57360ecbae6cb1632a88f86fd7c3d3f5631a5f082710203dda0be7`;
the packager checks those bytes and adds `node_modules/cordis/LICENSE`.

Files are copied into independent regular files with normalized permissions.
Nested `node_modules`, pnpm/cache metadata, source map files and source map/source
URL comments are omitted. Machine-local paths or unexpected dependency versions
cause packaging to fail. The same trusted input bytes and executable flags produce
the same output bytes and executable flags at another destination. Preparation is
bounded to 1,024 files, 16 MiB per file and 64 MiB total.

Use `dist/main.js` as the logical Host entrypoint. This artifact contains neither
Node nor an operating system, and packaging does not authenticate its inputs or
grant execution. The trusted Rust capture/installer must independently approve and
capture the actual tool and Host artifacts before launch. Do not use the pnpm
deployment's linked tree as that captured Host artifact.

## Limits and actual isolation

Frames use the SDK protocol, bounded before allocation, with a 64 MiB input / 64 MiB
output session ceiling and at most two pending writes. The parent enforces its own
narrower limits, live authority and captured identity. The JavaScript profile uses
safe integers and a 64-level JSON nesting limit; it rejects malformed UTF-8,
unpaired surrogates and duplicate fields. Raw stdout is protocol-only. Host errors
use a fixed diagnostic without embedding plugin input or exceptions.

Manifest input/output limits count the exact payload's UTF-8 bytes before
framing, within the generated SDK invocation-payload ceiling. A request's
`maxResultBytes` instead limits the complete JSON result
frame, excluding the four-byte length prefix. Before sending success, failure
or unknown output, the component Host checks the raw declaration limit and uses
the existing SDK frame encoder to check actual escaping and metadata against
the request. Oversized output terminates the channel without truncation. Frame
ceilings come from the Rust SDK's generated process profile; a larger frame
ceiling does not enlarge a domain's payload limits.

Node runs with the user's OS access. The parent clears inherited environment;
platform-created variables may still appear after startup (for example macOS text
encoding metadata). This is not a JavaScript or OS sandbox: components can access
Node APIs, write stdout or attempt to modify the runtime. Such failures cannot
replace the Rust parent's actual channel identity or authorize Core writes. Source
trust, Core adoption, service grants, Windows cleanup and desktop distribution are
not established by this conformance profile.
