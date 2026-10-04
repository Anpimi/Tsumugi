import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { workPlanCommands } from "./workPlanCommands";

type ProtectionRequest = Parameters<typeof workPlanCommands.setProtection>[0];
interface ProtectionBasis {
  request: Omit<ProtectionRequest, "actionId" | "protected" | "confirmedRelease">;
  key: string;
  sourceText: string | null;
  selectionText: string | null;
}
interface PendingProtection {
  request: ProtectionRequest;
  key: string;
  phase: "pending" | "unknown";
}
export interface WorkProtectionControlProps {
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
}

export function editingProtectionScope(context: SessionRequest, target: { unitId: string; sourceRevisionId: string }, locale: string) {
  return JSON.stringify([context.projectId, context.sessionToken, target.unitId, locale, target.sourceRevisionId]);
}

function protectionKey(unitId: string, locale: string, sourceRevisionId: string, selectionId: string | null) {
  return ["work-protection", unitId, locale, sourceRevisionId, selectionId];
}
function scopeIdentity(request: Pick<ProtectionRequest, "projectId" | "sessionToken" | "unitId" | "locale" | "sourceRevisionId" | "selectionId">) {
  return JSON.stringify([request.projectId, request.sessionToken, request.unitId, request.locale,
    request.sourceRevisionId, request.selectionId]);
}
function protectionIdentity(request: Pick<ProtectionRequest, "projectId" | "sessionToken" | "unitId" | "locale">) {
  return JSON.stringify([request.projectId, request.sessionToken, request.unitId, request.locale]);
}

/** The parent must retain this controller and guard navigation while blocked. */
export function WorkProtectionControl({ context, target, locale, selectionId, selectionText, open, disabled,
  draftBlocked, run, onBlockedChange, onEditingReadyChange }: WorkProtectionControlProps) {
  const { t } = useTranslation();
  const reads = useSessionReads();
  const [release, setRelease] = useState<ProtectionBasis | null>(null);
  const [pending, setPending] = useState<PendingProtection | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const section = useRef<HTMLElement>(null);
  const focusAfterRelease = useRef(false);
  const attemptedEdit = useRef<string | null>(null);
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
  useEffect(() => { latest.current = { scope, protectionScope, open, draftBlocked, refetch: query.refetch }; },
    [scope, protectionScope, open, draftBlocked, query.refetch]);
  const ready = query.data !== undefined && !query.isFetching && !query.error;
  const canProtect = ready && !query.data?.protected && !disabled && !pending;
  const canRelease = ready && query.data?.protected && !disabled && !draftBlocked && !pending;
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
      if (basis) void change(basis, true);
    }
    // Opening the editor establishes protection once. Explicit release keeps
    // the editor read-only until the user protects it again, without a loop.
  }, [scope, open, disabled, pending !== null, ready, query.data?.protected, onEditingReadyChange]);

  function capture(): ProtectionBasis | null {
    if (!query.data || !ready) return null;
    return { key: target.key, sourceText: target.sourceText ?? null, selectionText: selectionText ?? null, request: { ...context, unitId: target.unitId, locale,
      sourceRevisionId: target.sourceRevisionId, selectionId, expectedRevision: query.data.revision } };
  }

  async function submit(request: ProtectionRequest, key: string, current: () => boolean) {
    setPending({ request, key, phase: "pending" });
    try {
      await workPlanCommands.setProtection(request);
    } catch (error) {
      if (mounted.current) setPending(hasUnknownOutcome(error) ? { request, key, phase: "unknown" } : null);
      throw error;
    }
    if (mounted.current) setPending(value => value?.request.actionId === request.actionId ? null : value);
    // An idempotent receipt may precede newer manual protection. Invalidate and
    // read current facts; never copy that historical receipt into the cache.
    await reads.client.invalidateQueries({
      queryKey: reads.key(protectionKey(request.unitId, request.locale, request.sourceRevisionId, request.selectionId ?? null)),
      exact: true, refetchType: "none",
    });
    if (mounted.current && current() && latest.current.open
      && latest.current.protectionScope === protectionIdentity(request)) {
      const refreshed = await latest.current.refetch();
      if (refreshed.error) throw refreshed.error;
    }
  }

  async function change(basis: ProtectionBasis, protectedValue: boolean) {
    if (inFlight.current || pending || disabled || (!protectedValue && draftBlocked)) return;
    inFlight.current = true;
    try {
      await run(async current => {
        const actionId = await executionCommands.identity({
          sessionToken: basis.request.sessionToken, projectId: basis.request.projectId,
        });
        if (!mounted.current || !current() || latest.current.scope !== scopeIdentity(basis.request)) return;
        if (!protectedValue && latest.current.draftBlocked) return;
        if (!protectedValue) { focusAfterRelease.current = true; setRelease(null); }
        await submit({ ...basis.request, actionId, protected: protectedValue,
          confirmedRelease: !protectedValue }, basis.key, current);
      });
    } finally { inFlight.current = false; }
  }

  async function retry() {
    if (!pending || pending.phase !== "unknown" || inFlight.current || disabled
      || (!pending.request.protected && draftBlocked)) return;
    const retained = pending;
    inFlight.current = true;
    try { await run(current => submit(retained.request, retained.key, current)); }
    finally { inFlight.current = false; }
  }

  if (!open) return null;
  return <section ref={section} tabIndex={-1} aria-label={t("protection.title")}>
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
        const basis = capture(); if (basis) void change(basis, true);
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
                onClick={() => void change(release, false)}>{t("protection.confirmRelease")}</button>
            </div>
          </> : null}
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>
      {pending?.phase === "unknown" ? <button type="button" className="secondary-button"
        disabled={disabled || (!pending.request.protected && draftBlocked)} onClick={() => void retry()}>
        {t("protection.retry")}
      </button> : null}
    </div>
  </section>;
}
