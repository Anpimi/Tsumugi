# Fixed application work plans

A `WorkPlan` is Tsumugi Core's internal contract (`crates/core/src/application`) for scoping, authorizing, and tracking manual or AI-assisted translation workflows across a fixed set of source entries. Work plans are an internal application mechanism rather than a public plugin SDK API, and plugins or models never receive direct access to human-authorization methods, `ProjectStore`, or the raw execution runtime.

## Project conversation records

Core and desktop IPC can keep project threads and ordered human messages before a work plan exists. Each thread has its own identity. Messages retain their original whitespace and Unicode; an untitled thread uses an explicit `null` title. Reads use decimal cursors and return at most 50 complete records within 256 KiB, with a cursor for the next page.

Creating a thread or appending a message uses an action identity bound to the full request. Repeating that request returns its original receipt; changing its contents under the same identity is rejected. The corresponding recovery read returns `recorded`, `pending`, or `mismatch`. `pending` means the result has not been confirmed. Its replay field says whether the same request may be submitted explicitly; it does not schedule a retry or assert that the request never ran. Recovery keeps the original business request across project reopening while using the new session token.

These conversation records store human input. Planning calls use the separate permission and result checks below. The desktop workspace has a conversation panel for creating and selecting threads, paging messages, saving messages, and recovering local input. It can read recorded planning replies and proposals for the selected thread. Saving a message does not call a model. The panel can send one planning question, with messages alone or a fixed entry selection, after explicit material and connection review. A valid planning suggestion can be saved as a proposal and edited in the panel. A saved proposal version can also be reviewed and explicitly confirmed and started as a work plan. The confirmation and start retain separate requests and receipts. The conversation panel shows the linked plan status and offers start and recovery, pause, stop, takeover, and ordinary continuation controls, subject to the conditions below.

Write a question and choose **Prepare question**, or press Enter. This saves the message locally, selects only that message and prepares its materials in the same panel; it does not call a model. Shift+Enter inserts a line break, and Enter during input-method composition does not prepare a question. **Only save message** retains the local message without preparing it. The `/terms` command uses the same preparation flow with an explicit terminology purpose; member-directed commands retain their existing route.

In **Ask the assistant**, explicitly select any additional saved messages, up to 16 in total, and select a saved connection or enter a one-time connection. **Review what will be sent** captures changed materials locally without calling a model. The complete encoded request must fit within 32 KiB, including the model settings, instructions and message formatting. If the complete request is too large, reduce the selected messages, entries or shared material and prepare again. Review the model, endpoint, output limit, timeout, selected message text and optional full request. Changing materials, scope, connection or limits clears the preview and consent. **Send once** requires fresh consent and validates the original capture again; it authorizes no work plan. Closing the review retains the saved message and unsent input and returns focus to the original control. A later save, preparation or send response preserves newer input and does not take focus from it.

Use **Attach the current selection** to include 1–100 real entries from the entries table, retaining the original target language, source snapshot, members and exclusions. Larger selections are rejected intact. Changing a filter, table selection or view does not replace the attached set. Frozen scopes are checked through their original scope identity before and after preparation; a changed basis requires an explicit new selection. Direct entry selections must match every returned source snapshot.

With entries attached, choose whether to share applicable terms, manual context and supported source context. The preview shows the actual Core counts and the complete original input in formatted JSON; it does not reconstruct materials from a later table read. Current selected translation text is not sent. Human protection is disclosed only as a protected/unprotected flag, without its reasons. Removing entries clears sharing settings and consent and returns to a message-only question.

The complete original consent is written to the existing local journal before submission, with one request, no automatic retries and a finite expiry within the configured timeout. Input entered while this happens is kept. If the journal write fails, no model request is submitted; retrying the journal only repairs the local write. If the business result is uncertain, use **Check request status** to read its original receipt. Missing receipts retain the request without replaying it; another conversation remains available for new work. Closing the setup does not cancel a request already submitted. Reopening a project does not restore the preview or consent.

## Preparing planning materials

Conversation planning can capture 1–16 explicitly selected human messages, with either no content scope or a fixed set of real entries and one target language. The preview shows the selected messages, current source and selection references, protection state, model destination, exact planning input, and counts of the text and resources actually included. It reuses the existing sharing settings; choosing conversation-only includes no entries or resources.

