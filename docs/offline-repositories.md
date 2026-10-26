# Signed offline repositories

The experimental Extensions panel can verify and install plugins from a local [TUF (The Update Framework)](https://theupdateframework.io/) repository on disk.

To enroll or refresh a repository and install packages:
1. Obtain the repository's initial root metadata file (`1.root.json` or current root) through a channel you independently trust.
2. In **Extensions**, select the repository directory and root file, verify that the displayed root fingerprint matches your trusted source, and confirm the trust refresh. (Merely selecting a folder or file does not enroll the repository, and verification never installs packages or runs code.)
3. Once verified, review the available packages—including each version, repository-attested publisher, runtime, and requested permissions—and check the packages you want to install.
4. Confirm installation. Newly installed versions start disabled, and active plugin bindings in running tasks are never switched automatically.

## Repository layout

A signed offline repository is a prebuilt directory with the following structure:

```text
metadata/<version>.root.json
metadata/timestamp.json
metadata/snapshot.json
metadata/targets.json
targets/catalog.json
packages/<direct-member-name>/manifest.json
packages/<direct-member-name>/...
```

Consistent snapshots use standard versioned `snapshot.json` / `targets.json` filenames and a SHA-256-prefixed `catalog.json` filename. Include the currently enrolled root file as well as every intermediate `<version>.root.json` needed to verify key rotations.

During verification, TUF checks metadata signatures, thresholds, versions, and expiration dates before validating `targets/catalog.json` against its signed target hash and length. The authenticated `catalog.json` must follow this structure:

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

Key identity rules:
- **`packageDigest`**: The Host's full package digest (`tsumugi-plugin-package inspect`), not an archive hash or the TUF target hash of `catalog.json`.
- **`publisherId`**: Attested by this repository's TUF targets role rather than an independent per-publisher signing key.
- **Repository source ID**: Derived by the PackageStore from the canonical signed bytes of the initial enrolled root metadata. Keep that initial root file when refreshing the repository later; subsequent root rotations update the source's trusted root key without changing its stable source ID.

### Repository and package limits

Repository capture and PackageStore operations are supported on macOS and Linux, operate entirely offline without archive extraction or install scripts, and enforce these limits:
- **Catalog**: Up to 64 KiB, declaring 1 to 16 package entries. Multiple versions of the same logical plugin can coexist in `catalog.json`, though you can select at most one version per plugin during an installation.
- **Root metadata**: Each root file may be at most 256 KiB. Top-level TUF roles only; delegated targets are rejected before mutating the metadata cache.
- **Directory tree**: Up to 64 MiB and 1,024 total files/directories, with a 30-second capture timeout. Standard per-package bounds (including the 256-directory limit counting the package root) also apply. Symlinks, hard links, special files, path aliases, undeclared package files, and executable flags on metadata files are rejected.

## Update safety and recovery

### TUF verification and trust persistence

Tsumugi uses the pinned upstream TUF verifier to enforce signature thresholds, root key rotation, version monotonicity, target hashes/lengths, and expiration timestamps, persisting verified state in the locked PackageStore:
- **Incremental progress**: Verified intermediate roots, roles, and timestamp watermarks are saved even if a later role fails verification. During key rotation, the root comparison context stays durable until cache invalidation completes.
- **Corruption handling**: Corrupt store state is treated as a hard error; never manually delete or reset the metadata cache to work around verification errors.
- **Action recovery**: Every accepted trust refresh records its action ID, revision, root decision, and frozen input bytes. If a write is interrupted or the app reopens after an uncertain refresh, you must confirm the original action before starting another refresh (recovering a refresh re-checks expiration against the saved snapshot without installing packages).
- **Retention bounds**: The experimental store holds up to 16 enrolled sources and 128 total trust actions (including frozen snapshots) without automatic pruning, so ensure adequate disk space.

### Installing, updating, and rolling back packages

- **Installation tickets**: A verified repository preview ticket expires after 10 minutes or at the earliest TUF metadata expiration, whichever comes first. Starting a new refresh invalidates older installation tickets.
- **Downgrades and rollbacks**: Standard update selection only moves forward. Selecting an older plugin version from an authenticated catalog requires explicit rollback consent for that plugin (replacing any earlier version selection in the same preview). TUF metadata rollback, expiration, and root rotation rules are never relaxed.
- **Origin pinning**: Package origins recorded in approvals, active installations, or uninstall history cannot be reassigned to a different repository source or publisher. If a package is removed from `catalog.json`, it cannot be newly approved from a stale ticket, while already installed packages can still be managed or uninstalled in **Extensions**.

Tsumugi does not poll repositories in the background, auto-update plugins, migrate sources, or remove enrolled repositories. Repository trust enrollment, package approval, plugin enablement, and per-task execution consent remain distinct steps.
