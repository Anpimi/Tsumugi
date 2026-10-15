# Changelog

This is the authoritative English changelog. [简体中文](CHANGELOG.zh-CN.md) mirrors the same changes.

Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Application versions follow the project's [versioning policy](docs/versioning.md).

## [Unreleased]

- Returning from a failed source preparation to current content clears the old
  failure while keeping unrelated preparation text. Explicit discard reports
  its own cancellation failure. Source comparison labels also cover changed
  interpretation, including source descriptions with unchanged original text.

- Failed source extraction and source checks retain the plugin's bounded reason
  in local technical details in both the source workbench and task results.
  The Host validates the original error contract and captured input association;
  reading the reason does not authorize a retry, adoption or model sharing.

- TMX and TBX file previews remain visible after returning from the native file
  chooser or refocusing an unchanged project. Actual source, resource or session
  changes still clear the report and require an explicit new selection.

- Resource updates can preview explicitly selected UTF-8 plain-text TMX 1.4
  files and a recognized TBX-Basic DCA subset against the project languages.
  Separate local pages show complete mapped text, all selected-language term
  candidates, excluded rows, unverified provenance and classified mapping losses
  with bounded location samples. Ambiguous terminology is never chosen
  automatically; ignored schema hints do not run standard validation. Content
  license remains unknown. Previewing saves or adopts nothing and grants no
  model sharing; unsupported structure and exceeded limits are reported explicitly.

- The translation editor can read source observations from its References panel.
  Separate on-demand pages retain complete blocks, fact origins, inference
  rationale, neighboring text and local source references. Unknown and empty
  observations remain distinct. Source changes hide these references while
  preserving an older draft; a local read failure can be retried without
  blocking manual editing. Reading does not share data with a model.

- AI and Arena preparations can separately share extracted source facts,
  inferred facts and neighboring text, all off by default. Previews retain whole
  selected entries, their original evidence and bounded omission counts. Each
  variant captures its own selection and budget; edits require a new preview and
  confirmation. Provider requests contain only selected semantic text, fact
  origins and inference rationale, excluding source coordinates and provenance
  identifiers. Accepted requests retain their original capture during recovery.
- These required selection and capture fields advance the current-only project
  format to schema 36. Preserve older development directories and reimport their
  sources into a new project; no conversion or reset is performed.

- AI and Arena previews read source evidence and opted-in resources from one
  SQLite snapshot. Each preparation verifies the original source result,
  semantic proof and project mappings once for all units and variants; changed
  evidence is refused before any preview is returned. Variants keep independent
  terminology, manual-context and source-context sharing choices.

- Source execution retains the original SDK content once, with a checked
  schema/digest projection instead of duplicating the parsed proposal. Bounded
  quoted content above 2 MiB can complete checking, adoption and reopening within
  the existing 8 MiB result ledger; source identity and semantic proof are still
  verified from the exact original bytes. The stored representation advances
  the current-only project format to schema 35. Preserve older development
  directories and reimport their sources into a new project; no conversion or
  reset is performed.

- SDK content exchanges allow up to 4,000 domain blocks and 4 MiB encoded content,
  so separate identity and context extensions can cover the existing 2,000-item
  scope. Other content counts,
  2 MiB material/artifact limits and the 4 MiB combined invocation budget remain
  unchanged; process framing and permissions do not expand.

- Core exposes a read-only source-context observation for an exact current
  project, snapshot, unit, source revision and target locale. It retains domain
  fact origins, unsupported/empty block distinctions and immediate neighbors
  with their original occurrence and revision evidence. Reads verify the stored
  source result, semantic proof and project mappings in one SQLite snapshot.
  Manual context remains separate from source-fact sharing.

- The experimental SDK defines bounded source-context facts with explicit
  extracted or inferred origin and references to captured source ranges.
  The existing content receiver checks supported blocks without rewriting their
  bytes or interpreting unknown domains. Rust and generated JavaScript contracts
  share limits; these data helpers grant no sharing or execution authority.
  Domain collection and the desktop context workflow still require integration.

- AI and Arena preparations can choose named saved connections and open their
  application settings without losing the preparation. Choosing defaults keeps
  scope, sharing and budgets; editing a copied default makes it a one-time
  connection. Budget and sharing summaries stay visible while advanced fields
  are folded. Arena shows one shared round budget with separate per-request
  limits. Closing settings returns keyboard focus to its preparation opener. An unchanged current read keeps consent; changed selected defaults
  require a new preview and confirmation. Accepted authorization retains its
  captured request and deadline, and manual plans ignore unused model defaults.
- Work-plan acknowledgement checks compare complete serialized configuration,
  including all four captured profile-reference fields, so a correct saved
  connection is accepted and a transplanted reference is refused.

- Captured AI configuration can retain a non-secret saved-connection identity.
  Fresh previews and first authorization check the current profile and exact
  defaults; edits or archival invalidate that preparation. Accepted requests,
  original receipts and deadlines keep their captured configuration. Profile
  identities do not enter provider payloads.
- The schema 34 development boundary introduced captured connection
  provenance. Earlier development directories are refused without conversion
  or reset; retain them and reimport sources into a new project.

- Connection settings save, archive and restore named non-secret defaults.
  Closing the panel or changing projects keeps the draft and original save;
  a late acknowledgement preserves newer edits. Unknown saves can be checked
  from the same panel, while stale records require an explicit review.
  Window exit checks pending saves and current draft decisions before closing.

- Desktop exposes typed connection-profile reads and exact save/archive/restore
  operations, with original-action lookup and current-reference resolution.
  Core supplies the read basis and profile references from one snapshot; clients
  validate acknowledgements without rebuilding hashes or reading credentials.

- Core provides a separate application store for named, non-secret model
  connection defaults. Atomic changes retain their original receipts, detect
  stale writes and preserve archived profiles. Saved defaults carry no model
  permission and do not change captured request budgets or sharing settings.

- The content editor shows saved project translation-memory suggestions beside
  terms, context and revision history. Read-only comparisons retain the editable
  draft, distinguish AI/import/manual origins and check the current source basis.
  A reference does not grant approval or run a model; failed reads can be retried
  inside the sidebar.


The combined development build opens project schema 36 only. Earlier Unreleased
entries retain intermediate format boundaries from this undistributed batch;
they do not define alternate current project formats.

- Content range selection captures every match across pages, including its
  original bases and explicit exclusions. Later searches keep that fixed set;
  replacing it requires confirmation. Selected entries can be transferred to
  AI preparation without running a model or restoring preview, consent or
  execution authority. Original plans, model settings and budgets are retained.

- Translation navigation and Save and next remain available after a routine
  focus check returns the same confirmed list. Actual source, translation,
  resource or review changes, changed list data and replaced Query records still
  require a fresh explicit read; unfinished drafts remain intact.
  Explicit list reads confirm current project changes before recording their
  navigation basis, so a delayed save notification cannot disable the next entry.
  Save and recovery actions stay at the editor panel's bottom while content and
  references scroll independently, including the compact layout.
  Expanded references share the compact panel's available height while keeping
  the editor as its main region. Opening an entry brings the focused draft into view.

