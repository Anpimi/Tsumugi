# Experimental desktop read-only tools

Tsumugi's desktop reference-query workflow lets users and work-plan agents run read-only plugin tools defined with the SDK's [read-only tool Resource](../crates/plugin-sdk/docs/tools.md). Tsumugi manages tool discovery, session authorization, execution consent, and task tracking, while each plugin package defines its own query capability, input/output/error contracts, and reference guidance.

## Declared reference-query views

A JavaScript component can declare a host-rendered `Ui` contribution with `slot: "reference-query"` and the `tsumugi.capability-tool-declaration` contract (`schemaVersion: 1`, `behaviorVersion: 1`).
- The Host binds the `Ui` contribution to the single `Resource` using that exact schema within the same package and component.
- That `Resource` must reference a read-only query capability from the same component and define a `query` presentation.
- Packages with missing or multiple matching Resources, duplicate `reference-query` views in the same component, or unsupported slots/versions are rejected (Tsumugi never falls back to matching by name or registration order).

When opening a view, `read_plugin_ui` takes `{ package, uiId }`, verifies that the package is installed, approved, and enabled, and returns the resolved package, component, `Ui`, `Resource`, tool binding, and settings revision without starting a runtime or executing code. The UI then loads the tool via `read_plugin_tool` and verifies that the `Ui` and tool bindings match.

In **Resources → Reference queries**, declared `Ui` views and standard Resource-only tool packages share the same query interface:
- Plugins never supply custom DOM, CSS, application state, or native bridge code through `reference-query`.
- If multiple packages provide reference tools, you must select one explicitly.
- Updating, disabling, or uninstalling a package makes its previous view unavailable while keeping any unsaved local query drafts and pending operation recovery controls accessible.

## Query controls and execution

### Building and routing queries in the UI

An SDK `query` presentation defines a fixed input template, selectable target and category options, and result table columns. The SDK's `createToolQuery` helper builds single-item or batch request payloads and distinguishes empty matches from malformed outputs.

In **Resources → Reference queries**:
1. Select an installed package, an approved runtime environment, and the tool's target and category options.
2. Enter one or more query strings. You can also send text directly from the translation editor using **Look up source text** or **Look up selected draft text**, which appends the literal text into your query draft (reusing a single blank row if present) without altering unsaved editor text. Active IME composition finishes before routing, and routing is blocked while an uncertain operation is awaiting reconciliation.
3. Click **Review** to capture a preflight snapshot of the batch. Editing the query inputs afterward invalidates the review and requires capturing a fresh preflight before running.
4. Confirm per-attempt execution consent to run the query.

Results are matched back to their captured item IDs and rendered in escaped reference columns (or shown as an explicit empty match; malformed outputs are reported as errors). Query results are strictly for reference—they do not modify project translations, terminology, or resources, and remain readable in history even if the plugin is later disabled. Switching tabs preserves your draft, while leaving the view discards uncommitted preflight state.

### IPC lifecycle (`read`, `prepare`, `start`, `discard`)

 Rust/Serde definitions own the internal IPC shapes. After changing any IPC types, regenerate frontend contracts with `pnpm generate:contracts` and call them through `pluginCommands.tool`, `executionCommands.prepareTool`, `executionCommands.startTool`, and `executionCommands.discardTool`:

