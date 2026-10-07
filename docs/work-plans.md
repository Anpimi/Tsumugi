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

The current schema stores plan authority, control generations, action receipts,
execution associations, checked selection receipts and unit protection beside
the existing execution ledger. This development build opens current schema 31
only. Unsupported development projects are preserved and refused; recreate
projects and reimport source files. Current work plans use internal format 2;
earlier development plan formats are not migrated.

The experimental Core project-service adapter can capture an actual component
invocation, its selected SDK service descriptor, ordinary plugin permit and
original absolute deadline against an existing WorkPlan Agent scope. Its child
generation proposal contains only child identities and the original source
subset. The same enqueue transaction saves the origin association and original
ancestor budget; every dispatch, HTTP reservation, HTTP send, candidate adoption
and selection rechecks that authority. HTTP waiting is narrowed to the original
remaining deadline without changing captured model settings. The component's
outer input has no automation lease and cannot use the read-only tool delegation
path to acquire generation permission.

The public SDK [generation service contract](../crates/plugin-sdk/docs/generation.md)
owns its schema/behavior 1/1 input, acknowledgement and finite error shapes. Core
uses that SDK parser and requires the exact selected contract/schema versions
and External effect. Only child task/attempt identities and 1–100 distinct source
unit IDs enter the request. The acknowledgement exposes child identities and
their captured input digest, with no grant or authorization handle.

Desktop's `read_plugin_generation_component` observes one installed generation
component through the existing package and approved-runtime owner. The request
contains the complete provider identity, an explicit profile (`null` only for
a profile-independent declaration) and the exact environment digest. Selection
requires a Project-scoped JavaScript component, a required Single dependency on
the canonical generation service, matching ProjectService permission, External
effect and the exact SDK input/receipt/error references. The response keeps the
actual binding, settings revision and package/runtime provenance. This read does
not open a WorkPlan scope, issue an execution grant or run a component. Component
start, per-dispatch service binding and child effect integration remain separate.

Before the first service child enqueue, the trusted caller can check its sealed
Core preparation without writing execution or budget records. An already accepted
child is refused at this preparation boundary; reconcile its durable receipt
instead of reconstructing session-local effect authority. Desktop effect tracking
supports preparing all fallible reads and action identities under its exclusive
owner before enqueue. After acceptance the trusted caller commits only the
in-memory tracking state.

A short service receipt does not mean model completion or candidate adoption.
Channel closure and outer completion do not release a child's original grant.
The trusted application retains installed-settings revocation until the child's
execution and authorized effects are terminal. Repeating a call identity only
reads its original receipt; generic retry cannot replace its attempt to lose the
origin. Reopening preserves historical associations but cannot reconstruct live
authority or renew deadlines. This Core adapter requires the matching Process-2
SDK and Host; production Desktop execution and service binding remain separate
integration.

Core origin capture requires the installation owner's original one-way
revocation signal. Every child authority check reads it directly, including
before the real HTTP send after a reservation. Channel completion does not
detach this signal or make settings changes wait for a project runtime tick.

`authorize_work_plan` is a trusted human-facing boundary. It accepts an explicit
confirmation, the exact plan digest, the exact supported effect set and an expiry
within the next 24 hours. It rechecks the plan inside the existing write
transaction. Semantic answers do not form part of this permission request. The
returned execution input carries an `AutomationLease`; the lease refers to stored
authority and cannot grant effects itself. The effect set includes candidate saving, plus checks and the chosen selection
policy when selection is requested. Selection requires the assisted check stage.
Resource adoption, delivery and standalone automated checks remain refused until
their mutation contracts are assembled.

Pause, stop and takeover advance a persisted generation and cancel old queued
work. The runtime signals running workers; enqueue, dispatch, HTTP reservation
and adoption recheck authority. Late outputs and uncertain request reservations
remain evidence. A new action identity cannot regain a stopped input's authority.
Continue requires a new explicit confirmation, an expiry and a current plan
basis. The plan's own checked selections count as progress; a later manual or
other-plan selection changes the basis and requires a new plan. After initial
enqueue its returned work is a child of the original task:
submit it with the returned `parent_task` so all ancestor budgets remain charged.
Each child item must retain the parent's captured item scope, payload and exact
dependency identities and expected revisions. Adding, removing or changing a
dependency is refused before enqueue; canonical dependency ordering is preserved.
The desktop workbench displays the original plan budget across these attempts,
including earlier request usage and unresolved reservations.
Control never refunds requests, resets unknown exposure or rolls back committed
facts. An old action returns its original receipt; use `work_plan_status` for the
current state. Cancelling an automated root task also stops its plan in the same
transaction. Continuing explicitly acknowledges that original root cancellation
baseline; a newer root cancellation or cancellation of a child still prevents
requests. Closing the project pauses all active grants, including grants without
queued work, and signals their workers. Reopening requires explicit continuation.

