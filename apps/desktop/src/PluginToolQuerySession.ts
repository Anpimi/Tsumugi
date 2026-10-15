import { validateResponseAttempt } from "./generated/execution.validators";
import { useExecutionTaskSession } from "./ExecutionTaskSession";
import { useEffect, useRef, useState } from "react";
import { ToolQueryError } from "../../../crates/plugin-sdk/javascript/tool-query.mjs";
import { commandFailure, type CommandFailure } from "./CommandFailure";
import { executionCommands, executionContext, type PluginToolPrepareRequest, type PluginToolPreflight, type PluginToolStartRequest, type StopApplicationInstanceRequest, type PluginToolDiscardRequest, type CancelRequest, type AttemptDetail } from "./executionCommands";
import type { PluginToolView } from "./pluginCommands";
import { jsonIdentity, matchesTool as matches } from "./pluginToolChoices";
import { hasUnknownOutcome, type ProjectView } from "./projectCommands";
import { useSessionAlive, useSessionReads } from "./SessionReadProvider";
type DraftRow = { id: number; text: string };
export type ToolQueryIntent =
  | { kind: "prepare"; request: PluginToolPrepareRequest; view: PluginToolView; sequence: number }
  | { kind: "start"; request: PluginToolStartRequest; review: PluginToolPreflight; sequence: number }
  | { kind: "stop-instance"; request: StopApplicationInstanceRequest }
  | { kind: "discard"; request: PluginToolDiscardRequest };
type Capture = { review: PluginToolPreflight; sequence: number };

interface State {
  choiceKey: string; runtimeKey: string; refresh: number; rows: DraftRow[]; target: string; selections: string[];
  capture: Capture | null; run: Capture | null; consent: string | null; applicationConsent: string | null; submittedSequence: number;
  knownTask: { taskId: string; attemptId: string; operation: "plugin-tool-query" } | null;
  pending: ToolQueryIntent | null; uncertain: boolean; busy: boolean; failure: CommandFailure | null; inputFailure: ToolQueryError | null;
}
function invalidAcknowledgement(message: string): never { throw Object.assign(new Error(message), { outcome: "unknown" }); }

