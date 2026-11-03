import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AiConnection } from "./connectionCommands";
import { useApplicationQueryClient } from "./ApplicationReadProvider";
import { apiKeyCommands, apiKeyReadKey, apiKeyHistoryKey } from "./apiKeyCommands";
import { Button } from "./design-system/Button";
import { Field, TextInput } from "./design-system/Field";
import { Banner } from "./design-system/Feedback";
import fieldStyles from "./design-system/Field.module.css";

export function ConnectionKeyFields({ connection, profileId, secret, onSecret, onChange, onRemove, disabled, removeDisabled, visible, updating }: {
  profileId: string | null;
  connection: AiConnection; secret: string; onSecret: (value: string) => void;
  onChange: (connection: AiConnection) => void; onRemove: (reference: string) => void;
  disabled: boolean; removeDisabled: boolean; visible: boolean; updating: boolean;
}) {
  const { t } = useTranslation();
  const client = useApplicationQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const reference = connection.credentialReference;
  const history = useQuery({ queryKey: apiKeyHistoryKey(profileId ?? ""), enabled: visible && historyOpen && !!profileId,
    queryFn: async ({ signal }) => { if (!profileId) throw new Error("No saved connection selected");
      const result = await apiKeyCommands.history(profileId); if (signal.aborted) throw new Error("Key-history read cancelled"); return result; },
    networkMode: "always", retry: false, staleTime: 0, gcTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false }, client);
  const previous = history.data?.filter(key => key.reference !== reference && key.availability === "available") ?? [];
  const query = useQuery({ queryKey: apiKeyReadKey(reference ?? ""), enabled: visible && !!reference,
    queryFn: async ({ signal }) => { if (!reference) throw new Error("No system-key reference selected");
      const result = await apiKeyCommands.read(reference); if (signal.aborted) throw new Error("Key-status read cancelled"); return result; }, networkMode: "always", retry: false,
    staleTime: 0, gcTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false }, client);
  return <>
    <Field id="connection-key-source" label={t("connections.keySource")}>
      <select className={fieldStyles.input} value={reference ? "keychain" : "environment"} disabled={disabled} onChange={event => {
        onSecret("");
        if (event.target.value === "keychain") onChange({ ...connection, credentialEnv: "", credentialReference: crypto.randomUUID() });
        else { const next = { ...connection, credentialEnv: "OPENAI_API_KEY" }; delete next.credentialReference; onChange(next); }
      }}><option value="environment">{t("connections.keyEnvironment")}</option><option value="keychain">{t("connections.keySystem")}</option></select>
    </Field>
    {reference ? <>
      <Field id="connection-key-input" label={t("connections.keyInput")} description={t("connections.keyInputHelp")}>
        <TextInput type="password" value={secret} autoComplete="new-password" autoCapitalize="none" spellCheck={false}
          disabled={disabled || query.data?.availability === "unsupported-platform" || query.isError} onChange={event => onSecret(event.target.value)}/>
      </Field>
      {query.isFetching || updating ? <p role="status">{t("connections.keyChecking")}</p> : query.isError ? <Banner tone="error" role="alert">{t("connections.keyReadFailed")}</Banner>
        : query.data ? <p role="status">{t(query.data.availability === "available" ? "connections.keyAvailable" : query.data.availability === "missing" ? "connections.keyMissing" : "connections.keyUnsupported")}</p> : null}
      <Button type="button" disabled={disabled || query.isFetching} onClick={() => void query.refetch()}>{t("connections.keyRefresh")}</Button>
      {query.isSuccess && !query.isFetching && !updating && query.data.availability === "available" ? <>
        <p>{t("connections.keyRemoveHelp")}</p>
        <Button type="button" variant="danger" disabled={disabled || removeDisabled} onClick={() => onRemove(reference)}>{t("connections.keyRemove")}</Button>
      </> : null}
    </> : <Field id="connection-credentialEnv" label={t("connections.credentialEnv")} description={t("connections.credentialHelp")}>
      <TextInput value={connection.credentialEnv} disabled={disabled} autoCapitalize="none" spellCheck={false}
        onChange={event => onChange({ ...connection, credentialEnv: event.target.value })}/>
    </Field>}
    {profileId ? <details onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>{t("connections.keyHistory")}</summary><p>{t("connections.keyHistoryHelp")}</p>
      {history.isError ? <Banner tone="error" role="alert">{t("connections.keyReadFailed")}</Banner> : null}
      <Button type="button" disabled={disabled || history.isFetching} onClick={() => void history.refetch()}>{t("connections.keyHistoryRefresh")}</Button>
      {previous.map((key, index) => <Button key={key.reference} type="button" variant="danger" disabled={disabled || removeDisabled || history.isFetching || history.isError}
        onClick={() => onRemove(key.reference)}>{t("connections.keyHistoryRemove", { number: String(index + 1) })}</Button>)}
    </details> : null}
  </>;
}
