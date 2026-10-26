# Execution test host

The desktop **Tasks** view is backed by the project's persistent execution ledger. Production builds do not expose synthetic operations or fault-injection hooks. To test task generation, cancellation, recovery, and adoption locally without configuring an external AI provider or translation plugin, build the desktop app with the `execution-test-host` feature from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @tsumugi/desktop exec tauri build --debug --no-bundle --features execution-test-host -- --locked
```

Append `--offline` after the final `--` if Cargo dependencies are already cached. The resulting binary (`target/debug/tsumugi-desktop.exe` on Windows) embeds the frontend assets, so no separate development server is needed.

## Running synthetic fixtures

Launch the test binary with an absolute path to a **new, nonexistent directory** inside an existing parent folder:

```powershell
& .\target\debug\tsumugi-desktop.exe --fixture-directory 'C:\Temp\tsumugi-execution-check' --fixture-mode partial --fixture-grouped
```

The host initializes a three-item synthetic project and starts its task (refusing to overwrite an existing directory). In the app, choose **Open project**, select that directory, and open **Tasks** in the sidebar. To inspect the same project after restarting the app, launch the test executable **without fixture arguments** and open the existing directory.

### Fixture modes and options

| Mode | Behavior |
| --- | --- |
| `partial` | Two items succeed and one fails with a retryable error; retrying the failed item succeeds. |
| `success` | All three items generate saved outputs ready for explicit adoption. |
| `hold` | The first dispatched item blocks until cancelled, then terminates with an unknown outcome while remaining items stay undispatched. |
| `unknown` | Every dispatch terminates with an unknown outcome; running an explicit outcome query resolves the saved test result. |

- Passing `--fixture-grouped` treats all three items as a single atomic adoption unit; omitting it allows each item to be adopted independently.
- The runner completes items at 1.5-second intervals (except in `hold` mode). Because items are ordered by captured identity, the failing item in `partial` mode does not necessarily appear second in the list.
- For automated IPC tests, `execution-test-host` also registers the `seed_execution_fixture` command, which takes `sessionToken`, `projectId`, `mode`, `delayMs` (`0`–`5000`), and `grouped`. Fixture target tables are only accepted when `execution-test-host` is enabled; use a standard build and a fresh project to verify production schema behavior.

## Continuation identity and current storage

Task resume and safe-failure retry run through `continue_execution`, which requires a fixed action identity, the original attempt and consistency unit, the exact set of remaining items, and the expected task cancellation revision:

- **Transactional ledger records**: The original intent, canonical request digest, and new attempt identity are committed together in a single execution-ledger transaction. `read_execution_continuation` retrieves a single receipt by action identity, while `read_execution_continuations` pages through an attempt's receipts in sequence order (a non-null cursor indicates additional pages).
- **Idempotent local replay**: Resubmitting a recorded request returns the stored receipt before evaluating current eligibility, without re-enqueuing work, re-invoking the producer, or renewing scheduling authority after reopening. Submitting a modified payload under the same action identity returns a conflict. Previously succeeded items remain part of the consistency unit without being dispatched again. Note that local replay idempotency applies to the project ledger and does not guarantee exactly-once execution or billing on an external provider.
- **Outcome queries vs. continuations**: The legacy anonymous `recover_execution` route rejects resume and retry requests; it is used solely for session-owned outcome queries and output validation.
- **Schema compatibility**: Development builds support only the [current database schema](../README.md#development). Opening a project validates the table layout, frozen inputs, result references, and continuation bindings. Projects using older development schemas are refused without automatic migration or reset; keep those directories intact and reimport the original source files into a new project.

## Verification checklists

### Automated test suite

Automated tests run against real SQLite databases and the Tauri IPC handler using a mock window runtime:

```text
cargo test -p tsumugi-core --locked
cargo test -p tsumugi-desktop --features execution-test-host --locked
cargo test -p tsumugi-desktop --locked
pnpm --filter @tsumugi/desktop test
```

### Manual UI and lifecycle checks

Because automated IPC and component tests do not cover native window rendering or keyboard navigation, verify the following flows manually in the test host (recording the source revision and build features used):

1. **Grouped retry and adoption**: Launch with `partial --fixture-grouped`, inspect the saved outputs, retry the single failed item, and adopt the group. Verify that already succeeded items are not regenerated and that all three target updates appear in the adoption receipt.
2. **Persistence across restarts**: Close and reopen the project. Verify that the receipt and saved outputs remain intact and that reopening does not automatically dispatch pending work.
3. **Cancellation and lifecycle guards**: In a fresh `hold` project, trigger project close, app exit, project switch, and directory rename. Cancel out of the stop confirmation dialog once, then confirm stopping. Verify that the active item transitions to `unknown`, undispatched items remain `cancelled`, and a failed project open keeps the current session active.
4. **Resolving unknown outcomes**: In an `unknown` project, run an explicit outcome query on one item and verify that it transitions to a generated, unapplied output (with no generation retry button offered while `unknown`).
5. **Localization, keyboard, and layout**: Switch the UI language between English and Simplified Chinese. Navigate into **Tasks** using only the keyboard, inspect an item, open and dismiss a confirmation modal, and verify focus restoration and layout at the minimum window size.
6. **Draft and scope isolation**: Leave an unsaved project-name draft, switch to **Tasks**, and return to confirm the draft is preserved. Remove a target locale and verify that historical tasks cannot recreate the removed locale scope.

## Project command scheduling

Each open project owns a dedicated background thread for its session state and SQLite connection. All project commands—including reads, lifecycle transitions, reviews, and exports—enter a bounded FIFO queue so they never block the UI window or async runtime threads:

- **Queue capacity and slot reservations**: The queue admits up to 32 normal operations and reserves 4 additional slots for project close, task cancellation, and quiescence. When the queue is full, new requests fail immediately with a `busy` error. Split file-capture operations hold their reserved slot until their final session check completes, using at most 4 blocking file-capture slots and 1 separate slot for native file/folder pickers.
- **Session and ordering guarantees**: Session tokens and project IDs are validated when an operation executes on the project thread. Closing a project does not jump ahead of an already accepted write, and losing an IPC response does not cancel an accepted write (use the standard receipt reconciliation flow). Review cancellation uses an independent session-and-project signal that bypasses the queue wait, though an already executing synchronous SQLite statement runs to completion before the next queued command starts.
- **Slow-operation diagnostics**: Any operation whose total time (queue wait + execution) reaches 100 ms logs a diagnostic entry containing the operation name, dispatch sequence, process-local session epoch, queue time (ms), and work time (ms). Diagnostic logs omit request payloads, file paths, project IDs, and session tokens.
- **Native scheduling fault checks**: When built with `execution-test-host`, the scheduler also reads `review-page.json` and `review-check.json` from `source-fixture-control/` using the one-shot barrier mechanism described in [source import](source-import.md#native-fault-checks). A `{"wait":true}` rule writes a `.reached` marker and pauses the project thread for up to 60 seconds until a matching `.release` file is created, allowing you to test UI responsiveness while `review-page.reached` is active and independent review cancellation while `review-check.reached` is active. Use these barriers only with a dedicated test binary and disposable project data.
