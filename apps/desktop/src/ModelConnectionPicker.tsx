import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { connectionConfigCurrent, connectionReadOptions, currentConnections, useApplicationQueryClient } from "./ApplicationReadProvider";
import { CommandFailureDetails, commandFailure } from "./CommandFailure";
import type { AiConfig } from "./aiCommands";
import type { ConnectionReadView } from "./connectionCommands";

interface Props {
  config: AiConfig;
  label: string;
  active: boolean;
  disabled: boolean;
  editSeq: number;
  onSelect: (view: ConnectionReadView | null, id: string, expectedEditSeq: number) => boolean;
  onOpenSettings?: () => void;
}
/** Named application facts choose defaults; the preparation owner chooses what
 * to copy and retains its own scope, sharing, budgets and original requests. */
export function ModelConnectionPicker({ config, label, active, disabled, editSeq, onSelect, onOpenSettings }: Props) {
  const { t } = useTranslation(), client = useApplicationQueryClient();
  const query = useQuery({ ...connectionReadOptions(), enabled: active }, client);
  const view = currentConnections(client), linked = config.connectionProfile != null;
  const current = linked && connectionConfigCurrent(view, config);
  const selected = current ? config.connectionProfile!.profileId : linked ? "captured" : "";
  const profiles = query.data?.snapshot.profiles.filter(profile => !profile.archived).slice().sort((a, b) => a.name.localeCompare(b.name)) ?? [];
  return <section className="model-connection-picker">
    <label className="field">{label}<select aria-label={label} disabled={disabled} value={selected} onChange={event => {
      const id = event.target.value;
      if (!id) onSelect(null, "", editSeq);
      else if (id !== "captured") { const confirmed = currentConnections(client); if (confirmed) onSelect(confirmed, id, editSeq); }
    }}>
      <option value="">{t("connections.once")}</option>
      {linked && !current ? <option value="captured" disabled>{t("connections.capturedChoice", { defaultValue: enUS.connections.capturedChoice, model: config.model })}</option> : null}
      {profiles.map(profile => <option key={profile.id} value={profile.id} disabled={!view}>{profile.name} · {profile.connection.model}</option>)}
    </select></label>
    <div className="execution-actions">
      <button type="button" className="secondary-button" disabled={query.isFetching} onClick={() => void client.fetchQuery(connectionReadOptions()).catch(() => {})}>{t("connections.refresh")}</button>
      {onOpenSettings ? <button type="button" className="secondary-button" disabled={disabled} onClick={onOpenSettings}>{t("connections.manage")}</button> : null}
    </div>
    <p>{t("connections.preparationHelp")}</p>
    {query.isFetching ? <p role="status">{t("connections.loading")}</p> : query.isError ? <div role="status"><p>{t("connections.readFailed")}</p><CommandFailureDetails failure={commandFailure(query.error)}/></div>
      : view && profiles.length === 0 ? <p>{t("connections.empty")}</p> : null}
    {linked ? <p role="status">{t(current ? "connections.selectionCurrent" : view ? "connections.selectionChanged" : "connections.selectionChecking")}</p> : null}
    {!linked ? <p>{t("connections.onceHelp")}</p> : null}
  </section>;
}

export function PreparationBudgetSummary({ config, perRequest = false }: { config: AiConfig; perRequest?: boolean }) {
  const { t } = useTranslation();
  const complete = [config.maxItems,config.maxRequests,config.concurrency,config.maxOutputTokens,config.maxRetries,config.timeoutSeconds].every(Number.isFinite);
  const message = !complete ? "incompleteBudget" : perRequest ? "requestSummary" : "invocationSummary";
  const sharing = config.shareTerms && config.shareContext ? "connections.sharingBoth" : config.shareTerms ? "connections.sharingTerms" : config.shareContext ? "connections.sharingContext" : "connections.sharingNone";
  return <section className="preparation-budget-summary" aria-label={t("connections.invocationSummaryTitle")}>
    <p>{t(`connections.${message}`, { defaultValue: enUS.connections[message], items: config.maxItems, requests: config.maxRequests, concurrency: config.concurrency, tokens: config.maxOutputTokens, retries: config.maxRetries, timeout: config.timeoutSeconds })}</p>
    <p>{t(sharing)}</p><p>{t("ai.costUnknown")}</p>
  </section>;
}