- The experimental standalone SDK defines bounded work-plan generation-service
  input, child-identity receipts and finite errors at schema/behavior 1/1, with
  Rust receivers and generated JavaScript contracts. Configuration, model
  destinations, consent and cumulative budgets remain application-owned; a
  valid payload supplies no execution authority. The SDK also constructs declared
  text-query payloads from exact text and explicit options, retaining fixed
  template fields and checking complete encoded input limits. Process protocol 2
  and the undistributed SDK alpha.1 version remain unchanged.

- Tasks now shows saved plugin build plans and every artifact's allowed path,
  role, byte count and SHA-256, with the original plan's target count. An exact
  read-only route opens the same build in Build and export without replacing an
  unfinished mapping, preparation, consent or pending action. Historical reads
  verify the original immutable plan and results without requiring an installed
  builder or restoring execution approval. Unsupported generic semantic checks
  are no longer offered for plugin output; fresh execution still requires its
  separately prepared input and explicit approval.

- Experimental desktop IPC can independently withdraw approval and remove one
  exact installation. Accepted continuations retain the original request after
  a lost waiter, stop dependent work before removal, and keep project switching
  fenced through Store confirmation. Original removal receipts are reconciled
  before stopping a target, so an old completed request cannot remove or stop a
  reinstall. Inventory exposes the original installation action and retained
  removal observations; these observations alone do not confirm durability.
  Frontend acknowledgements check the complete original identity and action.
  The extension panel provides separate reviewed approval revocation, exact
  installation removal and original-operation recovery in English and Chinese.
  Busy continuations preserve their original request and recovery guidance;
  closing or refreshing the panel does not replace it. Native acceptance remains
  under development. A failed installation keeps its original recovery request
  once approval is saved; a known settings rejection before that confirmation
  permits reviewing current state without leaving an unusable pending action.

- Desktop execution retains package ownership through accepted capture and
  preparation IO, so stopping a package prevents late results from publishing
  even after its IPC waiter disappears. Internal package cleanup retires only
  dependent work and query threads, retains its session fence through the
  installation handoff, and preserves independent packages and saved data.
  Invalid checker consent is refused before it can retain a Review action and
  block its original valid request; uncertain committed grants stay recoverable.
  Full native lifecycle acceptance remains under development.

- The experimental Core runtime can stop one exact package across its registered
  environments without rotating unrelated packages' execution authority. Original
  grants and cancellation requests stay revoked across retries; completion waits
  for its owned workers and active queries. Captured query callbacks remain closed,
  and a completed old control cannot unregister an explicitly reinstalled package.
  Full native lifecycle acceptance remains under development.

- Execution shutdown waits for owned producer and outcome-query threads to exit,
  including threads retired after cancellation or timeout. Revoked result
  delivery no longer permits early runtime rotation, project closure or directory
  rename while the original runner is still held. New work stays blocked while
  quiescing; uncooperative threads require application restart.

- The experimental Host Store can explicitly remove one exact sealed package
  after its local approval has been removed. Disabled approval is still retained
  and blocks removal. A durable original-action journal keeps immutable recovery
  bytes outside active inventory and loading; retries preserve uncertain outcomes
  and cannot remove a later reinstall. Other packages, runtime installations,
  settings and project data remain separate. Callers must first stop and drain
  the original execution instances. Desktop removal controls and cache collection
  remain under development.
- Tasks retain the complete original cancellation request when its outcome cannot
  be confirmed. Explicit retry uses the same request identity; a missing, malformed
  or zero revision cannot clear recovery. Deferred recovery preserves the request
  and blocks project closure until its result is confirmed.

- The AI workbench can explicitly add, configure and remove multiple reference
  providers. Each keeps its own target, options and captured source while all
  providers share the plan's total tool allowance. Duplicate or unavailable
  choices require correction before preparation; refreshing preserves inputs.

- The AI workbench can choose an installed generation component, explicit profile
  and approved JavaScript environment for a subset of the original plan. Users
  review fixed material, permissions and shared budget before separate local
  execution consent. Waiting and unknown actions check original task records;
  known-rejection retries keep the original grant and expiry. Recorded children
  open the existing progress, candidate and recovery view. Changed authority
  prevents stale starts, and confirmed discard or closing a settled review
  preserves saved records. Native and wider product acceptance remain in development.
  Repeating an uncertain discard confirms absence without cancelling started work.

- Experimental Desktop generation-component commands prepare a fixed source subset
  and require a separate ordinary component execution grant. A cached runner captures
  its original WorkPlan scope for each real dispatch; actual Host calls enqueue AI
  children through the existing ledger, ancestor budget and candidate owner. Original
  consent, settings revocation and deadlines survive the short acknowledgement.
  Unknown outcomes reconcile without renewal; each child retains its association
  until execution and authorized effects settle. An unreadable enqueue acknowledgement
  remains unknown, and terminal release preserves the completed effect view.
  Canonical generation results reserve frame metadata separately from the unchanged
  payload limit; Core also verifies that captured payload limit for success,
  failure and unknown outcomes. Full workbench/native acceptance remains in development.

- Desktop can read an installed generation component's exact provider, explicit
  profile, approved environment and provenance without running it or granting
  execution. Incompatible service dependencies, effects and SDK data contracts
  are refused. This selection does not authorize a WorkPlan or complete the
  workbench/native product acceptance.

- SDK work-plan generation now has public bounded input, child acknowledgement
  and finite error contracts. Core requires their exact schema/behavior 1/1
  references and the original External effect, using the same SDK parser.
  Requests cannot override model, sharing, effects or budget; acknowledgements
  expose no grant or renewal handle. Earlier experimental bindings must use
  the current contracts. Full workbench/native product acceptance remains
  separate work.

- Experimental Core project-service generation retains actual component and
  service provenance with the original WorkPlan scope, grant, deadline and
  ancestor budget. Durable call receipts reconcile without resubmitting or
  renewing authority. HTTP dispatch and candidate adoption recheck the original
  caller; IO waits share its remaining deadline. Current project schema is 31;
  earlier development projects are refused unchanged. Matching Process-2
  SDK/Host and production Desktop integration are required.

- Installed-settings changes withdraw the original service revocation signal
  before writing, including failed or uncertain writes. Closing the installation
  owner revokes it without waiting for Store operations. Fresh captures reread
  actual settings; they cannot revive previous grants or deadlines. Core retains
  the signal after component completion and checks it before child HTTP sends.

- Work plans retain reference tools and the complete required/advisory checker
  set together. Their independent consents share one installed-settings guard;
  historical acknowledgements do not restore missing consent. Agent generation
  starts reject changed settings before child enqueue, and candidate-only plans
  continue saving explicitly authorized candidates.

