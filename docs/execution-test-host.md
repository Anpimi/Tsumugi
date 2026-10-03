# Execution test host

The desktop Tasks view reads the project's persistent execution ledger. Normal builds do not register a synthetic operation or its injection command. To exercise generation, cancellation, recovery, and adoption without a translation or external provider, build the explicit test host from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @tsumugi/desktop exec tauri build --debug --no-bundle --features execution-test-host -- --locked
```

Add `--offline` after the final `--` when the Cargo dependencies are already cached. The executable is `target/debug/tsumugi-desktop.exe`; its web assets are embedded, so no development server is required.

Start it with an absolute path to a **new, nonexistent directory** whose parent exists:

```powershell
& .\target\debug\tsumugi-desktop.exe --fixture-directory 'C:\Temp\tsumugi-execution-check' --fixture-mode partial --fixture-grouped
```

The host creates a three-item synthetic project and starts its task. In the app, choose **Open project**, select that directory, then choose **Tasks** in the sidebar. Creating the fixture never overwrites an existing directory. To reopen a fixture after closing the app, launch the same test executable **without fixture arguments**, then open the existing directory.

Available modes:

| Mode | Behavior |
| --- | --- |
| `partial` | Two items succeed and one fails safely; retrying the failed item succeeds. |
| `success` | All three items generate saved outputs; adoption remains explicit. |
| `hold` | The first dispatched item waits for cancellation, then ends without a reliable result. Remaining items have not been dispatched. |
| `unknown` | Each dispatch ends without a reliable result; the explicit query returns its saved-test outcome. |

`--fixture-grouped` makes all three items one atomic adoption unit. Without it, each item is independently adoptable. The runner returns at 1.5-second intervals except in `hold` mode. Item ordering follows captured identities, so the safely failing item need not appear second on screen.

The feature also registers `seed_execution_fixture` for IPC tests. It requires the current `sessionToken`, `projectId`, a mode, `delayMs` from 0 through 5000, and `grouped`. It has no production menu entry. Fixture target tables are accepted only by this explicit feature; use a normal build and a separate fresh project for production schema checks.

## Manual checks

1. In `partial --fixture-grouped`, inspect the saved outputs, retry the single eligible failure, and adopt the group. Successful outputs must not be regenerated; all three target changes appear in the recorded receipt.
2. Close and reopen. The receipt and saved output remain available. Reopening does not dispatch old work automatically.
3. In a fresh `hold` project, attempt close, application exit, project switching, and directory rename. Return from the stop confirmation once, then confirm stopping. The active result becomes unknown; undispatched work remains cancelled. Failed project opening retains the old session and reports that work stopped.
4. In `unknown`, query one item explicitly. It becomes a generated, unapplied output. Unknown work has no generation retry action.
5. Change UI language between English and Simplified Chinese. Use the keyboard to enter Tasks, inspect an item, open and leave a confirmation, and return to the triggering control. Check layouts at the minimum window size.
6. Leave a project-name draft, enter Tasks, and return. The draft must remain. Removing a target locale must not let historical work recreate that scope.

Automated checks use real SQLite and the Tauri IPC handler with a mock window runtime:

```text
cargo test -p tsumugi-core --locked
cargo test -p tsumugi-desktop --features execution-test-host --locked
cargo test -p tsumugi-desktop --locked
pnpm --filter @tsumugi/desktop test
```

IPC, component tests, and successful builds do not establish native visual or keyboard acceptance. Record manual observations separately, including the source revision and whether the test feature was enabled.

## Project command scheduling

The desktop owns its session and SQLite connection on one project thread. All project commands, including reads, lifecycle changes, review and export, enter a FIFO queue without waiting on the window or async runtime thread. Session tokens and project identities are checked when the operation executes. Closing does not overtake an accepted write, and losing a reply does not cancel that write: use the existing action/receipt reconciliation flow.

Admission permits at most 32 normal operations and reserves four additional slots for close, execution cancellation and quiescence. Saturation returns the existing `busy` error before work is accepted. A split file-capture operation reserves its slot through its final session check, so queue saturation cannot strand its completion. File/capture work uses at most four blocking slots; native pickers have one separate slot. Their permits stay with the work even if a caller stops waiting.

Review cancellation is an independent, session-and-project-bound signal and does not wait behind a check. A synchronous database operation already running on the project thread is not forcibly interrupted; accepted close/cancel operations retain FIFO ordering. The execution ticker uses that same owner, so a long project operation can delay task projection even though the window remains responsive. Database read optimization and shorter QA transactions are separate concerns.

Operations taking at least 100 ms including queue time emit a diagnostic line with operation name, dispatch sequence, session epoch, queue milliseconds and work milliseconds. Epochs are local to the running process. These logs contain no request text, paths, project IDs or session tokens; work time includes SQLite and application processing and is not a per-query SQL trace.

For native scheduling checks, this test feature also consumes `review-page.json` and `review-check.json` through the same one-shot controls described in [source import](source-import.md#native-fault-checks). A `{"wait":true}` barrier pauses the actual project operation until its matching `.release` file appears (60-second deadline). Check window input while `review-page.reached` exists; check the independent cancel action while `review-check.reached` exists. Release the barrier before the deadline and verify the real operation's result. Synthetic delays isolate scheduling and do not establish real search performance. Keep these controls beside a dedicated test executable and use only disposable project data.
