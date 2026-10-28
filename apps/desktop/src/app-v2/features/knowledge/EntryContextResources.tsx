import { useTranslation } from "react-i18next";
import { Button } from "../../../design-system/Button";
import { ErrorState, LoadingState } from "../../../design-system/Feedback";
import { useSessionQuery } from "../../../SessionReadProvider";
import { executionContext } from "../../../executionCommands";
import type { ProjectView } from "../../../projectCommands";
import { resourceCommands } from "../../../resourceCommands";
import { ContextResourceCapturePreview } from "../../../ContextResourceCapturePreview";

export default function EntryContextResources({ project, target, visible }: {
  project: ProjectView; target: { unitId: string; locale: string; sourceSnapshotId: string; sourceRevisionId: string }; visible: boolean;
}) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" });
  const scope = { projectId: project.metadata.projectId, unitId: target.unitId, locale: target.locale, sourceSnapshotId: target.sourceSnapshotId, sourceRevisionId: target.sourceRevisionId };
  const read = useSessionQuery({ key: ["knowledge-entry-resources", scope], scopes: ["source", "resources"], enabled: visible,
    read: () => resourceCommands.resolveContextResources({ ...executionContext(project), scope }) });
  return read.isFetching ? <LoadingState label={t("contextReading")}/> : read.error ? <ErrorState title={t("contextReadFailed")} action={<Button onClick={() => void read.refetch()}>{t("refresh")}</Button>}/>
    : read.data ? <ContextResourceCapturePreview mode="read" capture={{ scope: read.data.scope, entries: read.data.entries.filter(entry => entry.status !== "outside-scope" && entry.status !== "shadowed") }}/> : null;
}