The trusted application host can open a session-bound Agent scope for an active,
authorized plan whose original task budget is already registered. The scope
fixes the original lease and budget anchor; it cannot issue or renew authority.
An Agent generation proposal supplies only stable child task/attempt identities
and a nonempty subset of captured source units. Core derives exact child input
bytes from the plan, preserving model, destination, sharing, payload, dependencies,
output limits and effects. Preparation is read-only. Starting requires the exact
prepared digest, uses the original runtime and Provider service, and retains the
same candidate/check/selection service and independent checker consent.
Starting a child rechecks the complete checker identities and the original
installed-settings revision under the same guard used by plan authorization.
Changed settings reject the start before the child is enqueued.
All HTTP requests charge the original ancestors. Pause, stop, takeover, expiry
or closing the project invalidates the scope; explicit Continue needs a new
scope and retains the original cumulative budget. An old scope cannot cross
project-open sessions. The bounded Agent adapter exposes generation and tool
preparation and starting; the trusted scope opener and human authorizer/control
methods remain outside it. This is a bounded application consumer, rather than
a complete autonomous model loop.

An assisted plan can additionally capture read-only reference tools through
`prepare_work_plan_with_tools`. Each entry fixes an opaque handle, the actual
SDK binding and approved environment, installed settings revision, package and
runtime origins, and explicit query target and category choices. The plan fixes
one total invocation limit across all entries, attempts and control generations.
Preparing this metadata grants no execution. The Desktop captures it from
selected installed tools and displays the exact package, runtime, permissions,
options and invocation limit before authorization.

`query-tools` requires a separate human confirmation of unsandboxed local
execution. The host captures its original wall-clock expiry and monotonic
deadline when the human request is accepted. The tool deadline is the earlier
of the plan expiry and ten minutes; a longer model-plan duration does not extend
it. Replaying or recovering the same action cannot refresh either deadline.
Only a new explicit Continue can confirm another tool period, within the
original cumulative invocation limit. A project reopen restores history without
restoring local execution consent. Model sharing and checker consent remain
independent of this tool permission.

An Agent tool proposal contains only stable task/attempt identities, a captured
tool handle and a nonempty subset of the plan's units. Core creates the caller
identity, derives literal source text from the captured plan and builds the
original SDK query payload. It refuses arbitrary payload, destination, target,
options, caller, grant, expiry or permission substitutions. Preparation is
read-only. Starting rechecks the exact installed environment and original
consent, then commits the delegated grant, fixed input, execution association
and shared invocation reservation in one original ledger transaction. Each
accepted item uses one invocation; control, failure, cancellation or uncertain
acknowledgements do not refund reservations. Exact recovery preserves the
original attempt and grant rather than issuing new authority.

Tools run through the original `RunnerProxy`, worker channel and live grant
checks. Source changes cancel only the affected delegated tool, while unrelated
work continues. Pause, stop, takeover, expiry and root cancellation prevent new
dispatch and signal active workers. Completed read-only tool permits retire
after their original attempt settles; ordinary producer/checker permits retain
their existing adoption lifecycle. Stored tool output stays unapplied and binds
the original durable grant identity even after expiry or reopen. It does not
create terms, translations, checks, selections or human approval.

The Desktop's bounded Agent controls explicitly select captured units, query
references, display escaped SDK reference columns or empty matches, and generate
another candidate for that subset using the original model service. Reference
output is displayed separately and is not automatically shared with the model.
An uncertain start retains its original prepared identity and exposes read-only
reconciliation without resending the request. Result-read failures can be
refreshed. Tool results remain visible across plan control changes.

Manual saves and manual selections protect the unit in the same transaction.
Protection survives project reopen. Explicit release requires confirmation and
matching protection revision, source revision and selection identity. Historical
release receipts report their original result without clearing newer protection.
Saving a candidate does not select it or give human language-review approval.
The existing effect service also honors candidate-only plans with explicit
`SaveCandidate` authorization. It uses the ordinary candidate adoption boundary
and finishes with `saved`, without requesting checks or selection. Failed saves
retain the original action for explicit recovery; stopped authority prevents
new saves. A prepared plan alone never starts this effect.


