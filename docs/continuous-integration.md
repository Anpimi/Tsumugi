# Continuous Integration

[The workflow](../.github/workflows/ci.yml) runs for pull requests and pushes to
`main` that change application, crate, runtime, vendored dependency or lockfile
inputs. It can also be started manually. Documentation-only changes do not
schedule these code checks.

The workflow uses Node **26.10.0**, pnpm **12.8.1** and Rust **1.99.0**. Rust's
declared minimum version remains in the workspace manifest; this CI toolchain is
the selected verification environment, not a separate minimum-version claim.
GitHub Actions are pinned by commit. Jobs use frozen pnpm dependencies and locked
Cargo dependencies, with caches for downloaded packages. Build outputs, runtime
approvals and local project data are not cached.

## Checks

| Job | Environment | Scope |
| --- | --- | --- |
| Frontend build and behavior | Ubuntu 24.04 | TypeScript/Vite build and focused editing, import, source, review, release, conversation and IPC tests |
| Rust, process channels and generated contracts | macOS 15 arm64 | SDK contract tests with schema support, Core library tests, Host library and actual conformance subprocess tests, all four contract generators in check mode, SDK JavaScript receivers, and both JavaScript runtime builds/tests |

Each command is an ordinary workflow step. A failed command fails its job;
generated files are checked rather than regenerated into a passing checkout.
The process tests use the repository's own synthetic conformance worker.
Prebuilt external plugin packages and environment-dependent ignored tests remain
explicit opt-in checks described in the [Host README](../crates/plugin-host/README.md).
Skipped tests do not establish those external capabilities.

## Reproducing Checks Locally

Use the declared Node/Rust versions and install pnpm 12.8.1 with your existing
tool manager. From the repository root, install dependencies once:

```sh
pnpm install --frozen-lockfile
cargo fetch --locked
```

The frontend job runs:

```sh
pnpm --dir apps/desktop build
pnpm --dir apps/desktop test --maxWorkers=2 \
  src/TranslationDraftSession.test.tsx \
  src/app-v2/features/editor/translationDrafts.test.ts \
  src/app-v2/features/editor/SegmentEditor.test.tsx \
  src/TranslationImportSession.test.tsx \
  src/SourceDraftSession.test.tsx \
  src/ReviewBatchSession.test.tsx \
  src/ReleaseDraftSession.test.tsx \
  src/app-v2/features/assistant/ConversationPanel.test.tsx \
  src/app-v2/features/assistant/ConversationWorkPlanPanel.test.tsx \
  src/ipcContracts.test.ts
```

The Rust/contract job runs:

```sh
cargo test -p tsumugi-plugin-sdk --tests --features schema --locked
cargo test -p tsumugi-core --lib --locked -- --test-threads=2
cargo test -p tsumugi-plugin-host --features conformance-worker --lib --test process --locked -- --test-threads=2
pnpm --dir crates/plugin-sdk check:contracts
pnpm --dir runtimes/javascript-host check:contracts
pnpm --dir runtimes/agent-service check:contracts
pnpm --dir apps/desktop check:contracts
TSUMUGI_PLUGIN_CONTRACT="$(cd "${CARGO_TARGET_DIR:-target}" && pwd)/debug/tsumugi-plugin-contract" \
  pnpm --dir crates/plugin-sdk test
pnpm --dir runtimes/javascript-host build
pnpm --dir runtimes/javascript-host test
pnpm --dir runtimes/agent-service build
pnpm --dir runtimes/agent-service test
```

As in CI, `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_TEST_DEBUG=0` reduce intermediate build storage. Keep using an
existing `CARGO_TARGET_DIR` when appropriate. Contract generators reuse the
locked Rust dependencies offline and build the SDK CLI used by the JavaScript
receiver tests; fetch dependencies before their first run.

These checks verify source behavior and generated interfaces. Complete desktop
resource preparation, application packaging, native GUI use, real providers and
game loading have separate environments and evidence. Prepare an application
candidate with the [distribution instructions](plugin-distribution.md#prepare-and-build);
a green source workflow does not establish those acceptance results.
