import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { createToolQuery, ToolQueryError, type ToolQueryPresentation } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { commandFailure, CommandFailureDetails, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type PluginToolPrepareRequest, type PluginToolPreflight, type PluginStartRequest, type PluginToolDiscardRequest, type CancelRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { pluginCommands, type PluginToolRequest, type PluginToolView } from "./pluginCommands";
import { approvedPluginEnvironments, matchingPluginEnvironments, pluginEnvironmentVersion } from "./pluginEnvironments";
import { PluginPermissions } from "./PluginManager";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";

export interface ToolQueryState { busy: boolean; pending: boolean; hasDraft: boolean }
export interface ToolQueryHandle { allowLeave: () => Promise<boolean> }
type DraftRow = { id: number; text: string };
type Intent =
  | { kind: "prepare"; request: PluginToolPrepareRequest; view: PluginToolView; sequence: number }
  | { kind: "start"; request: PluginStartRequest; review: PluginToolPreflight; sequence: number }
  | { kind: "discard"; request: PluginToolDiscardRequest }
  | { kind: "cancel"; request: CancelRequest };
type Capture = { review: PluginToolPreflight; sequence: number };

// Compare opaque JSON identity independently of object key order. This is a
// presentation check; the original native boundary still captures and binds it.
function jsonIdentity(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
function field(value: unknown, path: readonly (string | number)[]): unknown {
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = Object.getOwnPropertyDescriptor(value, String(key))?.value;
  }
  return value;
}
function matches(view: PluginToolView, request: PluginToolRequest): boolean {
  const provider = view.binding.capability.provider;
  return view.resourceId === request.resourceId && view.environmentDigest === request.environmentDigest
    && provider.packageDigest === request.package.packageDigest && jsonIdentity(provider.plugin) === jsonIdentity(request.package.plugin);
}
function presentation(view: PluginToolView | undefined): { value: ToolQueryPresentation | null; failed: boolean } {
  if (!view) return { value: null, failed: false };
  try { return { value: createToolQuery(view.binding), failed: false }; }
  catch { return { value: null, failed: true }; }
}

/** Shared SDK input construction, original execution consent and ledger reads.
 * Drafts survive hidden panels; references never become project mutations. */
export function PluginToolQueries({ project, open, disabled, onState, onAttention, ref }: {
  project: ProjectView; open: boolean; disabled: boolean;
  onState: (state: ToolQueryState) => void; onAttention: () => void; ref?: Ref<ToolQueryHandle>;
}) {
  const { t } = useTranslation(), context = executionContext(project), reads = useSessionReads();
  const [choiceKey, setChoiceKey] = useState(""), [runtimeKey, setRuntimeKey] = useState(""), [refresh, setRefresh] = useState(0);
  const [rows, setRows] = useState<DraftRow[]>([{ id: 0, text: "" }]), nextRow = useRef(1);
  const [target, setTarget] = useState(""), [selections, setSelections] = useState<string[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null), [run, setRun] = useState<Capture | null>(null);
  const [consent, setConsent] = useState<string | null>(null), [submittedSequence, setSubmittedSequence] = useState(-1);
  const [pending, setPending] = useState<Intent | null>(null), pendingRef = useRef<Intent | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<CommandFailure | null>(null);
  const [inputFailure, setInputFailure] = useState<ToolQueryError | null>(null), [leave, setLeave] = useState(false);
  const draftSequence = useRef(0), mounted = useRef(true), running = useRef(false), requestSequence = useRef(0);
  const leaveResolver = useRef<((answer: boolean) => void) | null>(null), leaveTrigger = useRef<HTMLElement | null>(null);
  const errorRegion = useRef<HTMLDivElement>(null);
  const inventory = useSessionQuery({ key: ["tool-query-inventory", refresh], scopes: [], enabled: open && !disabled,
    read: async () => {
      const value = await pluginCommands.inventory();
      const enabled = value.packages.filter(item => item.state === "sealed" && value.packageDecisions.some(decision => decision.enabled
        && decision.packageDigest === item.packageDigest && jsonIdentity(decision.plugin) === jsonIdentity(item.plugin)));
      const packages = await Promise.all(enabled.map(item => pluginCommands.package({ plugin: item.plugin, packageDigest: item.packageDigest })));
      const choices = packages.flatMap(item => item.manifest.contributions.flatMap(contribution => contribution.contribution.kind === "resource"
        && contribution.contribution.schema.id === "tsumugi.capability-tool-declaration" && contribution.contribution.schema.schemaVersion === 1
        && contribution.contribution.schema.behaviorVersion === 1 ? [{ key: `${item.packageDigest}:${contribution.id}`,
          label: `${item.manifest.plugin.id} ${item.manifest.plugin.version} · ${contribution.id}`,
          package: { plugin: item.manifest.plugin, packageDigest: item.packageDigest }, resourceId: contribution.id,
          runtimeKinds: item.manifest.components.map(component => component.runtime) }] : []));
      return { choices, runtimes: approvedPluginEnvironments(value) };
    } });
  const choices = inventory.data?.choices ?? [], effectiveChoice = choiceKey || (choices.length === 1 ? choices[0].key : "");
  const choice = choices.find(item => item.key === effectiveChoice);
  const runtimes = matchingPluginEnvironments(inventory.data?.runtimes ?? [], choice?.runtimeKinds ?? []);
  const effectiveRuntime = runtimeKey || (runtimes.length === 1 ? runtimes[0].environmentDigest : "");
  const toolRequest: PluginToolRequest | null = choice && effectiveRuntime ? { package: choice.package, resourceId: choice.resourceId, environmentDigest: effectiveRuntime } : null;
  const environment = useSessionQuery({ key: ["tool-query-environment", effectiveChoice, effectiveRuntime, refresh, inventory.dataUpdatedAt], scopes: [],
    enabled: open && !disabled && !!toolRequest && runtimes.some(item => item.environmentDigest === effectiveRuntime) && !inventory.error && !inventory.isFetching,
    read: async () => {
      if (!toolRequest) throw new Error("Missing tool choice");
      const value = await pluginCommands.tool(toolRequest);
      if (!matches(value, toolRequest)) throw new Error("Tool environment identity changed");
      return value;
    } });
  const available = useMemo(() => presentation(environment.data), [environment.data]), query = available.value?.query;
  const defaultTarget = query ? field(query.inputTemplate, query.target.path) : undefined;
  const effectiveTarget = target || (typeof defaultTarget === "string" ? defaultTarget : "");
  const unavailable = !toolRequest || !runtimes.some(item => item.environmentDigest === effectiveRuntime) || !available.value || !!inventory.error || !!environment.error;
  const environmentChanged = !!capture && (!environment.data || jsonIdentity(environment.data) !== jsonIdentity(capture.review.tool));
  const changed = !!capture && capture.sequence !== draftSequence.current;
  const visibleRun = pending?.kind === "start" ? { review: pending.review, sequence: pending.sequence } : run;
  const attemptId = visibleRun?.review.attemptId ?? null;
  const detail = useSessionQuery({ key: ["tool-query-attempt", attemptId], scopes: ["execution"], enabled: open && !!attemptId && !busy,
    read: async () => {
      if (!attemptId) return null;
      const value = await readCompleteAttempt(context, attemptId, "plugin-tool-query");
      if (value && visibleRun && (value.items.length !== visibleRun.review.items.length
        || value.items.some(item => !visibleRun.review.items.some(fixed => fixed.itemId === item.status.itemId)))) throw new Error("Tool result coverage changed");
      return value;
    } });
  const resultIds = detail.data?.items.flatMap(item => item.resultId ? [item.resultId] : []) ?? [];
  const taskId = detail.data?.taskId;
  const output = useSessionQuery({ key: ["tool-query-output", attemptId, ...resultIds], scopes: ["execution"], enabled: open && !!attemptId && !busy && !!resultIds.length,
    read: async () => {
      if (!attemptId) return [];
      return Promise.all(resultIds.map(resultId => executionCommands.output({ ...context, attemptId, resultId })));
    } });
  const working = !!attemptId && (!detail.data || detail.data.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched"));
  const locked = disabled || busy || !!pending;
  const draftLocked = disabled || (!!pending && pending.kind !== "prepare");
  const hasDraft = rows.some(row => row.text.length > 0) && draftSequence.current !== submittedSequence;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestSequence.current++; leaveResolver.current?.(false); }; }, []);
  useEffect(() => { onState({ busy: busy || working, pending: !!pending, hasDraft }); }, [busy, working, !!pending, hasDraft, onState]);
  useEffect(() => { if (failure && open) errorRegion.current?.focus(); }, [failure, open]);
  useEffect(() => { const error = inventory.error ?? environment.error ?? detail.error ?? output.error; if (error) setFailure(commandFailure(error)); }, [inventory.error, environment.error, detail.error, output.error]);

  function edit() { draftSequence.current++; setConsent(null); setInputFailure(null); }
  function retain(intent: Intent | null) { pendingRef.current = intent; setPending(intent); }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setFailure(null);
    const ticket = ++requestSequence.current, current = () => mounted.current && requestSequence.current === ticket;
    try { await work(current); } catch (error) { if (current()) { if (error instanceof ToolQueryError) setInputFailure(error); else setFailure(commandFailure(error)); } }
    finally { running.current = false; if (mounted.current) { setBusy(false); reads.invalidate(["execution"]); } }
  }
  async function submit(intent: Intent, current: () => boolean) {
    retain(intent);
    try {
      switch (intent.kind) {
        case "prepare": {
          const value = await executionCommands.prepareTool(intent.request);
          const expected = new Map<string | undefined, number>();
          intent.request.payloads.forEach(payload => { const key = jsonIdentity(payload); expected.set(key, (expected.get(key) ?? 0) + 1); });
          if (value.attemptId !== intent.request.attemptId || !matches(value.tool, intent.request.tool)
            || jsonIdentity(value.tool.binding) !== jsonIdentity(intent.view.binding)
            || jsonIdentity(value.tool.environment) !== jsonIdentity(intent.view.environment) || value.items.length !== intent.request.payloads.length
            || new Set(value.items.map(item => item.itemId)).size !== value.items.length) throw new Error("Tool preparation identity changed");
          for (const item of value.items) { const key = jsonIdentity(item.payload), count = expected.get(key) ?? 0; if (!count) throw new Error("Tool input coverage changed"); expected.set(key, count - 1); }
          if (current()) { setCapture({ review: value, sequence: intent.sequence }); setConsent(null); retain(null); }
          break;
        }
        case "start": {
          const id = await executionCommands.startTool(intent.request);
          if (id !== intent.request.attemptId) throw new Error("Tool attempt identity changed");
          if (current()) { setRun({ review: intent.review, sequence: intent.sequence }); setSubmittedSequence(intent.sequence); retain(null); }
          break;
        }
        case "discard": await executionCommands.discardTool(intent.request); if (current()) { setCapture(null); setConsent(null); retain(null); } break;
        case "cancel": await executionCommands.cancel(intent.request); if (current()) retain(null); break;
      }
    } catch (error) { if (current() && !hasUnknownOutcome(error)) { retain(null); setConsent(null); } throw error; }
  }
  async function prepare(current: () => boolean) {
    const helper = available.value;
    if (!helper || !environment.data || !toolRequest || unavailable) return;
    const sequence = draftSequence.current;
    const payloads = rows.map(row => helper.prepare({ text: row.text, target: effectiveTarget, selections }));
    const id = await executionCommands.identity(context);
    if (current()) await submit({ kind: "prepare", request: { ...context, tool: toolRequest, attemptId: id, payloads }, view: environment.data, sequence }, current);
  }
  async function start(current: () => boolean) {
    if (!capture || changed || environmentChanged || unavailable || consent !== capture.review.inputDigest) return;
    const grantId = await executionCommands.identity(context);
    if (!current()) return;
    if (capture.sequence !== draftSequence.current) throw new ToolQueryError("input-changed", "text");
    await submit({ kind: "start", review: capture.review, sequence: capture.sequence,
      request: { ...context, attemptId: capture.review.attemptId, inputDigest: capture.review.inputDigest, grantId, expiresAtMs: String(Date.now() + 600_000), unsandboxedExecution: true } }, current);
  }
  function answerLeave(answer: boolean) { setLeave(false); leaveResolver.current?.(answer); leaveResolver.current = null; }
  useImperativeHandle(ref, () => ({ allowLeave() {
    if (running.current || pendingRef.current || working) { onAttention(); return Promise.resolve(false); }
    if (!hasDraft && !capture) return Promise.resolve(true);
    onAttention(); leaveTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeave(true); return new Promise(resolve => { leaveResolver.current?.(false); leaveResolver.current = resolve; });
  } }));
  async function discard(current: () => boolean) {
    if (capture) await submit({ kind: "discard", request: { ...context, attemptId: capture.review.attemptId } }, current);
  }
  const runView = visibleRun?.review.tool;
  const runPresentation = useMemo(() => presentation(runView).value, [runView]);
  function entries(resultId: string, itemId: string): string[][] | null {
    const result = output.data?.find(value => value?.resultId === resultId);
    if (!result || result.attemptId !== attemptId || result.projectId !== context.projectId || result.itemId !== itemId || result.outcome !== "succeeded" || !runPresentation) return null;
    try { return runPresentation.entries(result.output); } catch { return null; }
  }
  return <>
    <section hidden={!open} aria-label={t("toolQuery.title")} aria-busy={busy || inventory.isFetching || environment.isFetching}>
      <h3>{t("toolQuery.title")}</h3><p>{t("toolQuery.help")}</p>
      {failure ? <div ref={errorRegion} role="alert" tabIndex={-1}><p>{t("toolQuery.failed")}</p><CommandFailureDetails failure={failure} /></div> : null}
      {inventory.isFetching || environment.isFetching || busy || working ? <p role="status">{t("execution.working")}</p> : null}
      <label className="source-field">{t("toolQuery.provider")}<select value={effectiveChoice} disabled={locked || !!capture || working} onChange={event => { setChoiceKey(event.target.value); setRuntimeKey(""); setTarget(""); setSelections([]); edit(); }}>
        <option value="">{t("toolQuery.chooseProvider")}</option>{choices.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}
      </select></label>
      <label className="source-field">{t("sourcePlugin.runtime")}<select value={effectiveRuntime} disabled={locked || !!capture || working} onChange={event => { setRuntimeKey(event.target.value); edit(); }}>
        <option value="">{t("sourcePlugin.chooseRuntime")}</option>{runtimes.map(value => <option key={value.environmentDigest} value={value.environmentDigest}>{t(value.environment.profile === "node-system-libraries-v1" ? "sourcePlugin.runtimeOption" : "sourcePlugin.nativeRuntimeOption", { version: pluginEnvironmentVersion(value.environment), system: value.environment.platform.operatingSystem, architecture: value.environment.platform.architecture })}</option>)}
      </select></label>
      <button className="secondary-button" disabled={locked} onClick={() => { setConsent(null); setFailure(null); setRefresh(value => value + 1); reads.invalidate(["execution"]); }}>{t("toolQuery.refresh")}</button>
      {unavailable && !inventory.isFetching && !environment.isFetching ? <p role="status">{t(available.failed ? "toolQuery.noPresentation" : "toolQuery.unavailable")}</p> : null}
      {query ? <><h4>{environment.data?.binding.declaration.title}</h4><p>{environment.data?.binding.declaration.description}</p>
        <label className="source-field">{query.target.label}<select value={effectiveTarget} disabled={draftLocked} onChange={event => { setTarget(event.target.value); edit(); }}>{query.target.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><p>{query.target.description}</p>
        <fieldset disabled={draftLocked}><legend>{query.selections.label}</legend><p>{query.selections.description}</p>
          {query.selections.options.map(option => <label className="source-check" key={option.value}><input type="checkbox" checked={selections.includes(option.value)} onChange={event => { setSelections(values => event.target.checked ? [...values, option.value] : values.filter(value => value !== option.value)); edit(); }} />{option.label}<span>{option.description}</span></label>)}
        </fieldset>
      </> : null}
      <div aria-label={t("toolQuery.inputs")}>
        {rows.map((row, index) => <div key={row.id}><label className="source-field">{t("toolQuery.text", { position: String(index + 1) })}<textarea value={row.text} rows={3} disabled={draftLocked} aria-invalid={!!inputFailure && inputFailure.field === "text"} onChange={event => { setRows(values => values.map(value => value.id === row.id ? { ...value, text: event.target.value } : value)); edit(); }} /></label>
          {rows.length > 1 ? <button className="text-button" disabled={draftLocked} onClick={() => { setRows(values => values.filter(value => value.id !== row.id)); edit(); }}>{t("toolQuery.remove", { position: String(index + 1) })}</button> : null}</div>)}
        <button className="secondary-button" disabled={draftLocked} onClick={() => { const id = nextRow.current++; setRows(values => [...values, { id, text: "" }]); edit(); }}>{t("toolQuery.add")}</button>
      </div>
      {inputFailure ? <p role="alert">{t(inputFailure.code === "text-required" ? "toolQuery.textRequired" : inputFailure.code === "invalid-selection" ? "toolQuery.selectionRequired" : inputFailure.code === "limit-exceeded" ? "toolQuery.tooLarge" : "toolQuery.inputChanged")}</p> : null}
      {changed ? <p role="status">{t("toolQuery.inputChanged")}</p> : null}
      {environmentChanged ? <p role="alert">{t("toolQuery.environmentChanged")}</p> : null}
      <button className={capture && !changed && !environmentChanged && run?.review.attemptId !== capture.review.attemptId ? "secondary-button" : "primary-button"} disabled={locked || working || unavailable || inventory.isFetching || environment.isFetching} onClick={() => void perform(prepare)}>{t("toolQuery.prepare")}</button>
      {capture ? <section aria-label={t("toolQuery.review")}>
        <p>{t(visibleRun?.review.attemptId === capture.review.attemptId ? "toolQuery.executionCaptured" : "toolQuery.captured", { count: capture.review.items.length })}</p>
        <PluginPermissions permissions={capture.review.tool.binding.capability.declaration.permissions} /><p>{t("sourcePlugin.unsandboxed")}</p>
        <details><summary>{t("sourcePlugin.fixedDetails")}</summary><p>{capture.review.tool.binding.declaration.title}</p><code>{capture.review.tool.binding.capability.provider.packageDigest}</code><p><code>{capture.review.tool.environmentDigest}</code></p>
          {capture.review.items.map(item => <pre key={item.itemId}>{typeof field(item.payload, capture.review.tool.binding.declaration.query?.textPath ?? []) === "string" ? String(field(item.payload, capture.review.tool.binding.declaration.query?.textPath ?? [])) : t("toolQuery.invalidResult")}</pre>)}
        </details>
        {!run || run.review.attemptId !== capture.review.attemptId ? <><label className="source-check"><input type="checkbox" checked={consent === capture.review.inputDigest} disabled={locked || changed || environmentChanged || unavailable} onChange={event => setConsent(event.target.checked ? capture.review.inputDigest : null)} />{t("toolQuery.consent")}</label>
          <button className="primary-button" disabled={locked || changed || environmentChanged || unavailable || consent !== capture.review.inputDigest || inventory.isFetching || environment.isFetching} onClick={() => void perform(start)}>{t("toolQuery.start")}</button></> : null}
        <button className="secondary-button" disabled={locked || working} onClick={() => void perform(discard)}>{t("toolQuery.discardReview")}</button>
      </section> : null}
      {pending ? <button className="secondary-button" disabled={busy || disabled} onClick={() => void perform(current => submit(pending, current))}>{t("toolQuery.retryOriginal")}</button> : null}
      {detail.data && visibleRun ? <section aria-label={t("toolQuery.results")}><h4>{t("toolQuery.results")}</h4><p>{t("toolQuery.references")}</p>
        {detail.data.items.map(item => {
          const fixed = visibleRun.review.items.find(value => value.itemId === item.status.itemId);
          const text = fixed && runPresentation ? field(fixed.payload, runPresentation.query.textPath) : undefined;
          const result = item.resultId ? entries(item.resultId, item.status.itemId) : null;
          return <article key={item.status.itemId}><blockquote><pre>{typeof text === "string" ? text : t("toolQuery.invalidResult")}</pre></blockquote><p>{t(`execution.states.${item.status.execution}`)}</p>
            {item.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><p>{item.status.diagnostic}</p></details> : null}
            {item.status.execution === "succeeded" && !output.isFetching && runPresentation ? result === null ? <p role="alert">{t("toolQuery.invalidResult")}</p>
              : result.length === 0 ? <p>{runPresentation.query.output.emptyDescription}</p> : <div className="source-table-scroll"><table className="source-table"><thead><tr>{runPresentation.query.output.columns.map(column => <th key={jsonIdentity(column.path)} scope="col">{column.label}</th>)}</tr></thead><tbody>{result.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><pre>{cell}</pre></td>)}</tr>)}</tbody></table></div> : null}
          </article>;
        })}
        {working && taskId ? <button className="secondary-button" disabled={locked} onClick={() => void perform(async current => { const requestId = await executionCommands.identity(context); if (current()) await submit({ kind: "cancel", request: { ...context, taskId, requestId } }, current); })}>{t("toolQuery.cancel")}</button> : null}
      </section> : null}
    </section>
    <Dialog.Root open={leave} onOpenChange={value => { if (!value && !busy) answerLeave(false); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="confirm-dialog" onPointerDownOutside={event => event.preventDefault()} onCloseAutoFocus={event => { event.preventDefault(); leaveTrigger.current?.focus(); }}>
      <Dialog.Title>{t("toolQuery.leaveTitle")}</Dialog.Title><Dialog.Description>{t("toolQuery.leaveHelp")}</Dialog.Description><div className="form-actions">
        <button className="secondary-button" disabled={busy} onClick={() => answerLeave(false)}>{t("resource.stay")}</button>
        <button className="primary-button" disabled={locked} onClick={() => void perform(async current => { await discard(current); if (current()) { setRows([{ id: nextRow.current++, text: "" }]); edit(); answerLeave(true); } })}>{t("resource.discardAndLeave")}</button>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </>;
}