`prepare_automatic_selection` accepts a saved AI revision from this plan generation
and returns an opaque, store-created capture. The normal host runs the exact
adopted checker through independently consented original plugin execution, then
computes the complete Core/domain check union from the saved ledger evidence
outside a SQLite transaction. `commit_automatic_selection` rechecks the current grant,
source, selection, shared resources, scoped resource changes and protection in a
short transaction. A candidate from another plan, revoked generation, cancelled
attempt or changed basis cannot acquire selection authority. Selecting one entry
does not invalidate untouched entries of the same plan.

The initial `checked-selection-1` policy supports missing-only selection or
explicit replacement of the captured selection. Protection always prevents it;
missing-only also preserves existing selections. Incomplete checks, findings,
failed or unavailable rules prevent selection, even when a warning could be
waived manually elsewhere. The action receipt keeps the candidate check evidence
and its blocked outcome without deleting the candidate or attaching those results
to a different current translation. Successful selection and the ordinary QA
record for its new basis commit together. Policy identity, plan lease, observed
protection and immutable receipt remain separate from human review decisions;
selection never transfers approval or makes a release eligible.

A human-facing host must record protection through `set_work_protection` before
accepting an editable draft. This uses the existing persistent protection gate;
draft text is not sent to automation. Hosts must retain unknown protection writes
and keep input read-only until reconciliation. The required check set is the
adopted Core/domain policy union. Synchronous bundled check fixtures are
test-host-only; a reference query cannot substitute for required checker evidence
or certify external model quality.

The desktop command API uses the existing project session and execution runtime
for plan preparation, authorization, start, control, status and action recovery,
and protection reads/writes. Authorization and start are separate operations: a
saved authorization is not reported as a failed authorization when later enqueue
cannot run. Start uses the stored receipt and current grant, rather than accepting
raw execution input from the client. Historical acknowledgements cannot reactivate
a stopped generation. The desktop AI workbench prepares manual or assisted generation plans, shows
captured scope and sharing, and requires explicit confirmation and an authorization
duration before candidate generation. It exposes pause, stop, manual takeover and
renewed continuation. Reopening an attempt reads its stored plan association and
current authority; it sends no provider request. Lost control or authorization
responses retain their original action identity for receipt reconciliation. A saved
authorization whose enqueue fails remains available to start or stop explicitly.
The translation editor shows persistent protection and confirms release against
the current entry, language, source, selection and protection revision. Dirty or
unresolved saves block release. Opening an unprotected entry records protection
before enabling draft input. Until that write and a current protection read are
confirmed, the draft remains read-only. Failed reads can be refreshed; uncertain
writes retain their original action. If selection changed before protection,
discard any suggested draft and refresh the current entry before retrying.
Explicit release leaves the entry read-only until it is protected again. Saves
and subsequent reads keep an already protected editor editable, preserving newer
input. Composition prevents save shortcuts and entry/project navigation until
it ends.

The desktop exposes candidate-only work, selection of missing translations, or
explicit replacement of the captured translations. Choosing a selection policy
also enables the mechanical check stage; the sharing confirmation authorizes the
exact corresponding effect set. The host saves ordinary candidates through the
existing adoption ledger, computes mechanical checks on at most two background
threads, and commits through the same Core policy service. Workers own values and
cancellation signals, with no store or session handles. Pause, stop, takeover and
project close prevent subsequent automatic commits. A fresh project host pauses
crash-surviving grants before exposing its new session.

Each result shows its saved candidate and automatic phase, blocked reason or
sanitized failure. Historical policy receipts retain mechanical evidence and are
labelled as past work, without asserting the current selection or human approval.
A permitted storage retry first reads the saved result, then reuses the original
candidate and selection action identities; it never generates another provider
request. Opening an old attempt reads durable receipts without starting work.
Incomplete automatic effects are inactive after reopen and require an explicitly
renewed plan; they cannot silently resume an earlier grant. Candidate-only plans
retain explicit manual candidate saving. Standalone automated checks, resource
adoption and delivery remain unavailable. The API is not a stable plugin SDK. A model or plugin must not receive unrestricted access to human-authorization
methods, `ProjectStore` or the raw runtime; its host must carry the issued lease
and parent identity through the scoped application entry points.
