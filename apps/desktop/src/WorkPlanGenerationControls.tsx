import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { readRecordedAttempt } from "./executionRead";
import { pluginCommands } from "./pluginCommands";
import { pluginEnvironmentVersion } from "./pluginEnvironments";
import { readPluginGenerationChoices } from "./pluginGenerationChoices";
import { jsonIdentity } from "./pluginToolChoices";
import { PluginPermissions } from "./PluginManager";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { openWorkPlanAgentScope, type WorkPlanStatusView } from "./workPlanCommands";
import { workPlanGenerationCommands } from "./workPlanGenerationCommands";
import type { WorkPlanGenerationPreflight } from "./generated/ai.responses";
import type { WorkPlanGenerationStartRequest } from "./generated/ai.requests";
import type { WorkPlanContinuation } from "./AiPreparationSession";
import { useWorkbenchCommands, type CommandAvailability, type AiComponentPrepareCommandPayload, type AiComponentCommandPayload } from "./workbenchCommands";
import { enUS } from "./i18n/en-US";

type Consent = Pick<WorkPlanGenerationStartRequest, "grantId" | "expiresAtMs" | "unsandboxedExecution">;
export type ComponentOperation = { prepared: WorkPlanGenerationPreflight; plan: WorkPlanStatusView["plan"]; lease: WorkPlanStatusView["lease"];
  phase: "prepared" | "submitted" | "unknown" | "rejected"; consent: Consent | null };
function unknown(): never { throw { outcome: "unknown", reason: "work-plan-pending" }; }

export interface ComponentState { operation: ComponentOperation | null; consentDigest: string | null; discardUnknown: boolean }
const initialComponent = (): ComponentState => ({ operation: null, consentDigest: null, discardUnknown: false });
export function useWorkPlanGenerationSession(live: () => boolean) {
  const [state, setState] = useState(initialComponent), ref = useRef(state), notified = useRef<string | null>(null);
  const readCleanups = useRef(new Set<() => void>());
  useLayoutEffect(() => () => { readCleanups.current.forEach(dispose => dispose()); readCleanups.current.clear(); }, []);
  function update(change: (before: ComponentState) => ComponentState) {
    if (!live()) return;
    ref.current = change(ref.current); setState(ref.current);
  }
  return { state, current: () => ref.current, update, notified,
    holdRead(dispose: () => void) { readCleanups.current.add(dispose); return () => { dispose(); readCleanups.current.delete(dispose); }; },
    reset() { notified.current = null; update(initialComponent); } };
}
export type WorkPlanGenerationSession = ReturnType<typeof useWorkPlanGenerationSession>;

