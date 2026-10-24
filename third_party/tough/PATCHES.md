# Local storage integration

This directory contains the published `tough` 0.24.0 sources from crates.io,
licensed under MIT or Apache-2.0. The upstream repository is
https://github.com/awslabs/tough and the source revision is `98d8eb8b2ce63515d9b4981c938ef6453c5b5771`.

The local patch adds an optional metadata-storage adapter to `RepositoryLoader`.
It lets an embedding application use its existing atomic, durable, recoverable
storage owner for every verified metadata write, deletion and trusted-time
sample. The default upstream filesystem behavior remains available. Transport,
signature verification, TUF update ordering, rollback rules and expiration
checking stay upstream-owned; this patch does not implement another verifier.

An adapter must not report success before its write is durable, and must retain
unknown writes for exact reconciliation. The embedding owner must preserve
verified progress even if a later role fails, supply the latest retained trusted
root when reopening, and never turn a corrupt or unknown datastore into an empty
cache. These application obligations are not supplied by `tough` itself.

The custom backend also retains the original root-update context until the
upstream root phase and its timestamp/snapshot cache invalidation finish. This
preserves the original key-comparison baseline if an update stops after writing
a new root but before clearing the old role cache. Authentication still starts
from the latest retained trusted root; only the upstream cache-invalidation
comparison uses its retained original context. Completing that phase removes
the context before any new timestamp/snapshot/targets progress can begin.
The default filesystem/temporary backend keeps its upstream behavior.

Keep this patch limited to `src/datastore.rs` and the storage/continuation seams
in `src/lib.rs`. Reassess those seams when upgrading the upstream library.
