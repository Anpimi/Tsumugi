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

The desktop adapter currently selects Node from a nonempty captured read-only
tool scope and retains that scope's independent process consent. Empty-tool and
native-only scopes still need the application's independent default Node
selection. They are not covered by this intermediate adapter. This limitation
does not change the target scope or grant new tool permissions.

The synthetic checks cover the real Pi packages, standalone bundle and owned
process boundary. Desktop/domain-Worker acceptance and real-provider quality,
cache and billing evidence must be established separately. A missing member
runtime is an explicit failure for Agent input; it does not select the fixed
single-completion path.

Use the workspace's pinned Node version and pnpm:

```sh
pnpm install --frozen-lockfile
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

Create a new standalone artifact directory before using the optional desktop
runtime bundle profile:

```sh
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
```

The output is a self-contained `worker.mjs`, its internal format manifest and
license notices, without source maps, repository metadata or runtime package
resolution. The build uses ESM package entry points so UMD relative imports are
not left unresolved. Existing output directories are refused. Runtime packaging
does not install or approve Node or any domain tool; those keep their original
installation, selection and consent requirements. The runtime profile maps this
artifact to `member-runtime/` beside the application resources.

The pinned Pi npm artifacts omit their monorepo license. The retained
[Pi 1.3.0 notice](licenses/pi-1.3.0.txt) comes from the corresponding
[upstream tag](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE); the
packager includes it only for those exact package identities and versions.
