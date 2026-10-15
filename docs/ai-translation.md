# Direct AI translation

Use **Compare saved translations** beside a revision in editor history, or while
reviewing a saved AI candidate, to open that exact entry and language in Arena.
The application rechecks the current source and the selected historical revision
before opening offline choices. This does not create a comparison, contact a
model, select a translation or replace your manual draft. Choose a second saved
revision and explicitly start the comparison. Unfinished comparison choices,
merge drafts and unconfirmed actions must be resolved before replacing them.

Rejected candidates remain readable in saved comparisons. Their current rejection
status prevents direct selection until you explicitly restore them through the
translation history or saved AI candidate review. Status alone is shown in blind
comparisons, preserving hidden model identities. **Manual merge** remains an
explicit new revision with all contributor references; it neither restores nor
directly selects a rejected contributor. **Return to the original work area**
returns to the editor or AI preparation with its retained draft and settings.

AI translation and Arena comparison are working areas in the sidebar. Connection configuration can be folded away while preparing a task; validation errors in connection fields reveal those settings again. The selected scope, sharing choices and budget remain part of the explicit preview and consent flow. Moving between working areas keeps local preparation state through the existing leave decision, and Tasks retains persisted attempts.

Open a project with current source content and choose **AI translation**. Choose the working mode of each stage: understanding, resources, translation, checks and delivery. Manual and skipped stages require no model. Choosing manual translation hides connection and sharing settings; **Prepare manual plan** captures the selected entries and language and offers their manual editors. Glossary and context, Review and QA, and Build and export provide the other manual stages. AI assistance generates candidates. An explicit selection policy can also save candidates, run mechanical checks and choose eligible translations; resource adoption, standalone automated checks and delivery remain unavailable.

For AI-assisted translation, select a connection preset or enter a custom full Chat Completions URL, model and API key environment variable name. Presets supply editable connection defaults; choose a model explicitly. For a service without authentication, clear the environment variable name. Set credentials in the environment before launching the desktop application; never paste a key into a URL or into the name field.

Remote endpoints require HTTPS. HTTP is allowed only for loopback endpoints. URL credentials, query strings, fragments and redirects are rejected. Choose the token field expected by the service: `max_tokens` or `max_completion_tokens`; the client does not silently switch fields or providers.

The default budget is 20 selected units, concurrency 1, at most 20 requests, 2,000 output tokens per request, no automatic retries and a 60-second request timeout. You can edit the limits within the bounds shown in the form. Retries are limited to 429 and 503 responses and consume the same persistent request budget. Valid Retry-After delta seconds and HTTP dates are honored up to five seconds; a longer delay stops this attempt rather than sending early. Other retry delays use bounded exponential backoff and jitter. A network interruption or timeout is recorded as an unknown outcome and is never automatically retried. Cost and complete usage may be unknown even when a candidate succeeds.

Connections are reused across AI and Arena requests with the same endpoint, timeout and proxy environment. Credentials are resolved for each dispatched request and attached only to that request. The current compatibility profile supports Chat Completions JSON text with the explicitly chosen token field, a 32 KiB shared prompt, 64 KiB response and 32 KiB embedded model output. Model context capacity is unknown; remote cancellation and remote outcome queries are unavailable.

The provider origin has a two-request-per-second rolling limit independent of the global two-worker concurrency limit. The waiting queue admits up to 128 attempts and 2,000 expanded items, preserving the existing per-operation limits. Each free slot rotates between attempts. If the queue is full, wait for current work to finish or reduce the scope before sending again; rejected admission does not start a new task.

Requests reserve durable budget before network dispatch. The saved summary distinguishes reserved requests, unresolved outcomes, unknown usage and reported token totals. Reservations survive cancellation, timeout and project reopening; unknown requests are not free. Successful responses without usage also retain unknown usage. Local trusted child tasks share every ancestor limit and cannot expand the captured scope or connection and sharing configuration; this is a Core scheduling API, not a shipped autonomous Agent interface.