Preparation is local and read-only. It does not authorize or send a model request. Planning settings allow one request, no automatic retries, and one concurrent request; an oversized input is refused intact. The Host retains one opaque capture in the current project session. A successful replacement gets a new identity, and a failed preparation keeps the previous capture. Validation compares the original related facts without refreshing that capture; unrelated edits and unselected new messages do not change its materials. Closing or reopening the project discards this local preparation.

## Permitting one planning call

A planning start confirms the original preview digest, exact sharing scope, one request, and an expiry of at most 120 seconds within the configured timeout. Its action identity equals its attempt identity; task identity and expiry are fixed before submission. Timestamps use decimal strings over IPC. The Store issues an opaque, session-bound permission, and the original execution transaction records consent and enqueue together. Serialized input and preview data cannot grant permission by themselves.

The existing runtime, Provider service and request budget enforce this permission before dispatch and physical requests. Cancellation, uncertain writes, expiry, stopping, runtime replacement or reopening end its authority. Receipt reads and recovery check the original request; they never renew permission or replay it. A pending recovery remains unresolved, and ordinary task retry, query, resume and adoption actions are unavailable for this operation. Usage and unresolved requests stay in the original ledger.

Planning results are typed replies or plan suggestions. Suggestions must stay within the captured entries and language and preserve human protection. Invalid scope, unsupported effects, extra fields and malformed output are refused without automatic repair or a second model request. The original fixed input also retains local provenance; the Provider receives only the disclosed system and input text. History remains readable after the permission ends. Planning attempts are listed by thread in bounded sequence pages, including queued and failed attempts; details come from the original ledger. Reading history does not create a runtime, renew permission, or replay a request.

## Terminology proposals

Use **/terms** or the terminology planning purpose with selected messages, a fixed entry selection and one target language. The same material, connection, budget and explicit planning consent apply. Terminology has its own capability 3 / recipe 3 / preview 4; ordinary planning and character/style/background proposals retain their original profiles. Model output may suggest at most 16 entry-scoped terms, each with an exact source-text fragment, proposed target, aliases, protection preference and reason. Output cannot choose local resource IDs, expand the selection or write terms.

Saving the result as a formal proposal records the original attempt/result and their digests, and creates an immutable resource capture in the same transaction. Formal terminology revisions can edit the summary and open questions while retaining the original model entries. Target edits belong to resource adoption. Open the saved version to compare its terms in Knowledge. Review the original language and entry scope, edit a target if needed, then explicitly adopt through the existing resource decision and receipt. Open questions, an older proposal head or changed source block adoption; historical proposals and materials remain readable. Adopting one entry does not invalidate the remaining entries merely because the resource store changed. A delayed acknowledgement preserves newer target input, and an unknown result is checked against the original action after reopening. Saving messages, reading the proposal or opening Knowledge does not call a model.

## Conversation proposal revisions

Core stores immutable proposal revisions, with desktop IPC commands and a frontend command adapter for this layer. An initial revision can only come from the Store's successful, valid planning proposal result. It retains references to the original attempt, result, input digest, and result digest without copying the planning materials. Human adjustments create a new revision; `expectedRevisionId` checks that the current revision has not changed before saving.

In the conversation panel, **Save as a proposal** records a valid planning suggestion. The saved versions remain available in the thread. Edit the summary, open questions, and a subset of the original entry scope. Run templates can also configure candidate generation and checks before the new version is saved. Local input can be incomplete, but saving a new immutable version requires valid content and current materials. If a newer version exists, compare it and explicitly choose to continue from it before saving. When a save succeeds while newer edits are being made, those edits are kept and based on the saved version.

Creating and revising a proposal records the original request and receipt in the same transaction. Repeating the same action returns its original revision, and the original action can be checked after an uncertain response. Creating, revising, or explicitly validating a proposal checks its relevant materials against current project state. Historical revisions remain readable when those materials are stale; reopening history does not restore planning permission.

## Confirming a proposal as a work plan

From a saved proposal version in the conversation panel, choose **Review a work plan**, configure the connection, sharing, limits and applicable tools or checkers, and prepare the exact plan. Resolve open questions and save or discard local proposal edits first. Preparation does not send a model request, but it can initialize the local execution environment or reserve application tool instances for the project session. The Core preview does not write project business data.

Review the prepared entries, model and budget, shared materials, stages and selection policy, and any tools, checkers, application instances, team settings or MCP query shown. Choose an authorization duration of 1–1,440 whole minutes and explicitly confirm the required execution permissions and the plan. Changes to configuration, materials, environment or connection invalidate the preparation and consent. If the proposal's original project materials have changed, close work-plan setup and prepare a new question with the current entries. The original proposal stays available in history. A project session has one preparation slot, and a late response cannot replace newer choices. The complete original confirmation request must be acknowledged by the local journal before authorization is submitted.

