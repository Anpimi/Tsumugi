import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useApplicationQueryClient } from "./ApplicationReadProvider";
import { chatGptCommands, type ChatGptAccountStatus, type ChatGptLoginView, type ChatGptModelCatalog } from "./ChatGptCommands";
import { CommandFailureDetails, commandFailure, failureReason, type CommandFailure } from "./CommandFailure";
import type { AiConnection } from "./connectionCommands";

const accountKey = ["application", "chatgpt", "account"] as const;
/** Local status is read only on request or while this panel's explicit login is
 * pending. The model catalog always requires a separate user action. */
export function ChatGptConnectionFields({ connection, disabled, onChange, modelInvalid = false }: {
  connection: AiConnection; disabled: boolean; onChange: (connection: AiConnection) => void; modelInvalid?: boolean;
}) {
  const { t } = useTranslation(), client = useApplicationQueryClient();
  const [pending, setPending] = useState<ChatGptLoginView | null>(null);
  const [stoppedLogin, setStoppedLogin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<CommandFailure | null>(null);
  const [catalog, setCatalog] = useState<ChatGptModelCatalog | null>(null);
  const [registration, setRegistration] = useState("");
  const alive = useRef(true), running = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const query = useQuery({ queryKey: accountKey, enabled: false, staleTime: 0, gcTime: 60_000,
    networkMode: "always", retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const status = await chatGptCommands.read();
      if (signal.aborted) throw new Error("ChatGPT account read cancelled");
      return status;
    } }, client);
  const status = query.data, account = status?.account;
  const login = pending ?? status?.login;
  const subscription = connection.tokenField === "chatgpt_subscription";
  const selected = !!account && account.id === connection.chatgptAccount;
  const models = catalog && catalog.account === connection.chatgptAccount ? catalog.models : null;
  const readFailure = query.isError ? commandFailure(query.error) : null;
  const storageUnavailable = [readFailure, failure].some(value => failureReason(value) === "chatgpt-secure-storage");
  function accept(status: ChatGptAccountStatus) { client.setQueryData(accountKey, status); }
  async function action(work: () => Promise<void>) {
    if (running.current || disabled) return;
    running.current = true; setBusy(true); setFailure(null);
    try { await client.cancelQueries({ queryKey: accountKey, exact: true }, { revert: false }); await work(); }
    catch (error) { if (alive.current) setFailure(commandFailure(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    if (!pending || busy || stoppedLogin === pending.id) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const remaining = pending.expiresAt - Date.now();
      if (remaining <= 0) { setStoppedLogin(pending.id); return; }
      timer = setTimeout(() => { void poll(); }, Math.min(1000, remaining));
    };
    const poll = async () => {
      if (pending.expiresAt <= Date.now()) { setStoppedLogin(pending.id); return; }
      const result = await query.refetch();
      if (!active || running.current) return;
      if (result.isSuccess && result.data.login?.id !== pending.id) { setPending(null); return; }
      schedule();
    };
    schedule();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [pending, busy, stoppedLogin, query.refetch]);
  return <section className="chatgpt-account connection-notice" aria-label={t("connections.chatgpt.title")} aria-busy={busy}>
    <h3>{t("connections.chatgpt.title")}</h3><p>{t("connections.chatgpt.help")}</p>
    <div className="execution-actions">
      <button type="button" disabled={disabled || busy || query.isFetching} onClick={() => {
        const id = pending?.id;
        void query.refetch().then(result => {
          if (alive.current && id && result.isSuccess && result.data.login?.id !== id) setPending(before => before?.id === id ? null : before);
        });
      }}>{t("connections.chatgpt.check")}</button>
      <button type="button" disabled={disabled || busy || query.isFetching || !!login} onClick={() => { void action(async () => {
        const login = await chatGptCommands.begin(null); if (alive.current) setPending(login);
      }); }}>{t("connections.chatgpt.signIn")}</button>
      {account ? <button type="button" disabled={disabled || busy || query.isFetching || !!login} onClick={() => { const id = account.id; void action(async () => {
        const next = await chatGptCommands.logout(id); if (alive.current) { accept(next); setCatalog(null); }
      }); }}>{t("connections.chatgpt.logout")}</button> : null}
    </div>
    {status?.registrations.length ? <div>
      <label htmlFor="chatgpt-registration">{t("connections.chatgpt.returningAccount")}</label>
      <select id="chatgpt-registration" disabled={disabled || busy || !!login} value={registration} onChange={event => setRegistration(event.target.value)}>
        <option value="">{t("connections.chatgpt.chooseAccount")}</option>
        {status.registrations.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
      </select>
      <button type="button" disabled={disabled || busy || query.isFetching || !!login || !status.registrations.some(value => value.id === registration)} onClick={() => { void action(async () => {
        const login = await chatGptCommands.begin(registration); if (alive.current) setPending(login);
      }); }}>{t("connections.chatgpt.continue")}</button>
    </div> : null}
    {query.isFetching ? <p role="status">{t("connections.chatgpt.checking")}</p> : null}
    {account ? <p role="status">{t("connections.chatgpt.signedIn", { account: account.label })}</p>
      : status ? <p>{t("connections.chatgpt.signedOut")}</p> : <p>{t("connections.chatgpt.unchecked")}</p>}
    {login ? <div role="status"><p>{t(pending && stoppedLogin !== pending.id ? "connections.chatgpt.pending" : "connections.chatgpt.pendingPaused")}</p><p>{t("connections.chatgpt.closeHelp")}</p>
      <button type="button" disabled={disabled || busy} onClick={() => { const id = login.id; void action(async () => {
        const next = await chatGptCommands.cancel(id); if (alive.current) { accept(next); setPending(null); }
      }); }}>{t("connections.chatgpt.cancel")}</button></div> : null}
    {status?.issue ? <p role="status">{t(`connections.chatgpt.issues.${status.issue}`)}</p> : null}
    {query.isError ? <div role="alert"><p>{t("connections.chatgpt.readFailed")}</p><CommandFailureDetails failure={readFailure}/></div> : null}
    {failure ? <div role="alert"><p>{t("connections.chatgpt.actionFailed")}</p><CommandFailureDetails failure={failure}/></div> : null}
    {storageUnavailable ? <p>{t("connections.chatgpt.storageHelp")}</p> : null}
    <p>{t("connections.chatgpt.logoutHelp")}</p>
    {subscription ? <>
      <p>{t(selected ? "connections.chatgpt.selected" : "connections.chatgpt.accountUnavailable", { account: account?.label ?? "" })}</p>
      {account && !selected ? <button type="button" disabled={disabled || busy} onClick={() => onChange({ ...connection, chatgptAccount: account.id, model: "" })}>{t("connections.chatgpt.useAccount", { account: account.label })}</button> : null}
      <p>{t("connections.chatgpt.accountChoiceHelp")}</p>
      <button type="button" disabled={disabled || busy || !selected} onClick={() => { const id = connection.chatgptAccount; if (!id) return; void action(async () => {
        const result = await chatGptCommands.models(id);
        if (result.account !== id) throw new Error("Invalid ChatGPT catalog account acknowledgement");
        if (alive.current) setCatalog(result);
      }); }}>{t("connections.chatgpt.refreshModels")}</button>
      <label htmlFor="connection-chatgpt-model">{t("connections.model")}</label>
      <select id="connection-chatgpt-model" value={connection.model} disabled={disabled || !models} aria-invalid={modelInvalid || undefined} aria-describedby={modelInvalid ? "connection-model-error" : undefined} onChange={event => onChange({ ...connection, model: event.target.value })}>
        <option value="">{t("connections.chatgpt.chooseModel")}</option>
        {connection.model && !models?.some(model => model.id === connection.model) ? <option value={connection.model}>{t("connections.chatgpt.retainedModel", { model: connection.model })}</option> : null}
        {models?.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select>
      <p>{models?.length === 0 ? t("connections.chatgpt.noModels") : t("connections.chatgpt.modelHelp")}</p>
      <p>{t("connections.chatgpt.budgetHelp")}</p>
    </> : null}
  </section>;
}
