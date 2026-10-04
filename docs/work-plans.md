# Fixed application work plans

The Core `application` module owns the initial work-plan representation. The
current API prepares and verifies plans from a project's existing source,
translation and resource authorities. Both operations are read-only and use one
SQLite snapshot. The plan is an internal application contract, not a stable plugin
SDK or permission grant.

`ProjectStore::prepare_work_plan` accepts the existing `AiConfig`, one target
locale, a bounded set of source unit IDs and `PlanOptions`. It returns a `WorkPlan`
with a new plan identity, fixed execution input, observed translation selection
identities, explicit stage choices and a canonical digest. Re-reading its fixed
input preserves the task, attempt, item and adoption-unit identities.

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

These operations retain the current database schema and persistence format. The
desktop continues to use its existing explicit AI preview/start and candidate
adoption flow; preparing a Core work plan does not change that flow's permissions.