/** Human component consent stays separate from the bounded Agent consumer. */
export function WorkPlanGenerationControls({ context, status, selected, open, disabled, busy, run, onBlockedChange, onGenerated, session, ownerBusy }: {
  session: WorkPlanGenerationSession; ownerBusy: () => boolean;
  context: SessionRequest; status: WorkPlanStatusView; selected: readonly string[]; open: boolean; disabled: boolean; busy: boolean;
  run: (work: (current: WorkPlanContinuation) => Promise<void>) => Promise<void>;
  onBlockedChange: (blocked: boolean) => void; onGenerated: (attemptId: string) => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads(), registry = useWorkbenchCommands();
  const [expanded, setExpanded] = useState(false), [choiceKey, setChoiceKey] = useState(""), [profileKey, setProfileKey] = useState("");
  const [runtimeKey, setRuntimeKey] = useState(""), [refresh, setRefresh] = useState(0);
  const { operation, consentDigest, discardUnknown } = session.state;
  const setOperation = (operation: ComponentOperation | null) => session.update(before => ({ ...before, operation }));
  const setConsentDigest = (consentDigest: string | null) => session.update(before => ({ ...before, consentDigest }));
  const setDiscardUnknown = (discardUnknown: boolean) => session.update(before => ({ ...before, discardUnknown }));
  const notified = session.notified;
  const entryRef = useRef<HTMLButtonElement>(null), reviewRef = useRef<HTMLHeadingElement>(null), focusedReview = useRef<string | null>(null);
  const inventoryKey = ["generation-component-inventory", refresh];
  const inventory = useSessionQuery({ key: inventoryKey, scopes: [],
    enabled: open && expanded && !disabled && !busy && !operation, read: readPluginGenerationChoices });
  const choice = inventory.data?.choices.find(item => item.key === choiceKey);
  const runtime = inventory.data?.runtimes.find(item => item.environmentDigest === runtimeKey);
  const profile = choice?.declaration.profiles.find(item => jsonIdentity(item) === profileKey);
  const completeProfile = !!choice && (choice.declaration.profiles.length === 0 ? profileKey === "none" : !!profile);
  const request = choice && runtime && completeProfile
    ? { provider: choice.provider, profile: profile ?? null, environmentDigest: runtime.environmentDigest } : null;
  const environmentKey = ["generation-component-environment", choiceKey, profileKey, runtimeKey, refresh, inventory.dataUpdatedAt];
  const environment = useSessionQuery({ key: environmentKey, scopes: [],
    enabled: open && expanded && !disabled && !busy && !operation && !!request && !inventory.error && !inventory.isFetching,
    read: async () => { if (!request) throw new Error("Missing generation component choice"); return pluginCommands.generationComponent(request); } });
  const active = status.state === "active" && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000));
  const validUnits = selected.length > 0 && new Set(selected).size === selected.length
    && selected.every(id => status.plan.scope.some(unit => unit.unitId === id));
  const stale = !!operation && (jsonIdentity(operation.lease) !== jsonIdentity(status.lease) || operation.plan.digest !== status.plan.digest
    || operation.prepared.scope.some(unit => jsonIdentity(unit) !== jsonIdentity(status.plan.scope.find(item => item.unitId === unit.unitId))));
  const outerAttempt = operation?.prepared.attemptId ?? null;
  useEffect(() => {
    if (busy) return;
    if (outerAttempt && focusedReview.current !== outerAttempt) { focusedReview.current = outerAttempt; reviewRef.current?.focus(); }
    else if (!outerAttempt && focusedReview.current) { focusedReview.current = null; entryRef.current?.focus(); }
  }, [outerAttempt, busy]);
  const observation = useSessionQuery({ key: ["generation-component-executions", outerAttempt], scopes: ["execution"],
    enabled: open && !!operation && (operation.phase !== "prepared" || discardUnknown) && !busy,
    read: async () => {
      if (!operation) return null;
      const { prepared } = operation;
      const [outer, child] = await Promise.all([
        readRecordedAttempt(context, prepared.taskId, prepared.attemptId, "work-plan-generation-component"),
        readRecordedAttempt(context, prepared.generation.taskId, prepared.generation.attemptId, "ai-translation"),
      ]);
      if (outer && (outer.progress.total !== 1 || outer.items[0].scope.kind !== "work-plan-generation-component"
        || outer.items[0].scope.id !== context.projectId || outer.items[0].scope.locale !== null)) unknown();
      if (child && (child.taskId !== prepared.generation.taskId || child.progress.total !== prepared.scope.length
        || new Set(child.items.map(item => item.scope.id)).size !== prepared.scope.length
        || child.items.some(item => item.scope.kind !== "translation-unit" || item.scope.locale !== operation.plan.locale
          || !prepared.generation.unitIds.includes(item.scope.id)))) unknown();
      return { outer, child };
    } });
  const outer = observation.data?.outer;
  const settled = !!outer && outer.items.every(item => !["queued", "dispatched"].includes(item.status.execution));
  const blocked = !!operation && (!settled || discardUnknown);
  useEffect(() => { onBlockedChange(blocked); return () => onBlockedChange(false); }, [blocked, onBlockedChange]);
  const childId = observation.data?.child?.attemptId ?? null;
  useEffect(() => {
    if (childId && notified.current !== childId) { notified.current = childId; onGenerated(childId); }
  }, [childId, onGenerated]);
  const locked = disabled || busy || !!operation || !active;
  const readFailure = inventory.error ?? environment.error ?? observation.error;
  const preparingAllowed = !locked && validUnits && request && environment.data && !readFailure && !inventory.isFetching && !environment.isFetching;
  async function prepare(current: WorkPlanContinuation) {
    if (!preparingAllowed || !request || !environment.data) return;
    const fixed = structuredClone({ request, component: environment.data, lease: status.lease, plan: status.plan, ids: selected });
    const originalInventory = inventory.data;
    const inventoryWitness = reads.watchExactQuery(inventoryKey), environmentWitness = reads.watchExactQuery(environmentKey);
    const dispose = session.holdRead(() => { inventoryWitness.dispose(); environmentWitness.dispose(); });
    const checked = () => {
      const inventoryQuery = inventoryWitness.current(), environmentQuery = environmentWitness.current();
      return current.fresh() && inventoryQuery?.state.status === "success" && inventoryQuery.state.error === null
        && environmentQuery?.state.status === "success" && environmentQuery.state.error === null
        && jsonIdentity(inventoryQuery.state.data) === jsonIdentity(originalInventory)
        && jsonIdentity(environmentQuery.state.data) === jsonIdentity(fixed.component);
    };
    try {
    const scope = await openWorkPlanAgentScope({ ...context, lease: fixed.lease }, fixed.plan.scope);
    if (!checked()) return;
    const [taskId, attemptId, outerId] = await Promise.all([
      executionCommands.identity(context), executionCommands.identity(context), executionCommands.identity(context),
    ]);
    if (!checked()) return;
    const [first,...rest]=fixed.ids;
    if(!first)return;
    const prepared = await workPlanGenerationCommands.prepare({ ...context, scopeId: scope.scopeId, attemptId: outerId,
      component: fixed.request, generation: { taskId, attemptId, unitIds: [first,...rest] } }, scope, fixed.component);
    if (!checked()) {
      if(current()) {
        // Preserve the original Host capture until its disposal is acknowledged.
        setOperation({ prepared, plan:fixed.plan, lease:fixed.lease, phase:"prepared", consent:null });
        setConsentDigest(null); setDiscardUnknown(true);
        const removed=await workPlanGenerationCommands.discard({ ...context, attemptId:prepared.attemptId });
        if(current()) {
          if(!removed)unknown();
          setOperation(null); setDiscardUnknown(false);
        }
      }
      return;
    }
    setConsentDigest(null); setDiscardUnknown(false);
    setOperation({ prepared, plan: fixed.plan, lease: fixed.lease, phase: "prepared", consent: null });
    } finally { dispose(); }
  }
  async function start(current: WorkPlanContinuation) {
    if (!operation || !active || stale || consentDigest !== operation.prepared.inputDigest
      || !["prepared", "rejected"].includes(operation.phase)) return;
    const original = operation;
    const expiresAtMs=String(Date.now()+600_000);
    const consent = original.consent ?? { grantId: await executionCommands.identity(context), expiresAtMs, unsandboxedExecution: true };
    if (!current.fresh()) return;
    const starting: ComponentOperation = { ...original, consent, phase: "unknown" };
    setOperation(starting);
    try {
      await workPlanGenerationCommands.start(original.prepared, consent);
      if (current()) { setOperation({ ...starting, phase: "submitted" }); reads.invalidate(["execution"]); }
    } catch (error) {
      if (current()) { setOperation({ ...starting, phase: hasUnknownOutcome(error) ? "unknown" : "rejected" }); reads.invalidate(["execution"]); }
      throw error;
    }
  }
  async function discard(current: WorkPlanContinuation) {
    if (!operation) return;
    setDiscardUnknown(true);
    const removed = await workPlanGenerationCommands.discard({ ...context, attemptId: operation.prepared.attemptId });
    if (!current()) return;
    if (!removed) { setOperation({ ...operation, phase: "unknown" }); setDiscardUnknown(false); reads.invalidate(["execution"]); unknown(); }
    setOperation(null); setConsentDigest(null); setDiscardUnknown(false);
  }
  const canStart = operation && ["prepared", "rejected"].includes(operation.phase) && !discardUnknown
    && active && !stale && !busy && !disabled && consentDigest === operation.prepared.inputDigest
    && (!operation.consent || BigInt(operation.consent.expiresAtMs) > BigInt(Date.now()));
  const scope={projectId:context.projectId,sessionToken:context.sessionToken,area:"ai" as const};
  const unavailable:CommandAvailability={enabled:false,reason:"unavailable"};
  function planCurrent(){const query=reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan",status.lease.planId]));
    return query?.status==="success"&&query.fetchStatus==="idle"&&!query.isInvalidated&&query.error===null
      &&query.data?.plan.digest===status.plan.digest&&jsonIdentity(query.data.lease)===jsonIdentity(status.lease)&&query.data.state===status.state;}
  function preparationPayload():AiComponentPrepareCommandPayload|undefined {return request?{kind:"ai-component-prepare",planId:status.lease.planId,
    expectedGeneration:status.lease.generation,unitIds:[...selected],component:request}:undefined;}
  function prepareAvailability(value?:AiComponentPrepareCommandPayload):CommandAvailability {
    if(!open||reads.retired)return{enabled:false,reason:"hidden"};
    if(ownerBusy()||busy)return{enabled:false,reason:"busy"};
    const inventoryQuery=reads.client.getQueryState(reads.key(inventoryKey)), environmentQuery=reads.client.getQueryState(reads.key(environmentKey));
    const fresh=[inventoryQuery,environmentQuery].every(query=>query?.status==="success"&&query.fetchStatus==="idle"&&query.error===null&&!query.isInvalidated);
    return value&&preparingAllowed&&fresh&&planCurrent()&&!session.current().operation&&jsonIdentity(value)===jsonIdentity(preparationPayload())?{enabled:true}:unavailable;
  }
  function operationPayload():AiComponentCommandPayload|undefined {const operation=session.current().operation;
    return operation?{kind:"ai-component",scopeId:operation.prepared.scopeId,attemptId:operation.prepared.attemptId,inputDigest:operation.prepared.inputDigest}:undefined;}
  function operationAvailability(value?:AiComponentCommandPayload,discard=false):CommandAvailability {
    if(!open||reads.retired)return{enabled:false,reason:"hidden"};
    if(ownerBusy()||busy)return{enabled:false,reason:"busy"};
    const operation=session.current().operation;
    if(!value||!operation||jsonIdentity(value)!==jsonIdentity(operationPayload()))return unavailable;
    if(discard)return operation.phase==="prepared"||operation.phase==="rejected"||session.current().discardUnknown||!active?{enabled:true}:unavailable;
    return canStart&&planCurrent()?{enabled:true}:unavailable;
  }
  useLayoutEffect(()=>{
    const metadata={category:"ai" as const,scope,binding:null,confirmation:"none" as const};
    const remove=[registry.register({...metadata,id:"ai.component.prepare",nameKey:"ai.component.prepare",risk:"captures-ai",payloadKind:"ai-component-prepare",availability:prepareAvailability,handler:()=>{void run(prepare);}}),
      registry.register({...metadata,id:"ai.component.start",nameKey:"ai.component.start",risk:"runs-ai",confirmation:"required",payloadKind:"ai-component",availability:value=>operationAvailability(value),handler:()=>{void run(start);}}),
      registry.register({...metadata,id:"ai.component.discard",nameKey:"ai.component.discard",risk:"captures-ai",payloadKind:"ai-component",availability:value=>operationAvailability(value,true),handler:()=>{void run(discard);}})];
    return()=>remove.forEach(dispose=>dispose());
  });
  return <section aria-label={t("ai.component.title")} aria-busy={busy || inventory.isFetching || environment.isFetching || observation.isFetching}>
    <button type="button" className="secondary-button" ref={entryRef} aria-expanded={expanded} disabled={busy || !!operation}
      onClick={() => setExpanded(value => !value)}>{t("ai.component.title")}</button>
    {expanded || operation ? <>
      <p>{t("ai.component.help")}</p>
      <fieldset disabled={locked}><legend>{t("ai.component.choice")}</legend>
        <label className="field">{t("ai.component.provider")}<select value={choiceKey} onChange={event => { setChoiceKey(event.target.value); setProfileKey(""); setRuntimeKey(""); }}>
          <option value="">{t("ai.component.chooseProvider")}</option>{inventory.data?.choices.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select></label>
        <label className="field">{t("ai.component.profile")}<select value={profileKey} onChange={event => setProfileKey(event.target.value)}>
          <option value="">{t("ai.component.chooseProfile")}</option>{choice?.declaration.profiles.length === 0
            ? <option value="none">{t("ai.component.noProfile")}</option>
            : choice?.declaration.profiles.map(item => <option key={jsonIdentity(item)} value={jsonIdentity(item)}>{item.id} ({item.schemaVersion}/{item.behaviorVersion})</option>)}
        </select></label>
        <label className="field">{t("sourcePlugin.runtime")}<select value={runtimeKey} onChange={event => setRuntimeKey(event.target.value)}>
          <option value="">{t("sourcePlugin.chooseRuntime")}</option>{inventory.data?.runtimes.map(item => <option key={item.environmentDigest} value={item.environmentDigest}>
            {t("sourcePlugin.runtimeOption", { version: pluginEnvironmentVersion(item.environment), system: item.environment.platform.operatingSystem, architecture: item.environment.platform.architecture })}
          </option>)}
        </select></label>
        <button type="button" className="secondary-button" onClick={() => { setProfileKey(""); setRuntimeKey(""); setRefresh(value => value + 1); }}>{t("ai.component.refresh")}</button>
        <button type="button" className="secondary-button" disabled={!prepareAvailability(preparationPayload()).enabled} onClick={()=>{const value=preparationPayload();if(value)registry.dispatch("ai.component.prepare",scope,value);}}>{t("ai.component.prepare")}</button>
      </fieldset>
      {!inventory.isFetching && inventory.data?.choices.length === 0 ? <p role="status">{t("ai.component.unavailable")}</p> : null}
      {inventory.isFetching || environment.isFetching ? <p role="status">{t("execution.working")}</p> : null}
      {!active ? <p role="status">{t("ai.tools.inactive")}</p> : null}
      {readFailure ? <div role="alert"><p>{t("ai.component.failed")}</p><CommandFailureDetails failure={commandFailure(readFailure)} />
        </div> : null}
      {operation ? <section aria-label={t("ai.component.review")}>
        <h4 tabIndex={-1} ref={reviewRef}>{t("ai.component.review")}</h4><p>{`${operation.prepared.component.binding.provider.plugin.publisher}/${operation.prepared.component.binding.provider.plugin.id} ${operation.prepared.component.binding.provider.plugin.version} · ${operation.prepared.component.binding.provider.contributionId}`}</p>
        <p>{t("ai.component.budget", { ...operation.prepared.budget, defaultValue: enUS.ai.component.budget })}</p>
        {operation.plan.preview ? <p>{t("ai.component.fixedModel", { model: operation.plan.preview.config.model, locale: operation.plan.locale, defaultValue: enUS.ai.component.fixedModel })}</p> : null}
        <ul>{operation.prepared.scope.map(unit => <li key={unit.unitId}>{unit.nativeKey}</li>)}</ul>
        <details><summary>{t("ai.component.sharing")}</summary>{operation.plan.preview?.items.filter(item => operation.prepared.generation.unitIds.includes(item.unitId)).map(item =>
          <article key={item.unitId}><h4>{item.nativeKey}</h4><pre className="ai-text">{item.sourceText}</pre>
            {item.terms.map(term => <p key={term.revisionId}>{term.source}: {term.target}</p>)}
            {item.context ? <pre className="ai-text">{item.context.text}</pre> : null}</article>)}</details>
        <PluginPermissions permissions={operation.prepared.component.binding.declaration.permissions} />
        <p>{t("sourcePlugin.unsandboxed")}</p>
        <details><summary>{t("execution.diagnostic")}</summary><p>{operation.prepared.component.packageOrigin.sourceId} / {operation.prepared.component.packageOrigin.publisherId}</p>
          <p>{operation.prepared.component.runtimeOrigin.sourceId} / {operation.prepared.component.runtimeOrigin.publisherId}</p>
          <code>{operation.prepared.component.environmentDigest}</code><p><code>{operation.prepared.inputDigest}</code></p></details>
        {stale ? <p role="alert">{t("ai.component.stale")}</p> : null}
        <label className="source-check"><input type="checkbox" checked={consentDigest === operation.prepared.inputDigest}
          disabled={busy || stale || !active || !["prepared", "rejected"].includes(operation.phase) || discardUnknown}
          onChange={event => setConsentDigest(event.target.checked ? operation.prepared.inputDigest : null)} />{t("ai.component.consent")}</label>
        {["prepared", "rejected"].includes(operation.phase) && !discardUnknown ? <button type="button" className="primary-button" disabled={!operationAvailability(operationPayload()).enabled}
          onClick={()=>{const value=operationPayload();if(value)registry.dispatch("ai.component.start",scope,value);}}>{t(operation.phase === "rejected" ? "ai.component.retryOriginal" : "ai.component.start")}</button> : null}
        {operation.phase === "prepared" || operation.phase === "rejected" || discardUnknown || !active ? <button type="button" className="secondary-button" disabled={!operationAvailability(operationPayload(),true).enabled}
          onClick={()=>{const value=operationPayload();if(value)registry.dispatch("ai.component.discard",scope,value);}}>{t("ai.component.discard")}</button> : null}
        {operation.phase === "unknown" || discardUnknown ? <p role="status">{t("ai.component.unknown")}</p> : null}
        {operation.phase !== "prepared" || discardUnknown ? <>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => reads.invalidate(["execution"])}>{t("ai.reconcile")}</button>
          {outer ? <p role="status">{t(`execution.states.${outer.items[0].status.execution}`)}</p> : <p role="status">{t("ai.component.waiting")}</p>}
          {outer?.items[0].status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><code>{outer.items[0].status.diagnostic}</code></details> : null}
          {childId ? <p role="status">{t("ai.component.child")}</p> : null}
          {settled && !discardUnknown ? <button type="button" className="secondary-button" disabled={busy}
            onClick={() => { setOperation(null); setConsentDigest(null); }}>{t("ai.component.finish")}</button> : null}
        </> : null}
      </section> : null}
    </> : null}
  </section>;
}
