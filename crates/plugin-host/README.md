# Experimental process Host

The [plugin authoring walkthrough](../../docs/plugin-authoring.md) covers fixed
SDK consumption, package inspection and explicit manual development loading.

`tsumugi-plugin-host` launches captured plugin artifacts through the standalone
SDK process protocol. Its default feature set depends on the SDK without Core;
the optional `core-adapter` feature implements Core's trusted execution port.
It has no domain runner or model dependency. Desktop source/build commands use
exact approved installed packages and runtimes; default domain-package distribution
and the complete extension lifecycle remain under development.

Project- and attempt-scoped native workers or JavaScript components retain one
serialized capability per channel. The Application profile supports a frozen
roster of JavaScript read-only Tool callables or one native read-only Tool
callable, with no required dependencies or ProjectService access, under a
separate explicit lifetime lease. Native multi-callable components and broader
Application compositions remain unsupported. The Unix launcher creates an owned process group;
this profile is tested on macOS. Windows is refused until an owned Job Object implementation is verified.
The JavaScript launcher requires a `CapturedRuntime` containing the independently
approved Node tool and complete [built component Host](../../runtimes/javascript-host/README.md) trees. That Host
owns the process protocol and privately uses Cordis behind the SDK facade. The
plugin entrypoint exports a component; it is not launched as a protocol peer.
The local installation store can retain and reopen the approved runtime trees.
Trusted runtime acquisition and desktop distribution remain separate work.

## Application Tool lifetime

With `core-adapter`, `ApplicationInstance::reserve` captures the selected Tool's
entire immutable component roster and declared profiles, then allocates a fresh
instance UUID/activation generation. It starts
no component instructions. The trusted application owner separately authorizes
its lifetime with the user's explicit consent and original settings-revocation
signal; ordinary `RunnerProxy::new` and Core `authorize_plugin` refuse this
scope. Each real dispatch still carries a separate project permit, cancellation,
fixed input and original deadline. No project connection or service broker is
retained by the idle Host owner.

A bounded IO owner serializes calls to the same actual process across projects
and component members. Its queue and cumulative budgets belong to the whole
instance. `ProcessSession::channel()` returns a `ComponentChannelReceipt` with
the frozen roster and no preferred member; `ChannelReceipt` on each
`ReceivedResult` identifies the exact invoked contribution. The receipt's scope
describes its lifetime basis, while `ReceivedResult` separately records each
request's project/scope principal. Core fixes the basis in its
required nullable binding before consent and checks the actual channel identity
on receipt and reopening. The process can retain its own state and previously
supplied inputs in memory; this unsandboxed profile makes no in-process project
memory-isolation claim. Unauthorized new input is refused before invocation.

The trusted lease retains exact member/profile bindings within Core's original
input byte ceiling. Every call still requires that member's own original grant,
schemas, profile, input, cancellation and deadline. Process protocol 3 activates
the full nonempty unique roster (at most 128 callables); only a matching complete
Ready acknowledgement admits calls. Close/Closed identify the whole component.
Project/Attempt and native workers keep a singleton roster; older process
protocols are rejected without a fallback.

The manual Application Tool profile accepts JavaScript components with a frozen
read-only roster or a native worker with exactly one read-only callable. Neither
may require dependencies or ProjectService permission. Every callable must meet
these rules, including members other than the currently selected Tool.
Resources/Skills remain inert data. Application generation/domain/Agent, native
multi-callable components and service compositions stay refused. Stop, settings
withdrawal, cancellation, failure or cumulative budget
exhaustion retires the original activation. It is never silently replaced.
Cleanup reports stopped only after the owned direct child is reaped; exact old
keys cannot remove a later registration. Application exit snapshots its original
instances, closes admission and waits for bounded cleanup. An explicit recovery
after draining permits future separately consented instances without restoring
old leases; replayed old controls cannot change a later exit fence. Historical output/ACKs stay data only
and cannot restore a live lease after stop or project reopening. See the
[Desktop Tool guide](../../docs/plugin-tools.md) for the explicit consent and
stop controls.

## Project-service broker

Attempt components retain the original launch-authority guard for their entire
channel lifetime. Their scope ID must equal the invocation's exact attempt ID,
in addition to the captured project, package, contribution and actual instance.
An observed loss of authority cannot be undone by supplying another callback.
Core's `PluginExecutionBinding.componentScope` is required captured input data;
the immutable package determines it before consent. Requests and historical
result validation derive scope from that input, never from a worker's output.
The original input digest and grant therefore also bind the selected scope.
Each Project/Attempt Core dispatch owns and closes its process. Application
Tools use the bounded owner below; no shared service registry, grant renewal or
automatic activation is introduced.

Composed source/translation, format/advisory review, build/artifact and Agent
operations retain a complete binding per capability. Scopes can differ between
roles; an Attempt checker uses its own check attempt, not the producer's attempt
or a UI action/scope handle. The one Core scope derivation is reused for requests,
launch and service selection. Captured input and all original grants and required
checks remain authoritative on receipt and reopening.

Attempt services currently support only the existing JavaScript generation
adapter. Its required dependency, effect, permission and schemas must match, and
the per-dispatch factory fixes the descriptor to the original outer project and
attempt. Missing required services, foreign Project/Attempt descriptors and other
offered service contracts are refused before staging. Absent optional services
remain allowed. Project brokers retain their existing behavior. A completed
channel does not roll back an already accepted child or renew its original
deadline, grant, work-plan lease or budget.

`ProcessSession::launch_with_services` accepts a trusted `ProjectServiceBroker`.
It validates the broker's explicit selected bindings against actual component
dependencies, capability permissions/effects and project scope before staging or
spawning. Ordinary `launch` supplies no services and still refuses missing
required dependencies. Service availability never grants execution permission.

With `core-adapter`, a cached `RunnerProxy` can accept a trusted
`ProjectServiceFactory`. It captures a separate broker for each real
`DispatchRequest`, matching Core permit and cancellation handle. Capture shares
the bounded startup allowance and original Core dispatch deadline, and
continuously checks authority; failure never
launches a child without the requested services. The factory cannot retain a
particular invocation's work-plan scope as the cached proxy's authority.
The actual dispatch deadline remains required through launch, invocation and
result delivery, including while Core is waiting for its next runtime tick.
Historical outcome queries cannot reconstruct a fresh deadline for execution.

