import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationPlanningRun } from "../../../conversationCommands";
import { Button } from "../../../design-system/Button";
import { planningUnitLabels } from "./proposalDraft";
import styles from "./ConversationPanel.module.css";

export interface ConversationEntryReference {
  projectId: string; conversationId: string; attemptId: string;
  unitId: string; locale: string; sourceSnapshotId: string; sourceRevisionId: string; detailTab?: "detail" | "context";
}
export type OpenConversationEntryReference = (reference: ConversationEntryReference, current: () => boolean) => Promise<boolean>;

/** References are projected exclusively from the validated saved material tuple. */
export function ConversationEntryReferences({ run, current, onOpen }: { run: ConversationPlanningRun; current: () => boolean; onOpen?: OpenConversationEntryReference }) {
  const { t } = useTranslation(undefined, { keyPrefix: "conversation" });
  const [busy, setBusy] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const live = useRef({ mounted: false, current, onOpen, run });
  useLayoutEffect(() => { live.current = { mounted: true, current, onOpen, run }; return () => { live.current.mounted = false; }; }, [current, onOpen, run]);
  const labels = planningUnitLabels(run.preview.input), scope = run.preview.scope;
  if (scope.kind !== "units" || !run.preview.units.length) return null;
  async function open(unit: ConversationPlanningRun["preview"]["units"][number]) {
    const callback = onOpen;
    if (!callback || busy || !current() || scope.kind !== "units") return;
    const valid = () => live.current.mounted && live.current.run === run && live.current.onOpen === callback && live.current.current();
    setBusy(unit.unitId); setFailed(false);
    try {
      if (!await callback({ projectId: run.preview.projectId, conversationId: run.preview.conversationId, attemptId: run.detail.attemptId,
        unitId: unit.unitId, locale: scope.locale, sourceSnapshotId: unit.sourceSnapshotId, sourceRevisionId: unit.sourceRevisionId }, valid) && valid()) setFailed(true);
    } catch { if (valid()) setFailed(true); }
    finally { if (live.current.mounted) setBusy(null); }
  }
  return <section aria-label={t("entryReferences")}><div className={styles.actions}>{run.preview.units.map((unit, index) => <Button key={unit.unitId} size="sm"
    disabled={!onOpen || !current() || busy !== null} onClick={() => void open(unit)}>{t("entryReference", { entry: labels.get(unit.unitId)?.key || t("proposalEntryNumber", { number: index + 1 }), locale: scope.locale })}</Button>)}</div>
    {failed ? <p role="status">{t("entryReferenceChanged")}</p> : null}</section>;
}
