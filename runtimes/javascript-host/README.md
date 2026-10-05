# Experimental JavaScript component Host

This private workspace is the Node side of the [Rust process Host](../../crates/plugin-host).
It uses pinned `cordis@4.0.0-rc.10` for component registration and owned cleanup.
Plugins see only the [SDK component facade](../../crates/plugin-sdk/javascript/component.d.ts),
not a Cordis Context, Loader, service registry, credential or project database.
It implements one project-scoped, serial capability per process. Required service
dependencies and other scopes are refused by the Rust parent until their broker
exists. Desktop builds can opt into the fixed runtime bundle described below;
production provider/Core execution integration remains under development.

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

## Prepare the fixed macOS tool and Host artifact

The repository pins one Node distribution in
[node-distribution.macos-aarch64.json](scripts/node-distribution.macos-aarch64.json).
It records the official archive checksum and selected `bin/node`/`LICENSE`
checksums, plus the SDK-owned complete tool-tree digest including executable
flags. Pin changes require a deliberate review of the actual distribution;
the preparation command does not download updates or verify a signature chain.
Use a trusted Node build tool and the inspector built from this source tree:

```sh
cargo build --locked -p tsumugi-plugin-host --bin tsumugi-plugin-runtime
pnpm --dir runtimes/javascript-host prepare:runtime \
  --node-archive /absolute/pinned/node-v26.10.0-darwin-arm64.tar.xz \
  --host-source /absolute/new/production-deploy \
  --cordis-license /absolute/approved/cordis-LICENSE \
  --inspector /absolute/project/target/debug/tsumugi-plugin-runtime \
  --output /absolute/new/prepared-runtime
```

Build and deploy the current Host first using the preceding instructions. Keep
the explicit deploy unchanged during preparation. The output parent must exist
and the output must be new and separate from that input. The command captures
the pinned archive without following its final symlink, extracts only its two
selected members into memory, verifies their checksums, and inspects the actual
thin arm64 Mach-O. It rejects non-system imports, runtime search paths and
unsupported loader commands. It then uses the existing clean Host packager and
Rust capture owner; it does not copy the SDK's artifact/environment hash rules.

The resulting directory contains complete `tool/` and `host/` trees,
`inspection-request.json`, `inspection.json` and `distribution.json`. Metadata
contains logical paths and public provenance, without local input/output paths.
The descriptor includes every retained tool/Host file and executable flag,
including dependency metadata and licenses. Actual Node imports require **macOS
13.5 or later**. Preparation supports macOS arm64 only; this does not change the
application's base macOS minimum or establish Intel/Linux runtime availability.
A desktop installer must check this requirement before offering that artifact.

Fixed archive/file pins are build inputs, not a publisher update policy or a
user execution decision. Inspection records the installer-supplied version;
the verified distribution supplies that claim. Neither output JSON nor an
installation receipt independently approves its own bytes. Application approval,
installation, exact selection, bundling and each Core execution grant remain
separate steps. No selected Node, Host or plugin code executes during preparation.
An IO/tool failure after output creation leaves a partial preparation directory;
review it and explicitly discard it before retrying with a new destination.

## Opt into the desktop runtime bundle

On an Apple silicon Mac, prepare the preceding output at the fixed path
`apps/desktop/src-tauri/resources/javascript-runtime` in this checkout. Its
parent must exist and the destination must be new. Build the desktop with:

```sh
pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json
```

The `bundled-runtime` feature requires an Apple silicon macOS builder and target.
The build captures both actual trees through the Host, compares the complete tool
digest with the independent source pin, and embeds the actual complete SDK
descriptor, public application-build origin and limits. Tauri preserves the two
directory trees at logical resource paths. Preparation JSON is not copied into
the bundle or used as approval. This opt-in bundle requires macOS 13.5; ordinary
builds retain their base minimum and have no implicit Node/PATH fallback.

The global Extensions panel separately reviews and approves that exact environment.
The backend queries the real macOS version and captures approved bytes before
recording the full settings decision and independently installing them through
the same Store. Retrying an uncertain operation retains its original action,
revision and fixed intent. Existing installed environments can be selected after
the bundle acquisition tree is gone, but current independent approval, supported
tool policy, actual system availability and complete installed bytes are rechecked.
The panel can verify an exact installation without launching it. Installation,
plugin enablement and per-execution Core consent are separate; these controls do
not run a worker, authenticate network updates or claim an OS sandbox.

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
