import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { enUS } from "./i18n/en-US";
import { createToolQuery } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { executionCommands, type SessionRequest } from "./executionCommands";
import { readCompleteAttempt } from "./executionRead";
import { hasUnknownOutcome } from "./projectCommands";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { openWorkPlanAgent, type WorkPlanStatusView } from "./workPlanCommands";

type AgentConsumer = Awaited<ReturnType<typeof openWorkPlanAgent>>;
type ToolCapture = Awaited<ReturnType<AgentConsumer["prepareTool"]>>;
type GenerationCapture = Awaited<ReturnType<AgentConsumer["prepare"]>>;
type Pending = { kind: "tool"; consumer: AgentConsumer; prepared: ToolCapture }
  | { kind: "generation"; consumer: AgentConsumer; prepared: GenerationCapture };
type ToolRun = { prepared: ToolCapture; plan: WorkPlanStatusView["plan"] };

/** A bounded production consumer of the original plan, provider and tool ledger. */
export function WorkPlanAgentControls({ context, status, open, disabled, busy, run, onBlockedChange, onGenerated }: {
  context: SessionRequest; status: WorkPlanStatusView; open: boolean; disabled: boolean; busy: boolean;
  run: (work: (current: () => boolean) => Promise<void>) => Promise<void>;
  onBlockedChange: (blocked: boolean) => void; onGenerated: (attemptId: string) => void;
}) {
  const { t } = useTranslation(), reads = useSessionReads();
  const [selected, setSelected] = useState<string[]>([]), [toolHandle, setToolHandle] = useState("");
  const [pending, setPending] = useState<Pending | null>(null), [toolRun, setToolRun] = useState<ToolRun | null>(null);
  const entries = status.plan.tools?.entries ?? [];
  const tool = toolRun?.plan.tools?.entries.find(entry => entry.handle === toolRun.prepared.toolHandle);
  const presentation = useMemo(() => { try { return tool ? createToolQuery(tool.binding) : null; } catch { return null; } }, [tool]);
  const attemptId = toolRun?.prepared.attemptId ?? null;
  const detail = useSessionQuery({ key: ["agent-tool-attempt", attemptId], scopes: ["execution"], enabled: open && !!attemptId && !busy,
    read: async () => {
      if (!attemptId || !toolRun) return null;
      const result = await readCompleteAttempt(context, attemptId, "plugin-tool-query");
      if (result && (result.taskId !== toolRun.prepared.taskId || result.progress.total !== toolRun.prepared.scope.length))
        throw new Error("Agent tool result coverage changed");
      return result;
    } });
  const resultIds = detail.data?.items.flatMap(item => item.resultId ? [item.resultId] : []) ?? [];
  const output = useSessionQuery({ key: ["agent-tool-output", attemptId, ...resultIds], scopes: ["execution"], enabled: open && !!attemptId && resultIds.length > 0 && !busy,
    read: () => Promise.all(resultIds.map(resultId => executionCommands.output({ ...context, attemptId: attemptId!, resultId }))) });
  const working = !!toolRun && (!detail.data || detail.data.items.some(item => ["queued", "dispatched"].includes(item.status.execution)));
  useEffect(() => { onBlockedChange(!!pending || working); return () => onBlockedChange(false); }, [!!pending, working, onBlockedChange]);
  const active = status.state === "active" && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000));
  const validUnits = selected.length > 0 && selected.every(id => status.plan.scope.some(unit => unit.unitId === id));
  const remaining = status.toolInvocations ? status.toolInvocations.limit - status.toolInvocations.reserved : 0;
  const insufficient = selected.length > remaining;
  const locked = disabled || busy || !!pending || working || !active;
  async function start(kind: Pending["kind"], current: () => boolean) {
    if (!validUnits || (kind === "tool" && !entries.some(entry => entry.handle === toolHandle))) return;
    const consumer = await openWorkPlanAgent({ ...context, lease: status.lease }, status.plan.scope, entries);
    const [taskId, attemptId] = await Promise.all([executionCommands.identity(context), executionCommands.identity(context)]);
    if (!current()) return;
    const fixed = { taskId, attemptId, unitIds: [...selected] };
    const action: Pending = kind === "tool"
      ? { kind, consumer, prepared: await consumer.prepareTool({ ...fixed, toolHandle }) }
      : { kind, consumer, prepared: await consumer.prepare(fixed) };
    if (!current()) return;
    setPending(action);
    if (action.kind === "tool") setToolRun({ prepared: action.prepared, plan: status.plan });
    try {
      if (action.kind === "tool") await action.consumer.startTool(action.prepared);
      else await action.consumer.start(action.prepared);
      if (current()) {
        setPending(null); reads.invalidate(["execution"]);
        if (action.kind === "generation") onGenerated(action.prepared.attemptId);
      }
    } catch (error) {
      if (current() && !hasUnknownOutcome(error)) { setPending(null); if (action.kind === "tool") setToolRun(null); }
      throw error;
    }
  }
  async function reconcile(current: () => boolean) {
    if (!pending) return;
    // Read-only reconciliation never renews a permit or sends the call again.
    const result = await readCompleteAttempt(context, pending.prepared.attemptId,
      pending.kind === "tool" ? "plugin-tool-query" : "ai-translation");
    if (!result) throw { outcome: "unknown", reason: "work-plan-pending" };
    if (result.taskId !== pending.prepared.taskId || result.progress.total !== pending.prepared.scope.length)
      throw { outcome: "unknown", reason: "invalid-work-plan-acknowledgement" };
    if (current()) { if (pending.kind === "generation") onGenerated(pending.prepared.attemptId); setPending(null); reads.invalidate(["execution"]); }
  }
  function resultRows(resultId: string, itemId: string) {
    const result = output.data?.find(item => item?.resultId === resultId);
    if (!presentation || !result || result.projectId !== context.projectId || result.attemptId !== attemptId
      || result.itemId !== itemId || result.outcome !== "succeeded") return null;
    try { return presentation.entries(result.output); } catch { return null; }
  }
  return <section aria-label={t("ai.tools.agentTitle")}>
    <h3>{t("ai.tools.agentTitle")}</h3><p>{t("ai.tools.agentHelp")}</p>
    <fieldset disabled={locked}><legend>{t("ai.tools.subset")}</legend>
      {status.plan.scope.map(unit => <label className="source-check" key={unit.unitId}><input type="checkbox" checked={selected.includes(unit.unitId)}
        onChange={event => setSelected(ids => event.target.checked ? [...ids, unit.unitId] : ids.filter(id => id !== unit.unitId))} />{unit.nativeKey}</label>)}
    </fieldset>
    {entries.length ? <>
      <label className="field">{t("toolQuery.provider")}<select value={toolHandle} disabled={locked} onChange={event => setToolHandle(event.target.value)}>
        <option value="">{t("toolQuery.chooseProvider")}</option>{entries.map(entry => <option key={entry.handle} value={entry.handle}>{entry.binding.declaration.title} · {entry.binding.capability.provider.plugin.version}</option>)}
      </select></label>
      {status.toolInvocations ? <p>{t("ai.tools.usage", { ...status.toolInvocations, defaultValue: enUS.ai.tools.usage })}</p> : null}
      {validUnits && insufficient ? <p role="status">{t("ai.tools.insufficient", { needed: selected.length, remaining, defaultValue: enUS.ai.tools.insufficient })}</p> : null}
      <button type="button" className="secondary-button" disabled={locked || !validUnits || !toolHandle || insufficient}
        onClick={() => void run(current => start("tool", current))}>{t("ai.tools.query")}</button>
    </> : <p>{t("ai.tools.noTools")}</p>}
    <button type="button" className="secondary-button" disabled={locked || !validUnits}
      onClick={() => void run(current => start("generation", current))}>{t("ai.tools.generateSubset")}</button>
    {!active ? <p role="status">{t("ai.tools.inactive")}</p> : null}
    {pending ? <div role="status"><p>{t("ai.tools.unknown")}</p><button type="button" className="secondary-button" disabled={busy}
      onClick={() => void run(reconcile)}>{t("ai.reconcile")}</button></div> : null}
    {detail.error || output.error ? <div role="alert"><p>{t("toolQuery.failed")}</p><button type="button" className="secondary-button" disabled={busy}
      onClick={() => reads.invalidate(["execution"])}>{t("ai.refresh")}</button></div> : null}
    {working ? <p role="status">{t("execution.working")}</p> : null}
    {detail.data && toolRun ? <section aria-label={t("toolQuery.results")}>
      <h4>{t("toolQuery.results")}</h4><p>{t("toolQuery.references")}</p>
      {detail.data.items.map(item => {
        const rows = item.resultId ? resultRows(item.resultId, item.status.itemId) : null;
        return <article key={item.status.itemId}><p>{t(`execution.states.${item.status.execution}`)}</p>
          {item.status.diagnostic ? <details><summary>{t("execution.diagnostic")}</summary><p>{item.status.diagnostic}</p></details> : null}
          {item.status.execution === "succeeded" && presentation ? !output.data ? <p role="status">{t("execution.working")}</p>
            : rows === null ? <p role="alert">{t("toolQuery.invalidResult")}</p>
            : rows.length === 0 ? <p>{presentation.query.output.emptyDescription}</p>
              : <div className="source-table-scroll"><table className="source-table"><thead><tr>{presentation.query.output.columns.map((column, index) => <th key={index} scope="col">{column.label}</th>)}</tr></thead>
                <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}><pre>{cell}</pre></td>)}</tr>)}</tbody></table></div> : null}
        </article>;
      })}
    </section> : null}
  </section>;
}
