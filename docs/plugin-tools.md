# Experimental desktop read-only tools

Desktop tool queries consume the public SDK's
[read-only tool Resource](../crates/plugin-sdk/docs/tools.md) through the existing
installed package/runtime settings and Core execution ledger. The application
owns discovery, session authorization and execution consent; each package owns
its original capability, domain input/output/error contracts and guidance.

## Declared reference-query views

A JavaScript component can declare a host-rendered `Ui` with
`slot: "reference-query"` and `tsumugi.capability-tool-declaration` schema/behavior
`1/1`. The Host selects the unique Resource with that exact schema in the same
captured package and component. Its tool must select a query capability from that
component and supply the existing bounded `query` presentation. Missing or multiple
Resources, duplicate same-component slot/schema views and unsupported slots or
versions are refused; names and registration order cannot choose a match.

`read_plugin_ui` accepts `{ package, uiId }` and returns the exact package,
component, Ui, Resource, tool binding and installed settings revision. It reads
the original enabled/approved installation and rechecks that revision after
interpreting the immutable package. It captures no runtime and runs no code.
The view then uses `read_plugin_tool` and the original execution workflow below;
Ui and tool bindings must agree. No new permission, executor or task ledger is
introduced.

In **Resources → Reference queries**, declared views use the same standard text,
target, meaning, preview and consent controls. Multiple packages require an
explicit choice. Unsupported or invalid declarations do not fall back to a
Resource from that component. Resource-only packages retain their existing query
entry. Updating, disabling or uninstalling a package makes its old view unavailable;
a late read cannot restore it. The original draft and uncertain-action recovery
remain available without restoring execution authority. Plugins supply no DOM,
CSS, application state or native bridge access through this slot.

## Query controls and execution

An optional SDK `query` presentation supplies a bounded fixed input template,
explicit target and category choices, and reference-result columns. The public
SDK's `createToolQuery` helper constructs original single or batch payloads and
distinguishes empty matches from malformed output. The Desktop view captures
this metadata with the original binding; it grants no execution or adoption.
In the Resource workbench, **Reference queries** provides this shared
presentation without package-specific fields. Choose an installed reference
package and approved runtime, its explicit target and meanings, then enter one
or more separate texts. Multiple providers require an explicit choice. Review
captures the exact batch before a separate per-attempt execution consent.
New input remains editable during capture and requires a fresh review; unknown
acknowledgements retain the original request, grant and expiry for checking.

The controls read complete results through the original session query owner,
associate output with captured item identities and show escaped reference
columns or an explicit empty result. A malformed result is an error, rather
than an empty match. Hidden tabs retain drafts, leaving explicitly discards the
local draft/preflight, and cancellation targets the original execution task.
No term/translation adoption is offered. In the translation editor, **Look up
source text** and **Look up selected draft text** add the literal text to this
same query draft. The editor's unsaved text and existing query rows stay intact;
a lone empty query row is reused. New text invalidates the previous reviewed
consent and requires a new capture. Routing sends no query or save command;
a pending unknown action refuses incoming text without losing the editor draft.
Composition blocks routing until the user finishes entering text. Manual query
consent is independent of the bounded [work-plan Agent](work-plans.md).

`read_plugin_tool` accepts an exact package identity/digest, tool Resource ID
and independently approved environment digest. It reopens the installed object,
binds its actual capability, verifies supporting Resource/Skill files and matches
the executable runtime family. The resulting view includes the installed
settings revision, exact binding and independent package/runtime origins.
Discovery starts no worker and creates no execution grant.

`prepare_plugin_tool` requires an authorized project session, caller-owned
attempt ID, the exact tool choice and one or more opaque JSON `payloads`.
The captured tool view includes its required `componentScope`. Project and
Attempt components are supported for manual tools; an Attempt uses the original
attempt ID as its scope ID. The limited Application profile below fixes a trusted
instance UUID and activation generation in the same input. The captured manifest fixes this value in Core's
input before execution consent, so results cannot choose a different scope.
Work-plan Agent tools retain the same complete binding and use their own child
attempt identity, independently of the root attempt and Agent scope handle.
Changing scope changes the captured plan/input digest and requires new consent.
Required or offered services on Attempt query tools remain refused. The existing
Attempt generation-service adapter is reserved for generation components; no
manual query or Agent proposal gains a service or execution grant implicitly.
The application captures one fixed Core input for a single or batch query.
Core assigns item identities; use the returned item ID and payload together
rather than depending on the submitted array's order. The returned input digest
includes the selected tool, supporting package identity, environment, settings
revision and original query values. Repeating the same attempt and preparation
returns its original capture. Changing that attempt's parameters is refused.
Each project session holds one current preflight; failed preparation preserves
the previous capture, and concurrent preparation/start is refused.

The existing Core limits bound the complete fixed input to 4 MiB and at most
2,000 items. Each payload must also fit the capability's own input limit.
Generic opaque result encoding reserves eight times the declared output size
plus 16 KiB of metadata within Core's per-result maximum, with its existing
aggregate attempt limit. An unsupported declared output bound is refused rather
than silently reduced. Domain semantics remain the original worker's authority.

`start_plugin_tool` takes the reviewed attempt/input digest and the existing
strict Tool start consent: grant ID, original expiry, explicit consent to
unsandboxed execution and the required `applicationExecution` lifetime decision.
Project/Attempt requests explicitly set the latter to false. Before authorizing, the application reopens and compares
the captured tool and environment, then serializes its final settings revision
check with application-owned settings changes. Disabled/replaced packages,
revoked runtime decisions and changed settings require a new preparation.
Accepted asynchronous jobs retain their continuation if IPC stops waiting;
project quiescing revokes unfinished preflight tickets.
`discard_plugin_tool_preflight` discards only the named attempt's current
preflight/pending admission and preserves any original accepted start. It does
not cancel an already queued task; use the existing task cancellation command.