- Work plans can capture read-only reference tools with exact installed package,
  runtime and query options, and one shared invocation limit. Independent local
  execution consent lasts at most ten minutes; recovering the same action cannot
  renew it. Bounded Agent controls query captured source subsets through the
  original worker and ledger, show escaped unapplied references, and generate
  further candidates through the original model service. Pause, source changes,
  expiry and reopen preserve history without restoring authority. Current
  development projects use schema 31 and WorkPlan format 2; earlier development
  formats are refused unchanged without migration. Full autonomous orchestration
  and native product acceptance remain in development.

- Scoped Agent generation can prepare captured source subsets and run them
  through the original work-plan runtime, candidate service and ancestor budget.
  Model, destination, sharing and effects stay fixed; pause, takeover, expiry and
  project closure revoke the scope. Human controls and plugin execution consent
  remain separate. Complete autonomous tool integration is still in development.
  Candidate-only plans now honor explicitly authorized candidate saving and
  report completion without running checks, selecting a translation or approval.

- Experimental Core Host adapters now select project-service brokers separately
  for every actual dispatch and grant, including when a capability proxy is
  cached. Unfinished selection is bounded; selection failure does not launch a
  component with omitted services. Selection, invocation and result delivery
  retain the original Core dispatch deadline independently of later runtime ticks.

- Experimental SDK and Host add bounded project-service calls for JavaScript
  components. Exact selected providers, scopes, schemas, effects and original
  invocation contexts remain fixed; cancellation, revocation and the original
  deadline cover service callbacks. Missing required services are refused before
  process launch. Process protocol advances to 2; consumers must regenerate
  contracts and rebuild/capture the Host. Earlier process-1 runtimes are refused
  without fallback or development-data migration, including captured runtime
  descriptions retained in earlier development project/settings/receipt records.
  Use a fresh development profile and project. AI execution and durable child
  authority remain separate application integration. The basic native component
  helper refuses service tables it cannot consume.


- Provider child tasks cannot add, remove or change their parent's captured
  input dependencies. Exact dependency identities and expected revisions remain
  fixed while children share the original ancestor budgets.

- Experimental SDK and Host consumers can bind read-only tool Resources to an
  original captured capability, exact profile and same-package Resource/Skill
  support. Generated JavaScript contracts share the Rust definition; inspection
  refuses writable effects, extra permissions and executable support. Tool
  guidance grants no authority. Desktop commands prepare fixed single or batch
  query inputs and use the existing execution ledger with explicit per-attempt
  consent, exact installed settings/runtime rechecks and original-start
  reconciliation. Tools can also declare bounded text-query presentation,
  explicit target/category choices and reference-result columns. The public
  JavaScript helper preserves the captured input template for single and batch
  consumers and distinguishes empty matches from malformed results. Read-only
  results remain unadopted. Resource workbench reference queries now offer
  explicit package/target/meaning choices, separate text entries for batches,
  input protection during capture, execution consent and original-action
  reconciliation. Results use the original ledger and show escaped references,
  empty matches or result errors, with draft/leave/cancellation protection.
  Editors can add source or explicitly selected draft text to the same query
  inputs while retaining unsaved edits and existing rows. Routing grants no
  execution and invalidates earlier query consent; composition and unknown
  actions are protected. Bounded work-plan integration uses separate explicit
  scope and consent; full autonomous orchestration and native acceptance remain
  in development.

- Experimental Host consumers can read explicitly selected opaque Resources and
  Skills from immutable captured packages, with exact resource schema/behavior
  matching and executable-content rejection. Reading guidance grants no tools,
  execution permission or project adoption.

- Experimental environment decisions now retain complete Node and Native application Host descriptions in one revisioned local snapshot. Native decisions do not install runtime trees or grant execution permission. Current development settings use format 2; earlier settings are refused unchanged without migration. The extension inventory distinguishes recorded Native approval from missing Node installations. The Extensions panel observes the actual current application Host and saves or revokes its exact approval through the existing revisioned settings action. Stale application approvals remain removable. Source, build and translation choices resolve the exact approved current Native Host or sealed approved Node environment, match executable component runtime families and retain separate per-attempt consent.

Development target: **0.2.0-alpha.1**.

This initial backfill summarizes development commits `e76ef39` through `7febd7e` (2026-09-17 through 2026-10-02), which used `0.1.0` as their development version. No historical release tags exist, so these changes form one unreleased batch without invented release versions or dates.

### Added

- Experimental joint QA captures mandatory source-format rules and explicitly
  selected advisory text rules in one fixed check set. Independent checker
  inputs and permissions retain original ledger provenance. Current QA and
  checked selection distinguish required coverage from advisory findings and
  invocation failures; history preserves typed rules and text diagnostics.
  Desktop previews and WorkPlans require consent for each selected checker.
  The current project format is schema 33; earlier development directories are
  refused unchanged without migration. Knowledge Resources remain unadopted.

- Experimental SDK advisory text checks now declare explicit rule subsets and
  exact resource pins independently of file formats, with typed Unicode finding
  locations. Host metadata validates the actual package and resource bytes;
  components receive the immutable actual provider. These helpers grant no
  resource adoption or project QA qualification.

- macOS Apple silicon builds now enable the upstream SHA-256 hardware backend
  for Core and its linked SDK/Host consumers. Complete input and result digest
  checks keep the same algorithm and exact byte identities.

- Exact execution inputs now share immutable byte chunks in the original SQLite
  ledger. QA retains complete source material and independent per-item evidence;
  reads reconstruct and validate original bytes in their existing snapshot.
  The current project format advances to schema 28; earlier development
  directories are refused unchanged without migration.

- Execution envelope depth checks now traverse borrowed fields directly, avoiding
  a duplicate JSON payload tree during QA and ledger restoration. The same depth
  limit, exact stored bytes, digest checks and result associations remain required.

- The experimental Host/Core adapter now runs captured Native Worker packages with an independently approved identity of the actual application Host, exact live consent and original channel evidence. Core stores the strict Native or Node environment in the existing ledger and reopens historical results without restoring execution grants. Native environments carry no artificial Node artifacts; desktop discovery and approval use the current application Host; desktop capability selection resolves the same strict SDK environment union and refuses mixed or mismatched provider runtime families. The experimental Rust environment port now uses `ExecutionEnvironmentDescriptor`, and current project schema 27 refuses earlier development directories unchanged, without migration.

- The experimental public SDK offers an optional Rust native component entry point that owns strict framing, exact request/result identity, cooperative cancellation and cleanup. Authors return opaque capability output through the existing protocol; captured package/channel authorization and complete Native/Core environment binding remain Host responsibilities.

- Source workbench messages now describe native content identities and installed capabilities. Plugin-specific errors and source diagnostics remain opaque in technical details instead of triggering fixed SMAPI or WebVTT advice; shared command details preserve the original reason or field.

- Repeated source proof reads now reuse one bounded immutable qualification after comparing all four complete stored frames, their row associations and the current proof link. Project opening reuses each just-restored attempt input for its item validation instead of decoding it twice. Live execution permission and currentness remain separate checks; stored formats are unchanged.

- QA current-view reads now validate and release one original ledger input/result frame at a time in the same SQLite snapshot, avoiding retention of every complete plugin input. Release qualification now batches all requested units and locales inside one read snapshot. Original byte digests, associations, captured coverage and currentness remain mandatory; stored fields and the project format are unchanged.