Choose **Confirm and start** to record authorization and a link to the exact proposal version, then start that same authorized plan. Both original actions must be durably acknowledged by the local journal before their respective dispatch. If confirmation or start cannot be verified, the chain stops and retains the original request for checking; it does not regenerate a proposal or automatically repeat either action. A history link shows what was confirmed, not whether execution is active or permission remains valid. Planning permission is separate from execution permission.

The prepared plan retains its proposal origin; the generic manual authorization path cannot bypass the proposal confirmation. Confirmation requires the full work-plan preview and records bounded evidence of the complete human confirmation. The original work-plan authorization, the exact revision link, and a small receipt are saved in the same transaction. The existing plan and action records remain the authority for execution permission; the link does not create a separate permission or budget. Authorization rejects an older revision, stale materials, or unresolved questions.

A person can explicitly choose the execution model, budget, and real tools or checkers within the existing work-plan flow. The original Host environment consent checks still apply. Work uses the existing preparation, authorization, runtime, budget, and Provider boundaries. The same revision can be explicitly confirmed as multiple independent work plans, each with its own budget. Once authorized, each plan remains fixed; a later proposal revision does not change it.

Reopening or checking an action reads its original receipt without recreating the preparation, renewing permission, or replaying work. Checking an uncertain proposal confirmation first matches the complete original conversation request, then reads its original authorization receipt and current plan status. A matching, still-current receipt can make the original start available explicitly; the check never starts work or restores expired permission. If the confirmation receipt is missing, the original request remains pending and cannot be replayed or cleared in the conversation panel. You can start a new conversation for other work; the unresolved request still needs its original receipt.

## Running a linked plan in a conversation

Expand a confirmed plan in its conversation to read its current plan status and fixed scope. **Confirm and start** normally performs the first start after the original confirmation. If the chain stopped before a known start, use the explicit start action only after checking any pending original request. Start requires the original direct authorization, an exactly recovered current confirmation receipt, or a continuation receipt, and a matching active, unexpired plan in the current session. History and reopening a project do not restore that session-only start ticket; project reopening pauses surviving grants.

The expanded panel reads the most recent authorization or continuation that was actually enqueued for this plan, then uses its recorded task and attempt to read that attempt's full progress totals. A later continuation that has been confirmed but not started leaves the previous start as the latest recorded start. When that start predates the current plan generation, the panel identifies it as earlier work; its progress does not establish whether the current plan is running. Check the entry record for result validity, translation selection and review. Team plans show the root cumulative model budget, but one start cannot represent every member's progress. Team plan details also show recorded members, work results, messages and discussion, with incomplete pages indicated.

A delegated translator receives its own assignment and a directory of eligible recipients and entries. When it requests work, it supplies the entry's unit ID. Tsumugi binds the request to the source snapshot, revision and language in the confirmed plan. An initial assignment can explicitly ask different members for parallel translations. A delegated member needs new supporting discussion or a relevant message to request translation of an already assigned entry again. A rejected delegation returns its reason to the requesting member and consumes no activation.

The activation limit stops new assignments. Members with existing work can still submit their results while authorization and model budget remain available. Under a failed work item, open **Record details** to read the ledger reason and the attempt ID for that entry.

For an ordinary started plan (excluding team and MCP plans), expand **View generated results** to read its recorded entry results. The results are tied to that plan and start, include up to 100 entries, and appear 25 per page. Each entry shows its request and validation status; a result still awaiting validation or without valid output does not hide other entries. Expand the returned text to read it in full; an empty translation is shown as an empty result. **Read results again** refreshes the recorded results without sending another model request.

When a candidate has been saved, **View and handle candidate** opens that exact saved version in the entry’s history. There you can use the existing candidate controls to keep it as a local draft, edit and confirm it, or reject or restore it. Existing protection and recovery rules still apply. Opening a result does not itself save, select, or approve a translation. If the result or candidate cannot be matched, read the results again; the recorded work is kept.

Result reads use recorded automatic-processing receipts when available and consult live processing only if the local execution environment already exists. Reopening a project can read recorded results without creating that environment; reading does not renew permission or reconcile a write.

