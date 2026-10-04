# Fixed application work plans

The Core `application` module owns the initial work-plan representation. The
current API prepares and verifies plans from a project's existing source,
translation and resource authorities. Both operations are read-only and use one
SQLite snapshot. The plan is an internal application contract, not a stable plugin
SDK or permission grant.

`ProjectStore::prepare_work_plan` accepts an optional `AiConfig`, one target
locale, a bounded set of source unit IDs and `PlanOptions`. It returns a `WorkPlan`
with a new plan identity, captured source revisions and selection identities,
explicit stage choices and a canonical digest. A manual plan requires no model
configuration and carries no execution input or permission. An assisted generation
plan includes fixed execution input; re-reading it preserves the task, attempt,
item and adoption-unit identities. Unused model configuration is refused for
manual generation so it cannot accidentally acquire a provider scope.

Stages cover understanding, resources, generation, checks and delivery. Each
stage can be manual, assisted or skipped; the requested list may omit stages. The
default requests candidate generation and keeps the other stages manual. Optional
selection, resource adoption and delivery effects require explicit plan settings.
An automatic policy does not represent human language-review approval. Preparing
a plan makes no provider call, enqueues no work and changes no project facts.

The fixed input contains the exact provider destination, model and configuration,
request limits, selected sharing categories, source revisions, included terms and
context, and omission information. Credential environment-variable names are
configuration; credential values are never included in the plan. The plan's
digest also binds its requested effects and observed selections. Unknown fields,
duplicate scopes or stages, inconsistent effect settings and modified plans are
refused.

`ProjectStore::verify_work_plan` compares the captured evidence with the current
project. It refuses another project, changed source content or relevant shared
resources, and changed translation selections. An empty shared query remains
relevant: newly added matching context changes the evidence. Unrelated project
renames and global resource-clock increments do not invalidate a plan whose
actual scoped evidence is unchanged. A successful comparison is evidence
validation, not execution or mutation authorization.

Schema 14 stores plan authority, control generations, action receipts, execution
associations and unit protection beside the existing execution ledger. This
initial development build opens current schema 14 only. Unsupported development
projects are preserved and refused; recreate projects and reimport source files.

`authorize_work_plan` is a trusted human-facing boundary. It accepts an explicit
confirmation, the exact plan digest, candidate-saving permission and an expiry
within the next 24 hours. It rechecks the plan inside the existing write
transaction. Semantic answers do not form part of this permission request. The
returned execution input carries an `AutomationLease`; the lease refers to stored
authority and cannot grant effects itself. Other planned automatic effects are
currently refused by this authorization API until their mutation policies exist.

Pause, stop and takeover advance a persisted generation and cancel old queued
work. The runtime signals running workers; enqueue, dispatch, HTTP reservation
and adoption recheck authority. Late outputs and uncertain request reservations
remain evidence. A new action identity cannot regain a stopped input's authority.
Continue requires a new explicit confirmation, an expiry and a current plan
basis. After initial enqueue its returned work is a child of the original task:
submit it with the returned `parent_task` so all ancestor budgets remain charged.
Control never refunds requests, resets unknown exposure or rolls back committed
facts. An old action returns its original receipt; use `work_plan_status` for the
current state. Cancelling an automated root task also stops its plan in the same
transaction. Continuing explicitly acknowledges that original root cancellation
baseline; a newer root cancellation or cancellation of a child still prevents
requests. Closing the project pauses all active grants, including grants without
queued work, and signals their workers. Reopening requires explicit continuation.

Manual saves and manual selections protect the unit in the same transaction.
Protection survives project reopen. Explicit release requires confirmation and
matching protection revision, source revision and selection identity. Historical
release receipts report their original result without clearing newer protection.
Saving a candidate does not select it or give human language-review approval.

The desktop command API uses the existing project session and execution runtime
for plan preparation, authorization, start, control, status and action recovery,
and protection reads/writes. Authorization and start are separate operations: a
saved authorization is not reported as a failed authorization when later enqueue
cannot run. Start uses the stored receipt and current grant, rather than accepting
raw execution input from the client. Historical acknowledgements cannot reactivate
a stopped generation. The user interface still uses its existing explicit AI
preview/start and candidate adoption flow; plan controls, automatic selection,
resource adoption and delivery remain unfinished. The API is not a stable plugin
SDK. A model or plugin must not receive unrestricted access to human-authorization
methods, `ProjectStore` or the raw runtime; its host must carry the issued lease
and parent identity through the scoped application entry points.
