# Manual offline Packs

An offline Pack is a local directory bundling up to 16 prebuilt plugin packages for convenient side-loading.

To install packages from a Pack:
1. Open **Extensions → Choose offline Pack folder** and select the Pack directory.
2. Review each listed package's version, declared publisher, runtime type, and requested permissions. All packages start unchecked.
3. Select the packages you trust and click **Approve and install selected packages** to record your approvals and install the package files.
4. Newly installed packages start disabled; enable them individually when you are ready to use them (existing enablement states are preserved).

A Pack is simply a local folder layout—it does not provide cryptographic publisher authentication, runtime installation, or execution permissions. Pack installations use the same `manual-local` / `manual-approval` origin as individually installed local packages and cannot overwrite an existing installation or history entry that was approved from a different source or publisher. Leaving a conflicting member unchecked leaves your existing installation untouched. No installation scripts or plugin workers are executed during preview or installation.

## Preparing a directory

Place a `pack.json` file at the root of the Pack directory alongside one direct subdirectory per member package. Each member directory must contain a complete prebuilt plugin package, including its `manifest.json`.

`pack.json` must follow this structure:

```json
{
  "formatVersion": 1,
  "id": "reference-tools",
  "displayName": "Reference tools",
  "packages": [
    {
      "directory": "reference-package",
      "plugin": {
        "publisher": "example",
        "id": "reference-tools",
        "version": "0.1.0"
      },
      "packageDigest": "REPLACE_WITH_THE_ACTUAL_HOST_PACKAGE_DIGEST"
    }
  ]
}
```

Set `packageDigest` to the exact digest printed by `tsumugi-plugin-package inspect` for that member directory:

```sh
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- inspect /absolute/path/to/reference-package
```

Note that `packageDigest` is calculated by the Host over the manifest, canonical file paths, file contents, and executable permissions—it is not a ZIP or tarball hash. Every member's `plugin` metadata in `pack.json` must exactly match its `manifest.json`.

### Structural and size limits

Format version `1` enforces the following constraints (currently supported on macOS and Linux):
- **Member count and naming**: 1 to 16 packages with unique logical plugin IDs and unique directory names (compared case-insensitively). Each `directory` must be a single portable path segment; absolute paths, `..` traversal, symlinks, hard links, special files, and undeclared files are rejected.
- **Size and depth**: `pack.json` may be at most 64 KiB. The entire Pack tree (including `pack.json`) is capped at 64 MiB, 1,024 files, 1,024 directories, and 17 directory levels, with a 30-second read timeout.
- **Per-package limits**: Standard single-package and SDK limits still apply, including a maximum of 256 directories per member (counting the member root directory).

## Confirmation and recovery

- **Preview snapshots**: Selecting a Pack reads an immutable snapshot of its files into memory without writing to the PackageStore. The preview ticket is valid for 10 minutes. Editing files on disk afterwards does not update the displayed preview—re-select the folder to pick up changes. Selecting a different Pack clears your checkboxes, whereas closing and reopening the Extensions panel preserves your active preview.
- **Sequential installation and retry**: When you confirm installation, Tsumugi saves all selected approvals first and then installs the selected packages in order. If an error occurs midway, earlier approvals and completed package installations remain in place. If an installation is interrupted or its response is lost, use **Retry original operation** to finish or reconcile the exact pending request—this uses the already captured snapshot even if the source folder was moved or the 10-minute preview timer expired.
- **Individual lifecycle**: Once installed, packages are managed individually. Tsumugi does not track Pack membership after installation, and there is no bulk uninstall, shared trust, or automatic Pack update mechanism. For signed catalogs that support authenticated updates, see [Signed offline repositories](offline-repositories.md).
