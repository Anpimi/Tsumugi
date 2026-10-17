import { useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { defaultAiConfig, editedAiConfig, sameAiConfig, type AiConfig } from "./aiCommands";
import { aiSemanticReviewCommands, type AiSemanticReviewPrepared, type AiSemanticReviewRule, type AiSemanticReviewTarget } from "./aiSemanticReviewCommands";
import { semanticReviewKey } from "./aiSemanticReviewQueries";
import { connectionConfigCurrent, useConnectionFacts } from "./ApplicationReadProvider";
import type { ConnectionReadView } from "./connectionCommands";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionContext } from "./executionCommands";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import type { ReviewSummary, ReviewTarget } from "./reviewCommands";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";

type StartRequest = Parameters<typeof aiSemanticReviewCommands.start>[0];
type Preparation = { value: AiSemanticReviewPrepared; sequence: number; scope: string };
export interface AiSemanticReviewDraft {
  expanded: boolean; mode: "current" | "chosen"; config: AiConfig; presetName: string;
  rules: AiSemanticReviewRule[]; sequence: number; prepared: Preparation | null; consent: boolean;
  pending: { request: StartRequest; preparation: Preparation; absent: boolean } | null;
  attemptId: string | null; attempts: string[]; busy: "prepare" | "start" | "check" | null;
  failure: CommandFailure | null; notice: "newer" | "started" | "absent" | "unknown" | "stale" | null;
}

