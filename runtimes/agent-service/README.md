# Internal member execution adapter

This internal workspace package uses `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` at the same pinned version. `MemberKernel` owns one Pi
instance and its local transcript. Application services supply the captured
context, original request identities, authorized tools and controlled transport.

The current profile is OpenAI-compatible Chat Completions over SSE. Pi serializes
messages and parses provider responses; the supplied host transport receives the
exact body and captured endpoint, without SDK authentication headers. The host
must bind the original destination, attach credentials, reserve every physical
attempt against the shared budget, enforce current permission and settle usage.
Automatic provider retries are disabled in this profile.

`prepare` is awaited before each model request, including tool follow-up turns.
It returns the original host request identity. Model, tool and lifecycle records
carry that association. Event listeners are awaited through `agent_end`; their
completion indicates local execution settlement, while business results still
require application receipts. Missing provider usage must retain unknown budget
occupancy: a normalized zero count alone is insufficient evidence of known usage.

Tool implementations use the application's existing mutation and sharing
boundaries. `beforeToolCall` checks admission, and `afterToolCall` controls the
model-visible result. Persist application revocation before calling `close`,
which closes local admission, clears queued guidance and waits for Pi to abort.

The member process uses an internal application channel generated from Core's
Rust types. It is separate from the SDK plugin Process protocol. The trusted
Host stages the captured application bundle with only the independently approved
Node tool, clears the environment, bounds frames and process lifetime, and waits
for the original child to exit before releasing its staging directory. Pi runs
without the Cordis Host or ambient credentials. Model capacity and prices remain
unknown unless supplied by their actual owner; normalized SDK zero values are
not authoritative billing records.

The desktop adapter selects the exact application-default Node identity from
build metadata and loads its independently installed, approved bytes. This also
supports scopes without tools and scopes containing only native tools. Empty
scopes retain their original model authorization, sharing, budget and dispatch
deadline; they do not require a fabricated tool consent. Actual domain tools
keep their independent captured permissions and original broker. Settings
revocation also stops the member's pending controlled IO.

The synthetic checks cover the real Pi packages, standalone bundle, owned
process boundary and a desktop/Core/domain-Worker tool loop with original
budget and cancellation assertions. Full native application acceptance and
real-provider quality, cache and billing evidence remain separate. A missing
member runtime is an explicit failure for Agent input; it does not select the
fixed single-completion path.

Use Node `>=26.10.0 <27`, pnpm 12 and the repository lockfile. Provision the
dependencies and platform esbuild binary from an existing offline cache before
preparation; missing inputs fail rather than trigger installation or a download:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --dir runtimes/agent-service build
pnpm --dir runtimes/agent-service test
```

The workspace explicitly denies the unused `@google/genai` preinstall no-op and
`protobufjs` version-diagnostic postinstall scripts. Their distributed JavaScript
is used as packaged; installation does not require these scripts.

Generate the member channel after editing its Core authority:

```sh
pnpm --dir runtimes/agent-service generate:contracts
```

The same generation emits `profile.json` and the TypeScript profile. The
packager and desktop build read that generated protocol identity; they do not
choose a separate version. Check the captured contract before packaging.

From the repository root, create a new standalone artifact directory before
using the optional desktop runtime bundle profile. Its parent must already
exist. Packaging compiles the member source directly and does not require a
previous `dist` build:

```sh
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
```

The output is a self-contained `worker.mjs`, its internal format manifest and
license notices, without source maps, repository metadata or runtime package
resolution. The build uses ESM package entry points so UMD relative imports are
not left unresolved. Existing output directories are refused. Runtime packaging
does not install or approve Node or any domain tool; those keep their original
installation, selection and consent requirements. The runtime profile maps this
artifact to `member-runtime/` beside the application resources. With
`bundled-runtime` enabled, the desktop build captures this complete bounded
tree through the same Host owner used at runtime. A missing entrypoint or a
protocol different from Core's generated profile fails the build. Preparation
does not run as part of the frontend build or Cargo build script. Review any
previous output explicitly or use a fresh checkout; a build never removes it.

The separately prepared Node tool retains the exact distribution pin in
[`node-distribution.macos-aarch64.json`](../javascript-host/scripts/node-distribution.macos-aarch64.json).
The optional desktop bundle currently supports only that macOS arm64 profile
and macOS 13.5 or later. The builder's Node version is not approval of a
redistributed or installed runtime. Follow the complete
[offline desktop preparation](../../docs/plugin-distribution.md#prepare-and-build)
before invoking the Tauri runtime bundle profile.

The pinned Pi npm artifacts omit their monorepo license. The retained
[Pi 1.3.0 notice](licenses/pi-1.3.0.txt) comes from the corresponding
[upstream tag](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE); the
packager includes it only for those exact package identities and versions.
