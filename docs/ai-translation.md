# Direct AI translation

The **AI translation** and **Arena comparison** views in the sidebar let you prepare model-assisted translation candidates, compare multiple generation schemes, and manage context strategies. For advisory meaning and style review of existing translations, use the separate [AI review workflow](review-qa.md#ai-meaning-and-style-review), which shares the same provider and task controls under an independent preview and consent flow without turning review findings into translation candidates or approvals.

## Preparing a translation workflow

Open a project with current source content and select **AI translation**. You can configure the working mode for each stage of the pipeline: understanding, resources, translation, checks, and delivery:

- **Manual and skipped stages** require no model connection. Selecting manual translation hides connection and data-sharing settings; **Prepare manual plan** records the selected entries and target language and opens their manual editors. Other manual stages are handled in **Glossary and context**, **Review and QA**, and **Build and export**.
- **AI-assisted stages** generate translation candidates. By default, new preparations save candidates alongside their authorized checks while keeping candidate selection manual. You can also keep checks manual, or choose an automatic selection policy (**Save candidates; choose manually**, **Choose only entries without a translation**, or **Allow replacing the translations shown in this scope**). The automatic selection policies require assisted checks and include that selection effect in the authorization summary. Automatic selection only applies when checks pass cleanly, the source, resources, and current selection remain unchanged, and the entry is not manually protected. Human approval, resource adoption, and release export remain manual actions.

While preparing a task, you can collapse the connection configuration panel; any validation errors in connection fields automatically expand it again. Switching between sidebar working areas preserves your local preparation draft through the leave prompt, while **Tasks** retains persisted execution attempts.

## Model connections and budgets

### ChatGPT account connection (macOS)

On macOS, **Settings** offers **Continue with ChatGPT**. After signing in and authorizing Tsumugi in your system browser, refresh the selected account's model list and save a connection for that account:

- Each account or workspace registration is stored separately, even if multiple registrations share the same email address. Signing in again reuses the existing registration. Signing into a new account does not update earlier prepared requests—select the new account and prepare the request again.
- Credentials are stored in the macOS Keychain outside projects, plugins, and the member runtime. If a Keychain write fails, the account remains unavailable; after restoring Keychain access, use **Retry account storage** to record the withdrawn state before signing in again. Reading account status or failing a status refresh does not modify storage or confirm a previously cached account or model list.
- Signing out stops local account usage and attempts remote token revocation. If remote revocation cannot be confirmed, disconnect Tsumugi directly in [ChatGPT Settings](https://chatgpt.com/#settings).
- ChatGPT connections use the official public Responses endpoint and draw from your plan allowance and applicable credits. They impose **no hard output-token cap**, though request count, concurrency, timeout, and encoded input/output size limits still apply, and automatic retries are disabled. Reported token counts are recorded for reference but do not represent exact billing or unlimited quota.

### API-key connections

To use an API-key provider, select a preset or enter a custom full Chat Completions URL, model identifier, and credential environment variable name:

- Presets provide editable defaults, and you must choose a model identifier. Set the API key in your environment before launching the desktop app (or clear the variable name for local services that require no authentication). Never paste a secret key into the URL or variable name field.
- Remote endpoints must use HTTPS; HTTP is permitted only for loopback addresses. URLs containing embedded credentials, query strings, or fragments are rejected, and HTTP redirects are not followed.
- Select the token limit parameter expected by your provider (`max_tokens` or `max_completion_tokens`). The client uses your chosen field as-is without switching parameters or providers behind the scenes.

By default, an API-key budget covers 20 selected units, concurrency 1, up to 20 requests, 2,000 output tokens per request, 0 automatic retries, and a 60-second request timeout. You can adjust these limits within the bounds shown in the form. When retries are enabled, they apply only to HTTP `429` and `503` responses and draw from the same persistent request budget. Valid `Retry-After` delta seconds or HTTP dates up to 5 seconds are honored (longer delays abort the attempt rather than dispatching early); other retries use exponential backoff with jitter. Network interruptions and timeouts are recorded as unknown outcomes and are never automatically retried.

### Transport, queueing, and budget reservation

Connections with identical endpoint, timeout, and proxy settings are reused across AI translation and Arena requests, while credentials are resolved per dispatched request. The client supports Chat Completions JSON text with a 32 KiB shared prompt limit, 64 KiB response limit, and 32 KiB embedded model output limit. Remote cancellation and remote outcome queries are not supported by the transport profile.

Dispatching enforces a rolling limit of 2 requests per second per provider origin, alongside a global limit of 2 concurrent workers. The waiting queue accepts up to 128 attempts and 2,000 expanded items, rotating free slots across active attempts. If the queue is full, wait for running work to finish or reduce the batch scope before submitting.

Requests reserve durable budget before network dispatch. Reservations persist across cancellation, timeouts, and project reopening, and the saved summary tracks reserved requests, unresolved outcomes, unknown usage, and reported token totals separately. Direct requests send only text: a fixed translation instruction and a user message containing JSON text (no files, images, audio, or tools). ChatGPT connections require a `response.completed` event, and Chat Completions require a single assistant choice with `finish_reason: "stop"`. Both must return JSON containing matching `unitId`, `targetLocale`, and `text` fields, which are validated locally without requesting server-side JSON Schema enforcement.

## Context sharing, source observations, and preview

After selecting the target language and source units, configure what project context to include:

- **Terms and human context**: New AI workbench drafts enable applicable adopted terms and saved human context by default. Toggling either option persists across connection edits, budget resets, and workspace switches; discarding the full draft resets to the defaults.
- **Source observations**: You can independently include extracted source facts, source inferences (with rationale), and adjacent original text. If the project and target language have an adopted context strategy, new drafts initialize from that strategy; otherwise all three options start turned off. Inferences remain marked as hypotheses, and missing, empty, or unsupported facts remain distinct. Selecting facts that depend on an unavailable interpreter blocks preparation, though adjacent text can still be shared without interpreting those facts.

The source-observation budget defaults to 16,384 encoded bytes and 128 entries per source unit (adjustable between 27–16,384 bytes and 1–128 entries, counting the complete JSON array and entries). Extracted and inferred facts are packed in original block order before adjacent text, and any entry that exceeds the remaining budget is omitted in full. The preview reports omission categories, reasons, up to 8 reference samples, and the remaining omitted count. Only the chosen fact kind, text, origin, inference rationale, or adjacent text and relative direction are sent to the provider; source coordinates, artifact identities, and revision metadata stay local.

Choose **Preview what will be sent** to inspect the exact source text, destination, budget, included resources, and omissions. Editing any input invalidates the current preview and consent. To dispatch, confirm the data-sharing summary and choose an authorization duration between 1 and 1,440 minutes.

## Handling results, protection, and review

Generated translations are saved per source unit:

- **Save candidate** appends an immutable AI revision to the unit's translation history without selecting or approving it.
- **Compare and select in editor** opens the unit in the translation editor to compare revisions, edit text, select a translation, and run checks.
- **Manual protection**: Saving or selecting a translation manually marks the entry as protected against automatic AI selection. The editor displays this protection status and requires a separate confirmation to release it (blocked while unsaved drafts or pending saves exist). Stale candidates are also blocked if the source text changes or the target language is removed.
- **Navigating to Review**: From an AI result, you can open **Review and QA** for that entry and target language using its currently selected translation. If no translation is selected yet, use the editor to choose or edit one first. Returning from Review preserves your AI workspace position and preparation state.

### Rejecting and restoring saved AI candidates

In the translation workspace's revision history, you can record an explicit rejection for an unselected AI candidate that matches the current source basis. Enter your reviewer name and reason, then choose **Reject AI candidate**.

- Rejecting a candidate records the candidate revision, source revision, current selection, and prior decision. It prevents the candidate from being selected manually or automatically while keeping its text and provenance readable.
- To make the candidate selectable again, choose **Restore AI candidate** and record a new human decision; source updates never restore rejected candidates automatically.
- If a rejection or restoration response is lost, the pending decision retains its actor and reason. Check the saved action before retrying with the same identity and payload; project close and other translation edits remain blocked until the pending decision settles.

### Proposing terms from manual corrections

When you save a manual edit that replaces a previously selected translation, you can use that before/after revision pair to propose a glossary term for the entry and target language. Review the recorded source and revision pair, then enter the source term, preferred target form, and reason. Adopting a proposed term runs the standard term conflict check and records provenance under the entry or language scope. If the underlying revisions have changed since the proposal was captured, capture a fresh proposal from the current saved correction.

### Maintaining changed work

**Maintain changed work** evaluates an explicit window of up to 100 current source occurrences using source correspondence, resource changes, current review evidence, and manual protection status. For each item, you can keep applicable work, request a current review, mark work as unresolved, or select repair candidates. Protected entries and unresolved source mappings are excluded from automatic maintenance, and if an entry's protection revision changes, the captured maintenance plan is blocked at preparation, authorization, continuation, and dispatch. Repair selections feed into an ordinary WorkPlan preview, budget, and consent flow, while literal resource matches are surfaced as possible dependencies for human review.

## Execution control and recovery

**Tasks** retains the input, recipe, model, output, and adoption receipts across project restarts. To halt active automation, use **Pause automation**, **Stop this plan**, or **Take over manually**. These actions revoke active execution permissions and prevent further dispatches (requests already in flight on the network may still complete or incur provider charges). Resuming after a pause or takeover requires a new consent confirmation and expiry window using the remaining shared budget; a stopped plan or any change to source, selection, or shared resources requires preparing a new plan. Closing the project or recovering from an unexpected exit automatically pauses active grants.

When a start, control, or adoption acknowledgement is lost or uncertain:

1. The application checks the original action receipt once in read-only mode before allowing a retry.
2. **Start authorized work** reuses a saved authorization grant if initial queue admission failed, rather than allocating a new budget.
3. Only a confirmed missing start allows retrying the exact same request. If a read fails or cannot prove whether the request was accepted, the outcome remains uncertain and automatic retry stays disabled.
4. For storage retries on already generated results, the application verifies durable evidence and reuses the original action identities without dispatching a new provider request.

## Tool guidance and child Agent scopes

### Tool guidance

Within an authorized plan's tool controls, you can inspect documentation attached to captured tools. The initial listing shows the tool, package, permission summary, and declared members without loading their contents. You can then load the attached Skill and supporting Resources on demand:

- Guidance bodies are treated as untrusted UTF-8 plain text (capped at 64 KiB per read). Markdown rendering, links, and scripts are not executed, and reading guidance does not invoke tools, share data with a model, or consume execution budget.
- Only declared members within the active plan scope and captured tool identity can be read. Missing, mismatched, or oversized content returns an error, and expired, stopped, or reopened plans reject reads against old scopes.

### Child Agent scopes

An active authorized plan can delegate a subset of its captured entries and tools to a child Agent:

- A child scope cannot sub-delegate or expand entries, tools, permissions, model settings, sharing choices, or expiration times. All child scopes share the parent plan's cumulative execution budget and tool invocation limits.
- Generation and tool results remain bound to the specific child consumer, caller, and input identities that produced them; parent or sibling scopes cannot substitute their own scope to read those results.
- Local trusted child tasks use a Core scheduling API (`ExecutionRuntime` / `ProjectStore`) rather than an autonomous agent interface.
- If creating a child scope returns no confirmation, you can close the preparation once the original deadline has passed or after stopping the parent plan, and reconcile any uncertain generation or tool execution through task history.

## Context strategy experiments

Open **Context strategies** in the AI workbench or Arena comparison to evaluate whether a specific source-observation profile improves translation results for a project and target language:

1. **Propose a strategy**: From a saved manual correction, record a strategy proposal containing the before/after source and translation evidence, reason, exceptions, and source-observation settings.
2. **Capture an evaluation suite**: Select 2 to 20 current entries divided into calibration and held-out groups (with at least one entry in each group; the original correction entry may be used in calibration but cannot be held out). The suite locks the source text, resources, and mandatory checker policy.
3. **Run the comparison**: The experiment runs a two-scheme Arena round sharing one connection and request budget. Both schemes disable optional terms and saved human context; the baseline disables all source observations, while the candidate enables only the proposed source-observation settings.
4. **Evaluate and adopt**: Save the generated outputs as unselected candidates, run their authorized checks, and record a preference and explanation for every held-out pair. Adopting the strategy as the new project/language default requires passing all mandatory checks for both schemes across the suite, completing all held-out judgments, recording zero preferences for the baseline, and recording at least one preference for the candidate.

Once adopted, new AI drafts and full draft resets use the strategy by default, while existing drafts and historical tasks keep their original settings. Withdrawing an adopted strategy updates future defaults while preserving past evaluations and history.

## Arena comparison

Choose **Arena comparison** to evaluate 2 to 4 generation schemes side by side for the same source entries and target language:

- **Configuration and limits**: Each scheme specifies its own endpoint, model, output token parameter, timeout, retry limit, term/context sharing, and source-observation settings. All schemes in a round share a single request and concurrency budget. By default, a round compares 2 schemes across up to 20 source strings with 40 total requests (including retries) and concurrency 1. The maximum scope is 100 expanded `string × scheme` items, 300 total requests, and concurrency 2.
- **Preview and execution**: Preview every scheme's destination, prompt text, included resources, and parameters before confirming the shared budget. Results stay bound to their originating scheme regardless of response arrival order. You can enable **Hide candidate identities until revealed** to assign persistent anonymous labels (`A`–`D`) during evaluation, and click **Reveal candidate identities** when ready.
- **Offline comparison**: Under **Compare saved candidates** (or via **Compare saved translations** in the editor history or AI candidate review), you can compare 2 to 4 existing revisions for an entry and language without making any network requests. Rejected candidates remain readable in comparisons, display their rejected status in blind mode without exposing model identity, and cannot be selected unless restored first.
- **Selecting or merging**: In a comparison, choose **Use this translation** to select an eligible candidate, or choose **Edit a manual merge** and **Save merge and select** to combine compared revisions into a new manual revision that records all contributing revision references. Saving a merge does not alter the parent revisions, carry forward their approvals, or restore a rejected contributor.

## Development interface migration

Internal Rust and desktop IPC interfaces are experimental:

- Producer callers obtain `DispatchRequest` from the execution runtime or store dispatch boundary (`ExecutionRuntime::register` / `ProjectStore::enqueue_execution`), which supplies the private durable-budget channel and defaults to recording `external-unknown` effects. Trusted hosts must call `register_read_only` / `enqueue_read_only_execution` or `register_with_policy` for reviewed effect contracts; a producer cannot self-authorize replay or overwrite a persisted policy by reusing an identity.
- Development builds support only the [current database schema](../README.md#development). Projects created with older development schemas are refused without automatic migration or reset; preserve those directories and reimport the original source files into a new project. See [work plans](work-plans.md) for human-control boundaries.