- Normal Core now uses the adopted policy/plugin union for QA reads and release qualification; domain marker/format parsing and synchronous four-rule checks are confined to explicit test-host fixtures. Saved checks without actual ledger evidence are refused on current/history reads and reopen, while validated historical receipts remain readable after grant expiry. Experimental synchronous Core check APIs are now test-host-only; normal consumers use prepared actual execution and evidence adoption. Project schema and the undistributed application/SDK versions are unchanged.

- AI checked selection now resolves its checker and approved runtime from the original WorkPlan source snapshot, separately confirms local execution, and runs fixed per-input grants through the existing runtime. Actual ledger evidence computes the Core/plugin QA union outside the command queue before the original selection/QA transaction. Changed checkers refuse old plans, uncertain retries retain their original identities and expiry, and pause, takeover or project stop prevent late selection while preserving candidates and prior QA. Historical receipts reopen without restoring local permission. The experimental WorkPlan IPC requires the current checker metadata and explicit local-consent field. Complete native workflows and large-scope acceptance remain pending.

- Desktop Review now prepares the exact adopted checker and approved runtime for explicit local execution consent, runs it through the existing execution ledger, and computes/adopts the complete Core/plugin QA union outside the command queue and inside the original short commit boundary. Cancellation and project stop prevent late QA writes; accepted work survives a lost reply, and original saved checks remain readable without renewed permission. The experimental Review IPC requires preparation and a fixed per-attempt grant. Native interaction acceptance remains pending.

- Core automatic selection now checks saved candidates with the exact adopted Core/plugin policy union. Clean actual evidence selects the candidate and saves current QA in one transaction; missing checks or findings retain the candidate without selection. Receipts preserve the original QA and remain readable after grants expire. The current-only project format advances to schema 26; earlier development formats are refused unchanged. Review and automation displays identify opaque plugin rules instead of labelling them as terminology. Complete native checker interaction acceptance remains in development.

- Core can capture a read-only Review plan from the adopted source and current selection, preserving complete original evidence, exact local identity mappings, resource dependencies, checker/runtime selection and the policy/domain required-check union. Core choice and terminology computation shares its existing validator and runs over owned values outside SQLite. A prepared action projects that plan into the ordinary authorized runtime, and Core receives only its live, current, correctly associated ledger result before computing the complete Core/domain union outside SQLite. Empty, omitted, misbound or forged coverage stays incomplete or is rejected. Capture and computation create no QA receipt or release qualification; owned actual evidence can now be adopted atomically after live authority, current dependencies and concurrent-check rechecks. Current reads and eligibility evaluate the exact saved Core/domain union; missing coverage blocks qualification, and historical receipts survive grant expiry. This advances the current-only project format to schema 25 without migrating earlier development directories. Native checker and release interaction acceptance remain in development.

- Source declarations now require an exact immutable Review Resource and capture its complete domain rules, checker and runtime with the adopted source. Missing or substituted bindings refuse source adoption; reading stored bindings grants no execution or approval. This breaks the experimental source-declaration API (schema/behavior 2/2) and advances current projects to schema 24; earlier development directories are refused unchanged, without migration. Core Review execution and qualification integration remain in development.

- Experimental SDK review contracts now capture complete original source evidence, an explicit selected-text scope and exact mandatory domain rules, with missing text distinguished from empty text. Host inspection binds a captured review Resource to its exact package/checker. Generated JavaScript structure and Rust receiving checks share the same definitions; results reuse the existing Core/domain coverage union. These APIs do not run checkers or grant approval, waivers or release eligibility. Production Review integration remains in development.

- The translation workbench selects installed declared capabilities and an approved runtime, confirms the file's target language, and captures immutable bytes against the current adopted source and exact native matching scope. Extraction and independent checks require separate consent before checked per-entry previews reach the existing adoption workflow. Preparation survives view changes; uncertain operations retain their original requests, grants and proof identities. Missing capabilities preserve editing, and rejected checks cannot open a preview. Full native interaction acceptance and domain cutover remain pending.

- Read-only desktop translation environment resolution now returns the selected material recipe, exact extractor/checker bindings and independently approved installed runtime. Native selected-directory capture follows the declaration with complete bounded UTF-8 bytes, preserving BOM and original evidence through the existing Windows/macOS path, identity and double-read checks. Preparation grants no execution permission; the plugin translation workbench remains under development.

- Experimental Core translation extraction now checks the current source set, snapshot, native scope and existing project language before recording a captured plugin attempt. Complete proposals require separately authorized domain checks through the existing durable proof owner; generic validators cannot approve them, and reopening verifies saved evidence without restoring permission. Checked complete proposals now project into per-entry EX items and adoption units through the existing ledger. Matching compares exact namespace/policy/value identities, and the existing candidate/selection/receipt owner rechecks current proof and both execution grants. Original display ranges may be absent; complete translation results retain the original SDK bytes once, and fixed checker inputs share their captured material while reconstructing the unchanged SDK contract. The existing 1 MiB input and 2 MiB result bounds remain enforced. Repeated execution and adoption reuse bounded verified decoding while checking complete saved bytes, current coverage, associations and live authority; original receipts remain idempotent after reopening. Desktop plugin import integration remains under development.

- Experimental SDK existing-translation contracts retain complete captured material, explicit target-language evidence and original native identity references, with separately required domain checks. The Host binds their immutable single-file Resource metadata without executing code; project matching, adoption and desktop integration remain under development.

- Extensions can review and set up a fixed application-bundled package set and its runtime in one local operation. Prepared bytes must match source-owned provenance and digest pins. New included packages are enabled, existing enable/disable choices are preserved, and uncertain or partial installation retains original per-artifact actions for recovery. Setup starts no worker and does not grant execution or release permission. The Apple silicon catalog now fixes independent WebVTT and SMAPI packages with current source, mandatory review and build resources, including SMAPI translation import and its complete parser runtime. Complete two-domain release acceptance remains under development.

- Build and export now selects an enabled installed build capability and approved runtime, captures an explicit complete path mapping, and separately reviews the builder and each independent artifact check. Only all proved requested languages can form a saved release. Drafts survive view changes, the macOS Quit menu and Command-Q use the coordinated window-close checks, and cancelling a leave confirmation returns keyboard focus; uncertain starts, check proof and release adoption retain their original identities for reconciliation. Saved releases and multi-file destination previews use their exact paths without domain-specific UI routing. Domain-package cutover and full native workflow acceptance remain under development.

- Saved releases export every exact locale/path artifact, including nested paths and empty files, through the existing native directory authority. Read-only previews and reconciliation create no files; conflicts require the observed state and an explicit overwrite choice. File IO runs outside the project thread, records partial or unknown outcomes per file, and converges accepted actions after cancellation or a lost caller. Export still works after reopening without an installed plugin; domain-package cutover and complete native workflow acceptance remain under development.

