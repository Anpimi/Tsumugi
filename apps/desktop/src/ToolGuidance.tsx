import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { commandFailure, CommandFailureDetails } from "./CommandFailure";
import { PluginPermissions } from "./PluginManager";
import type { SessionRequest } from "./executionCommands";
import { jsonIdentity } from "./pluginToolChoices";
import { useSessionQuery, useSessionReads } from "./SessionReadProvider";
import { openWorkPlanAgent, type WorkPlanAgentLeaf, type WorkPlanStatusView } from "./workPlanCommands";
import type { WorkPlanAgentGuidanceView } from "./generated/ai.responses";

type Consumer = WorkPlanAgentLeaf;
type Reading = { toolHandle: string; kind: "skill" } | { toolHandle: string; kind: "resource"; resourceId: string };
type Props = { context: SessionRequest; status: WorkPlanStatusView; open: boolean; disabled: boolean; bounded?: Consumer };
type CapturedConsumer = { scopeId: string; value: Consumer };
const textKey = (scopeId: string, reading: Reading) => ["agent-tool-guidance-text", scopeId, reading];

/** Guidance reads never join the preparation draft or pending execution owner. */
export function ToolGuidance(props: Props) {
  const identity = jsonIdentity([props.context, props.status.lease, props.status.state, props.status.expiresAt,
    props.status.plan.digest, props.status.plan.tools, props.bounded?.scope.scopeId]);
  return <ScopedToolGuidance key={identity} {...props} />;
}

function ScopedToolGuidance({ context, status, open, disabled, bounded }: Props) {
  const { t } = useTranslation(), reads = useSessionReads();
  const [expanded, setExpanded] = useState(false), [selected, setSelected] = useState<Reading | null>(null);
  // Keep bounded methods out of Query facts. The cache holds only Rust DTOs.
  const consumer = useRef<CapturedConsumer | null>(null), flight = useRef<object | null>(null), mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; flight.current = null; consumer.current = null; }; }, []);
  const current = useCallback(() => {
    const query = reads.client.getQueryState<WorkPlanStatusView>(reads.key(["workPlan", status.lease.planId]));
    return open && !disabled && !reads.retired && reads.context.projectId === context.projectId && reads.context.sessionToken === context.sessionToken
      && status.state === "active" && BigInt(status.expiresAt) > BigInt(Math.floor(Date.now() / 1000))
      && status.effects.includes("query-tools")
      && !!query && query.status === "success" && query.fetchStatus === "idle" && !query.isInvalidated && query.error === null
      && query.data?.state === "active" && query.data.expiresAt === status.expiresAt
      && jsonIdentity(query.data.lease) === jsonIdentity(status.lease) && query.data.plan.digest === status.plan.digest
      && jsonIdentity(query.data.plan.tools) === jsonIdentity(status.plan.tools);
  }, [reads, context.projectId, context.sessionToken, status, open, disabled]);
  const subscribe = useCallback((notify: () => void) => {
    const stop = reads.client.getQueryCache().subscribe(notify);
    const remaining = BigInt(status.expiresAt) * 1000n - BigInt(Date.now());
    const timer = remaining > 0n ? setTimeout(notify, Number(remaining > 2147483646n ? 2147483646n : remaining) + 1) : undefined;
    return () => { stop(); clearTimeout(timer); };
  }, [reads, status.expiresAt]);
  const available = useSyncExternalStore(subscribe, current, () => false);
  const handles = bounded?.scope.delegation?.toolHandles;
  const hasTools = !!status.plan.tools?.entries.some(tool => !handles || handles.includes(tool.handle));
  useLayoutEffect(() => { if (!available) { flight.current = null; consumer.current = null; } }, [available]);
  const directory = useSessionQuery({ key: ["agent-tool-guidance", status.lease.planId, status.lease.generation, status.plan.digest, ...(bounded ? [bounded.scope.scopeId] : [])],
    scopes: ["execution"], enabled: expanded && available && hasTools,
    read: async () => {
      const ticket = {}; flight.current = ticket; consumer.current = null;
      const valid = () => mounted.current && flight.current === ticket && current();
      const value = bounded ?? await openWorkPlanAgent({ ...context, lease: status.lease }, status.plan.scope, status.plan.tools?.entries ?? []);
      if (!valid()) throw new Error("Agent guidance scope changed");
      const catalog = await value.readGuidance();
      if (!valid()) throw new Error("Agent guidance scope changed");
      consumer.current = { scopeId: catalog.scopeId, value };
      return catalog;
    } });
  function readConsumer(scopeId: string) {
    const captured = consumer.current;
    if (!mounted.current || !current() || !captured || captured.scopeId !== scopeId) throw new Error("Agent guidance scope changed");
    return captured;
  }
  function selectText(scopeId: string, reading: Reading) {
    if (!current()) return;
    setSelected(reading);
    // Repeated explicit reads still recheck the original scope at the Host.
    void reads.client.invalidateQueries({ queryKey: reads.key(textKey(scopeId, reading)), exact: true });
  }
  const catalog = available && !directory.isFetching && !directory.error ? directory.data : undefined;
  return <section aria-label={t("ai.toolGuidance.title")}>
    <h4>{t("ai.toolGuidance.title")}</h4><p>{t("ai.toolGuidance.help")}</p>
    {!hasTools ? <p>{t("ai.toolGuidance.empty")}</p> : <button type="button" className="secondary-button" aria-expanded={expanded} disabled={!available}
      onClick={() => { flight.current = null; consumer.current = null; setSelected(null); setExpanded(!expanded); }}>{t(expanded ? "ai.toolGuidance.hide" : "ai.toolGuidance.show")}</button>}
    {!available && hasTools ? <div role="status"><p>{t("ai.toolGuidance.unavailable")}</p>
      <button type="button" className="secondary-button" disabled={disabled || !open || reads.retired} onClick={() => reads.invalidate(["execution"])}>{t("ai.toolGuidance.refreshPlan")}</button></div> : null}
    {expanded && available ? <>
      {directory.isFetching ? <p role="status">{t("ai.toolGuidance.loading")}</p> : null}
      {directory.error ? <div role="alert"><p>{t("ai.toolGuidance.failed")}</p><CommandFailureDetails failure={commandFailure(directory.error)} />
        <button type="button" className="secondary-button" onClick={() => { void directory.refetch(); }}>{t("ai.toolGuidance.retryDirectory")}</button></div> : null}
      {catalog ? <>
        {!catalog.tools.length ? <p>{t("ai.toolGuidance.empty")}</p> : catalog.tools.map(tool => {
          const provider = tool.binding.capability.provider, declaration = tool.binding.declaration;
          return <article key={tool.handle} aria-label={declaration.title}>
            <h5>{declaration.title}</h5><p>{declaration.description}</p>
            <dl><dt>{t("ai.toolGuidance.package")}</dt><dd>{provider.plugin.publisher}/{provider.plugin.id} {provider.plugin.version}<br /><code>{provider.packageDigest}</code></dd>
              <dt>{t("ai.toolGuidance.tool")}</dt><dd><code>{tool.resourceId}</code> · <code>{declaration.name}</code></dd>
              <dt>{t("ai.toolGuidance.member")}</dt><dd><code>{provider.componentId}</code> / <code>{provider.contributionId}</code></dd></dl>
            <p>{t("ai.toolGuidance.permissions")}</p><PluginPermissions permissions={tool.binding.capability.declaration.permissions} />
            {declaration.skill ? <button type="button" className="secondary-button" onClick={() => selectText(catalog.scopeId, { toolHandle: tool.handle, kind: "skill" })}>{t("ai.toolGuidance.readSkill")}</button>
              : <p>{t("ai.toolGuidance.noSkill")}</p>}
            {tool.binding.resources.length ? <details><summary>{t("ai.toolGuidance.references")}</summary>
              <ul>{tool.binding.resources.map(resource => <li key={resource.contributionId}><code>{resource.contributionId}</code> · <code>{resource.schema.id}</code> ({resource.schema.schemaVersion}/{resource.schema.behaviorVersion})
                <button type="button" className="secondary-button" onClick={() => selectText(catalog.scopeId, { toolHandle: tool.handle, kind: "resource", resourceId: resource.contributionId })}>{t("ai.toolGuidance.readReference")}</button></li>)}</ul>
            </details> : <p>{t("ai.toolGuidance.noReferences")}</p>}
          </article>;
        })}
        {selected ? <GuidanceText key={jsonIdentity([catalog.scopeId, selected])} catalog={catalog} selected={selected} current={current}
          readConsumer={readConsumer} stillConsumer={value => mounted.current && consumer.current === value} /> : null}
      </> : null}
    </> : null}
  </section>;
}

