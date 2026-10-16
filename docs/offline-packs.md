# Manual offline Packs

Open **Extensions → Choose offline Pack folder** to review an already built
collection of packages. Each package starts unchecked. Review its version,
declared publisher, runtime types and complete requested permissions, then select
only the members you trust. **Approve and install selected packages** saves those
approvals and installs their captured bytes. New packages start disabled; enable
them separately when ready. Existing enablement decisions are preserved.

A Pack is not a trusted publisher, signature, runtime installer or execution
grant. Its metadata and publishers are unauthenticated claims. This local flow
uses the same `manual-local` / `manual-approval` origin as individually selected
local packages. It cannot overwrite a conflicting source or publisher approval, including an origin
retained in installation or uninstall history. Leaving a conflicting member
unchecked preserves the existing installation.
Package installation, enablement and permission for a particular execution are
separate decisions. No installation script or worker runs during preview or
installation.

## Preparing a directory

Place `pack.json` at the selected root, alongside one direct child directory per
member. Each member directory contains a complete, prebuilt package, including
its `manifest.json`. The strict descriptor has this shape:

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

Replace the illustrative digest with the exact `packageDigest` returned by the
public Host inspector for that member:

```sh
cargo run --locked -p tsumugi-plugin-host --bin tsumugi-plugin-package -- inspect /absolute/path/to/reference-package
```

The Host digest includes the exact manifest and ordered package paths, bytes and
executable flags. A ZIP/tar hash is a different value. Computing a digest does not
authenticate its publisher. The descriptor's plugin identity must match the
captured manifest exactly.

Version 1 accepts 1–16 members with distinct logical plugin IDs and distinct
directory names, including case-insensitive comparison. Directory names are one
portable path segment; absolute paths, traversal, links, special files and
unlisted files are rejected. The descriptor is at most 64 KiB. The complete
selected tree, including the descriptor, is at most 64 MiB, 1,024 files, 1,024
directories and 17 nested levels, with a 30-second capture deadline. Existing
single-package and SDK limits also apply, including at most 256 directories per
member with the member root counted. Current safe directory capture is
supported on macOS and Linux; other platforms report unavailable.

## Confirmation and recovery

Preview captures immutable bytes and performs no Store write. Its ticket expires
after ten minutes. Changing the original directory does not change a displayed
snapshot; choose it again to review new bytes. Choosing another Pack clears all
member selections, even if it has the same name. Closing and reopening the panel
retains the existing local preview. Reading current state never installs members.

The original installation first saves all selected approvals, then installs the
selected packages in order. If a later step fails, earlier approvals and installed
packages remain. A retained or unknown operation keeps its exact original request
and each member's durability action. Use **Retry original operation** to confirm
or finish it; do not start a replacement operation. The captured bytes remain
available for that accepted operation even if the original directory disappears
or its preview ticket expires. A completed installation's lost acknowledgement
also uses that original request. Reading inventory alone does not confirm an
uncertain write.

Pack membership is not persisted: these are explicit individual installations.
There is no automatic Pack update, member removal, shared trust, source migration
or bulk uninstall. [Signed offline repositories](offline-repositories.md) use
a separate explicit root-enrollment and authenticated update workflow.
