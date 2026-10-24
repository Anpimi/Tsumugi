# Signed offline repositories

The experimental Extensions panel accepts an already built local repository.
Obtain its initial root through a channel you independently trust, compare the
displayed root fingerprint with that channel, and explicitly confirm the trust
refresh. Selecting a folder or root file alone enrolls nothing. Repository
verification neither installs packages nor executes code.

After verification, review each package's exact version, repository-attested
publisher, runtime and complete package/capability permissions. Select the
members you want to install. Members start unchecked; choosing another version
of the same logical plugin replaces that selection and its rollback consent.
New versions start disabled. Existing enablement and in-flight fixed bindings
remain separate; installation never silently switches a running provider.

## Repository layout

Use a complete, already built directory containing:

```text
metadata/<version>.root.json
metadata/timestamp.json
metadata/snapshot.json
metadata/targets.json
targets/catalog.json
packages/<direct-member-name>/manifest.json
packages/<direct-member-name>/...
```

Consistent snapshots use the standard versioned snapshot/targets metadata and
SHA-256-prefixed catalog filename. Include the current retained root and every
intermediate root needed for rotation. Metadata is verified with TUF; catalog
bytes must match the signed target description before any member is trusted.
The strict authenticated catalog is:

```json
{
  "formatVersion": 1,
  "displayName": "Reference repository",
  "packages": [{
    "directory": "reference-package",
    "plugin": {"publisher": "example", "id": "reference-tools", "version": "1.0.0"},
    "packageDigest": "REPLACE_WITH_THE_ACTUAL_HOST_PACKAGE_DIGEST",
    "publisherId": "repository-attested-publisher"
  }]
}
```

`packageDigest` is the Host's complete package digest, not the hash of an archive
or the catalog target. The publisher identifier is attested by this repository;
it is not an independent publisher-key authentication claim. The catalog cannot
choose its source identity: the Store derives that stable identifier from the
independently enrolled initial root's canonical signed content. Retain that
initial root for subsequent selections. A root rotation updates the existing
source's latest trusted root, not its original source identifier.

The catalog is at most 64 KiB and declares 1–16 exact members. Distinct versions
may coexist in the catalog; each installation chooses at most one version per
logical plugin. The complete capture is at most 64 MiB, 1,024 files/directories
and a 30-second deadline. Individual package limits, including its root in the
256-directory limit, remain in force. Root files are at most 256 KiB. Links,
special files, path aliases, undeclared package contents and executable metadata
are refused. Capture/Store operations currently support macOS and Linux.
There are no network requests, archive extraction or installation scripts.
This profile accepts top-level targets only; delegated targets are refused
before verification can mutate the trusted metadata cache.

## Update safety and recovery

Signature thresholds, root rotation, metadata versions, target hashes/lengths,
expiry and the latest sampled time use the pinned upstream verifier. The local
storage adapter only connects its metadata operations to the existing locked
PackageStore. It does not replace TUF verification. Already verified intermediate
root, role and time progress is retained even if a later role fails. The
original root-update comparison context remains durable until key-rotation
cache invalidation finishes; interrupted recovery still authenticates from the
latest trusted root. Corrupt
state is an error; deleting or resetting the metadata cache is not a recovery
operation.

Each accepted refresh retains its exact action, revision, root decision and
frozen source bytes. An uncertain write requires confirmation of that original
action. After reopening, the Store conservatively requires original-action
confirmation before another refresh; merely observing visible files does not
prove durability. Resume reuses retained input even if the selected folder has
disappeared, rechecks current expiry, and never authorizes package installation.
Trust revisions and package-settings revisions are separate.
The experimental Store retains at most sixteen sources and 128 trust actions
in total, including frozen inputs. It performs no automatic history deletion;
keep sufficient space for those retained snapshots.

A verified installation ticket expires after at most ten minutes or the earliest
metadata expiry. New installation decisions recheck source currentness, clock
and expiry. A newer, pending or rejected refresh invalidates earlier candidates.
An accepted installation's original recovery action can still confirm already
recorded results; it cannot silently add a new member or change permissions.

An older software version in a currently authenticated catalog can be chosen
with separate explicit rollback consent. Ordinary update selection cannot
downgrade software. This never relaxes metadata rollback, expiry or root rules.
Existing origins retained by approvals, installations and uninstall history
cannot be replaced with another source or publisher. Removed catalog members
cannot receive new approval from an old candidate; existing local approvals
remain independently removable in Extensions.

There is no background update, automatic provider switch, root discovery,
repository removal, source migration or automatic Pack membership management.
Repository trust, package approval, enablement and each execution grant remain
separate decisions.
