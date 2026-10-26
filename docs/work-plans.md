# Fixed application work plans

A `WorkPlan` is Tsumugi Core's internal contract (`crates/core/src/application`) for scoping, authorizing, and tracking manual or AI-assisted translation workflows across a fixed set of source entries. Work plans are an internal application mechanism rather than a public plugin SDK API, and plugins or models never receive direct access to human-authorization methods, `ProjectStore`, or the raw execution runtime.

## Preparing and verifying a work plan

### Plan preparation (`ProjectStore::prepare_work_plan`)

`ProjectStore::prepare_work_plan` is a read-only operation against a single SQLite snapshot. It takes an optional `AiConfig`, a target locale, a bounded set of source unit IDs, and `PlanOptions`, and returns a `WorkPlan` (internal format version `3`, including a nullable maintenance basis; see the [development format boundary](../README.md)) containing:
- A unique plan ID and canonical digest
- Captured source revisions and current translation selection IDs
- Explicit stage modes (`manual`, `assisted`, or `skipped`) across five stages: **understanding**, **resources**, **generation**, **checks**, and **delivery**

By default, the Core library enables assisted candidate generation while keeping other stages manual; new drafts in the Desktop AI workbench recommend assisted candidate generation paired with assisted checks and manual selection.

- **Manual plans** require no `AiConfig` (passing an unused `AiConfig` to a manual plan is rejected so it cannot accidentally acquire provider scope).
- **Assisted generation plans** lock the execution input: provider destination, model and parameters, request budgets, selected data-sharing categories, source revisions, included glossary terms and context, omission metadata, and requested post-generation effects. Only credential environment-variable names are stored in the plan—secret values are never included.

### Evidence verification (`ProjectStore::verify_work_plan`)

`ProjectStore::verify_work_plan` is a read-only check that compares a captured plan against the project's current state. It rejects the plan if:
- The project identity does not match,
- Any targeted source entry was modified,
- Relevant shared resources changed (even if an earlier query returned zero matches, newly added matching context changes the evidence), or
- A targeted entry's selected translation changed.

Unrelated project renames or global resource-clock increments that do not affect the plan's scoped evidence do not invalidate the plan.

## Authorizing and controlling execution

### Human authorization (`authorize_work_plan`)

`authorize_work_plan` records human consent inside the store's write transaction. It requires explicit confirmation, the exact plan digest, the requested effect set, and an expiration timestamp within 24 hours.

Authorization returns an execution input carrying an `AutomationLease` that references the stored grant in SQLite (alongside control generations, action receipts, execution associations, checked selection receipts, and unit protection). Supported automatic effects are:
- `SaveCandidate`: Saves generated translation candidates through the standard adoption ledger (`saved`).
- `RunChecks`: Runs the captured set of domain/Core checkers on saved candidates and records the check evidence (`checked`) without selecting the candidate as the active translation.
- Selection policy (`checked-selection-3`): Automatically selects passing candidates (either for missing translations only, or replacing the captured selection); requires `RunChecks`.

In the Desktop AI workbench, authorization and task start are separate steps: if saving an authorization succeeds but enqueueing the initial task fails, the saved authorization remains available to start or stop explicitly without re-prompting.

### Pause, stop, takeover, and continuation

Users can **pause**, **stop**, **take over manually**, or **continue** a plan at any time:
- **Pause, stop, and takeover** increment the persisted control generation, cancel queued tasks, and signal running workers. Every enqueue, dispatch, HTTP reservation, HTTP send, candidate save, and selection re-checks the active authority. Closing a project automatically pauses all active grants and signals running workers; when a new project host starts, it pauses any crash-surviving grants before opening the session.
- **Budget accounting**: Child tasks are submitted with `parent_task` so all requests charge the root plan's shared budget. Each child item must preserve the parent's item scope, payload, and ordered dependencies. Control transitions never refund consumed request budgets, erase uncertain external exposure, or roll back already committed candidates. Use `work_plan_status` to inspect live state and budget consumption.
- **Continuation**: Resuming a paused or reopened plan requires a fresh human confirmation, a new expiration time, and a valid plan basis. Selections made by the plan's own `checked-selection-3` policy count as valid progress, whereas manual edits or selections from another plan change the basis and require preparing a new plan.

## Scoped Agent execution and reference tools

For an active, authorized plan with a registered task budget, the application host can open a session-bound Agent scope. This scope locks the `AutomationLease` and shared budget anchor and exposes a narrow set of operations to the Agent: preparing and starting candidate generation or read-only tool queries for subsets of the planned source units, and reading back its own dispatched tool outputs.

### Reference tool queries in a work plan