Request capacity and model usage come from the original root budget and include continuation child tasks. Remaining capacity deducts recorded reservations and historical holds from the root limit. A reservation occupies a slot before network dispatch, so it does not confirm that the provider received the request. Unresolved outcomes and requests without usage are counted separately. When no request reports a token total or detail, the panel shows it as unreported. Token quantities retain their decimal precision and unknown values remain unknown in each usage category; currency and billing are not inferred. The panel does not calculate a percentage or cost. The run locator and execution-progress reads only inspect stored records: they do not initialize execution, call a provider, renew permission, or reconcile business writes. The separate plan-status read keeps its existing local checker observation behavior. If a read fails or its plan status no longer matches, it does not substitute zero progress or prevent the separate status and available pause, stop, or takeover controls.

Pause, stop, and takeover do not require a new connection, execution permission, or an unexpired authorization. These controls do not establish that remote calls have drained or that further charges are impossible. For an ordinary paused or taken-over plan, review its fixed materials and effects, set a new duration, and confirm the applicable Host permissions to continue. Continuation does not reset the original cumulative budget or automatically start work; use the resulting current-session receipt to start explicitly. Team and MCP plans require their dedicated recovery flow or a new plan; the conversation panel does not offer generic continuation for them.

Before dispatch, the local journal must durably acknowledge the complete original start or control request. If that write fails or its acknowledgement is uncertain, dispatch waits until the local write is confirmed. Pause, stop, and takeover can be requested separately even when another request in the conversation is unresolved or in flight. Up to 32 such control requests can await checking; check existing requests before adding more. They do not require new execution consent. An unresolved control request blocks a new start or continuation of the same plan, while independent message input follows the usual pending-request rules.

If a start or control result is uncertain, check the original request in the panel. A recorded result confirms the local action was recorded; it does not establish that remote calls have finished or that charges are impossible. If no matching receipt exists and the plan has advanced beyond the request’s expected control generation, the old request can no longer apply and is reported as not applied. Otherwise its outcome remains pending: a stopped plan, expiry, or missing receipt alone does not prove it never applied. Start checks also match the expected attempt, input, and enqueue association; an action record alone does not mean work started. Checking these records does not reconcile an unknown execution, renew permission, or create an execution environment.

A pending control request is never replayed automatically. When offered, **Check and retry original request** explicitly retries that same request after checking it; it does not substitute another action or expiry. A missing start receipt can be retried explicitly with the same request only while its original session ticket remains available and current status permits it. Reopening restores neither that ticket nor Host consent. A missing continuation receipt cannot replay Host consent. Checking or resolving a request preserves other pending requests and newer input.

<a id="run-setup-and-navigation-in-the-opt-in-workspace"></a>

## Run setup and navigation in the workspace

Proposal drafts offer templates for generating candidates, with or without assisted checks. A template keeps the existing entry scope, destinations and sharing choices. It starts with candidates-only selection, leaves resource adoption and delivery disabled, and grants no permission. Save the draft as a new proposal revision before preparing its work plan.

Initial team setup uses the proposal’s existing entry scope. Add members, choose the first member and entry, and configure each member’s name, role, connection, source material, allowed work and request limits. A team shares discussion material only under the plan’s explicit sharing setting. The team preview shows the shared plan request limit, including retries. Each member shows its own request limit within that shared limit and its own per-request settings. API-key members show their output-token cap. For subscription members Tsumugi sets no output-token cap, and the ChatGPT account and workspace limits still apply. Incomplete members cannot be saved as a valid runnable revision. Preparing and authorizing the plan still checks its actual root budget, materials, connections and Host permissions.

The **Runs** activity shows recorded plans from a selected project conversation alongside context experiments. Opening a plan or its saved candidate does not start work. **Return to the original run** restores the original conversation, expands its plan and reuses its retained Runs tab when available. Input, pending requests and execution permission continue to belong to their original owners.

The assistant’s project brief appears for an empty thread or after an absence of more than eight hours. It reads selected translation counts, delivery-blocking entries and shared decisions without a model request. Selection is independent of review approval and delivery readiness. Partial reads and counts from different source observations stay unknown. A saved entry position is only a local navigation preference; reopening it still resolves the current project entry and grants no authority.

## Preparing and verifying a work plan

### Plan preparation (`ProjectStore::prepare_work_plan`)

