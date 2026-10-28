import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DraftValue } from "../../../draftCommands";
import { resourceCommands } from "../../../resourceCommands";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Banner, ErrorState, LoadingState } from "../../../design-system/Feedback";
import { memoryEntryKey } from "../knowledge/translationMemoryReads";
import { MemoryEntryEvidence } from "../knowledge/TranslationMemoryDetails";

export default function TranslationReuseReference({ origin, locale, disabled }: { origin: NonNullable<DraftValue["reuseOrigin"]>; locale: string; disabled: boolean }) {
  const { t } = useTranslation(undefined, { keyPrefix: "knowledge" }), reads = useSessionReads(), id = useId(), [open, setOpen] = useState(false);
  const donor = { unitId: origin.donorUnitId, revisionId: origin.donorTranslationRevisionId, locale };
  const entry = useSessionQuery({ key: memoryEntryKey(donor), scopes: ["source", "translation", "review", "resources"], enabled: open && !reads.retired,
    read: () => resourceCommands.translationMemoryEntry({ ...reads.context, ...donor }) });
  return <Banner tone="info"><p>{t("memoryReferenced")}</p><p>{t("memoryReferencedHelp")}</p>
    <Button size="sm" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t("memoryReadReference")}</Button>
    <div id={id} hidden={!open}>{entry.isFetching ? <LoadingState label={t("memoryReading")}/> : entry.error ? <ErrorState title={t("memoryReferenceFailed")} action={<Button onClick={() => void entry.refetch()}>{t("refresh")}</Button>}/>
      : entry.data ? <MemoryEntryEvidence entry={entry.data}/> : null}</div>
  </Banner>;
}