Select the target language and source units. Adopted applicable terms and saved human context are optional and off by default. **Preview what will be sent** shows the full source text, destination, budget, selected resources and omissions. Changing inputs invalidates the preview and consent. Confirm sharing and choose an authorization duration of 1–1440 minutes before sending. Choose **Save candidates; choose manually**, **Choose only entries without a translation**, or **Allow replacing the translations shown in this scope**. The latter two enable mechanical checks and add that exact selection effect to the displayed authorization. Only clean checks, unchanged source/resources/selection and unprotected entries permit selection. Approval, resource adoption and export remain separate manual actions.

**Source observations** separately offers extracted source facts, source inferences
with their rationale, and adjacent original text. All three start off and are
independent of terms and saved human context. The preview preserves fact origins
and original references locally; inferences remain hypotheses. Missing, explicitly
empty and unsupported facts remain distinguishable. Selecting facts that require
an unavailable interpreter blocks preparation; neighbors can be selected without
interpreting those facts.

The source-observation budget defaults to 16,384 encoded bytes and 128 entries per
original. It accepts 27–16,384 bytes and 1–128 entries, counting the complete JSON
entries and their array container. Facts follow their original block order before
adjacent text; an entry that does not fit is omitted whole. The preview shows
omission categories, reasons, up to eight reference samples and the remaining
unlisted count. Provider requests include only the chosen fact kind, text,
origin and inference rationale, or adjacent text and relative direction.
Source coordinates, artifact identities and revision evidence stay local.
Accepted execution and recovery retain the original capture, sharing choices and
deadlines; editing a choice requires a new preview and confirmation.

Requests contain text only: a fixed translation system instruction and a user message containing JSON text. No files, images, audio or tools are sent. The service must return a single assistant choice with `finish_reason: "stop"` and JSON content containing exactly `unitId`, `targetLocale` and `text`, copying the supplied identity and locale. The client validates output locally; it does not request a server-side JSON Schema mode.

Results are saved per unit. **Save candidate** adds an immutable AI revision to the ordinary translation history without selecting it or approving it. **Compare and select in editor** lets you compare, select, edit and run the normal checks. Manual saves and selections protect the entry from automatic selection. The editor displays this protection and requires a separate, scoped confirmation to release it; unsaved drafts and pending saves block release. Changed source or removed target languages prevent stale candidate adoption. Automatic plans show saving, checking, selected or blocked states beside each result. Protected entries and check findings retain the candidate and mechanical evidence. Policy receipts describe past work without asserting the current selection or human approval. A permitted storage retry checks durable evidence and reuses its original action identities, without another provider request.

Tasks retains input, recipe, model, output and adoption receipts after reopening a project. Reopening does not send requests. Use **Pause automation**, **Stop this plan** or **Take over manually** to invalidate old permissions and stop new work. In-flight requests may still execute or be billed. Pause and takeover can continue only after renewed explicit consent and a new expiry; continuation uses the original remaining shared budget, including unknown exposure. Changed source, selection or shared resources require a new plan. A stopped plan requires a new plan. A prior AI attempt cannot use generic resume or retry actions to bypass these permissions.

If authorization or control has an uncertain result, check the original action receipt before retrying that same request. Historical receipts do not override newer control state. A saved authorization is retained if queue admission fails, so **Start authorized work** retries the existing grant instead of creating a new budget. If a start or adoption response is lost, check the saved attempt or receipt before retrying. Closing a project pauses active grants and preserves evidence. A fresh host also pauses grants retained after an unexpected exit; reopening requires explicit continuation.

## Arena comparison

Choose **Arena comparison** to generate two to four schemes for the same selected original strings and one target language. Each scheme has its own endpoint, model, output token parameter, timeout, retry limit, terms/human-context sharing and source-observation selection and budget. The whole round shares one request and concurrency budget. Defaults are two schemes, up to 20 original strings, 40 requests including retries and concurrency 1. At most 100 expanded string × scheme items are allowed; requests are bounded to 300 and concurrency to 2. An initial request count larger than the chosen budget is rejected.

Preview every scheme's destination, complete text, actual resources and parameters, then explicitly confirm the shared budget. Changing a scheme, source or relevant resources requires a new preview. Each result remains bound to its scheme even if responses arrive out of order or have identical text. The display identifies differing inputs or parameters and repeated sampling. Reported token totals cover only the known portion; missing usage and uncertain requests remain unknown.

