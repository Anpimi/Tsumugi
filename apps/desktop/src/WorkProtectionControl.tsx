import { useWorkbenchCommands, type TranslationProtectionCommandPayload, type TranslationProtectionPendingCommandPayload, type CommandAvailability } from "./workbenchCommands";
import type { WorkProtectionSession, ProtectionRequest, ProtectionBasis } from "./WorkProtectionSession";
import { protectionKey } from "./WorkProtectionSession";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { workPlanCommands } from "./workPlanCommands";

export interface WorkProtectionControlProps {
  session: WorkProtectionSession;
  context: SessionRequest;
  target: { unitId: string; sourceRevisionId: string; key: string; sourceText?: string };
  locale: string;
  selectionId: string | null;
  selectionText?: string | null;
  open: boolean;
  disabled: boolean;
  draftBlocked: boolean;
  run: (work: (current: () => boolean) => Promise<void>) => Promise<void>;
  onBlockedChange: (blocked: boolean) => void;
  onEditingReadyChange?: (scope: string, ready: boolean) => void;
  onAutomaticProtectionStart?: (basis: ProtectionBasis) => ((current: () => boolean) => Promise<void>) | null;
  onReturnFocus?: () => boolean;
}

export function editingProtectionScope(context: SessionRequest, target: { unitId: string; sourceRevisionId: string }, locale: string) {
  return JSON.stringify([context.projectId, context.sessionToken, target.unitId, locale, target.sourceRevisionId]);
}

function scopeIdentity(request: Pick<ProtectionRequest, "projectId" | "sessionToken" | "unitId" | "locale" | "sourceRevisionId" | "selectionId">) {
  return JSON.stringify([request.projectId, request.sessionToken, request.unitId, request.locale,
    request.sourceRevisionId, request.selectionId]);
}
function protectionIdentity(request: Pick<ProtectionRequest, "projectId" | "sessionToken" | "unitId" | "locale">) {
  return JSON.stringify([request.projectId, request.sessionToken, request.unitId, request.locale]);
}