- Experimental desktop plugin builds now freeze eligible input and explicit output choices from an exact installed build environment. The builder and independent artifact checker each require consent for their own fixed input, grant and expiry. Saved check proof gates complete Release adoption through the existing Core owner; retries preserve original permission, while cancelled preparation and closed sessions reject late results. The desktop workbench uses these commands; domain-package migration and complete native acceptance remain under development.

- Desktop can read a build recipe with both exact providers from an enabled installed package and separately approved installed runtime. It shares the source environment capture and refuses changed settings; the read grants no execution or release permission. The installed execution commands are available; domain-package migration and complete native acceptance remain pending.

- Core release adoption now preserves every artifact for every requested locale in the existing release store. It rechecks producer and independent checker authority, cancellation and current results, preserves the frozen qualified plan after edits, and returns the original adoption receipt on replay. Reads compare saved bytes, paths, roles and identities with the original results and mandatory proof, without requiring live plugin permission. Exact-path reads and delivery records cover the complete output set, including empty files; domain-package migration and complete native acceptance remain pending.

- Core plugin artifact validation binds each complete builder result to a separately authorized checker and the original build policy. Required rule/target coverage and blocking findings control validation; a generic validator cannot bypass it. Saved source and artifact proofs share one ledger, are rechecked on reopening, and do not grant release or execution authority. Complete native workflow acceptance and domain-package cutover remain pending.

- Experimental Core release-plan capture reuses current qualification and source evidence, keeps review history out of plugin build requests, and fixes the complete output paths. The execution ledger rechecks new plans, rejects substituted decisions and output collisions, and reconciles the original attempt after edits or reopening without restoring execution authority. The workbench now captures these exact inputs; domain-package cutover and complete native acceptance remain pending.

- Experimental SDK build contracts capture complete source evidence and decided targets, check actual UTF-8 artifact hashes, portable paths and fixed limits, and bind an independent checker with complete mandatory output coverage. The Host resolves build declarations from immutable Resource bytes without executing code. Generated JavaScript types and structural validators share the Rust owner; the workbench uses these contracts, while domain-package migration and complete native acceptance remain pending.

- Experimental source-import resources declare fixed material paths and limits, an exact profile, independent extractor/checker contributions and mandatory semantic policy. The SDK validates these bindings, the Host reads immutable package bytes, and generic capture preserves authorized source bytes without invoking an embedded domain parser. Desktop source resolution returns the exact recipe, providers and independently approved installed runtime from one current settings snapshot, refusing disabled packages, missing artifacts or substituted choices. The Source content workbench now captures only the declared native materials and explicitly authorizes the extractor and independent checker separately for their exact inputs, package and runtime. Mandatory fixed check validation gates adoption; failed or pending checks retain the proposal and block application. Lost acknowledgements retain the original attempt, grant, expiry or check result, while cancelled checks can be reviewed again under a new attempt. Expired or closed grants are never renewed. Normal builds remove the old built-in source preflight/start entry points; translation/build migration and default domain-package distribution remain incomplete.

- Opt-in Apple silicon macOS builds bundle the fixed Node and complete Host trees, with a macOS 13.5 minimum and build-owned exact environment metadata. The Extensions panel independently approves and installs that environment, reports unsupported or missing resources, and verifies exact installed files against current approval. Uncertain retries preserve the original request until confirmation. Runtime installation does not enable plugins, launch workers or restore execution permission; production provider integration and authenticated updates remain under development.

- Experimental runtime preparation verifies a pinned macOS arm64 Node archive and its selected files, inspects actual system-library imports and the macOS 13.5 minimum, and retains the complete clean Host dependency/license tree. A public read-only inspector uses the SDK and Host's existing digest/capture owners. Prepared metadata does not approve or install a runtime, bundle it into the desktop, or authorize execution.

- The experimental local plugin store provisions a bounded private application directory, preserves existing permissions, and rejects links, observed replacement and revoked initialization. Its metadata inventory keeps installation receipts distinct from trusted approval and exact enablement decisions; selected loading still requires independent approval and complete byte verification. The desktop Extensions panel now reviews a locally selected package, records explicit manual trust and installs fixed bytes with new packages disabled. Enablement is a separate action. Backend capability selection requires current exact approval, enablement and verified installed bytes; declared publishers are not authenticated. Revision checks and original-request retries reconcile uncertain settings and installation outcomes. Invalid settings remain preserved and refused, while failed reads retain a clearly marked previous observation and block new changes. These controls do not restore execution grants, start plugin code or bundle runtimes.

- Experimental source checks capture required rules and the selected package before execution, using the existing check-result coverage contract. Content schema 2 retains original identity display evidence separately from canonical matching; a captured revision policy selects opaque domain evidence. Source and proposal each have a 2 MiB encoded limit; their combined check request has a separate 4 MiB limit. Process frames reserve space for worst-case JSON quoting and metadata, while raw payload and complete result-frame limits are enforced independently. Earlier experimental shapes are refused without conversion, within the same undistributed SDK alpha batch.

- Public source-extraction SDK inputs bind the selected profile and original captured artifacts to generic content proposals. Generated JavaScript content types share the Rust definitions; structural association does not replace domain validation or project adoption. Public package inspection fingerprints a prebuilt candidate through the Host's bounded capture owner without running code or granting installation, publisher or execution approval.

- Experimental standalone plugin declaration SDK and schema/validation harness, with explicit contribution owners, exact schema/profile behavior identities, requested permissions and deterministic provider choice. Three-layer content exchange retains raw UTF-8 material and opaque domain data, distinguishes byte/UTF-16/grapheme ranges, correlates results with captured requests and independent channel bindings, and preserves mandatory check coverage. Captured runtime descriptions identify exact tool and Host artifacts with an SDK-owned environment digest; the initial Node profile requires an independently verified distribution using platform system libraries. These data checks do not capture or load a runtime, activate plugins, grant authority or establish accepted project writes.

- Experimental process Host and SDK framing harness bind captured package bytes to independent native workers, enforce bounded IO and deadlines, and revoke channels on cancellation, authority loss or invalid results. The macOS conformance profile checks actual native and Node child processes. The JavaScript Host privately uses Cordis behind a generated SDK facade, waits for asynchronous cleanup and discards cancelled or closed-scope callbacks. Its launcher now accepts captured Node and complete Host artifact trees instead of mutable executable/bootstrap paths. Callers must update this experimental API; Core inputs retain the SDK environment descriptor, and the same package can coexist under different exact environments. An optional Core Runner adapter preserves exact package/channel evidence, requires explicit revocable per-attempt consent and uses trusted semantic validators before adoption. Descriptor-based local package capture rejects links, observed replacement and oversized trees; an in-memory catalog checks independently approved identity, source and digest, keeps versions separate and requires explicit enablement and provider selection. Managed local installation retains approved bytes and strict receipts in private immutable objects, synchronizes exclusive promotion, and reconciles uncertain commits through the original action. The same store retains complete approved runtime trees and reopens them after checking actual bytes, the SDK descriptor and independent source approval; acquisition directories can then be removed. Package and runtime actions share conflict and uncertain-commit recovery checks. Installation and loading do not enable a plugin, restore execution grants or authorize project writes. Authenticated updates, desktop catalog/runtime distribution, Windows process cleanup and OS sandboxing remain pending.