1. **`read_plugin_tool`**: Takes the exact package identity/digest, tool Resource ID, and approved runtime digest. It verifies the installed package, binds the target capability, checks supporting Resource/Skill files, verifies runtime compatibility, and returns the tool view with the current settings revision and provenance.
2. **`prepare_plugin_tool`**: Requires an authorized project session, a caller-owned attempt ID, the selected tool binding, and one or more JSON `payloads`.
   - **Scope binding**: Manual tools support `Project` and `Attempt` component scopes (`Attempt` scope uses the attempt ID as its scope ID), as well as the shared `Application` profile described below. The scope is locked into the Core input digest before consent. Attempt-scoped query tools cannot require or offer host services (the generation service adapter is reserved for generation components).
   - **Limits and idempotency**: Core assigns stable item IDs to each payload and enforces a total input limit of 4 MiB and 2,000 items (in addition to the capability's own per-item input limit). Opaque result encoding reserves 8× the declared output size plus 16 KiB of metadata within Core's per-result and aggregate attempt caps. Repeating `prepare_plugin_tool` with the same attempt ID and parameters returns the existing capture, whereas changing parameters for the same attempt ID is rejected. Each project session holds one active preflight at a time.
3. **`start_plugin_tool`**: Accepts the reviewed attempt/input digest and a strict start consent object (`grantId`, original expiry, explicit consent to unsandboxed execution, and `applicationExecution: boolean`, which is `false` for `Project`/`Attempt` scopes). Before dispatching through `RunnerProxy`, Tsumugi re-verifies the package, runtime, and settings revision. Repeating an already accepted start returns its persisted acknowledgement without spawning a duplicate worker or extending the grant expiry.
4. **`discard_plugin_tool_preflight`**: Discards an unstarted preflight for the specified attempt ID without cancelling already queued or running tasks (use the standard task cancellation command to stop an active task).

### Work-plan Agent tool queries

When a tool is invoked by the [work-plan Agent](work-plans.md), its package, runtime, query options, source unit subset, and shared invocation budget are locked when the work plan is authorized:
- Running tools in a plan requires separate human consent for unsandboxed local execution, capped at 10 minutes (preserved across recovery).
- Each tool call runs under its own child attempt ID with an atomic delegated grant and enqueue transaction.
- The Agent's `prepareTool` and `startTool` methods only accept pre-captured tool handles, subsets of planned source units, and prepared attempt IDs—the Agent cannot pass arbitrary JSON payloads or extend permissions.

## Shared Application query instances

Read-only Tool components can also use `Application` scope so a single worker process can serve queries across multiple open projects during an app session.

### Eligibility

A component qualifies for shared `Application` scope if it declares no required service dependencies and no `ProjectService` permissions, and is either:
- A **JavaScript Tool component** where every callable capability in its Process protocol 3 roster (up to 128 unique callables) is read-only, or
- A **Native (Rust) Process 3 worker** with a single read-only callable capability.

Native multi-callable workers, components that require or offer project services, domain Source/Translation/Review/Build capabilities, work-plan Agent tools, and generation components do not support `Application` scope.

### Lifetime consent and isolation boundaries

- **Instance reservation**: Clicking **Review queries** for an `Application`-scoped tool reserves an instance UUID and activation generation (`applicationScope`) without starting the process, and lists all capabilities in the component's roster (`applicationCapabilities`). For `Project` and `Attempt` tools, `applicationScope` is `null` and `applicationCapabilities` is empty.
- **Dual consent on first run**: Starting the instance for the first time requires both standard per-query consent and a separate checkbox authorizing the shared instance to stay alive until you quit Tsumugi, click **Stop shared instance**, or disable/revoke the package.
- **Reusing a running instance**: Subsequent queries—including queries for sibling read-only tools in the same JavaScript component or queries from other open projects—reuse the running process. However, every query still requires its own fixed input capture, capability/profile selection, project authorization, grant, and deadline. Closing one project revokes that project's permissions while allowing the shared process to keep serving other open projects.
- **Memory and sandbox note**: Shared instances run unsandboxed in a single OS process and can retain in-memory state and previous inputs across projects until stopped. Only authorize shared lifetime for packages you trust across all projects you open in the session.

### Managing, stopping, and exiting shared instances

The query preview displays the instance's live status (`reserved`, `active`, `stopping`, or `stopped`; internal IPC uses `executionCommands.applicationInstance` and `executionCommands.stopApplicationInstance`):
- **Manual stop**: Clicking **Stop shared instance** from any project interrupts in-flight calls on that shared worker while preserving local query drafts and saved ledger history. Tsumugi waits for the OS child process to exit before reporting `stopped` or completing package uninstallation. Starting a new query afterward reserves a fresh instance UUID and requires new lifetime consent.
- **Session limits**: Session I/O, frame, `stderr`, and invocation limits apply cumulatively across the life of an activation. If an instance fails, is cancelled, or exhausts its budget, it is retired without automatic restart.
- **Application exit**: When you quit Tsumugi, the app closes new instance admission, revokes all active lifetime leases, and waits for shared worker processes to exit before destroying the native window. If a shutdown is still draining, the window stays open; if you cancel quitting (for example, due to unsaved editor changes) or window closure fails, you can click **Allow new shared instances** in the app banner once shutdown finishes draining to re-enable starting new instances.