/** Current reads and the release dialog consume the stable translation protection owner. */
export function WorkProtectionControl({ context, session, target, locale, selectionId, selectionText, open, disabled,
  draftBlocked, run, onBlockedChange, onEditingReadyChange, onAutomaticProtectionStart, onReturnFocus }: WorkProtectionControlProps) {
  const { t } = useTranslation();
  const reads = useSessionReads(), registry = useWorkbenchCommands();
  const commandScope = { ...context, area: "translation" as const };
  const [release, setRelease] = useState<ProtectionBasis | null>(null);
  const pending = session.state.pending;
  const mounted = useRef(false);
  const inFlight = session.inFlight;
  const section = useRef<HTMLElement>(null);
  const focusAfterRelease = useRef(false);
  const attemptedEdit = session.attemptedEdit;
  const automaticBasis = useRef<ProtectionBasis | null>(null);
  const editingScope = editingProtectionScope(context, target, locale);
  const scope = scopeIdentity({ ...context, ...target, locale, selectionId });
  const protectionScope = protectionIdentity({ ...context, unitId: target.unitId, locale });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onBlockedChange(pending !== null); }, [pending !== null, onBlockedChange]);
  const query = useSessionQuery({
    key: protectionKey(target.unitId, locale, target.sourceRevisionId, selectionId),
    scopes: ["translation", "source"], enabled: open,
    read: () => workPlanCommands.protection({ ...context, unitId: target.unitId, locale }),
  });
  const latest = useRef({ scope, protectionScope, open, draftBlocked, refetch: query.refetch });
  useLayoutEffect(() => { latest.current = { scope, protectionScope, open, draftBlocked, refetch: query.refetch }; },
    [scope, protectionScope, open, draftBlocked, query.refetch]);
  const queryState = reads.client.getQueryState(reads.key(protectionKey(target.unitId, locale, target.sourceRevisionId, selectionId)));
  const ready = query.data !== undefined && !query.isFetching && !query.error && queryState?.status === "success"
    && queryState.fetchStatus === "idle" && !queryState.isInvalidated && queryState.data === query.data;
  const canProtect = ready && !query.data?.protected && !disabled && !session.blocked();
  const canRelease = ready && query.data?.protected && !disabled && !draftBlocked && !session.blocked();
  const releaseCurrent = release !== null && scopeIdentity(release.request) === scope
    && release.request.expectedRevision === query.data?.revision;

  useEffect(() => {
    if (!onEditingReadyChange) return;
    if (!open || pending) onEditingReadyChange(editingScope, false);
    else if (ready) onEditingReadyChange(editingScope, query.data?.protected === true);
    // Retain a confirmed protection across an ordinary save/refetch. Locking
    // an existing editor during those reads would interrupt newer input/IME.
  }, [editingScope, open, pending !== null, ready, query.data?.protected, onEditingReadyChange]);

  useEffect(() => {
    if (!onEditingReadyChange || !open || disabled || pending || !ready
      || attemptedEdit.current === scope || inFlight.current) return;
    attemptedEdit.current = scope;
    if (!query.data?.protected) {
      const basis = capture();
      if (basis) {
        // Only this synchronous dispatch can capture an automatic continuation.
        // Explicit protection and recovery use their original separate paths.
        automaticBasis.current = basis;
        registry.dispatch("translation.protect-work", commandScope, { kind: "translation-protection", basis, protected: true });
        automaticBasis.current = null;
      }
    }
    // Opening the editor establishes protection once. Explicit release keeps
    // the editor read-only until the user protects it again, without a loop.
  }, [scope, open, disabled, pending !== null, ready, query.data?.protected, onEditingReadyChange]);

  function capture(): ProtectionBasis | null {
    const current = reads.client.getQueryState(reads.key(protectionKey(target.unitId, locale, target.sourceRevisionId, selectionId)));
    if (!query.data || !ready || current?.status !== "success" || current.fetchStatus !== "idle" || current.isInvalidated || current.data !== query.data) return null;
    return { key: target.key, sourceText: target.sourceText ?? null, selectionText: selectionText ?? null, request: { ...context, unitId: target.unitId, locale,
      sourceRevisionId: target.sourceRevisionId, selectionId, expectedRevision: query.data.revision } };
  }

  async function refreshAfter(request: ProtectionBasis["request"], current: () => boolean) {
    if (mounted.current && current() && latest.current.open && latest.current.protectionScope === protectionIdentity(request)) {
      const refreshed = await latest.current.refetch(); if (refreshed.error) throw refreshed.error;
    }
  }
  async function change(basis: ProtectionBasis, protectedValue: boolean) {
    if (session.blocked() || disabled || (!protectedValue && draftBlocked)) return;
    const automatic = protectedValue && automaticBasis.current === basis;
    const confirmAutomatic = automatic ? onAutomaticProtectionStart?.(basis) : null;
    await run(async current => {
      const proof = () => {
        const checked = reads.client.getQueryState<import("./workPlanCommands").WorkProtection>(reads.key(protectionKey(basis.request.unitId, basis.request.locale, basis.request.sourceRevisionId, basis.request.selectionId ?? null)));
        return mounted.current && current() && latest.current.scope === scopeIdentity(basis.request)
          && (protectedValue || !latest.current.draftBlocked) && checked?.status === "success" && checked.fetchStatus === "idle"
          && !checked.isInvalidated && checked.data?.revision === basis.request.expectedRevision;
      };
      if (!protectedValue) { focusAfterRelease.current = true; setRelease(null); }
      const receipt = await session.change(basis, protectedValue, proof);
      await refreshAfter(basis.request, current);
      if (automatic && receipt?.protected && mounted.current && current() && latest.current.open
        && latest.current.scope === scopeIdentity(basis.request)) await confirmAutomatic?.(current);
    });
  }
  async function retry() {
    const original = session.current().pending;
    if (original?.phase !== "unknown" || inFlight.current || disabled || (!original.request.protected && draftBlocked)) return;
    await run(async current => {
      await session.retry(() => mounted.current && current() && (original.request.protected || !latest.current.draftBlocked));
      await refreshAfter(original.request, current);
    });
  }

  function baseAvailability(): CommandAvailability {
    return !open || reads.retired ? { enabled: false, reason: "hidden" } : disabled || inFlight.current ? { enabled: false, reason: "busy" } : { enabled: true };
  }
  function protectionAvailability(payload?: TranslationProtectionCommandPayload): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    const captured = capture();
    return payload && captured && !session.blocked() && JSON.stringify(payload.basis) === JSON.stringify(captured)
      && (payload.protected ? query.data?.protected === false : query.data?.protected === true && !draftBlocked
        && release !== null && JSON.stringify(release) === JSON.stringify(payload.basis))
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function pendingAvailability(payload?: TranslationProtectionPendingCommandPayload): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    const original = session.current().pending;
    return payload && original?.phase === "unknown" && JSON.stringify(original.request) === JSON.stringify(payload.request) && original.key === payload.key
      && (original.request.protected || !draftBlocked) ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  useLayoutEffect(() => {
    const metadata = { category: "translation" as const, scope: commandScope, binding: null, risk: "writes-translation" as const };
    const removals = [
      registry.register({ ...metadata, id: "translation.protect-work", nameKey: "protection.protect", payloadKind: "translation-protection", confirmation: "none",
        availability: protectionAvailability, handler: payload => { void change(payload.basis, payload.protected); } }),
      registry.register({ ...metadata, id: "translation.release-work", nameKey: "protection.confirmRelease", payloadKind: "translation-protection", confirmation: "required",
        availability: protectionAvailability, handler: payload => { void change(payload.basis, payload.protected); } }),
      registry.register({ ...metadata, id: "translation.retry-protection", nameKey: "protection.retry", payloadKind: "translation-protection-pending", confirmation: "none",
        availability: pendingAvailability, handler: () => { void retry(); } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  if (!open) return null;
  return <section className="work-protection" ref={section} tabIndex={-1} aria-label={t("protection.title")}>
    <p role="status">{query.isPending || query.isFetching ? t("protection.loading") : query.error
      ? t("protection.unavailable") : t(query.data?.protected ? "protection.protected" : "protection.unprotected")}</p>
    {query.error ? <p role="alert">{t("protection.readFailed")} <button type="button" className="text-button"
      disabled={disabled || query.isFetching} onClick={() => void run(async current => {
        if (!current()) return;
        const refreshed = await query.refetch();
        if (refreshed.error) throw refreshed.error;
      })}>{t("protection.refresh")}</button></p> : null}
    {draftBlocked ? <p>{t("protection.draftBlocked")}</p> : null}
    {pending ? <p role="status">{pending.phase === "unknown"
      ? t("protection.unknown", { key: pending.key, locale: pending.request.locale }) : t("protection.pending")}</p> : null}
    <div className="form-actions">
      <button type="button" className="secondary-button" disabled={!canProtect} onClick={() => {
        const basis = capture(); if (basis) registry.dispatch("translation.protect-work", commandScope, { kind: "translation-protection", basis, protected: true });
      }}>{t("protection.protect")}</button>
      <Dialog.Root open={release !== null} onOpenChange={value => {
        if (!value) setRelease(null);
        else if (canRelease) setRelease(capture());
      }}>
        <Dialog.Trigger asChild><button type="button" className="secondary-button" disabled={!canRelease}>
          {t("protection.release")}
        </button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog"
          onCloseAutoFocus={event => {
            if (onReturnFocus?.()) { focusAfterRelease.current = false; event.preventDefault(); return; }
            // Confirming disables the release trigger. Keep keyboard focus in
            // the protection region while its committed state refreshes.
            if (focusAfterRelease.current) {
              focusAfterRelease.current = false;
              event.preventDefault(); section.current?.focus();
            }
          }}>
          <Dialog.Title>{t("protection.releaseTitle")}</Dialog.Title>
          <Dialog.Description>{t("protection.releaseHelp", { key: release?.key ?? "", locale: release?.request.locale ?? "" })}</Dialog.Description>
          {release ? <>
            <p><code>{release.key}</code> <span>{release.request.locale}</span></p>
            {release.sourceText !== null ? <><h3>{t("translation.sourceText")}</h3><pre className="ai-text">{release.sourceText}</pre></> : null}
            <h3>{t("translation.current")}</h3><pre className="ai-text">{release.selectionText ?? t("protection.noSelection")}</pre>
            <details><summary>{t("protection.evidence")}</summary><dl style={{ overflowWrap: "anywhere" }}>
              <dt>{t("protection.sourceRevision")}</dt><dd><code>{release.request.sourceRevisionId}</code></dd>
              <dt>{t("protection.selection")}</dt><dd><code>{release.request.selectionId ?? t("protection.noSelection")}</code></dd>
              <dt>{t("protection.revision")}</dt><dd>{release.request.expectedRevision}</dd>
            </dl></details>
            {!releaseCurrent ? <p role="alert">{t("protection.scopeChanged")}</p> : null}
            {draftBlocked ? <p>{t("protection.draftBlocked")}</p> : null}
            <div className="form-actions">
              <Dialog.Close asChild><button type="button" className="secondary-button">{t("protection.cancel")}</button></Dialog.Close>
              <button type="button" className="primary-button" disabled={!canRelease || !releaseCurrent}
                onClick={() => registry.dispatch("translation.release-work", commandScope, { kind: "translation-protection", basis: release, protected: false })}>{t("protection.confirmRelease")}</button>
            </div>
          </> : null}
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      {pending?.phase === "unknown" ? <button type="button" className="secondary-button"
        disabled={disabled || (!pending.request.protected && draftBlocked)} onClick={() => { if (pending) registry.dispatch("translation.retry-protection", commandScope, { kind: "translation-protection-pending", request: pending.request, key: pending.key }); }}>
        {t("protection.retry")}
      </button> : null}
    </div>
  </section>;
}