**Hide candidate identities until revealed** assigns fixed anonymous A–D labels. Refreshing or reopening keeps the labels. **Reveal candidate identities** persists the reveal; it does not erase provenance. Destinations remain visible in the sharing preview, so this is a convenience for human comparison rather than a scientific double-blind experiment.

Save successful outputs as ordinary candidates. Saving does not select or approve them and preserves a translation selected while generation was running. Cancel stops undispatched work; an in-flight request may already have run or been billed. Unsaved results from the canceled round remain readable but cannot be adopted. A terminal round can prepare a new round with a fresh preview and consent; reopening or generic task recovery never sends extra requests.

To compare offline, choose an original string and language under **Compare saved candidates**, load its history, select two to four revisions and start a comparison. No connection or AI request is needed. Reopen saved comparisons from the same panel. The current selection shows its actual text, including a manual merge or another revision outside the compared candidates. Historical candidates may use different source or resource evidence and are marked for reassessment.

**Use this translation** checks the observed current selection. **Edit a manual merge** lets you combine all compared revisions into new text. **Save merge and select** creates one manual revision, records its contributing revision references and selects it atomically. It does not modify the parents or carry their approvals forward. Old-source contributors need a current-source revision in the normal editor first. Relevant source, resources or selection changes reject a stale save; **Review current basis and keep draft** preserves the text while refreshing the evidence. Continue with normal Review and QA before building a SMAPI language file or WebVTT subtitle.

During a save you can continue editing. A successful older save does not discard newer text. If a response is lost, **Check saved result** uses the original action identity, including when another selection has since been made. Retry only that same action after checking. Keep or explicitly discard an unsaved settings or merge draft when leaving; unresolved actions must be reconciled first.

## Development interface migration

The internal Rust and desktop IPC interfaces remain experimental. Producer callers now obtain `DispatchRequest` from the execution runtime or store dispatch boundary rather than constructing its fields directly; the runtime supplies the private durable-budget channel. `ExecutionRuntime::register` and `ProjectStore::enqueue_execution` conservatively record `external-unknown` effects. A trusted host must explicitly use `register_read_only` / `enqueue_read_only_execution`, or `register_with_policy` for another reviewed effect contract. A producer's own claim or operation name cannot authorize replay. Persisted policies cannot be changed by resubmitting the same identity.

Current development projects use schema 39 only. Durable budgets, reservations,
ancestry, effect policies and exact continuation identities retain their original
owners. Other development schemas are refused without an application upgrade,
rebuild or reset; SQLite may complete its own hot-journal recovery. Preserve those
directories and create a new project to reimport original source files. Existing
attempts retain their captured host-reviewed policy. See the [README](../README.md#development)
and [work plans](work-plans.md) for current compatibility and human-control boundaries.

The Tasks view keeps an explicit resume/retry intent, selected items and original
cancellation basis after a lost acknowledgement. Exact lookup or the same request
returns the stored continuation without another enqueue or model reservation;
changed requests conflict. Generic recovery does not replace work-plan Continue
authorization or restore a closed component scope.

## Rejecting and restoring a saved candidate

Open the entry in the translation workspace and review its saved revision history.
For an unselected AI candidate with the current source basis, enter the human
actor and reason, then choose **Reject AI candidate**. The candidate's immutable
text and producer evidence remain available. This decision does not approve a
translation, change a selected revision, remove mechanical checks or create a
project-wide style or training rule.

The decision records its exact revision, source revision, observed selection and
previous candidate decision. A changed basis or selection conflicts instead of
overwriting newer work. Rejected revisions cannot be selected through manual or
automatic selection. **Restore AI candidate** records a new human decision before
that same candidate can be selected or suggested again; prior rejection receipts
remain readable. Source changes never restore a rejected revision automatically.

If a response is lost, the original candidate decision stays pending with its
captured actor and reason. Check that action before continuing. An explicit retry
reuses exactly the same identity and payload; editing the next reason does not
change the original request. Project close and other translation mutations stay
blocked while the original decision is unresolved. Unsaved translation text is
kept when the decision settles.
