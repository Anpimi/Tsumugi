import { useTranslation } from "react-i18next";
import { useSessionQuery, useSessionReads } from "../../../SessionReadProvider";
import { Button } from "../../../design-system/Button";
import { Banner } from "../../../design-system/Feedback";
import InlineCandidate, { type InlineCandidateProps } from "../candidates/InlineCandidate";
import { readEntryDetails } from "./entryReads";

type Props = Omit<InlineCandidateProps, "target" | "focused"> & { unitId: string; locale: string };

/** The focused row and inspector share one full editor snapshot, never a preview-derived target. */
export default function FocusedCandidate({ unitId, locale, ...props }: Props) {
  const reads = useSessionReads(), { t } = useTranslation(undefined, { keyPrefix: "workbenchV2" });
  const query = useSessionQuery({ key: ["workbench-entry-details", unitId, locale], scopes: ["source", "translation", "resources", "review"],
    enabled: props.visible && !props.disabled, read: () => readEntryDetails(reads, unitId, locale) });
  if (query.isError) return <Banner tone="warning" action={<Button size="xs" disabled={props.disabled || query.isFetching} onClick={() => void query.refetch()}>{t("refresh")}</Button>}>{t("candidateUnavailableHelp")}</Banner>;
  if (!query.data) return <span role="status">{t("candidateLoading")}</span>;
  return <InlineCandidate {...props} target={query.data.target} focused disabled={props.disabled || query.isFetching} />;
}