The Desktop generation factory can additionally bind exact prepared WorkPlan
tool queries for an opt-in Project JavaScript caller. Each read-only Project
JavaScript or supported Application callee retains its original tool preparation,
independent consent, grant, budget and real Core execution receipt. Application
tools additionally require their exact shared instance's separate lifetime lease
and complete captured capability roster. The original manual Agent query entry
uses that same WorkPlan tool authority. The caller receives a separate
[generation-component input](../plugin-sdk/docs/generation.md#prepared-component-tool-queries),
including the frozen query bytes and call identity. Application callees retain
their restricted JavaScript roster or Native singleton profile, without their
own required dependencies or ProjectService access. Both caller and callee package
shutdown retain their original producer ownership until drainage. Query results
keep the callee's own schema and never replace the Core generation receipt.

For each call, the Host supplies a `ServiceCaller` derived from the actual channel
and original invocation, then checks the exact handle, context, contract, payload
and current guards. `ServiceCaller::deadline()` exposes the fixed absolute outer
invocation deadline to the trusted broker without sending a clock or authority
object to the component. Service callbacks share that deadline and are cancelled
when authority is revoked. They must return promptly
for long-running work; the application owns durable enqueue/reconciliation and
must retain child authority until termination independently of channel cleanup.
Wrong-direction, duplicate, stale or mismatched traffic terminates the owned
process. Service output remains opaque and unadopted. This public transport does
not add an AI runner, credential store, project mutation boundary or Core grant.

The SDK-owned process protocol is now 3. Rebuild and capture the current Host and
regenerate consumers; earlier process-1/2 runtime descriptors are refused. Other
protocol, project and installation format identities remain separately owned.

## Captured package and actual channel

The trusted installer supplies immutable manifest/file bytes and an independently
expected package digest to `PackageImage::capture`. The digest covers ordered,
length-delimited paths/content and executable flags. Computing it does not
authenticate a publisher or authorize execution. Byte capture does not follow
source filesystem paths or unpack arbitrary archives. The initial materialization
profile rejects traversal, case aliases, non-ASCII paths and file/directory
collisions and reserved device names, then writes a private instance directory
under the host-owned staging parent.

`PackageImage::capture_directory` adds bounded capture of a selected prebuilt
local directory on macOS and Linux. Call it on a blocking IO worker with an
independently expected digest and a live read guard from the trusted application.
It opens every path component relative to a held directory descriptor with
`O_NOFOLLOW`, rejects links, hard-linked regular files and special files, and
requires two complete scans to agree on identities, metadata and file contents.
The snapshot keeps binary bytes and executable flags. The policy bounds captured
non-manifest files to 256 plus `manifest.json`, total manifest/file bytes to
64 MiB, directories to 256, package
depth to 16 and observed processing time to ten seconds. The read guard is checked
between reads; synchronous filesystem calls themselves cannot be preempted.
macOS maps only the system `/var` and `/tmp` aliases to `/private`; arbitrary
symlinks remain rejected. Other platforms refuse this capture API. Tests have run
on macOS; the Linux implementation has not been exercised here.

Captured bytes remain fixed after source edits. Capturing does not execute the
entrypoint, unpack an archive, fetch metadata or prove publisher identity. The
caller still owns source approval, and an installer must validate archive/source
provenance before producing captured bytes. The desktop's [local package
controls](../../README.md) use explicit manual trust; authenticated network updates
remain separate work.

Public package tooling uses `PackageImage::inspect_directory` to fingerprint a
prebuilt candidate through that same bounded capture owner. It returns the claimed
plugin identity, package digest, manifest SHA-256 and actual file/byte counts;
it returns no image, installation receipt, publisher approval or grant. This
read-only CLI accepts an absolute or relative selection without resolving away
symbolic links:

```sh
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect /path/to/prebuilt-package
```

Verify this candidate against trusted release metadata or explicitly approve its
source before supplying its digest to installation. The inspection performs no
component loading, download, build or installation script. Independent plugins
can materialize their declared runtime files and use this public tool instead of
copying the Host's package digest algorithm.

`PackageImage::capture_archive` accepts already read bytes of the existing
uncompressed candidate tar and the independently approved package digest.
`inspect_archive` provides the same five-field inspection without approval.
Member modes retain executable flags across operating systems; no files are
extracted or executed. The payload keeps the original 64 MiB total limit and
256 files plus the manifest, with at most 1 MiB of encoded transport overhead.
Only regular USTAR members and a single local PAX `path` for the following file
are accepted. Links, sparse entries, path aliases, other extensions, executable
manifests, incomplete terminators and nonzero trailing input are refused.
The parser checks the live read guard and an observed ten-second deadline.

`PackageImage::encode_archive` writes a deterministic in-memory transport from
an already captured image, preserving its manifest, file bytes and logical
flags. It shares the decoder's path and materialization bounds and checks the
same live guard during bounded file chunks. Long paths use the supported local
PAX record. This does not write files or grant permission. The resulting tar
retains the captured package digest; its transport bytes and archive SHA-256
can differ from the original producer's archive, which must retain its own pin.

The read-only CLI consumes a bounded archive from standard input:

```sh
cargo run -p tsumugi-plugin-host --bin tsumugi-plugin-package --locked -- inspect-archive < candidate.tar
```

The transport archive SHA-256 and captured package digest remain separate
identities. This entry does not install a package, verify its publisher, enable
Windows Store/runtime support or grant execution permission. Generic packages
need their original manifest and resources; bundled-only SDK recipe policies
remain in their distribution tooling.

The explicit `diagnose <prebuilt-directory> <request-json>` operation adds
[capability declaration/profile diagnostics](../../docs/capability-compatibility.md)
from that same immutable capture. It compares independently supplied expected
contract/profile identities through the SDK's original matcher. Compatible and
incompatible reports retain actual declared versions and the five-field package
inspection; the original `inspect` output stays unchanged. Diagnosis runs no
component, creates no Store and grants no installation or execution authority.

## Fixed runtime environment

`PackageImage::capability_tool` resolves an SDK [read-only tool declaration](../plugin-sdk/docs/tools.md)
from its immutable Resource, retaining the original capability and checking
same-package Resource/Skill support. Wrong contracts, writable effects, extra
permissions and executable supporting bytes are refused. Metadata inspection
does not activate a component or grant execution; application consumers must
recheck current availability, fixed selections and actual per-attempt authority.

`PackageImage::text_review_declaration` binds an explicitly selected advisory
text-check Resource to its original read-only capability and same-package
supporting resources. `text_review_resource_pins` hashes the actual captured
resource bytes; `validate_text_review_input` compares a fixed request to that
declaration, provider and complete pin set. Wrong schemas, package selections,
claimed resource hashes and executable support are refused without running a
component. This metadata boundary grants no execution, resource adoption or
project QA qualification; actual channel reception and current policy remain
independent requirements.

`PackageImage::resource_bytes` reads one explicitly selected Resource from the
immutable captured package after an exact schema and behavior match.
`skill_bytes` reads one declared Skill from the same image. Both reject a wrong
contribution kind or executable content and retain the original captured bytes;
neither starts a runtime, reads source paths or grants project mutation, tool or
execution permission. Resource interpretation belongs to its public contract's
consumer. Skill guidance remains untrusted content. Domain-independent knowledge
packages can use these APIs without adding a Core format branch.

`CapturedRuntime::capture_directories` captures two prebuilt, link-free trees on a
blocking IO worker. Independent installer approval supplies the SDK's strict
`RuntimeEnvironmentDescriptor`, exact platform/architecture, tool version,
complete tool/Host tree digests and relative entrypoints. Every actual byte and
executable flag must match. The trees share a 256 MiB / 2048-file / 60-second
observed bound. Later edits or deletion of their source directories cannot change
the retained snapshot. Capture executes no code and grants no authority.

The initial `node-system-libraries-v1` profile requires the trusted installer to
verify a Node distribution using only platform system libraries. A Homebrew
entrypoint with external dynamic libraries cannot be approved by hashing that
entrypoint alone. The Host does not infer this premise from a declared version,
parse binary dependencies, authenticate signatures or freeze the OS itself.

Build tooling can use `CapturedRuntime::inspect_directories` and the public CLI
to derive an observed SDK descriptor through that same bounded tree owner:

```sh
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-runtime -- \
  inspect /absolute/tool-tree /absolute/host-tree /absolute/inspection-request.json
```