An assisted plan can include read-only reference tools configured in the AI workbench:
- **Preparation (`prepare_work_plan_with_tools`)**: Each configured provider row binds an opaque tool handle, the SDK capability binding, an approved runtime environment, the installed settings revision, package/runtime origins, and query target/category options. All rows in the plan share a single total tool invocation limit across all attempts and continuations.
- **Unsandboxed execution consent (`query-tools`)**: Authorizing tool execution in a work plan requires a separate human confirmation for unsandboxed local execution. The tool execution window is capped at the earlier of 10 minutes or the overall plan expiration; recovering or replaying an action does not extend this timer, and reopening a project requires a new `Continue` confirmation to run tools again.
- **Dispatched tool calls**: An Agent tool proposal passes only child task/attempt IDs, a pre-captured tool handle, and a non-empty subset of the plan's source units. Core constructs the literal SDK query payload from the captured source text, re-verifies the runtime and settings revision, and commits the delegated grant and shared budget reservation in a single ledger transaction (one invocation per item). Each tool attempt uses its own child attempt ID as its `Attempt` component scope.
- **Reading tool results (`readToolAttempt` and `readToolOutput`)**: The Agent can poll progress and read structured reference outputs for its own enqueued tool attempts while the scope remains active. Tool outputs stay unapplied—they are not automatically injected into model prompts or adopted into project terminology—and remain readable in the workbench across plan control changes.

## Generation components and the generation service

In addition to built-in model continuation, a work plan can run an installed JavaScript generation component (in `Project` or `Attempt` scope) that delegates model requests back to Core's [generation service contract](../crates/plugin-sdk/docs/generation.md) (`schemaVersion: 1`, `behaviorVersion: 1`, `External` effect).

### Component discovery and lifecycle

1. **Discovery (`read_plugin_generation_component`)**: Verifies that the installed JavaScript component declares a required `Single` dependency on the canonical generation service, matching `ProjectService` permission, `External` effect, and exact SDK input/receipt/error contracts, and pairs it with an approved JavaScript runtime.
2. **Preparation (`prepare_work_plan_generation_component`)**: Binds an outer plugin attempt, child task/attempt identities, and a subset of 1–100 distinct source unit IDs within the active `WorkPlan` scope.
3. **Execution (`start_work_plan_generation_component`)**: Requires explicit consent for unsandboxed plugin execution and an ordinary plugin grant. The outer plugin invocation carries no `AutomationLease` of its own; instead, when the component calls the Host generation service, the service validates the request against the parent `WorkPlan` scope, locks the ancestor budget and remaining deadline, and atomically enqueues the child model task.
4. **Discard (`discard_work_plan_generation_component`)**: Discards an unstarted component preparation without cancelling active runs or erasing ledger records.

### Service semantics and example implementation

The generation service returns an enqueue receipt containing the child identities and captured input digest (without exposing any grant handle), and does not wait for the model HTTP call to finish:
- **Receipt vs. completion**: An enqueue receipt only confirms that the child model task was accepted into the queue; actual model execution, candidate saving, and checks happen asynchronously under the child attempt and shared plan budget.
- **Settings and authority tracking**: Core attaches the installation owner's one-way settings revocation signal to the child origin and checks it before every dispatch, HTTP reservation, and HTTP send. The child association stays active until child execution, retired producers, and authorized effects/checkers all settle.
- **Reference example**: The Philosophy plugin's [Generation service client](https://github.com/Anpimi/tsumugi-plugins/blob/main/examples/philosophy/README.md#generation-service-client) (`generation-delegate`) demonstrates an Attempt-scoped generation component alongside an independent read-only knowledge query/check component in the same package.

## Automatic selection and entry protection

### Entry protection (`set_work_protection`)

To prevent background automation from overwriting a translator's active work, the translation editor records persistent unit protection before making an entry editable:
- Opening an unprotected entry in the editor calls `set_work_protection` first; the draft remains read-only until the protection write and current state read complete.
- Manual saves and manual translation selections also record unit protection in the same transaction.
- Protected entries cannot be overwritten by automatic selection policies. Protection persists across project restarts until you explicitly release it (which checks the current entry, locale, source revision, selection identity, and protection revision, and blocks if the editor has unsaved changes).

### Checked automatic selection (`checked-selection-3`)