- The AI workbench prepares manual plans without a model, or confirms assisted generation with a fixed scope and authorization expiry. Pause, stop, manual takeover and explicitly renewed continuation preserve saved work and the original shared budget. Explicit policies select missing translations or replace captured translations only after mechanical checks and current authority, basis and protection checks. Results retain candidate and policy evidence without human approval. Reopening reads history with grants paused; uncertain controls and permitted storage retries retain their original action identities.

- Shared AI and Arena connection reuse, independent per-provider request rate limits, fair bounded scheduling, and durable request reservations with known usage and unknown exposure shown after reopening. Trusted Core child tasks inherit scope, connection settings, cancellation and ancestor budgets.

- Added macOS desktop builds and local source, translation, glossary import and verified release export, with descriptor-based file authorization and Command-key editing shortcuts.

- Task, AI, Arena and import progress share a session cache and coalesced updates. Missed notifications are reconciled from the project, and hidden views stop their own reads without cancelling running work.

- Bounded review summaries, consistent editor snapshots, and a fixed search range with continuous previous/next navigation and save-and-next across result pages.

- Review checks compute outside database transactions and the project command queue, then recheck their inputs before saving; late checks cannot replace newer translation or check evidence.

- Windows desktop application with English and Simplified Chinese interfaces, project creation, opening, renaming, closing, recent-project reconciliation, and editable target languages.
- Durable task history with cancellation, interrupted-work recovery, saved results, explicit result adoption, and safe project shutdown.
- Bounded SMAPI source import from `manifest.json` and flat JSONC `i18n/default.json`, preserving original files and requiring confirmation of the complete source snapshot.
- SMAPI translation-file preview and checked adoption, immutable manual translation revisions, per-language selections, and interrupted-save/import recovery.
- Project glossary imports, saved context, translation-memory suggestions, and resource-change impact beside the translation editor.
- Human approval and change requests, persisted QA attempts, scoped waivers, a work queue, and build-readiness checks against current project evidence.
- Verified SMAPI language-file builds, immutable releases, and local export with destination checks, explicit replacement choices, and recovery of uncertain outcomes.
- Upstream source comparison, explicit identity continuation, per-language impact estimates, snapshot history, and append-only corrections preserving earlier translations and releases.
- Experimental WebVTT caption profile 1, supporting source updates, translation editing, review, and output preserving timing, settings, cue identifiers, and non-text bytes.
- Configurable OpenAI-compatible translation requests with explicit data-sharing consent, request previews, budgets, saved candidates, partial-failure reporting, and recovery.
- Arena comparison of two to four schemes or saved candidates, blind labels, explicit identity reveal, candidate selection, and atomic manual merges with recorded contributions.
- Persistent translation workspaces with search across all current content keys, source and selected translation text; direct entry from review, source impact and Arena; and return to the originating view without losing its position.

### Changed

