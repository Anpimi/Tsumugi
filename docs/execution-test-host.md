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
