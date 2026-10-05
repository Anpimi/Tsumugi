# Experimental process Host

`tsumugi-plugin-host` launches captured plugin artifacts through the standalone
SDK process protocol. Its default feature set depends on the SDK without Core;
the optional `core-adapter` feature implements Core's trusted execution port.
It has no domain runner or model dependency. Desktop source/build commands use
exact approved installed packages and runtimes; default domain-package distribution
and the complete extension lifecycle remain under development.

The implemented profile is one serialized capability on a project-scoped native
worker or JavaScript component. The Unix launcher creates an owned process group;
this profile is tested on macOS. Windows is refused until an owned Job Object implementation is verified.
The JavaScript launcher requires a `CapturedRuntime` containing the independently
approved Node tool and complete [built component Host](../../runtimes/javascript-host/README.md) trees. That Host
owns the process protocol and privately uses Cordis behind the SDK facade. The
plugin entrypoint exports a component; it is not launched as a protocol peer.
The local installation store can retain and reopen the approved runtime trees.
Trusted runtime acquisition and desktop distribution remain separate work.

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
files to 256, total manifest/file bytes to 64 MiB, directories to 256, package
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

## Fixed runtime environment

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
conformance profile does not provide this Node-specific Core environment binding.

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
tree limits. An interrupted promoted object is listed as `RecoveryRequired` and
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
non-nil UUID action. It writes captured bytes into a private candidate, synchronizes
files and nested directories, then promotes the whole object exclusively under
its actual package digest. The private outer directory stays writable for the
rename and is sealed after the promoted identity and bytes are rechecked;
package files and descendants are already read-only. The object and required parent directories must be
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

### Reopening an approved runtime

`PackageStore::install_runtime` retains a `CapturedRuntime` under its SDK-derived
environment digest. Its independent `RuntimeApproval` contains the complete SDK
descriptor and trusted source/publisher origin. This uses the same store lock,
descriptor-relative IO, exclusive promotion and original-action recovery as
package installation. Runtime files and their receipt are read-only; the store
keeps distinct environments without replacing an installed one.
Unselected runtimes participate only in bounded receipt, read-only metadata and
descriptor-identity checks for conflicting actions. This does not approve their
execution bytes. The target runtime is fully recaptured before and after promotion
and during original-action recovery; loading always recaptures the selected trees.

After closing and reopening the store, `load_runtime` requires that independent
approval again and recaptures both complete trees, including executable flags.
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
are refused; other component scopes are refused. The handshake must echo the
captured capability and provider binding exactly. It cannot upgrade declarations,
effects, versions, limits or permission requests.

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

With `core-adapter`, `RunnerProxy` captures a package contribution and the trusted
installer's `CapturedRuntime`. Core's fixed input retains the complete SDK
descriptor and derives its digest. Registration and host policy use the exact
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

`PackageImage::translation_import` reads the SDK's translation Resource from
captured bytes and binds its exact extractor/checker selections. The SDK binding
checks single-file path/extension, role, raw bound and profile data without
executing domain code or approving filesystem access. See the
[public translation data contract](../plugin-sdk/docs/translation-import.md).
This metadata API does not complete translation matching/adoption or desktop
migration.

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
