import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { CommandFailureDetails, failureReason } from "./CommandFailure";
import { useSessionReads } from "./SessionReadProvider";
import { mcpShareStatusKey, useMcpSharing, validMcpRecipientLabel } from "./McpSharingSession";
import type { McpShareView } from "./mcpCommands";
import "./McpSharingPanel.css";

/** This presentation never owns or persists the recipient credential. */
export function McpSharingPanel() {
  const owner = useMcpSharing(), { state } = owner, reads = useSessionReads(), { t, i18n } = useTranslation();
  const [showConfiguration, setShowConfiguration] = useState(false), [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const [expanded, setExpanded] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null), operation = state.operation;
  const key = operation ? mcpShareStatusKey(operation) : ["mcp-share-status", "none"], identity = JSON.stringify(key);
  const subscribe = useCallback((notify: () => void) => reads.client.getQueryCache().subscribe(notify), [reads]);
  const snapshot = useCallback(() => reads.client.getQueryData<McpShareView>(reads.key(key)), [reads, identity]);
  const view = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { if (state.target) setExpanded(true); }, [state.target]);
  useEffect(() => { if (state.target && expanded) heading.current?.focus({ preventScroll: true }); }, [state.target, expanded]);
  useEffect(() => { setShowConfiguration(false); }, [operation?.preparation.identity.shareId, operation?.closed]);
  useEffect(() => { if (!expanded || !visible) setShowConfiguration(false); }, [expanded, visible]);
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== "hidden"); document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed); }, []);
  useEffect(() => {
    if (!visible || !expanded || reads.retired || !operation || operation.closed || state.reading || state.readFailed
      || !(state.busy === "authorizing" || operation.uncertain || state.revocation?.pending || state.revocation?.uncertain
        || view?.phase === "awaiting-pairing" || view?.phase === "connected" || view?.phase === "closing")
      || view?.phase === "closed" && view.callbacksDrained) return;
    const timer = window.setTimeout(() => { void owner.refresh(); }, 1000);
    return () => window.clearTimeout(timer);
  }, [visible, expanded, reads, operation?.preparation.identity.shareId, operation?.authorization?.actionId, operation?.closed,
    state.reading, state.readFailed, state.busy, operation?.uncertain, state.revocation?.pending, state.revocation?.uncertain, view?.phase, view?.callbacksDrained]);
  if (!state.target) return null;
  const prepared = operation?.prepared, preview = prepared?.preview, payload = preview?.payload;
  const safeClosed = !operation || operation.closed;
  const ready = !!preview && !operation?.authorization && !operation?.closed && !state.stale && operation?.editSeq === state.editSeq;
  const reason = failureReason(state.failure), failureMessage = reason === "mcp-share-selection-source" ? "mcpSharing.selectionSource"
    : reason === "mcp-share-current" ? "mcpSharing.currentChanged"
    : typeof state.failure !== "string" && state.failure?.code === "limit-exceeded" ? "mcpSharing.limitExceeded" : "mcpSharing.failed";
  const expiry = view?.expiresAtMs == null ? null : new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(Number(view.expiresAtMs)));
  return <section className="mcp-sharing-panel" aria-labelledby="mcp-share-heading"><details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t("mcpSharing.title")}</summary><div className="mcp-sharing-content">
    <h2 id="mcp-share-heading" ref={heading} tabIndex={-1}>{t("mcpSharing.title")}</h2>
    <p>{t("mcpSharing.help")}</p><p>{t("mcpSharing.entry", { key: state.target.key, locale: state.target.locale })}</p>
    <label className="field"><span>{t("mcpSharing.recipient")}</span><input value={state.recipientLabel} maxLength={128}
      onChange={event => owner.edit({ recipientLabel: event.target.value })} aria-invalid={state.recipientLabel !== "" && !validMcpRecipientLabel(state.recipientLabel)} aria-describedby="mcp-share-recipient-help" /></label>
    <p id="mcp-share-recipient-help">{t("mcpSharing.recipientHelp")}</p>
    {state.recipientLabel !== "" && !validMcpRecipientLabel(state.recipientLabel) ? <p role="alert">{t("mcpSharing.recipientInvalid")}</p> : null}
    <label className="checkbox-label"><input type="checkbox" checked={state.shareTerms} onChange={event => owner.edit({ shareTerms: event.target.checked })} />{t("mcpSharing.terms")}</label>
    <label className="checkbox-label"><input type="checkbox" checked={state.shareContext} onChange={event => owner.edit({ shareContext: event.target.checked })} />{t("mcpSharing.context")}</label>
    <p>{t("mcpSharing.optionalHelp")}</p>
    {state.stale ? <p role="status">{t("mcpSharing.stale")}</p> : null}
    {operation && operation.editSeq !== state.editSeq ? <p role="status">{t("mcpSharing.changedInput")}</p> : null}
    <div className="execution-actions"><button type="button" className="secondary-button" disabled={!!state.busy || !!state.revocation?.pending || !safeClosed || !validMcpRecipientLabel(state.recipientLabel)}
      onClick={() => { void owner.prepare(); }}>{t("mcpSharing.preview")}</button></div>
    {state.busy ? <p role="status">{t(state.busy === "preparing" ? "mcpSharing.preparing" : "mcpSharing.authorizing")}</p> : null}
    {preview && payload && prepared ? <section aria-label={t("mcpSharing.previewTitle")}>
      <h3>{t("mcpSharing.previewTitle")}</h3>
      <p>{t("mcpSharing.recipient")}: {prepared.preparation.recipientLabel}</p>
      <h4>{t("mcpSharing.source")}</h4><pre>{payload.source.text === "" ? t("mcpSharing.empty") : payload.source.text}</pre>
      <h4>{t("mcpSharing.translation")}</h4>{payload.translation ? <pre>{payload.translation.text === "" ? t("mcpSharing.empty") : payload.translation.text}</pre> : <p>{t("mcpSharing.noTranslation")}</p>}
      <h4>{t("mcpSharing.terms")}</h4>{!prepared.preparation.selection.shareTerms ? <p>{t("mcpSharing.termsExcluded")}</p>
        : payload.terms?.length ? <ul>{payload.terms.map((term, index) => <li key={`${term.source}:${index}`}><p>{term.source}</p>
          {term.selected ? <p>{term.selected.source} → {term.selected.target}</p> : <p>{t("resource.conflict")}</p>}
          {term.conflicting.length ? <ul>{term.conflicting.map(item => <li key={item.revisionId}>{item.source} → {item.target}</li>)}</ul> : null}
        </li>)}</ul> : <p>{t("mcpSharing.noTerms")}</p>}
      <h4>{t("mcpSharing.context")}</h4>{!prepared.preparation.selection.shareContext ? <p>{t("mcpSharing.contextExcluded")}</p>
        : payload.manualContext ? <pre>{payload.manualContext.text === "" ? t("mcpSharing.empty") : payload.manualContext.text}</pre> : <p>{t("mcpSharing.noContext")}</p>}
      <details><summary>{t("mcpSharing.snapshot")}</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>
      <p>{t("mcpSharing.duration")}</p><p>{t("mcpSharing.bounds")}</p><p id="mcp-share-disclosure">{t("mcpSharing.disclosure")}</p>
      <label className="checkbox-label"><input type="checkbox" checked={state.consent} disabled={!ready || !!state.busy} aria-describedby="mcp-share-disclosure"
        onChange={event => owner.setConsent(event.target.checked)} />{t("mcpSharing.consent")}</label>
      <div className="execution-actions"><button type="button" className="primary-button" disabled={!ready || !state.consent || !!state.busy || !!state.revocation?.pending}
        onClick={() => { void owner.authorize(); }}>{t("mcpSharing.authorize")}</button></div>
    </section> : null}
    {operation?.uncertain ? <p role="status">{t("mcpSharing.unknown")}</p> : null}
    {state.revocation?.uncertain ? <p role="status">{t("mcpSharing.revokeUnknown")}</p> : null}
    {state.revocation?.pending ? <p role="status">{t("mcpSharing.revoking")}</p> : null}
    {state.readFailed ? <p role="alert">{t("mcpSharing.readFailed")}</p> : null}
    {state.failure ? <div role="alert"><p>{t(failureMessage)}</p><CommandFailureDetails failure={state.failure} /></div> : null}
    {view ? <><p role="status">{t("mcpSharing.status", { status: t(`mcpSharing.statuses.${view.phase}`) })}</p>{expiry ? <p>{t("mcpSharing.expires", { expiry })}</p> : null}</> : null}
    {operation ? <div className="execution-actions"><button type="button" className="secondary-button"
      onClick={() => { void (state.reading ? owner.retryRead() : owner.refresh()); }}>{t(state.reading ? "mcpSharing.replaceRead" : state.readFailed ? "mcpSharing.retryRead" : "mcpSharing.check")}</button>
      {state.reading ? <p>{t("mcpSharing.replaceReadHelp")}</p> : null}
      <button type="button" className="secondary-button" disabled={operation.closed || !!state.revocation?.pending}
        onClick={() => { setShowConfiguration(false); void owner.revoke(); }}>{t(operation.authorization ? "mcpSharing.revoke" : "mcpSharing.closeRequest")}</button>
    </div> : null}
    {operation?.authorization && !operation.closed && !operation.configuration ? <><p>{t("mcpSharing.configurationUnavailable")}</p><p>{t("mcpSharing.recoverHelp")}</p>
      <button type="button" className="secondary-button" disabled={!!state.busy || !!state.revocation?.pending || !!state.revocation}
        onClick={() => { void owner.authorize(true); }}>{t("mcpSharing.recover")}</button></> : null}
    {operation?.configuration && !operation.closed && !state.revocation ? <section aria-label={t("mcpSharing.configuration")}>
      <h3>{t("mcpSharing.configuration")}</h3><p>{t("mcpSharing.secretHelp")}</p>
      <button type="button" className="secondary-button" aria-expanded={showConfiguration} onClick={() => setShowConfiguration(value => !value)}>{t(showConfiguration ? "mcpSharing.hideSecret" : "mcpSharing.showSecret")}</button>
      {showConfiguration ? <label className="field"><span>{t("mcpSharing.configuration")}</span><textarea rows={9} readOnly spellCheck={false} autoComplete="off" value={JSON.stringify(operation.configuration, null, 2)} /></label> : null}
    </section> : null}
    <p>{t("mcpSharing.closeHelp")}</p><p>{t("mcpSharing.retained")}</p>
    <button type="button" className="secondary-button" disabled={!!state.revocation?.pending || !safeClosed} onClick={() => owner.close()}>{t("mcpSharing.close")}</button>
  </div></details></section>;
}