- Execution continuation identities and their unique new attempt are stored in one transaction with the existing chunked input, package, grant, budget and release checks. Current development project compatibility is described in the [README](README.md#development); earlier formats are preserved and refused without conversion.

- Normal Core and desktop source imports now require the declared plugin extractor and independent checker. Former SMAPI/WebVTT source parsers, default capability selection, capture APIs and source selection/integration IPC are isolated to execution test fixtures. Captured material, generic identities, source revisions, semantic proof and original receipts retain their existing representation. Current projects use schema 33 and refuse earlier development directories unchanged.
- Normal Core and desktop builds now require the installed plugin build pipeline. Former built-in SMAPI/WebVTT builders, domain artifact parsers, build requests and persistence variants are available only to explicit execution test fixtures. Current projects use schema 33 and refuse earlier development directories unchanged. Plugin release plans, independently checked original artifacts, adoption receipts and local delivery keep their existing owners and representation.
- Current development projects use schema 33, combining exact recovery intent and cancellation associations with the original work-plan service children, captured input chunks and ancestor budgets. Other development formats are refused before application schema changes, without an upgrade, rebuild or reset. Keep their directories and reimport source files into a new project. Internal execution consumers regenerate the typed continuation requests; stored receipt replay does not renew a grant, lease or scheduling authority.


- Normal Core and desktop source imports now require the declared plugin extractor and independent checker. Former SMAPI/WebVTT source parsers, default capability selection, capture APIs and source selection/integration IPC are isolated to execution test fixtures. Captured material, generic identities, source revisions, semantic proof and original receipts retain their existing representation. Current projects use schema 33 and refuse earlier development directories unchanged.
- Normal Core and desktop builds now require the installed plugin build pipeline. Former built-in SMAPI/WebVTT builders, domain artifact parsers, build requests and persistence variants are available only to explicit execution test fixtures. Current projects use schema 33 and refuse earlier development directories unchanged. Plugin release plans, independently checked original artifacts, adoption receipts and local delivery keep their existing owners and representation.

- Desktop translation imports use declared installed plugin capabilities only. Production omits the built-in file listing, preflight and import commands and no longer registers their extractor runner; regenerate earlier development IPC consumers. Normal Core builds also exclude the built-in translation parser and runner and reject its former captured inputs without recording an attempt. Experimental Rust consumers must use the checked plugin projection workflow; the former importer is available only for tests or the explicit `execution-test-host` feature. Generic editing, history, preview and adoption remain available.

- Execution recovery uses the host-verified effect policy captured at enqueue. External operations require a fresh explicit preview or authorization; uncertain external requests retain their recorded budget exposure and do not replay automatically.

- Source, translation, AI candidate, and build adoption validate domain output before opening their write transaction; commit rechecks current scope, cancellation and receipts atomically. Experimental plugin source adoption fixes mandatory semantic checks to the original source, proposal and selected checker, stores their exact result link and rechecks both permissions at commit. Core maps generic SDK units to project identities and derives revisions from the captured policy's opaque evidence. Source history displays original names and encoded references, with local retry when file details are unavailable.
- Manual translation saves and selections now persist unit protection. The translation editor confirms persistent protection before enabling draft input, keeps uncertain actions for reconciliation, and releases protection only after confirming the current entry, language, source, selection and protection revision. Dirty or pending saves block release; old acknowledgements cannot clear newer protection.
- Project storage now uses schema 33 for durable work-plan authorization, human control, checked-selection policy receipts, plugin execution grants, complete captured runtime-environment bindings, generic source-unit mappings, mandatory source/artifact-check provenance and immutable multi-artifact releases. This development build opens schema 33 only and removes automatic upgrades from earlier development schemas. Preserve previous project directories and create a new project to reimport source files. Unsupported versions, unsupported storage settings and corrupt databases are refused without conversion or reset.
- The desktop workspace keeps view inputs and navigation context, places current guidance beside translations, and exposes task inspection and advanced build or AI details when needed.
- Application metadata now identifies the `0.2.0-alpha.1` development batch. Storage schemas, bundled integration versions, and capability/profile versions retain their independent meanings.

### Fixed

- Package removal waits for generation-service children, outcome queries and selection effects owned by the original calling package, including retired workers. Independent packages keep their existing model runtime and authority.
- Manual context refreshes with current project facts while keeping unsaved text, reasons and original uncertain writes. Review a changed saved context and explicitly adopt its save basis; background reads never replace the draft.

- Project overview rereads source availability through the shared session cache after source changes and when returning to the view. Refreshing or failed reads cannot keep the translation shortcut ready, and responses from a previous project cannot change the current overview.

- Project metadata recovery checks the original saved request through scoped commands. While its result is being checked, users may edit the text and folder checkbox without changing that request; confirmation keeps newer edits unsaved, and repeated reads or late responses cannot clear another draft or continue navigation.

- Translation import, fixed match application and historical revision selection share scoped commands and preserve their original requests. A later rejected retry cannot erase an earlier uncertain import or selection; checked history and current-source reads remain separate from captured import work.

- Build and export actions share scoped commands with exact mappings, saved release identities and destination consent. Original uncertain requests remain recoverable across view changes; historical release export stays available when current readiness or history reads fail.

- Task recovery, saved-result application, cancellation and preview navigation verify the exact workspace and original scope through the shared command context. Confirmed requests retain their identities across view changes; uncertain results require an exact lookup before explicit replay, and changed or failed reads cannot authorize new task actions.

- Arena actions verify their exact workspace scope, comparison basis, draft or saved candidate through the shared command context. Original uncertain requests remain recoverable, checked Task cancellation stays available during view refreshes, and captured work survives view changes without accepting a replaced or failed read.

- AI actions share the current workspace command context and verify the selected scope or saved candidate before starting. Original uncertain requests remain available for explicit recovery, and approved captured work continues across view switches without applying late results to a replacement project.

- Translation and review workspaces refresh their current references and history through the project session while preserving drafts and captured scopes. Failed reads keep completed saves distinct from uncertain writes; returning to a workspace does not restore stale editing or navigation permission.

- Keep workspace positions and unsaved work when inactive views unmount. Work-plan controls, plugin capture/check/build stages, reference queries and editor protection keep complete original pending actions in the project session. Explicit recovery retains original consent and deadlines, including after a later retry is rejected. Project close and replacement check unfinished work in every workspace, retain unknown operations for recovery, and reject stale navigation or newer input after saving. Discarding captured reference input completes its original exit confirmation after the action settles; newer query or resource edits and unresolved discards still prevent exit. Captured plugin builds stop reopening editable package discovery; unrelated Store contention no longer misreports their accepted preparation as failed, and returning to editable setup rereads current options. Independent artifact checks now match the Core build scope to its captured source snapshot and language, and reject results from another scope. Captured builder and runtime labels come from the original input; preparation and failed reads do not claim that packages are missing. Blocked project and window exits explain the unfinished or unconfirmed work in its workspace so you can review it and explicitly retry. Confirmed project changes still settle when newer input arrives during opening or closing; local work from the ended session stays read-only for copying until explicitly discarded, and its operations cannot continue into the new session.

- Tasks preserve complete application decisions and original requests across view remounts, including groups spanning result pages. Shared translation writes and same-task cancellation are coordinated before application starts. Uncertain applications require matching preparation and receipt evidence before settling; keeping output or refreshing progress cannot discard an unknown outcome. Recovery actions without a provable original result retain their scope and uncertainty.

- Build mappings, destination checks and original build/export recovery survive release-workspace remounts. Late build confirmations preserve newer input, complete file receipts are checked before confirmation, and selecting a folder again authorizes checking the original export without treating a missing record in that folder as proof that no export occurred. Ordinary navigation retains preparation; leaving the project asks before discarding it.

- Arena settings, explicit generation consent, fixed merge drafts and original start, comparison, reveal, selection and candidate-save requests survive view remounts. Recovery checks complete rounds and the original action, preserves newer input and confirmed saves after read failures, and shares the translation write reservation for selection, merging and candidate saving.

- AI generation and candidate saving keep their original preview, complete selected scope and requests across view remounts. Explicit recovery checks the original attempt or action; confirmed saves remain recorded when result reads fail, and late confirmations preserve newer settings.

- Task, Source, AI and Arena cancellation share the original request across workspace changes and remounts. Explicit retries reuse its identity, and a checked cancellation acknowledgement is kept separate from later task reads and actual worker stopping.

- Translation import preparations, fixed match previews, complete-file confirmations and original uncertain actions survive leaving their view. Checked adoption keeps newer manual input, and import, manual saves and revision selection share one write reservation. Uncertain revision selections retain their captured text and can reconcile the original action after source or language changes.

- Source content, history, identity evidence and translation impact refresh with current project facts. Paged searches retry their original filter and cursor, hidden views stop reads, and removed languages block stale navigation. Automatic comparison reads preserve fixed identity decisions and confirmation evidence; viewing current content remains separate from reading an earlier applied snapshot, including beside newer decisions retained after a late confirmation.

- Source selections, declarations, fixed previews and identity decisions survive view remounts. Original uncertain actions retain their exact request for checked recovery; preparation and adoption confirmations must match that request and its frozen unit. Confirmed application remains saved when a later content read fails, and late confirmations keep newer decisions.

- Current glossary, context, translation-memory and impact reads refresh with project changes, retain paged read recovery, and stop when their view closes. Fresh resource actions recheck their exact target and current read evidence after preparation; automatic comparison refreshes retain the original captured comparison until it is explicitly read again.

- Resource term and context drafts, captured file comparisons and fixed input evidence survive navigation and view remounts. Late saves keep newer edits; removed languages block new work while original uncertain saves, decisions and context captures can be retried with the same request. A captured file remains available when its preview read fails.

- Review fallback and waiver actions recheck the displayed entry, issue and existing exception before dispatch. Batch approvals keep their displayed confirmation scope, recheck availability before starting, and retain the stop control while an entry is being recorded.

- Build-readiness assessments keep the explicitly selected languages, refresh after relevant project changes, and show loading and retry separately. Changing the language selection or leaving the assessment prevents late reads from replacing current results or interfering with review drafts and pending actions.

- Review work queues open without waiting for summaries, show loading separately from empty results, and refresh after relevant project changes. Leaving the queue releases its view wait; a failed page can be retried at its original cursor without replacing captured review work.
- Review history loads independently of the selected entry and current evidence. Failed history pages have their own retry and first-page recovery, while new review results return to current history without replacing reasons, fixed selections or pending actions.

- Save-and-next retains newer edits and original uncertain save requests, and stops late navigation after leaving the workspace or changing the target language.

- Validate project names and target languages before saving from the leave dialog, keeping invalid drafts available to edit.

- Review reasons, reviewer details, fixed selections and original pending actions survive closing the panel or remounting its view. Late confirmations preserve newer edits, while checks and batches retain their original cancellation controls. Returning to an entry retains the content its reason refers to; changed content can be compared and explicitly accepted without losing the reason. Stale checks remain separate from current evidence, and actual project leave still requires confirmation.

- Review retains reasons and original unknown actions when a target language is removed. It blocks new work for that language, checks the scope again after waiting, and reports unstarted entries when a batch stops. An uncertain request remains reserved for exact reconciliation even after its language is restored.

- Translation drafts and their original save requests belong to the project session. Leaving the editing view keeps newer input and pending confirmations; a late save acknowledgement updates its basis without replacing edits made while saving.

- AI preparation keeps connection settings, selected scope, preview and consent when navigating between workspaces. Source, resource or sharing changes require a fresh preview and consent; late previews cannot restore obsolete preparation.

- Target-language changes recheck the active translation scope. Drafts for removed languages remain available with a return-to-settings recovery action, while new reads and writes for an unavailable language are blocked.

- Ctrl+S and Command+S save the active translation draft from its list or reference panel. Project-name shortcuts use the same required-name validation as the save button and keep invalid input available for correction. Composition, modal dialogs, pending saves and unknown outcomes prevent unintended shortcut mutations; an uncertain translation save can only be checked or retried explicitly.
- Resuming undispatched work and retrying safe failures retain the original action, selected items and cancellation basis after a lost confirmation. Exact lookup or replay returns the recorded attempt without another enqueue or dispatch. Modified requests conflict; an unrecorded request cannot refresh its cancellation basis. The Tasks view can inspect the original recovery history. Anonymous resume/retry IPC calls are now refused; outcome queries and output validation keep their existing behavior.

- Development runtime bundles pin the current independently built WebVTT and SMAPI packages and their exact SDK snapshot. Existing installed bindings and historical releases keep their original package identities; installing a new selected package remains explicit.

- Resuming undispatched work and retrying safe failures retain the original action, exact selected items and cancellation basis. A recorded request returns the original continuation receipt before fresh eligibility and cannot enqueue or dispatch again. The old anonymous recovery route refuses these actions; consumers must use the typed continuation and history API. New plugin attempts do not inherit the original execution grant.

- Cancellation keeps an uncertain result when its durable request is saved but the following task projection fails, preserving the original error and cancellation request for reconciliation.

- Manual checks rejected before dispatch no longer keep a project active or
  repeatedly read extension settings. Retrying preserves the original consent;
  partially submitted or uncertain authorized checks retain recovery and cancellation.

- Source-update estimates now reflect the QA needed after adopting a new source
  snapshot. Unchanged translations and applicable manual decisions remain;
  checks bound to the complete previous input remain historical until rerun.

- Review and WorkPlan text-checker choices remain stable while an action locks
  and unlocks its controls. Preparing a check no longer starts an unrelated
  metadata read that can compete with the original execution start.

- New-project destination previews use the native path separator, including
  macOS root directories, to match the actual project location.

- Installed source, translation, build and reference choices read enabled package
  metadata sequentially, avoiding Store contention when several extensions are
  enabled. Source and build refreshes wait for their current metadata and
  environment reads, including when returning to the workbench.

- Translation import refreshes the editor entry list after individual or batch adoption and confirmed recovery, preserving its query, page and any draft. Cancelling an unsaved-draft leave confirmation returns focus to the editor. Declared translation fields use the existing form layout, and installed source-environment reads keep their loading feedback visible until completion.

- Preparing a plugin translation preview before its independent check completes now reports an incomplete check instead of a corrupt project. Rejected checks still block preview, and a missing proof for a result already marked qualified remains a corruption error.

- Experimental source and artifact adoption recheck the selected checker's current authorization and unsuperseded result before preparation and at commit. Revocation or cancellation after a successful semantic check blocks new adoption while preserving previously adopted content, saved evidence and committed receipts.

- Saved source warnings remain available after preview, adoption and reopening; successful task outputs no longer display failure retry guidance. Adopted plugin snapshots refuse missing mandatory check evidence even when stored validation flags are downgraded. Invocation result budgets count original JSON frame bytes, including whitespace and escaping.

- Continued AI work plans display the original shared budget, including prior requests and unresolved exposure, rather than only the new child attempt.

- Unsupported SQLite storage settings now have a distinct refusal instead of being reported as corrupt project data. The original project and its settings are preserved. Core Rust callers with exhaustive error matches must handle `UnsupportedStorage`; the desktop wire uses `unsupported-schema` with `reason: "storage-mode"`.

- IPC validation keeps both primitive integer bounds and narrower declared field constraints.

- Failed edits preserve their submitted and rejecting bases with translated recovery guidance and expandable diagnostics. Command diagnostic references correlate sanitized boundary logs, including failures before queue admission; unknown results continue to retain the original action.

- Project lifecycle responses, change notifications, execution results, source content, translations, resources, reviews, build/delivery, AI and Arena records are checked against generated Rust contracts; malformed confirmations remain unconfirmed, and revision counters retain their full integer range, including source history revisions. Malformed rejection objects also retain the original action for reconciliation, even when their error code is recognized.

- Metadata updates reject noncanonical expected revisions, including signed values and leading zeros, before writing project data.

- AI resource baselines and reported token usage retain full unsigned integer precision. Arena totals remain exact across candidates; start, comparison and merge confirmations must match the submitted attempt or action.

- Term and context saves preserve newer content and source notes when a delayed response arrives or an uncertain original action is checked again.

- Build acknowledgements confirm the submitted attempt, and export previews bind the release and destination selection. Export confirmations bind the submitted action, release and overwrite choice; delivery history cannot include a different release.

- Lost build and export confirmations retain their original request for an exact saved-result check before another action or navigation. Retrying an accepted build preserves its fixed inputs after later edits. A history refresh failure cannot replace a confirmed export or mask its original rejection.

- Review and QA responses retain their complete input evidence; decisions, checks, waivers and fallback confirmations must match the submitted action, unit and language before pending state is cleared.

- Manual translation saves confirm the committed revision and the next edit basis directly, preserve newer input, and keep history refresh separate from save confirmation. Translation counters and history cursors use exact decimal strings across desktop IPC. Earlier translations, QA results and review decisions remain readable after source updates remove an entry; removed entries stay excluded from current evaluation, editing and build eligibility.
- Translation, resource, AI and Arena mutations retain their original action after an unrecognized or disconnected IPC response; diagnostic wording no longer decides whether an action may be retried.
- Desktop project operations, search, review and export run on a bounded project thread instead of blocking window events. Cancellation remains available while review checks run, and queued requests recheck the active session before accessing project data.
- Project lifecycle cancellation, retry intent, folder moves, stale recent paths, action feedback, and shutdown while tasks are active.
- Translation draft preservation and save ordering during navigation, return to an editor, and late responses; responsive review checks and saves.
- Editor keyboard shortcuts and workspace selection interfering with text editing or unexpectedly reopening the first item.
- Source import limits, unsupported-value feedback, identity guidance, long native keys, and retained input when reopening source updates.
- QA waiver scope and validator evidence, historical handling of late QA replies, and changed-versus-unchanged source qualification.
- Caption ordering, Unicode payload boundaries, and timing/layout semantics in upstream impact estimates.
- Arena selection preservation and recovery after an uncertain manual merge.