function GuidanceText({ catalog, selected, current, readConsumer, stillConsumer }: {
  catalog: WorkPlanAgentGuidanceView; selected: Reading; current: () => boolean;
  readConsumer: (scopeId: string) => CapturedConsumer; stillConsumer: (value: CapturedConsumer) => boolean;
}) {
  const { t } = useTranslation();
  const text = useSessionQuery({ key: textKey(catalog.scopeId, selected), scopes: ["execution"], enabled: true,
    read: async () => {
      const captured = readConsumer(catalog.scopeId);
      const value = selected.kind === "skill" ? await captured.value.readSkill(selected.toolHandle)
        : await captured.value.readResource(selected.toolHandle, selected.resourceId);
      if (!current() || !stillConsumer(captured)) throw new Error("Agent guidance scope changed");
      return value;
    } });
  return <section aria-label={t("ai.toolGuidance.content")}>
    <h5>{t("ai.toolGuidance.content")}</h5><p>{t("ai.toolGuidance.untrusted")}</p>
    {text.isFetching ? <p role="status">{t("ai.toolGuidance.loading")}</p> : text.error ? <div role="alert"><p>{t("ai.toolGuidance.failed")}</p>
      <CommandFailureDetails failure={commandFailure(text.error)} /><button type="button" className="secondary-button" onClick={() => { void text.refetch(); }}>{t("ai.toolGuidance.retryContent")}</button></div>
      : text.data ? <><p>{text.data.tool.binding.declaration.title} · <code>{text.data.content.contributionId}</code></p><pre>{text.data.content.text}</pre></> : null}
  </section>;
}
