# Internal member execution adapter

This private workspace package uses `@earendil-works/pi-agent-core` and
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

This package currently has synthetic integration coverage. Desktop supervision,
the Rust streaming transport/budget bridge, domain Worker integration and managed
runtime packaging remain to be connected. It is not yet launched by the desktop
application. The tests exercise real Pi packages against isolated local HTTP
fixtures; they provide no real-provider quality, cache or billing evidence.

Use the workspace's pinned Node version and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm --dir runtimes/agent-service build
pnpm --dir runtimes/agent-service test
```

The workspace explicitly denies the unused `@google/genai` preinstall no-op and
`protobufjs` version-diagnostic postinstall scripts. Their distributed JavaScript
is used as packaged; installation does not require these scripts.