`ProjectStore::prepare_work_plan` is a read-only operation against a single SQLite snapshot. It takes an optional `AiConfig`, a target locale, a bounded set of source unit IDs, and `PlanOptions`, and returns a `WorkPlan` (internal format version `3`, including a nullable maintenance basis; see the [development format boundary](../README.md)) containing:
- A unique plan ID and canonical digest
- Captured source revisions and current translation selection IDs
- Explicit stage modes (`manual`, `assisted`, or `skipped`) across five stages: **understanding**, **resources**, **generation**, **checks**, and **delivery**

By default, the Core library enables assisted candidate generation while keeping other stages manual. In the desktop conversation panel, proposal drafts offer templates to generate candidates with or without assisted checks; both use candidates-only selection.

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

The desktop conversation panel combines authorization and the first start under **Confirm and start**, while retaining their separate durable requests and receipts. If authorization succeeds but the initial start fails or is uncertain, preserve the saved authorization and check the original start before explicitly starting or stopping the same plan. Do not repeat confirmation, refresh its expiry or issue another planning request as recovery.

### Pause, stop, takeover, and continuation

Users can **pause**, **stop**, **take over manually**, or **continue** a plan at any time:
- **Pause, stop, and takeover** increment the persisted control generation, cancel queued tasks, and signal running workers. Every enqueue, dispatch, HTTP reservation, HTTP send, candidate save, and selection re-checks the active authority. Closing a project automatically pauses all active grants and signals running workers; when a new project host starts, it pauses any crash-surviving grants before opening the session.
- **Budget accounting**: Child tasks are submitted with `parent_task` so all requests charge the root plan's shared budget. Each child item must preserve the parent's item scope, payload, and ordered dependencies. Control transitions never refund consumed request budgets, erase uncertain external exposure, or roll back already committed candidates. Use `work_plan_status` to inspect live state and budget consumption.
- **Continuation**: Resuming a paused or reopened plan requires a fresh human confirmation, a new expiration time, and a valid plan basis. Selections made by the plan's own `checked-selection-3` policy count as valid progress, whereas manual edits or selections from another plan change the basis and require preparing a new plan.

## Scoped Agent execution and reference tools

For an active, authorized plan with a registered task budget, the application host can open a session-bound Agent scope. This scope locks the `AutomationLease` and shared budget anchor and exposes a narrow set of operations to the Agent: preparing and starting candidate generation or read-only tool queries for subsets of the planned source units, and reading back its own dispatched tool outputs.

### Reference tool queries in a work plan

An assisted plan can include read-only reference tools configured during work-plan confirmation:
- **Preparation (`prepare_work_plan_with_tools`)**: Each configured provider row binds an opaque tool handle, the SDK capability binding, an approved runtime environment, the installed settings revision, package/runtime origins, and query target/category options. All rows in the plan share a single total tool invocation limit across all attempts and continuations.
- **Unsandboxed execution consent (`query-tools`)**: Authorizing tool execution in a work plan requires a separate human confirmation for unsandboxed local execution. The tool execution window is capped at the earlier of 10 minutes or the overall plan expiration; recovering or replaying an action does not extend this timer, and reopening a project requires a new `Continue` confirmation to run tools again.
- **Dispatched tool calls**: An Agent tool proposal passes only child task/attempt IDs, a pre-captured tool handle, and a non-empty subset of the plan's source units. Core constructs the literal SDK query payload from the captured source text, re-verifies the runtime and settings revision, and commits the delegated grant and shared budget reservation in a single ledger transaction (one invocation per item). Each tool attempt uses its own child attempt ID as its `Attempt` component scope.
- **Reading tool results (`readToolAttempt` and `readToolOutput`)**: The Agent can poll progress and read structured reference outputs for its own enqueued tool attempts while the scope remains active. Tool outputs stay unapplied—they are not automatically injected into model prompts or adopted into project terminology—and remain readable in the workbench across plan control changes.

When the plan allows reading cited artifact bodies, a member can request a short excerpt from the original cited revision or source occurrence. The result reports its byte position, total text size and the position to use for a further read. Excerpts can leave room for instructions, discussion and other tool results in the next model request. The complete serialized request still has to fit within 32 KiB. If the combined request is too large, expand **Record details** on the failed team work to see the measured size and limit. Prepare with less shared material or request an excerpt for a new run. Earlier dispatched requests remain in the original budget history.

In a team member’s work history, choose **Read tool references**, then **Read saved tool results** for the original call. Results are paged in groups of 16; structured tool fields are shown when the saved declaration is available, and **Read original tool output** expands the original response. Reading these records does not run the tool, select a translation or restore permission.

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