/** One local draft within the Review session; authoritative results remain in Query and Task. */
export function useAiSemanticReviewSession(project: ProjectView, target: ReviewTarget | null, chosen: ReviewSummary[], locale: string) {
  const [state, setState] = useState<AiSemanticReviewDraft>(() => ({ expanded: false, mode: "current", config: { ...defaultAiConfig }, presetName: "custom",
    rules: ["meaning", "style"], sequence: 0, prepared: null, consent: false, pending: null, attemptId: null, attempts: [], busy: null, failure: null, notice: null }));
  const stateRef = useRef(state), inputs = useRef({ project, target, chosen, locale });
  const reads = useSessionReads(), alive = useSessionAlive(), connections = useConnectionFacts(), tasks = useExecutionTaskSession();
  const [session] = useState(() => executionContext(project));
  const working = useRef(false);
  function update(change: (before: AiSemanticReviewDraft) => AiSemanticReviewDraft) {
    if (!alive.current) return;
    const next = change(stateRef.current); stateRef.current = next; setState(next);
  }
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    const previous = scope();
    inputs.current = { project, target, chosen, locale };
    if (previous !== scope()) invalidate();
  }, [project, target, chosen, locale]);
  function live() { return alive.current && inputs.current.project.sessionToken === session.sessionToken && inputs.current.project.metadata.projectId === session.projectId; }
  function targets(): AiSemanticReviewTarget[] {
    const input = inputs.current, values = stateRef.current.mode === "current" ? input.target ? [input.target] : [] : input.chosen;
    return values.map(value => ({ unitId: value.unitId, locale: value.locale }));
  }
  function scope() {
    const input = inputs.current, values = stateRef.current.mode === "current" ? input.target ? [input.target] : [] : input.chosen;
    return JSON.stringify([input.locale, input.project.metadata.targetLocales, stateRef.current.mode,
      values.map(value => [value.unitId, value.locale, value.basis, value.sourceSnapshotId, value.sourceRevisionId, value.selectionId, value.revisionId]).sort()]);
  }
  function invalidate() { update(before => ({ ...before, sequence: before.sequence + 1, prepared: null, consent: false, notice: before.prepared ? "stale" : before.notice })); }
  const observedScope = scope();
  useLayoutEffect(() => {
    if (stateRef.current.prepared && stateRef.current.prepared.scope !== scope()) invalidate();
  }, [target, chosen, locale, project.metadata.targetLocales, state.mode, observedScope]);
  useLayoutEffect(() => reads.subscribeChanges(scopes => {
    if (scopes.some(value => ["project", "source", "translation", "resources", "review"].includes(value))) invalidate();
  }), [reads]);
  useLayoutEffect(() => {
    if (!connectionConfigCurrent(connections.current(), stateRef.current.config)) invalidate();
  }, [connections.state]);
  function edit(change: (before: AiSemanticReviewDraft) => AiSemanticReviewDraft) {
    update(before => ({ ...change(before), sequence: before.sequence + 1, prepared: null, consent: false, failure: null, notice: null }));
  }
  function setConfig(value: SetStateAction<AiConfig>) {
    edit(before => { const config = editedAiConfig(before.config, typeof value === "function" ? value(before.config) : value); return sameAiConfig(config, before.config) ? before : { ...before, config }; });
  }
  function selectConnection(view: ConnectionReadView | null, id: string, expectedSequence: number) {
    if (!live() || stateRef.current.sequence !== expectedSequence) return false;
    if (!id) { setConfig(before => ({ ...before, connectionProfile: null })); update(before => ({ ...before, presetName: "custom" })); return true; }
    if (!view || connections.current() !== view) return false;
    const profile = view.snapshot.profiles.find(value => value.id === id && !value.archived), reference = view.references.find(value => value.profileId === id);
    if (!profile || !reference) return false;
    setConfig(before => ({ ...before, ...profile.connection, connectionProfile: reference }));
    update(before => ({ ...before, presetName: "custom" })); return true;
  }
  function preparationCurrent(value: Preparation) {
    return live() && stateRef.current.sequence === value.sequence && scope() === value.scope
      && connectionConfigCurrent(connections.current(), value.value.preview.config);
  }
  async function prepare() {
    if (!live() || working.current || stateRef.current.pending) return;
    const before = stateRef.current, captured = scope(), selected = targets();
    if (!selected.length || !before.rules.length || !connectionConfigCurrent(connections.current(), before.config)) return;
    working.current = true; update(value => ({ ...value, busy: "prepare", prepared: null, consent: false, failure: null, notice: null }));
    try {
      const value = await aiSemanticReviewCommands.prepare({ ...session, config: before.config, targets: selected, rules: before.rules });
      if (!live()) return;
      if (stateRef.current.sequence !== before.sequence || captured !== scope()) { update(value => ({ ...value, notice: "newer" })); return; }
      update(current => ({ ...current, prepared: { value, sequence: before.sequence, scope: captured }, consent: false }));
    } catch (error) { if (live()) update(value => ({ ...value, failure: commandFailure(error) })); }
    finally { working.current = false; update(value => ({ ...value, busy: null })); }
  }
  async function send(request: StartRequest, preparation: Preparation) {
    working.current = true;
    update(value => ({ ...value, busy: "start", pending: { request, preparation, absent: false }, consent: false, failure: null, notice: null }));
    try {
      await aiSemanticReviewCommands.start(request);
      if (!live()) return;
      update(value => ({ ...value, pending: null, prepared: value.prepared === preparation ? null : value.prepared,
        attemptId: request.attemptId, attempts: value.attempts.includes(request.attemptId) ? value.attempts : [...value.attempts, request.attemptId], notice: "started" }));
      reads.invalidate(["execution"]);
    } catch (error) {
      if (!live()) return;
      update(value => ({ ...value, pending: hasUnknownOutcome(error) ? value.pending : null, failure: commandFailure(error), notice: hasUnknownOutcome(error) ? "unknown" : null }));
    } finally { working.current = false; update(value => ({ ...value, busy: null })); }
  }
  async function start() {
    const before = stateRef.current, prepared = before.prepared;
    if (!prepared || !before.consent || before.pending || working.current || !preparationCurrent(prepared)) return;
    await send({ ...session, attemptId: prepared.value.attemptId, digest: prepared.value.preview.digest, confirmed: true }, prepared);
  }
  async function check() {
    const original = stateRef.current.pending;
    if (!live() || !original || working.current) return;
    const pending = { ...original, absent: false };
    working.current = true; update(value => ({ ...value, pending, busy: "check", failure: null }));
    try {
      const lookup = await aiSemanticReviewCommands.read({ ...session, attemptId: pending.request.attemptId });
      if (!live() || stateRef.current.pending !== pending) return;
      if (lookup.view) {
        reads.client.setQueryData(reads.key(semanticReviewKey(lookup.attemptId)), lookup.view);
        update(value => ({ ...value, pending: null, prepared: null, attemptId: lookup.attemptId,
          attempts: value.attempts.includes(lookup.attemptId) ? value.attempts : [...value.attempts, lookup.attemptId], notice: "started" }));
      } else update(value => ({ ...value, pending: { ...pending, absent: true }, notice: "absent" }));
    } catch (error) { update(value => ({ ...value, failure: commandFailure(error), notice: "unknown" })); }
    finally { working.current = false; update(value => ({ ...value, busy: null })); }
  }
  function reserved() {
    const activity = tasks.currentActivity();
    return working.current || !!stateRef.current.pending
      || !!activity && activity.intent.operation === "ai-semantic-review" && !["recorded", "rejected"].includes(activity.phase)
      || Object.values(tasks.state).some(value => stateRef.current.attempts.includes(value.target.attemptId) && ["preparing", "pending", "unknown"].includes(value.phase));
  }
  return { state, current: () => stateRef.current, targets, scope, preparationCurrent, reserved,
    dirty: () => !!stateRef.current.prepared || !!stateRef.current.pending || !sameAiConfig(stateRef.current.config, defaultAiConfig)
      || stateRef.current.mode !== "current" || stateRef.current.rules.length !== 2,
    setExpanded: (expanded: boolean) => update(value => ({ ...value, expanded })),
    setMode: (mode: AiSemanticReviewDraft["mode"]) => edit(value => ({ ...value, mode })),
    setRules: (rules: AiSemanticReviewRule[]) => edit(value => ({ ...value, rules })), setConfig,
    setPresetName: (presetName: string) => update(value => ({ ...value, presetName })), selectConnection,
    setConsent: (consent: boolean) => update(value => ({ ...value, consent: consent && !!value.prepared && preparationCurrent(value.prepared) })),
    showAttempt: (attemptId: string) => update(value => value.attempts.includes(attemptId) ? { ...value, attemptId } : value),
    prepare, start, check,
    retry: async () => { const pending = stateRef.current.pending; if (pending?.absent && !working.current && preparationCurrent(pending.preparation)) await send(pending.request, pending.preparation); },
    discardAbsent: () => { if (!working.current && stateRef.current.pending?.absent) update(value => ({ ...value, pending: null, prepared: null, consent: false, notice: null })); },
    clear: () => { if (reserved()) return false; update(value => ({ ...value, expanded: false, mode: "current", config: { ...defaultAiConfig }, presetName: "custom", rules: ["meaning", "style"], sequence: value.sequence + 1, prepared: null, consent: false, failure: null, notice: null })); return true; },
  };
}
