# Local build output inspection and export

Once translations are reviewed, checked, and approved, use **Build and export** to generate localized output files through an installed build plugin, run semantic artifact checks, record an immutable project release, and export the verified files to disk.

See the [README](../README.md#development) for current database schema compatibility, and the [versioning policy](versioning.md) for application release versioning (the releases described in this guide are localized project outputs rather than application releases).

## Preparing and running a build

1. **Verify build readiness**: Open a project with an adopted source snapshot, selected translations, current QA checks, and human approvals. In **Review and QA**, resolve any remaining items in the work queue and run the build readiness check. Any source-text fallbacks or supported QA waivers must be explicitly recorded beforehand. If Readiness reports blockers, use **Edit this key** to jump to the affected entry, fix the issue, and recheck readiness.
2. **Configure the build**: Open **Build and export**, select an approved installed build capability and matching runtime, choose the target languages for the release, and enter the relative output path for each target language (one path per line, relative to the export folder). The selected build package validates its required file formats and path names.
3. **Review and authorize**: Inspect the release policy, source snapshot, coverage, blockers, exceptions, and execution environment to capture the build input. Builder and artifact-checker selections maintain separate execution bindings (each may use `Project` or `Attempt` scope while locking the package, profile, environment, and required check set). After capturing the fixed build input, grant explicit execution consent to run the builder.

The build executes as a persisted background task using saved project text without rereading external Mod files or generating new translations. You can monitor progress in **Tasks**; switching views or closing the build panel does not cancel a running task or discard your release form inputs.

## Running artifact checks and recording a release

In **Tasks**, a completed plugin build displays each generated artifact's relative path, role, byte size, SHA-256 digest, and the number of targets in the build plan:

1. **Prepare artifact checks**: From a completed build in the current session, prepare a batch of artifact-check inputs. Review each language's build result, artifact digests, checker identity, execution environment, and requested permissions, then approve the checks you want to run.
2. **Execute checks**: Start the confirmed checks, which run in the language order captured by the build. Each check runs in its own check attempt without automatic retries. If a step fails, is cancelled, or returns an uncertain outcome, remaining checks pause so you can reconcile the operation; stopping continuation leaves partial proofs intact, while cancelling an already running check task is a separate action.
3. **Record the release**: Each passing check records its semantic proof. Once all required languages and artifact checks pass, apply the verified results to save an immutable project release. Subsequent edits to project translations do not modify an existing release or its stored artifact bytes.

To inspect a past plugin build without creating a new grant or release, choose **View saved build in Build and export**. This read-only view verifies the saved source references, fixed build plan, generated artifact files, and per-language artifact-check proofs, and remains accessible even after reopening the project or uninstalling the builder plugin (provided no unfinished build mapping or unresolved action is currently active in the form).

## Exporting release files to disk

1. In **Build and export**, refresh the releases list and select a saved release. Expand **Release input and checks** to inspect the input digest, source-file digests, builder and checker versions, review basis, and any recorded source fallbacks or QA waivers.
2. Choose a local export folder and click **Check destination**. Tsumugi compares the release's relative file paths against the destination directory, recognizing existing identical files and requiring explicit confirmation before overwriting differing files.
3. Confirm the export. If a destination file changes after the preview, the export stops and requests a fresh destination check. Export history records the target directory, per-file status, and observed file digests. Always verify exported files before using them in another application.

## Recovery from interrupted or uncertain operations

If a build, plugin check, or export acknowledgement is lost or interrupted, Tsumugi reconciles the saved state before permitting a retry:

- **Plugin and build tasks**: When a build confirmation is lost, the view automatically queries the original fixed request once. You can also click **Check saved build task** (or **Check this original operation** for plugin steps) to repeat that read-only lookup. A saved task preserves its fixed inputs even if project text or target languages are edited later. **Retry the same build** is offered only when the lookup confirms that no task was recorded. Reopening a project preserves all historical records and bindings, but starting a new build or semantic check after expiry or restart requires preparing a fresh attempt with new execution consent.
- **File exports**: If an export or destination check ends in an uncertain state, the view reads the original action record once (and you can click **Check this export** to re-read it without writing files or opening the folder picker). To reconcile an interrupted export on disk, re-authorize the same destination folder if needed and run the file check next to the history entry: matching files are marked confirmed, missing files can be retried, and differing or unreadable files remain flagged for review. **Refresh export history** reloads the saved history without touching the filesystem.

## Synthetic workflow checks

On macOS arm64, you can run automated IPC workflow tests against temporary projects using a synthetic build and check component. Provide `TSUMUGI_TEST_RUNTIME_TOOL`, `TSUMUGI_TEST_RUNTIME_HOST`, and `TSUMUGI_TEST_RUNTIME_APPROVAL` configured with the compatible artifacts and descriptor described in the [Host conformance guide](../crates/plugin-host/README.md). These tests run local workers directly without making model requests or opening an application window:

```sh
cargo test --locked -p tsumugi-desktop --bin tsumugi-desktop --features wire-schema artifact_workflow_ -- --test-threads=1
```