When a plan is authorized with `RunChecks` or an automatic selection policy:
1. Saved candidates are checked on background worker threads using the independently approved domain and Core checkers (`prepare_automatic_selection`).
2. `commit_automatic_selection` re-verifies the active plan grant, source revision, current selection, scoped shared resources, and unit protection in a short SQLite transaction.
3. For candidate-only check plans, the receipt records the `checked` status and full rule evidence without changing the entry's active translation.
4. For selection policies (`missing-only` or explicit replacement), all required checks must complete with zero errors, warnings, or unavailable rules—even if a warning could be manually waived in the review UI. If any check fails or the unit is protected, the candidate remains saved with its check report and blocked reason recorded on the receipt. When all checks pass, the candidate is selected and its QA record is committed atomically. Automatic selection never marks an entry as human-reviewed or release-approved.

## Installed generation-client conformance

On Apple silicon macOS (`aarch64`), the `generation_tests::philosophy_generation` test suite exercises the Philosophy generation client plugin end-to-end through registered desktop commands, the generation service broker, and synthetic local HTTP responses.

Prepare and inspect both the Philosophy package and the WebVTT package, set their paths and digests alongside the approved JavaScript runtime environment variables (see the [Host conformance documentation](../crates/plugin-host/README.md)), and run:

```sh
cargo test -p tsumugi-desktop --bin tsumugi-desktop --features execution-test-host \
  generation_tests::philosophy_generation --locked -- --test-threads=1
```

Required environment variables:
- `TSUMUGI_TEST_GENERATION_PACKAGE` and `TSUMUGI_TEST_GENERATION_DIGEST` (Philosophy generation package)
- `TSUMUGI_TEST_PLUGIN_PACKAGE` and `TSUMUGI_TEST_PLUGIN_DIGEST` (WebVTT package)
- `TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST`, and `TSUMUGI_TEST_RUNTIME_APPROVAL`

The suite verifies enqueue receipt handling versus child completion, shared budget tracking across success, network disconnects, and in-flight pauses, and independent manual knowledge queries and review checks in temporary profiles without calling external model APIs.

## Installed shared-query conformance

On Apple silicon macOS (`aarch64`), the `installed_conflicting_knowledge_choices_share_manual_batch_and_agent_queries` test verifies manual single/batch queries and work-plan Agent tool queries across multiple installed knowledge plugins with conflicting terminology preferences.

To prepare the test fixtures:
1. Build and inspect the standard WebVTT (`TSUMUGI_TEST_PLUGIN_PACKAGE` / `TSUMUGI_TEST_PLUGIN_DIGEST`) and Philosophy (`TSUMUGI_TEST_KNOWLEDGE_PACKAGE` / `TSUMUGI_TEST_KNOWLEDGE_DIGEST`) packages.
2. Create a second controlled copy of the Philosophy plugin (`TSUMUGI_TEST_SECOND_KNOWLEDGE_PACKAGE` / `TSUMUGI_TEST_SECOND_KNOWLEDGE_DIGEST`):
   - Keep the query/check engine and public contracts unchanged.
   - Change the terminology revision to `independent-editorial-2` and change the soundness term preference from `可靠性` to `健全性`, then regenerate the Resource pins with the example's preparer script.
   - Update the generated plugin ID and the text checker's own-package guard to `philosophy-alternative`, and package that copy into a separate directory without re-running the preparer script afterward.
3. Provide the approved runtime paths (`TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST`, and `TSUMUGI_TEST_RUNTIME_APPROVAL`) and run:

```sh
cargo test --locked -p tsumugi-desktop --features execution-test-host installed_conflicting_knowledge_choices_share_manual_batch_and_agent_queries -- --test-threads=1
```

The test exercises both installation orders, verifies that conflicting query outputs preserve their distinct provider and Resource provenance without mutating translations or model budgets, and checks independent tool/model budget enforcement, duplicate-start reconciliation, package disabling, and project reopen behavior against a local loopback model fixture.

## Directed human guidance

Team work plans allow a user to send targeted guidance messages to an active team member during execution:
1. When preparing and authorizing a team plan, the plan discloses whether human-submitted guidance is enabled for each model destination.
2. During execution, select an approved team member and a planned source entry, review the member's role, model destination, and your message text, and confirm sending. (This profile sends a plain message body to a specific recipient/role/target; it does not attach external files, wake idle members, or spawn new work items.)
3. Tsumugi records the message in the team ledger with a stable identity and returns a local receipt.
4. The next authorized model request for that member includes the message through Core's frozen context view and records that the message was consumed by that exact request ID (requests that were already captured in flight are unaffected).

Every guidance submission is checked against the active `AutomationLease`, recipient role, target entry, and remaining model request budget—if no future request budget remains, new guidance is rejected while in-flight requests finish normally. If a submission acknowledgement is lost, look up or retry the original action identity rather than sending a duplicate message. Saved messages and receipts remain readable after stopping or reopening a project.
