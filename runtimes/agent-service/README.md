# Internal Member Execution Adapter (`@tsumugi/agent-service`)

`@tsumugi/agent-service` is the internal Node.js worker runtime that executes AI team members on top of `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` (pinned at `1.3.0`). Spawned by [`tsumugi-plugin-host`](../../crates/plugin-host/README.md) (`member::run_member`), it wraps a single Pi agent instance (`MemberKernel`) over an internal stdio channel generated from `tsumugi-core`'s Rust types.

## Architecture and Execution Flow

### Controlled Transport and Budget Accounting

The current member profile targets OpenAI-compatible Chat Completions over SSE with automatic provider retries disabled:

- Pi serializes conversation messages and parses SSE responses, while delegating all HTTP I/O to the Host-controlled transport callback.
- The worker never holds ambient API keys or network credentials. For each physical request attempt, the Host binds the destination endpoint, attaches credentials, reserves budget against the shared `WorkPlan`, enforces live permissions, and records token usage.
- **Usage Reporting**: The worker forwards the provider's raw usage receipt (prompt and completion totals, plus optional `cacheRead`, `cacheWrite`, and `reasoning` counts formatted as non-negative integer decimal strings when valid, or `null` when absent) and strips Pi's normalized zero-fallbacks and synthetic price calculations from event and result projections. If a provider omits usage data, budget occupancy remains explicitly unknown rather than defaulting to `0`.

### Request Preparation and Shared Context Views (`prepare` & `transformContext`)

Before each model request (including tool follow-up turns), `MemberKernel` awaits the Host's `prepare` callback:

1. `prepare` returns the authoritative Host request identity and an optional frozen shared context view (containing UTF-8 text, author identities, source references, and sharing basis supplied by Core).
2. Pi's `transformContext` hook injects that view as a single untrusted user-data message immediately after the leading system declarations for that request only.
3. Shared context views never accumulate in Pi's persistent local transcript or impersonate assistant/tool messages; returning a `null` view on a subsequent turn removes the prior view projection.
4. Any user guidance queued while `prepare` is in flight is held until the next request boundary so the already-captured view basis remains consistent with the serialized request body.

### Tool Calls and Lifecycle Shutdown

- **Tools**: Domain and application tools execute through Core's existing broker and mutation boundaries. `beforeToolCall` checks tool admission against the active plan, and `afterToolCall` formats the model-visible tool result. Scopes without tools or scopes containing only native tools run without requiring synthetic JavaScript tool grants.
- **Cancellation & Close**: Calling `close` stops local admission, clears queued guidance, and waits for Pi to abort in-flight work. Event listeners are awaited through `agent_end` before the worker exits and the Host releases the temporary staging directory.

## Building, Testing, and Packaging

Requires Node `>=26.10.0 <27`, `pnpm` 12, and a populated offline dependency cache (including the platform `esbuild` binary). The workspace configuration disables the unused `@google/genai` preinstall and `protobufjs` postinstall scripts.

From the repository root:

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --dir runtimes/agent-service build
pnpm --dir runtimes/agent-service test
```

### Regenerating the Member Channel Contract

After modifying the member channel types in `tsumugi-core`, regenerate the JSON schema, `profile.json`, and TypeScript bindings:

```sh
pnpm --dir runtimes/agent-service generate:contracts
```

### Packaging the Standalone Member Runtime Artifact

To verify contract currentness and bundle the standalone member runtime directory (for `TSUMUGI_TEST_MEMBER_ARTIFACT` or the desktop `bundled-runtime` feature):

```sh
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir runtimes/agent-service package:runtime --output "$PWD/apps/desktop/src-tauri/resources/member-runtime"
```

`package:runtime` compiles the TypeScript source directly with `esbuild` (resolving ESM entrypoints so UMD relative imports are bundled cleanly) into a self-contained `worker.mjs`, its format manifest, and third-party license notices (including [`licenses/pi-1.3.0.txt`](licenses/pi-1.3.0.txt) from [`earendil-works/pi` `v1.3.0`](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE)):

- Source maps and repository metadata are omitted, and output files are written with `0644` permissions.
- The target `--output` directory must not already exist (its parent directory must exist).
- When building the desktop app with the `bundled-runtime` Cargo feature on macOS arm64 (macOS 13.5+), the build verifies this `member-runtime` tree alongside the pinned Node distribution in [`node-distribution.macos-aarch64.json`](../javascript-host/scripts/node-distribution.macos-aarch64.json). See [the offline desktop preparation guide](../../docs/plugin-distribution.md#prepare-and-build) for full bundling instructions.