Execution uses the original `RunnerProxy` and Core grant/dispatch/result checks.
Single and batch queries use this same path. Repeating an accepted original
start reads its original enqueued input and persisted grant, including the exact
expiry, unsandboxed consent and Application lifetime decision. This data-only
acknowledgement remains available after later queries, quiescing, revocation or
reopening; it does not start a worker or restore any execution or instance lease.
Substituting a grant, changing either consent decision or renewing expiry for
that attempt is refused. A recorded grant without an enqueued input is not a
start acknowledgement and still needs its original pending admission.
An unknown acknowledgement retains the original action
for reconciliation. Inspect results, progress and recovery through the existing
execution commands, and cancel running tasks through their original task ID.

Results retain the actual worker channel, authorization ID and original SDK
output/error bytes. Query results stay unadopted and create no project Resource,
terminology or translation mutation. Historical output remains readable after
a provider is disabled. Tool guidance remains untrusted material. Work-plan
tools fix their package, environment, options, source subset and shared total
invocation limit through the original plan owner. They require independent
human local-execution consent for at most ten minutes, preserve its original
deadline on recovery, and use a Core-created caller identity and atomic delegated
grant/enqueue. The Agent's `prepareTool` and `startTool` accept only captured
handles, unit subsets and original prepared identities; they cannot submit free
payloads or renew consent. Results use this same ledger and reference
presentation and remain unapplied. Complete autonomous model orchestration and
native product acceptance have their own gates.

Rust/Serde owns these internal IPC shapes. Regenerate frontend types, schemas
and validators with `pnpm generate:contracts`; use the centralized
`pluginCommands.tool`, `executionCommands.prepareTool` and
`executionCommands.startTool` / `executionCommands.discardTool` adapters.

## Shared Application query instances

For an approved JavaScript Tool component whose callable capabilities are all
read-only, or a native worker with exactly one read-only callable, with no
required dependencies or ProjectService permission,
**Review queries**
reserves an exact instance identity without starting component code. The preview
includes required nullable `applicationScope`: an instance UUID/activation
generation for Application, and explicit null for Project/Attempt. Its original
Core binding, input digest and actual channel must agree on that identity.
The required `applicationCapabilities` list shows the whole frozen component
roster for Application and is explicitly empty for Project/Attempt. The lifetime
consent displays this set before execution; selecting another Tool in the same
component does not allocate a separate shared process.

The native singleton uses the original captured Native Host identity and
Process3 SDK worker facade. Its package and Native Host approval do not grant
instance lifetime or permission for a project query. It retains the same
instance principal across projects while each invocation carries its own exact
project, provider, input and grant. Native workers with multiple callables or
project services are refused.

The first run requires both the existing exact query consent and a separate
checkbox allowing this instance to live until application exit, explicit stop,
package withdrawal or retirement. A package/runtime approval, project grant,
manifest scope or query result cannot create this lifetime lease. Later project
queries can reuse the same live instance, but each requires its own fixed input,
exact selected capability and profile, project authorization, cancellation,
grant and original deadline. Process protocol 3 freezes the entire nonempty,
unique roster (at most 128 callables) at activation. Each invocation and result
retain their complete contribution binding and their own schemas and limits;
membership alone grants no permission to invoke a sibling capability. Closing one
project withdraws its authority while the independently consented instance may
remain running for another project.

This profile is unsandboxed. The same process can retain runtime state and
previously supplied input in memory across projects until stopped; it provides
no in-process project memory isolation. The Host sends each new input only
under that project's current permit, with no inherited project service handles.

The preview shows the reserved/active/stopping/stopped state and an explicit
**Stop shared instance** action. Stopping from any member interrupts calls on this shared
activation while keeping query drafts and saved ledger output. Unknown stop
acknowledgements retain the exact original stop action for reconciliation.
A historical start/stop ACK is data only and cannot restart an old activation.
The owner waits for its original process to be reaped before reporting stopped
or completing package removal. A later review reserves a fresh identity and
requires new lifetime consent; old cleanup cannot stop that replacement.

The existing session IO/frame/stderr/invocation limits apply cumulatively to
one activation. Failure, cancellation or exhaustion retires that activation,
without automatic replacement or renewed budgets. Application instance/status
records and control actions are bounded for one application session; exhausted
capacity is reported explicitly. Drained processes, runtime images and obsolete
runner registrations are released by their original owners.

Native multi-callable Application workers, required/offered project services,
domain Source/Translation/Review/Build, work-plan Agent tools
and generation components remain explicitly unsupported. Data Resources and
Skills remain readable without activating an executable component. Internal IPC
status/stop adapters are `executionCommands.applicationInstance` and
`executionCommands.stopApplicationInstance`; they create no project grant.

Normal application exit closes instance admission, withdraws every original
lifetime lease and waits for bounded owned cleanup before destroying the native
window. If cleanup is still stopping or its acknowledgement is unknown, the
window remains open. Closing it again checks the same original stop-all action;
it does not activate a replacement. Closing a project alone does not invoke
this application-exit control. Automated checks cover direct-child reaping;
actual native application exit remains a separate acceptance step.

If exit is cancelled by newer edits or native window destruction fails, the
original App feedback provides **Allow new shared instances**. This explicitly
reopens admission only after the exact shutdown has drained; old instances and
leases stay stopped. An uncertain recovery retains its original action for
checking and blocks conflicting exit/recovery requests. Later exit uses a new
action and snapshot. Replaying an earlier stop or recovery cannot stop newer
instances or release a newer exit's admission fence.