The strict request contains `profile`, `toolVersion`, `toolEntrypoint` and
`hostEntrypoint`; the CLI limits its JSON to 4096 bytes. The output includes the
SDK-owned descriptor/digest and combined file/byte counts. The requested version
and profile are claims, not discovered facts or trusted approval. The inspector
executes no artifacts and never installs, approves, activates or grants Core
authority. The [fixed macOS preparation tool](../../runtimes/javascript-host/README.md#prepare-the-fixed-macos-tool-and-host-artifact)
verifies pinned distribution bytes and their loader boundary before inspection.
Its output still requires independent application approval and installation.

Launch materializes captured package, tool and Host bytes into one private owned
instance (`package/`, `runtime/tool/`, `runtime/host/`). Descriptor-relative
create-new IO uses private directories and read-only files, checking live
authority between chunks and before spawn. The child runs the captured Node and
Host entries with an empty inherited environment; it does not resolve them from
PATH, global modules or the original source directories. JavaScript invocation
requests must carry this environment's SDK-derived digest. The Native standalone
conformance profile does not provide a Core environment binding.

`CapturedNativeRuntime::inspect_current()` observes the actual application Host
without executing a plugin or creating approval. `capture(&approval)` compares
the complete independently approved SDK native descriptor with that observation.
On macOS, the read-only [XNU `csops` interface](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/codesign.h)
supplies the own process's CodeDirectory hash; on Linux, the held
[`/proc/self/exe` executable handle](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)
supplies complete bytes with stable metadata checks. Mutable current-executable
pathnames and worker claims are not used. Unknown platforms/architectures or
unavailable identities are refused. Publisher trust and OS/library capture are
outside this profile.

`RuntimeLauncher::NativeCore` retains that immutable native description and its
owner PID, checks the actual current Host again before staging/spawn, and binds
requests to its derived environment digest. It uses the same captured package,
held staging directories, live-authority callbacks and close/reap owner as Node.
Native entrypoint/package bytes remain fixed by the separate provider binding;
no Node/tool/Host tree is invented for them. Native installed Desktop selection
and persisted approval are separate work; this library route does not add a
parallel settings store.

## Package catalog and fixed selection

`PackageImage::build_declaration` reads an explicitly selected non-executable
SDK build Resource from its immutable captured bytes, then binds both exact
builder/checker declarations from that same manifest. It grants no execution or
publication authority. The [SDK build contract](../plugin-sdk/docs/build.md)
defines decided input, actual UTF-8 artifacts and complete independent check data;
the desktop workbench captures explicit paths and reviews each execution;
domain-package migration and complete native acceptance remain pending.

Desktop `read_plugin_build` resolves that declaration from the exact enabled
installed package and independently approved installed runtime in one current
application-settings snapshot. Its read-only view includes both provider
bindings, the fixed profile/output limits/artifact rules, complete environment
and origins. Source and build resolution share the same package/runtime owner
and recheck the entire settings snapshot before returning. It runs no component,
captures no project data and grants no execution or release authority. Fresh
resolution rejects disabled or changed package/runtime decisions; previously
captured bytes remain an immutable observation.

Desktop `prepare_plugin_build` freezes eligible project input with explicit
locale/output/configuration choices and the exact installed environment. It
grants no execution. `start_plugin_build` requires explicit acknowledgement of
the unsandboxed process and a grant for that exact attempt/input/expiry. Preparing
an artifact check captures a saved builder result and all its actual outputs;
`start_artifact_check` requires its own consent and grant. Builder grants cannot
authorize the checker. Both starts freshly resolve the approved package/runtime
and use the existing RunnerProxy and Core execution ledger. Source and build
requests share one bounded session registration owner.

`finish_artifact_check` computes the fixed required-check proof outside the
project queue, then commits through Core's existing validation owner. Only the
complete proved locale set can be adopted by the existing Release handler.
Original retries do not renew grants; cancelled preparation and closed sessions
reject late continuations. Execution cancellation uses the existing task control.
The desktop workbench uses these commands with separate consent and original-action
reconciliation. Generic saved-artifact delivery uses held native directories and
per-file outcomes. Default domain bundles, domain-package cutover and complete
native workflow acceptance remain pending.

`catalog::PackageCatalog` records at most 128 captured package versions. Its
`PackageApproval` comes from independently verified metadata or explicit local
source approval, with expected plugin identity, digest and non-secret source and
publisher identifiers. Registration compares those values to the actual image;
the API does not verify signatures or TUF metadata. Same-name packages cannot
silently move source or publisher, and an existing exact identity cannot be
replaced with different bytes. Versions from the same origin can coexist.

Registration starts disabled. Explicit enablement makes declarations eligible
for new selection without loading code or granting project access. Resolution
reuses the SDK's exact contract/profile and provider-choice rules. Multiple
compatible providers or versions require an explicit choice for a single
operation; collection retains independent identities in canonical order.
`ResolvedCapability` holds the actual package image, approved origin and complete
capability binding. `lookup` checks an existing fixed binding without substituting
a newer version or another contribution. Disabling stops new catalog resolution;
already captured selections remain unchanged. The lifecycle owner must separately
stop dispatch and revoke Core permits when required. This catalog is in memory
and is not a second project store or a production installation/update service.

Its Rust dependency closure diagnostic API adapts the same captured images and
enabled state to the SDK's [bounded declaration
graph](../plugin-sdk/docs/declarations.md#component-dependency-closure-diagnostics),
then retains exact package digests and provider bindings. It does no package IO,
activation or authorization. A missing declaration in this catalog does not
establish whether an external Host service is available; Application and
ProjectService execution restrictions still apply independently.

Run the admission and selection tests without a worker runtime:

```sh
cargo test -p tsumugi-plugin-host --test directory --test catalog --locked
```

## Durable local installation

`PackageStore::open_existing` opens a selected application-owned directory on
macOS and Linux. The directory must already exist, belong to the current user
and have mode `0700`; the API does not provision arbitrary paths. A held lock
permits one cooperating store owner. Root, lock and object-directory identities
are checked throughout descriptor-relative IO. Read-only package objects reject
links, hard-linked regular files, unexpected modes and unknown receipt fields.
The same-user process can still change permissions; these checks do not create
an OS sandbox or authenticate the publisher.

Current Store receipt format 2 binds one immutable tar payload per artifact:
`objects/<package-digest>/{package.tar,receipt.json}` and
`runtimes/<environment-digest>/{tool.tar,host.tar,receipt.json}`. Each archive and
receipt has mode `0400`; the sealed envelope has mode `0500`. Logical executable
flags belong to archive members, independently of the archive file's own access
mode. No persistent extracted tree or flags sidecar is retained. The original
manifest, artifact bytes, SDK digests and independent approvals keep their owners.
Earlier development receipts, directory payloads and mixed layouts are preserved
and refused; use a new development Store and explicitly reinstall from approved
inputs. There is no implicit conversion or fallback. Repository frozen-input
records and application settings retain their independent format versions.

`PackageStore::provision` creates a fixed application-owned suffix under an
existing current-user directory. Its anchor must not be writable by other users;
one to eight simple UTF-8 child names are accepted, and every suffix directory
must have mode `0700`. Existing permissions and entries are preserved. The same
descriptor-relative filesystem owner creates and synchronizes directories,
checks observed anchor/suffix/root replacement and retains the root descriptor
through lock acquisition and store initialization. Run it on a blocking worker
with a live guard; its observed deadline is 60 seconds. Failure can leave private
empty directories or initialized namespaces, which the same suffix can safely
reopen. This does not approve packages, enable a catalog entry or restore grants.

`PackageStore::inventory` observes a deterministic list of at most 128 package
and 128 runtime receipts under that same lock and live IO guard. It validates
strict receipt fields, SDK manifest identity, origin syntax, readonly metadata,
namespace consistency and the shared action/identity conflict index. Package
metadata retains the 64 MiB limit; runtime metadata retains its existing complete
artifact limits. Strict tar headers, local path metadata, padding and terminators
are read through held files. Package inventory also reads the manifest; ordinary
payload bodies are seek-skipped. Runtime and retired-object indexes skip every
ordinary body. Selected load and original-action recovery verify complete bytes.
These scans perform metadata IO, without treating the index as digest verification. An interrupted promoted object is listed as `RecoveryRequired` and
is not sealed or repaired. Unknown private candidates remain untouched.

Inventory is metadata only. `Sealed` describes the wrapper, not authenticated
provenance, verified executable bytes or readiness to run. A legal observed origin
is not independent approval; readonly executable bytes can have changed before
inspection. Callers must still obtain a trusted `PackageApproval` or
`RuntimeApproval` and use selected `load`/`load_runtime` for complete capture and
admission. Inventory creates no approval, enablement, process or Core grant.
Like the other store APIs, it belongs on a blocking worker and is not an OS
sandbox against software running as the same user.

`PackageStore::settings` reads bounded local application decisions separately
from installation receipts. Only an absent `settings.json` returns revision 0
with no package/runtime approvals. Existing files must be private, regular,
unlinked mode `0400`, at most 1 MiB, strictly decoded and semantically valid.
Malformed, unsafe or changed settings are refused and preserved; they are never
reconstructed from inventory. Each snapshot contains at most 128 independently
approved package versions with exact `enabled` flags and 128 approved runtime
environments. Same-source package versions coexist; duplicate identities and
conflicting sources/publishers are rejected through the catalog's shared policy.

The trusted application supplies `PluginSettingsUpdate` after independently
verifying application metadata or receiving an explicit human decision. It must
not convert a receipt or a digest match into approval. Runtime descriptors,
package identity and digest syntax share SDK validation; origin identifiers use
the catalog owner. These settings contain no execution grant, project session,
channel token or credentials. Reading or saving them does not load code, enable
an in-memory catalog, activate a component or restore a Core permit.

`update_settings` takes an expected revision, a canonical action UUID and the
complete desired state. It normalizes exact records before saving, refuses stale
revisions without writes and advances the revision once. Settings action IDs
identify settings intents, separately from installation receipts. Keep the
expected revision, action ID and complete intended update until its outcome is
confirmed. A retry matching the last action and exact normalized snapshot
rechecks file and parent-directory durability without another revision change;
a changed retry is refused. Once a newer decision is saved, an old intent cannot
silently overwrite it.

The same store lock, held root descriptor, live guard and observed 60-second
IO deadline govern settings. A private exclusive candidate is fully written,
checked against intended bytes, sealed and synchronized before atomic
promotion/replacement. The settings file and root directory must then synchronize
and retain their bindings. A failure after namespace replacement is
`UnknownCommit`, even if the new values can be read. Re-read current settings and
reconcile the same intended update rather than issuing a fresh action blindly.
Pre-promotion failure preserves the old snapshot and its private candidate;
unknown candidates are not deleted. This cooperative CAS is not protection
against malicious software running as the same user. The desktop uses these
decisions in its [local package controls](../../README.md). Runtime and execution
consent remain separate integration work.

Installation accepts an already approved `RegisteredPackage` and a canonical
non-nil UUID action. It encodes captured bytes and logical flags into a private
candidate archive, synchronizes the archive and receipt, then promotes the whole object exclusively under
its actual package digest. The private outer directory stays writable for the
rename and is sealed after the promoted identity and bytes are rechecked;
the package archive and receipt are already read-only. The object and required parent directories must be
synchronized before returning a successful immutable receipt. A failure after
promotion is `InstallError::UnknownCommit`; retain the object and retry the same
action to verify and synchronize it. A promoted but unsealed object returns
`RecoveryRequired` from `load`; only the original action with the exact approval
can seal and finish it. A new action cannot silently reuse the old receipt or
repair a different pending installation. Candidates interrupted before promotion
remain private and are not installed objects; this API does not delete unknown candidates.

Each store contains at most 128 installed package versions. Conflicting action,
identity, source or publisher metadata is rejected; same-source versions coexist.
The original action can be reconciled even at capacity. Reopening and `load`
require an independent `PackageApproval` and recapture actual bytes, rather than
trusting a receipt or digest-shaped directory name. Loading returns an immutable
image and receipt without catalog enablement, execution, a Core grant or project
adoption. The receipt format is owned by this experimental store, not a new
project database or public SDK protocol.

Use a blocking IO worker and a live application guard. Each install/load has a
60-second observed deadline, checked between filesystem operations; individual
blocking system calls are not preempted. The existing package capture limits
remain in effect. Linux is implemented but has not been exercised in the macOS
validation environment. Network acquisition/signatures, complete project
environment selection, uninstall/garbage collection and desktop runtime controls remain
separate work.

### Exact application environment decisions

`RuntimeApproval.environment` uses the SDK's strict `ExecutionEnvironmentDescriptor`:
complete captured Node environments and observed Native application Hosts share
one `PluginSettings.runtimes` decision snapshot, revision check and original-action
reconciliation. Reading or persisting a decision grants no execution authority.
Native Hosts have no installable tool/Host trees. `captured_environment`,
`install_runtime`, `load_runtime` and runtime receipts explicitly refuse the Native
variant; callers must use `CapturedNativeRuntime::capture` to compare a separately
approved Native descriptor with the actual current Host before execution.

The current-only local settings format is 2. Earlier development settings are
refused unchanged, without conversion, implicit approval or receipt-derived
replacement. Preserve old settings when creating a new development profile.
Node runtime objects use the current Store receipt format 2 described above.
Desktop observation of
recorded Native decisions is metadata only. The desktop separately observes its
actual current application identity and accepts an explicit digest-bound decision
through the same settings revision/action owner. Old Native approvals can be
removed without changing Node decisions; no Native runtime tree is installed.
Native execution selection remains in development.

### Reopening an approved runtime

`PackageStore::install_runtime` retains a `CapturedRuntime` under its SDK-derived
environment digest. Its independent `RuntimeApproval` contains the complete SDK
descriptor and trusted source/publisher origin. This uses the same store lock,
descriptor-relative IO, exclusive promotion and original-action recovery as
package installation. The two artifact archives and their receipt are read-only; the store
keeps distinct environments without replacing an installed one.
Unselected runtimes participate only in bounded receipt, read-only metadata and
descriptor-identity checks for conflicting actions. This does not approve their
execution bytes. The target runtime is fully recaptured before and after promotion
and during original-action recovery; loading always recaptures the selected archives.

After closing and reopening the store, `load_runtime` requires that independent
approval again and recaptures both complete artifacts, including executable flags.
The original acquisition directories are no longer needed. An installed receipt
records provenance and the original action; it is not a new source of trust or
permission. Changed bytes, descriptors or origin are refused. An interrupted
promotion remains uncertain, and an unsealed object requires its original action
to finish rather than being repaired by loading it.

The runtime trees share the SDK's 2048-file / 256 MiB bound, and each store keeps
at most 128 runtime environments. Package and runtime installations share the
action identity boundary. Installing or loading a runtime never executes it,
enables a plugin, restores a Core grant or adopts project results. The returned
runtime can be supplied to the existing JavaScript launcher or Core RunnerProxy;
their execution consent and channel checks still apply.
Callers with exhaustive matches on `InstallError` must handle `MissingRuntime`.

```sh
cargo test -p tsumugi-plugin-host --lib --test installation --test directory --test catalog --locked
```

Materialization runs on a blocking IO worker and retains ownership of its temporary
directory while a spawned child remains unreaped. Cancelling a pre-spawn
materialization future leaves the bounded blocking task to finish its own cleanup. Authority is rechecked immediately
before spawning, after materialization, as well as during the handshake.

`ProcessSession::launch` requires a current authority callback and an explicit
acknowledgement of unsandboxed execution. The manifest's requested permissions do
not provide either. Launch resolves the declared entrypoint and contribution,
does not inherit the parent environment, and assigns a fresh instance identity
to the actual process/pipe channel. Required dependencies without an implemented broker
are refused. Application launch requires the explicit instance basis and limited
JavaScript Tool profile below. The handshake must echo the
captured capability and provider binding exactly. It cannot upgrade declarations,
effects, versions, limits or permission requests.

Plugin sessions and application members use the same owned child-process
implementation. The caller attaches its captured materialization before a
fallible explicit start, rechecks authority and binding, and rolls back through
the original bounded cleanup path on failure. Attached pipe tasks are aborted
when their owner is dropped. Unix children keep their original process-group
and direct-child wait policy; this is lifecycle control rather than confinement.

The Windows backend creates a suspended process with an explicit inherited
handle list inside a private kill-on-close Job before its initial thread runs.
Only an explicit start resumes that thread. Successful wait requires both the
leader's exit and an empty Job; unknown state cannot release staging. This is a
process backend, not available Windows package loading or Desktop support.
Directory capture, installation, runtime identity and distribution gates remain closed.
It requires the Windows 10 Job-list process attribute and does not fall back to
assigning an already running process.

The separate `crates/plugin-host/process-conformance` workspace compiles the
actual process-owner source by path, without database or repository-verifier
C libraries. With the corresponding Rust target installed, use:

```sh
cargo check --manifest-path crates/plugin-host/process-conformance/Cargo.toml --target x86_64-pc-windows-msvc --tests --locked
```

Cross-compilation checks API and type consistency. It does not execute Windows
Job admission, pipe access controls, descendants or teardown; target execution
must be checked separately before claiming that platform is supported.

The filesystem backend also supports held-parent-relative Windows operations
for materializing already captured in-memory artifacts. It uses complete volume
and file identities, rejects reparse points and multiply linked files, and
creates protected current-user access controls. Read-only and executable access
come from each captured artifact's explicit flag, never from a filename or an
inferred NTFS executable bit. Process pipes, Jobs and files share the same
current-token security-descriptor implementation.

Cleanup verifies recorded identities and deletes the held Windows object;
replacement objects and unknown contents are retained. Unix keeps its original
descriptor-relative operations and observed-binding cleanup policy. These are
lifecycle and integrity controls, not an OS sandbox against the same user.
The separate `filesystem-conformance` workspace compiles the actual filesystem,
runtime and staging sources without the repository/database C libraries:

```sh
cargo check --manifest-path crates/plugin-host/filesystem-conformance/Cargo.toml --target x86_64-pc-windows-msvc --tests --locked
```

This does not enable Windows directory capture or package installation: their
portable executable-flag source still needs a complete artifact contract.
Actual Windows file behavior must be checked separately from compilation.

`invoke` checks the captured project/scope, package/instance, exact capability,
input/output/error/profile identities and limits. The SDK correlates the result
with both the captured request and this actual channel. Dispatch IDs cannot be
reused, and unsolicited/duplicate output cannot become the next dispatch's result.
`ReceivedResult` can only be constructed by the Host and exposes immutable output
and channel evidence. This is not domain semantic validation, replay authority,
human approval or a project write; Core must still perform those checks.

## Bounded IO and exit

The [SDK framing contract](../plugin-sdk/docs/process.md) owns the JSON source.
The host checks lengths before allocating incoming bodies, bounds the aggregate
stdout and stderr traffic and queues, limits invocation count, and applies policy
deadlines even when stdin is blocked by a worker that stopped reading. Raw stderr
is counted and discarded rather than printed or stored as trusted diagnostics.
Explicit heartbeats correlate a fresh nonce on the same channel.

Payload and frame ceilings are separate. Manifest `maxInputBytes` and
`maxOutputBytes` bound exact, unescaped payload UTF-8; `maxResultBytes` bounds the
complete encoded SDK result frame, including JSON escaping and metadata. The
Host checks the original received frame against the invocation budget before
parsing, including JSON whitespace and escape overhead. It also checks the raw
output limit for success, failure and unknown outcomes before returning evidence;
the SDK correlates the complete result with its captured request.
The default frame ceiling follows the SDK's finite process profile; the default
aggregate stdout ceiling is 64 MiB. Callers can select narrower frame/stream
limits. No limit permits truncation or partial result acceptance.

Cancellation and current authority are polled while waiting and rechecked before
returning output. Revocation poisons the channel, stops further dispatch, and
terminates the owned process group. `close` waits for a bounded acknowledgement,
terminates the group and reaps its direct child under a separate cleanup deadline.
`CloseReceipt` and `termination_receipt` distinguish acknowledgement, actual
direct-child reaping and known exit status. An error/timeout does not assert that
an external effect did not occur. Callers must await `close`; Drop kills/aborts as
a final cleanup safeguard and does not produce an acceptance receipt. If Drop or
post-spawn rollback cannot confirm reaping, it retains the instance instead of
deleting a live child's files. Cleanup also refuses a replaced parent/root identity.

Process groups provide lifecycle control, not a security sandbox. A trusted native
program can access the user's files/network and can escape its group. CPU/RSS
confinement, escaped descendants, signed source verification, host service grants,
artifact output opening and adoption authority are not provided by this profile.

## Core execution adapter

An independently authorized `ApplicationInstance::ensure_ready(deadline,
cancellation)` completes the original activation handshake on its existing
owner thread without invoking a tool. A prepared dependency must be genuinely
Ready before its caller starts. The readiness deadline does not become the
shared instance's lifetime authorization after success. Failed startup retains
actual not-spawned, unconfirmed or reaped evidence from the original process
cleanup path; a returned error alone never proves drainage. WorkPlan calls still
need their own exact tool grant and original live application lease. Cancellation
keeps the existing policy of retiring the exact shared instance.

With `core-adapter`, `RunnerProxy` captures a package contribution and the trusted
installer's `CapturedRuntime` or approved `CapturedNativeRuntime`, selected by
`RunnerRuntime` and checked against the component runtime kind. Core's fixed
input retains the complete SDK `ExecutionEnvironmentDescriptor`
descriptor and derives its digest. `RunnerRuntime::environment()` exposes that
complete strict SDK value without granting execution. Registration and host
policy use the exact
provider/environment pair, so A/B environments for the same package coexist;
registration order does not choose between them. The adapter
checks that selection again before staging and sends only the selected item's
captured data through the SDK channel. Installer authentication and environment
pinning remain the installer's responsibility.

The trusted application must register the proxy, capture its `execution_binding`,
then explicitly authorize the input through `ExecutionRuntime::authorize_plugin`
with a stable grant ID, expiry and unsandboxed-execution consent. That per-attempt
grant is stored in the existing project ledger; its live permit can be revoked,
expires, and ends with its runtime generation or project session. Reopening reads
history without reactivating old grants. This first adapter refuses automation
leases and delegated child execution.

The adapter closes the actual child before returning a result. Core retains the
raw SDK payload, independently supplied channel, grant ID and checked JSON proposal.
A successful proposal requires a trusted `ResultValidator`, registered for its
operation, to become valid. The validator runs on captured values outside the
project thread and transaction. Missing validators leave proposals pending;
`capture_result_validation` / `prepare` / `commit_result_validation` supports later
explicit checking. Producer bytes cannot carry the private validation proof.
Checked results still require a separate explicit adoption action and trusted
handler; the existing transaction rechecks current scope, result, cancellation
and plugin authority. Existing committed receipts remain idempotently readable.

Plugin source extraction instead requires `capture_source_validation`, a separately
authorized execution of its fixed checker input, and `commit_source_validation`;
a generic result validator cannot replace those mandatory checks. New source
adoption rechecks the selected checker's exact live grant both before preparation
and inside the final transaction. Revoking or cancelling that checker blocks
adoption even after its semantic proof was saved. Previously adopted content and
committed receipt replay remain available without restoring execution authority.

The adapter clamps the fixed complete-result allowance to the Host's frame
ceiling, while raw payload limits remain attached to the captured declaration.
Core's ledger envelope has its own budget for original SDK bytes and the checked
JSON projection. Failed and unknown SDK outcomes preserve their raw error evidence without
claiming replay safety. A new process cannot authenticate an earlier instance's
outcome, so this adapter's outcome query remains unavailable. A failed launch does
not expose a Core-visible cleanup receipt; no result is accepted from that path.

Build the JavaScript Host as described in its README, then run the synthetic
Core integration with independently approved absolute artifact-tree paths:

```sh
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/path/to/tool-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/path/to/clean-host-tree \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/path/to/approved-descriptor.json \
cargo test -p tsumugi-plugin-host --features core-adapter,javascript-conformance --test core --locked
```

These tests use an isolated project and independent proposal expectations. They
do not prove a production plugin catalog, domain migration or desktop workflow.

## Real-process conformance

The `native_catalog` test consumes the independent public
[Rust JSON catalog example](https://github.com/Anpimi/tsumugi-plugins)
as an explicitly selected prebuilt package, with no domain-source dependency.
Prepare and inspect that package using its public recipe, review its source and
fingerprint, then run:

```sh
TSUMUGI_TEST_NATIVE_PACKAGE=/absolute/path/to/prebuilt-flat-json \
TSUMUGI_TEST_NATIVE_DIGEST='<independently-reviewed-package-digest>' \
cargo test -p tsumugi-plugin-host --features core-adapter --test native_catalog --locked -- --ignored --nocapture --test-threads=1
```

The tests install/reopen fixed package bytes in a temporary Store, independently
capture the actual Native Host, and execute extraction, source checking, QA,
building and artifact checking over real child channels. Literal Unicode/BOM
oracles and rehashed semantic forgeries are separate from the producer. Cancelled
or revoked children are reaped, with owned staging checked for cleanup. The Core
flow requires separate source proof, current QA, human approval and artifact
proof before adopting a frozen Release, then checks exact bytes and history on
reopen. The Host workspace's development dependency enables Core test fixtures.
To run the same three tests with normal Core features `[]`, use the isolated
consumer workspace, which registers the original test file without copying it:

```sh
TSUMUGI_TEST_NATIVE_PACKAGE=/absolute/path/to/prebuilt-flat-json \
TSUMUGI_TEST_NATIVE_DIGEST='<independently-reviewed-package-digest>' \
cargo test --manifest-path crates/plugin-host/compatibility/Cargo.toml --features core-adapter --test native_catalog --locked -- --ignored --nocapture --test-threads=1
```

With a prepared dependency cache, add `--offline`. All three selected tests must
execute; an empty or ignored-only result does not establish conformance. The
prebuilt package retains its own SDK archive provenance. Each test independently
observes and captures its actual Native Host executable; it does not use a Node
tool/JavaScript Host tree or a member-runtime artifact. That test Host identity
does not approve a different Desktop application executable. Installation does
not grant execution authority.

These tests use synthetic project data and establish neither Desktop Native
discovery/approval, Windows/Linux execution nor complete domain migration or
release acceptance. This pairing also does not establish the full cross-version
SDK, contract, Profile and data-schema compatibility matrix or behavioral
compatibility from matching version labels.

The isolated `sdk_artifact_pair` consumer additionally accepts two independently
built Rust catalog packages from different locked SDK archives: a retained
Process2 worker and a current Process3 worker. Review both public build recipes,
archive provenance and package inspection digests first. The packages must keep
the same manifest, plugin version, nominal SDK version and all declared domain
Resource bytes. Changing a descriptor label or repackaging the current worker
does not supply the historical artifact.

```sh
TSUMUGI_TEST_LEGACY_NATIVE_PACKAGE=/absolute/path/to/process2-flat-json \
TSUMUGI_TEST_LEGACY_NATIVE_DIGEST='<independently-reviewed-legacy-package-digest>' \
TSUMUGI_TEST_NATIVE_PACKAGE=/absolute/path/to/process3-flat-json \
TSUMUGI_TEST_NATIVE_DIGEST='<independently-reviewed-current-package-digest>' \
cargo test --manifest-path crates/plugin-host/compatibility/Cargo.toml --features core-adapter --test sdk_artifact_pair --locked -- --ignored --nocapture --test-threads=1
```

The single selected test must execute. It installs/reopens both exact packages,
captures its actual current Native Host, observes legacy launch refusal and an
empty owned staging parent, then executes current extraction over the same Host
and checks literal Unicode/BOM material and byte ranges. The historical worker
closes its stream on the current activation; the public Host reports `Crashed`,
which is not a protocol-specific diagnosis. Current cooperative close and direct
child reaping are checked separately. This bounded artifact pair adds no fallback,
SDK upgrade mechanism, Desktop approval or promise about other SDK versions.

The `translation_validation` test, with `core-adapter,javascript-conformance`,
uses an explicitly captured SMAPI package and the independently approved runtime
to adopt its actual source, then qualify a complete translation proposal in the
Core ledger. It checks existing project locale/current source/native scope,
separate producer/checker grants, mandatory proof, revocation before commit and
read-only reopening without renewed permission. The original material remains
fixed and native values are not normalized by Core. Checked complete proposals
project into one EX item/adoption unit per entry (one empty unit for zero entries).
The same test verifies complete-result gating, exact native matching, equal-text
sources with different keys, empty strings, unmatched retention, candidate-only,
select-if-empty, explicit replacement, stale selection conflict, checker revocation
between capture and commit, and original receipt replay after reopening. The
projection shares the existing revision/selection/receipt owner. Optional original
display evidence has nullable UTF-8 key coordinates; absence is never a fabricated
range. Desktop plugin import integration and complete domain cutover remain pending.

`PackageImage::translation_import` reads the SDK's translation Resource from
captured bytes and binds its exact extractor/checker selections. The SDK binding
checks single-file path/extension, role, raw bound and profile data without
executing domain code or approving filesystem access. See the
[public translation data contract](../plugin-sdk/docs/translation-import.md).
This metadata API does not complete translation matching/adoption or desktop
migration.

The `release_validation` test uses the same explicit SMAPI package/runtime
configuration and `core-adapter,javascript-conformance` features. It adopts checked
source, qualifies manual translations through the existing review policy, and
runs the captured builder and independent artifact checker for two languages.
It directly captures approved package bytes; package installation and enablement
are separate conformance requirements.
Missing either proof blocks release adoption. Literal Unicode and deliberately
empty source output, original receipts, frozen edits and reopening after grant
revocation are checked against the actual Core store. Empty source output uses
an explicit source-fallback decision. This does not verify plugin translation QA
or desktop interaction. Run it with:

```sh
cargo test -p tsumugi-plugin-host --features core-adapter,javascript-conformance --test release_validation --locked
```

The separate `source_maintenance` consumer uses the same explicit SMAPI package
and captured JavaScript runtime variables. It runs the public two-generation
maintenance fixture with normal Core features `[]`, rather than the Host
workspace's fixture-enabled Core. Source extraction, independent source checks,
manual translations, domain QA, building and artifact checking use the captured
package's real workers. Fixed comparison and lineage expectations distinguish
unchanged work, edited text, confirmed renames, rejected key reuse and unresolved
splits/merges. The test also checks retained original Release bytes after the
update and reopening. Run it explicitly with the reviewed artifact inputs:

```sh
cargo test --locked --offline \
  --manifest-path crates/plugin-host/compatibility/Cargo.toml \
  --features core-adapter,javascript-conformance \
  --test source_maintenance -- --ignored --nocapture --test-threads=1
```

This synthetic software journey does not establish native Desktop interaction,
the complete real-world maintenance corpus, other platforms or plugin upgrade
compatibility. It leaves the original two-consumer compatibility runner and its
report format unchanged.

The `official` pairing tests consume an explicitly selected prebuilt WebVTT
candidate from the independent
[official plugin repository](https://github.com/Anpimi/tsumugi-plugins). They install
and reopen approved bytes and use the actual captured JavaScript Host. The full
pairing covers extraction/source semantics followed by build/check. The isolated
`official_webvtt_generic_build_and_check_use_the_captured_package` test uses a
fixed public content oracle and executes only the builder and artifact checker.
It binds the package's SDK BuildDeclaration Resource, validates BuildInput and
actual ArtifactSet with the SDK, and compares required CheckResults to the fixed
rule/provider and real Host channel. Literal Unicode/BOM/CRLF bytes are independent
of the builder; stale target revisions and markup fail, while rehashed timing,
text and non-payload changes produce blocking semantic findings. All owned child
processes close/reap and their staging directories are checked for cleanup.

These tests do not link domain source or establish Core adoption, desktop
selection, execution permission for another attempt, or complete migration. The
fixed build-source fixture derives from the MIT-licensed independent package's
literal source-check oracle; no extractor output defines its expected semantics.

Provide reviewed package bytes/digest and the same independently approved runtime
trees described above; missing selections fail instead of skipping:

```sh
TSUMUGI_TEST_PLUGIN_PACKAGE=/absolute/path/to/prebuilt-webvtt \
TSUMUGI_TEST_PLUGIN_DIGEST='<independently-approved-package-digest>' \
TSUMUGI_TEST_RUNTIME_TOOL=/absolute/path/to/tool-tree \
TSUMUGI_TEST_RUNTIME_HOST=/absolute/path/to/clean-host-tree \
TSUMUGI_TEST_RUNTIME_APPROVAL=/absolute/path/to/approved-descriptor.json \
cargo test -p tsumugi-plugin-host --features javascript-conformance --test official --locked -- --test-threads=1
```

To run only the build/check pairing with those same explicit selections, filter
with `official_webvtt_generic_build_and_check_use_the_captured_package --exact`.
The two pairing tests are separate; a filtered run does not cover source checking.

The `smapi` pairing test selects a separately prepared SMAPI package using the
same explicit package/runtime variables, and installs/reopens its fixed bytes
through the shared Store harness:

```sh
cargo test -p tsumugi-plugin-host --features javascript-conformance --test smapi --locked -- --test-threads=1
```

It binds the captured source/translation/build Resource declarations and executes
six separate contributions through the real JavaScript Host. Independent literals
cover JSONC/BOM/UTF-8 quoted ranges, native key identity, distinct equal-text units
and canonical Unicode locale output. Duplicate native keys and stale revisions
return typed failures; structurally valid forged source text and rehashed output
text/formatting produce complete blocking check results bound to the fixed
package and actual channel. Owned children close/reap and staging is cleaned.
The separate translation pairing test retains the fixed source snapshot, explicit
target and original whole-file evidence, including a zero-entry object. Its
independent checker blocks forged values/native identities, missing entries and
changed order even when generic data association succeeds. These tests establish
package/process behavior; current-project matching, per-entry adoption and native
desktop confirmation still require their own application integration evidence.
These pairings do not prove current-project matching, per-entry adoption,
installed Mod compatibility or the complete desktop domain cutover. The shared
harness changes no runtime grants or package approvals for other attempts.

The `joint_review` test uses the same reviewed WebVTT package/runtime variables,
plus `TSUMUGI_TEST_KNOWLEDGE_PACKAGE` and `TSUMUGI_TEST_KNOWLEDGE_DIGEST` for the
public `examples/philosophy` package. Its multiple-provider case also requires
`TSUMUGI_TEST_SECOND_KNOWLEDGE_PACKAGE` and
`TSUMUGI_TEST_SECOND_KNOWLEDGE_DIGEST` for an independently inspected controlled
package with plugin ID `philosophy-alternative`.

Prepare the second fixture outside the source checkout from the public philosophy
example, retaining its public SDK helper selection and original domain engine:

1. Copy the example into an owned temporary example tree with the same relative
   SDK-cache layout. Prepare and verify that cache using the plugin repository's
   public `tooling/prepare-sdk.py` recipe.
2. Set the terminology Resource revision to `independent-editorial-2` and change
   only the `soundness` concept's Simplified Chinese preference from `可靠性` to
   `健全性`. Run the original `tooling/prepare.mjs` in that copy to regenerate
   Resource pins and declarations.
3. Set the generated manifest's plugin ID to `philosophy-alternative`. Align the
   expected own-package ID in `components/text-review.mjs` with that identity;
   retain all provider, version, component, contribution and Resource checks.
   Do not rerun the unmodified preparer after this identity change.
4. Materialize that copy using the public `tooling/package-plugin.py` recipe,
   inspect the resulting directory with `tsumugi-plugin-package inspect`, and
   supply the reviewed directory and exact digest through the second-package
   variables. The original package and its digest remain separate.

With those six package variables and the three runtime variables set, run:

```sh
cargo test -p tsumugi-plugin-host --features core-adapter,javascript-conformance --test joint_review --locked -- --test-threads=1
```

The tests execute actual query/check workers and ordinary Core QA over synthetic
project data. They retain mandatory format checks, conflicting advisory findings,
independent grants and origins, manual protection and exact history after reopen.
Explicit single-provider and independent-union selection are checked with both
registration orders; an unchosen ambiguous provider is refused. Automatic
selection uses a synthetic candidate through the original Core ledger, without a
model request. The fixture approval metadata is an explicit test decision, not
authenticated publisher provenance. An external Cargo consumer with normal Core
features `[]` can use this same test file to exclude legacy execution fixtures.
This does not establish rendered editor/batch/Agent workflows, behavior-version
upgrade compatibility or complete release acceptance.

The `version_compatibility` test uses the original reviewed philosophy package
as `TSUMUGI_TEST_PLUGIN_PACKAGE`/`TSUMUGI_TEST_PLUGIN_DIGEST`. Its source is also
reused by the original `knowledge` test's `version_compatibility` module.
Prepare four additional controlled copies in the same public example/SDK-cache
layout described above. Each retains the original plugin ID `philosophy`; set
its `package.json` version before running the original public preparer:

| Fixture variables | Controlled package version | Controlled change |
| --- | --- | --- |
| `TSUMUGI_TEST_BEHAVIOR_PACKAGE`/`TSUMUGI_TEST_BEHAVIOR_DIGEST` | `0.1.0-alpha.2` | Set only the query capability's `behaviorVersion` to 2. In the engine's **query** branch, use case-sensitive `row.text.includes(form)` instead of Unicode word-boundary occurrence; describe literal substring matching in that query's `basis.coverage`. Keep the check branch, query input/output schemas and Profile unchanged. |
| `TSUMUGI_TEST_PROFILE_PACKAGE`/`TSUMUGI_TEST_PROFILE_DIGEST` | `0.1.0-alpha.3` | Set `PROFILE.behaviorVersion` to 2, retaining the original capability/data identities and engine. |
| `TSUMUGI_TEST_SCHEMA_PACKAGE`/`TSUMUGI_TEST_SCHEMA_DIGEST` | `0.1.0-alpha.4` | Set `schemaVersion` to 2 on the query capability, its input/output schemas and `RESOURCE_SCHEMA`; retain behavior/Profile identities and original JSON field types and engine. |
| `TSUMUGI_TEST_DATA_PACKAGE`/`TSUMUGI_TEST_DATA_DIGEST` | `0.1.0-alpha.5` | Set only `RESOURCE_SCHEMA.schemaVersion` to 2. Keep the original query contract, Profile, input/output/error schemas, JSON field types, engine and exact terminology payload bytes. This isolates the Resource data-schema axis from the combined schema fixture. |

Make the declaration changes in the copy's `components/definition.mjs`; change
the query implementation only in the behavior fixture. Regenerate each copy's
manifest/tool/review Resources using `tooling/prepare.mjs`, materialize it with
the public package recipe and independently inspect its exact directory/digest.
These versions identify controlled conformance fixtures, not published releases.
With all five reviewed package/digest pairs and the approved
`TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST` and
`TSUMUGI_TEST_RUNTIME_APPROVAL` set, use the isolated consumer workspace:

```sh
cargo test --manifest-path crates/plugin-host/compatibility/Cargo.toml --features javascript-conformance --test version_compatibility --locked -- --nocapture --test-threads=1
```

With a prepared dependency cache, add `--offline`. All four selected tests must
execute; an empty, filtered-only or ignored-only result does not establish
conformance. This workspace uses normal Core and SDK features `[]`, with the
Host's `core-adapter`, and does not compile the unrelated WorkPlan fixtures in
the original `knowledge` test. It reuses the same public package installation,
runtime capture and real-worker helpers.

Actual installed/reopened package bytes and real query channels distinguish
`soundtrack` under the two behaviors despite identical payload field types.
Old and new versions coexist; explicit contract/Profile selection follows exact
identities in either registration order. Wrong contract, Profile or input/output
data versions are refused on the original channel before dispatch, after which
an exact request still succeeds. Resource schema versions are also exact. The
data-only fixture refuses the old Resource schema and exposes unchanged literal
bytes through schema 2. Both query declarations remain compatible, so an
unselected single-provider resolution is ambiguous in either registration order;
an explicit exact provider selects the requested package and digest. Its real
query output retains the original literal entries, resource pin, input digest,
coverage and Unicode word-boundary behavior. Resource reads and declaration
selection provide no execution permission.
SDK identity and process protocol are checked separately on the actual captured
runtime descriptor: the current Process3 descriptor is retained, while a
structurally valid unsupported SDK label or retained process-1 identity is
diagnosed and refused before directory capture, without a package-version
fallback. Changing the descriptor's SDK label does not upgrade or execute an SDK
artifact.
This proves the current bounded selection/dispatch policy, not execution of an
arbitrary future SDK artifact, automatic project environment adoption or a
permanent promise to freeze all future contracts.

The `knowledge_generation` test uses a freshly prepared Philosophy package with
the independent [Generation service client](https://github.com/Anpimi/tsumugi-plugins/blob/main/examples/philosophy/README.md#generation-service-client).
Set `TSUMUGI_TEST_GENERATION_PACKAGE` and `TSUMUGI_TEST_GENERATION_DIGEST` to that
reviewed prebuilt directory and its Host inspection digest, alongside the same
`TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST` and
`TSUMUGI_TEST_RUNTIME_APPROVAL` used above. It runs real query/check workers and
refuses the required-service component before staging when no broker exists.
The query instance remains usable and static Resources/Skills remain readable.
It makes no model request and does not prove application generation authority.

```sh
cargo test -p tsumugi-plugin-host --features javascript-conformance --test knowledge_generation --locked -- --test-threads=1
```

```sh
cargo test -p tsumugi-plugin-host --features conformance-worker --locked
```

The explicit feature builds a separate synthetic worker executable consuming only
the public SDK. Tests stage its actual binary bytes and launch independent
processes with synthetic input, including incorrect identities, malformed and
oversized frames, blocked input, crashes, duplicate output, authority revocation,
uncooperative exit and A/B instance cleanup. They do not invoke a paid model or
open a developer project. The worker is a conformance peer, not a production
domain implementation or evidence of an accepted desktop plugin flow.

The Native Application tests use a distinct SDK-client fixture with actual child
PID and invocation-count observations. Build it explicitly, then supply the
absolute example path from your Cargo target directory for this test command:

```sh
cargo build --locked -p tsumugi-plugin-host --features native-application-conformance --example native-application-worker
TSUMUGI_NATIVE_SDK_WORKER=/absolute/path/to/debug/examples/native-application-worker cargo test --locked -p tsumugi-plugin-host --features core-adapter --test native_application -- --ignored --test-threads=1
```

The tests create synthetic projects and a unique temporary observation file for
mid-invocation cancellation. Keep the worker path local to this command; other
Native SDK tests retain their original echo-worker fixture.

## Desktop Native environment integration

Desktop source, build, translation and adopted Review resolution use the same
installed catalog, revisioned settings and `RunnerRuntime` owner. All providers
selected by a declaration must share the approved environment's executable
runtime family. Native resolution rechecks the independently approved exact
current application Host; it never installs or borrows a Node tree. Node
resolution retains complete approved installed-byte and origin checks.
Read-only environment inspection starts no worker and grants no attempt.
The desktop controls display approved current Native Host choices and sealed
approved Node choices for the selected package's runtime types; the backend
resolves and checks the exact declaration providers before execution.

The desktop's ignored `actual_native_desktop_source_translation_review_and_build_use_independent_grants_and_proofs`
test accepts an explicit independently built macOS arm64 `examples/flat-json`
package through `TSUMUGI_TEST_NATIVE_PACKAGE` and its independent expected digest
through `TSUMUGI_TEST_NATIVE_DIGEST`. It uses production registered IPC with a mock
window and a synthetic picker selection. Actual Native worker processes, source
capture/check/adoption, complete translation extraction/check/projection/adoption,
QA, build/artifact proof,
release adoption and project reopen remain real. The fixture verifies Host
revocation, independent grants, unmatched and empty translations, the complete
Core/domain rule union, Core release refusal for an empty selection, manual
correction and retained translation history, and exact output bytes without an
installed Node runtime. It is an IPC/process test, not a native GUI observation.
No model call, network request or user project is part of that fixture.

## Manual offline Packs

The application can review [bounded offline Pack directories](../../docs/offline-packs.md)
through the same immutable capture, Catalog and PackageStore owners. Each selected
member needs its own explicit approval; a Pack supplies no authenticated origin,
execution grant or shared trust. New packages start disabled. Settings promotion
preflights the complete installed receipt set and retained uninstall origins,
so a deterministic identity/source/publisher conflict is rejected before saving
new approvals. Removing an approval or installation does not silently change a
logical package's retained origin. Same-origin version coexistence and original
installation-action recovery remain separate from source migration.

## Signed offline repositories

[Offline repository catalogs](../../docs/offline-repositories.md) are captured
without executing code or enrolling trust. Explicit root enrollment and refresh
use the pinned upstream TUF verifier with a narrow, documented metadata-storage
adapter. The existing PackageStore owns durable trust actions, frozen inputs,
root/role/time progress and exact original-action recovery; a read projection or
installation receipt cannot create a verified repository witness. Failed later
metadata cannot discard previously verified progress. Only a verified exact
member can supply its repository origin to a separate package decision.

Attempt JavaScript generation components may explicitly opt into the existing
component-input wrapper and declared read-only prepared query services. Every
facade is bound to the caller's exact dispatch scope; callee grants and execution
scopes remain independent. The legacy Attempt generation input retains its
Core-generation-only service boundary. Missing declared providers and mismatched
scope or permissions are rejected before activation.