/** Original tool captures, consent and unresolved requests belong to the stable resource session. */
export function usePluginToolQuerySession(project: ProjectView) {
  const context = executionContext(project), reads = useSessionReads(), mounted = useSessionAlive(), tasks = useExecutionTaskSession();
  const [state, setState] = useState<State>({ choiceKey: "", runtimeKey: "", refresh: 0, rows: [{ id: 0, text: "" }], target: "", selections: [],
    capture: null, run: null, consent: null, applicationConsent: null, submittedSequence: -1, knownTask: null, pending: null, uncertain: false, busy: false, failure: null, inputFailure: null });
  const currentState = useRef(state), nextRow = useRef(1), draftSequence = useRef(0), running = useRef(false), requestSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestSequence.current++; }; }, []);
  function change<K extends keyof State>(key: K, value: State[K]) {
    if (!mounted.current) return;
    currentState.current = { ...currentState.current, [key]: value }; setState(currentState.current);
  }
  const setCapture = (value: Capture | null) => change("capture", value), setRun = (value: Capture | null) => change("run", value);
  const setConsent = (value: string | null) => change("consent", value), setSubmittedSequence = (value: number) => change("submittedSequence", value);
  const setApplicationConsent = (value: string | null) => change("applicationConsent", value);
  const setBusy = (value: boolean) => change("busy", value), setFailure = (value: CommandFailure | null) => change("failure", value);
  const setInputFailure = (value: ToolQueryError | null) => change("inputFailure", value);
  function edit() { draftSequence.current++; setConsent(null); setApplicationConsent(null); setInputFailure(null); }
  function retain(value: ToolQueryIntent | null) { change("pending", value); if (!value) change("uncertain", false); }
  async function perform(work: (current: () => boolean) => Promise<void>) {
    if (!mounted.current || running.current) return;
    running.current = true; setBusy(true); setFailure(null);
    const ticket = ++requestSequence.current, current = () => mounted.current && requestSequence.current === ticket;
    try { await work(current); } catch (error) { if (current()) { if (error instanceof ToolQueryError) setInputFailure(error); else setFailure(commandFailure(error)); } }
    finally { running.current = false; if (mounted.current) { setBusy(false); reads.invalidate(["execution"]); } }
  }
  async function submit(intent: ToolQueryIntent, current: () => boolean) {
    const before = currentState.current;
    const sameOriginal = before.pending !== null && jsonIdentity(before.pending) === jsonIdentity(intent);
    if (before.uncertain && !sameOriginal) throw new Error("The complete original tool request must be retained");
    const originalUncertain = sameOriginal && before.uncertain;
    retain(intent);
    try {
      switch (intent.kind) {
        case "prepare": {
          const value = await executionCommands.prepareTool(intent.request);
          const expected = new Map<string | undefined, number>();
          intent.request.payloads.forEach(payload => { const key = jsonIdentity(payload); expected.set(key, (expected.get(key) ?? 0) + 1); });
          if (value.attemptId !== intent.request.attemptId || !matches(value.tool, intent.request.tool)
            || jsonIdentity(value.tool.binding) !== jsonIdentity(intent.view.binding)
            || jsonIdentity(value.tool.environment) !== jsonIdentity(intent.view.environment)
            || value.tool.componentScope !== intent.view.componentScope
            || (value.tool.componentScope === "application") !== (value.applicationScope !== null) || value.items.length !== intent.request.payloads.length
            || new Set(value.items.map(item => item.itemId)).size !== value.items.length) invalidAcknowledgement("Tool preparation identity changed");
          for (const item of value.items) { const key = jsonIdentity(item.payload), count = expected.get(key) ?? 0; if (!count) invalidAcknowledgement("Tool input coverage changed"); expected.set(key, count - 1); }
          if (current()) { setCapture({ review: value, sequence: intent.sequence }); setConsent(null); setApplicationConsent(null); retain(null); }
          break;
        }
        case "start": {
          const id = await executionCommands.startTool(intent.request);
          if (id !== intent.request.attemptId) invalidAcknowledgement("Tool attempt identity changed");
          if (current()) { setRun({ review: intent.review, sequence: intent.sequence }); setSubmittedSequence(intent.sequence); retain(null); }
          break;
        }
        case "stop-instance": await executionCommands.stopApplicationInstance(intent.request); if (current()) retain(null); await reads.client.invalidateQueries({ queryKey: reads.key(["application-plugin-instance", intent.request.basis.instanceId, intent.request.basis.activationGeneration]) }); break;
        case "discard": await executionCommands.discardTool(intent.request); if (current()) { setCapture(null); setConsent(null); setApplicationConsent(null); retain(null); } break;
      }
    } catch (error) { if (current() && !hasUnknownOutcome(error) && !originalUncertain) { retain(null); setConsent(null); setApplicationConsent(null); } if (current() && (hasUnknownOutcome(error) || originalUncertain)) change("uncertain", true); throw error; }
  }

  function observeTask(view: AttemptDetail) {
    const before = currentState.current, visible = before.pending?.kind === "start" ? before.pending : before.run;
    if (!visible || !validateResponseAttempt(view) || view.operation !== "plugin-tool-query"
      || view.attemptId !== visible.review.attemptId || view.recovery.attemptId !== visible.review.attemptId) return;
    const known = before.knownTask;
    if (known?.attemptId === view.attemptId) return;
    change("knownTask", Object.freeze({ taskId: view.taskId, attemptId: view.attemptId, operation: "plugin-tool-query" }));
  }
  function working() {
    const before = currentState.current, capture = before.pending?.kind === "start" ? before.pending : before.run;
    if (!capture) return false;
    const query = reads.client.getQueryState<AttemptDetail | null>(reads.key(["tool-query-attempt", capture.review.attemptId]));
    return !query || query.status !== "success" || query.fetchStatus !== "idle" || query.isInvalidated || !query.data
      || query.data.attemptId !== capture.review.attemptId
      || before.knownTask?.attemptId === capture.review.attemptId && query.data.taskId !== before.knownTask.taskId
      || query.data.items.some(item => item.status.execution === "queued" || item.status.execution === "dispatched");
  }
  function hasDraft() { const before = currentState.current; return !!before.capture || before.rows.some(row => row.text.length > 0) && draftSequence.current !== before.submittedSequence; }
  function blocked() { return running.current || !!currentState.current.pending || working(); }
  function setRows(value: DraftRow[] | ((before: DraftRow[]) => DraftRow[])) { change("rows", typeof value === "function" ? value(currentState.current.rows) : value); }
  function setSelections(value: string[] | ((before: string[]) => string[])) { change("selections", typeof value === "function" ? value(currentState.current.selections) : value); }
  function addText(text: string) {
    const before = currentState.current;
    if (!mounted.current || !text.length || before.pending && before.pending.kind !== "prepare" || running.current && before.pending?.kind !== "prepare") return false;
    const id = nextRow.current++;
    setRows(before.rows.length === 1 && before.rows[0].text === "" ? [{ ...before.rows[0], text }] : [...before.rows, { id, text }]); edit(); return true;
  }
  return { tasks, state, current: () => currentState.current, draftSequence, nextRow, mounted, running, perform, submit, edit, blocked, working, observeTask, hasDraft, addText,
    setRows, setSelections, setCapture, setConsent, setApplicationConsent, setFailure, setInputFailure,
    setChoiceKey: (value: string) => change("choiceKey", value), setRuntimeKey: (value: string) => change("runtimeKey", value),
    setTarget: (value: string) => change("target", value), setRefresh: (value: number | ((before: number) => number)) => change("refresh", typeof value === "function" ? value(currentState.current.refresh) : value) };
}
export type PluginToolQuerySession = ReturnType<typeof usePluginToolQuerySession>;
