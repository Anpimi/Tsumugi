import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import type { CommandError, ProjectView } from "./projectCommands";
import { projectCommands } from "./projectCommands";
import { executionCommands as commands, executionContext, type AttemptDetail, type AttemptSummary, type RecoveryAction, type RecoveryUnit, type Receipt, type Task, type PrepareRequest, type ResultEnvelope } from "./executionCommands";

type Confirmation = { action: RecoveryAction | "cancel"; unit?: RecoveryUnit; itemId?: string };
export function ExecutionTasks({ project, disabled }: { project: ProjectView; disabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [dismissBlocked, setDismissBlocked] = useState(false);
  return <Dialog.Root open={open} onOpenChange={next => { if (!dismissBlocked) setOpen(next); }}>
    <Dialog.Trigger className="navigation-item" disabled={disabled}>{t("execution.title")}</Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="execution-dialog" onEscapeKeyDown={event => { if (dismissBlocked) event.preventDefault(); }}>
      <div className="execution-heading"><div><Dialog.Title>{t("execution.title")}</Dialog.Title><Dialog.Description>{project.metadata.displayName}</Dialog.Description></div><Dialog.Close className="secondary-button" disabled={dismissBlocked}>{t("execution.back")}</Dialog.Close></div>
      {open ? <TaskContent key={project.sessionToken} project={project} onDismissBlockedChange={setDismissBlocked} /> : null}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

export function TaskContent({ project, onDismissBlockedChange }: { project: ProjectView; onDismissBlockedChange?: (blocked: boolean) => void }) {
  const { t } = useTranslation();
  const context = executionContext(project);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [cursor, setCursor] = useState("0");
  const [attemptCursor, setAttemptCursor] = useState("0");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<"done" | "noReceipt" | "queryStarted" | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [output, setOutput] = useState<ResultEnvelope | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [pendingAction, setPendingAction] = useState<PrepareRequest | null>(null);
  const [receiptChecked, setReceiptChecked] = useState(false);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const outputRegion = useRef<HTMLDivElement | null>(null);
  useEffect(() => { onDismissBlockedChange?.(busy || pendingAction !== null); return () => onDismissBlockedChange?.(false); }, [busy, pendingAction, onDismissBlockedChange]);
  useEffect(() => { if (output) { outputRegion.current?.focus(); outputRegion.current?.scrollIntoView?.({ block: "nearest" }); } }, [output]);
  function confirm(choice: Confirmation) { actionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setFailure(null); setMessage(null); setConfirmation(choice); }
  const sequence = useRef(0);
  const mounted = useRef(true);
  const mutating = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);

  function showError(error: unknown) {
    const code = (error as Partial<CommandError> | null)?.code;
    setFailure(code ?? "storage-failed");
  }
  // A single completed read schedules the next poll. Selection, mutation and
  // unmount invalidate older responses before they can update this view.
  useEffect(() => {
    if (busy) return;
    const ticket = ++sequence.current;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => mounted.current && ticket === sequence.current;
    async function read() {
      try {
        const runtime = await commands.status(context);
        if (!current()) return;
        if (runtime.error) showError(runtime.error);
        if (!taskId) {
          const rows = await commands.list({ ...context, after: cursor, limit: 50 });
          if (current()) setTasks(rows);
        } else {
          const rows = await commands.task({ ...context, taskId, after: attemptCursor, limit: 100 });
          if (!current()) return;
          setAttempts(rows);
          const selected = attemptId ?? rows.at(-1)?.attemptId;
          if (selected) {
            const next = await commands.attempt({ ...context, attemptId: selected, offset, limit: 100 });
            if (current()) setDetail(next);
          }
        }
      } catch (error) { if (current()) showError(error); }
      finally { if (current()) { setLoading(false); timer = setTimeout(() => setRefresh(value => value + 1), 1500); } }
    }
    void read();
    return () => { sequence.current++; clearTimeout(timer); };
  }, [project.sessionToken, taskId, attemptId, cursor, attemptCursor, offset, refresh, busy]);

  function selectTask(id: string | null) {
    sequence.current++;
    setTaskId(id); setDetail(null); setAttemptId(null); setAttemptCursor("0"); setOffset(0); setOutput(null); setReceipt(null); setFailure(null); setLoading(true); setPendingAction(null);
  }
  async function perform(work: () => Promise<void>) {
    if (mutating.current) return;
    mutating.current = true; sequence.current++; setBusy(true); setFailure(null); setMessage(null);
    try { await work(); } catch (error) { if (mounted.current) showError(error); }
    finally { mutating.current = false; if (mounted.current) { setBusy(false); setRefresh(value => value + 1); } }
  }
  async function execute(choice: Confirmation) {
    if (!detail) return;
    const selected = detail;
    await perform(async () => {
      if (choice.action === "cancel") {
        await commands.cancel({ ...context, taskId: selected.taskId, requestId: await commands.identity(context) });
      } else if (choice.unit) {
        const unit = choice.unit;
        if (choice.action === "adopt-result") {
          const actionId = await commands.identity(context);
          const prepared = { ...context, attemptId: selected.attemptId, unitId: unit.unitId, actionId, resultIds: unit.resultIds };
          setPendingAction(prepared); setReceiptChecked(false);
          await commands.prepare(prepared);
          const result = await commands.adopt({ ...context, actionId });
          if (mounted.current) { setReceipt(result); setPendingAction(null); }
        } else if (choice.action === "view-receipt" && unit.receiptId) {
          const result = await commands.receipt({ ...context, actionId: unit.receiptId });
          if (mounted.current) setReceipt(result);
        } else {
          const result = await commands.recover({ ...context, attemptId: selected.attemptId, unitId: unit.unitId, action: choice.action, itemIds: choice.itemId ? [choice.itemId] : unit.remainingItemIds });
          if (mounted.current && result.attemptId !== selected.attemptId) { setAttemptId(result.attemptId); setOffset(0); setOutput(null); setReceipt(null); }
          if (mounted.current && result.queryStarted) setMessage("queryStarted");
        }
      }
      if (mounted.current) { setConfirmation(null); if (choice.action !== "query-outcome") setMessage("done"); }
    });
  }
  async function checkReceipt() {
    if (!pendingAction) return;
    await perform(async () => {
      await projectCommands.read({ sessionToken: context.sessionToken });
      const result = await commands.receipt({ ...context, actionId: pendingAction.actionId });
      if (!mounted.current) return;
      setReceipt(result); setReceiptChecked(true);
      if (result) { setPendingAction(null); setConfirmation(null); setMessage("done"); } else setMessage("noReceipt");
    });
  }
  const errorKey = failure === "dependency-conflict" ? "conflict" : failure === "outcome-unknown" ? "unknown" : failure === "session-invalid" ? "session" : failure === "cancelled" ? "cancelled" : failure === "output-invalid" ? "invalid" : failure === "busy" ? "busy" : "failed";
  const feedback = <>{failure ? <p role="alert">{t(`execution.errors.${errorKey}`)}</p> : null}{message ? <p role="status">{t(`execution.${message}`)}</p> : null}
    {pendingAction ? <div className="execution-actions"><button className="secondary-button" disabled={busy} onClick={() => void checkReceipt()}>{t("execution.checkReceipt")}</button>
      {receiptChecked ? <button className="secondary-button" disabled={busy} onClick={() => void perform(async () => { await commands.prepare(pendingAction); const result = await commands.adopt({ ...context, actionId: pendingAction.actionId }); if (mounted.current) { setReceipt(result); setPendingAction(null); setConfirmation(null); setMessage("done"); } })}>{t("execution.retryAdoption")}</button> : null}
      <button className="text-button" disabled={busy} onClick={() => { setPendingAction(null); setConfirmation(null); }}>{t("execution.keepOutput")}</button></div> : null}</>;
  const titleFor = (action: Confirmation["action"]) => action === "cancel" ? t("execution.cancel") : t(`execution.actions.${action}`);
  const confirmationCount = confirmation?.itemId ? 1 : confirmation?.unit?.itemIds.length ?? 0;
  const blockedKey = (reason: string) => reason === "outcome-unknown" ? "unknown" : reason === "scope-removed" ? "scopeRemoved" : reason === "output-invalid" ? "invalid" : reason === "retry-not-safe" ? "retryUnsafe" : "blocked";
  return <div className="execution-content" aria-busy={busy || loading}>
    {!confirmation ? feedback : null}
    <div className="execution-actions">
      {taskId ? <button className="secondary-button" disabled={busy || pendingAction !== null} onClick={() => selectTask(null)}>{t("execution.allTasks")}</button> : null}
      <button className="secondary-button" disabled={busy} onClick={() => void perform(async () => { await projectCommands.read({ sessionToken: context.sessionToken }); })}>{t("execution.refresh")}</button>
    </div>
    {loading ? <p role="status">{t("execution.loading")}</p> : null}
    {!taskId ? <>
      {!loading && tasks.length === 0 ? <p>{t("execution.empty")}</p> : null}
      {tasks.length > 0 ? <p>{t("execution.listHelp")}</p> : null}
      <ul className="execution-list">{tasks.map(task => <li key={task.taskId}>
        <button className="secondary-button" onClick={() => selectTask(task.taskId)} disabled={busy}>
          {t(task.operation === "sample-update" ? "execution.sampleOperation" : "execution.operation")} · {t("execution.taskNumber", { number: task.sequence })}
        </button>
      </li>)}</ul>
      {cursor !== "0" || tasks.length === 50 ? <div className="execution-actions">
        <button className="text-button" disabled={cursor === "0" || busy} onClick={() => setCursor("0")}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={tasks.length < 50 || busy} onClick={() => setCursor(tasks.at(-1)!.sequence)}>{t("execution.nextPage")}</button>
      </div> : null}
    </> : <>
      <label className="field execution-attempt">{t("execution.attempt")}
        <select disabled={busy || pendingAction !== null} value={attemptId ?? detail?.attemptId ?? ""} onChange={event => {
          sequence.current++; setAttemptId(event.target.value); setOffset(0); setDetail(null); setOutput(null); setReceipt(null); setLoading(true);
        }}>
          {attempts.map(attempt => <option key={attempt.attemptId} value={attempt.attemptId}>{t("execution.attemptNumber", { number: attempt.sequence })}</option>)}
          {detail && !attempts.some(attempt => attempt.attemptId === detail.attemptId) ? <option value={detail.attemptId}>{t("execution.currentAttempt")}</option> : null}
        </select>
      </label>
      {attemptCursor !== "0" || attempts.length === 100 ? <div className="execution-actions">
        <button className="text-button" disabled={attemptCursor === "0" || busy || pendingAction !== null} onClick={() => { setAttemptCursor("0"); setAttemptId(null); }}>{t("execution.firstPage")}</button>
        <button className="text-button" disabled={attempts.length < 100 || busy || pendingAction !== null} onClick={() => { setAttemptCursor(attempts.at(-1)!.sequence); setAttemptId(null); }}>{t("execution.nextPage")}</button>
      </div> : null}
      {detail ? <>
        <section className="execution-summary" aria-label={t("execution.summary")}>
          <strong>{t("execution.progress", { generated: detail.progress.succeeded, adopted: detail.progress.adopted, total: detail.progress.total })}</strong>
          <p>{t("execution.statusCounts", { failed: detail.progress.failed, unknown: detail.progress.unknown, running: detail.progress.running, queued: detail.progress.queued, cancelled: detail.progress.cancelled })}</p>
          <small>{t("execution.applicationHelp")}</small>
        </section>
        <section aria-label={t("execution.nextSteps")}>
          <div className="execution-section-heading"><h3>{t("execution.nextSteps")}</h3>
            <button className="text-button" disabled={busy || pendingAction !== null} onClick={() => confirm({ action: "cancel" })}>{t("execution.cancel")}</button>
          </div>
          {detail.recovery.units.map(unit => <section className="execution-unit" key={unit.unitId}>
            <details><summary>{t("execution.groupScope", { count: unit.itemIds.length })}</summary>
              <ul>{unit.scopes.map((scope, index) => <li key={unit.itemIds[index]}>{scope.id}{scope.locale ? ` · ${scope.locale}` : ""}</li>)}</ul>
            </details>
            {unit.blockedReason ? <p>{t(unit.blockedReason === "continued-in-new-attempt" ? "execution.continued" : unit.blockedReason === "still-running" ? "execution.running" : `execution.errors.${blockedKey(unit.blockedReason)}`)}</p> : null}
            <div className="execution-actions">{unit.actions.map(action => action === "query-outcome" ? unit.remainingItemIds.map(id =>
              <button className="secondary-button" key={id} disabled={busy || pendingAction !== null} onClick={() => confirm({ action, unit, itemId: id })}>{t(`execution.actions.${action}`)} · {unit.scopes[unit.itemIds.indexOf(id)]?.id}</button>
            ) : <button className={action === "adopt-result" || action === "retry-safe-failure" || action === "resume-undispatched" ? "primary-button" : "secondary-button"} key={action} disabled={busy || pendingAction !== null} onClick={() => {
              if (action === "view-receipt") void execute({ action, unit }); else confirm({ action, unit });
            }}>{t(`execution.actions.${action}`)}</button>)}</div>
          </section>)}
        </section>
        <h3>{t("execution.itemResults")}</h3>
        <ul className="execution-list">{detail.items.map(item => <li key={item.status.itemId}>
          <div className="execution-item-heading"><strong>{item.scope.id}{item.scope.locale ? ` · ${item.scope.locale}` : ""}</strong>
            {item.resultId ? <button className="text-button" disabled={busy} onClick={() => void perform(async () => {
              const result = await commands.output({ ...context, attemptId: detail.attemptId, resultId: item.resultId! });
              if (mounted.current) setOutput(result);
            })}>{t(item.status.execution === "succeeded" ? "execution.output" : "execution.failureDetails")}</button> : null}
          </div>
          <p>{t(`execution.states.${item.status.execution}`)} · {t(`execution.adoption.${item.status.adoption}`)}</p>
          {item.status.validation === "invalid" ? <p>{t("execution.errors.invalid")}</p> : null}
          {item.status.cancellationRequested ? <small>{t("execution.cancellationRequested")}</small> : null}
          {output?.itemId === item.status.itemId && output.resultId === item.resultId ? <div className="execution-result" ref={outputRegion} tabIndex={-1} role="region" aria-label={t("execution.resultFor", { name: item.scope.id })}>
            <h4>{t("execution.resultFor", { name: item.scope.id })}</h4>
            {output.output !== null ? <pre className="execution-output">{JSON.stringify(output.output, null, 2)}</pre> : <p>{t("execution.noOutput")}</p>}
            {output.diagnostic ? <><p>{t(output.diagnostic.retrySafe ? "execution.safeFailure" : "execution.unsafeFailure")}</p>
              <details><summary>{t("execution.diagnostic")}</summary><code>{output.diagnostic.code}</code></details></> : null}
          </div> : null}
        </li>)}</ul>
        {offset > 0 || detail.nextOffset !== null ? <div className="execution-actions">
          <button className="text-button" disabled={offset === 0 || busy} onClick={() => { setOffset(Math.max(0, offset - 100)); setOutput(null); }}>{t("execution.previousPage")}</button>
          <button className="text-button" disabled={detail.nextOffset === null || busy} onClick={() => { setOffset(detail.nextOffset!); setOutput(null); }}>{t("execution.nextPage")}</button>
        </div> : null}
      </> : null}
    </>}
    {receipt ? <section className="execution-receipt" role="status"><h3>{t("execution.receipt")}</h3><ul>{receipt.changes.map(change => <li key={`${change.kind}:${change.id}`}>{change.id} · {t("execution.revision", { number: change.revision })}</li>)}</ul></section> : null}
    <Dialog.Root open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop execution-confirm-backdrop" />
        <Dialog.Content className="confirm-dialog execution-confirm-dialog" onCloseAutoFocus={event => { event.preventDefault(); actionTrigger.current?.focus(); }} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => event.preventDefault()}>
          <Dialog.Title>{confirmation ? titleFor(confirmation.action) : t("execution.nextSteps")}</Dialog.Title>
          <Dialog.Description>{confirmation?.action === "cancel" ? t("execution.cancelHelp") : confirmation ? t(`execution.actionHelp.${confirmation.action}`, {
            count: confirmationCount, remaining: confirmation.unit?.remainingItemIds.length ?? 0,
            reused: (confirmation.unit?.itemIds.length ?? 0) - (confirmation.unit?.remainingItemIds.length ?? 0),
          }) : null}</Dialog.Description>
          <ul>{confirmation?.unit?.scopes.map((scope, index) => !confirmation.itemId || confirmation.unit?.itemIds[index] === confirmation.itemId ? <li key={index}>
            {scope.id}{scope.locale ? ` · ${scope.locale}` : ""}
            {confirmation.action === "resume-undispatched" || confirmation.action === "retry-safe-failure" ? <small> · {t(confirmation.unit!.remainingItemIds.includes(confirmation.unit!.itemIds[index]) ? "execution.willRun" : "execution.reuse")}</small> : null}
          </li> : null)}</ul>
          {feedback}
          <div className="form-actions"><button className="secondary-button" disabled={busy} onClick={() => setConfirmation(null)}>{t("execution.back")}</button>
            <button className="primary-button" disabled={busy || pendingAction !== null} onClick={() => { if (confirmation) void execute(confirmation); }}>{busy ? t("execution.working") : confirmation ? titleFor(confirmation.action) : t("execution.confirm")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
