import { useWorkbenchCommands, type ResourceToolPreparationCommandPayload, type ResourceToolCaptureCommandPayload, type ResourceToolPendingCommandPayload,
  type ExecutionCancellationCommandPayload, type ExecutionCancellationRetryCommandPayload, type CommandAvailability } from "./workbenchCommands";
import { TaskCancellationFeedback } from "./ExecutionTaskSession";
import type { PluginToolQuerySession, ToolQueryIntent } from "./PluginToolQuerySession";
import { useEffect, useId, useLayoutEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { createToolQuery, ToolQueryError, type ToolQueryPresentation } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type PluginToolPrepareRequest, type PluginToolPreflight, type PluginToolDiscardRequest, type CancelRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { pluginCommands, type PluginToolRequest, type PluginToolView, type PluginUiView } from "./pluginCommands";
import { matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import { PluginPermissions } from "./PluginPermissions";
import { jsonIdentity, queryField as field, matchesTool as matches, readReferenceQueryChoices } from "./pluginToolChoices";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { currentPlugins, pluginInventoryReadKey, usePluginFacts } from "./ApplicationReadProvider";
import { Button } from "./design-system/Button";
import { Dialog } from "./design-system/Dialog";
import { Field, TextArea } from "./design-system/Field";
import { Banner, LoadingState } from "./design-system/Feedback";
import styles from "./PluginToolQueries.module.css";

export interface ToolQueryState { busy: boolean; pending: boolean; hasDraft: boolean }
export interface ToolQueryHandle { allowLeave: (current?: () => boolean, intentCurrent?: () => boolean) => Promise<boolean>; addText: (text: string) => boolean }

function presentation(view: PluginToolView | undefined): { value: ToolQueryPresentation | null; failed: boolean } {
  if (!view) return { value: null, failed: false };
  try { return { value: createToolQuery(view.binding), failed: false }; }
  catch { return { value: null, failed: true }; }
}

function matchesUi(view: PluginUiView, choice: { package: PluginToolRequest["package"]; componentId: string; uiId: string | null; settingsRevision: string }): boolean {
  const provider = view.binding.capability.provider;
  return choice.uiId !== null && view.uiId === choice.uiId && view.componentId === choice.componentId
    && view.slot === "reference-query" && view.settingsRevision === choice.settingsRevision && !!view.resourceId
    && view.package.packageDigest === choice.package.packageDigest
    && jsonIdentity(view.package.plugin) === jsonIdentity(choice.package.plugin)
    && provider.componentId === choice.componentId && provider.packageDigest === choice.package.packageDigest
    && jsonIdentity(provider.plugin) === jsonIdentity(choice.package.plugin);
}

/** Shared SDK input construction, original execution consent and ledger reads.
 * Drafts survive hidden panels; references never become project mutations. */
export function PluginToolQueries({ project, session, open, disabled, onState, onAttention, canInteract, onLeaveDialogChange, ref }: {
  project: ProjectView; session: PluginToolQuerySession; open: boolean; disabled: boolean;
  onState: (state: ToolQueryState) => void; onAttention: () => void; ref?: Ref<ToolQueryHandle>;
  canInteract?: () => boolean; onLeaveDialogChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation(), context = executionContext(project), reads = useSessionReads(), registry = useWorkbenchCommands();
  const { t: surface } = useTranslation(undefined, { keyPrefix: "pluginToolWorkbench" });
  const pluginFacts = usePluginFacts();
  const commandScope = { ...context, area: "resources" as const };
  const { choiceKey, runtimeKey, refresh, rows, target, selections, capture, run, consent, submittedSequence, pending, busy, failure, inputFailure } = session.state;
  const { setChoiceKey, setRuntimeKey, setRefresh, setRows, setTarget, setSelections, setCapture, setConsent, setApplicationConsent, setFailure,
    setInputFailure, draftSequence, nextRow, running, perform, submit, edit } = session;
  const mounted = useRef(false), interaction = useRef(canInteract), selectionsId = useId(), inputErrorId = useId();
  useLayoutEffect(() => { interaction.current = canInteract; });
  const interactive = () => interaction.current?.() ?? true;
  const [leave, setLeave] = useState(false), leaveProof = useRef<(() => boolean) | null>(null);
  const leaveIntent = useRef<(() => boolean) | null>(null);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null), leaveTrigger = useRef<HTMLElement | null>(null);
  const leaveDialogObserver = useRef(onLeaveDialogChange);
  useLayoutEffect(() => {
    if (leaveDialogObserver.current !== onLeaveDialogChange) leaveDialogObserver.current?.(false);
    leaveDialogObserver.current = onLeaveDialogChange; onLeaveDialogChange?.(leave);
  }, [leave, onLeaveDialogChange]);
  useLayoutEffect(() => () => leaveDialogObserver.current?.(false), []);
  const errorRegion = useRef<HTMLDivElement>(null);
  const pluginInventory = useQuery({ queryKey: pluginInventoryReadKey, enabled: open && !disabled && !pluginFacts.reserved(),
    queryFn: async ({ signal }) => {
      if (pluginFacts.reserved()) throw new Error("Plugin settings read is reserved");
      const value = await pluginCommands.inventory();
      if (signal.aborted) throw new Error("Plugin inventory read cancelled");
      return value;
    } }, pluginFacts.client);
  const currentInventory = pluginFacts.current();
  const inventoryKey = ["tool-query-inventory", refresh, currentInventory?.settingsRevision, pluginFacts.state?.dataUpdateCount] as const;
  const inventory = useSessionQuery({ key: inventoryKey, scopes: [], enabled: open && !disabled && !pluginFacts.reserved() && !!currentInventory,
    read: () => {
      const snapshot = currentPlugins(pluginFacts.client);
      if (!snapshot) throw new Error("Plugin inventory changed");
      return readReferenceQueryChoices(snapshot, `${project.metadata.projectId}:${project.sessionToken}`,
        () => !pluginFacts.reserved() && currentPlugins(pluginFacts.client) === snapshot);
    } });
  const inventoryReadState = reads.client.getQueryState(reads.key(inventoryKey));
  const choices = currentInventory && inventoryReadState?.status === "success" && inventoryReadState.fetchStatus === "idle"
    && !inventoryReadState.isInvalidated && inventoryReadState.data === inventory.data && !inventory.isFetching && !inventory.isError
    && inventory.data?.settingsRevision === currentInventory.settingsRevision ? inventory.data.choices : [];
  const unsupportedViews = choices === inventory.data?.choices ? inventory.data.unsupportedViews : [];
  const effectiveChoice = choiceKey || (choices.length === 1 ? choices[0].key : "");
  const choice = choices.find(item => item.key === effectiveChoice);
  const runtimes = matchingPluginEnvironments(inventory.data?.runtimes ?? [], choice?.runtimeKinds ?? []);
  const effectiveRuntime = runtimeKey || (runtimes.length === 1 ? runtimes[0].environmentDigest : "");
  const uiRequest = choice?.kind === "ui" && choice.uiId ? { package: choice.package, uiId: choice.uiId } : null;
  const uiKey = ["tool-query-ui", effectiveChoice, inventory.dataUpdatedAt] as const;
  const ui = useSessionQuery({ key: uiKey, scopes: [], enabled: open && !disabled && !pluginFacts.reserved() && !!uiRequest && !!currentInventory,
    read: async () => {
      if (!uiRequest || !choice) throw new Error("Missing reference view choice");
      if (pluginFacts.reserved()) throw new Error("Plugin settings read is reserved");
      const value = await pluginCommands.ui(uiRequest);
      if (!matchesUi(value, choice)) throw new Error("Reference view identity changed");
      return value;
    } });
  const uiReadState = reads.client.getQueryState(reads.key(uiKey));
  const uiView = choice?.kind === "ui" && uiReadState?.status === "success" && uiReadState.fetchStatus === "idle"
    && !uiReadState.isInvalidated && uiReadState.data === ui.data && ui.data && !ui.isFetching && !ui.error && matchesUi(ui.data, choice) ? ui.data : null;
  const resourceId = choice?.kind === "resource" ? choice.resourceId : uiView?.resourceId;
  const toolRequest: PluginToolRequest | null = choice && resourceId && effectiveRuntime
    ? { package: choice.package, resourceId, environmentDigest: effectiveRuntime } : null;
  const environmentKey = ["tool-query-environment", effectiveChoice, effectiveRuntime, refresh, inventory.dataUpdatedAt, ui.dataUpdatedAt] as const;
  const environment = useSessionQuery({ key: environmentKey, scopes: [],
    enabled: open && !disabled && !pluginFacts.reserved() && !!toolRequest && runtimes.some(item => item.environmentDigest === effectiveRuntime)
      && !inventory.error && !inventory.isFetching && !!currentInventory && (choice?.kind !== "ui" || !!uiView),
    read: async () => {
      if (!toolRequest) throw new Error("Missing tool choice");
      if (pluginFacts.reserved()) throw new Error("Plugin settings read is reserved");
      const value = await pluginCommands.tool(toolRequest);
      if (!matches(value, toolRequest) || value.settingsRevision !== choice?.settingsRevision
        || (choice?.kind === "ui" && (!uiView || jsonIdentity(value.binding) !== jsonIdentity(uiView.binding)))) {
        throw new Error("Tool environment identity changed");
      }
      return value;
    } });
  const environmentReadState = reads.client.getQueryState(reads.key(environmentKey));
  const currentTool = currentInventory && environmentReadState?.status === "success" && environmentReadState.fetchStatus === "idle"
    && !environmentReadState.isInvalidated && environmentReadState.data === environment.data
    && !inventory.isFetching && !ui.isFetching && !environment.isFetching && !environment.error
    && choice && environment.data?.settingsRevision === choice.settingsRevision
    && (choice.kind !== "ui" || uiView && jsonIdentity(environment.data?.binding) === jsonIdentity(uiView.binding))
    ? environment.data : undefined;
  const available = useMemo(() => presentation(currentTool), [currentTool]), query = available.value?.query;
  const defaultTarget = query ? field(query.inputTemplate, query.target.path) : undefined;
  const effectiveTarget = target || (typeof defaultTarget === "string" ? defaultTarget : "");
  const unavailable = !toolRequest || !runtimes.some(item => item.environmentDigest === effectiveRuntime) || !available.value
    || !!pluginInventory.error || !!inventory.error || !!ui.error || !!environment.error;
  const environmentChanged = !!capture && (!currentTool || jsonIdentity(currentTool) !== jsonIdentity(capture.review.tool));
  const changed = !!capture && capture.sequence !== draftSequence.current;
  const visibleRun = pending?.kind === "start" ? { review: pending.review, sequence: pending.sequence } : run;
  const attemptId = visibleRun?.review.attemptId ?? null;
  const detail = useSessionQuery({ key: ["tool-query-attempt", attemptId], scopes: ["execution"], enabled: open && !!attemptId && !busy,
    read: async () => {
      if (!attemptId) return null;
      const value = await readCompleteAttempt(context, attemptId, "plugin-tool-query");
      const known = session.current().knownTask;
      if (value && known?.attemptId === attemptId && value.taskId !== known.taskId) throw new Error("Tool task association changed");
      if (value && visibleRun && (value.items.length !== visibleRun.review.items.length
        || value.items.some(item => !visibleRun.review.items.some(fixed => fixed.itemId === item.status.itemId)))) throw new Error("Tool result coverage changed");
      return value;
    } });
  const resultIds = detail.data?.items.flatMap(item => item.resultId ? [item.resultId] : []) ?? [];
  const knownTask = session.state.knownTask;
  const taskId = knownTask?.attemptId === attemptId ? knownTask.taskId : detail.data?.taskId;
  useLayoutEffect(() => {
    const state = reads.client.getQueryState(reads.key(["tool-query-attempt", attemptId]));
    if (detail.data && state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && state.data === detail.data) session.observeTask(detail.data);
  }, [detail.data, detail.isFetching, detail.error, reads, attemptId, session]);
  function cancellationProof() {
    const known = session.current().knownTask;
    return interactive() && !!known && known.taskId === taskId && known.attemptId === attemptId && known.operation === "plugin-tool-query";
  }
  function environmentCurrent() {
    const pluginState = pluginFacts.client.getQueryState(pluginInventoryReadKey);
    const inventoryState = reads.client.getQueryState(reads.key(inventoryKey));
    const uiState = choice?.kind === "ui" ? reads.client.getQueryState(reads.key(uiKey)) : null;
    const environmentState = reads.client.getQueryState(reads.key(environmentKey));
    return !pluginFacts.reserved() && pluginState?.status === "success" && pluginState.fetchStatus === "idle" && !pluginState.isInvalidated
      && pluginState.data === currentInventory && currentPlugins(pluginFacts.client) === currentInventory
      && inventoryState?.status === "success" && inventoryState.fetchStatus === "idle" && !inventoryState.isInvalidated && inventoryState.data === inventory.data
      && (choice?.kind !== "ui" || uiState?.status === "success" && uiState.fetchStatus === "idle" && !uiState.isInvalidated && uiState.data === uiView)
      && environmentState?.status === "success" && environmentState.fetchStatus === "idle" && !environmentState.isInvalidated && environmentState.data === currentTool;
  }
  const output = useSessionQuery({ key: ["tool-query-output", attemptId, ...resultIds], scopes: ["execution"], enabled: open && !!attemptId && !busy && !!resultIds.length,
    read: async () => {
      if (!attemptId) return [];
      return Promise.all(resultIds.map(resultId => executionCommands.output({ ...context, attemptId, resultId })));
    } });
  const working = !!attemptId && (!detail.data || detail.data.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched"));
  const locked = disabled || busy || !!pending;
  const draftLocked = disabled || (!!pending && pending.kind !== "prepare");
  const hasDraft = rows.some(row => row.text.length > 0) && draftSequence.current !== submittedSequence;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; leaveResolver.current?.(false); }; }, []);
  useEffect(() => { onState({ busy: busy || working, pending: !!pending, hasDraft }); }, [busy, working, !!pending, hasDraft, onState]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  useEffect(() => { const error = pluginInventory.error ?? inventory.error ?? ui.error ?? environment.error ?? detail.error ?? output.error;
    if (error) setFailure(commandFailure(error)); }, [pluginInventory.error, inventory.error, ui.error, environment.error, detail.error, output.error]);

  async function prepare(current: () => boolean) {
    const helper = available.value;
    if (!helper || !currentTool || !toolRequest || unavailable || !interactive()) return;
    const sequence = draftSequence.current;
    const payloads = rows.map(row => helper.prepare({ text: row.text, target: effectiveTarget, selections }));
    const id = await executionCommands.identity(context);
    if (current() && interactive() && environmentCurrent()) await submit({ kind: "prepare", request: { ...context, tool: toolRequest, attemptId: id, payloads }, view: currentTool, sequence }, current);
  }
  async function start(current: () => boolean) {
    if (!capture || changed || environmentChanged || unavailable || consent !== capture.review.inputDigest || !applicationReady() || !interactive()) return;
    const grantId = await executionCommands.identity(context);
    if (!current() || !interactive() || !environmentCurrent()) return;
    if (capture.sequence !== draftSequence.current) throw new ToolQueryError("input-changed", "text");
    await submit({ kind: "start", review: capture.review, sequence: capture.sequence,
      request: { ...context, attemptId: capture.review.attemptId, inputDigest: capture.review.inputDigest, grantId, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true, applicationExecution: session.current().applicationConsent === capture.review.inputDigest } }, current);
  }
  function answerLeave(answer: boolean) { setLeave(false); leaveResolver.current?.(answer); leaveResolver.current = null; }
  useImperativeHandle(ref, () => ({ addText: text => !disabled && session.addText(text), allowLeave(current = () => true, intentCurrent = current) {
    if (!current()) return Promise.resolve(false);
    if (session.blocked()) { onAttention(); return Promise.resolve(false); }
    if (!session.hasDraft()) return Promise.resolve(true);
    onAttention(); leaveProof.current = current; leaveIntent.current = intentCurrent;
    leaveTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
  } }));
  async function discard(current: () => boolean) {
    if (capture) await submit({ kind: "discard", request: { ...context, attemptId: capture.review.attemptId } }, current);
  }
  async function discardAndLeave() {
    if (!leaveProof.current?.()) { answerLeave(false); return; }
    let answer: boolean | null = null;
    const sequence = draftSequence.current;
    await perform(async current => {
      await discard(current);
      answer = current() && draftSequence.current === sequence && !session.current().pending;
    });
    if (!mounted.current || answer === null) return;
    // The resource proof includes this Tool's running lock. Recheck it only
    // after perform releases that lock, before clearing any retained input.
    if (!answer || !leaveIntent.current?.() || draftSequence.current !== sequence || session.blocked()) { answerLeave(false); return; }
    if (session.current().mode === "mcp" && !session.clearMcpDraft()) { answerLeave(false); return; }
    setRows([{ id: nextRow.current++, text: "" }]); edit();
    answerLeave(!!leaveIntent.current?.() && !session.blocked());
  }
  const preparationPayload: ResourceToolPreparationCommandPayload | undefined = toolRequest && currentTool
    ? { kind: "resource-tool-preparation", editSeq: draftSequence.current, tool: toolRequest, view: currentTool } : undefined;
  const capturePayload: ResourceToolCaptureCommandPayload | undefined = capture
    ? { kind: "resource-tool-capture", editSeq: capture.sequence, attemptId: capture.review.attemptId, inputDigest: capture.review.inputDigest } : undefined;
  const applicationBasis = capture?.review.applicationScope ?? null;
  const instanceKey = ["application-plugin-instance", applicationBasis?.instanceId, applicationBasis?.activationGeneration] as const;
  const instance = useSessionQuery({ key: instanceKey, scopes: ["execution"], enabled: open && !!applicationBasis && !busy,
    read: async () => { if (!applicationBasis) throw new Error("Missing application instance"); return executionCommands.applicationInstance({ basis: applicationBasis }); } });
  function currentInstance() {
    const state = reads.client.getQueryState(reads.key(instanceKey));
    return state?.status === "success" && state.fetchStatus === "idle" && !state.isInvalidated && !state.error && state.data === instance.data ? instance.data : null;
  }
  function applicationReady() {
    if (!applicationBasis) return true;
    const value = currentInstance();
    return value?.state === "active" || value?.state === "reserved" && session.current().applicationConsent === capture?.review.inputDigest;
  }
  function stopInstanceAvailability(payload?: ResourceToolCaptureCommandPayload): CommandAvailability {
    const base = captureAvailability(payload);
    const value = currentInstance();
    return base.enabled && applicationBasis && value && (value.state === "active" || value.state === "reserved")
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  async function stopInstance(current: () => boolean) {
    if (!applicationBasis || !currentInstance() || !interactive()) return;
    const basis = structuredClone(applicationBasis), actionId = await executionCommands.identity(context);
    if (current() && interactive()) await submit({ kind: "stop-instance", request: { actionId, basis } }, current);
  }
  const pendingPayload: ResourceToolPendingCommandPayload | undefined = pending ? { kind: "resource-tool-pending", intent: pending } : undefined;
  const cancelPayload: ExecutionCancellationCommandPayload | undefined = taskId && attemptId
    ? { kind: "execution-cancellation", taskId, attemptId, origin: "resources" } : undefined;
  function baseAvailability(): CommandAvailability {
    return !open || leave || reads.retired || !interactive() ? { enabled: false, reason: "hidden" }
      : disabled || session.running.current ? { enabled: false, reason: "busy" } : { enabled: true };
  }
  function preparationAvailability(payload?: ResourceToolPreparationCommandPayload): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    return payload && preparationPayload && !session.current().pending && !working && !unavailable && !pluginInventory.isFetching && !inventory.isFetching && !ui.isFetching && !environment.isFetching && environmentCurrent()
      && payload.editSeq === draftSequence.current && jsonIdentity(payload.tool) === jsonIdentity(preparationPayload.tool)
      && jsonIdentity(payload.view) === jsonIdentity(preparationPayload.view) ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function captureAvailability(payload?: ResourceToolCaptureCommandPayload, starting = false): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    const fixed = session.current().capture;
    return payload && fixed && !session.current().pending && payload.attemptId === fixed.review.attemptId && payload.inputDigest === fixed.review.inputDigest
      && payload.editSeq === fixed.sequence && (!starting || !changed && !environmentChanged && !unavailable && !pluginInventory.isFetching && !inventory.isFetching && !ui.isFetching && !environment.isFetching && environmentCurrent()
        && fixed.sequence === draftSequence.current && session.current().consent === fixed.review.inputDigest && applicationReady())
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function pendingAvailability(payload?: ResourceToolPendingCommandPayload, retry = false): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    return payload && session.current().pending && jsonIdentity(payload.intent) === jsonIdentity(session.current().pending)
      && (!retry || payload.intent.kind !== "start" || session.current().startRetryAllowed)
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function cancelAvailability(payload?: ExecutionCancellationCommandPayload): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    return payload && payload.origin === "resources" && payload.taskId === taskId && payload.attemptId === attemptId
      && session.tasks.canCancel(payload, cancellationProof) ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  function retryCancelAvailability(payload?: ExecutionCancellationRetryCommandPayload,retry=true): CommandAvailability {
    const base = baseAvailability(); if (!base.enabled) return base;
    const value = payload && session.tasks.current(payload.taskId);
    return value?.phase === "unknown" && (!retry || value.retryAllowed) && payload?.origin === "resources" && value.target.origin === payload.origin
      && value.target.attemptId === payload.attemptId && value.request.requestId === payload.requestId
      ? { enabled: true } : { enabled: false, reason: "unavailable" };
  }
  useLayoutEffect(() => {
    const metadata = { category: "resources" as const, scope: commandScope, binding: null, confirmation: "none" as const };
    const removals = [
      registry.register({ ...metadata, id: "resource.prepare-tool", payloadKind: "resource-tool-preparation", nameKey: "toolQuery.prepare", risk: "captures-resources",
        availability: preparationAvailability, handler: () => { void perform(prepare); } }),
      registry.register({ ...metadata, id: "resource.start-tool", payloadKind: "resource-tool-capture", nameKey: "toolQuery.start", risk: "runs-resource-tool",
        availability: payload => captureAvailability(payload, true), handler: () => { void perform(start); } }),
      registry.register({ ...metadata, id: "resource.stop-tool-instance", payloadKind: "resource-tool-capture", nameKey: "toolQuery.applicationStop", risk: "stops-application-component",
        availability: stopInstanceAvailability, handler: () => { void perform(stopInstance); } }),
      registry.register({ ...metadata, id: "resource.discard-tool", payloadKind: "resource-tool-capture", nameKey: "toolQuery.discardReview", risk: "retries-resource-action",
        availability: payload => captureAvailability(payload), handler: () => { void perform(discard); } }),
      registry.register({ ...metadata, id: "resource.check-tool-start", payloadKind: "resource-tool-pending", nameKey: "execution.checkPluginStart", risk: "reads-execution",
        availability: payload => payload?.intent.kind === "start" ? pendingAvailability(payload) : { enabled: false, reason: "unavailable" }, handler: () => { void session.checkStart(); } }),
      registry.register({ ...metadata, id: "resource.retry-tool", payloadKind: "resource-tool-pending", nameKey: "toolQuery.retryOriginal", risk: "retries-resource-action",
        availability: payload => pendingAvailability(payload, true), handler: payload => { void perform(current => submit(payload.intent, current)); } }),
      registry.register({ ...metadata, id: "resource.cancel-tool", payloadKind: "execution-cancellation", nameKey: "toolQuery.cancel", risk: "cancels-execution-task",
        availability: cancelAvailability, handler: payload => { void session.tasks.cancel(payload, cancellationProof); } }),
      registry.register({ ...metadata, id: "resource.retry-tool-cancellation", payloadKind: "execution-cancellation-retry", nameKey: "execution.retryCancellation", risk: "retries-execution-action",
        availability: retryCancelAvailability, handler: payload => { void session.tasks.retry(payload.taskId); } }),
      registry.register({ ...metadata, id: "resource.check-tool-cancellation", payloadKind: "execution-cancellation-retry", nameKey: "execution.checkCancellation", risk: "reads-execution",
        availability: payload => retryCancelAvailability(payload,false), handler: payload => { void session.tasks.checkCancellation(payload.taskId); } }),
    ];
    return () => removals.forEach(remove => remove());
  });
  const runView = visibleRun?.review.tool;
  const runPresentation = useMemo(() => presentation(runView).value, [runView]);
  const capturedPresentation = useMemo(() => presentation(capture?.review.tool).value, [capture?.review.tool]);
  function entries(resultId: string, itemId: string): string[][] | null {
    const result = output.data?.find(value => value?.resultId === resultId);
    if (!result || result.attemptId !== attemptId || result.projectId !== context.projectId || result.itemId !== itemId || result.outcome !== "succeeded" || !runPresentation) return null;
    try { return runPresentation.entries(result.output); } catch { return null; }
  }
  return <>
    <section hidden={!open} className={styles.panel} aria-label={t("toolQuery.title")} aria-busy={busy || pluginInventory.isFetching || inventory.isFetching || ui.isFetching || environment.isFetching}>
      <TaskCancellationFeedback origin="resources" taskId={taskId} disabled={disabled} visible={open} retryCommand={{ available: intent => retryCancelAvailability({ ...intent, kind: "execution-cancellation-retry" }).enabled,
        dispatch: intent => { registry.dispatch("resource.retry-tool-cancellation", commandScope, { ...intent, kind: "execution-cancellation-retry" }); } }} checkCommand={{available:intent=>retryCancelAvailability({...intent,kind:"execution-cancellation-retry"},false).enabled,
          dispatch:intent=>{registry.dispatch("resource.check-tool-cancellation",commandScope,{...intent,kind:"execution-cancellation-retry"});}}} />
      <h3>{t("toolQuery.title")}</h3><p>{t("toolQuery.help")}</p>
      {failure ? <Banner tone="error" ref={errorRegion} role="alert" tabIndex={-1}><p>{t("toolQuery.failed")}</p><CommandFailureDetails failure={failure} /></Banner> : null}
      {detail.error ? <Banner tone="error" role="alert" action={<Button type="button" variant="secondary" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{t("toolQuery.retryRead")}</Button>}>
        <p>{t("toolQuery.recordReadFailed")}</p><CommandFailureDetails failure={commandFailure(detail.error)} /></Banner> : null}
      {output.error ? <Banner tone="error" role="alert" action={<Button type="button" variant="secondary" disabled={output.isFetching} onClick={() => void output.refetch()}>{t("toolQuery.retryRead")}</Button>}>
        <p>{t("toolQuery.outputReadFailed")}</p><CommandFailureDetails failure={commandFailure(output.error)} /></Banner> : null}
      {pluginInventory.isFetching || inventory.isFetching || ui.isFetching || environment.isFetching || busy || working ? <LoadingState label={t("execution.working")}/> : null}
      <Field label={t("toolQuery.provider")}><select value={effectiveChoice} disabled={locked || !!capture || working} onChange={event => { setChoiceKey(event.target.value); setRuntimeKey(""); setTarget(""); setSelections([]); edit(); }}>
        <option value="">{t("toolQuery.chooseProvider")}</option>
        {choiceKey && !choice ? <option value={choiceKey}>{t("toolQuery.providerUnavailable")}</option> : null}
        {choices.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}
      </select></Field>
      {unsupportedViews.map(value => <Banner tone="warning" key={value} role="status">{t("toolQuery.unsupportedView", { provider: value })}</Banner>)}
      <Field label={t("sourcePlugin.runtime")}><select value={effectiveRuntime} disabled={locked || !!capture || working} onChange={event => { setRuntimeKey(event.target.value); edit(); }}>
        <option value="">{t("sourcePlugin.chooseRuntime")}</option>{runtimes.map(value => <option key={value.environmentDigest} value={value.environmentDigest}>{t(value.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(value.environment), system: value.environment.platform.operatingSystem, architecture: value.environment.platform.architecture })}</option>)}
      </select></Field>
      <Button variant="secondary" disabled={locked || pluginInventory.isFetching} onClick={() => {
        setConsent(null); setFailure(null); setRefresh(value => value + 1); void pluginInventory.refetch(); reads.invalidate(["execution"]);
      }}>{t("toolQuery.refresh")}</Button>
      {unavailable && !pluginInventory.isFetching && !inventory.isFetching && !ui.isFetching && !environment.isFetching
        ? <Banner tone="warning" role="status">{t(available.failed ? "toolQuery.noPresentation" : "toolQuery.unavailable")}</Banner> : null}
      {query ? <><h4>{currentTool?.binding.declaration.title}</h4><p>{currentTool?.binding.declaration.description}</p>
        {currentTool ? <details className={styles.provenance}><summary>{surface("packageDetails")}</summary>
          <p>{currentTool.binding.capability.provider.plugin.id} {currentTool.binding.capability.provider.plugin.version}</p>
          <p>{t("plugins.declaredPublisher", { publisher: currentTool.binding.capability.provider.plugin.publisher })}</p>
          <p>{t("plugins.origin", { source: currentTool.packageOrigin.sourceId, publisher: currentTool.packageOrigin.publisherId })}</p>
          <p>{surface("binding", { component: currentTool.binding.capability.provider.componentId, resource: currentTool.resourceId })}</p>
          {choice?.kind === "ui" ? <p>{surface("view", { view: choice.uiId })}</p> : null}
          <code>{currentTool.binding.capability.provider.packageDigest}</code>
        </details> : null}
        <Field label={query.target.label} description={query.target.description}><select value={effectiveTarget} disabled={draftLocked} onChange={event => { setTarget(event.target.value); edit(); }}>{query.target.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <fieldset disabled={draftLocked} className={styles.meanings} aria-describedby={`${selectionsId}-help`}><legend>{query.selections.label}</legend><p id={`${selectionsId}-help`}>{query.selections.description}</p>
          {query.selections.options.map((option, index) => <div className={styles.meaning} key={option.value}><label className={styles.check}><input type="checkbox" checked={selections.includes(option.value)} aria-describedby={`${selectionsId}-${index}`}
            onChange={event => { setSelections(values => event.target.checked ? [...values, option.value] : values.filter(value => value !== option.value)); edit(); }} />{option.label}</label>
            <p id={`${selectionsId}-${index}`} className={styles.description}>{option.description}</p></div>)}
        </fieldset>
      </> : null}
      <div className={styles.inputs} aria-label={t("toolQuery.inputs")}>
        {rows.map((row, index) => <div className={styles.inputRow} key={row.id}><Field label={t("toolQuery.text", { position: String(index + 1) })}>{control => <TextArea {...control} value={row.text} rows={3} disabled={draftLocked} aria-invalid={!!inputFailure && inputFailure.field === "text"}
          aria-describedby={inputFailure?.field === "text" ? inputErrorId : control["aria-describedby"]} onChange={event => { setRows(values => values.map(value => value.id === row.id ? { ...value, text: event.target.value } : value)); edit(); }} />}</Field>
          {rows.length > 1 ? <Button variant="link" disabled={draftLocked} onClick={() => { setRows(values => values.filter(value => value.id !== row.id)); edit(); }}>{t("toolQuery.remove", { position: String(index + 1) })}</Button> : null}</div>)}
        <Button variant="secondary" disabled={draftLocked} onClick={() => { const id = nextRow.current++; setRows(values => [...values, { id, text: "" }]); edit(); }}>{t("toolQuery.add")}</Button>
      </div>
      {inputFailure ? <Banner id={inputErrorId} tone="error" role="alert">{t(inputFailure.code === "text-required" ? "toolQuery.textRequired" : inputFailure.code === "invalid-selection" ? "toolQuery.selectionRequired" : inputFailure.code === "limit-exceeded" ? "toolQuery.tooLarge" : "toolQuery.inputChanged")}</Banner> : null}
      {changed ? <Banner tone="warning" role="status">{t("toolQuery.inputChanged")}</Banner> : null}
      {environmentChanged ? <Banner tone="warning" role="alert">{t("toolQuery.environmentChanged")}</Banner> : null}
      <Button variant={capture && !changed && !environmentChanged && run?.review.attemptId !== capture.review.attemptId ? "secondary" : "primary"} disabled={!preparationAvailability(preparationPayload).enabled} onClick={() => { if (preparationPayload) registry.dispatch("resource.prepare-tool", commandScope, preparationPayload); }}>{t("toolQuery.prepare")}</Button>
      {capture ? <section aria-label={t("toolQuery.review")}>
        <p>{t(visibleRun?.review.attemptId === capture.review.attemptId ? "toolQuery.executionCaptured" : "toolQuery.captured", { count: capture.review.items.length })}</p>
        {capturedPresentation ? <section aria-label={surface("preparedInputs")} className={styles.preview}>
          <h4>{surface("preparedInputs")}</h4>
          {capture.review.items.map((item, index) => {
            const capturedQuery = capturedPresentation.query;
            const text = field(item.payload, capturedQuery.textPath), targetValue = field(item.payload, capturedQuery.target.path), selected = field(item.payload, capturedQuery.selections.path);
            if (typeof text !== "string" || typeof targetValue !== "string" || !Array.isArray(selected) || !selected.every(value => typeof value === "string")) return <Banner key={item.itemId} tone="error" role="alert">{surface("previewUnavailable")}</Banner>;
            return <article key={item.itemId}><h5>{surface("preparedText", { position: index + 1 })}</h5><pre>{text}</pre>
              <dl className={styles.selectionSummary}><div><dt>{capturedQuery.target.label}</dt><dd>{capturedQuery.target.options.find(option => option.value === targetValue)?.label ?? targetValue}</dd></div>
                <div><dt>{capturedQuery.selections.label}</dt><dd><ul>{selected.map(value => <li key={value}>{capturedQuery.selections.options.find(option => option.value === value)?.label ?? value}</li>)}</ul></dd></div></dl>
            </article>;
          })}
        </section> : null}
        <PluginPermissions permissions={capture.review.tool.binding.capability.declaration.permissions} /><p>{t("sourcePlugin.unsandboxed")}</p>
        <p>{t(`toolQuery.scopes.${capture.review.tool.componentScope}`)}</p>
        {applicationBasis ? <section aria-label={t("toolQuery.applicationTitle")}>
          <p>{t("toolQuery.applicationHelp")}</p>
          {capture.review.tool.environment.profile === "native-application-host-v1" ? <p>{t("toolQuery.applicationNativeHelp")}</p> : null}
          <p>{t("toolQuery.applicationCapabilities")}</p>
          <ul>{capture.review.applicationCapabilities.map(member => <li key={member.contributionId}>{member.contributionId}</li>)}</ul>
          {instance.isFetching ? <p role="status">{t("toolQuery.applicationLoading")}</p> : null}
          {instance.error ? <Banner tone="error" role="alert"><CommandFailureDetails failure={commandFailure(instance.error)} /></Banner> : null}
          {instance.data ? <p role="status">{t(`toolQuery.applicationStates.${instance.data.state}`)}</p> : null}
          {instance.data?.state === "reserved" ? <label className={styles.check}><input type="checkbox" checked={session.state.applicationConsent === capture.review.inputDigest}
            disabled={locked || changed || environmentChanged} onChange={event => setApplicationConsent(event.target.checked ? capture.review.inputDigest : null)} />{t("toolQuery.applicationConsent")}</label> : null}
          <Button type="button" disabled={busy} onClick={() => { void instance.refetch(); }}>{t("toolQuery.applicationRefresh")}</Button>
          <Button type="button" disabled={!stopInstanceAvailability(capturePayload).enabled} onClick={() => { if (capturePayload) registry.dispatch("resource.stop-tool-instance", commandScope, capturePayload); }}>{t("toolQuery.applicationStop")}</Button>
        </section> : null}
        <details><summary>{t("sourcePlugin.fixedDetails")}</summary><p>{capture.review.tool.binding.declaration.title}</p><code>{capture.review.tool.binding.capability.provider.packageDigest}</code><p><code>{capture.review.tool.environmentDigest}</code></p>
          <p>{t("plugins.declaredPublisher", { publisher: capture.review.tool.binding.capability.provider.plugin.publisher })}</p>
          <p>{t("plugins.origin", { source: capture.review.tool.packageOrigin.sourceId, publisher: capture.review.tool.packageOrigin.publisherId })}</p>
          <p>{surface("binding", { component: capture.review.tool.binding.capability.provider.componentId, resource: capture.review.tool.resourceId })}</p>
        </details>
        {!run || run.review.attemptId !== capture.review.attemptId ? <><label className={styles.check}><input type="checkbox" checked={consent === capture.review.inputDigest} disabled={locked || changed || environmentChanged || unavailable} onChange={event => setConsent(event.target.checked ? capture.review.inputDigest : null)} />{t("toolQuery.consent")}</label>
          <Button variant="primary" disabled={!captureAvailability(capturePayload, true).enabled} onClick={() => { if (capturePayload) registry.dispatch("resource.start-tool", commandScope, capturePayload); }}>{t("toolQuery.start")}</Button></> : null}
        <Button variant="secondary" disabled={locked || working} onClick={() => { if (capturePayload) registry.dispatch("resource.discard-tool", commandScope, capturePayload); }}>{t("toolQuery.discardReview")}</Button>
      </section> : null}
      {pending?.kind === "start" ? <section role="status"><p>{t(session.state.checkingStart ? "execution.checkingPluginStart" : "toolQuery.startUnknown")}</p>
        <Button variant="secondary" disabled={!pendingAvailability(pendingPayload).enabled} onClick={() => { if (pendingPayload) registry.dispatch("resource.check-tool-start", commandScope, pendingPayload); }}>{t("execution.checkPluginStart")}</Button>
        {session.state.startRetryAllowed ? <><p>{t("execution.pluginStartMissing")}</p><Button variant="secondary" disabled={!pendingAvailability(pendingPayload, true).enabled} onClick={() => { if (pendingPayload) registry.dispatch("resource.retry-tool", commandScope, pendingPayload); }}>{t("execution.retryPluginStart")}</Button></> : null}
      </section> : pending ? <Button variant="secondary" disabled={!pendingAvailability(pendingPayload, true).enabled} onClick={() => { if (pendingPayload) registry.dispatch("resource.retry-tool", commandScope, pendingPayload); }}>{t("toolQuery.retryOriginal")}</Button> : null}
      {detail.data && visibleRun ? <section aria-label={t("toolQuery.results")}><h4>{t("toolQuery.results")}</h4><p>{t("toolQuery.references")}</p>
        {detail.data.items.map(item => {
          const fixed = visibleRun.review.items.find(value => value.itemId === item.status.itemId);
          const text = fixed && runPresentation ? field(fixed.payload, runPresentation.query.textPath) : undefined;
          const result = item.resultId ? entries(item.resultId, item.status.itemId) : null;
          return <article key={item.status.itemId}><blockquote><pre>{typeof text === "string" ? text : t("toolQuery.invalidResult")}</pre></blockquote><p>{t(`execution.states.${item.status.execution}`)}</p>
            {item.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><p>{item.status.diagnostic}</p></details> : null}
            {item.status.execution === "succeeded" && !output.isFetching && !output.error && runPresentation ? result === null ? <p role="alert">{t("toolQuery.invalidResult")}</p>
              : result.length === 0 ? <p>{runPresentation.query.output.emptyDescription}</p> : <div className={styles.scroll}><table className={styles.table}><thead><tr>{runPresentation.query.output.columns.map(column => <th key={jsonIdentity(column.path)} scope="col">{column.label}</th>)}</tr></thead><tbody>{result.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><pre>{cell}</pre></td>)}</tr>)}</tbody></table></div> : null}
          </article>;
        })}
        {working && taskId && attemptId ? <Button variant="secondary" disabled={!cancelAvailability(cancelPayload).enabled}
          onClick={() => { if (cancelPayload) registry.dispatch("resource.cancel-tool", commandScope, cancelPayload); }}>{t("toolQuery.cancel")}</Button> : null}
      </section> : null}
    </section>
    <Dialog open={leave} onOpenChange={value => { if (!value && !busy) answerLeave(false); }} title={t("toolQuery.leaveTitle")} description={t("toolQuery.leaveHelp")}
      closeLabel={surface("closeConfirmation")} closeDisabled={busy} onPointerDownOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); if (leaveTrigger.current?.isConnected) leaveTrigger.current.focus(); }}
      footer={<div className={styles.actions}>
        <Button variant="secondary" disabled={busy} onClick={() => answerLeave(false)}>{t("resource.stay")}</Button>
        <Button variant="primary" pending={busy} disabled={locked} onClick={() => void discardAndLeave()}>{t("resource.discardAndLeave")}</Button>
      </div>}>{busy ? <p role="status">{t("execution.working")}</p> : null}</Dialog>
  </>;
}
